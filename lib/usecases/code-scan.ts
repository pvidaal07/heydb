import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Knowledge } from "../knowledge/types.ts";
import { incomingCounts } from "../model/references.ts";
import { displayName, formatName } from "../model/names.ts";
import type { Snapshot } from "../model/snapshot.ts";
import { HEYDB_DIR } from "../store/project.ts";

// Whether the project next to .heydb/ has code that uses this database, and
// where. After a sync heydb offers to let the agent read that code and note
// what it makes explicit (enum values, units, joins without a foreign key).
// Many projects have none (a heydb project made only to explore a database),
// and then the notes come from conversations instead.
//
// This only finds candidates: a table name in database context, that is SQL
// (`SELECT … FROM art`) or an ORM declaration (`protected $table = 'art'`).
// A name that is only mentioned (a comment, help text, a variable) does not
// count: tables called "config" or "para" are ordinary words. It never
// interprets the code; the agent does that, if the person agrees. The scan runs right after a sync, so it is bounded in files,
// bytes and time: a huge repository gives a partial answer, never a stuck Pi.
//
// Documentation (markdown, text) counts too, but only where it defines a
// table: "`cst` = maestro de clientes", "| tda | Almacenes |". A passing
// mention in prose does not. It is read before the code, with at most a
// quarter of each limit while code waits, so code early in the walk cannot
// use up the limits before the docs are reached, and huge docs cannot either.
//
// The agent writes at most one note per listed table, so the tables come in
// the order a note helps most: first those with no comment and no note, then
// those with a comment, then those that already have a note; within each group
// cryptic names (cst, fac_cab), many references and much code first. The work
// comes in rounds: the tables noted in one run go last in the next, so running
// it again lists the next tables, and `remaining` says how many still wait.
// A table the agent could not explain is left as a question: a note that
// starts with QUESTION_PREFIX. It goes after the commented tables, so the next
// round does not spend its top spot on what the code already failed to say,
// and it never counts as waiting.
//
// Within a table, files come in the order the agent should follow them: the
// file that maps the table (an ORM declaration such as pgTable("orders"),
// @Entity("orders"), Prisma @@map, __tablename__) is the anchor and comes
// first, even when it names the table once; then the application code that
// uses it most. Migrations, schema dumps, tests, seeds and fixtures, copies
// set aside (old, bak, copy, "no se compila") and customer variants of a
// program (invoice_00123.prg or invoice-acme.prg next to invoice.prg) come
// last: they repeat a table's name without explaining it.
//
// `estimate` says how much the agent would be pointed to read, so a caller can
// show the cost before anything starts.

export interface ScanLimits {
	/** Source files read at most. */
	readonly maxFiles: number;
	/** Bytes read at most, all files together. */
	readonly maxBytes: number;
	/** Bigger files are skipped (generated code, dumps, minified bundles). */
	readonly maxFileBytes: number;
	/** Wall time budget, measured with the `now` clock. */
	readonly maxMillis: number;
	/** In a huge schema only the most referenced tables are looked for. */
	readonly maxTables: number;
}

export const DEFAULT_SCAN_LIMITS: ScanLimits = {
	maxFiles: 5000,
	maxBytes: 50 * 1024 * 1024,
	maxFileBytes: 512 * 1024,
	// A large legacy codebase (about 900 source files) needs about 9 s; progress is shown meanwhile.
	maxMillis: 10_000,
	maxTables: 300,
};

/** Tables kept in the result, the ones that most need a note first, and files kept per table. */
const MAX_MATCHES = 30;
const MAX_FILES_PER_TABLE = 5;
const MAX_DOCS_PER_TABLE = 3;
/** Documentation is read first, with at most this share of each limit while code waits to be read. */
const DOCS_SHARE = 0.25;
/** Two-letter names ("id", "ab") are everywhere in code: they would only add noise. */
const MIN_NAME_LENGTH = 3;

/** Folders that hold someone else's code, build output, CI configuration or heydb's own files. */
const SKIPPED_FOLDERS = new Set([
	"node_modules",
	"vendor",
	".git",
	HEYDB_DIR,
	"dist",
	"build",
	"coverage",
	".github",
	".gitlab",
	".circleci",
]);
/** Files that are never database code: lockfiles and CI configuration. Minified bundles (*.min.js) too. */
const SKIPPED_FILES = new Set([
	"pnpm-lock.yaml",
	"package-lock.json",
	"yarn.lock",
	"composer.lock",
	"Gemfile.lock",
	"poetry.lock",
	"Cargo.lock",
	"go.sum",
	".gitlab-ci.yml",
]);
const SOURCE_EXTENSIONS = new Set([
	"php",
	"ts",
	"tsx",
	"js",
	"jsx",
	"py",
	"java",
	"cs",
	"go",
	"rb",
	"sql",
	"kt",
	"scala",
	"xml",
	"yml",
	"yaml",
	// Legacy business code, where ERP databases are usually queried: xBase
	// (Harbour, Clipper, FoxPro), Delphi, Visual Basic, COBOL, ABL and RPG.
	"prg",
	"ch",
	"pas",
	"dfm",
	"vb",
	"bas",
	"frm",
	"cls",
	"cbl",
	"cob",
	"p",
	"w",
	"rpgle",
	// Prisma schema: `model Order { … @@map("orders") }`.
	"prisma",
]);

