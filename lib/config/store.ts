import { readFileSync } from "node:fs";
import { join } from "node:path";

import { stableJson, writeFileAtomic } from "../store/files.ts";
import { assertNoSymlinks } from "../store/guards.ts";
import { HEYDB_DIR } from "../store/project.ts";
import { emptyConfig } from "./operations.ts";
import type { Config } from "./types.ts";
import { validateConfig } from "./validate.ts";

// .heydb/config.json: the connections of the project, committed, without
// secrets. Written like the snapshot (sorted keys, atomic rename), so a git
// diff of a config change shows only the changed fields.

const SUPPORTED_FORMAT_VERSION = 1;
const FILE_NAME = "config.json";

export function configPath(projectRoot: string): string {
	return join(projectRoot, HEYDB_DIR, FILE_NAME);
}

export function saveConfig(projectRoot: string, config: Config): void {
	assertNoSymlinks(projectRoot, FILE_NAME);
	// Validated again on the way out: a config that could not be loaded back is never written.
	writeFileAtomic(configPath(projectRoot), stableJson(validateConfig(config)));
}

/** Returns the stored config; a project without config.json has no connections yet. */
export function loadConfig(projectRoot: string): Config {
	const path = configPath(projectRoot);
	assertNoSymlinks(projectRoot, FILE_NAME);

	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (isMissingFile(error)) return emptyConfig();
		throw error;
	}

	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		throw new Error(`${FILE_NAME} is not valid JSON (${path})`);
	}
	return checkConfig(data);
}

function checkConfig(data: unknown): Config {
	if (data === null || typeof data !== "object" || Array.isArray(data)) {
		throw new Error(`${FILE_NAME} is not a heydb config: expected a JSON object`);
	}
	const record = data as Record<string, unknown>;
	if (!("formatVersion" in record)) {
		throw new Error(`${FILE_NAME} is not a heydb config: missing "formatVersion"`);
	}
	if (record.formatVersion !== SUPPORTED_FORMAT_VERSION) {
		throw new Error(
			`${FILE_NAME}: unsupported config formatVersion ${JSON.stringify(record.formatVersion)} (expected ${SUPPORTED_FORMAT_VERSION}); update heydb`,
		);
	}
	try {
		return validateConfig(data);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`${FILE_NAME} is not a heydb config: ${reason}`, { cause: error });
	}
}

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
