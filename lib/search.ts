import type { Annotation, Knowledge, RelationshipSide } from "./knowledge/types.ts";
import { displayName, formatName, parseName } from "./model/names.ts";
import { type CommentCount, incomingReferences, namePatternTargets } from "./model/references.ts";
import type { Snapshot, Table } from "./model/snapshot.ts";

// Search over the stored snapshot and knowledge; it never touches the server.
//
// Matching ignores case and accents on both sides: Spanish legacy schemas mix
// "facturacion" and "facturación", "año" and "ano", and nobody remembers which
// one a table used. Text is decomposed (NFD: "ó" becomes "o" plus a combining
// accent), the combining marks are dropped, and the rest is lowercased.
//
// The query is a bag of words, not a phrase: "facturas de venta cabecera"
// finds a table whose comment says "Cabecera de las facturas de venta" and
// one called fac_cab. The query is split on anything that is not a letter or
// a digit, stopwords go ("de", "las", "the", "of", and the words people wrap a
// question in: "tabla", "donde", "guarda", "field"…; all of them stay when
// nothing else is left), and every word is folded (see foldWord), so plurals
// match their singular.
//
// Each table or view is a document with fields, every one split into words
// the same way (names also on "_", digits and camelCase: fac_cab2019 is fac,
// cab, 2019). Field weights, strongest first:
//
//   table name                                             3
//   table comment, team notes on the table                 3
//   inferred meaning: comments of the columns that
//   reference the table (incomingReferences)               2
//   column comments and column notes                       1
//   column names                                           0.6
//   view definition                                        0.4
//
// Databases are documents with their name and notes; a documented
// relationship, with its note (1.5).
//
// A query word matches a word of a field when it is the same word (full
// weight); when it starts the longer word and has 4 letters or more ("factur"
// finds "facturacion", 0.7); or, in table and column names only, when the
// name part of 3 letters or more starts the query word: legacy names are
// abbreviations, so "albaran" finds alb_lin and "factura" fac_cab (0.5, shown
// as "name (abbreviation)"). A column name part that only repeats an
// abbreviation of its own table (num_fac in fac_cab) does not count again.
//
// The score is BM25F: per query word, the weighted matches of all fields
// (each field normalized by its length against the average, so a short
// comment that matches says more than a long one) saturate (k1 = 1.2) and are
// multiplied by how rare the word is among the documents searched (IDF), so a
// word every table has counts little. The words are added up, and the sum is
// multiplied by the square of the share of query words the document matched:
// a table that matches every word outranks one that matches one word well,
// but a table matching only some words is still listed. On top, an exact
// name (the query is the table name, plurals and "_" aside: "cliente" finds
// clientes, "order lines" order_lines) adds 1000, and the query found as a
// phrase, in order and without stopwords in between, adds the sum of its
// IDFs (half of it in a column comment).
//
// Results are tables (and views, databases, documented relationships), never
// loose columns: a column that matches is listed under its table, so 40
// matching columns of one table cost one line, not 40. Each result says what
// it matched, strongest field first, and what it is (`about`: the table
// comment, else a team note), so the agent can often answer from the results
// alone.
//
// Without a limit, the 10 best are returned, and only those scoring at least
// WEAK_SHARE of the best (the exact-name bonus left out on both sides; an
// exact name always stays): a table matching one word of four, or a passing
// mention in a column comment, is counted in `weaker` instead of costing a
// line. An explicit limit returns that many, weak or not.
//
// Inferred meaning is how "cliente" finds cus, a table without comment that
// fifty columns called cod_cus describe as "Cliente Habitual". It is evidence,
// not a fact: such results carry `inferred` so the agent says so. The
// evidence is the summary heydb_table shows ("Referencing columns are
// commented as", from incomingReferences), read for the MAX_INFERRED_TABLES
// tables most pointed to by columns whose comment matches: each summary scans
// a database, so the cost stays bounded on a 2,000-table schema.
//
// One database per company repeats every table: copies with the same name and
// the same columns (names and types) in other databases are one result, the
// first in snapshot order, with `alsoIn` naming the rest; `total` counts those
// results. Query words that match nothing anywhere are in `unmatched`, so the
// agent can try another word instead of the same search again.

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
	 * Why it matched, strongest first: "name", "name (abbreviation)",
	 * "table comment: …", "note: …", 'referenced as "Cliente Habitual" ×7 (inferred)', "columns: …".
	 */
	readonly matchedIn: readonly string[];
	/** At most SNIPPET_LENGTH characters of the strongest matched text, around the match; "" when only names matched. */
	readonly snippet: string;
	/**
	 * What it is, on one line and uncut: the table comment, else its matching (or
	 * first) team note; a database's note; a relationship's note. "" when there
	 * is none: then `snippet` is the best there is.
	 */
	readonly about: string;
	/** True when part of the match is meaning inferred from referencing columns: an inference, not a fact. */
	readonly inferred: boolean;
	/** The comments of the referencing columns that matched, when inferred. */
	readonly inferredFrom?: readonly CommentCount[];
	/** True when the only thing that matched is an abbreviation in its name (alb_cab for "albarán"). */
	readonly abbreviated: boolean;
	/** Matching columns of a table or view, best first, at most MAX_COLUMNS. */
	readonly columns: readonly ColumnMatch[];
	/** Matching columns beyond those listed. */
	readonly moreColumns: number;
	/** The two sides of a relationship result, canonical. */
	readonly relationship?: { readonly from: RelationshipSide; readonly to: RelationshipSide };
	/** Other databases with an identical table (same name, same columns) that matched too, as displayed; absent when none. */
	readonly alsoIn?: readonly string[];
}

