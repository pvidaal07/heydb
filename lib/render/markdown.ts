import type { ExternalRelationship, TableKnowledge } from "../knowledge/query.ts";
import type { Annotation, Knowledge, Relationship, RelationshipSide } from "../knowledge/types.ts";
import type { Change } from "../model/diff.ts";
import { displayName, displayNameOf, formatName, parseName } from "../model/names.ts";
import type { IncomingReferences } from "../model/references.ts";
import type { Column, Snapshot, Table } from "../model/snapshot.ts";
import { type SchemaStats, schemaStats } from "../model/stats.ts";
import { normalizeText, type SearchResult, type SearchResults } from "../search.ts";
import type { StatusResult } from "../usecases/status.ts";

// Markdown written for agents. Every character returned here is read by a
// model and paid for in its context window, so the format is a budget:
// - sections and table columns that would be empty are left out;
// - long lists stop at a limit and say how many were left and how to find them;
// - every note carries its id, because editing or forgetting one needs it;
// - names are display names ("shop.orders" for MySQL's "shop.shop.orders"):
//   shorter to read and still accepted back by every tool.
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
	/** Notes about the whole project, shown before anything else. */
	readonly projectNotes?: readonly Annotation[];
}

/** Under this share of commented tables, comments are not a reliable map of the schema. */
const LOW_COMMENT_COVERAGE = 0.2;

export function renderOverview(snapshot: Snapshot, knowledge: Knowledge, options: OverviewOptions): string {
	const { connection, maxTables = 50, projectNotes = [] } = options;
	const firstNote = firstNotes(knowledge);
	const stats = schemaStats(snapshot, knowledge);
	const blocks: string[][] = [
		[`# heydb · ${connection}`, `${snapshot.engine.kind} ${snapshot.engine.version} · captured ${snapshot.capturedAt}`],
	];

	// What holds for every database ("one database per client") frames the rest.
	if (projectNotes.length > 0) blocks.push(["## Project notes", ...projectNotes.map((note) => `- ${indented(note.text)} ${noteTag(note)}`)]);

	if (stats.length > 0) blocks.push(["## Databases", ...stats.flatMap((schema) => databaseLines(schema, firstNote))]);

	if (snapshot.warnings.length > 0) {
		const shown = snapshot.warnings
			.slice(0, MAX_WARNINGS)
			.map((warning) => `- ${warning.message}${warning.target === undefined ? "" : ` (${displayText(warning.target)})`}`);
		blocks.push(["## Warnings", ...shown, ...more(snapshot.warnings.length - MAX_WARNINGS, "warning")]);
	}

	// Notes first (the team already explained them), then the core of each
	// database, then the rest by name: when the list is cut, what is cut is
	// what says least.
	const tables = snapshot.databases
		.flatMap((database) =>
			database.schemas.flatMap((schema) =>
				schema.tables.map((table) => ({ name: formatName({ database: database.name, schema: schema.name, table: table.name }), table })),
			),
		)
		.sort((a, b) => compareText(a.name, b.name));
	const main = new Map(stats.flatMap((schema) => schema.mainTables).map((item, index) => [item.name, index]));
	const group = (name: string) => (firstNote.has(name) ? 0 : main.has(name) ? 1 : 2);
	tables.sort((a, b) => group(a.name) - group(b.name) || (main.get(a.name) ?? 0) - (main.get(b.name) ?? 0) || compareText(a.name, b.name));
	if (tables.length > 0) {
		const rows = tables.slice(0, maxTables).map(({ name, table }) => {
			const note = firstNote.get(name) ?? preview(table.comment);
			return row([displayNameOf(name), table.kind, tableRows(table), note]);
		});
		const rest = more(tables.length - maxTables, "table").map((line) => `${line} — use heydb_search`);
		blocks.push([
			"## Tables",
			"Tables with notes first, then the most referenced, then by name; rows are engine estimates.",
			row(["table", "kind", "rows", "note"]),
			"|---|---|---|---|",
			...rows,
			...rest,
		]);
	}
	return render(blocks);
}