/** Documentation: read only for definitions of a table, never as code. */
const DOC_EXTENSIONS = new Set(["md", "markdown", "txt", "rst", "adoc"]);

/** The project's files, with paths relative to its root and "/" separators. */
export interface CodeFiles {
	/** Entries of a folder ("" is the root). Symbolic links are "other": never followed. */
	list(dir: string): Promise<readonly { name: string; kind: "file" | "dir" | "other" }[]>;
	/** Size in bytes of a regular file; null for anything else or a missing file. */
	size(path: string): Promise<number | null>;
	read(path: string): Promise<string>;
}

export interface ScanOptions {
	/** Replaced in tests; the default reads the real folder. */
	readonly files?: CodeFiles;
	/** Milliseconds; replaced in tests. */
	readonly now?: () => number;
	readonly limits?: Partial<ScanLimits>;
	/** The connection's notes: a table that has one needs another less. */
	readonly knowledge?: Knowledge;
}

/**
 * What already says what a table is: nothing, its comment, a question a
 * previous round left (a note starting with QUESTION_PREFIX), or a team note.
 */
export type Described = "nothing" | "comment" | "question" | "note";

/**
 * How a note marks a table as a question for the user rather than knowledge:
 * the agent could not explain the table from the code. The learn message asks
 * the agent to save such notes with this prefix; the next scan lists those
 * tables after the commented ones instead of first again.
 */
export const QUESTION_PREFIX = "[?] ";

/** Whether a note is a question left by learn-code (starts with QUESTION_PREFIX, leading spaces ignored). */
export function isQuestionNote(text: string): boolean {
	return text.trimStart().startsWith(QUESTION_PREFIX.trim());
}

export interface TableUsage {
	/** Display name, e.g. "erp.art"; tables with the same name in several databases are joined with " / ". */
	readonly table: string;
	/** The table name as the schema writes it, e.g. "art". */
	readonly name: string;
	/**
	 * Code files in the order to follow them, at most 5: the mapping file
	 * first, then the code that uses it most; migrations, tests, seeds and
	 * variants last.
	 */
	readonly files: readonly string[];
	/** The file that maps the table (an ORM declaration), when one does; it is files[0]. Absent otherwise. */
	readonly anchor?: string;
	/** Occurrences in every scanned code file. */
	readonly hits: number;
	/** Documentation files that define it, at most 3. */
	readonly docs: readonly string[];
	/** The best description any of its copies has. */
	readonly described: Described;
	/** Whether the name is abbreviation-like (isCrypticName). */
	readonly cryptic: boolean;
	/** References from other tables (foreign keys, noted joins, name patterns), the most of any copy. */
	readonly referenced: number;
}

export interface SchemaUsage {
	/** Whether any source file was found at all. */
	readonly hasCode: boolean;
	readonly filesScanned: number;
	/** Documentation files read for definitions. */
	readonly docsScanned: number;
	/** Files that use or define at least one table. */
	readonly filesMatched: number;
	/** Tables used or defined by at least one file; `matches` keeps the 30 that most need a note. */
	readonly tablesMatched: number;
	readonly matches: readonly TableUsage[];
	/** Matched tables with no description (no useful comment, no note) left out of `matches`: the next rounds. */
	readonly remaining: number;
	/** A limit stopped the scan: more code may use these tables. */
	readonly truncated: boolean;
	/** How much the agent would be pointed to read. Always set by findSchemaUsage. */
	readonly estimate?: ScanEstimate;
}

/** What the listed tables point the agent to, for a cost estimate before it starts. */
export interface ScanEstimate {
	/** Tables listed (`matches`). */
	readonly tables: number;
	/** Distinct code and documentation files named by the listed tables. */
	readonly files: number;
	/** Their size in bytes, all together. */
	readonly bytes: number;
	/** The biggest of them, in bytes: huge files mean a legacy project, costly to read. */
	readonly largestFile: number;
	/** Listed tables whose first file maps them (an ORM declaration): few means little to anchor on. */
	readonly anchored: number;
}

