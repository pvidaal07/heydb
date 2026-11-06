import { assertConnectionName } from "../store/guards.ts";
import type { Config, ConnectionConfig } from "./types.ts";
import { validateConnection } from "./validate.ts";

// Pure operations on Config, like the knowledge ones: each returns a new value
// and never mutates its input, and every entry they produce has passed the
// same validation as a file loaded from disk. Callers decide when to save.

export function emptyConfig(): Config {
	return { formatVersion: 1, defaultConnection: null, connections: {} };
}

export function addConnection(config: Config, name: string, entry: ConnectionConfig): Config {
	assertConnectionName(name);
	if (Object.hasOwn(config.connections, name)) {
		throw new Error(`connection "${name}" already exists; update or remove it instead`);
	}
	return withConnections(config, { ...config.connections, [name]: validateConnection(entry, name) });
}

/** Changes only the given fields; the merged entry is validated again. */
export function updateConnection(config: Config, name: string, changes: Partial<ConnectionConfig>): Config {
	const existing = requireConnection(config, name);
	return withConnections(config, { ...config.connections, [name]: validateConnection({ ...existing, ...changes }, name) });
}

/** Removes a connection; when it was the default, there is no default any more. */
export function removeConnection(config: Config, name: string): Config {
	requireConnection(config, name);
	const connections = Object.fromEntries(Object.entries(config.connections).filter(([key]) => key !== name));
	const defaultConnection = config.defaultConnection === name ? null : config.defaultConnection;
	return { formatVersion: 1, defaultConnection, connections };
}

export function setDefaultConnection(config: Config, name: string | null): Config {
	if (name !== null) requireConnection(config, name);
	return { ...config, defaultConnection: name };
}

/**
 * The connection a command should use: the name it was given, else the
 * default, else the only one configured. Anything else would be a guess, and
 * a wrong guess here means reading the wrong server.
 */
export function pickConnection(config: Config, name?: string): { name: string; connection: ConnectionConfig } {
	const chosen = name ?? config.defaultConnection ?? onlyConnection(config);
	return { name: chosen, connection: requireConnection(config, chosen) };
}

function onlyConnection(config: Config): string {
	const names = sortedNames(config);
	const [only] = names;
	if (only === undefined) throw new Error("no connections are configured: add one first");
	if (names.length > 1) {
		throw new Error(
			`several connections are configured (${names.join(", ")}) and none is the default: pass a connection name or set a default`,
		);
	}
	return only;
}

function requireConnection(config: Config, name: string): ConnectionConfig {
	if (Object.hasOwn(config.connections, name)) return config.connections[name] as ConnectionConfig;
	const names = sortedNames(config);
	const known = names.length === 0 ? "no connections are configured" : `configured: ${names.join(", ")}`;
	throw new Error(`unknown connection "${name}"; ${known}`);
}

function withConnections(config: Config, connections: Record<string, ConnectionConfig>): Config {
	return { ...config, connections };
}

function sortedNames(config: Config): string[] {
	return Object.keys(config.connections).sort();
}
