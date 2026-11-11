import type { ConnectionConfig } from "../config/types.ts";
import type { Snapshot } from "../model/snapshot.ts";
import type { MysqlConnectionOptions } from "./mysql/introspect.ts";
import type { PostgresConnectionOptions } from "./postgres/introspect.ts";

// The one entry point to every engine. Callers pass a config entry and the
// already resolved password (lib/secrets.ts); this file picks the engine.
//
// Drivers load only when used (ADR-0006): the engine module, and with it its
// driver, is imported with a dynamic import() inside the function, never at
// the top of this file. Reading the snapshot, searching or annotating never
// connect, so they never pay for mysql2 or pg. `import type` above is erased before
// the code runs and loads nothing; tests/engines/index.test.ts checks both.

// One shared promise per engine module: concurrent callers wait for the same
// import instead of starting their own. Pi's module loader breaks when two
// imports of mysql2 run at the same time (seen with two /heydb:status at once).
let mysqlEngine: Promise<typeof import("./mysql/introspect.ts")> | undefined;

function loadMysqlEngine(): Promise<typeof import("./mysql/introspect.ts")> {
	mysqlEngine ??= import("./mysql/introspect.ts").catch((error: unknown) => {
		mysqlEngine = undefined; // a failed load can be retried
		throw error;
	});
	return mysqlEngine;
}

let postgresEngine: Promise<typeof import("./postgres/introspect.ts")> | undefined;

function loadPostgresEngine(): Promise<typeof import("./postgres/introspect.ts")> {
	postgresEngine ??= import("./postgres/introspect.ts").catch((error: unknown) => {
		postgresEngine = undefined; // a failed load can be retried
		throw error;
	});
	return postgresEngine;
}

let mysqlDatabases: Promise<typeof import("./mysql/databases.ts")> | undefined;

function loadMysqlDatabases(): Promise<typeof import("./mysql/databases.ts")> {
	// After the engine module: it is what loads mysql2, and its one shared promise
	// keeps two first-time loads of the driver from running at once.
	mysqlDatabases ??= loadMysqlEngine()
		.then(() => import("./mysql/databases.ts"))
		.catch((error: unknown) => {
		mysqlDatabases = undefined; // a failed load can be retried
		throw error;
	});
	return mysqlDatabases;
}

/**
 * The databases `entry` lists that the server does not have or does not show
 * to its user, in config order; none when it captures every visible database.
 * PostgreSQL is not checked: a connection reaches exactly one database, and
 * connecting to one that does not exist already fails at once with a clear error.
 */
export async function missingDatabases(entry: ConnectionConfig, password: string): Promise<string[]> {
	if (entry.databases === null) return [];
	switch (entry.engine) {
		case "mysql":
		case "mariadb": {
			const { missingMysqlDatabases } = await loadMysqlDatabases();
			return missingMysqlDatabases(mysqlOptions(entry, password));
		}
		case "postgresql":
			return [];
	}
}

/** Captures the structure of the server described by `entry`. */
export async function introspect(entry: ConnectionConfig, password: string): Promise<Snapshot> {
	switch (entry.engine) {
		case "mysql":
		case "mariadb": {
			const { introspectMysql } = await loadMysqlEngine();
			return introspectMysql(mysqlOptions(entry, password));
		}
		case "postgresql": {
			// Built before the import, so a bad entry fails without loading pg.
			const options = postgresOptions(entry, password);
			const { introspectPostgres } = await loadPostgresEngine();
			return introspectPostgres(options);
		}
	}
}

/** MySQL and MariaDB speak the same protocol, so both use the same driver options. */
export function mysqlOptions(entry: ConnectionConfig, password: string): MysqlConnectionOptions {
	return { host: entry.host, port: entry.port, user: entry.user, password, databases: entry.databases };
}

/** A PostgreSQL connection reaches one database: the only entry of `databases`. */
export function postgresOptions(entry: ConnectionConfig, password: string): PostgresConnectionOptions {
	const [database, ...others] = entry.databases ?? [];
	// Config validation already requires exactly one; this guards entries built in code.
	if (database === undefined || others.length > 0) throw new Error("a postgresql connection needs exactly one database");
	return { host: entry.host, port: entry.port, user: entry.user, password, database, schemas: entry.schemas ?? null };
}
