import { formatName } from "../../model/names.ts";
import { sortSnapshot } from "../../model/order.ts";
import type {
	Column,
	ForeignKey,
	Index,
	ReferentialAction,
	Routine,
	Schema,
	Snapshot,
	Table,
	Trigger,
	Warning,
} from "../../model/snapshot.ts";

// Pure translation from PostgreSQL catalog rows to a Snapshot, like
// lib/engines/mysql/catalog.ts: introspect.ts runs the queries and hands the
// rows here, so every rule below is tested with hand-written rows.
//
// PostgreSQL has three levels, database → schema → table, and a connection
// only ever reaches the database it was opened on. So a PostgreSQL snapshot
// has exactly one Database (the connected one) with one Schema per captured
// schema, and every foreign key points inside that same database.
//
// Row field names match the aliases used in introspect.ts queries.

export interface PostgresCatalog {
	/** Result of SHOW server_version, e.g. "16.4 (Debian 16.4-1.pgdg120+1)". */
	readonly version: string;
	readonly capturedAt: string;
	/** The database the connection is on: the only one a snapshot can describe. */
	readonly database: string;
	/** Schemas the caller asked for; null means "every non-system schema". */
	readonly requestedSchemas: readonly string[] | null;
	/** Every schema of the database, system ones included. */
	readonly schemas: readonly SchemaRow[];
	readonly tables: readonly TableRow[];
	readonly columns: readonly ColumnRow[];
	readonly indexColumns: readonly IndexColumnRow[];
	readonly foreignKeyColumns: readonly ForeignKeyColumnRow[];
	readonly triggers: readonly TriggerRow[];
	readonly routines: readonly RoutineRow[];
}

export interface SchemaRow {
	readonly schemaName: string;
	/** has_schema_privilege(..., 'USAGE'): without it no table of the schema can be queried. */
	readonly usable: boolean;
}

export interface TableRow {
	readonly schemaName: string;
	readonly tableName: string;
	/** pg_class.relkind: r table, p partitioned table, f foreign table, v view, m materialized view. */
	readonly relkind: string;
	/** pg_class.reltuples: an estimate, -1 when the table was never analyzed (PostgreSQL 14+). */
	readonly reltuples: number | string;
	/** Sum of the known estimates of a partitioned table's partitions; null when none is known. */
	readonly partitionRows: number | string | null;
	readonly comment: string | null;
	/** pg_get_viewdef for views and materialized views; null for anything else. */
	readonly viewDefinition: string | null;
}

export interface ColumnRow {
	readonly schemaName: string;
	readonly tableName: string;
	readonly columnName: string;
	readonly position: number;
	/** format_type(): schema-qualified when the type is not in pg_catalog, e.g. "public.order_status". */
	readonly dataType: string;
	readonly notNull: boolean;
	/** pg_get_expr of the default, or of the expression of a generated column. */
	readonly defaultExpression: string | null;
	/** pg_attribute.attidentity: "a" ALWAYS, "d" BY DEFAULT, "" not an identity column. */
	readonly identity: string;
	/** pg_attribute.attgenerated: "s" stored, "v" virtual (PostgreSQL 18), "" not generated. */
	readonly generated: string;
	readonly comment: string | null;
	/** Only when it differs from the type's default collation, i.e. set explicitly. */
	readonly collation: string | null;
	/** Labels of an enum type in their declared order; null for any other type. */
	readonly enumLabels: readonly string[] | null;
}

export interface IndexColumnRow {
	readonly schemaName: string;
	readonly tableName: string;
	readonly indexName: string;
	readonly primary: boolean;
	readonly unique: boolean;
	/** Access method from pg_am: btree, hash, gin, gist… */
	readonly method: string;
	/** 1-based position in the index key (INCLUDE columns are not part of the key). */
	readonly position: number;
	/** The column name, or the expression text for an expression index part. */
	readonly columnName: string;
}

