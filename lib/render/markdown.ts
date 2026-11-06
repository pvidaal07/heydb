import type { TableKnowledge } from "../knowledge/query.ts";
import type { Annotation, Knowledge, Relationship } from "../knowledge/types.ts";
import type { Change } from "../model/diff.ts";
import { formatDatabaseName, formatName, parseName } from "../model/names.ts";
import type { Column, Snapshot, Table } from "../model/snapshot.ts";
import type { SearchResults } from "../search.ts";
import type { StatusResult } from "../usecases/status.ts";

// Markdown written for agents. Every character returned here is read by a
// model and paid for in its context window, so the format is a budget:
// - sections and table columns that would be empty are left out;
// - long lists stop at a limit and say how many were left and how to find them;
// - every note carries its id, because editing or forgetting one needs it.
// The output is plain markdown, readable by a person too, with no trailing
// newline: callers join pieces as they like.

const NOTE_PREVIEW_LENGTH = 80;
const MAX_WARNINGS = 20;

/** Pipes would end a table cell and line breaks would end the row. */
export function escapeCell(text: string): string {
	return text.replaceAll("|", "\\|").replace(/\r\n|\r|\n/g, "<br>");
}

/** "~1.2k", "~15k", "~2.5M": the precision an estimate deserves, in few characters. */
export function approximateRows(rows: number): string {
	const units = ["", "k", "M", "B"];
	let value = rows;
	let unit = 0;
	while (unit < units.length - 1 && Number(round(value)) >= 1000) {
		value /= 1000;
		unit += 1;
	}
	return `~${round(value)}${units[unit]}`;
}

// One decimal below 10 ("1.2"), none above ("15"); "1.0" prints as "1".
function round(value: number): string {
	const text = value < 10 ? value.toFixed(1) : value.toFixed(0);
	return text.endsWith(".0") ? text.slice(0, -2) : text;
}

export interface OverviewOptions {
	readonly connection: string;
	readonly maxTables?: number;
}

export function renderOverview(snapshot: Snapshot, knowledge: Knowledge, options: OverviewOptions): string {
	const { connection, maxTables = 50 } = options;
	const firstNote = firstNotes(knowledge);
	const blocks: string[][] = [
		[`# heydb · ${connection}`, `${snapshot.engine.kind} ${snapshot.engine.version} · captured ${snapshot.capturedAt}`],
	];

	const databases = snapshot.databases.flatMap((database) =>
		database.schemas.map((schema) => {
			const name =
				schema.name === database.name ? formatDatabaseName(database.name) : formatName({ database: database.name, schema: schema.name });
			const views = schema.tables.filter((table) => table.kind === "view").length;
			const counts = [count(schema.tables.length - views, "table"), ...(views > 0 ? [count(views, "view")] : [])].join(", ");
			const note = firstNote.get(formatName({ database: database.name, schema: schema.name }));
			return `- ${name}: ${counts}${note === undefined ? "" : ` · ${note}`}`;
		}),
	);
	if (databases.length > 0) blocks.push(["## Databases", ...databases]);

	if (snapshot.warnings.length > 0) {
		const shown = snapshot.warnings
			.slice(0, MAX_WARNINGS)
			.map((warning) => `- ${warning.message}${warning.target === undefined ? "" : ` (${warning.target})`}`);
		blocks.push(["## Warnings", ...shown, ...more(snapshot.warnings.length - MAX_WARNINGS, "warning")]);
	}

	const tables = snapshot.databases
		.flatMap((database) =>
			database.schemas.flatMap((schema) =>
				schema.tables.map((table) => ({ name: formatName({ database: database.name, schema: schema.name, table: table.name }), table })),
			),
		)
		.sort((a, b) => compareText(a.name, b.name));
	if (tables.length > 0) {
		const rows = tables.slice(0, maxTables).map(({ name, table }) => {
			const note = firstNote.get(name) ?? preview(table.comment);
			return row([name, table.kind, tableRows(table), note]);
		});
		const rest = more(tables.length - maxTables, "table").map((line) => `${line} — use heydb_search`);
		blocks.push(["## Tables", row(["table", "kind", "rows", "note"]), "|---|---|---|---|", ...rows, ...rest]);
	}
	return render(blocks);
}

