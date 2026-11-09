import { execFile } from "node:child_process";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { incomingCounts } from "../model/references.ts";
import { displayName, formatName } from "../model/names.ts";
import type { Snapshot } from "../model/snapshot.ts";
import { HEYDB_DIR } from "../store/project.ts";
import type { GitRun, RunGit } from "./sharing.ts";

// Whether the project next to .heydb/ has code that uses this database, and
// where. After a sync heydb offers to let the agent read that code and note
// what it makes explicit (enum values, units, joins without a foreign key).
// Many projects have none (a heydb project made only to explore a database),
// and then the notes come from conversations instead.
//
// This only finds candidates: a table name in database context, that is SQL
// (`SELECT … FROM gar`) or an ORM declaration (`protected $table = 'gar'`).
// A name that is only mentioned (a comment, help text, a variable) does not
// count: tables called "config" or "para" are ordinary words. It never
// interprets the code; the agent does that, if the person agrees. The scan runs right after a sync, so it is bounded in files,
// bytes and time: a huge repository gives a partial answer, never a stuck Pi.

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
	maxMillis: 3000,
	maxTables: 300,
};

/** Tables kept in the result, most used first, and files kept per table. */
const MAX_MATCHES = 30;
const MAX_FILES_PER_TABLE = 5;
/** Two-letter names ("id", "ab") are everywhere in code: they would only add noise. */
const MIN_NAME_LENGTH = 3;

/** Folders that hold someone else's code, build output, CI configuration or heydb's own files. */
const SKIPPED_FOLDERS = new Set(["node_modules", "vendor", ".git", HEYDB_DIR, "dist", "build", ".github", ".gitlab", ".circleci"]);
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
]);

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
	/** Replaced in tests; the default runs the real git. */
	readonly runGit?: RunGit;
	/** Milliseconds; replaced in tests. */
	readonly now?: () => number;
	readonly limits?: Partial<ScanLimits>;
}

export interface TableUsage {
	/** Display name, e.g. "erp.gar"; tables with the same name in several databases are joined with " / ". */
	readonly table: string;
	/** The table name as the schema writes it, e.g. "gar". */
	readonly name: string;
	/** Files that use it most, at most 5. */
	readonly files: readonly string[];
	/** Occurrences in every scanned file. */
	readonly hits: number;
}

export interface SchemaUsage {
	/** Whether any source file was found at all. */
	readonly hasCode: boolean;
	readonly filesScanned: number;
	/** Files that use at least one table. */
	readonly filesMatched: number;
	/** Tables used by at least one file; `matches` keeps the 30 most used. */
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

	const names = tableNames(snapshot, limits.maxTables);
	const listed = await listSources(projectRoot, files, options.runGit ?? runRealGit, limits.maxFiles, outOfTime);
	let truncated = listed.truncated;

	// lowercased table name → file → hits
	const found = new Map<string, Map<string, number>>();
	let filesScanned = 0;
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
		filesScanned += 1;
		let matched = false;
		for (const token of tableReferences(text)) {
			const key = token.toLowerCase();
			if (!names.has(key)) continue;
			const perFile = found.get(key) ?? new Map<string, number>();
			found.set(key, perFile);
			perFile.set(path, (perFile.get(path) ?? 0) + 1);
			matched = true;
		}
		if (matched) filesMatched += 1;
	}

	const matches = [...found].map(([key, perFile]): TableUsage => {
		const ranked = [...perFile].sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]));
		const table = names.get(key) as TableName;
		return {
			table: table.display,
			name: table.name,
			files: ranked.slice(0, MAX_FILES_PER_TABLE).map(([path]) => path),
			hits: ranked.reduce((sum, [, hits]) => sum + hits, 0),
		};
	});
	matches.sort((a, b) => b.hits - a.hits || compareText(a.table, b.table));
	return {
		hasCode: filesScanned > 0,
		filesScanned,
		filesMatched,
		tablesMatched: matches.length,
		matches: matches.slice(0, MAX_MATCHES),
		truncated,
	};
}

// The patterns of database context. Each captures the table name as `name`:
// a whole identifier (letters, digits, "_"), so "gar" never matches in
// ref_gar or garage. Keywords are case-insensitive.

const ID = "[\\p{L}\\p{N}_]+";
/** A name as SQL writes it: optionally quoted (` " ' [ ]) and qualified (db.table, db.schema.table). */
const SQL_NAME = `(?:[\`"'\\[]?${ID}[\`"'\\]]?\\.){0,2}[\`"'\\[]?(?<name>${ID})(?![\\p{L}\\p{N}_])`;
/** A quoted string that holds only the name: 'gar', "gar", `gar`. */
const QUOTED_NAME = `["'\`](?<name>${ID})["'\`]`;
/** How far back, within one statement (no ";"), the verb that opens it may be. */
const STATEMENT = "[^;]{0,2000}?";

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
const REFERENCES: readonly RegExp[] = [
	new RegExp(`(?<=\\b(?:SELECT|DELETE)\\b${STATEMENT})\\bFROM\\s+${SQL_NAME}`, "dgiu"),
	new RegExp(`(?<=\\bFROM\\b${STATEMENT})\\bJOIN\\s+${SQL_NAME}`, "dgiu"),
	new RegExp(`(?<=\\bUPDATE\\b${STATEMENT})\\bJOIN\\s+${SQL_NAME}(?=[^;]{0,500}?\\bSET\\b)`, "dgiu"),
	new RegExp(`(?<=\\b(?:INSERT|REPLACE|MERGE)\\b[^;]{0,100}?)\\bINTO\\s+${SQL_NAME}`, "dgiu"),
	new RegExp(`\\bUPDATE\\s+${SQL_NAME}(?=[^;]{0,500}?\\bSET\\b)`, "dgiu"),
	new RegExp(
		`(?<=\\b(?:CREATE|ALTER|DROP|TRUNCATE|RENAME|LOCK)\\b[^;]{0,40}?)\\bTABLES?\\s+(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?${SQL_NAME}`,
		"dgiu",
	),
	new RegExp(`(?<![\\p{L}\\p{N}_])\\$?(?:table|db_table|__tablename__|tableName)\\s*[:=]\\s*${QUOTED_NAME}`, "dgiu"),
	new RegExp(`(?:->|::|\\.)\\s*(?:table|from)\\s*\\(\\s*${QUOTED_NAME}`, "dgu"),
	new RegExp(`\\bknex\\s*\\(\\s*${QUOTED_NAME}`, "dgu"),
	new RegExp(`(?:@(?:Table|Entity)\\s*\\([^)]*?\\bname\\s*=\\s*|\\[Table\\s*\\(\\s*)${QUOTED_NAME}`, "dgu"),
	new RegExp(`^[ \\t]*table:[ \\t]*(?<name>${ID})[ \\t]*\\r?$`, "dgmu"),
];