export interface ForeignKeyColumnRow {
	readonly schemaName: string;
	readonly tableName: string;
	readonly constraintName: string;
	readonly position: number;
	readonly columnName: string;
	readonly referencedSchema: string;
	readonly referencedTable: string;
	readonly referencedColumn: string;
	/** pg_constraint.confupdtype / confdeltype: one letter, see FOREIGN_KEY_ACTIONS. */
	readonly updateRule: string;
	readonly deleteRule: string;
}

export interface TriggerRow {
	readonly schemaName: string;
	readonly tableName: string;
	readonly triggerName: string;
	/** pg_trigger.tgtype: a bit set, see TRIGGER_TYPE. */
	readonly type: number;
}

export interface RoutineRow {
	readonly schemaName: string;
	readonly routineName: string;
	/** pg_proc.prokind: f function, p procedure, a aggregate, w window function. */
	readonly kind: string;
}

const SYSTEM_SCHEMAS = ["pg_catalog", "information_schema", "pg_toast"];
// Every session gets its own pg_temp_N and pg_toast_temp_N for temporary tables.
const TEMPORARY_SCHEMA = /^pg_(toast_)?temp_\d+$/;

const FOREIGN_KEY_ACTIONS: Readonly<Record<string, ReferentialAction>> = {
	a: "NO ACTION",
	r: "RESTRICT",
	c: "CASCADE",
	n: "SET NULL",
	d: "SET DEFAULT",
};

// The bits of pg_trigger.tgtype (src/include/catalog/pg_trigger.h). ROW (1)
// says row or statement level, which the model does not record.
const TRIGGER_TYPE = { before: 2, insert: 4, delete: 8, update: 16, truncate: 32, instead: 64 } as const;

// Aggregates and window functions live in pg_proc too, but they are not
// something a person calls like a function or a procedure, so they are left out.
const ROUTINE_KINDS: Readonly<Record<string, Routine["kind"]>> = { f: "function", p: "procedure" };

/**
 * The schemas to capture, sorted: the requested ones that exist (names match
 * exactly, as PostgreSQL identifiers are case-sensitive), or every schema but
 * the system ones when none was requested.
 */
export function capturedSchemas(schemas: readonly SchemaRow[], requested: readonly string[] | null): string[] {
	const names = schemas.map((row) => row.schemaName);
	const chosen = requested === null ? names.filter((name) => !isSystemSchema(name)) : names.filter((name) => requested.includes(name));
	return [...new Set(chosen)].sort(compareText);
}

export function buildSnapshot(catalog: PostgresCatalog): Snapshot {
	const { database } = catalog;
	const captured = capturedSchemas(catalog.schemas, catalog.requestedSchemas);
	const capturedSet = new Set(captured);
	const inCapturedSchema = (row: { schemaName: string }) => capturedSet.has(row.schemaName);

	// Group every kind of row by its table once, so building each table is a lookup.
	const columnsByTable = groupBy(catalog.columns.filter(inCapturedSchema), tableKey);
	const indexesByTable = groupBy(catalog.indexColumns.filter(inCapturedSchema), tableKey);
	const foreignKeysByTable = groupBy(catalog.foreignKeyColumns.filter(inCapturedSchema), tableKey);
	const triggersByTable = groupBy(catalog.triggers.filter(inCapturedSchema), tableKey);
	const tablesBySchema = groupBy(catalog.tables.filter(inCapturedSchema), (row) => row.schemaName);
	const routinesBySchema = groupBy(catalog.routines.filter(inCapturedSchema), (row) => row.schemaName);

	const schemas: Schema[] = captured.map((name) => ({
		name,
		tables: (tablesBySchema.get(name) ?? []).map((row) => {
			const key = tableKey(row);
			return buildTable(
				database,
				row,
				columnsByTable.get(key) ?? [],
				indexesByTable.get(key) ?? [],
				foreignKeysByTable.get(key) ?? [],
				triggersByTable.get(key) ?? [],
			);
		}),
		routines: buildRoutines(routinesBySchema.get(name) ?? []),
	}));

	// Return the canonical order so every consumer sees the same snapshot,
	// whatever order the server returned the rows in.
	return sortSnapshot({
		formatVersion: 1,
		engine: { kind: "postgresql", version: catalog.version },
		capturedAt: catalog.capturedAt,
		databases: [{ name: database, schemas }],
		warnings: [
			...missingSchemaWarnings(database, catalog.requestedSchemas, catalog.schemas),
			...unusableSchemaWarnings(database, catalog.schemas, capturedSet),
			...hiddenViewDefinitionWarnings(database, schemas),
		],
	});
}

