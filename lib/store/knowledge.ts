import { readFileSync } from "node:fs";
import { join } from "node:path";

import { emptyKnowledge, sortKnowledge } from "../knowledge/operations.ts";
import type { Knowledge } from "../knowledge/types.ts";
import { validateKnowledge } from "../knowledge/validate.ts";
import { stableJson, writeFileAtomic } from "./files.ts";
import { assertConnectionName, assertNoSymlinks } from "./guards.ts";
import { HEYDB_DIR } from "./project.ts";

// Knowledge lives in <project>/.heydb/knowledge/<connection>.json, next to the
// snapshot, and is committed too: a teammate gets the notes with a git pull.
// One file per connection, not per table: table names are not safe file names
// (dots, case, names Windows reserves). See ADR-0012.

const SUPPORTED_FORMAT_VERSION = 1;


export function knowledgePath(projectRoot: string, connection: string): string {
	assertConnectionName(connection);
	return join(projectRoot, HEYDB_DIR, "knowledge", `${connection}.json`);
}

export function saveKnowledge(projectRoot: string, connection: string, knowledge: Knowledge): void {
	const path = knowledgePath(projectRoot, connection);
	assertNoSymlinks(projectRoot, "knowledge");
	writeFileAtomic(path, stableJson(sortKnowledge(knowledge)));
}

/** Returns the stored knowledge; a connection nobody annotated yet has empty knowledge. */
export function loadKnowledge(projectRoot: string, connection: string): Knowledge {
	const path = knowledgePath(projectRoot, connection);
	// "knowledge/" in messages tells it apart from the snapshot, also called <connection>.json.
	const fileName = `knowledge/${connection}.json`;
	assertNoSymlinks(projectRoot, "knowledge");

	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (isMissingFile(error)) return emptyKnowledge();
		throw error;
	}

	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		throw new Error(`${fileName} is not valid JSON (${path})`);
	}
	return checkKnowledge(data, fileName);
}

function checkKnowledge(data: unknown, fileName: string): Knowledge {
	if (data === null || typeof data !== "object" || Array.isArray(data)) {
		throw new Error(`${fileName} is not a heydb knowledge file: expected a JSON object`);
	}
	const record = data as Record<string, unknown>;
	if (!("formatVersion" in record)) {
		throw new Error(`${fileName} is not a heydb knowledge file: missing "formatVersion"`);
	}
	if (record.formatVersion !== SUPPORTED_FORMAT_VERSION) {
		throw new Error(
			`${fileName}: unsupported knowledge formatVersion ${JSON.stringify(record.formatVersion)} (expected ${SUPPORTED_FORMAT_VERSION}); update heydb`,
		);
	}
	try {
		return validateKnowledge(data);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`${fileName} is not a heydb knowledge file: ${reason}`, { cause: error });
	}
}

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