export interface SearchResults {
	/** The best `limit` results. */
	readonly results: readonly SearchResult[];
	/** How many matched in total, identical copies counted once, so callers can say "showing 10 of 87". */
	readonly total: number;
	/** Matches left out for scoring far below the best; 0 with an explicit limit. Optional for callers building results by hand. */
	readonly weaker?: number;
	/** Query words, as typed but normalized, that match nothing in the databases searched. */
	readonly unmatched?: readonly string[];
}

export interface SearchOptions {
	/** How many results; without it, DEFAULT_SEARCH_LIMIT and the weak ones left out. */
	readonly limit?: number;
	/** Only this database: "acme", "acme.acme", or in PostgreSQL "app" or "app.public". */
	readonly database?: string;
}

export const SNIPPET_LENGTH = 120;
export const DEFAULT_SEARCH_LIMIT = 10;
/** Without a limit, results scoring under this share of the best are only counted. */
const WEAK_SHARE = 0.2;
const COLUMN_SNIPPET_LENGTH = 40;
const MAX_COLUMNS = 5;
/** Tables whose referencing columns are summarized per search; each costs one scan of its database. */
const MAX_INFERRED_TABLES = 10;
const MAX_DATABASES_LISTED = 10;

type Field = "name" | "stated" | "inferred" | "columnText" | "columnName" | "definition" | "relationship";

/** Weight of a match in each field, and how much its length tempers it (BM25 b). */
const FIELDS: Readonly<Record<Field, { readonly weight: number; readonly b: number }>> = {
	name: { weight: 3, b: 0.5 },
	stated: { weight: 3, b: 0.5 },
	inferred: { weight: 2, b: 0 },
	columnText: { weight: 1, b: 0.75 },
	columnName: { weight: 0.6, b: 0.75 },
	definition: { weight: 0.4, b: 0.75 },
	relationship: { weight: 1.5, b: 0 },
};
const FIELD_NAMES = Object.keys(FIELDS) as Field[];

const MATCH = { exact: 1, extension: 0.7, abbreviation: 0.5 } as const;
/** Shortest query word that finds the longer words it starts; shortest name part read as an abbreviation. */
const MIN_EXTENSION = 4;
const MIN_ABBREVIATION = 3;
const K1 = 1.2;
const EXACT_NAME_BONUS = 1000;
const PHRASE_BONUS = { stated: 1, column: 0.5 } as const;

