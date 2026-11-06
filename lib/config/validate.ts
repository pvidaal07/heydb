import { PASSWORD_REFERENCE, REFERENCE_RULE, suggestedReference } from "../secrets.ts";
import { assertConnectionName } from "../store/guards.ts";
import type { Config, ConnectionConfig, ConnectionEngine } from "./types.ts";

// config.json is committed and edited by hand, so every field is checked at
// the boundary, like snapshots and knowledge. The result is rebuilt field by
// field, and an unknown field is an error, not dropped: a password typed under
// a misspelt key would otherwise stay in the committed file unnoticed. Errors
// name the exact path, e.g. "connections.prod.port must be an integer from 1 to 65535".
//
// The same check runs on every entry the pure operations add or update, so a
// config in memory is always one that could have been loaded from disk.
//
// No message ever repeats the value of a password field, or of an unknown
// field: either may be the real password.

const ENGINES: readonly ConnectionEngine[] = ["mysql", "mariadb"];
const ROOT_FIELDS = ["formatVersion", "defaultConnection", "connections"];
const CONNECTION_FIELDS = ["engine", "host", "port", "user", "password", "databases"];

export function validateConfig(data: unknown): Config {
	const root = object(data, "config");
	onlyKnownFields(root, ROOT_FIELDS, "config");
	if (root.formatVersion !== 1) throw new Error("formatVersion must be 1");

	const defaultConnection = read(root, "defaultConnection");
	if (defaultConnection !== null && typeof defaultConnection !== "string") {
		throw new Error("defaultConnection must be null or a string");
	}
	const entries = object(read(root, "connections"), "connections");
	// A Map, then Object.fromEntries: the result only has the names that were read.
	const connections = new Map<string, ConnectionConfig>();
	for (const [name, value] of Object.entries(entries)) {
		try {
			assertConnectionName(name);
		} catch (error) {
			throw new Error(`connections: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
		}
		connections.set(name, validateConnection(value, name));
	}
	if (defaultConnection !== null && !connections.has(defaultConnection)) {
		throw new Error(`defaultConnection ${JSON.stringify(defaultConnection)} is not one of the configured connections`);
	}
	return { formatVersion: 1, defaultConnection, connections: Object.fromEntries(connections) };
}

export function validateConnection(data: unknown, name: string): ConnectionConfig {
	const path = `connections.${name}`;
	const entry = object(data, path);
	onlyKnownFields(entry, CONNECTION_FIELDS, path);
	return {
		engine: engine(read(entry, "engine", path), `${path}.engine`),
		host: text(read(entry, "host", path), `${path}.host`),
		port: port(read(entry, "port", path), `${path}.port`),
		user: text(read(entry, "user", path), `${path}.user`),
		password: password(read(entry, "password", path), `${path}.password`, name),
		databases: databases(read(entry, "databases", path), `${path}.databases`),
	};
}

function engine(value: unknown, path: string): ConnectionEngine {
	if (value === "postgresql") {
		throw new Error(`${path} "postgresql" is not supported yet (PostgreSQL support is planned); use "mysql" or "mariadb"`);
	}
	const found = ENGINES.find((item) => item === value);
	if (found === undefined) throw new Error(`${path} must be "mysql" or "mariadb"`);
	return found;
}

function text(value: unknown, path: string): string {
	if (typeof value !== "string" || value === "") throw new Error(`${path} must be a non-empty string`);
	return value;
}

function port(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
		throw new Error(`${path} must be an integer from 1 to 65535`);
	}
	return value;
}

function password(value: unknown, path: string, name: string): string {
	if (typeof value === "string" && PASSWORD_REFERENCE.test(value)) return value;
	const example = suggestedReference(name);
	if (typeof value === "string" && value.startsWith("env:")) {
		throw new Error(`${path} must be a reference such as "${example}": ${REFERENCE_RULE}`);
	}
	throw new Error(
		`${path} must be a reference such as "${example}", never the password itself: ` +
			".heydb/config.json is committed to git, so anything written there is readable by everyone with the repository. " +
			"Put the password in that environment variable (or in .heydb/.env, which git ignores).",
	);
}

function databases(value: unknown, path: string): readonly string[] | null {
	if (value === null) return null;
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(`${path} must be null (every database) or a non-empty list of names`);
	}
	return value.map((item: unknown, index) => {
		if (typeof item !== "string" || item === "") throw new Error(`${path}[${index}] must be a non-empty string`);
		if (value.indexOf(item) !== index) throw new Error(`${path} repeats ${JSON.stringify(item)}`);
		return item;
	});
}

/** Names the first unknown field, never its value. */
function onlyKnownFields(record: Record<string, unknown>, known: readonly string[], path: string): void {
	const unknown = Object.keys(record).find((key) => !known.includes(key));
	if (unknown !== undefined) throw new Error(`${path} has an unknown field ${JSON.stringify(unknown)}`);
}

function read(record: Record<string, unknown>, key: string, path = ""): unknown {
	if (!(key in record)) throw new Error(`${path === "" ? key : `${path}.${key}`} is missing`);
	return record[key];
}

function object(value: unknown, path: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
	return value as Record<string, unknown>;
}
