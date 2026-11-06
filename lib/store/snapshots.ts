import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { sortSnapshot } from "../model/order.ts";
import type { Snapshot } from "../model/snapshot.ts";
import { validateSnapshot } from "../model/validate.ts";
import { stableJson, writeFileAtomic } from "./files.ts";
import { HEYDB_DIR } from "./project.ts";

// Snapshots live in <project>/.heydb/snapshots/<connection>.json and are meant
// to be committed: teammates without database credentials still get the schema.

const SUPPORTED_FORMAT_VERSION = 1;

// The connection name becomes a file name, so it is an allow-list:
// - no path separators or dots, so it can never point outside .heydb/ ("../evil");
// - lowercase only, because "Prod" and "prod" are the same file on macOS and Windows;
// - none of the device names Windows reserves (a file "nul.json" cannot be checked out there).
const CONNECTION_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

export function snapshotPath(projectRoot: string, connection: string): string {
	assertConnectionName(connection);
	return join(projectRoot, HEYDB_DIR, "snapshots", `${connection}.json`);
}

export function saveSnapshot(projectRoot: string, connection: string, snapshot: Snapshot): void {
	const path = snapshotPath(projectRoot, connection);
	assertNoSymlinks(projectRoot);
	writeFileAtomic(path, stableJson(sortSnapshot(snapshot)));
}

/** Returns the stored snapshot, or null when this connection was never synced. */
export function loadSnapshot(projectRoot: string, connection: string): Snapshot | null {
	const path = snapshotPath(projectRoot, connection);
	const fileName = `${connection}.json`;
	assertNoSymlinks(projectRoot);

	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (isMissingFile(error)) return null;
		throw error;
	}

	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		throw new Error(`${fileName} is not valid JSON (${path})`);
	}
	return checkSnapshot(data, fileName);
}

function assertConnectionName(name: string): void {
	if (!CONNECTION_NAME.test(name)) {
		throw new Error(
			`invalid connection name ${JSON.stringify(name)}: use 1-64 lowercase letters, digits, "-" or "_", starting with a letter or digit`,
		);
	}
	if (WINDOWS_RESERVED.test(name)) {
		throw new Error(`invalid connection name ${JSON.stringify(name)}: reserved name on Windows`);
	}
}

// .heydb/ is committed, and git can commit symbolic links. A link named
// .heydb or .heydb/snapshots pointing elsewhere would make heydb read or
// overwrite files outside the project, so links are refused, never followed.
function assertNoSymlinks(projectRoot: string): void {
	for (const relative of [HEYDB_DIR, join(HEYDB_DIR, "snapshots")]) {
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

// First the top-level checks, whose messages say what kind of file this is
// (not a snapshot at all, or one from a newer heydb); then validateSnapshot
// checks every field down to each column.
function checkSnapshot(data: unknown, fileName: string): Snapshot {
	if (data === null || typeof data !== "object" || Array.isArray(data)) {
		throw new Error(`${fileName} is not a heydb snapshot: expected a JSON object`);
	}
	const record = data as Record<string, unknown>;
	if (!("formatVersion" in record)) {
		throw new Error(`${fileName} is not a heydb snapshot: missing "formatVersion"`);
	}
	if (record.formatVersion !== SUPPORTED_FORMAT_VERSION) {
		throw new Error(
			`${fileName}: unsupported snapshot formatVersion ${JSON.stringify(record.formatVersion)} (expected ${SUPPORTED_FORMAT_VERSION}); update heydb`,
		);
	}
	for (const field of ["engine", "capturedAt", "databases", "warnings"]) {
		if (!(field in record)) {
			throw new Error(`${fileName} is not a heydb snapshot: missing "${field}"`);
		}
	}
	if (!Array.isArray(record.databases) || !Array.isArray(record.warnings)) {
		throw new Error(`${fileName} is not a heydb snapshot: "databases" and "warnings" must be lists`);
	}
	try {
		return validateSnapshot(data);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`${fileName} is not a heydb snapshot: ${reason}`, { cause: error });
	}
}

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