export function renderTable(table: Table, canonicalName: string, knowledge: TableKnowledge): string {
	const header = [`# ${table.kind} ${canonicalName}`];
	const facts = [table.storageEngine, table.rowEstimate === null ? null : `${approximateRows(table.rowEstimate)} rows`].filter(
		(fact) => fact !== null,
	);
	if (facts.length > 0) header.push(facts.join(" · "));
	if (table.comment !== "") header.push(`Comment: ${oneLine(table.comment)}`);
	const blocks: string[][] = [header, columnsBlock(table.columns, knowledge.columns)];

	if (table.kind === "table") {
		blocks.push([`Primary key: ${table.primaryKey.length === 0 ? "none" : list(table.primaryKey)}`]);
	}
	if (table.indexes.length > 0) {
		blocks.push([
			"## Indexes",
			...table.indexes.map((index) => `- ${index.name} ${list(index.columns)}${index.unique ? " unique" : ""} ${index.method}`),
		]);
	}

	const relationships = [
		...table.foreignKeys.map((key) => {
			const { database, schema, table: target, columns } = key.references;
			const to = `${formatName({ database, schema, table: target })}${list(columns)}`;
			return `- ${key.name}: ${list(key.columns)} → ${to} · on delete ${key.onDelete} · on update ${key.onUpdate}`;
		}),
		...knowledge.relationships.map((relationship) => implicitRelationship(relationship, canonicalName)),
	];
	if (relationships.length > 0) blocks.push(["## Relationships", ...relationships]);

	if (table.triggers.length > 0) {
		blocks.push(["## Triggers", ...table.triggers.map((trigger) => `- ${trigger.name}: ${trigger.timing} ${trigger.events.join(", ")}`)]);
	}
	if (table.kind === "view") {
		blocks.push(
			table.viewDefinition === null
				? ["## Definition", "not visible to this user (see the snapshot warnings)"]
				: ["## Definition", "```sql", table.viewDefinition, "```"],
		);
	}

	const notes = [
		...knowledge.database.map((note) => noteLine("database", note)),
		...knowledge.table.map((note) => noteLine("table", note)),
	];
	if (notes.length > 0) blocks.push(["## Notes", ...notes]);
	return render(blocks);
}

export function renderStatus(status: StatusResult): string {
	switch (status.state) {
		case "never_synced":
			return "Never synced: there is no stored snapshot for this connection yet.";
		case "up_to_date":
			return `Up to date: the live database matches the snapshot (hash ${status.hash.slice(0, 12)}).`;
		case "drifted":
			return `Drifted: the live database differs from the snapshot in ${count(status.changes.length, "change")}.\n\n${renderChanges(status.changes)}`;
	}
}

export function renderChanges(changes: readonly Change[], { max = 50 }: { readonly max?: number } = {}): string {
	if (changes.length === 0) return "No changes.";
	const lines = changes.slice(0, max).map((change) => {
		const object = change.object === "foreignKey" ? "foreign key" : change.object;
		const details = change.details.length === 0 ? "" : `: ${change.details.join("; ")}`;
		return `- ${change.kind} ${object} ${change.target}${details}`;
	});
	return [...lines, ...more(changes.length - max, "change")].join("\n");
}

export function renderSearch(search: SearchResults): string {
	if (search.total === 0) return "No matches.";
	const header =
		search.results.length < search.total
			? `Showing ${search.results.length} of ${search.total} matches; refine the query to narrow them.`
			: `${count(search.total, "match")}.`;
	const lines = search.results.map((result) => {
		const where = result.matchedIn === "name" ? "" : ` · ${result.matchedIn}: ${result.snippet}`;
		return `- ${result.object} ${result.target}${where}`;
	});
	return [header, ...lines].join("\n");
}

