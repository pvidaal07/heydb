// The connections of a project live in .heydb/config.json, which is committed:
// teammates share host, port, engine and user through git. That only works
// because the file holds NO secrets. A password is always a reference such as
// "env:HEYDB_PROD_PASSWORD", resolved on the machine that connects (ADR-0005).

/** Engines a connection may use today. PostgreSQL joins in step 7. */
export type ConnectionEngine = "mysql" | "mariadb";

export interface ConnectionConfig {
	readonly engine: ConnectionEngine;
	readonly host: string;
	readonly port: number;
	readonly user: string;
	/** Only a reference, "env:HEYDB_NAME"; never the password itself. */
	readonly password: string;
	/** Databases to capture; null captures every database the user can see. */
	readonly databases: readonly string[] | null;
}

export interface Config {
	/** Bumped only when the shape of this file changes incompatibly. */
	readonly formatVersion: 1;
	/** Used when a command names no connection; null when none was chosen. */
	readonly defaultConnection: string | null;
	/** By connection name; names follow the same allow-list as snapshot files. */
	readonly connections: Readonly<Record<string, ConnectionConfig>>;
}