export async function findSchemaUsage(projectRoot: string, snapshot: Snapshot, options: ScanOptions = {}): Promise<SchemaUsage> {
	const limits = { ...DEFAULT_SCAN_LIMITS, ...options.limits };
	const files = options.files ?? realFiles(projectRoot);
	const now = options.now ?? (() => performance.now());
	const deadline = now() + limits.maxMillis;

	const names = tableNames(snapshot, options.knowledge ?? EMPTY_KNOWLEDGE, limits.maxTables);
	const listed = await listSources(files, limits.maxFiles, () => now() > deadline);

	// lowercased table name → file → hits (and whether it maps the table), in code and in documentation
	const found = new Map<string, Map<string, FileHits>>();
	const defined = new Map<string, Map<string, FileHits>>();
	const sizes = new Map<string, number>();
	// Possible customer variants and their base files: their lines are compared once read.
	const candidates = variantCandidates(listed.code);
	const compared = new Set([...candidates.keys(), ...[...candidates.values()].map((candidate) => candidate.base)]);
	const prints = new Map<string, Set<number>>();
	let filesScanned = 0;
	let docsScanned = 0;
	let filesMatched = 0;

	/** Reads `paths` in order until one of the budgets runs out; `stopped` when files remained unread. */
	async function readPass(paths: readonly string[], budget: { files: number; bytes: number; deadline: number }, doc: boolean) {
		let considered = 0;
		let bytes = 0;
		for (const path of paths) {
			if (considered >= budget.files || now() > budget.deadline) return { considered, bytes, stopped: true };
			considered += 1;
			const size = await files.size(path);
			if (size === null || size > limits.maxFileBytes) continue;
			if (bytes + size > budget.bytes) return { considered, bytes, stopped: true };
			bytes += size;
			let text: string;
			try {
				text = await files.read(path);
			} catch {
				continue; // deleted or unreadable since it was listed: not this scan's business
			}
			if (doc) docsScanned += 1;
			else filesScanned += 1;
			sizes.set(path, size);
			if (compared.has(path)) prints.set(path, fingerprint(text));
			let matched = false;
			const references = doc ? tableDefinitions(text).map((name) => ({ name, mapping: false })) : tableReferences(text, path);
			for (const reference of references) {
				const key = reference.name.toLowerCase();
				if (!names.has(key)) continue;
				const into = doc ? defined : found;
				const perFile = into.get(key) ?? new Map<string, FileHits>();
				into.set(key, perFile);
				const previous = perFile.get(path);
				perFile.set(path, { hits: (previous?.hits ?? 0) + 1, mapping: (previous?.mapping ?? false) || reference.mapping });
				matched = true;
			}
			if (matched) filesMatched += 1;
		}
		return { considered, bytes, stopped: false };
	}

	// Documentation first: it is small, and the best evidence of what a table is.
	// While code waits it gets at most a share of each limit; code gets the rest.
	const share = listed.code.length > 0 ? DOCS_SHARE : 1;
	const listedAt = now();
	const docs = await readPass(
		listed.docs,
		{
			files: Math.ceil(limits.maxFiles * share),
			bytes: Math.floor(limits.maxBytes * share),
			deadline: Math.min(deadline, listedAt + (deadline - listedAt) * share),
		},
		true,
	);
	const code = await readPass(listed.code, { files: limits.maxFiles - docs.considered, bytes: limits.maxBytes - docs.bytes, deadline }, false);
	const truncated = listed.truncated || docs.stopped || code.stopped;

	const variants = new Set(
		[...candidates]
			.filter(([path, { base, digits }]) => digits || similar(prints.get(path), prints.get(base)))
			.map(([path]) => path),
	);
	const last = (path: string) => goesLast(path) || variants.has(path);
	const mostFirst = (perFile: Map<string, FileHits> | undefined) =>
		[...(perFile ?? [])].sort((a, b) => b[1].hits - a[1].hits || compareText(a[0], b[0]));
	/** Application code before what goes last; within each, the mapping file first, then the most uses. */
	const followOrder = (perFile: Map<string, FileHits> | undefined) =>
		mostFirst(perFile).sort((a, b) => Number(last(a[0])) - Number(last(b[0])) || Number(b[1].mapping) - Number(a[1].mapping));
	const matches = [...new Set([...found.keys(), ...defined.keys()])].map((key): TableUsage => {
		const ranked = followOrder(found.get(key));
		const table = names.get(key) as TableName;
		const [first] = ranked;
		const anchor = first !== undefined && first[1].mapping && !last(first[0]) ? first[0] : undefined;
		return {
			table: table.display,
			name: table.name,
			files: ranked.slice(0, MAX_FILES_PER_TABLE).map(([path]) => path),
			...(anchor === undefined ? {} : { anchor }),
			hits: ranked.reduce((sum, [, file]) => sum + file.hits, 0),
			docs: mostFirst(defined.get(key))
				.slice(0, MAX_DOCS_PER_TABLE)
				.map(([path]) => path),
			described: table.described,
			cryptic: table.cryptic,
			referenced: table.referenced,
		};
	});
	matches.sort(
		(a, b) =>
			DESCRIBED_ORDER[a.described] - DESCRIBED_ORDER[b.described] ||
			noteValue(b) - noteValue(a) ||
			b.hits - a.hits ||
			compareText(a.table, b.table),
	);
	const listedMatches = matches.slice(0, MAX_MATCHES);
	const pointed = [...new Set(listedMatches.flatMap((match) => [...match.files, ...match.docs]))].map((path) => sizes.get(path) ?? 0);
	return {
		hasCode: filesScanned > 0,
		filesScanned,
		docsScanned,
		filesMatched,
		tablesMatched: matches.length,
		matches: listedMatches,
		remaining: matches.slice(MAX_MATCHES).filter((match) => match.described === "nothing").length,
		truncated,
		estimate: {
			tables: listedMatches.length,
			files: pointed.length,
			bytes: pointed.reduce((sum, size) => sum + size, 0),
			largestFile: pointed.reduce((max, size) => Math.max(max, size), 0),
			anchored: listedMatches.filter((match) => match.anchor !== undefined).length,
		},
	};
}