/** Words a question is wrapped in that say nothing about the schema, Spanish and English. */
const STOPWORDS: ReadonlySet<string> = new Set([
	// Spanish
	"de", "del", "la", "las", "el", "los", "lo", "un", "una", "unos", "unas", "y", "e", "o", "u", "a", "al", "en", "por",
	"para", "con", "que", "se", "su", "sus", "es", "son", "esta", "este", "estan", "como", "cual", "cuales", "donde",
	"cuando", "hay", "tiene", "tienen", "tabla", "tablas", "campo", "campos", "columna", "columnas", "guarda", "guardan",
	"guardar", "guardado", "guardados", "almacena", "almacenan",
	// English
	"the", "of", "an", "and", "or", "to", "in", "for", "with", "by", "on", "at", "from", "is", "are", "which", "where",
	"what", "how", "table", "tables", "field", "fields", "column", "columns", "store", "stores", "stored", "save", "saved", "kept",
]);

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
 * then. It only decides what counts as "the same word".
 */
export function foldWord(word: string): string {
	let stem = word;
	if (stem.length > 4 && stem.endsWith("s") && !stem.endsWith("ss")) stem = stem.slice(0, -1);
	if (stem.length > 4 && stem.endsWith("e")) stem = stem.slice(0, -1);
	return stem;
}

export function searchSchema(snapshot: Snapshot, knowledge: Knowledge, query: string, options: SearchOptions = {}): SearchResults {
	const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
	const q = parseQuery(query);
	const wanted = databaseFilter(snapshot, options.database);
	if (q.words.length === 0) return { results: [], total: 0, weaker: 0, unmatched: [q.needle] };

	const match = matcher(q);
	const notes = notesByTarget(knowledge.annotations);
	const docs: Doc[] = [];
	const byTarget = new Map<string, Doc>();

	// Per database, lowercased table name → canonical names: where a column
	// named cod_cus may point. Two entries when names differ only by case.
	const byName = new Map<string, Map<string, string[]>>();
	for (const database of snapshot.databases) {
		const names = new Map<string, string[]>();
		byName.set(database.name, names);
		for (const schema of database.schemas) {
			for (const table of schema.tables) {
				const name = formatName({ database: database.name, schema: schema.name, table: table.name });
				const lower = table.name.toLowerCase();
				names.set(lower, [...(names.get(lower) ?? []), name]);
			}
		}
	}
	const documented = new Map<string, string>(); // table + column → table it points to, from the team's relationships
	for (const { from, to } of knowledge.relationships) {
		// A column pointing into another connection infers nothing about the tables of this one.
		if (from.connection !== undefined || to.connection !== undefined) continue;
		for (const name of from.columns) documented.set(columnKey(from.table, name), to.table);
	}

	// Columns whose comment matches, weighted by how many query words, per
	// table they point to: the candidates for inferred meaning.
	const pointedTo = new Map<string, number>();

	for (const database of snapshot.databases) {
		for (const schema of database.schemas) {
			const included = wanted === null || wanted.has(schemaKey(database.name, schema.name));
			const schemaName = formatName({ database: database.name, schema: schema.name });
			if (included) {
				const doc = newDoc(schemaName, "database", docs.length);
				const names = schema.name === database.name ? [database.name] : [database.name, schema.name];
				const matched = names.map((name) => match.text(name));
				addName(doc, matched);
				doc.exactName = names.some((name) => match.isExactName(name));
				const own = notes.get(schemaName) ?? [];
				for (const note of own) addText(doc, "stated", "note", note.text, match.text(note.text), SNIPPET_LENGTH);
				doc.about = bestNote(own, match);
				docs.push(doc);
			}

			for (const table of schema.tables) {
				const tableName = formatName({ database: database.name, schema: schema.name, table: table.name });
				if (included) {
					const doc = collectTable(table, tableName, notes, match, docs.length);
					doc.copy = { key: copyKey(table, database.name, schema.name), shown: displayName({ database: database.name, schema: schema.name }) };
					docs.push(doc);
					byTarget.set(tableName, doc);
				}
				for (const column of table.columns) {
					if (column.comment === "") continue;
					const words = covered(match.text(column.comment).tf);
					if (words === 0) continue;
					for (const target of pointsTo(table, tableName, column.name, database.name, byName, documented)) {
						pointedTo.set(target, (pointedTo.get(target) ?? 0) + words);
					}
				}
			}
		}
	}

	const candidates = [...pointedTo.entries()]
		.filter(([name]) => byTarget.has(name))
		.sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))
		.slice(0, MAX_INFERRED_TABLES);
	for (const [name] of candidates) {
		const doc = byTarget.get(name) as Doc;
		const tf = new Array<number>(q.words.length).fill(0);
		const shown: string[] = [];
		const from: CommentCount[] = [];
		let phrase = false;
		for (const item of incomingReferences(snapshot, knowledge, name).summary) {
			const matched = match.text(item.comment);
			if (matched.tf === null) continue;
			// Fifty references say more than one, but not fifty times more.
			const times = 1 + Math.log(item.count);
			matched.tf.forEach((value, index) => {
				tf[index] = (tf[index] as number) + value * times;
			});
			phrase ||= matched.phrase;
			shown.push(`"${item.comment}" ×${item.count}`);
			from.push(item);
		}
		if (shown.length === 0) continue;
		doc.inferred = true;
		doc.inferredFrom = from;
		addEvidence(doc, { field: "inferred", label: `referenced as ${shown.join(", ")} (inferred)`, snippet: "", tf, length: 0 });
		if (phrase) doc.phrase = Math.max(doc.phrase, PHRASE_BONUS.stated);
	}

	for (const relationship of knowledge.relationships) {
		// Only a side in this connection can be in one of its databases.
		const here = [relationship.from, relationship.to].filter((item) => item.connection === undefined);
		if (wanted !== null && !here.some((item) => wanted.has(schemaKeyOf(item.table)))) continue;
		const doc = newDoc(`${side(relationship.from)} → ${side(relationship.to)}`, "relationship", docs.length);
		doc.relationship = { from: relationship.from, to: relationship.to };
		doc.about = collapse(relationship.note);
		addText(doc, "relationship", "relationship note", relationship.note, match.text(relationship.note), SNIPPET_LENGTH);
		docs.push(doc);
	}

	const ranked = rank(docs, q);
	const unmatched = q.shown.filter((_, index) => !docs.some((doc) => doc.matched[index]));
	const best = Math.max(0, ...ranked.map((item) => item.base));
	const kept = options.limit !== undefined ? ranked : ranked.filter((item) => item.exactName || item.base >= WEAK_SHARE * best);
	const results = kept.slice(0, Math.max(0, limit)).map((item) => item.result);
	return { results, total: ranked.length, weaker: ranked.length - kept.length, unmatched };
}

