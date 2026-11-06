import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";

import type { Snapshot } from "../../model/snapshot.ts";
import {
	buildSnapshot,
	type ColumnRow,
	type ForeignKeyColumnRow,
	type IndexColumnRow,
	type PrivilegeRow,
	type RoutineRow,
	type TableRow,
	type TriggerRow,
} from "./catalog.ts";

// Reads the structure of a MySQL or MariaDB server through INFORMATION_SCHEMA.
// One query per kind of object for ALL captured databases at once (never one
// query per table), so the cost grows with the number of object kinds, not
// with the number of tables. The rows go to catalog.ts, which builds the
// snapshot without touching the server.

export interface MysqlConnectionOptions {
	readonly host: string;
	readonly port: number;
	readonly user: string;
	/** The resolved password. Callers resolve secret references before this point. */
	readonly password: string;
	/** Databases to capture; null or omitted captures every visible user database. */
	readonly databases?: readonly string[] | null;
	readonly connectTimeoutMs?: number;
}

const SYSTEM_DATABASES = ["information_schema", "mysql", "performance_schema", "sys"];

// GRANTEE looks like 'user'@'host'. An admin sees every user's privileges, so
// filter to the account this session is authenticated as. CHAR(39) is a single
// quote: writing it as "'" would break on servers running with ANSI_QUOTES,
// where double quotes delimit names, not text.
const CURRENT_GRANTEE =
	"CONCAT(CHAR(39), SUBSTRING_INDEX(CURRENT_USER(), '@', 1), CHAR(39), '@', CHAR(39), SUBSTRING_INDEX(CURRENT_USER(), '@', -1), CHAR(39))";

export async function introspectMysql(options: MysqlConnectionOptions): Promise<Snapshot> {
	const connection = await connectReadOnly(options);
	try {
		const capturedAt = new Date().toISOString();
		const [versionRows] = await connection.query<RowDataPacket[]>("SELECT VERSION() AS version");
		const version = String(versionRows[0]?.version ?? "");

		const requested = options.databases ?? null;
		const visible = await visibleDatabases(connection);
		const databases = requested === null ? visible : visible.filter((name) => requested.includes(name));

		const empty = { tables: [], columns: [], indexColumns: [], foreignKeyColumns: [], triggers: [], routines: [], privileges: [] };
		const rows = databases.length === 0 ? empty : await readCatalog(connection, databases);

		return buildSnapshot({ version, capturedAt, requestedDatabases: requested, databases, ...rows });
	} finally {
		await connection.end();
	}
}

/**
 * Opens a connection whose session is READ ONLY: even a user with write
 * privileges cannot change data or tables through it (INSERT, UPDATE, DROP,
 * CALL of a writing procedure all fail). It does not block SET GLOBAL; heydb
 * only ever sends fixed SELECT statements. Defense in depth on top of
 * recommending a read-only database user.
 */
export async function connectReadOnly(options: MysqlConnectionOptions): Promise<Connection> {
	let connection: Connection;
	try {
		connection = await mysql.createConnection({
			host: options.host,
			port: options.port,
			user: options.user,
			password: options.password,
			connectTimeout: options.connectTimeoutMs ?? 10_000,
			multipleStatements: false,
			supportBigNumbers: true,
		});
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`mysql: cannot connect to ${options.host}:${options.port} as ${options.user}: ${reason}`, {
			cause: error,
		});
	}
	try {
		// A neutral sql_mode makes the output independent of how the server is
		// configured: MariaDB prints generated-column expressions with " instead of `
		// under ANSI_QUOTES, and NO_BACKSLASH_ESCAPES would break the driver's escaping
		// of query parameters. It only affects this session.
		await connection.query("SET SESSION sql_mode = ''");
		await connection.query("SET SESSION TRANSACTION READ ONLY");
	} catch (error) {
		// Never leave a half-configured connection open: it would keep the process alive.
		connection.destroy();
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`mysql: cannot open a read-only session on ${options.host}:${options.port}: ${reason}`, {
			cause: error,
		});
	}
	return connection;
}

async function visibleDatabases(connection: Connection): Promise<string[]> {
	const [rows] = await connection.query<RowDataPacket[]>(
		"SELECT SCHEMA_NAME AS name FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME NOT IN (?) ORDER BY SCHEMA_NAME",
		[SYSTEM_DATABASES],
	);
	return rows.map((row) => String(row.name));
}

