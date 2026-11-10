// Searching the project's own code and docs, as an agent does with rg, then
// reading the table's columns the cheapest way it has without heydb
// (information_schema). The search is in Node, no rg needed: case-insensitive,
// any of the query's words, "path:line:text", the first 100 matching lines,
// lines cut at 200 characters; binary files, files over 2 MB, node_modules,
// .git, .heydb (heydb's own notes would be heydb, not the code) and .env files
// (secrets) are skipped. Files are read one at a time and the walk stops at
// the cap, so a large tree costs what a real grep would.
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { columnsDump, databasesList, tablesList } from "../measure.ts";
import { type BenchContext, MAX_LINE_LENGTH, MAX_LINES, type Strategy, grepWords, searchThenRead, wordsPattern } from "./shared.ts";

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SKIPPED_FOLDERS: ReadonlySet<string> = new Set(["node_modules", ".git", ".heydb"]);
/** Bytes looked at for a NUL, as grep and rg do to call a file binary. */
const BINARY_PROBE = 8192;

export interface GrepResult {
	readonly lines: readonly string[];
	/** True when it stopped at the cap: there was more. */
	readonly capped: boolean;
	/** Files read. */
	readonly files: number;
}

export async function grepTree(root: string, words: readonly string[], maxLines = MAX_LINES): Promise<GrepResult> {
	const lines: string[] = [];
	let files = 0;
	if (words.length === 0) return { lines, capped: false, files };
	const pattern = wordsPattern(words);
	for await (const path of walk(root)) {
		const info = await stat(path);
		if (info.size > MAX_FILE_BYTES) continue;
		const data = await readFile(path);
		files += 1;
		if (data.subarray(0, BINARY_PROBE).includes(0)) continue;
		const text = data.toString("utf8");
		if (!pattern.test(text)) continue;
		const name = relative(root, path).split(sep).join("/");
		for (const [index, line] of text.split(/\r?\n/).entries()) {
			if (!pattern.test(line)) continue;
			if (lines.length === maxLines) return { lines, capped: true, files };
			lines.push(`${name}:${index + 1}:${line.slice(0, MAX_LINE_LENGTH)}`);
		}
	}
	return { lines, capped: false, files };
}

/** Regular files under a folder, names in byte order (deterministic), symbolic links not followed. */
async function* walk(dir: string): AsyncGenerator<string> {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (!SKIPPED_FOLDERS.has(entry.name)) yield* walk(path);
		} else if (entry.isFile() && !entry.name.startsWith(".env")) {
			yield path;
		}
	}
}

/** Undefined without a code folder: the strategy is skipped. */
export function codeGrep(ctx: BenchContext): Strategy | undefined {
	const root = ctx.codeDir;
	if (root === undefined) return undefined;
	return {
		id: "code-grep",
		label: "grep the code, then SQL columns",
		simulated: false,
		run: (question) =>
			searchThenRead(ctx, question, {
				lookup: ctx.lookup,
				search: async (query) => ({ tool: "grep", args: query, text: (await grepTree(root, grepWords(query))).lines.join("\n") }),
				// The guided route: list the databases, then one database's tables with their comments.
				fallback: (targets) => ({
					calls: [
						() => ({ tool: "sql databases", args: "", text: databasesList(ctx.tables) }),
						() => ({ tool: "sql tables", args: targets[0]!.schema, text: tablesList(ctx.tables, targets[0]!.schema) }),
					],
					definitions: false,
				}),
				read: (targets) => [() => ({ tool: "sql columns", args: targets.map((target) => target.table.name).join(", "), text: columnsDump(targets, false) })],
			}),
	};
}