// One list item per database, its details indented below it. Comment coverage
// says how far comments can be trusted as a map; the most referenced tables
// are the core of the database, whatever their names.
function databaseLines(stats: SchemaStats, firstNote: ReadonlyMap<string, string>): string[] {
	const ref = { database: stats.database, schema: stats.schema };
	const counts = [count(stats.tables, "table"), ...(stats.views > 0 ? [count(stats.views, "view")] : [])].join(", ");
	const note = firstNote.get(formatName(ref));
	const lines: string[] = [];
	if (stats.tables > 0) {
		lines.push(
			`Comment coverage: ${percent(stats.tablesWithComment, stats.tables)} of ${count(stats.tables, "table")}, ${percent(stats.columnsWithComment, stats.columns)} of ${count(stats.columns, "column")}`,
		);
	}
	if (stats.prefixes.length > 0) {
		lines.push(`Name prefixes: ${stats.prefixes.map(({ prefix, count: n }) => `${prefix} ×${n}`).join(", ")}`);
	}
	if (stats.mainTables.length > 0) {
		lines.push(
			"Most referenced tables:",
			...stats.mainTables.map(({ name, table, incoming }) => {
				const rows = table.rowEstimate === null ? "rows unknown" : `${approximateRows(table.rowEstimate)} rows`;
				const about = firstNote.get(name) ?? (preview(table.comment) || "no comment");
				return `- ${displayNameOf(name)} · ${count(incoming, "reference")} · ${rows} · ${about}`;
			}),
		);
	}
	if (stats.tables > 0 && stats.tablesWithComment / stats.tables < LOW_COMMENT_COVERAGE) {
		lines.push("Most tables have no comment: do not infer meaning from table names alone.");
	}
	return [`- ${displayName(ref)}: ${counts}${note === undefined ? "" : ` · ${note}`}`, ...lines.map((line) => `  ${line}`)];
}

export interface TableOptions {
	/** How many columns to list: a number, or "all". Default DEFAULT_COLUMN_LIMIT. */
	readonly columns?: "all" | number;
	/** Only columns whose name or comment contains this text, ignoring case and accents. */
	readonly columnFilter?: string;
	/** The connection the table belongs to; sides in other connections are prefixed with theirs. */
	readonly connection?: string;
	/** Relationships stored in other connections' knowledge files that point to this table. */
	readonly external?: readonly ExternalRelationship[];
	/** Why some of those files could not be read. */
	readonly unreadable?: readonly string[];
}

/** Enough for a normal table whole; a 540-column legacy table shows its most telling 60. */
export const DEFAULT_COLUMN_LIMIT = 60;
const MAX_DEFINITION_LENGTH = 3000;
const MAX_INCOMING = 20;
const MAX_GUESSES_SHOWN = 15;
/** Foreign keys, triggers and indexes listed; a legacy table may have dozens of each. */
const MAX_LISTED = 10;
/** Column comments and notes, unless a column_filter asked for those columns. */
const COLUMN_TEXT_LENGTH = 100;

const NO_EVIDENCE =
	"No table comment or team note: meaning must be inferred from columns and references; say it is an inference and ask the user to confirm.";

/**
 * One table, in the order an agent should read it: first what says what the
 * table is (comment, notes, who points to it), then its shape. On a huge
 * legacy table the columns come last and are cut, so the evidence of meaning
 * is never what gets lost.
 */
