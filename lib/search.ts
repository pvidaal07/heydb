import type { Annotation, Knowledge, RelationshipSide } from "./knowledge/types.ts";
import { displayName, formatName, parseName } from "./model/names.ts";
import { incomingReferences, namePatternTargets } from "./model/references.ts";
import type { Snapshot, Table } from "./model/snapshot.ts";

// Search over the stored snapshot and knowledge; it never touches the server.
//
// Matching ignores case and accents on both sides: Spanish legacy schemas mix
// "facturacion" and "facturación", "año" and "ano", and nobody remembers which
// one a table used. Text is decomposed (NFD: "ó" becomes "o" plus a combining
// accent), the combining marks are dropped, and the rest is lowercased.
//
// Results are tables (and views, databases, documented relationships), never
// loose columns: a column that matches is listed under its table, so 40
// matching columns of one table cost one line, not 40. Each result adds up
// the evidence it matched on, strongest first:
//
//   exact table name                                   1000
//   table comment or team note, the query as a word     500
//   inferred meaning: the comments of the columns that
//   reference the table contain the query as a word     200 + 10 per reference (up to 15)
//   table name starts with the query                    150
//   table comment or note, inside a longer word         120
//   table name contains the query                       100
//   view definition                                     60 as a word, 30 inside one
//   its columns (name or comment or note)               up to 50, + 1 per extra column (up to 4)
//
// Databases score like tables by name and notes; a documented relationship
// by its note (120 as a word, 30 inside one). A table name is also an exact
// match when only a plural differs: "cliente" finds a table called clientes.
//
// Inferred meaning is how "cliente" finds cus, a table without comment that
// fifty columns called cod_cus describe as "Cliente Habitual". It is evidence,
// not a fact: such results carry `inferred` so the agent says so. The
// evidence is the summary heydb_table shows ("Referencing columns are
// commented as", from incomingReferences), read for the MAX_INFERRED_TABLES
// tables most pointed to by matching columns: each summary scans a database,
// so the cost stays bounded on a 2,000-table schema.
//
// "As a word" folds simple plurals (see foldWord), so "clientes" finds
// "Cliente" and "articulos" finds "Artículo".

export type SearchObject = "database" | "table" | "view" | "relationship";

export interface ColumnMatch {
	readonly name: string;
	/** The matched comment or note, cut; "" when the name matched. */
	readonly snippet: string;
}

export interface SearchResult {
	/** Canonical name; for a relationship, "from(columns) → to(columns)". */
	readonly target: string;
	readonly object: SearchObject;
	/**
	 * Why it matched, strongest first: "name", "table comment: …", "note: …",
	 * 'referenced as "Cliente Habitual" ×7 (inferred)', "columns: …".
	 */
	readonly matchedIn: readonly string[];
	/** At most SNIPPET_LENGTH characters of the strongest matched text, around the match; "" when only names matched. */
	readonly snippet: string;
	/** True when part of the match is meaning inferred from referencing columns: an inference, not a fact. */
	readonly inferred: boolean;
	/** Matching columns of a table or view, best first, at most MAX_COLUMNS. */
	readonly columns: readonly ColumnMatch[];
	/** Matching columns beyond those listed. */
	readonly moreColumns: number;
	/** The two sides of a relationship result, canonical. */
	readonly relationship?: { readonly from: RelationshipSide; readonly to: RelationshipSide };
}

export interface SearchResults {
	/** The best `limit` results. */
	readonly results: readonly SearchResult[];
	/** How many matched in total, so callers can say "showing 20 of 87". */
	readonly total: number;
}

export interface SearchOptions {
	readonly limit?: number;
	/** Only this database: "acme", "acme.acme", or in PostgreSQL "app" or "app.public". */
	readonly database?: string;
}

export const SNIPPET_LENGTH = 120;
const COLUMN_SNIPPET_LENGTH = 60;
const MAX_COLUMNS = 5;
/** Tables whose referencing columns are summarized per search; each costs one scan of its database. */
const MAX_INFERRED_TABLES = 10;
const MAX_DATABASES_LISTED = 10;

const SCORE = {
	exactName: 1000,
	statedWord: 500,
	inferred: 200,
	perReference: 10,
	maxReferences: 15,
	namePrefix: 150,
	statedText: 120,
	nameContains: 100,
	definitionWord: 60,
	definitionText: 30,
	columnExact: 50,
	columnWord: 40,
	columnPrefix: 30,
	columnContains: 20,
	columnText: 15,
	maxExtraColumns: 4,
} as const;

