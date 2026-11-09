import type { Knowledge, Relationship } from "../knowledge/types.ts";
import { formatName, type ObjectRef, parseName, parseSegments } from "./names.ts";
import type { Snapshot, Table } from "./snapshot.ts";

// Who points to a table. In a legacy schema this is the strongest evidence of
// what a table means: "gar" has no comment and looks like "garantías", but 500
// columns elsewhere called ref_gar or id_gar say "Artículo" in their comments.
//
// Three kinds of evidence, strongest first:
// - declared foreign keys, enforced by the engine;
// - implicit relationships the team documented (knowledge);
// - name-pattern guesses: a column called ref_gar, id_gar, cod_gar, gar_id…
//   in another table of the same database. Nothing enforces them, so they are
//   always shown as guesses.
//
// A table never references itself here: its own foreign keys are shown as
// outgoing relationships, and a self-reference says nothing about meaning.
//
// Only relationships between two tables of this snapshot count. One that
// crosses into another connection names a table of a different database
// server, even when the name is the same; heydb_table lists those apart.

/** Guesses kept per table; the rest are only counted. */
export const MAX_NAME_PATTERN_GUESSES = 200;

const SUMMARY_SIZE = 3;

export interface DeclaredReference {
	/** Canonical name of the referencing table. */
	readonly table: string;
	readonly name: string;
	readonly columns: readonly string[];
	readonly toColumns: readonly string[];
	/** Comment of the first referencing column that has one, or "". */
	readonly comment: string;
}

export interface ImplicitReference {
	readonly relationship: Relationship;
	/** Comment of the first referencing column that has one, or "". */
	readonly comment: string;
}

export interface NamePatternReference {
	/** Canonical name of the table holding the column. */
	readonly table: string;
	readonly column: string;
	readonly comment: string;
}

export interface CommentCount {
	/** The comment as first written, on one line. */
	readonly comment: string;
	readonly count: number;
}

export interface IncomingReferences {
	readonly declared: readonly DeclaredReference[];
	readonly implicit: readonly ImplicitReference[];
	/** At most MAX_NAME_PATTERN_GUESSES, commented columns first. */
	readonly guesses: readonly NamePatternReference[];
	/** Guesses found beyond the kept ones. */
	readonly moreGuesses: number;
	/** The most frequent comments of all referencing columns, guesses included. */
	readonly summary: readonly CommentCount[];
}

export function incomingReferences(snapshot: Snapshot, knowledge: Knowledge, tableName: string): IncomingReferences {
	if (parseSegments(tableName).length !== 3) throw new Error(`expected a table name (database.schema.table): got "${tableName}"`);
	const target = parseName(tableName) as Required<Omit<ObjectRef, "column">>;
	const canonical = formatName(target);
	const tables = tableIndex(snapshot);

	const declared: DeclaredReference[] = [];
	for (const [name, { table }] of tables) {
		if (name === canonical) continue;
		for (const key of table.foreignKeys) {
			if (formatName(key.references) !== canonical) continue;
			declared.push({ table: name, name: key.name, columns: key.columns, toColumns: key.references.columns, comment: commentOf(table, key.columns) });
		}
	}

	const implicit = local(knowledge)
		.filter((relationship) => relationship.to.table === canonical && relationship.from.table !== canonical)
		.map((relationship) => {
			const from = tables.get(relationship.from.table)?.table;
			return { relationship, comment: from === undefined ? "" : commentOf(from, relationship.from.columns) };
		});

	const covered = coveredColumns(snapshot, knowledge);
	const wanted = target.table.toLowerCase();
	const guesses: NamePatternReference[] = [];
	for (const [name, { database, table }] of tables) {
		if (database !== target.database || name === canonical || table.kind !== "table") continue;
		for (const column of table.columns) {
			if (covered.has(columnKey(name, column.name))) continue;
			if (namePatternTargets(column.name).includes(wanted)) guesses.push({ table: name, column: column.name, comment: column.comment });
		}
	}
	guesses.sort(
		(a, b) => Number(a.comment.trim() === "") - Number(b.comment.trim() === "") || compareText(a.table, b.table) || compareText(a.column, b.column),
	);

	const comments = [...declared.map((item) => item.comment), ...implicit.map((item) => item.comment), ...guesses.map((item) => item.comment)];
	return {
		declared: declared.sort((a, b) => compareText(a.table, b.table) || compareText(a.name, b.name)),
		implicit,
		guesses: guesses.slice(0, MAX_NAME_PATTERN_GUESSES),
		moreGuesses: Math.max(0, guesses.length - MAX_NAME_PATTERN_GUESSES),
		summary: summarize(comments),
	};
}

/**
 * How many incoming references every table has (canonical name → count),
 * counted exactly like incomingReferences, for the whole snapshot in one pass:
 * the overview ranks 2,000 tables and cannot scan every column once per table.
 */