export function renderTable(
	table: Table,
	canonicalName: string,
	knowledge: TableKnowledge,
	incoming: IncomingReferences = documentedOnly(knowledge, canonicalName),
	options: TableOptions = {},
): string {
	const header = [`# ${table.kind} ${displayNameOf(canonicalName)}`];
	const rows = table.kind === "view" ? null : table.rowEstimate === null ? "rows unknown" : `${approximateRows(table.rowEstimate)} rows (engine estimate)`;
	const facts = [table.storageEngine, rows].filter((fact) => fact !== null);
	if (facts.length > 0) header.push(facts.join(" · "));
	if (table.comment.trim() !== "") header.push(`Comment: ${oneLine(table.comment)}`);
	else header.push(knowledge.table.length > 0 ? "No table comment." : NO_EVIDENCE);
	if (table.kind === "table") header.push(`Primary key: ${table.primaryKey.length === 0 ? "none" : list(table.primaryKey)}`);
	const blocks: string[][] = [header];

	const notes = [
		...knowledge.database.map((note) => noteLine("database", note)),
		...knowledge.table.map((note) => noteLine("table", note)),
	];
	if (notes.length > 0) blocks.push(["## Notes", ...notes]);

	const here = (side: RelationshipSide) => side.connection === undefined && side.table === canonicalName;
	const outgoing = knowledge.relationships.filter((relationship) => here(relationship.from));
	const external = options.external ?? [];
	const relationships = [
		...table.foreignKeys.slice(0, MAX_LISTED).map((key) => {
			const { database, schema, table: target, columns } = key.references;
			const to = `${displayName({ database, schema, table: target })}${list(columns)}`;
			return `- ${key.name}: ${list(key.columns)} → ${to} · on delete ${key.onDelete} · on update ${key.onUpdate}`;
		}),
		...more(table.foreignKeys.length - MAX_LISTED, "foreign key"),
		...outgoing.map((relationship) => implicitRelationship(relationship, canonicalName, options.connection)),
	];
	if (relationships.length > 0) blocks.push(["## Relationships", ...relationships]);

	const fromOtherConnections = [
		...external
			.slice(0, MAX_INCOMING)
			.map(({ connection, relationship }) => implicitRelationship(relationship, canonicalName, options.connection, connection)),
		...more(external.length - MAX_INCOMING, "relationship from another connection"),
		...(options.unreadable ?? []).map((reason) => `- not read: ${reason}`),
	];
	const referencedBy = incomingBlock(incoming, canonicalName, options.connection, fromOtherConnections);
	if (referencedBy.length > 0) blocks.push(["## Referenced by", ...referencedBy]);

	if (table.triggers.length > 0) {
		blocks.push([
			"## Triggers",
			...table.triggers.slice(0, MAX_LISTED).map((trigger) => `- ${trigger.name}: ${trigger.timing} ${trigger.events.join(", ")}`),
			...more(table.triggers.length - MAX_LISTED, "trigger"),
		]);
	}
	if (table.kind === "view") blocks.push(definitionBlock(table.viewDefinition));

	// Columns a key or a relationship uses rank right after the primary key.
	const related = new Set([
		...table.foreignKeys.flatMap((key) => key.columns),
		...outgoing.flatMap((relationship) => relationship.from.columns),
		...knowledge.relationships.filter((relationship) => here(relationship.to)).flatMap((relationship) => relationship.to.columns),
		...external.flatMap(({ relationship }) => [relationship.from, relationship.to].filter((side) => side.connection === options.connection)).flatMap((side) => side.columns),
		...incoming.declared.flatMap((reference) => reference.toColumns),
	]);
	blocks.push(columnsBlock(table, knowledge.columns, related, options));

	if (table.indexes.length > 0) {
		blocks.push([
			"## Indexes",
			...table.indexes.slice(0, MAX_LISTED).map((index) => `- ${index.name} ${list(index.columns)}${index.unique ? " unique" : ""} ${index.method}`),
			...more(table.indexes.length - MAX_LISTED, "index"),
		]);
	}
	return render(blocks);
}

// The comments of the columns that point here come first: on a table without
// comment, "Artículo" ×12 says more than any name.
function incomingBlock(
	incoming: IncomingReferences,
	canonicalName: string,
	connection: string | undefined,
	fromOtherConnections: readonly string[],
): string[] {
	const lines: string[] = [];
	if (incoming.summary.length > 0) {
		lines.push(`Referencing columns are commented as: ${incoming.summary.map(({ comment, count: n }) => `"${comment}" ×${n}`).join(", ")}`);
	}
	lines.push(
		...incoming.declared
			.slice(0, MAX_INCOMING)
			.map((reference) => `- ${displayNameOf(reference.table)}${list(reference.columns)} → ${list(reference.toColumns)} · foreign key ${reference.name}`),
		...more(incoming.declared.length - MAX_INCOMING, "foreign key"),
		...incoming.implicit.slice(0, MAX_INCOMING).map(({ relationship }) => implicitRelationship(relationship, canonicalName, connection)),
		...more(incoming.implicit.length - MAX_INCOMING, "implicit relationship"),
		...fromOtherConnections,
	);
	if (incoming.guesses.length > 0) {
		lines.push(
			"Name pattern, not enforced (guesses):",
			...incoming.guesses.slice(0, MAX_GUESSES_SHOWN).map((guess) => {
				const name = displayName({ ...parseName(guess.table), column: guess.column });
				return guess.comment.trim() === "" ? `- ${name}` : `- ${name} · "${oneLine(guess.comment)}"`;
			}),
			...more(incoming.guesses.length + incoming.moreGuesses - MAX_GUESSES_SHOWN, "name-pattern guess"),
		);
	}
	return lines;
}

