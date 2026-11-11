import type { RowDataPacket } from "mysql2/promise";

import { type MysqlConnectionOptions, connectReadOnly } from "./introspect.ts";

// The check before a sync (issue #144): which configured databases the server
// does not show to this user. One cheap query on SCHEMATA, with a time limit,
// so a wrong database name is found in a moment instead of after a long read.

/** How long the one query may take before the check fails, naming what it was doing. */
export const CHECK_TIMEOUT_MS = 10_000;

/** What findMissingDatabases needs from a connection; a mysql2 connection fits. */
export interface SchemataReader {
	query(options: { sql: string; timeout: number }, values: unknown[]): Promise<readonly [unknown, unknown]>;
}

/** The configured databases of `options` that do not exist or are not visible; none when it captures all. */
export async function missingMysqlDatabases(options: MysqlConnectionOptions): Promise<string[]> {
	const configured = options.databases ?? [];
	if (configured.length === 0) return [];
	const connection = await connectReadOnly(options);
	try {
		const missing = await findMissingDatabases(connection, configured);
		await connection.end();
		return missing;
	} catch (error) {
		// After a timeout the connection may be stuck: drop it instead of waiting for a polite end.
		connection.destroy();
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(
			`mysql: checking which databases exist on ${options.host}:${options.port} failed ` +
				`(time limit ${CHECK_TIMEOUT_MS / 1000}s): ${reason}`,
			{ cause: error },
		);
	}
}

/** `configured`, in its order, minus the names SCHEMATA lists. Names compare exactly, as the capture does. */
export async function findMissingDatabases(connection: SchemataReader, configured: readonly string[]): Promise<string[]> {
	const [rows] = await connection.query(
		{ sql: "SELECT SCHEMA_NAME AS name FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME IN (?)", timeout: CHECK_TIMEOUT_MS },
		[[...configured]],
	);
	const found = new Set((rows as RowDataPacket[]).map((row) => String(row.name)));
	return configured.filter((name) => !found.has(name));
}
