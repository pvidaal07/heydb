import type { ConnectionConfig } from "../config/types.ts";
import type { Snapshot } from "../model/snapshot.ts";
import type { MysqlConnectionOptions } from "./mysql/introspect.ts";

// The one entry point to every engine. Callers pass a config entry and the
// already resolved password (lib/secrets.ts); this file picks the engine.
//
// Drivers load only when used (ADR-0006): the engine module, and with it its
// driver, is imported with a dynamic import() inside the function, never at
// the top of this file. Reading the snapshot, searching or annotating never
// connect, so they never pay for mysql2. `import type` above is erased before
// the code runs and loads nothing; tests/engines/index.test.ts checks both.

/** Captures the structure of the server described by `entry`. */
export async function introspect(entry: ConnectionConfig, password: string): Promise<Snapshot> {
	switch (entry.engine) {
		case "mysql":
		case "mariadb": {
			const { introspectMysql } = await import("./mysql/introspect.ts");
			return introspectMysql(mysqlOptions(entry, password));
		}
	}
}

/** MySQL and MariaDB speak the same protocol, so both use the same driver options. */
export function mysqlOptions(entry: ConnectionConfig, password: string): MysqlConnectionOptions {
	return { host: entry.host, port: entry.port, user: entry.user, password, databases: entry.databases };
}
