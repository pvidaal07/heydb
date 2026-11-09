import { Client } from "pg";

import type { Snapshot } from "../../model/snapshot.ts";
import {
	buildSnapshot,
	capturedSchemas,
	type ColumnRow,
	type ForeignKeyColumnRow,
	type IndexColumnRow,
	type RoutineRow,
	type SchemaRow,
	type TableRow,
	type TriggerRow,
} from "./catalog.ts";

// Reads the structure of one PostgreSQL 14+ database through pg_catalog.
// information_schema is not enough: it hides every object the user has no
// privilege on, and lacks enum labels, index methods, expression indexes and
// materialized views. pg_catalog lists everything to everyone.
//
// One query per kind of object for ALL captured schemas at once (= ANY($1)),
// never one per table, like the MySQL engine. The rows go to catalog.ts,
// which builds the snapshot without touching the server.

export interface PostgresConnectionOptions {
	readonly host: string;
	readonly port: number;
	readonly user: string;
	/** The resolved password. Callers resolve secret references before this point. */
	readonly password: string;
	/** The one database to connect to: a PostgreSQL connection never reaches another. */
	readonly database: string;
	/** Schemas to capture; null or omitted captures every non-system schema. */
	readonly schemas?: readonly string[] | null;
	readonly connectTimeoutMs?: number;
	readonly statementTimeoutMs?: number;
}

// Every setting that changes how pg_catalog functions print text the hash
// depends on. A role or a database can set any of them (ALTER ROLE ... SET),
// so heydb pins its own values instead of inheriting them:
// - search_path empty: format_type, pg_get_expr and pg_get_viewdef qualify
//   every name with its schema ("public.orders"), whatever the user's path.
//   pg_catalog is still searched first, so the queries below need no prefix.
// - DateStyle, TimeZone, IntervalStyle, extra_float_digits: how date, time,
//   interval and float constants in defaults and view definitions are printed.
// - default_transaction_read_only: the session cannot write (see connectReadOnly).
const SESSION_SETTINGS: readonly (readonly [string, string])[] = [
	["search_path", ""],
	["DateStyle", "ISO, MDY"],
	["TimeZone", "UTC"],
	["IntervalStyle", "postgres"],
	["extra_float_digits", "1"],
	["default_transaction_read_only", "on"],
];

const RELATION_KINDS = ["r", "p", "f", "v", "m"];

export async function introspectPostgres(options: PostgresConnectionOptions): Promise<Snapshot> {
	const client = await connectReadOnly(options);
	try {
		const capturedAt = new Date().toISOString();
		// One read-only REPEATABLE READ transaction: every query below sees the
		// same moment, so a table created halfway through cannot appear in one
		// list and be missing from another.
		await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
		const version = String((await client.query("SHOW server_version")).rows[0]?.server_version ?? "");
		const database = String((await client.query("SELECT current_database() AS name")).rows[0]?.name ?? "");

		const requestedSchemas = options.schemas ?? null;
		const schemas = (
			await client.query<SchemaRow>(
				`SELECT nspname AS "schemaName", has_schema_privilege(oid, 'USAGE') AS usable FROM pg_namespace`,
			)
		).rows;
		const captured = capturedSchemas(schemas, requestedSchemas);
		const empty = { tables: [], columns: [], indexColumns: [], foreignKeyColumns: [], triggers: [], routines: [] };
		const rows = captured.length === 0 ? empty : await readCatalog(client, captured);
		await client.query("COMMIT");

		return buildSnapshot({ version, capturedAt, database, requestedSchemas, schemas, ...rows });
	} finally {
		await client.end();
	}
}

/**
 * Opens a connection whose session is read-only: INSERT, UPDATE, DDL and
 * CALL of a writing procedure all fail, even for a superuser. A superuser
 * could switch it off again with SET; heydb only ever sends fixed SELECT
 * statements. Defense in depth on top of recommending a read-only role.
 */
export async function connectReadOnly(options: PostgresConnectionOptions): Promise<Client> {
	const client = new Client({
		host: options.host,
		port: options.port,
		user: options.user,
		password: options.password,
		database: options.database,
		connectionTimeoutMillis: options.connectTimeoutMs ?? 10_000,
		application_name: "heydb",
	});
	try {
		await client.connect();
	} catch (error) {
		// A failed connect may still hold a socket; ending it lets the process exit.
		await client.end().catch(() => {});
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(
			`postgresql: cannot connect to ${options.host}:${options.port} as ${options.user} (database "${options.database}"): ${reason}`,
			{ cause: error },
		);
	}
	try {
		const settings = [...SESSION_SETTINGS, ["statement_timeout", String(options.statementTimeoutMs ?? 60_000)] as const];
		// set_config(name, value, false) is SET for the whole session, with the values bound as parameters.
		// Qualified, because this one statement still runs under the role's own search_path.
		const calls = settings.map((_, index) => `pg_catalog.set_config($${index * 2 + 1}, $${index * 2 + 2}, false)`);
		await client.query(`SELECT ${calls.join(", ")}`, settings.flat());
	} catch (error) {
		// Never leave a half-configured connection open: it would keep the process alive.
		await client.end().catch(() => {});
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`postgresql: cannot open a read-only session on ${options.host}:${options.port}: ${reason}`, {
			cause: error,
		});
	}
	return client;
}

