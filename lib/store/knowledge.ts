import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { emptyKnowledge, sortKnowledge } from "../knowledge/operations.ts";
import type { Knowledge, RelationshipSide } from "../knowledge/types.ts";
import { validateKnowledge, validateProjectKnowledge } from "../knowledge/validate.ts";
import { stableJson, writeFileAtomic } from "./files.ts";
import { assertConnectionName, assertNoSymlinks } from "./guards.ts";
import { HEYDB_DIR } from "./project.ts";

// Knowledge lives in <project>/.heydb/knowledge/<connection>.json, next to the
// snapshot, and is committed too: a teammate gets the notes with a git pull.
// One file per connection, not per table: table names are not safe file names
// (dots, case, names Windows reserves). See ADR-0012.
//
// Project notes live next to them in _project.json: a connection name must
// start with a letter or digit, so no connection can ever own that file.

const SUPPORTED_FORMAT_VERSION = 1;
const PROJECT_FILE = "_project.json";

export function knowledgePath(projectRoot: string, connection: string): string {
	assertConnectionName(connection);
	return join(projectRoot, HEYDB_DIR, "knowledge", `${connection}.json`);
}

export function saveKnowledge(projectRoot: string, connection: string, knowledge: Knowledge): void {
	const path = knowledgePath(projectRoot, connection);
	assertNoSymlinks(projectRoot, "knowledge");
	writeFileAtomic(path, stableJson(sortKnowledge(knowledge)));
}

/**
 * Returns the stored knowledge; a connection nobody annotated yet has empty
 * knowledge. A relationship side naming this same connection is the same as
 * one naming none, so it comes back without it: "no connection" is the only
 * way the rest of heydb has to say "this connection".
 */
export function loadKnowledge(projectRoot: string, connection: string): Knowledge {
	// "knowledge/" in messages tells it apart from the snapshot, also called <connection>.json.
	const knowledge = readKnowledge(projectRoot, knowledgePath(projectRoot, connection), `knowledge/${connection}.json`, validateKnowledge);
	const own = (side: RelationshipSide): RelationshipSide =>
		side.connection === connection ? { table: side.table, columns: side.columns } : side;
	return {
		...knowledge,
		relationships: knowledge.relationships.map((item) => ({ ...item, from: own(item.from), to: own(item.to) })),
	};
}

export function projectKnowledgePath(projectRoot: string): string {
	return join(projectRoot, HEYDB_DIR, "knowledge", PROJECT_FILE);
}

/** Notes about the whole project; empty when there are none yet. */
export function loadProjectKnowledge(projectRoot: string): Knowledge {
	return readKnowledge(projectRoot, projectKnowledgePath(projectRoot), `knowledge/${PROJECT_FILE}`, validateProjectKnowledge);
}

/** Checked before writing, so a bug elsewhere can never store a database note where nobody looks for it. */
export function saveProjectKnowledge(projectRoot: string, knowledge: Knowledge): void {
	const checked = validateProjectKnowledge(sortKnowledge(knowledge));
	assertNoSymlinks(projectRoot, "knowledge");
	writeFileAtomic(projectKnowledgePath(projectRoot), stableJson(checked));
}

/**
 * The connections that have a knowledge file, sorted: every <name>.json whose
 * name is a valid connection name, whether or not it is still configured.
 * The project file and anything else in the folder are left out.
 */
export function knowledgeConnections(projectRoot: string): string[] {
	assertNoSymlinks(projectRoot, "knowledge");
	let entries: string[];
	try {
		entries = readdirSync(join(projectRoot, HEYDB_DIR, "knowledge"));
	} catch (error) {
		if (isMissingFile(error)) return [];
		throw error;
	}
	return entries
		.filter((entry) => entry.endsWith(".json"))
		.map((entry) => entry.slice(0, -".json".length))
		.filter(isConnectionName)
		.sort();
}

function isConnectionName(name: string): boolean {
	try {
		assertConnectionName(name);
		return true;
	} catch {
		return false;
	}
}

function readKnowledge(projectRoot: string, path: string, fileName: string, validate: (data: unknown) => Knowledge): Knowledge {
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
	return checkKnowledge(data, fileName, validate);
}

function checkKnowledge(data: unknown, fileName: string, validate: (data: unknown) => Knowledge): Knowledge {
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
		return validate(data);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`${fileName} is not a heydb knowledge file: ${reason}`, { cause: error });
	}
}

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