async function readCatalog(connection: Connection, databases: readonly string[]) {
	// mysql2 expands an array bound to "IN (?)" into a list of escaped values.
	const select = async <T>(sql: string): Promise<T[]> => {
		const [rows] = await connection.query<RowDataPacket[]>(sql, [databases]);
		return rows as unknown as T[];
	};

	// One connection runs these one after another; Promise.all just waits for all of them.
	const [tables, columns, indexColumns, foreignKeyColumns, triggers, routines, privileges] = await Promise.all([
		select<TableRow>(`
			SELECT TABLE_SCHEMA AS databaseName, TABLE_NAME AS tableName, TABLE_TYPE AS tableType,
			       ENGINE AS storageEngine, TABLE_ROWS AS tableRows, TABLE_COMMENT AS tableComment
			FROM INFORMATION_SCHEMA.TABLES
			WHERE TABLE_SCHEMA IN (?)`),
		select<ColumnRow>(`
			SELECT TABLE_SCHEMA AS databaseName, TABLE_NAME AS tableName, COLUMN_NAME AS columnName,
			       ORDINAL_POSITION AS position, COLUMN_TYPE AS columnType, IS_NULLABLE AS isNullable,
			       COLUMN_DEFAULT AS columnDefault, COLUMN_COMMENT AS columnComment, EXTRA AS extra,
			       COLLATION_NAME AS collation, GENERATION_EXPRESSION AS generationExpression
			FROM INFORMATION_SCHEMA.COLUMNS
			WHERE TABLE_SCHEMA IN (?)`),
		select<IndexColumnRow>(`
			SELECT TABLE_SCHEMA AS databaseName, TABLE_NAME AS tableName, INDEX_NAME AS indexName,
			       SEQ_IN_INDEX AS sequence, COLUMN_NAME AS columnName, NON_UNIQUE AS nonUnique,
			       INDEX_TYPE AS indexType
			FROM INFORMATION_SCHEMA.STATISTICS
			WHERE TABLE_SCHEMA IN (?)`),
		select<ForeignKeyColumnRow>(`
			SELECT k.TABLE_SCHEMA AS databaseName, k.TABLE_NAME AS tableName, k.CONSTRAINT_NAME AS constraintName,
			       k.ORDINAL_POSITION AS position, k.COLUMN_NAME AS columnName,
			       k.REFERENCED_TABLE_SCHEMA AS referencedDatabase, k.REFERENCED_TABLE_NAME AS referencedTable,
			       k.REFERENCED_COLUMN_NAME AS referencedColumn,
			       r.UPDATE_RULE AS updateRule, r.DELETE_RULE AS deleteRule
			FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
			JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS r
			  ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
			 AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
			 AND r.TABLE_NAME = k.TABLE_NAME
			WHERE k.TABLE_SCHEMA IN (?) AND k.REFERENCED_TABLE_NAME IS NOT NULL`),
		select<TriggerRow>(`
			SELECT EVENT_OBJECT_SCHEMA AS databaseName, EVENT_OBJECT_TABLE AS tableName,
			       TRIGGER_NAME AS triggerName, ACTION_TIMING AS timing, EVENT_MANIPULATION AS event
			FROM INFORMATION_SCHEMA.TRIGGERS
			WHERE EVENT_OBJECT_SCHEMA IN (?)`),
		select<RoutineRow>(`
			SELECT ROUTINE_SCHEMA AS databaseName, ROUTINE_NAME AS routineName, ROUTINE_TYPE AS routineType
			FROM INFORMATION_SCHEMA.ROUTINES
			WHERE ROUTINE_SCHEMA IN (?)`),
		// For a non-admin user both views list only that user's own privileges.
		select<PrivilegeRow>(`
			SELECT NULL AS databaseName, PRIVILEGE_TYPE AS privilege
			FROM INFORMATION_SCHEMA.USER_PRIVILEGES
			WHERE GRANTEE = ${CURRENT_GRANTEE}
			UNION ALL
			SELECT TABLE_SCHEMA AS databaseName, PRIVILEGE_TYPE AS privilege
			FROM INFORMATION_SCHEMA.SCHEMA_PRIVILEGES
			WHERE GRANTEE = ${CURRENT_GRANTEE} AND TABLE_SCHEMA IN (?)`),
	]);

	return { tables, columns, indexColumns, foreignKeyColumns, triggers, routines, privileges };
}