const OBJECT_ORDER: readonly SearchObject[] = ["database", "table", "view", "relationship"];

/** Lowercase and without accents: "Facturación" becomes "facturacion". */
export function normalizeText(text: string): string {
	return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * The stem a normalized word is compared by, so a singular finds its plural:
 * on words longer than 4 characters, one final "s" goes (not after another
 * "s": "address"), then one final "e". clientes → cliente → client;
 * proveedores → proveedore → proveedor; facturas → factura.
 *
 * Deliberately small: irregular plurals (lápiz/lápices, child/children) and
 * synonyms are not folded, and two different words may share a stem now and
 * then. It only decides what counts as "the same word"; substrings still match.
 */
export function foldWord(word: string): string {
	let stem = word;
	if (stem.length > 4 && stem.endsWith("s") && !stem.endsWith("ss")) stem = stem.slice(0, -1);
	if (stem.length > 4 && stem.endsWith("e")) stem = stem.slice(0, -1);
	return stem;
}

export function searchSchema(snapshot: Snapshot, knowledge: Knowledge, query: string, options: SearchOptions = {}): SearchResults {
	const { limit = 20 } = options;
	const q = parseQuery(query);
	const wanted = databaseFilter(snapshot, options.database);

	const notes = notesByTarget(knowledge.annotations);
	const results: Draft[] = [];
	const tables = new Map<string, Draft>();
	const draft = (target: string, object: SearchObject): Draft => {
		const existing = tables.get(target);
		if (existing !== undefined) return existing;
		const created: Draft = { target, object, signals: [], columns: [], inferred: false };
		tables.set(target, created);
		results.push(created);
		return created;
	};

	// Per database, lowercased table name → canonical names: where a column
	// named cod_cus may point. Two entries when names differ only by case.
	const byName = new Map<string, Map<string, string[]>>();
	const kinds = new Map<string, Table["kind"]>();
	for (const database of snapshot.databases) {
		const names = new Map<string, string[]>();
		byName.set(database.name, names);
		for (const schema of database.schemas) {
			for (const table of schema.tables) {
				const name = formatName({ database: database.name, schema: schema.name, table: table.name });
				const lower = table.name.toLowerCase();
				names.set(lower, [...(names.get(lower) ?? []), name]);
				kinds.set(name, table.kind);
			}
		}
	}
	const documented = new Map<string, string>(); // table + column → table it points to, from the team's relationships
	for (const { from, to } of knowledge.relationships) {
		// A column pointing into another connection infers nothing about the tables of this one.
		if (from.connection !== undefined || to.connection !== undefined) continue;
		for (const name of from.columns) documented.set(columnKey(from.table, name), to.table);
	}

	// How many columns whose comment has the query as a word point to each table:
	// the candidates for inferred meaning, before their summaries are read.
	const pointedTo = new Map<string, number>();

	for (const database of snapshot.databases) {
		for (const schema of database.schemas) {
			const included = wanted === null || wanted.has(schemaKey(database.name, schema.name));
			const schemaName = formatName({ database: database.name, schema: schema.name });
			if (included) {
				const signals = [
					...nameSignals(database.name, q),
					...(schema.name === database.name ? [] : nameSignals(schema.name, q)),
					...noteSignals(notes.get(schemaName), q),
				];
				if (signals.length > 0) draft(schemaName, "database").signals.push(...bestNameFirst(signals));
			}

			for (const table of schema.tables) {
				const ref = { database: database.name, schema: schema.name, table: table.name };
				const tableName = formatName(ref);
				if (included) collectTable(table, tableName, notes, q, draft);

				for (const column of table.columns) {
					if (column.comment === "" || !isWordMatch(column.comment, q)) continue;
					for (const target of pointsTo(table, tableName, column.name, database.name, byName, documented)) {
						pointedTo.set(target, (pointedTo.get(target) ?? 0) + 1);
					}
				}
			}
		}
	}

	const candidates = [...pointedTo.entries()]
		.filter(([name]) => wanted === null || wanted.has(schemaKeyOf(name)))
		.sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))
		.slice(0, MAX_INFERRED_TABLES);
	for (const [name] of candidates) {
		const matching = incomingReferences(snapshot, knowledge, name).summary.filter((item) => isWordMatch(item.comment, q));
		if (matching.length === 0) continue;
		const references = matching.reduce((sum, item) => sum + item.count, 0);
		const target = draft(name, kinds.get(name) ?? "table");
		target.inferred = true;
		target.signals.push({
			score: SCORE.inferred + SCORE.perReference * Math.min(references, SCORE.maxReferences),
			label: `referenced as ${matching.map((item) => `"${item.comment}" ×${item.count}`).join(", ")} (inferred)`,
			snippet: "",
		});
	}

	for (const relationship of knowledge.relationships) {
		// Only a side in this connection can be in one of its databases.
		const here = [relationship.from, relationship.to].filter((item) => item.connection === undefined);
		if (wanted !== null && !here.some((item) => wanted.has(schemaKeyOf(item.table)))) continue;
		const signals = textSignal("relationship note", textMatch(relationship.note, q, SNIPPET_LENGTH), SCORE.statedText, SCORE.definitionText);
		if (signals.length === 0) continue;
		results.push({
			target: `${side(relationship.from)} → ${side(relationship.to)}`,
			object: "relationship",
			signals,
			columns: [],
			inferred: false,
			relationship: { from: relationship.from, to: relationship.to },
		});
	}

	const finished = results.map(finish).sort(compareRanked);
	return { results: finished.slice(0, Math.max(0, limit)).map((item) => item.result), total: finished.length };
}