async function readCatalog(client: Client, schemas: readonly string[]) {
	// Every query takes the captured schemas as $1 (a text[]) and, where it
	// needs them, the relation kinds heydb lists as $2; nothing is interpolated.
	const select = async <T>(sql: string, ...more: unknown[]): Promise<T[]> =>
		(await client.query(sql, [schemas, ...more])).rows as T[];

	// One after another, never with Promise.all: a pg client runs one query at
	// a time anyway, and queueing a second one while the first runs is
	// deprecated (pg 8 warns; pg 9 will refuse it).
	//
	// Partitions are left out (NOT relispartition): the partitioned table is
	// the object people query, and listing each partition would repeat it.
	const tables = await select<TableRow>(
		`
		SELECT n.nspname AS "schemaName", c.relname AS "tableName", c.relkind::text AS relkind,
		       c.reltuples AS reltuples,
		       CASE WHEN c.relkind = 'p' THEN (
		         SELECT sum(part.reltuples) FROM pg_partition_tree(c.oid) tree
		         JOIN pg_class part ON part.oid = tree.relid
		         WHERE tree.isleaf AND part.reltuples >= 0
		       ) END AS "partitionRows",
		       obj_description(c.oid, 'pg_class') AS comment,
		       CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid, true) END AS "viewDefinition"
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = ANY($1) AND c.relkind = ANY($2) AND NOT c.relispartition`,
		RELATION_KINDS,
	);

	// The collation is reported only when it differs from the type's own,
	// i.e. when the column sets one explicitly.
	const columns = await select<ColumnRow>(
		`
		SELECT n.nspname AS "schemaName", c.relname AS "tableName", a.attname AS "columnName",
		       a.attnum AS position, format_type(a.atttypid, a.atttypmod) AS "dataType",
		       a.attnotnull AS "notNull", pg_get_expr(d.adbin, d.adrelid) AS "defaultExpression",
		       a.attidentity::text AS identity, a.attgenerated::text AS generated,
		       col_description(c.oid, a.attnum) AS comment,
		       CASE WHEN a.attcollation <> t.typcollation THEN co.collname::text END AS collation,
		       CASE WHEN t.typtype = 'e' THEN ARRAY(
		         SELECT e.enumlabel::text FROM pg_enum e WHERE e.enumtypid = t.oid ORDER BY e.enumsortorder
		       ) END AS "enumLabels"
		FROM pg_attribute a
		JOIN pg_class c ON c.oid = a.attrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		JOIN pg_type t ON t.oid = a.atttypid
		LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
		LEFT JOIN pg_collation co ON co.oid = a.attcollation
		WHERE n.nspname = ANY($1) AND c.relkind = ANY($2) AND NOT c.relispartition
		  AND a.attnum > 0 AND NOT a.attisdropped`,
		RELATION_KINDS,
	);

	// indkey is 0-based and holds 0 for an expression part, whose text
	// pg_get_indexdef prints. Only key columns, not INCLUDE ones.
	const indexColumns = await select<IndexColumnRow>(`
		SELECT n.nspname AS "schemaName", c.relname AS "tableName", ic.relname AS "indexName",
		       x.indisprimary AS "primary", x.indisunique AS "unique", am.amname AS method,
		       k.ord::int AS position,
		       CASE WHEN x.indkey[k.ord - 1] = 0 THEN pg_get_indexdef(x.indexrelid, k.ord::int, true)
		            ELSE a.attname::text END AS "columnName"
		FROM pg_index x
		JOIN pg_class c ON c.oid = x.indrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		JOIN pg_class ic ON ic.oid = x.indexrelid
		JOIN pg_am am ON am.oid = ic.relam
		CROSS JOIN LATERAL generate_series(1, x.indnkeyatts) AS k(ord)
		LEFT JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = x.indkey[k.ord - 1]
		WHERE n.nspname = ANY($1) AND NOT c.relispartition`);

	// conkey and confkey pair up position by position. A foreign key to a
	// partitioned table also gets one clone per partition (conparentid <> 0).
	const foreignKeyColumns = await select<ForeignKeyColumnRow>(`
		SELECT n.nspname AS "schemaName", c.relname AS "tableName", con.conname AS "constraintName",
		       k.ord::int AS position, a.attname AS "columnName",
		       rn.nspname AS "referencedSchema", rc.relname AS "referencedTable", ra.attname AS "referencedColumn",
		       con.confupdtype::text AS "updateRule", con.confdeltype::text AS "deleteRule"
		FROM pg_constraint con
		JOIN pg_class c ON c.oid = con.conrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		JOIN pg_class rc ON rc.oid = con.confrelid
		JOIN pg_namespace rn ON rn.oid = rc.relnamespace
		CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(attnum, refattnum, ord)
		JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
		JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.refattnum
		WHERE n.nspname = ANY($1) AND con.contype = 'f' AND con.conparentid = 0 AND NOT c.relispartition`);

	// Internal triggers are the ones PostgreSQL creates to enforce foreign keys.
	const triggers = await select<TriggerRow>(`
		SELECT n.nspname AS "schemaName", c.relname AS "tableName", t.tgname AS "triggerName", t.tgtype AS type
		FROM pg_trigger t
		JOIN pg_class c ON c.oid = t.tgrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = ANY($1) AND NOT t.tgisinternal AND NOT c.relispartition`);

	// Functions that belong to an extension (citext, PostGIS…) are part of
	// that extension, not of the application's schema: PostGIS alone adds
	// hundreds. pg_depend records them with deptype 'e'.
	const routines = await select<RoutineRow>(`
		SELECT n.nspname AS "schemaName", p.proname AS "routineName", p.prokind::text AS kind
		FROM pg_proc p
		JOIN pg_namespace n ON n.oid = p.pronamespace
		WHERE n.nspname = ANY($1)
		  AND NOT EXISTS (
		    SELECT 1 FROM pg_depend dep
		    WHERE dep.classid = 'pg_proc'::regclass AND dep.objid = p.oid AND dep.deptype = 'e'
		  )`);

	return { tables, columns, indexColumns, foreignKeyColumns, triggers, routines };
}
