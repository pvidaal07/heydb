import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";

import type { Snapshot } from "../../model/snapshot.ts";
import {
	attachForeignKeyRules,
	buildSnapshot,
	type ColumnRow,
	type ForeignKeyKeyColumnRow,
	type ForeignKeyRuleRow,
	type IndexColumnRow,
	type PrivilegeRow,
	type RoutineRow,
	type TableRow,
	type TriggerRow,
	type ViewRow,
} from "./catalog.ts";

// Reads the structure of a MySQL or MariaDB server through INFORMATION_SCHEMA.
// One query per kind of object for ALL captured databases at once (never one
// query per table), so the cost grows with the number of object kinds, not
// with the number of tables. The rows go to catalog.ts, which builds the
// snapshot without touching the server.
//
// Every query reads ONE INFORMATION_SCHEMA view. A statement that names two
// (a JOIN, or a UNION of both) can make MariaDB scan the second one without
// the database filter, opening every table of every database on the server:
// on a shared server the sync hangs for minutes. Rows are combined in code.
// tests/engines/mysql-introspect-sql.test.ts enforces it.
//
// Every query also has a time limit (statementTimeoutMs): when a query takes
// longer, heydb closes the connection and fails naming what it was reading,
// instead of waiting forever.

export interface MysqlConnectionOptions {
	readonly host: string;
	readonly port: number;
	readonly user: string;
	/** The resolved password. Callers resolve secret references before this point. */
	readonly password: string;
	/** Databases to capture; null or omitted captures every visible user database. */
	readonly databases?: readonly string[] | null;
	readonly connectTimeoutMs?: number;
	/** Time limit for each query; default 60 s. */
	readonly statementTimeoutMs?: number;
}

const DEFAULT_STATEMENT_TIMEOUT_MS = 60_000;

/** What TimedSession needs from a mysql2 connection; tests pass a fake. */
export interface QueryableConnection {
	query(options: { sql: string; timeout: number; values?: unknown[] }): Promise<[unknown, unknown]>;
	destroy(): void;
}

/** A query took longer than statementTimeoutMs; the connection is already closed. */
export class MysqlTimeoutError extends Error {}

/**
 * Runs queries with a time limit. mysql2 only stops waiting when the limit is
 * hit (the query keeps running on the server and late packets would still
 * arrive), so the connection is destroyed: no socket keeps the process alive.
 */
export class TimedSession {
	#destroyed = false;
	readonly #connection: QueryableConnection;
	readonly #where: string;
	readonly #timeoutMs: number;

	constructor(connection: QueryableConnection, where: string, timeoutMs: number) {
		this.#connection = connection;
		this.#where = where;
		this.#timeoutMs = timeoutMs;
	}

	/** True once a timeout closed the connection: do not end() it again. */
	get destroyed(): boolean {
		return this.#destroyed;
	}

	/** Runs one query; `step` says what it reads, e.g. "foreign keys", for the timeout error. */
	async select<T>(step: string, sql: string, values?: unknown[]): Promise<T[]> {
		try {
			const [rows] = await this.#connection.query({ sql, timeout: this.#timeoutMs, ...(values ? { values } : {}) });
			return rows as T[];
		} catch (error) {
			if ((error as { code?: unknown } | null)?.code !== "PROTOCOL_SEQUENCE_TIMEOUT") throw error;
			if (!this.#destroyed) {
				this.#destroyed = true;
				this.#connection.destroy();
			}
			throw new MysqlTimeoutError(
				`mysql: reading ${step} on ${this.#where} took longer than ${formatSeconds(this.#timeoutMs)}; ` +
					"the server did not answer in time (it may be overloaded, or scanning every database on a shared server)",
				{ cause: error },
			);
		}
	}
}

function formatSeconds(ms: number): string {
	return `${Number((ms / 1000).toFixed(3))} s`;
}

function sessionFor(connection: Connection, options: MysqlConnectionOptions): TimedSession {
	return new TimedSession(
		connection,
		`${options.host}:${options.port}`,
		options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
	);
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
	const session = sessionFor(connection, options);
	try {
		const capturedAt = new Date().toISOString();
		const versionRows = await session.select<RowDataPacket>("the server version", "SELECT VERSION() AS version");
		const version = String(versionRows[0]?.version ?? "");

		const requested = options.databases ?? null;
		const visible = await visibleDatabases(session);
		const databases = requested === null ? visible : visible.filter((name) => requested.includes(name));

		const empty = {
			tables: [],
			columns: [],
			indexColumns: [],
			foreignKeyColumns: [],
			triggers: [],
			routines: [],
			views: [],
			privileges: [],
		};
		const rows = databases.length === 0 ? empty : await readCatalog(session, databases);

		return buildSnapshot({ version, capturedAt, requestedDatabases: requested, databases, ...rows });
	} finally {
		if (!session.destroyed) await connection.end();
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
		const session = sessionFor(connection, options);
		await session.select("the session setup (sql_mode)", "SET SESSION sql_mode = ''");
		await session.select("the session setup (read only)", "SET SESSION TRANSACTION READ ONLY");
	} catch (error) {
		// A timeout already closed the connection and names its step.
		if (error instanceof MysqlTimeoutError) throw error;
		// Never leave a half-configured connection open: it would keep the process alive.
		connection.destroy();
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`mysql: cannot open a read-only session on ${options.host}:${options.port}: ${reason}`, {
			cause: error,
		});
	}
	return connection;
}