interface Query {
	/** The normalized query, spaces collapsed. */
	readonly needle: string;
	/** Its words, folded; empty when it has no letters or digits. */
	readonly words: readonly string[];
	/** The folded query when it is one plain word ("clientes" → "client"), else null: names match it too. */
	readonly folded: string | null;
	/** `folded` when it differs from the needle, else null: prefixes and substrings to try besides the needle. */
	readonly stem: string | null;
}

function parseQuery(query: string): Query {
	const needle = normalizeText(collapse(query));
	if (needle === "") throw new Error("search query must not be empty");
	const words = splitWords(needle);
	const folded = words.length === 1 && /^[\p{L}\p{N}]+$/u.test(needle) ? (words[0] as string) : null;
	return { needle, words, folded, stem: folded !== needle ? folded : null };
}

interface Signal {
	readonly score: number;
	readonly label: string;
	/** The matched text, for SearchResult.snippet; "" for names and inferences. */
	readonly snippet: string;
}

interface Draft {
	readonly target: string;
	readonly object: SearchObject;
	readonly signals: Signal[];
	readonly columns: (ColumnMatch & { score: number; position: number })[];
	inferred: boolean;
	readonly relationship?: SearchResult["relationship"];
}

interface Ranked {
	readonly score: number;
	readonly result: SearchResult;
}

type Notes = ReadonlyMap<string, readonly Annotation[]>;

function collectTable(table: Table, tableName: string, notes: Notes, q: Query, draft: (target: string, object: SearchObject) => Draft): void {
	const signals: Signal[] = [
		...nameSignals(table.name, q),
		...textSignal("table comment", textMatch(table.comment, q, SNIPPET_LENGTH), SCORE.statedWord, SCORE.statedText),
		...noteSignals(notes.get(tableName), q),
		...textSignal("definition", textMatch(table.viewDefinition ?? "", q, SNIPPET_LENGTH), SCORE.definitionWord, SCORE.definitionText),
	];

	const columns: Draft["columns"] = [];
	for (const column of table.columns) {
		const name = nameRank(column.name, q);
		const nameScore = name === "exact" ? SCORE.columnExact : name === "prefix" ? SCORE.columnPrefix : SCORE.columnContains;
		let best: { score: number; snippet: string } | null = name === null ? null : { score: nameScore, snippet: "" };
		const columnNotes = (notes.get(columnKey(tableName, column.name)) ?? []).map((note) => note.text);
		for (const text of [column.comment, ...columnNotes]) {
			const match = textMatch(text, q, COLUMN_SNIPPET_LENGTH);
			const score = match === null ? 0 : match.word ? SCORE.columnWord : SCORE.columnText;
			if (match !== null && (best === null || score > best.score)) best = { score, snippet: match.snippet };
		}
		if (best !== null) columns.push({ name: column.name, snippet: best.snippet, score: best.score, position: column.position });
	}

	if (signals.length === 0 && columns.length === 0) return;
	const target = draft(tableName, table.kind);
	target.signals.push(...signals);
	target.columns.push(...columns);
}