/** Uses of a table in one file, and whether the file maps it. */
interface FileHits {
	readonly hits: number;
	readonly mapping: boolean;
}

const EMPTY_KNOWLEDGE: Knowledge = { formatVersion: 1, annotations: [], relationships: [] };

/** Tables nothing describes first, then commented ones, then those left as questions, then those with a note. */
const DESCRIBED_ORDER: Readonly<Record<Described, number>> = { nothing: 0, comment: 1, question: 2, note: 3 };

/**
 * How much a note on this table is worth, among tables described alike: a
 * cryptic name counts double, since search cannot match it to any word, and
 * every doubling of references or of uses in code adds one.
 */
function noteValue(table: Pick<TableUsage, "cryptic" | "referenced" | "hits">): number {
	return (table.cryptic ? 2 : 1) * (1 + Math.log2(1 + table.referenced) + Math.log2(1 + table.hits));
}

/**
 * Whether a table name looks like an abbreviation that no search word will
 * match: 4 letters or fewer in all, a part with no vowel (stk, cst), or most
 * of its parts 3 letters or fewer (fac_cab). Parts are split at anything that
 * is not a letter and at camelCase humps. Only Latin letters are checked for
 * vowels; other scripts are never called cryptic for lacking them.
 */
export function isCrypticName(name: string): boolean {
	const parts = name
		.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
		.split(/[^\p{L}]+/u)
		.filter((part) => part !== "");
	const letters = parts.reduce((sum, part) => sum + part.length, 0);
	if (letters <= 4) return true;
	const latin = (part: string) => part.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
	if (parts.some((part) => /^[a-z]+$/.test(latin(part)) && !/[aeiouy]/.test(latin(part)))) return true;
	return parts.filter((part) => part.length <= 3).length * 2 > parts.length;
}

// The patterns of database context. Each captures the table name as `name`:
// a whole identifier (letters, digits, "_"), so "art" never matches in
// ref_art or article. Keywords are case-insensitive.

const ID = "[\\p{L}\\p{N}_]+";
/** A name as SQL writes it: optionally quoted (` " ' [ ]) and qualified (db.table, db.schema.table). */
const SQL_NAME = `(?:[\`"'\\[]?${ID}[\`"'\\]]?\\.){0,2}[\`"'\\[]?(?<name>${ID})(?![\\p{L}\\p{N}_])`;
/**
 * A database prefix built by code in front of the table, as legacy and web
 * code often write it: "FROM "+cDb+".art" (Harbour, JS), "FROM " . $db . ".art"
 * (PHP), `FROM ${db}.art` (template strings). Bounded, so it stays cheap.
 */
const BUILT_PREFIX = `(?:["'\`]\\s*(?:\\+|\\.|&|\\|\\|)\\s*[^"'\`\\n]{1,60}?\\s*(?:\\+|\\.|&|\\|\\|)\\s*["'\`]\\.|\\$\\{[^}\\n]{1,60}\\}\\.)`;
/** A table name after a SQL keyword: plain, quoted or qualified, or behind a built prefix. */
const SQL_TARGET = `(?:${BUILT_PREFIX})?${SQL_NAME}`;
/** A quoted string that holds only the name: 'art', "art", `art`. */
const QUOTED_NAME = `["'\`](?<name>${ID})["'\`]`;
/** How far back, within one statement (no ";"), the verb that opens it may be. */
const STATEMENT_CHARS = 2000;

/**
 * SQL, anywhere in a file (strings included). Each keyword needs the verb of
 * its statement, so prose like "read it from config" or "update project"
 * does not count:
 * - FROM after SELECT or DELETE (DELETE FROM too)
 * - JOIN after FROM, or after UPDATE when a SET follows
 * - INTO after INSERT, REPLACE or MERGE
 * - UPDATE followed by SET
 * - TABLE after CREATE, ALTER, DROP, TRUNCATE, RENAME or LOCK
 *
 * ORM and mapping declarations (these map the table: the file is its anchor):
 * - `self.table = 'x'`, `protected $table = "x"`, `__tablename__ = "x"`
 *   (SQLAlchemy), `db_table = "x"` (Django), `self.table_name = "x"` (Rails),
 *   `tableName: "x"` / `tableName = "x"`, Doctrine XML `<entity … table="x">`
 * - `@Table(name = "x")`, `@Entity(name = "x")` (JPA), `[Table("x")]` (C#)
 * - `pgTable("x"`, `mysqlTable("x"`, `sqliteTable("x"` (Drizzle)
 * - `@Entity("x")`, `@Entity({ name: "x" })` (TypeORM)
 * - `@@map("x")`, and in a .prisma file a `model x {` without @@map (Prisma)
 * - `table: x` on its own line (YAML mappings)
 *
 * Uses, not mappings: `->table('x')`, `DB::table('x')`, `.table("x")`,
 * `->from('x')`, `.from("x")`, `knex("x")`, and any other variable named after
 * a table (`$tableName = 'x'`, `cTabla := "x"`).
 */
