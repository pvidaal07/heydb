import { lstatSync } from "node:fs";
import { join } from "node:path";

import { HEYDB_DIR } from "./project.ts";

// Safety checks shared by every file heydb keeps under .heydb/. Keeping them
// in one place means snapshots and knowledge can never drift apart.

// The connection name becomes a file name, so it is an allow-list:
// - no path separators or dots, so it can never point outside .heydb/ ("../evil");
// - lowercase only, because "Prod" and "prod" are the same file on macOS and Windows;
// - none of the device names Windows reserves (a file "nul.json" cannot be checked out there).
const CONNECTION_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

export function assertConnectionName(name: string): void {
	if (!CONNECTION_NAME.test(name)) {
		throw new Error(
			`invalid connection name ${JSON.stringify(name)}: use 1-64 lowercase letters, digits, "-" or "_", starting with a letter or digit`,
		);
	}
	if (WINDOWS_RESERVED.test(name)) {
		throw new Error(`invalid connection name ${JSON.stringify(name)}: reserved name on Windows`);
	}
}

/**
 * Turns what a person typed ("Acme", "Prod EU", "Producción") into a name
 * assertConnectionName accepts ("acme", "prod-eu", "produccion"), so the
 * rule protects the files without getting in the user's way. Returns null
 * when nothing usable is left.
 */
export function toConnectionName(input: string): string | null {
	let name = input
		.normalize("NFD")
		.replace(/\p{M}/gu, "") // accents: "ó" → "o"
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-") // spaces, dots and anything else become a dash
		.replace(/-{2,}/g, "-")
		.replace(/^[-_]+|[-_]+$/g, "")
		.slice(0, 64)
		.replace(/[-_]+$/, "");
	if (name === "") return null;
	if (WINDOWS_RESERVED.test(name)) name = `${name}-db`;
	return name;
}

/**
 * .heydb/ is committed, and git can commit symbolic links. A link named .heydb
 * or .heydb/<entry> (a subdirectory such as "snapshots", or a file such as
 * ".env") pointing elsewhere would make heydb read or overwrite files outside
 * the project, so links are refused, never followed.
 */
export function assertNoSymlinks(projectRoot: string, entry: string): void {
	for (const relative of [HEYDB_DIR, join(HEYDB_DIR, entry)]) {
		if (isSymlink(join(projectRoot, relative))) {
			throw new Error(`${relative.replaceAll("\\", "/")} is a symbolic link; heydb refuses to follow it`);
		}
	}
}

function isSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false; // does not exist yet
	}
}