interface Query {
	/** The normalized query, spaces collapsed. */
	readonly needle: string;
	/** Its words without stopwords, folded, each once; empty when it has no letters or digits. */
	readonly words: readonly string[];
	/** Each word as typed, normalized, for messages. */
	readonly shown: readonly string[];
	/** The words in order, joined by spaces: what a table name must be to be the exact name. */
	readonly exact: string;
	/** True when every word was a stopword and they were kept. */
	readonly stopwordsOnly: boolean;
}

function parseQuery(query: string): Query {
	const needle = normalizeText(collapse(query));
	if (needle === "") throw new Error("search query must not be empty");
	const typed = needle.split(/[^\p{L}\p{N}]+/u).filter((word) => word !== "");
	const content = typed.filter((word) => !STOPWORDS.has(word));
	const stopwordsOnly = content.length === 0 && typed.length > 0;
	const kept = stopwordsOnly ? typed : content;
	const words: string[] = [];
	const shown: string[] = [];
	for (const word of kept) {
		const folded = foldWord(word);
		if (words.includes(folded)) continue;
		words.push(folded);
		shown.push(word);
	}
	return { needle, words, shown, exact: kept.map(foldWord).join(" "), stopwordsOnly };
}

/** How one text matched the query, computed once per distinct text. */
interface Matched {
	/** Words that count for the length of a field: stopwords do not. */
	readonly length: number;
	/** Per query word, the sum of its matches' weights; null when no word matched. */
	readonly tf: readonly number[] | null;
	/** True when the only matches were abbreviations. */
	readonly abbreviated: boolean;
	/** The first word that matched, as folded: where the snippet is cut. */
	readonly first: string;
	/** Every word that matched, as folded. */
	readonly hits: readonly string[];
	/** True when the query words are there in order, as a phrase. */
	readonly phrase: boolean;
}