/**
 * A keyword match plus the context it needs. The keyword is searched first and
 * the context is checked only around each match, in a bounded window cut at
 * the statement end (";"). A lookbehind such as (?<=SELECT[^;]{0,2000}?) would
 * be tried at every position of the file: on a 500 KB legacy source file that
 * meant minutes per file.
 */
interface ReferenceRule {
	readonly pattern: RegExp;
	/** Must appear in the statement before the match, at most `before.chars` back. */
	readonly before?: { readonly verb: RegExp; readonly chars: number };
	/** Must appear in the statement after the match, at most `after.chars` ahead. */
	readonly after?: { readonly verb: RegExp; readonly chars: number };
	/** Whether the match maps the table (an ORM declaration), not just uses it. */
	readonly mapping?: boolean | ((match: RegExpExecArray, text: string) => boolean);
}

/** Variables and properties that map a table when assigned: Eloquent, Rails, SQLAlchemy, Django, Sequelize, Doctrine. */
const MAPPING_VARIABLES = new Set(["table", "table_name", "tablename", "__tablename__", "db_table"]);

/**
 * Whether an assignment to a variable named after a table maps it. A PHP
 * variable maps it only as a class property (`protected $table`); a bare
 * `table` only as a property (`self.table`) or an XML attribute (`<entity table="x">`).
 */
function mapsTable(match: RegExpExecArray, text: string): boolean {
	const variable = match.groups?.variable?.toLowerCase() ?? "";
	if (!MAPPING_VARIABLES.has(variable)) return false;
	const line = text.slice(Math.max(0, match.index - 200), match.index).split("\n").at(-1) ?? "";
	if (match.groups?.dollar !== undefined) return /\b(?:protected|public|private|var)\s+(?:static\s+)?$/u.test(line);
	if (variable !== "table") return true;
	return /\.\s*$/u.test(line) || /<[\p{L}\p{N}_:.-]+\s[^<>]*$/u.test(line);
}

const REFERENCES: readonly ReferenceRule[] = [
	{ pattern: new RegExp(`\\bFROM\\s+${SQL_TARGET}`, "dgiu"), before: { verb: /\b(?:SELECT|DELETE)\b/iu, chars: STATEMENT_CHARS } },
	{ pattern: new RegExp(`\\bJOIN\\s+${SQL_TARGET}`, "dgiu"), before: { verb: /\bFROM\b/iu, chars: STATEMENT_CHARS } },
	{
		pattern: new RegExp(`\\bJOIN\\s+${SQL_TARGET}`, "dgiu"),
		before: { verb: /\bUPDATE\b/iu, chars: STATEMENT_CHARS },
		after: { verb: /\bSET\b/iu, chars: 500 },
	},
	{ pattern: new RegExp(`\\bINTO\\s+${SQL_TARGET}`, "dgiu"), before: { verb: /\b(?:INSERT|REPLACE|MERGE)\b/iu, chars: 100 } },
	{ pattern: new RegExp(`\\bUPDATE\\s+${SQL_TARGET}`, "dgiu"), after: { verb: /\bSET\b/iu, chars: 500 } },
	{
		pattern: new RegExp(`\\bTABLES?\\s+(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?${SQL_TARGET}`, "dgiu"),
		before: { verb: /\b(?:CREATE|ALTER|DROP|TRUNCATE|RENAME|LOCK)\b/iu, chars: 40 },
	},
	// Any variable or property whose name says "table" or "tabla": $table, db_table,
	// __tablename__, tableName, cTabla, oQuery:cTabla. `==` comparisons do not count.
	{
		pattern: new RegExp(
			`(?<![\\p{L}\\p{N}_])(?<dollar>\\$)?(?<variable>[\\p{L}\\p{N}_]*(?:tabla|table)[\\p{L}\\p{N}_]*)\\s*(?::=|=(?!=)|:)\\s*${QUOTED_NAME}`,
			"dgiu",
		),
		mapping: mapsTable,
	},
	{ pattern: new RegExp(`(?:->|::|\\.)\\s*(?:table|from)\\s*\\(\\s*${QUOTED_NAME}`, "dgu") },
	{ pattern: new RegExp(`\\bknex\\s*\\(\\s*${QUOTED_NAME}`, "dgu") },
	{ pattern: new RegExp(`(?:@(?:Table|Entity)\\s*\\([^)]*?\\bname\\s*=\\s*|\\[Table\\s*\\(\\s*)${QUOTED_NAME}`, "dgu"), mapping: true },
	{ pattern: new RegExp(`\\b(?:pg|mysql|sqlite|singlestore)Table\\s*\\(\\s*${QUOTED_NAME}`, "dgu"), mapping: true },
	{ pattern: new RegExp(`@Entity\\s*\\(\\s*(?:\\{[^)]*?\\bname\\s*:\\s*)?${QUOTED_NAME}`, "dgu"), mapping: true },
	{ pattern: new RegExp(`@@map\\s*\\(\\s*(?:name\\s*:\\s*)?${QUOTED_NAME}`, "dgu"), mapping: true },
	{ pattern: new RegExp(`^[ \\t]*table:[ \\t]*(?<name>${ID})[ \\t]*\\r?$`, "dgmu"), mapping: true },
];

