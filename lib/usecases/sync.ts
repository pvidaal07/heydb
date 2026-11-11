import { updateConnection } from "../config/operations.ts";
import { loadConfig, saveConfig } from "../config/store.ts";
import type { ConnectionConfig } from "../config/types.ts";
import { missingDatabases } from "../engines/index.ts";
import { type Change, diffSnapshots } from "../model/diff.ts";
import { schemaHash } from "../model/hash.ts";
import type { Snapshot } from "../model/snapshot.ts";
import { resolveSecret } from "../secrets.ts";
import { saveSnapshot } from "../store/snapshots.ts";
import type { OpenedConnection } from "./project.ts";
import { checkStatus } from "./status.ts";

export interface SyncResult {
	/** false when the stored snapshot already had the same structure. */
	readonly written: boolean;
	readonly hash: string;
	/** What the new file changed; every database counts as added on the first sync. */
	readonly changes: readonly Change[];
}

/**
 * Stores the live snapshot of `connection`, but only when its structure
 * differs from the stored one. Snapshot files are committed: rewriting them
 * because the capture time, a row estimate or a warning changed would create
 * a git change on every sync with nothing real to review.
 */
export function syncSnapshot(projectRoot: string, connection: string, live: Snapshot): SyncResult {
	const status = checkStatus(projectRoot, connection, live);
	switch (status.state) {
		case "up_to_date":
			return { written: false, hash: status.hash, changes: [] };
		case "never_synced":
			saveSnapshot(projectRoot, connection, live);
			return { written: true, hash: schemaHash(live), changes: diffSnapshots({ ...live, databases: [] }, live) };
		case "drifted":
			saveSnapshot(projectRoot, connection, live);
			return { written: true, hash: status.liveHash, changes: status.changes };
	}
}

export interface DatabaseCheckOptions {
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** The engine's check; replaced in tests so no server is needed. */
	readonly missingDatabases?: (entry: ConnectionConfig, password: string) => Promise<readonly string[]>;
}

/**
 * The databases the connection lists that the server does not have or does
 * not show to its user, in config order. A connection that captures every
 * visible database has nothing to check, and never connects for it. The
 * password is resolved here, like captureLive, and only handed to the engine.
 */
export async function checkDatabases(opened: OpenedConnection, options: DatabaseCheckOptions = {}): Promise<string[]> {
	if (opened.connection.databases === null) return [];
	const { env = process.env, missingDatabases: find = missingDatabases } = options;
	const password = resolveSecret(opened.connection.password, { connection: opened.name, env, projectRoot: opened.root });
	return [...(await find(opened.connection, password))];
}

/**
 * Removes `databases` from the connection in .heydb/config.json, read fresh
 * from disk, and returns the connection as it now is. The rest of the file is
 * kept and written as every config change is. Removing every database is
 * refused: an empty list is not valid, and null would mean "all of them".
 */
export function removeDatabases(opened: OpenedConnection, databases: readonly string[]): OpenedConnection {
	const config = loadConfig(opened.root);
	const current = config.connections[opened.name]?.databases ?? null;
	if (current === null) return { ...opened, config, connection: config.connections[opened.name] ?? opened.connection };
	const kept = current.filter((name) => !databases.includes(name));
	if (kept.length === 0) {
		throw new Error(`connection "${opened.name}" would be left without databases; fix its databases or remove the connection instead`);
	}
	const next = updateConnection(config, opened.name, { databases: kept });
	saveConfig(opened.root, next);
	return { ...opened, config: next, connection: next.connections[opened.name] as ConnectionConfig };
}

/** The requested databases a capture skipped because the server did not show them (the engine's database_not_visible warnings). */
export function skippedDatabases(snapshot: Snapshot): string[] {
	return snapshot.warnings.filter((warning) => warning.code === SKIPPED_DATABASE && warning.target !== undefined).map((warning) => warning.target as string);
}

/** The warning the MySQL engine gives for a configured database it cannot see. */
export const SKIPPED_DATABASE = "database_not_visible";
