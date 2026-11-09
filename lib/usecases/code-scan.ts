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
// mention in prose does not.
//
// The agent has a budget of about 20 notes, so the tables come in the order a
// note helps most: first those with no comment and no note, then those with a
// comment, then those that already have a note; within each group cryptic
// names (cst, fac_cab), many references and much code first.

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

/** What already says what a table is: nothing, its comment, or a team note. */
export type Described = "nothing" | "comment" | "note";

export interface TableUsage {
	/** Display name, e.g. "erp.art"; tables with the same name in several databases are joined with " / ". */
	readonly table: string;
	/** The table name as the schema writes it, e.g. "art". */
	readonly name: string;
	/** Code files that use it most, at most 5. */
	readonly files: readonly string[];
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
	/** A limit stopped the scan: more code may use these tables. */
	readonly truncated: boolean;
}

export async function findSchemaUsage(projectRoot: string, snapshot: Snapshot, options: ScanOptions = {}): Promise<SchemaUsage> {
	const limits = { ...DEFAULT_SCAN_LIMITS, ...options.limits };
	const files = options.files ?? realFiles(projectRoot);
	const now = options.now ?? (() => performance.now());
	const deadline = now() + limits.maxMillis;
	const outOfTime = () => now() > deadline;

	const names = tableNames(snapshot, options.knowledge ?? EMPTY_KNOWLEDGE, limits.maxTables);
	const listed = await listSources(files, limits.maxFiles, outOfTime);
	let truncated = listed.truncated;

	// lowercased table name → file → hits, in code and in documentation
	const found = new Map<string, Map<string, number>>();
	const defined = new Map<string, Map<string, number>>();
	let filesScanned = 0;
	let docsScanned = 0;
	let filesMatched = 0;
	let bytes = 0;
	for (const path of listed.paths) {
		if (outOfTime()) {
			truncated = true;
			break;
		}
		const size = await files.size(path);
		if (size === null || size > limits.maxFileBytes) continue;
		if (bytes + size > limits.maxBytes) {
			truncated = true;
			break;
		}
		bytes += size;
		let text: string;
		try {
			text = await files.read(path);
		} catch {
			continue; // deleted or unreadable since it was listed: not this scan's business
		}
		const doc = isDoc(path);
		if (doc) docsScanned += 1;
		else filesScanned += 1;
		let matched = false;
		for (const token of doc ? tableDefinitions(text) : tableReferences(text)) {
			const key = token.toLowerCase();
			if (!names.has(key)) continue;
			const into = doc ? defined : found;
			const perFile = into.get(key) ?? new Map<string, number>();
			into.set(key, perFile);
			perFile.set(path, (perFile.get(path) ?? 0) + 1);
			matched = true;
		}
		if (matched) filesMatched += 1;
	}

	const mostFirst = (perFile: Map<string, number> | undefined) =>
		[...(perFile ?? [])].sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]));
	const matches = [...new Set([...found.keys(), ...defined.keys()])].map((key): TableUsage => {
		const ranked = mostFirst(found.get(key));
		const table = names.get(key) as TableName;
		return {
			table: table.display,
			name: table.name,
			files: ranked.slice(0, MAX_FILES_PER_TABLE).map(([path]) => path),
			hits: ranked.reduce((sum, [, hits]) => sum + hits, 0),
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
	return {
		hasCode: filesScanned > 0,
		filesScanned,
		docsScanned,
		filesMatched,
		tablesMatched: matches.length,
		matches: matches.slice(0, MAX_MATCHES),
		truncated,
	};
}

const EMPTY_KNOWLEDGE: Knowledge = { formatVersion: 1, annotations: [], relationships: [] };

/** Tables nothing describes first, then commented ones, then those with a note. */
const DESCRIBED_ORDER: Readonly<Record<Described, number>> = { nothing: 0, comment: 1, note: 2 };

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
 * ORM and mapping declarations:
 * - `table = 'x'`, `$table = 'x'`, `protected $table = "x"`, `__tablename__ = "x"`
 *   (SQLAlchemy), `db_table = "x"` (Django), `tableName: "x"` / `tableName = "x"`,
 *   Doctrine XML `<entity … table="x">`
 * - `->table('x')`, `DB::table('x')`, `.table("x")`, `->from('x')`, `.from("x")`, `knex("x")`
 * - `@Table(name = "x")`, `@Entity(name = "x")` (JPA), `[Table("x")]` (C#)
 * - `table: x` on its own line (YAML mappings)
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
			`(?<![\\p{L}\\p{N}_])\\$?[\\p{L}\\p{N}_]*(?:tabla|table)[\\p{L}\\p{N}_]*\\s*(?::=|=(?!=)|:)\\s*${QUOTED_NAME}`,
			"dgiu",
		),
	},
	{ pattern: new RegExp(`(?:->|::|\\.)\\s*(?:table|from)\\s*\\(\\s*${QUOTED_NAME}`, "dgu") },
	{ pattern: new RegExp(`\\bknex\\s*\\(\\s*${QUOTED_NAME}`, "dgu") },
	{ pattern: new RegExp(`(?:@(?:Table|Entity)\\s*\\([^)]*?\\bname\\s*=\\s*|\\[Table\\s*\\(\\s*)${QUOTED_NAME}`, "dgu") },
	{ pattern: new RegExp(`^[ \\t]*table:[ \\t]*(?<name>${ID})[ \\t]*\\r?$`, "dgmu") },
];

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

/** Every table name the file uses in database context; one per place, even when two patterns see it. */
function tableReferences(text: string): string[] {
	const found = new Map<number, string>();
	for (const rule of REFERENCES) {
		for (const match of text.matchAll(rule.pattern)) {
			const start = match.indices?.groups?.name?.[0];
			const name = match.groups?.name;
			if (start === undefined || name === undefined) continue;
			const { before, after } = rule;
			if (before !== undefined && !before.verb.test(statementBefore(text, match.index, before.chars))) continue;
			if (after !== undefined && !after.verb.test(statementAfter(text, match.index + match[0].length, after.chars))) continue;
			found.set(start, name);
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
	const noted = new Set(knowledge.annotations.map((annotation) => annotation.target));
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
					described: noted.has(canonical) ? "note" : describes(table.comment, table.name) ? "comment" : "nothing",
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
): Promise<{ paths: string[]; truncated: boolean }> {
	const paths: string[] = [];
	const pending = [""];
	while (pending.length > 0) {
		if (outOfTime()) return { paths, truncated: true };
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
			if (entry.kind !== "file" || !(isSource(path) || isDoc(path))) continue;
			if (paths.length === maxFiles) return { paths, truncated: true };
			paths.push(path);
		}
	}
	return { paths, truncated: false };
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