// Without the snapshot, only what the team documented can point here.
function documentedOnly(knowledge: TableKnowledge, canonicalName: string): IncomingReferences {
	const local = (side: RelationshipSide) => side.connection === undefined;
	const implicit = knowledge.relationships
		.filter(({ from, to }) => local(from) && local(to) && to.table === canonicalName && from.table !== canonicalName)
		.map((relationship) => ({ relationship, comment: "" }));
	return { declared: [], implicit, guesses: [], moreGuesses: 0, summary: [] };
}

function definitionBlock(definition: string | null): string[] {
	if (definition === null) return ["## Definition", "not visible to this user (see the snapshot warnings)"];
	if (definition.length <= MAX_DEFINITION_LENGTH) return ["## Definition", "```sql", definition, "```"];
	return [
		"## Definition",
		"```sql",
		definition.slice(0, MAX_DEFINITION_LENGTH),
		"```",
		`… definition cut at ${MAX_DEFINITION_LENGTH} of ${definition.length} characters; the full text is in the stored snapshot (.heydb/snapshots/)`,
	];
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
		return `- ${change.kind} ${object} ${displayText(change.target)}${details}`;
	});
	return [...lines, ...more(changes.length - max, "change")].join("\n");
}

export function renderSearch(search: SearchResults): string {
	const unmatched = (search.unmatched ?? []).map((word) => `"${word}"`).join(", ");
	if (search.total === 0) {
		return unmatched === "" ? "No matches." : `No matches for ${unmatched}. Try synonyms, another language (English or Spanish) or single words.`;
	}
	const header =
		search.results.length < search.total
			? `Showing ${search.results.length} of ${search.total} matches; refine the query or pass a higher limit for more.`
			: `${count(search.total, "match")}.`;
	const partial = unmatched === "" ? [] : [`Nothing matches ${unmatched}; these results match the other words.`];
	const named = new Set<string>();
	const lines = search.results.map((result) => searchLine(result, named));
	const weaker = search.weaker ?? 0;
	const footer = weaker > 0 ? [`… ${weaker} weaker ${plural(weaker, "match")} not shown.`] : [];
	const inferred = search.results.some((result) => result.inferred) ? [INFERRED_NOTE] : [];
	return [header, ...partial, ...lines, ...footer, ...inferred].join("\n");
}

const ABOUT_LENGTH = 80;
const SEARCH_COLUMNS = 3;

// One line that often answers the question by itself: what the table is (its
// comment or note, cut), then the columns that matched, with their comments.
// How it matched is left out, except what the agent must treat with care:
// meaning inferred from other tables, and a name that only looks like the word.
function searchLine(result: SearchResult, named: Set<string>): string {
	const { relationship } = result;
	const target = relationship === undefined ? displayText(result.target) : `${sideText(relationship.from)} → ${sideText(relationship.to)}`;
	let line = `- ${result.object} ${target}${copies(result.alsoIn ?? [], named)}${structuralCopies(result.copies ?? [])}${result.abbreviated ? " (abbreviated name)" : ""}`;
	const about = result.about === "" ? result.snippet : result.about;
	if (about !== "") line += ` — ${shorten(about, ABOUT_LENGTH)}`;
	const from = result.inferredFrom ?? [];
	if (from.length > 0) line += ` · referenced as ${from.map(({ comment, count: n }) => `"${comment}" ×${n}`).join(", ")} (inferred)`;
	if (result.columns.length > 0) {
		const shown = result.columns.slice(0, SEARCH_COLUMNS).map(({ name, snippet }) => (snippet === "" ? name : `${name} "${snippet}"`));
		const rest = result.columns.length - SEARCH_COLUMNS + result.moreColumns;
		line += ` · columns: ${shown.join(", ")}${rest > 0 ? ` (+${rest})` : ""}`;
	}
	return line;
}