interface Matcher {
	/** A table or column name: split on "_", digits and camelCase; abbreviations count. */
	name(name: string): Matched;
	/** Comments, notes, definitions and database names: words only. */
	text(text: string): Matched;
	/** True when `name` is the query, plurals and separators aside. */
	isExactName(name: string): boolean;
}

// Legacy schemas repeat the same column names and comments thousands of
// times ("cod_cli", "Cliente"): each distinct text and word is matched once.
function matcher(q: Query): Matcher {
	const tokens = (abbreviations: boolean, split: (text: string) => string[]) => {
		const byWord = new Map<string, Float64Array | null>();
		const quality = (token: string): Float64Array | null => {
			let found = byWord.get(token);
			if (found !== undefined) return found;
			found = null;
			for (const [index, word] of q.words.entries()) {
				const value =
					token === word
						? MATCH.exact
						: word.length >= MIN_EXTENSION && token.startsWith(word)
							? MATCH.extension
							: abbreviations && token.length >= MIN_ABBREVIATION && word.startsWith(token)
								? MATCH.abbreviation
								: 0;
				if (value === 0) continue;
				found ??= new Float64Array(q.words.length);
				found[index] = value;
			}
			byWord.set(token, found);
			return found;
		};
		const byText = new Map<string, Matched>();
		return (text: string): Matched => {
			const cached = byText.get(text);
			if (cached !== undefined) return cached;
			const all = split(text);
			const content = q.stopwordsOnly ? all : all.filter((word) => !STOPWORDS.has(word));
			const folded = content.map(foldWord);
			let tf: number[] | null = null;
			let best = 0;
			const hits: string[] = [];
			for (const token of folded) {
				const values = quality(token);
				if (values === null) continue;
				tf ??= new Array<number>(q.words.length).fill(0);
				for (const [index, value] of values.entries()) {
					tf[index] = (tf[index] as number) + value;
					best = Math.max(best, value);
				}
				hits.push(token);
			}
			const matched: Matched = {
				length: content.length,
				tf,
				abbreviated: tf !== null && best <= MATCH.abbreviation,
				first: hits[0] ?? "",
				hits,
				phrase: tf !== null && q.words.length > 1 && containsWords(folded, q.words),
			};
			byText.set(text, matched);
			return matched;
		};
	};
	const name = tokens(true, nameWords);
	const text = tokens(false, (raw) => normalizeText(raw).split(/[^\p{L}\p{N}]+/u).filter((word) => word !== ""));
	return {
		name,
		text,
		isExactName: (raw) => {
			const words = nameWords(raw);
			return (q.stopwordsOnly ? words : words.filter((word) => !STOPWORDS.has(word))).map(foldWord).join(" ") === q.exact;
		},
	};
}