export function incomingCounts(snapshot: Snapshot, knowledge: Knowledge): Map<string, number> {
	const counts = new Map<string, number>();
	const add = (name: string) => counts.set(name, (counts.get(name) ?? 0) + 1);
	const tables = tableIndex(snapshot);

	for (const [name, { table }] of tables) {
		for (const key of table.foreignKeys) {
			const to = formatName(key.references);
			if (to !== name) add(to);
		}
	}
	for (const relationship of local(knowledge)) {
		if (relationship.to.table !== relationship.from.table) add(relationship.to.table);
	}

	// Per database: lowercased table name → canonical names (two when only case differs).
	const byName = new Map<string, Map<string, string[]>>();
	for (const [name, { database }] of tables) {
		const names = byName.get(database) ?? new Map<string, string[]>();
		byName.set(database, names);
		const lower = (parseName(name).table as string).toLowerCase();
		names.set(lower, [...(names.get(lower) ?? []), name]);
	}
	const covered = coveredColumns(snapshot, knowledge);
	for (const [name, { database, table }] of tables) {
		if (table.kind !== "table") continue;
		const names = byName.get(database);
		for (const column of table.columns) {
			if (covered.has(columnKey(name, column.name))) continue;
			for (const candidate of namePatternTargets(column.name)) {
				for (const to of names?.get(candidate) ?? []) if (to !== name) add(to);
			}
		}
	}
	return counts;
}

/**
 * The table names a column name may point to, lowercased: what comes before
 * or after any "_". ref_gar → ref, gar; cod_gar_ant → cod, cod_gar, gar_ant,
 * ant. So "gar" matches ref_gar, id_gar, cod_gar, gar_id and gar_precio as a
 * whole token, but never ref_garantia.
 */
export function namePatternTargets(columnName: string): string[] {
	const lower = columnName.toLowerCase();
	const targets = new Set<string>();
	for (let index = lower.indexOf("_"); index !== -1; index = lower.indexOf("_", index + 1)) {
		const before = lower.slice(0, index);
		const after = lower.slice(index + 1);
		if (before !== "") targets.add(before);
		if (after !== "") targets.add(after);
	}
	return [...targets];
}

interface IndexedTable {
	readonly database: string;
	readonly table: Table;
}

function tableIndex(snapshot: Snapshot): Map<string, IndexedTable> {
	const tables = new Map<string, IndexedTable>();
	for (const database of snapshot.databases) {
		for (const schema of database.schemas) {
			for (const table of schema.tables) {
				tables.set(formatName({ database: database.name, schema: schema.name, table: table.name }), { database: database.name, table });
			}
		}
	}
	return tables;
}

// A column that is part of a foreign key or a documented relationship already
// says where it points; guessing from its name would only add noise.
function coveredColumns(snapshot: Snapshot, knowledge: Knowledge): Set<string> {
	const covered = new Set<string>();
	for (const [name, { table }] of tableIndex(snapshot)) {
		for (const key of table.foreignKeys) for (const column of key.columns) covered.add(columnKey(name, column));
	}
	for (const { from } of knowledge.relationships) {
		if (from.connection === undefined) for (const column of from.columns) covered.add(columnKey(from.table, column));
	}
	return covered;
}

/** The relationships whose two sides are tables of this connection. */
function local(knowledge: Knowledge): Relationship[] {
	return knowledge.relationships.filter(({ from, to }) => from.connection === undefined && to.connection === undefined);
}

function columnKey(table: string, column: string): string {
	return `${table}\u0000${column}`;
}

function commentOf(table: Table, columns: readonly string[]): string {
	for (const name of columns) {
		const comment = table.columns.find((column) => column.name === name)?.comment ?? "";
		if (comment.trim() !== "") return comment;
	}
	return "";
}

// "Artículo", "articulo." and " ARTÍCULO " are the same answer. Grouped
// without case, accents, extra spaces or end punctuation; shown as first written.
function summarize(comments: readonly string[]): CommentCount[] {
	const groups = new Map<string, { comment: string; count: number }>();
	for (const comment of comments) {
		const shown = comment.replace(/\s+/g, " ").trim();
		const key = fold(shown);
		if (key === "") continue;
		const group = groups.get(key);
		if (group === undefined) groups.set(key, { comment: shown.replace(/[.:;,]+$/, ""), count: 1 });
		else group.count += 1;
	}
	return [...groups.values()]
		.sort((a, b) => b.count - a.count || compareText(a.comment, b.comment))
		.slice(0, SUMMARY_SIZE)
		.map(({ comment, count }) => ({ comment, count }));
}

// The same folding as normalizeText in lib/search.ts, which model code must not import.
function fold(text: string): string {
	return text
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[.:;,]+$/, "");
}

// Plain code-unit comparison: the same order on every machine and locale.
function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