/** The tables a column may point to: its foreign key, a documented relationship, or else its name pattern. */
function pointsTo(
	table: Table,
	tableName: string,
	column: string,
	database: string,
	byName: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>,
	documented: ReadonlyMap<string, string>,
): string[] {
	const key = table.foreignKeys.find((item) => item.columns.includes(column));
	if (key !== undefined) return [formatName(key.references)].filter((name) => name !== tableName);
	const related = documented.get(columnKey(tableName, column));
	if (related !== undefined) return related === tableName ? [] : [related];
	// incomingReferences only reads name patterns from tables: views repeat their columns.
	if (table.kind !== "table") return [];
	const names = byName.get(database);
	return namePatternTargets(column).flatMap((candidate) => names?.get(candidate) ?? []).filter((name) => name !== tableName);
}

function finish(draft: Draft): Ranked {
	const columns = [...draft.columns].sort((a, b) => b.score - a.score || a.position - b.position);
	const signals = [...draft.signals];
	const [bestColumn] = columns;
	if (bestColumn !== undefined) {
		const shown = columns.slice(0, MAX_COLUMNS);
		const more = columns.length - shown.length;
		const list = shown.map((column) => (column.snippet === "" ? column.name : `${column.name} ("${column.snippet}")`)).join(", ");
		signals.push({
			score: bestColumn.score + Math.min(columns.length - 1, SCORE.maxExtraColumns),
			label: `columns: ${list}${more > 0 ? ` (+${more} more)` : ""}`,
			snippet: "",
		});
	}
	// Stable sort: equal scores keep the order they were found in (name before comment).
	signals.sort((a, b) => b.score - a.score);
	const snippet = signals.find((signal) => signal.snippet !== "")?.snippet ?? "";
	const result: SearchResult = {
		target: draft.target,
		object: draft.object,
		matchedIn: signals.map((signal) => signal.label),
		snippet,
		inferred: draft.inferred,
		columns: columns.slice(0, MAX_COLUMNS).map(({ name, snippet: text }) => ({ name, snippet: text })),
		moreColumns: Math.max(0, columns.length - MAX_COLUMNS),
		...(draft.relationship !== undefined && { relationship: draft.relationship }),
	};
	return { score: signals.reduce((sum, signal) => sum + signal.score, 0), result };
}

function nameSignals(name: string, q: Query): Signal[] {
	const rank = nameRank(name, q);
	if (rank === null) return [];
	const score = rank === "exact" ? SCORE.exactName : rank === "prefix" ? SCORE.namePrefix : SCORE.nameContains;
	return [{ score, label: "name", snippet: "" }];
}

// A database matching by both its name and its schema name counts once.
function bestNameFirst(signals: readonly Signal[]): Signal[] {
	const names = signals.filter((signal) => signal.label === "name").sort((a, b) => b.score - a.score);
	return [...names.slice(0, 1), ...signals.filter((signal) => signal.label !== "name")];
}

function noteSignals(notes: readonly Annotation[] | undefined, q: Query): Signal[] {
	return (notes ?? []).flatMap((note) => textSignal("note", textMatch(note.text, q, SNIPPET_LENGTH), SCORE.statedWord, SCORE.statedText));
}

function textSignal(label: string, match: { word: boolean; snippet: string } | null, wordScore: number, textScore: number): Signal[] {
	if (match === null) return [];
	return [{ score: match.word ? wordScore : textScore, label: `${label}: ${match.snippet}`, snippet: match.snippet }];
}

function nameRank(name: string, q: Query): "exact" | "prefix" | "contains" | null {
	const normalized = normalizeText(name);
	if (normalized === q.needle) return "exact";
	if (q.folded !== null && /^[\p{L}\p{N}]+$/u.test(normalized) && foldWord(normalized) === q.folded) return "exact";
	if (normalized.startsWith(q.needle) || (q.stem !== null && normalized.startsWith(q.stem))) return "prefix";
	if (normalized.includes(q.needle) || (q.stem !== null && normalized.includes(q.stem))) return "contains";
	return null;
}

/**
 * Where the query is in `raw`: as whole words (word: true), or only inside
 * longer words; null when it is not there. The snippet is cut around it.
 */
function textMatch(raw: string, q: Query, length: number): { word: boolean; snippet: string } | null {
	if (raw === "") return null;
	const text = collapse(raw);
	const word = hasWords(normalizeText(text), q);
	if (word === null) return null;
	return { word, snippet: snippetAround(text, word ? (q.words[0] as string) : q.needle, length) };
}

function isWordMatch(raw: string, q: Query): boolean {
	return raw !== "" && hasWords(normalizeText(raw), q) === true;
}