function buildTable(
	database: string,
	row: TableRow,
	columnRows: readonly ColumnRow[],
	indexRows: readonly IndexColumnRow[],
	foreignKeyRows: readonly ForeignKeyColumnRow[],
	triggerRows: readonly TriggerRow[],
): Table {
	// A materialized view is stored like a table (it has rows and indexes) but
	// is defined by a SELECT, which is what a reader needs to know: the model
	// has no separate kind for it, so it is a view with its definition.
	const isView = row.relkind === "v" || row.relkind === "m";
	return {
		name: row.tableName,
		kind: isView ? "view" : "table",
		comment: row.comment ?? "",
		storageEngine: null,
		rowEstimate: rowEstimate(row),
		columns: [...columnRows].sort((a, b) => a.position - b.position).map(buildColumn),
		primaryKey: indexColumns(indexRows.filter((r) => r.primary)),
		indexes: buildIndexes(indexRows.filter((r) => !r.primary)),
		foreignKeys: buildForeignKeys(database, foreignKeyRows),
		triggers: triggerRows.map(buildTrigger),
		viewDefinition: isView ? row.viewDefinition : null,
	};
}

function rowEstimate(row: TableRow): number | null {
	if (row.relkind === "v") return null;
	const estimate = Number(row.reltuples);
	if (estimate >= 0) return Math.round(estimate);
	// A partitioned table holds no rows itself; until it is analyzed, the sum of
	// its partitions is the best estimate there is.
	if (row.relkind === "p" && row.partitionRows !== null) return Math.round(Number(row.partitionRows));
	return null;
}

function buildColumn(row: ColumnRow): Column {
	const generated = row.generated === "s" || row.generated === "v";
	const identity = row.identity === "a" ? "ALWAYS" : row.identity === "d" ? "BY DEFAULT" : null;
	return {
		name: row.columnName,
		position: row.position,
		type: row.enumLabels === null ? row.dataType : `${row.dataType} enum(${row.enumLabels.map(sqlText).join(",")})`,
		nullable: !row.notNull,
		// An identity column has no pg_attrdef row; its default is the identity
		// itself, written as the DDL says it, so ALWAYS and BY DEFAULT differ.
		default: generated ? null : identity !== null ? `GENERATED ${identity} AS IDENTITY` : row.defaultExpression,
		comment: row.comment ?? "",
		// serial and bigserial are a sequence default, the pre-identity idiom.
		autoIncrement: identity !== null || (row.defaultExpression?.startsWith("nextval(") ?? false),
		generated: generated ? { expression: row.defaultExpression ?? "", stored: row.generated === "s" } : null,
		collation: row.collation,
	};
}

function buildIndexes(rows: readonly IndexColumnRow[]): Index[] {
	return [...groupBy(rows, (r) => r.indexName)].map(([name, parts]) => {
		const first = parts[0]!; // groupBy never creates empty groups
		return { name, columns: indexColumns(parts), unique: first.unique, method: first.method };
	});
}

function indexColumns(rows: readonly IndexColumnRow[]): string[] {
	return [...rows].sort((a, b) => Number(a.position) - Number(b.position)).map((r) => r.columnName);
}

function buildForeignKeys(database: string, rows: readonly ForeignKeyColumnRow[]): ForeignKey[] {
	return [...groupBy(rows, (r) => r.constraintName)].map(([name, parts]) => {
		const sorted = [...parts].sort((a, b) => Number(a.position) - Number(b.position));
		const first = sorted[0]!;
		const where = `${database}.${first.schemaName}.${first.tableName}.${name}`;
		return {
			name,
			columns: sorted.map((r) => r.columnName),
			references: {
				database,
				schema: first.referencedSchema,
				table: first.referencedTable,
				columns: sorted.map((r) => r.referencedColumn),
			},
			onDelete: foreignKeyAction(first.deleteRule, where),
			onUpdate: foreignKeyAction(first.updateRule, where),
		};
	});
}