/** Every table name the file uses in database context; one per place, even when two patterns see it. */
function tableReferences(text: string): string[] {
	const found = new Map<number, string>();
	for (const pattern of REFERENCES) {
		for (const match of text.matchAll(pattern)) {
			const start = match.indices?.groups?.name?.[0];
			const name = match.groups?.name;
			if (start !== undefined && name !== undefined) found.set(start, name);
		}
	}
	return [...found.values()];
}

interface TableName {
	readonly canonical: string;
	readonly name: string;
	readonly display: string;
}

/** Lowercased table name → how to show it, for the tables worth looking for. */
function tableNames(snapshot: Snapshot, maxTables: number): Map<string, TableName> {
	const all: { canonical: string; name: string; display: string }[] = [];
	for (const database of snapshot.databases) {
		for (const schema of database.schemas) {
			for (const table of schema.tables) {
				if (table.name.length < MIN_NAME_LENGTH) continue;
				const ref = { database: database.name, schema: schema.name, table: table.name };
				all.push({ canonical: formatName(ref), name: table.name, display: displayName(ref) });
			}
		}
	}
	let kept = all;
	if (all.length > maxTables) {
		// The tables others point to are the core of a legacy schema, and the ones code uses most.
		const counts = incomingCounts(snapshot, { formatVersion: 1, annotations: [], relationships: [] });
		const incoming = (item: (typeof all)[number]) => counts.get(item.canonical) ?? 0;
		kept = [...all].sort((a, b) => incoming(b) - incoming(a) || compareText(a.canonical, b.canonical)).slice(0, maxTables);
	}
	const names = new Map<string, TableName>();
	for (const item of kept) {
		const key = item.name.toLowerCase();
		const previous = names.get(key);
		names.set(key, previous === undefined ? item : { ...previous, display: `${previous.display} / ${item.display}` });
	}
	return names;
}

/**
 * The source files to read, in a stable order. git knows which files belong
 * to the project (and skips what it ignores); without a repository, the
 * folder is walked. Either way the same folders and extensions are skipped,
 * so nothing under .heydb/, its secrets file included, is ever read.
 */
async function listSources(
	root: string,
	files: CodeFiles,
	runGit: RunGit,
	maxFiles: number,
	outOfTime: () => boolean,
): Promise<{ paths: string[]; truncated: boolean }> {
	let run: GitRun | "missing";
	try {
		run = await runGit(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], root);
	} catch {
		run = "missing"; // too slow or too much output: the walk has its own limits
	}
	if (run !== "missing" && run.exitCode === 0) {
		const paths = run.stdout.split("\0").filter((path) => path !== "" && isSource(path));
		return { paths: paths.slice(0, maxFiles), truncated: paths.length > maxFiles };
	}

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
			if (entry.kind !== "file" || !isSource(path)) continue;
			if (paths.length === maxFiles) return { paths, truncated: true };
			paths.push(path);
		}
	}
	return { paths, truncated: false };
}

function isSource(path: string): boolean {
	const segments = path.split("/");
	if (segments.slice(0, -1).some((segment) => SKIPPED_FOLDERS.has(segment))) return false;
	const name = segments.at(-1) ?? "";
	if (SKIPPED_FILES.has(name) || name.toLowerCase().endsWith(".min.js")) return false;
	const dot = name.lastIndexOf(".");
	return dot > 0 && SOURCE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
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

const GIT_TIMEOUT_MS = 2000;
/** git ls-files of a very large repository; beyond it the walk takes over. */
const GIT_MAX_OUTPUT = 32 * 1024 * 1024;

// An argument list and no shell: nothing in a path is ever interpreted.
function runRealGit(args: readonly string[], cwd: string): Promise<GitRun | "missing"> {
	return new Promise((resolve, reject) => {
		const options = { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_OUTPUT, shell: false, windowsHide: true, encoding: "utf8" as const };
		execFile("git", [...args], options, (error, stdout, stderr) => {
			if (error === null) return resolve({ exitCode: 0, stdout, stderr });
			const failure = error as NodeJS.ErrnoException & { code?: unknown; killed?: boolean };
			if (failure.code === "ENOENT") return resolve("missing");
			if (typeof failure.code === "number" && !failure.killed) return resolve({ exitCode: failure.code, stdout, stderr });
			reject(error);
		});
	});
}

// Plain code-unit comparison: the same order on every machine and locale.
function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
