import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sortSnapshot } from "../model/order.ts";
import type { Snapshot } from "../model/snapshot.ts";
import { validateSnapshot } from "../model/validate.ts";
import { stableJson, writeFileAtomic } from "./files.ts";
import { assertConnectionName, assertNoSymlinks } from "./guards.ts";
import { HEYDB_DIR } from "./project.ts";

// Snapshots live in <project>/.heydb/snapshots/<connection>.json and are meant
// to be committed: teammates without database credentials still get the schema.

const SUPPORTED_FORMAT_VERSION = 1;

export function snapshotPath(projectRoot: string, connection: string): string {
	assertConnectionName(connection);
	return join(projectRoot, HEYDB_DIR, "snapshots", `${connection}.json`);
}

export function saveSnapshot(projectRoot: string, connection: string, snapshot: Snapshot): void {
	const path = snapshotPath(projectRoot, connection);
	assertNoSymlinks(projectRoot, "snapshots");
	writeFileAtomic(path, stableJson(sortSnapshot(snapshot)));
}

/** Returns the stored snapshot, or null when this connection was never synced. */
export function loadSnapshot(projectRoot: string, connection: string): Snapshot | null {
	const path = snapshotPath(projectRoot, connection);
	const fileName = `${connection}.json`;
	assertNoSymlinks(projectRoot, "snapshots");

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