// Notes go in the "notes" cell of their column; comment and notes columns are
// only printed when at least one column has something in them.
function columnsBlock(columns: readonly Column[], notes: TableKnowledge["columns"]): string[] {
	const notesOf = (column: Column) => (Object.hasOwn(notes, column.name) ? (notes[column.name] ?? []) : []);
	const withComments = columns.some((column) => column.comment !== "");
	const withNotes = columns.some((column) => notesOf(column).length > 0);
	const headers = ["column", "type", "null", "default", ...(withComments ? ["comment"] : []), ...(withNotes ? ["notes"] : [])];
	const rows = columns.map((column) =>
		row([
			column.name,
			columnType(column),
			column.nullable ? "yes" : "no",
			// An empty-string default is shown as '' so it differs from no default at all.
			column.default === null ? "" : column.default === "" ? "''" : column.default,
			...(withComments ? [column.comment] : []),
			...(withNotes ? [notesOf(column).map((note) => `${note.text} ${noteTag(note)}`).join("\n")] : []),
		]),
	);
	return ["## Columns", row(headers), `|${headers.map(() => "---").join("|")}|`, ...rows];
}

function columnType(column: Column): string {
	const parts = [column.type];
	if (column.autoIncrement) parts.push("auto_increment");
	if (column.generated !== null) {
		parts.push(`generated (${column.generated.expression}) ${column.generated.stored ? "stored" : "virtual"}`);
	}
	return parts.join(" ");
}

// Seen from this table: its own side is written without the table name.
function implicitRelationship(relationship: Relationship, tableName: string): string {
	const { from, to } = relationship;
	const left = from.table === tableName ? list(from.columns) : `${from.table}${list(from.columns)}`;
	const right = to.table === tableName && from.table !== tableName ? list(to.columns) : `${to.table}${list(to.columns)}`;
	const note = relationship.note === "" ? "" : ` · ${oneLine(relationship.note)}`;
	return `- ${left} → ${right} · implicit, documented by ${relationship.author}${note} [id ${relationship.id} · ${day(relationship.createdAt)}]`;
}

// Multi-line notes keep their lines, indented so they stay inside the list item.
function noteLine(scope: string, note: Annotation): string {
	return `- ${scope}: ${note.text.split(/\r\n|\r|\n/).join("\n  ")} ${noteTag(note)}`;
}

function noteTag(note: Annotation): string {
	return `[id ${note.id} · ${note.author} · ${day(note.createdAt)}]`;
}

/** First line of the first note of every target, for one-line summaries. */
function firstNotes(knowledge: Knowledge): Map<string, string> {
	const notes = new Map<string, string>();
	for (const annotation of knowledge.annotations) {
		const target = formatName(parseName(annotation.target));
		if (!notes.has(target)) notes.set(target, preview(annotation.text));
	}
	return notes;
}

function preview(text: string): string {
	const line = text.split(/\r\n|\r|\n/)[0]?.trim() ?? "";
	const characters = [...line];
	return characters.length <= NOTE_PREVIEW_LENGTH ? line : `${characters.slice(0, NOTE_PREVIEW_LENGTH - 1).join("")}…`;
}

function tableRows(table: Table): string {
	if (table.kind === "view" || table.rowEstimate === null) return "";
	return approximateRows(table.rowEstimate);
}

function row(cells: readonly string[]): string {
	return `| ${cells.map(escapeCell).join(" | ")} |`;
}

function list(items: readonly string[]): string {
	return `(${items.join(", ")})`;
}

function oneLine(text: string): string {
	return text.replace(/\s*(\r\n|\r|\n)\s*/g, " ").trim();
}

function day(timestamp: string): string {
	return timestamp.slice(0, 10);
}

function count(n: number, noun: string): string {
	return `${n} ${plural(n, noun)}`;
}

function plural(n: number, noun: string): string {
	if (n === 1) return noun;
	return noun.endsWith("ch") ? `${noun}es` : `${noun}s`;
}

/** "… 3 more tables" when a list was cut, nothing when it was not. */
function more(n: number, noun: string): string[] {
	return n > 0 ? [`… ${n} more ${plural(n, noun)}`] : [];
}

function render(blocks: readonly string[][]): string {
	return blocks.map((block) => block.join("\n")).join("\n\n");
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
