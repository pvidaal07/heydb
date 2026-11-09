import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { constants, gunzipSync, gzipSync } from "node:zlib";

import { sortSnapshot } from "../model/order.ts";
import type { Snapshot } from "../model/snapshot.ts";
import { validateSnapshot } from "../model/validate.ts";
import { stableJson, writeFileAtomic } from "./files.ts";
import { assertConnectionName, assertNoSymlinks } from "./guards.ts";
import { HEYDB_DIR } from "./project.ts";

// Snapshots live in <project>/.heydb/snapshots/<connection>.json.gz and are
// meant to be committed: teammates without database credentials still get the
// schema. The content is the same stable JSON earlier builds wrote as plain
// <connection>.json, gzip-compressed: a 1,500-table ERP was 395,460 lines of
// JSON, which nobody reviews in a pull request. Reading decompresses on every
// load: on 1,500 tables × 60 columns that is ~13 ms of the ~75 ms a load
// takes (JSON.parse and validation are the rest), so a decompressed local
// copy would save little and add a second file to keep in step.

const SUPPORTED_FORMAT_VERSION = 1;

/** Where saveSnapshot writes: <connection>.json.gz. */
export function snapshotPath(projectRoot: string, connection: string): string {
	assertConnectionName(connection);
	return join(projectRoot, HEYDB_DIR, "snapshots", `${connection}.json.gz`);
}

/** The plain <connection>.json earlier builds wrote; still read, replaced on the next save. */
function legacySnapshotPath(projectRoot: string, connection: string): string {
	assertConnectionName(connection);
	return join(projectRoot, HEYDB_DIR, "snapshots", `${connection}.json`);
}

/** The file the snapshot of `connection` is read from, or null when it was never synced. */
export function storedSnapshotPath(projectRoot: string, connection: string): string | null {
	for (const path of [snapshotPath(projectRoot, connection), legacySnapshotPath(projectRoot, connection)]) {
		if (existsSync(path)) return path;
	}
	return null;
}

export function saveSnapshot(projectRoot: string, connection: string, snapshot: Snapshot): void {
	const path = snapshotPath(projectRoot, connection);
	assertNoSymlinks(projectRoot, "snapshots");
	writeFileAtomic(path, gzipStable(stableJson(sortSnapshot(snapshot))));
	// Only after the new file is in place, so a failed write keeps the old one.
	rmSync(legacySnapshotPath(projectRoot, connection), { force: true });
}

/**
 * gzip with the header fields that depend on the machine fixed, so the same
 * snapshot gives the same bytes everywhere: modification time 0 and no file
 * name (what gzipSync already writes), and operating system 255, "unknown"
 * (zlib writes the one it was built for: 3 on Linux, 19 on macOS). The
 * compressed data itself depends only on the zlib build; a different one may
 * pick other bytes for the same JSON, which is harmless because the file is
 * only rewritten when the structure changed.
 */
function gzipStable(text: string): Buffer {
	const bytes = gzipSync(text, { level: constants.Z_BEST_COMPRESSION });
	bytes.writeUInt32LE(0, 4);
	bytes[9] = 0xff;
	return bytes;
}

/** Returns the stored snapshot, or null when this connection was never synced. */
export function loadSnapshot(projectRoot: string, connection: string): Snapshot | null {
	const path = snapshotPath(projectRoot, connection);
	const legacyPath = legacySnapshotPath(projectRoot, connection);
	assertNoSymlinks(projectRoot, "snapshots");

	const compressed = readIfExists(path);
	if (compressed !== null) {
		const fileName = `${connection}.json.gz`;
		let text: string;
		try {
			text = gunzipSync(compressed).toString("utf8");
		} catch {
			throw new Error(`${fileName} is not a valid gzip file (${path})`);
		}
		return parseSnapshot(text, fileName, path);
	}
	const plain = readIfExists(legacyPath);
	if (plain === null) return null;
	return parseSnapshot(plain.toString("utf8"), `${connection}.json`, legacyPath);
}

function readIfExists(path: string): Buffer | null {
	try {
		return readFileSync(path);
	} catch (error) {
		if (isMissingFile(error)) return null;
		throw error;
	}
}

function parseSnapshot(text: string, fileName: string, path: string): Snapshot {
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