/**
 * " (+9 identical: emp_002, emp_003, emp_004, …)": the other databases of a
 * repeated table, the first few named. One database per company repeats
 * every table in the same databases, so a list already named is not named
 * again: " (+9 identical)".
 */
function copies(alsoIn: readonly string[], named: Set<string>): string {
	if (alsoIn.length === 0) return "";
	const key = alsoIn.join("\u0000");
	if (named.has(key)) return ` (+${alsoIn.length} identical)`;
	named.add(key);
	const names = alsoIn.slice(0, IDENTICAL_NAMED).join(", ");
	return ` (+${alsoIn.length} identical: ${names}${alsoIn.length > IDENTICAL_NAMED ? ", …" : ""})`;
}

const IDENTICAL_NAMED = 3;

/** " (+3 copies: fac_cab_2019, fac_cab_2020, …)": tables of the same database with this one's columns, matched only by what they share with it. */
function structuralCopies(names: readonly string[]): string {
	if (names.length === 0) return "";
	const shown = names.slice(0, COPIES_NAMED).join(", ");
	return ` (+${names.length} ${names.length === 1 ? "copy" : "copies"}: ${shown}${names.length > COPIES_NAMED ? ", …" : ""})`;
}

const COPIES_NAMED = 2;

// Said once under the results, only when one of them is inferred.
const INFERRED_NOTE =
	"(inferred): only the comments of columns that reference the table match; present that meaning as an inference and ask the user to confirm it.";

