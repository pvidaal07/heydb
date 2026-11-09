import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { emptyConfig } from "../config/operations.ts";
import { stableJson, writeFileAtomic } from "../store/files.ts";
import { assertNoSymlinks } from "../store/guards.ts";
import { HEYDB_DIR } from "../store/project.ts";

// .heydb/.gitignore keeps the two local-only things out of git, whatever the
// project's own .gitignore says: the secrets file and the leftovers of an
// interrupted atomic write (writeFileAtomic names them *.tmp).
const GITIGNORE = [
	"# Written by heydb. Everything else in .heydb/ is meant to be committed.",
	"# .env holds local secrets for env:HEYDB_NAME password references; never commit it.",
	".env",
	"# Leftovers of an interrupted write.",
	"*.tmp",
	"",
].join("\n");

export interface InitResult {
	/** Paths created by this call, relative to the project root; empty when everything existed. */
	readonly created: readonly string[];
}

/**
 * Makes `root` a heydb project. Safe to run again: existing files are never
 * overwritten (a team may have edited the .gitignore or added connections),
 * so the only effect of a second run is filling in what is missing.
 */
export function initProject(root: string): InitResult {
	const files: [name: string, content: string][] = [
		[".gitignore", GITIGNORE],
		["config.json", stableJson(emptyConfig())],
	];
	// Every path is checked before anything is written.
	for (const [name] of files) assertNoSymlinks(root, name);

	const created: string[] = [];
	if (createDirectory(join(root, HEYDB_DIR))) created.push(`${HEYDB_DIR}/`);
	for (const [name, content] of files) {
		if (createFile(join(root, HEYDB_DIR, name), content)) created.push(`${HEYDB_DIR}/${name}`);
	}
	return { created };
}

const ENV_RULE = "# Added by heydb: .env holds local secrets for env:HEYDB_NAME references; never commit it.\n.env\n";

/**
 * Makes sure git ignores .heydb/.env before heydb writes a secret there. A
 * team may have replaced the .gitignore heydb wrote, so it is checked every
 * time: the rule is appended when no line ignores .env or a later "!.env"
 * un-ignores it, and the usual file is written when there is none. Returns
 * whether the file changed.
 */
export function ensureEnvIgnored(root: string): boolean {
	assertNoSymlinks(root, ".gitignore");
	const path = join(root, HEYDB_DIR, ".gitignore");
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (!hasCode(error, "ENOENT")) throw error;
		return createFile(path, GITIGNORE);
	}
	// The last rule that names .env decides, as in git.
	const rules = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^!?\/?\.env$/.test(line));
	if (rules.length > 0 && !rules[rules.length - 1]?.startsWith("!")) return false;
	const separator = text === "" || text.endsWith("\n") ? "" : "\n";
	writeFileAtomic(path, `${text}${separator}${ENV_RULE}`);
	return true;
}

function createDirectory(path: string): boolean {
	try {
		mkdirSync(path);
		return true;
	} catch (error) {
		if (!hasCode(error, "EEXIST")) throw error;
		if (!statSync(path).isDirectory()) throw new Error(`${HEYDB_DIR} exists but is not a directory`);
		return false;
	}
}

// The "wx" flag creates the file only if it does not exist, in one system
// call: there is no gap between "check" and "write" in which another process
// could create it and then be overwritten.
function createFile(path: string, content: string): boolean {
	try {
		writeFileSync(path, content, { flag: "wx" });
		return true;
	} catch (error) {
		if (hasCode(error, "EEXIST")) return false;
		throw error;
	}
}

function hasCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