/** fac_cab2019 → fac, cab, 2019; invoiceLines → invoice, lines; normalized, not folded. */
function nameWords(name: string): string[] {
	return normalizeText(name.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2"))
		.split(/[^\p{L}\p{N}]+|(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/u)
		.filter((word) => word !== "");
}

/** Why a document matched: one line of matchedIn. */
interface Evidence {
	readonly field: Field;
	readonly label: string;
	readonly snippet: string;
	readonly tf: readonly number[];
	/** Words it adds to the length of its field. */
	readonly length: number;
}

interface ColumnDraft {
	readonly name: string;
	readonly snippet: string;
	/** True when only an abbreviation in its name matched, no comment or note. */
	readonly abbreviated: boolean;
	readonly position: number;
	readonly nameTf: readonly number[] | null;
	readonly textTf: readonly number[] | null;
}

interface Doc {
	readonly target: string;
	readonly object: SearchObject;
	/** Position in the snapshot: the first of identical copies is the one shown. */
	readonly order: number;
	readonly evidence: Evidence[];
	readonly columns: ColumnDraft[];
	/** Words per field, matched or not: BM25 compares it with the average. */
	readonly lengths: Record<Field, number>;
	/** Per field and query word, the weight of its matches. */
	readonly tf: Partial<Record<Field, number[]>>;
	/** Per query word, true when anything here matched it. */
	readonly matched: boolean[];
	exactName: boolean;
	/** The phrase bonus earned, as a share of the query's IDF. */
	phrase: number;
	inferred: boolean;
	inferredFrom?: readonly CommentCount[];
	about: string;
	relationship?: SearchResult["relationship"];
	/** Tables only: what makes copies identical, and the database to show for this one. */
	copy?: { readonly key: string; readonly shown: string };
}

interface Ranked {
	readonly score: number;
	/** The score without the exact-name bonus: what weak results are measured by. */
	readonly base: number;
	readonly exactName: boolean;
	readonly result: SearchResult;
}

type Notes = ReadonlyMap<string, readonly Annotation[]>;

function newDoc(target: string, object: SearchObject, order: number): Doc {
	const lengths = Object.fromEntries(FIELD_NAMES.map((field) => [field, 0])) as Record<Field, number>;
	return { target, object, order, evidence: [], columns: [], lengths, tf: {}, matched: [], exactName: false, phrase: 0, inferred: false, about: "" };
}

function collectTable(table: Table, tableName: string, notes: Notes, match: Matcher, order: number): Doc {
	const doc = newDoc(tableName, table.kind, order);
	const own = match.name(table.name);
	addName(doc, [own]);
	doc.exactName = match.isExactName(table.name);
	addText(doc, "stated", "table comment", table.comment, match.text(table.comment), SNIPPET_LENGTH);
	const tableNotes = notes.get(tableName) ?? [];
	for (const note of tableNotes) addText(doc, "stated", "note", note.text, match.text(note.text), SNIPPET_LENGTH);
	doc.about = collapse(table.comment) || bestNote(tableNotes, match);
	const definition = table.viewDefinition ?? "";
	addText(doc, "definition", "definition", definition, match.text(definition), SNIPPET_LENGTH);

	for (const column of table.columns) {
		const matchedName = match.name(column.name);
		doc.lengths.columnName += matchedName.length;
		// num_fac in fac_cab: an abbreviation the table's own name already gave says nothing new.
		const name = matchedName.abbreviated && matchedName.hits.every((hit) => own.hits.includes(hit)) ? { tf: null } : matchedName;
		let text: { tf: readonly number[]; raw: string; first: string; weight: number } | null = null;
		const columnNotes = (notes.get(columnKey(tableName, column.name)) ?? []).map((note) => note.text);
		for (const raw of [column.comment, ...columnNotes]) {
			if (raw === "") continue;
			const matched = match.text(raw);
			doc.lengths.columnText += matched.length;
			if (matched.tf === null) continue;
			if (matched.phrase) doc.phrase = Math.max(doc.phrase, PHRASE_BONUS.column);
			accumulate(doc, "columnText", matched.tf);
			const weight = matched.tf.reduce((sum, value) => sum + value, 0);
			// The comment or note that matched most is the one shown.
			if (text === null || weight > text.weight) text = { tf: matched.tf, raw, first: matched.first, weight };
		}
		if (name.tf !== null) accumulate(doc, "columnName", name.tf);
		if (name.tf === null && text === null) continue;
		doc.columns.push({
			name: column.name,
			snippet: text === null ? "" : snippetAround(collapse(text.raw), text.first, COLUMN_SNIPPET_LENGTH),
			abbreviated: text === null && matchedName.abbreviated,
			position: column.position,
			nameTf: name.tf,
			textTf: text?.tf ?? null,
		});
	}
	return doc;
}

/** The first note that matched, else the first one, on one line; "" without notes. */
function bestNote(notes: readonly Annotation[], match: Matcher): string {
	const note = notes.find((item) => match.text(item.text).tf !== null) ?? notes[0];
	return note === undefined ? "" : collapse(note.text);
}

function addName(doc: Doc, matched: readonly Matched[]): void {
	const tf = new Array<number>(matched[0]?.tf?.length ?? 0).fill(0);
	let length = 0;
	let any = false;
	let abbreviated = true;
	for (const item of matched) {
		length = Math.max(length, item.length);
		if (item.tf === null) continue;
		any = true;
		abbreviated &&= item.abbreviated;
		// A database named like its schema matches once: the best of the two.
		item.tf.forEach((value, index) => {
			tf[index] = Math.max(tf[index] ?? 0, value);
		});
	}
	doc.lengths.name += length;
	if (any) addEvidence(doc, { field: "name", label: abbreviated ? "name (abbreviation)" : "name", snippet: "", tf, length: 0 });
}

function addText(doc: Doc, field: Field, label: string, raw: string, matched: Matched, length: number): void {
	if (raw === "") return;
	doc.lengths[field] += matched.length;
	if (matched.tf === null) return;
	if (matched.phrase) doc.phrase = Math.max(doc.phrase, PHRASE_BONUS.stated);
	const snippet = snippetAround(collapse(raw), matched.first, length);
	addEvidence(doc, { field, label: `${label}: ${snippet}`, snippet, tf: matched.tf, length: 0 });
}

function addEvidence(doc: Doc, evidence: Evidence): void {
	doc.evidence.push(evidence);
	doc.lengths[evidence.field] += evidence.length;
	accumulate(doc, evidence.field, evidence.tf);
}

function accumulate(doc: Doc, field: Field, tf: readonly number[]): void {
	const sums = (doc.tf[field] ??= new Array<number>(tf.length).fill(0));
	tf.forEach((value, index) => {
		if (value === 0) return;
		sums[index] = (sums[index] as number) + value;
		doc.matched[index] = true;
	});
}

function covered(tf: readonly number[] | null): number {
	return tf === null ? 0 : tf.filter((value) => value > 0).length;
}

/** Scores every document that matched, groups identical copies and sorts them. */
function rank(docs: readonly Doc[], q: Query): Ranked[] {
	const count = q.words.length;
	const idf = q.words.map((_, index) => {
		const df = docs.filter((doc) => doc.matched[index]).length;
		return Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
	});
	const average = Object.fromEntries(
		FIELD_NAMES.map((field) => {
			const lengths = docs.map((doc) => doc.lengths[field]).filter((length) => length > 0);
			return [field, lengths.length === 0 ? 0 : lengths.reduce((sum, length) => sum + length, 0) / lengths.length];
		}),
	) as Record<Field, number>;
	const norm = (doc: Doc, field: Field) => {
		const { weight, b } = FIELDS[field];
		const avg = average[field];
		return weight / (avg === 0 ? 1 : 1 - b + (b * doc.lengths[field]) / avg);
	};

	const idfSum = idf.reduce((total, value) => total + value, 0);
	const scored: { doc: Doc; score: number; base: number; exactName: boolean; result: SearchResult }[] = [];
	for (const doc of docs) {
		if (!doc.matched.some(Boolean)) continue;
		let sum = 0;
		let matched = 0;
		for (let index = 0; index < count; index++) {
			let tf = 0;
			for (const field of FIELD_NAMES) tf += (doc.tf[field]?.[index] ?? 0) * norm(doc, field);
			if (tf === 0) continue;
			matched += 1;
			sum += ((idf[index] as number) * tf * (K1 + 1)) / (tf + K1);
		}
		const base = sum * (matched / count) ** 2 + doc.phrase * idfSum;
		const score = base + (doc.exactName ? EXACT_NAME_BONUS : 0);
		scored.push({ doc, score, base, exactName: doc.exactName, result: finish(doc, idf, (field) => norm(doc, field)) });
	}

	// Identical copies: the first in snapshot order is shown, ranked by the best of them.
	const groups = new Map<string, { doc: Doc; score: number; base: number; exactName: boolean; result: SearchResult; others: Doc[] }>();
	const ranked: Ranked[] = [];
	const single: Ranked[] = [];
	for (const item of scored) {
		if (item.doc.copy === undefined) {
			single.push(item);
			continue;
		}
		const group = groups.get(item.doc.copy.key);
		if (group === undefined) {
			groups.set(item.doc.copy.key, { ...item, others: [] });
		} else {
			group.others.push(item.doc);
			group.score = Math.max(group.score, item.score);
			group.base = Math.max(group.base, item.base);
		}
	}
	for (const group of groups.values()) {
		const alsoIn = group.others.sort((a, b) => a.order - b.order).map((doc) => doc.copy?.shown as string);
		const { score, base, exactName } = group;
		ranked.push({ score, base, exactName, result: alsoIn.length === 0 ? group.result : { ...group.result, alsoIn } });
	}
	ranked.push(...single);
	return ranked.sort(compareRanked);
}

function finish(doc: Doc, idf: readonly number[], norm: (field: Field) => number): SearchResult {
	const weigh = (tf: readonly number[] | null, field: Field) =>
		tf === null ? 0 : tf.reduce((sum, value, index) => sum + value * (idf[index] as number), 0) * norm(field);
	const lines = doc.evidence.map((evidence) => ({ label: evidence.label, snippet: evidence.snippet, weight: weigh(evidence.tf, evidence.field) }));

	// Columns matching more query words first, then the stronger match, then table order.
	const columns = doc.columns
		.map((column) => ({
			column,
			words: covered(column.nameTf === null ? column.textTf : column.textTf === null ? column.nameTf : column.nameTf.map((value, index) => value + (column.textTf?.[index] ?? 0))),
			weight: weigh(column.nameTf, "columnName") + weigh(column.textTf, "columnText"),
		}))
		.sort((a, b) => b.words - a.words || b.weight - a.weight || a.column.position - b.column.position);
	if (columns.length > 0) {
		const shown = columns.slice(0, MAX_COLUMNS);
		const more = columns.length - shown.length;
		const list = shown.map(({ column }) => (column.snippet === "" ? column.name : `${column.name} ("${column.snippet}")`)).join(", ");
		lines.push({
			label: `columns: ${list}${more > 0 ? ` (+${more} more)` : ""}`,
			snippet: "",
			weight: weigh(doc.tf.columnName ?? null, "columnName") + weigh(doc.tf.columnText ?? null, "columnText"),
		});
	}
	// Stable sort: equal weights keep the order they were found in (name before comment).
	lines.sort((a, b) => b.weight - a.weight);
	const abbreviated =
		doc.evidence.length > 0 &&
		doc.evidence.every((evidence) => evidence.label === "name (abbreviation)") &&
		doc.columns.every((column) => column.abbreviated);
	return {
		target: doc.target,
		object: doc.object,
		matchedIn: lines.map((line) => line.label),
		snippet: lines.find((line) => line.snippet !== "")?.snippet ?? "",
		about: doc.about,
		inferred: doc.inferred,
		...(doc.inferredFrom !== undefined && { inferredFrom: doc.inferredFrom }),
		abbreviated,
		columns: columns.slice(0, MAX_COLUMNS).map(({ column }) => ({ name: column.name, snippet: column.snippet })),
		moreColumns: Math.max(0, columns.length - MAX_COLUMNS),
		...(doc.relationship !== undefined && { relationship: doc.relationship }),
	};
}

/**
 * Copies of a table in one database per company: same name and same
 * columns. In PostgreSQL the schema is part of it, so app.public.orders and
 * app.sales.orders stay apart while app1.public.orders and app2.public.orders
 * are copies.
 */
function copyKey(table: Table, database: string, schema: string): string {
	const columns = table.columns.map((column) => `${column.name}\u0001${column.type}`).join("\u0002");
	return [table.kind, table.name, schema === database ? "" : schema, columns].join("\u0000");
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