/** A Prisma model; without @@map in its body, its name is the table's. */
const PRISMA_MODEL = new RegExp(`^[ \\t]*model[ \\t]+(?<name>${ID})[ \\t]*\\{`, "dgmu");

/** The part of the statement before `index`: at most `chars` back, cut after the last ";". */
function statementBefore(text: string, index: number, chars: number): string {
	const window = text.slice(Math.max(0, index - chars), index);
	return window.slice(window.lastIndexOf(";") + 1);
}

/** The part of the statement after `index`: at most `chars` ahead, cut at the first ";". */
function statementAfter(text: string, index: number, chars: number): string {
	const window = text.slice(index, index + chars);
	const end = window.indexOf(";");
	return end === -1 ? window : window.slice(0, end);
}

interface Reference {
	readonly name: string;
	/** The file maps the table here (an ORM declaration). */
	readonly mapping: boolean;
}

/** Every table name the file uses or maps in database context; one per place, even when two patterns see it. */
function tableReferences(text: string, path: string): Reference[] {
	const found = new Map<number, Reference>();
	const add = (start: number, name: string, mapping: boolean) =>
		found.set(start, { name, mapping: mapping || (found.get(start)?.mapping ?? false) });
	for (const rule of REFERENCES) {
		for (const match of text.matchAll(rule.pattern)) {
			const start = match.indices?.groups?.name?.[0];
			const name = match.groups?.name;
			if (start === undefined || name === undefined) continue;
			const { before, after, mapping = false } = rule;
			if (before !== undefined && !before.verb.test(statementBefore(text, match.index, before.chars))) continue;
			if (after !== undefined && !after.verb.test(statementAfter(text, match.index + match[0].length, after.chars))) continue;
			add(start, name, typeof mapping === "boolean" ? mapping : mapping(match as RegExpExecArray, text));
		}
	}
	if (path.toLowerCase().endsWith(".prisma")) {
		for (const match of text.matchAll(PRISMA_MODEL)) {
			const start = match.indices?.groups?.name?.[0];
			const name = match.groups?.name;
			if (start === undefined || name === undefined) continue;
			const rest = text.slice(match.index + match[0].length);
			const end = rest.search(/^[ \t]*\}/mu);
			if (!/@@map\s*\(/u.test(end === -1 ? rest : rest.slice(0, end))) add(start, name, true);
		}
	}
	return [...found.values()];
}

interface TableName {
	readonly canonical: string;
	readonly name: string;
	readonly display: string;
	readonly described: Described;
	readonly cryptic: boolean;
	readonly referenced: number;
}

/**
 * Lowercased table name → how to show it and what it needs, for the tables
 * worth looking for. In a huge schema those are the ones a note helps most
 * before any code is read: described alike, the cryptic and referenced first.
 */
function tableNames(snapshot: Snapshot, knowledge: Knowledge, maxTables: number): Map<string, TableName> {
	const counts = incomingCounts(snapshot, knowledge);
	const noted = new Set(knowledge.annotations.filter((annotation) => !isQuestionNote(annotation.text)).map((annotation) => annotation.target));
	const questioned = new Set(knowledge.annotations.filter((annotation) => isQuestionNote(annotation.text)).map((annotation) => annotation.target));
	const all: TableName[] = [];
	for (const database of snapshot.databases) {
		for (const schema of database.schemas) {
			for (const table of schema.tables) {
				if (table.name.length < MIN_NAME_LENGTH) continue;
				const ref = { database: database.name, schema: schema.name, table: table.name };
				const canonical = formatName(ref);
				all.push({
					canonical,
					name: table.name,
					display: displayName(ref),
					described: noted.has(canonical)
						? "note"
						: questioned.has(canonical)
							? "question"
							: describes(table.comment, table.name)
								? "comment"
								: "nothing",
					cryptic: isCrypticName(table.name),
					referenced: counts.get(canonical) ?? 0,
				});
			}
		}
	}
	let kept = all;
	if (all.length > maxTables) {
		const value = (item: TableName) => noteValue({ ...item, hits: 0 });
		kept = [...all]
			.sort(
				(a, b) =>
					DESCRIBED_ORDER[a.described] - DESCRIBED_ORDER[b.described] ||
					value(b) - value(a) ||
					compareText(a.canonical, b.canonical),
			)
			.slice(0, maxTables);
	}
	const names = new Map<string, TableName>();
	for (const item of kept) {
		const key = item.name.toLowerCase();
		const previous = names.get(key);
		names.set(
			key,
			previous === undefined
				? item
				: {
						...previous,
						display: `${previous.display} / ${item.display}`,
						described: DESCRIBED_ORDER[item.described] > DESCRIBED_ORDER[previous.described] ? item.described : previous.described,
						referenced: Math.max(previous.referenced, item.referenced),
					},
		);
	}
	return names;
}

/** A comment says what the table is when it has a word of 3 letters or more besides the table's own name. */
function describes(comment: string, name: string): boolean {
	const lowerName = name.toLowerCase();
	return (comment.match(/[\p{L}\p{N}_]+/gu) ?? []).some((word) => word.toLowerCase() !== lowerName && /\p{L}{3}/u.test(word));
}