function foreignKeyAction(code: string, where: string): ReferentialAction {
	const action = FOREIGN_KEY_ACTIONS[code];
	if (action === undefined) throw new Error(`unknown foreign key action "${code}" on ${where}`);
	return action;
}

function buildTrigger(row: TriggerRow): Trigger {
	const type = Number(row.type);
	const has = (bit: number) => (type & bit) !== 0;
	const events: Trigger["events"][number][] = [];
	if (has(TRIGGER_TYPE.insert)) events.push("INSERT");
	if (has(TRIGGER_TYPE.update)) events.push("UPDATE");
	if (has(TRIGGER_TYPE.delete)) events.push("DELETE");
	if (has(TRIGGER_TYPE.truncate)) events.push("TRUNCATE");
	return {
		name: row.triggerName,
		timing: has(TRIGGER_TYPE.instead) ? "INSTEAD OF" : has(TRIGGER_TYPE.before) ? "BEFORE" : "AFTER",
		events,
	};
}

// Overloads share a name (add_item(int), add_item(text)): the model lists
// routines by name, so each name appears once per kind.
function buildRoutines(rows: readonly RoutineRow[]): Routine[] {
	const routines = new Map<string, Routine>();
	for (const row of rows) {
		const kind = ROUTINE_KINDS[row.kind];
		if (kind !== undefined) routines.set(`${kind}\u0000${row.routineName}`, { name: row.routineName, kind });
	}
	return [...routines.values()];
}

function missingSchemaWarnings(database: string, requested: readonly string[] | null, schemas: readonly SchemaRow[]): Warning[] {
	const existing = new Set(schemas.map((row) => row.schemaName));
	return [...new Set(requested ?? [])]
		.filter((name) => !existing.has(name))
		.map((name) => ({
			code: "schema_not_visible",
			message: `schema "${name}" does not exist in database "${database}"`,
			target: formatName({ database, schema: name }),
		}));
}

// pg_catalog lists every object of the database to every user, privileges or
// not, so nothing is hidden from the snapshot. But without USAGE on a schema
// no query can reach its tables, which an agent writing SQL must know.
function unusableSchemaWarnings(database: string, schemas: readonly SchemaRow[], captured: ReadonlySet<string>): Warning[] {
	return schemas
		.filter((row) => captured.has(row.schemaName) && !row.usable)
		.map((row) => ({
			code: "schema_not_usable",
			message: `the user has no USAGE privilege on schema "${row.schemaName}": its structure is listed, but its tables cannot be queried with this user`,
			target: formatName({ database, schema: row.schemaName }),
		}));
}

// pg_get_viewdef does not check privileges, so a definition is only missing
// when the server returned none; still, null is never presented as a SELECT.
function hiddenViewDefinitionWarnings(database: string, schemas: readonly Schema[]): Warning[] {
	return schemas.flatMap((schema) =>
		schema.tables
			.filter((table) => table.kind === "view" && table.viewDefinition === null)
			.map((view) => ({
				code: "view_definition_hidden",
				message: `definition of view "${schema.name}.${view.name}" could not be read`,
				target: formatName({ database, schema: schema.name, table: view.name }),
			})),
	);
}

function isSystemSchema(name: string): boolean {
	return SYSTEM_SCHEMAS.includes(name) || TEMPORARY_SCHEMA.test(name);
}

/** A SQL string literal: 'it''s', the way enum labels are written in DDL. */
function sqlText(text: string): string {
	return `'${text.replaceAll("'", "''")}'`;
}

function tableKey(row: { schemaName: string; tableName: string }): string {
	// \u0000 cannot appear in identifiers, so the key is unambiguous.
	return `${row.schemaName}\u0000${row.tableName}`;
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const key = keyOf(item);
		const group = groups.get(key);
		if (group === undefined) groups.set(key, [item]);
		else group.push(item);
	}
	return groups;
}

// Plain code-unit comparison, like byName: the order never depends on the locale.
function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