/** true: the query is there as whole words; false: only inside longer words; null: not there. */
function hasWords(normalized: string, q: Query): boolean | null {
	const first = q.words[0];
	const inside = normalized.includes(q.needle);
	// Cheap check first: a word match needs the stem of the first word somewhere.
	if (!inside && (first === undefined || !normalized.includes(first))) return null;
	const word = q.words.length > 0 && containsWords(splitWords(normalized), q.words);
	return word ? true : inside ? false : null;
}

function splitWords(normalized: string): string[] {
	return normalized
		.split(/[^\p{L}\p{N}]+/u)
		.filter((word) => word !== "")
		.map(foldWord);
}

function containsWords(words: readonly string[], wanted: readonly string[]): boolean {
	for (let start = 0; start + wanted.length <= words.length; start++) {
		if (wanted.every((word, index) => words[start + index] === word)) return true;
	}
	return false;
}

/**
 * The part of `text` around the first occurrence of `needle` in its
 * normalized form, at most `length` characters including the "…" that mark
 * cut ends. Matching happens on the normalized text, but the snippet is cut
 * from the original, so accents are shown as written.
 */
function snippetAround(text: string, needle: string, length: number): string {
	if (text.length <= length) return text;
	// normalized[i] came from text[origin[i]]: removing accents changes lengths.
	let normalized = "";
	const origin: number[] = [];
	let index = 0;
	for (const character of text) {
		const part = normalizeText(character);
		normalized += part;
		for (let unit = 0; unit < part.length; unit++) origin.push(index);
		index += character.length;
	}
	origin.push(text.length);

	const at = Math.max(0, normalized.indexOf(needle));
	const matchStart = origin[at] as number;
	const room = length - 2; // two characters kept for the "…" at each end
	const start = Math.max(0, Math.min(matchStart - Math.floor(length / 3), text.length - room));
	const end = Math.min(text.length, start + room);
	return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/** Line breaks and runs of spaces become one space: a snippet is one line. */
function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * The (database, schema) pairs `database` names, as a set of schemaKey;
 * null without a filter. Exact spelling first, then ignoring case, like the
 * resolve functions.
 */
function databaseFilter(snapshot: Snapshot, database: string | undefined): Set<string> | null {
	if (database === undefined) return null;
	const typed = database.trim();
	const pairs = snapshot.databases.flatMap((item) =>
		item.schemas.map((schema) => {
			const ref = { database: item.name, schema: schema.name };
			return { key: schemaKey(item.name, schema.name), shown: displayName(ref), names: [item.name, formatName(ref), displayName(ref)] };
		}),
	);
	let matches = pairs.filter((pair) => pair.names.includes(typed));
	if (matches.length === 0) matches = pairs.filter((pair) => pair.names.some((name) => name.toLowerCase() === typed.toLowerCase()));
	if (matches.length === 0) {
		const known = [...new Set(pairs.map((pair) => pair.shown))].sort(compareText);
		const shown = known.slice(0, MAX_DATABASES_LISTED).join(", ");
		const more = known.length > MAX_DATABASES_LISTED ? ` and ${known.length - MAX_DATABASES_LISTED} more` : "";
		throw new Error(`no database matches "${database}"; databases: ${shown}${more}`);
	}
	return new Set(matches.map((pair) => pair.key));
}

function notesByTarget(annotations: readonly Annotation[]): Map<string, Annotation[]> {
	const notes = new Map<string, Annotation[]>();
	for (const annotation of annotations) {
		const { database, schema, table, column } = parseName(annotation.target);
		const key = column === undefined ? annotation.target : columnKey(formatName({ database, schema, ...(table !== undefined && { table }) }), column);
		notes.set(key, [...(notes.get(key) ?? []), annotation]);
	}
	return notes;
}

function side({ connection, table, columns }: RelationshipSide): string {
	return `${connection === undefined ? "" : `${connection}: `}${table}(${columns.join(", ")})`;
}

function schemaKey(database: string, schema: string): string {
	return `${database}\u0000${schema}`;
}

function schemaKeyOf(canonical: string): string {
	const { database, schema } = parseName(canonical);
	return schemaKey(database, schema);
}

function columnKey(table: string, column: string): string {
	return `${table}\u0000${column}`;
}

function compareRanked(a: Ranked, b: Ranked): number {
	return (
		b.score - a.score ||
		OBJECT_ORDER.indexOf(a.result.object) - OBJECT_ORDER.indexOf(b.result.object) ||
		compareText(a.result.target, b.result.target)
	);
}

// Plain code-unit comparison: the same order on every machine and locale.
function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