async function visibleDatabases(session: TimedSession): Promise<string[]> {
	const rows = await session.select<RowDataPacket>(
		"the list of databases",
		"SELECT SCHEMA_NAME AS name FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME NOT IN (?) ORDER BY SCHEMA_NAME",
		[SYSTEM_DATABASES],
	);
	return rows.map((row) => String(row.name));
}

async function readCatalog(session: TimedSession, databases: readonly string[]) {
	// mysql2 expands an array bound to "IN (?)" into a list of escaped values.
	const select = <T>(step: string, sql: string): Promise<T[]> => session.select<T>(step, sql, [databases]);

	// One after another: a connection runs one query at a time anyway, and a
	// queued query must not start its time limit before the previous one ends.
	const tables = await select<TableRow>("tables", `
			SELECT TABLE_SCHEMA AS databaseName, TABLE_NAME AS tableName, TABLE_TYPE AS tableType,
			       ENGINE AS storageEngine, TABLE_ROWS AS tableRows, TABLE_COMMENT AS tableComment
			FROM INFORMATION_SCHEMA.TABLES
			WHERE TABLE_SCHEMA IN (?)`);
	const columns = await select<ColumnRow>("columns", `
			SELECT TABLE_SCHEMA AS databaseName, TABLE_NAME AS tableName, COLUMN_NAME AS columnName,
			       ORDINAL_POSITION AS position, COLUMN_TYPE AS columnType, IS_NULLABLE AS isNullable,
			       COLUMN_DEFAULT AS columnDefault, COLUMN_COMMENT AS columnComment, EXTRA AS extra,
			       COLLATION_NAME AS collation, GENERATION_EXPRESSION AS generationExpression
			FROM INFORMATION_SCHEMA.COLUMNS
			WHERE TABLE_SCHEMA IN (?)`);
	const indexColumns = await select<IndexColumnRow>("indexes", `
			SELECT TABLE_SCHEMA AS databaseName, TABLE_NAME AS tableName, INDEX_NAME AS indexName,
			       SEQ_IN_INDEX AS sequence, COLUMN_NAME AS columnName, NON_UNIQUE AS nonUnique,
			       INDEX_TYPE AS indexType
			FROM INFORMATION_SCHEMA.STATISTICS
			WHERE TABLE_SCHEMA IN (?)`);
	const foreignKeyKeyColumns = await select<ForeignKeyKeyColumnRow>("foreign keys", `
			SELECT TABLE_SCHEMA AS databaseName, TABLE_NAME AS tableName, CONSTRAINT_NAME AS constraintName,
			       ORDINAL_POSITION AS position, COLUMN_NAME AS columnName,
			       REFERENCED_TABLE_SCHEMA AS referencedDatabase, REFERENCED_TABLE_NAME AS referencedTable,
			       REFERENCED_COLUMN_NAME AS referencedColumn
			FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
			WHERE TABLE_SCHEMA IN (?) AND REFERENCED_TABLE_NAME IS NOT NULL`);
	// A foreign key lives in the database of its table, so CONSTRAINT_SCHEMA is that database.
	const foreignKeyRules = await select<ForeignKeyRuleRow>("foreign key rules", `
			SELECT CONSTRAINT_SCHEMA AS databaseName, TABLE_NAME AS tableName, CONSTRAINT_NAME AS constraintName,
			       UPDATE_RULE AS updateRule, DELETE_RULE AS deleteRule
			FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS
			WHERE CONSTRAINT_SCHEMA IN (?)`);
	const triggers = await select<TriggerRow>("triggers", `
			SELECT EVENT_OBJECT_SCHEMA AS databaseName, EVENT_OBJECT_TABLE AS tableName,
			       TRIGGER_NAME AS triggerName, ACTION_TIMING AS timing, EVENT_MANIPULATION AS event
			FROM INFORMATION_SCHEMA.TRIGGERS
			WHERE EVENT_OBJECT_SCHEMA IN (?)`);
	const routines = await select<RoutineRow>("routines", `
			SELECT ROUTINE_SCHEMA AS databaseName, ROUTINE_NAME AS routineName, ROUTINE_TYPE AS routineType
			FROM INFORMATION_SCHEMA.ROUTINES
			WHERE ROUTINE_SCHEMA IN (?)`);
	const views = await select<ViewRow>("views", `
			SELECT TABLE_SCHEMA AS databaseName, TABLE_NAME AS tableName, VIEW_DEFINITION AS viewDefinition
			FROM INFORMATION_SCHEMA.VIEWS
			WHERE TABLE_SCHEMA IN (?)`);
	// For a non-admin user both views list only that user's own privileges.
	const globalPrivileges = await session.select<PrivilegeRow>("global privileges", `
			SELECT NULL AS databaseName, PRIVILEGE_TYPE AS privilege
			FROM INFORMATION_SCHEMA.USER_PRIVILEGES
			WHERE GRANTEE = ${CURRENT_GRANTEE}`);
	const databasePrivileges = await select<PrivilegeRow>("database privileges", `
			SELECT TABLE_SCHEMA AS databaseName, PRIVILEGE_TYPE AS privilege
			FROM INFORMATION_SCHEMA.SCHEMA_PRIVILEGES
			WHERE GRANTEE = ${CURRENT_GRANTEE} AND TABLE_SCHEMA IN (?)`);

	return {
		tables,
		columns,
		indexColumns,
		foreignKeyColumns: attachForeignKeyRules(foreignKeyKeyColumns, foreignKeyRules),
		triggers,
		routines,
		views,
		privileges: [...globalPrivileges, ...databasePrivileges],
	};
}