// Documentation defines a table in three ways; each captures the name as `name`:
// - in backticks: `cst`, `erp.cst`
// - alone in a cell of a markdown table row that has a description: | tda | Almacenes |
// - at the start of a line (a list item, a heading, bold allowed), followed by
//   "=", ":", "–", "—" or " - " and words: "cst = maestro de clientes"

const IN_BACKTICKS = new RegExp(`\`(?:${ID}\\.){0,2}(?<name>${ID})\``, "gu");
const DEFINITION_LINE = new RegExp(
	`^[ \\t]*(?:[-*+][ \\t]+|\\d+[.)][ \\t]+|#{1,6}[ \\t]+)?(?:\\*\\*)?(?:${ID}\\.){0,2}(?<name>${ID})(?:\\*\\*)?(?:[ \\t]*[=:–—]|[ \\t]+-)[ \\t]*\\p{L}{2}`,
	"gmu",
);
const WHOLE_ID = new RegExp(`^${ID}$`, "u");

/** Every table name the documentation defines; one per place. */
function tableDefinitions(text: string): string[] {
	const names: string[] = [];
	for (const match of text.matchAll(IN_BACKTICKS)) names.push(match.groups?.name as string);
	for (const match of text.matchAll(DEFINITION_LINE)) names.push(match.groups?.name as string);
	for (const line of text.split("\n")) {
		const row = line.trim();
		if (!row.startsWith("|")) continue;
		const cells = row.replace(/^\||\|$/g, "").split("|").map((cell) => cell.replace(/[`*]/g, "").trim());
		cells.forEach((cell, index) => {
			if (!WHOLE_ID.test(cell)) return;
			if (cells.some((other, at) => at !== index && /\p{L}{2}/u.test(other))) names.push(cell);
		});
	}
	return names;
}

/**
 * The source files to read, in a stable order. git knows which files belong
 * to the project (and skips what it ignores); without a repository, the
 * folder is walked. Either way the same folders and extensions are skipped,
 * so nothing under .heydb/, its secrets file included, is ever read.
 */
// The folders are walked directly, never listed through git: the code that
// uses a database is often a reference copy kept in a folder the project's
// .gitignore excludes, and git would hide it. Generated and third-party
// folders are skipped by name, and the walk is bounded by the file and time
// limits.
async function listSources(
	files: CodeFiles,
	maxFiles: number,
	outOfTime: () => boolean,
): Promise<{ docs: string[]; code: string[]; truncated: boolean }> {
	const docs: string[] = [];
	const code: string[] = [];
	let truncated = false;
	const pending = [""];
	while (pending.length > 0) {
		if (outOfTime()) return { docs, code, truncated: true };
		const dir = pending.shift() as string;
		let entries: Awaited<ReturnType<CodeFiles["list"]>>;
		try {
			entries = await files.list(dir);
		} catch {
			continue; // a folder we may not read
		}
		for (const entry of [...entries].sort((a, b) => compareText(a.name, b.name))) {
			const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
			if (entry.kind === "dir" && !SKIPPED_FOLDERS.has(entry.name)) pending.push(path);
			if (entry.kind !== "file") continue;
			// Each kind is listed up to the file limit on its own, so code early in the walk never hides the docs.
			const into = isDoc(path) ? docs : isSource(path) ? code : null;
			if (into === null) continue;
			if (into.length === maxFiles) truncated = true;
			else into.push(path);
		}
		if (truncated && docs.length === maxFiles && code.length === maxFiles) return { docs, code, truncated: true };
	}
	return { docs, code, truncated };
}

// What goes last among a table's files: it names the table without explaining it.

/** Folders of migrations, tests, seeds and fixtures. */
const LAST_FOLDERS = /^(?:migrations?|migrate|alembic|tests?|__tests__|specs?|seeds?|seeders?|fixtures?)$/iu;
/** File names of tests (orders.test.ts, orders_test.go, test_orders.py, OrderTest.php), seeds and fixtures. */
const LAST_FILES = [
	/\.(?:test|spec)\.[^.]+$/iu,
	/_test\.[^.]+$/iu,
	/^test_[^/]*\.py$/iu,
	/[\p{Ll}\p{N}]Tests?\.(?:java|kt|cs|php|scala)$/u,
	/^seed/iu,
	/seeder/iu,
	/fixture/iu,
];
/** Numbered SQL migrations (0001_init.sql, Drizzle, Flyway V1__init.sql) and SQL schema dumps. */
const SQL_MIGRATION = /^(?:\d{3,}[_-]|V\d+(?:[._]\d+)*__)/u;
const SQL_DUMP = /schema|dump|structure|ddl|backup/iu;
/** Words that mark a copy set aside, in a file or folder name. */
const SET_ASIDE = new Set(["old", "bak", "backup", "copy", "copia"]);

/** Whether a file names tables without explaining them: migrations, dumps, tests, seeds, fixtures, copies set aside. */
function goesLast(path: string): boolean {
	const segments = path.split("/");
	const file = segments.at(-1) ?? "";
	const folders = segments.slice(0, -1);
	const dot = file.lastIndexOf(".");
	const stem = dot > 0 ? file.slice(0, dot) : file;
	if (folders.some((folder) => LAST_FOLDERS.test(folder))) return true;
	if (LAST_FILES.some((pattern) => pattern.test(file))) return true;
	if (file.slice(dot + 1).toLowerCase() === "sql" && (SQL_MIGRATION.test(file) || SQL_DUMP.test(stem))) return true;
	return [...folders, stem].some(setAside);
}

/** "orders_old", "ordersBak", "orders copy", "no se compila", "nocompila". */
function setAside(name: string): boolean {
	const words = name
		.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u);
	if (words.some((word) => SET_ASIDE.has(word))) return true;
	const letters = name.toLowerCase().replace(/[^\p{L}]+/gu, "");
	return letters.includes("nocompila") || letters.includes("nosecompila");
}

/**
 * Files that may be customer variants of another: same folder and extension,
 * named like it plus a suffix (invoice_00123.prg, invoice-acme.prg,
 * invoice2.prg next to invoice.prg). A digit suffix is a variant; a word
 * suffix only when the file turns out to be a near-copy of its base, so
 * order_service.ts next to order.ts stays application code.
 */
function variantCandidates(paths: readonly string[]): Map<string, { base: string; digits: boolean }> {
	const parts = (path: string) => {
		const slash = path.lastIndexOf("/");
		const file = path.slice(slash + 1);
		const dot = file.lastIndexOf(".");
		if (dot <= 0) return null;
		return { group: `${path.slice(0, slash + 1)}\0${file.slice(dot + 1).toLowerCase()}`, stem: file.slice(0, dot).toLowerCase() };
	};
	const groups = new Map<string, Map<string, string>>();
	for (const path of paths) {
		const part = parts(path);
		if (part === null) continue;
		const stems = groups.get(part.group) ?? new Map<string, string>();
		groups.set(part.group, stems);
		stems.set(part.stem, path);
	}
	const candidates = new Map<string, { base: string; digits: boolean }>();
	for (const path of paths) {
		const part = parts(path);
		if (part === null) continue;
		const stems = groups.get(part.group) as Map<string, string>;
		const { stem } = part;
		// The longest existing base: after a separator, or right before trailing digits.
		let found: { base: string; digits: boolean } | undefined;
		for (let at = stem.length - 1; at > 0 && found === undefined; at--) {
			if (!"_-. ".includes(stem[at] as string)) continue;
			const base = stems.get(stem.slice(0, at));
			const tag = stem.slice(at + 1);
			if (base !== undefined && tag !== "") found = { base, digits: /^\d+$/u.test(tag) };
		}
		const numbered = /^(.*[^\d_\-. ])\d+$/u.exec(stem);
		const numberedBase = numbered === null ? undefined : stems.get(numbered[1] as string);
		if (found === undefined && numberedBase !== undefined) found = { base: numberedBase, digits: true };
		if (found !== undefined && found.base !== path) candidates.set(path, found);
	}
	return candidates;
}

/** The distinct lines of a file worth comparing (4 characters or more, trimmed), hashed. */
function fingerprint(text: string): Set<number> {
	const lines = new Set<number>();
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length < 4) continue;
		let hash = 0x811c9dc5;
		for (let i = 0; i < trimmed.length; i++) hash = Math.imul(hash ^ trimmed.charCodeAt(i), 0x01000193);
		lines.add(hash >>> 0);
	}
	return lines;
}

/** Near-copies: at least half of the lines of the bigger file are in the other. */
function similar(a: Set<number> | undefined, b: Set<number> | undefined): boolean {
	if (a === undefined || b === undefined) return false;
	const [small, big] = a.size <= b.size ? [a, b] : [b, a];
	if (big.size === 0) return false;
	let shared = 0;
	for (const line of small) if (big.has(line)) shared += 1;
	return shared * 2 >= big.size;
}

function isSource(path: string): boolean {
	return hasExtension(path, SOURCE_EXTENSIONS);
}

function isDoc(path: string): boolean {
	return hasExtension(path, DOC_EXTENSIONS);
}

function hasExtension(path: string, extensions: ReadonlySet<string>): boolean {
	const segments = path.split("/");
	if (segments.slice(0, -1).some((segment) => SKIPPED_FOLDERS.has(segment))) return false;
	const name = segments.at(-1) ?? "";
	if (SKIPPED_FILES.has(name) || name.toLowerCase().endsWith(".min.js")) return false;
	const dot = name.lastIndexOf(".");
	return dot > 0 && extensions.has(name.slice(dot + 1).toLowerCase());
}

function realFiles(root: string): CodeFiles {
	return {
		async list(dir) {
			const entries = await readdir(join(root, dir), { withFileTypes: true });
			return entries.map((entry) => ({
				name: entry.name,
				kind: entry.isFile() ? "file" : entry.isDirectory() ? "dir" : "other",
			}));
		},
		async size(path) {
			try {
				const stats = await lstat(join(root, path));
				return stats.isFile() ? stats.size : null;
			} catch {
				return null;
			}
		},
		read: (path) => readFile(join(root, path), "utf8"),
	};
}


// Plain code-unit comparison: the same order on every machine and locale.
function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