// Which columns, and in which order: the filter first; then, when there are
// more than the limit, the ones that say most about the table (primary key,
// keys and relationships, commented or noted), shown in table order with
// their position (#12) so gaps are visible. One line per column, "- name
// type", then only what carries information: PK, auto, generated, null,
// =default, the comment and notes. Long comments and notes are cut, except
// for the columns a column_filter asked for.
function columnsBlock(table: Table, notes: TableKnowledge["columns"], related: ReadonlySet<string>, options: TableOptions): string[] {
	const notesOf = (column: Column) => (Object.hasOwn(notes, column.name) ? (notes[column.name] ?? []) : []);
	const total = table.columns.length;
	const filter = options.columnFilter?.trim() ?? "";
	const needle = normalizeText(filter);
	const matching =
		filter === ""
			? table.columns
			: table.columns.filter((column) => normalizeText(column.name).includes(needle) || normalizeText(column.comment).includes(needle));
	const limit = options.columns === "all" ? Number.POSITIVE_INFINITY : (options.columns ?? DEFAULT_COLUMN_LIMIT);

	let shown = matching;
	if (matching.length > limit) {
		const keys = new Set(table.primaryKey);
		const rank = (column: Column) =>
			keys.has(column.name) ? 0 : related.has(column.name) ? 1 : column.comment.trim() !== "" || notesOf(column).length > 0 ? 2 : 3;
		shown = [...matching]
			.sort((a, b) => rank(a) - rank(b) || a.position - b.position)
			.slice(0, limit)
			.sort((a, b) => a.position - b.position);
	}

	const heading =
		filter !== ""
			? `## Columns matching "${filter}" (${matching.length} of ${total})`
			: shown.length < total
				? `## Columns (${shown.length} of ${total}; keys, relationships and commented first)`
				: "## Columns";
	if (shown.length === 0) {
		return [heading, filter === "" ? "none" : 'No column matches; try another column_filter or columns: "all".'];
	}

	const keys = new Set(table.primaryKey);
	const numbered = shown.length < total;
	let cut = false;
	const text = (value: string) => {
		const line = oneLine(value);
		if (filter !== "") return line;
		const short = shorten(line, COLUMN_TEXT_LENGTH);
		cut ||= short !== line;
		return short;
	};
	const lines = shown.map((column) => {
		const parts = [`- ${numbered ? `#${column.position} ` : ""}${column.name}`, column.type];
		if (keys.has(column.name)) parts.push("PK");
		if (column.autoIncrement) parts.push("auto");
		if (column.generated !== null) parts.push(`generated (${column.generated.expression}) ${column.generated.stored ? "stored" : "virtual"}`);
		if (column.nullable) parts.push("null");
		// An empty-string default is shown as '' so it differs from no default at all.
		if (column.default !== null) parts.push(`=${column.default === "" ? "''" : column.default}`);
		const comment = column.comment.trim() === "" ? "" : ` — "${text(column.comment)}"`;
		const notes = notesOf(column).map((note) => ` · note: ${text(note.text)} ${noteTag(note)}`);
		return `${parts.join(" ")}${comment}${notes.join("")}`;
	});
	const hidden = matching.length - shown.length;
	const footer = hidden > 0 ? [`… ${count(hidden, "more column")} — call heydb_table with columns: "all" or a column_filter`] : [];
	const cutNote = cut ? ["Long comments and notes are cut; a column_filter shows them whole."] : [];
	return [heading, ...lines, ...footer, ...cutNote];
}

/**
 * Seen from this table of `connection`: its own side is written without the
 * table name, and a side in any other connection starts with that
 * connection's name. `storedIn` is the connection whose file stores the
 * relationship, when it is not this one; its id is only usable there.
 */
function implicitRelationship(relationship: Relationship, tableName: string, connection?: string, storedIn?: string): string {
	const { from, to } = relationship;
	const connectionOf = (side: RelationshipSide) => side.connection ?? storedIn ?? connection;
	const isThisTable = (side: RelationshipSide) => side.table === tableName && connectionOf(side) === connection;
	const named = (side: RelationshipSide) => sideText({ ...side, connection: connectionOf(side) }, connection);
	const left = isThisTable(from) ? list(from.columns) : named(from);
	const right = isThisTable(to) && !isThisTable(from) ? list(to.columns) : named(to);
	const note = relationship.note === "" ? "" : ` · ${oneLine(relationship.note)}`;
	const where = storedIn === undefined ? "" : ` · connection ${storedIn}`;
	return `- ${left} → ${right} · implicit, documented by ${relationship.author}${note} [id ${relationship.id}${where} · ${day(relationship.createdAt)}]`;
}

/** "erp: erp.cus(cod)" for a side in another connection than `current`, "shop.orders(id)" otherwise. */
function sideText(side: RelationshipSide, current?: string): string {
	const prefix = side.connection === undefined || side.connection === current ? "" : `${side.connection}: `;
	return `${prefix}${displayText(side.table)}${list(side.columns)}`;
}

function noteLine(scope: string, note: Annotation): string {
	return `- ${scope}: ${indented(note.text)} ${noteTag(note)}`;
}

// Multi-line notes keep their lines, indented so they stay inside the list item.
function indented(text: string): string {
	return text.split(/\r\n|\r|\n/).join("\n  ");
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

/** One line, at most `length` characters, "…" last when cut. */
function shorten(text: string, length: number): string {
	const characters = [...oneLine(text).replace(/\s+/g, " ")];
	return characters.length <= length ? characters.join("") : `${characters.slice(0, length - 1).join("")}…`;
}

function preview(text: string): string {
	const line = text.split(/\r\n|\r|\n/)[0]?.trim() ?? "";
	const characters = [...line];
	return characters.length <= NOTE_PREVIEW_LENGTH ? line : `${characters.slice(0, NOTE_PREVIEW_LENGTH - 1).join("")}…`;
}

/** The display name of a canonical name; text that is not one is returned as it is. */
function displayText(name: string): string {
	try {
		return displayNameOf(name);
	} catch {
		return name;
	}
}

function percent(part: number, whole: number): string {
	return `${whole === 0 ? 0 : Math.round((100 * part) / whole)}%`;
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
	return noun.endsWith("ch") || noun.endsWith("s") || noun.endsWith("x") ? `${noun}es` : `${noun}s`;
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
