import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
	buildSnapshot,
	capturedSchemas,
	type ColumnRow,
	type ForeignKeyColumnRow,
	type IndexColumnRow,
	type PostgresCatalog,
	type TableRow,
} from "../../lib/engines/postgres/catalog.ts";
import { emptyKnowledge } from "../../lib/knowledge/operations.ts";
import { knowledgeForTable } from "../../lib/knowledge/query.ts";
import { schemaHash } from "../../lib/model/hash.ts";
import type { Snapshot, Table } from "../../lib/model/snapshot.ts";
import { validateSnapshot } from "../../lib/model/validate.ts";
import { renderOverview, renderSearch, renderTable } from "../../lib/render/markdown.ts";
import { searchSchema } from "../../lib/search.ts";
import { resolveTable } from "../../lib/usecases/resolve.ts";

// Hand-written catalog rows, shaped like the aliases of the queries in
// lib/engines/postgres/introspect.ts. No server involved.

function tableRow(schemaName: string, tableName: string, overrides: Partial<TableRow> = {}): TableRow {
	return { schemaName, tableName, relkind: "r", reltuples: 10, partitionRows: null, comment: null, viewDefinition: null, ...overrides };
}

function columnRow(schemaName: string, tableName: string, columnName: string, position: number, overrides: Partial<ColumnRow> = {}): ColumnRow {
	return {
		schemaName,
		tableName,
		columnName,
		position,
		dataType: "integer",
		notNull: true,
		defaultExpression: null,
		identity: "",
		generated: "",
		comment: null,
		collation: null,
		enumLabels: null,
		...overrides,
	};
}

function indexRow(tableName: string, indexName: string, position: number, columnName: string, overrides: Partial<IndexColumnRow> = {}): IndexColumnRow {
	return { schemaName: "public", tableName, indexName, primary: false, unique: false, method: "btree", position, columnName, ...overrides };
}

function fkRow(position: number, columnName: string, referencedColumn: string, overrides: Partial<ForeignKeyColumnRow> = {}): ForeignKeyColumnRow {
	return {
		schemaName: "public",
		tableName: "orders",
		constraintName: "fk_orders_customer",
		position,
		columnName,
		referencedSchema: "billing",
		referencedTable: "customers",
		referencedColumn,
		updateRule: "a",
		deleteRule: "a",
		...overrides,
	};
}

function catalog(overrides: Partial<PostgresCatalog> = {}): PostgresCatalog {
	return {
		version: "16.4 (Debian 16.4-1.pgdg120+1)",
		capturedAt: "2026-11-06T10:00:00.000Z",
		database: "legacy",
		requestedSchemas: null,
		schemas: [
			{ schemaName: "public", usable: true },
			{ schemaName: "billing", usable: true },
		],
		tables: [tableRow("public", "orders"), tableRow("billing", "customers")],
		columns: [columnRow("public", "orders", "id", 1), columnRow("billing", "customers", "id", 1)],
		indexColumns: [],
		foreignKeyColumns: [],
		triggers: [],
		routines: [],
		...overrides,
	};
}

function table(snapshot: Snapshot, schema: string, name: string): Table {
	const found = snapshot.databases[0]?.schemas.find((s) => s.name === schema)?.tables.find((t) => t.name === name);
	assert.ok(found, `expected table ${schema}.${name}`);
	return found;
}

describe("capturedSchemas", () => {
	const all = ["public", "billing", "pg_catalog", "information_schema", "pg_toast", "pg_temp_3", "pg_toast_temp_3"].map(
		(schemaName) => ({ schemaName, usable: true }),
	);

	test("captures every schema but the system ones when none is requested, sorted", () => {
		assert.deepEqual(capturedSchemas(all, null), ["billing", "public"]);
	});

	test("captures only the requested schemas that exist, even a system one asked for by name", () => {
		assert.deepEqual(capturedSchemas(all, ["public", "missing", "pg_catalog"]), ["pg_catalog", "public"]);
	});

	test("matches names exactly: PostgreSQL identifiers are case-sensitive", () => {
		assert.deepEqual(capturedSchemas([{ schemaName: "Sales", usable: true }], ["sales"]), []);
	});
});

describe("buildSnapshot (PostgreSQL)", () => {
	test("one database, the connected one, with one schema per captured schema", () => {
		const snapshot = buildSnapshot(catalog());
		assert.deepEqual(snapshot.engine, { kind: "postgresql", version: "16.4 (Debian 16.4-1.pgdg120+1)" });
		assert.equal(snapshot.capturedAt, "2026-11-06T10:00:00.000Z");
		assert.deepEqual(
			snapshot.databases.map((d) => [d.name, d.schemas.map((s) => s.name)]),
			[["legacy", ["billing", "public"]]],
		);
		assert.deepEqual(snapshot.warnings, []);
		assert.deepEqual(validateSnapshot(JSON.parse(JSON.stringify(snapshot))), snapshot, "a valid snapshot");
	});

	test("ignores rows of schemas that were not captured", () => {
		const snapshot = buildSnapshot(
			catalog({ requestedSchemas: ["public"], tables: [tableRow("public", "orders"), tableRow("billing", "customers")] }),
		);
		assert.deepEqual(snapshot.databases[0]?.schemas.map((s) => s.name), ["public"]);
	});

	test("maps relation kinds: tables, partitioned and foreign tables are tables; views and materialized views are views", () => {
		const snapshot = buildSnapshot(
			catalog({
				tables: [
					tableRow("public", "plain", { relkind: "r" }),
					tableRow("public", "events", { relkind: "p" }),
					tableRow("public", "remote", { relkind: "f" }),
					tableRow("public", "paid_orders", { relkind: "v", reltuples: -1, viewDefinition: " SELECT 1;" }),
					tableRow("public", "order_totals", { relkind: "m", reltuples: 2, viewDefinition: " SELECT 2;" }),
				],
				columns: [],
			}),
		);
		const kinds = snapshot.databases[0]?.schemas.find((s) => s.name === "public")?.tables.map((t) => `${t.name}:${t.kind}`);
		assert.deepEqual(kinds, ["events:table", "order_totals:view", "paid_orders:view", "plain:table", "remote:table"]);
		assert.equal(table(snapshot, "public", "paid_orders").viewDefinition, " SELECT 1;");
		assert.equal(table(snapshot, "public", "order_totals").viewDefinition, " SELECT 2;");
		assert.equal(table(snapshot, "public", "plain").viewDefinition, null);
		assert.equal(table(snapshot, "public", "plain").storageEngine, null, "PostgreSQL has no storage engine per table");
	});

	test("row estimates: -1 means never analyzed, views have none, partitioned tables fall back to their partitions", () => {
		const snapshot = buildSnapshot(
			catalog({
				tables: [
					tableRow("public", "fresh", { reltuples: -1 }),
					tableRow("public", "big", { reltuples: 1234.6 }),
					tableRow("public", "empty", { reltuples: 0 }),
					tableRow("public", "v", { relkind: "v", reltuples: -1 }),
					tableRow("public", "m", { relkind: "m", reltuples: 7 }),
					tableRow("public", "p_analyzed", { relkind: "p", reltuples: 3, partitionRows: 99 }),
					tableRow("public", "p_parts", { relkind: "p", reltuples: -1, partitionRows: 41 }),
					tableRow("public", "p_unknown", { relkind: "p", reltuples: -1, partitionRows: null }),
				],
				columns: [],
			}),
		);
		const rows = Object.fromEntries(
			snapshot.databases[0]!.schemas.find((s) => s.name === "public")!.tables.map((t) => [t.name, t.rowEstimate]),
		);
		assert.deepEqual(rows, { big: 1235, empty: 0, fresh: null, m: 7, p_analyzed: 3, p_parts: 41, p_unknown: null, v: null });
	});

	test("keeps names exactly as the catalog has them, quoted identifiers included", () => {
		const snapshot = buildSnapshot(
			catalog({
				tables: [tableRow("public", "MixedCase"), tableRow("public", "v1.old_orders")],
				columns: [columnRow("public", "MixedCase", "DisplayName", 2), columnRow("public", "MixedCase", "Id", 1)],
				indexColumns: [indexRow("MixedCase", "MixedCase_pkey", 1, "Id", { primary: true, unique: true })],
			}),
		);
		const mixed = table(snapshot, "public", "MixedCase");
		assert.deepEqual(mixed.columns.map((c) => c.name), ["Id", "DisplayName"]);
		assert.deepEqual(mixed.primaryKey, ["Id"]);
		assert.ok(table(snapshot, "public", "v1.old_orders"));
	});

	test("reads columns: nullability, defaults, comments and explicit collations", () => {
		const snapshot = buildSnapshot(
			catalog({
				columns: [
					columnRow("public", "orders", "total", 3, { dataType: "numeric(10,2)", defaultExpression: "0", comment: "Includes VAT" }),
					columnRow("public", "orders", "notes", 5, { dataType: "text", notNull: false }),
					columnRow("public", "orders", "email", 6, { dataType: "character varying(255)", collation: "C" }),
				],
			}),
		);
		const [total, notes, email] = table(snapshot, "public", "orders").columns;
		assert.deepEqual(total, {
			name: "total",
			position: 3,
			type: "numeric(10,2)",
			nullable: false,
			default: "0",
			comment: "Includes VAT",
			autoIncrement: false,
			generated: null,
			collation: null,
		});
		assert.equal(notes?.nullable, true);
		assert.equal(notes?.comment, "");
		assert.equal(email?.collation, "C");
	});

	test("identity and serial columns are auto-increment; identity says ALWAYS or BY DEFAULT in the default", () => {
		const snapshot = buildSnapshot(
			catalog({
				columns: [
					columnRow("public", "orders", "always", 1, { identity: "a" }),
					columnRow("public", "orders", "by_default", 2, { dataType: "bigint", identity: "d" }),
					columnRow("public", "orders", "old_serial", 3, { defaultExpression: "nextval('public.orders_old_serial_seq'::regclass)" }),
					columnRow("public", "orders", "plain", 4, { defaultExpression: "1" }),
				],
			}),
		);
		const columns = table(snapshot, "public", "orders").columns.map((c) => [c.name, c.autoIncrement, c.default]);
		assert.deepEqual(columns, [
			["always", true, "GENERATED ALWAYS AS IDENTITY"],
			["by_default", true, "GENERATED BY DEFAULT AS IDENTITY"],
			["old_serial", true, "nextval('public.orders_old_serial_seq'::regclass)"],
			["plain", false, "1"],
		]);
	});

	test("a generated column has its expression and no default; stored (s) and virtual (v, PostgreSQL 18)", () => {
		const snapshot = buildSnapshot(
			catalog({
				columns: [
					columnRow("public", "orders", "line_total", 1, { generated: "s", defaultExpression: "(quantity * unit_price)" }),
					columnRow("public", "orders", "virtual_total", 2, { generated: "v", defaultExpression: "(quantity * 2)" }),
				],
			}),
		);
		const [stored, virtual] = table(snapshot, "public", "orders").columns;
		assert.deepEqual([stored?.generated, stored?.default], [{ expression: "(quantity * unit_price)", stored: true }, null]);
		assert.deepEqual(virtual?.generated, { expression: "(quantity * 2)", stored: false });
	});

	test("an enum column lists its labels in order in the type, like MySQL's enum(...)", () => {
		const snapshot = buildSnapshot(
			catalog({
				columns: [
					columnRow("public", "orders", "status", 1, {
						dataType: "public.order_status",
						enumLabels: ["draft", "paid", "it's complicated"],
					}),
				],
			}),
		);
		assert.equal(table(snapshot, "public", "orders").columns[0]?.type, "public.order_status enum('draft','paid','it''s complicated')");
	});

	test("primary key in key order and indexes in index order, whatever order the rows came in", () => {
		const snapshot = buildSnapshot(
			catalog({
				tables: [tableRow("public", "order_lines")],
				columns: [],
				indexColumns: [
					indexRow("order_lines", "order_lines_pkey", 2, "order_id", { primary: true, unique: true }),
					indexRow("order_lines", "idx_notes", 1, "to_tsvector('simple'::regconfig, notes)", { method: "gin" }),
					indexRow("order_lines", "order_lines_pkey", 1, "line_no", { primary: true, unique: true }),
					indexRow("order_lines", "uq_code", 2, "line_no", { unique: true }),
					indexRow("order_lines", "uq_code", "1" as unknown as number, "code", { unique: true }),
				],
			}),
		);
		const lines = table(snapshot, "public", "order_lines");
		assert.deepEqual(lines.primaryKey, ["line_no", "order_id"]);
		assert.deepEqual(lines.indexes, [
			{ name: "idx_notes", columns: ["to_tsvector('simple'::regconfig, notes)"], unique: false, method: "gin" },
			{ name: "uq_code", columns: ["code", "line_no"], unique: true, method: "btree" },
		]);
	});

	test("foreign keys: cross-schema target in the same database, composite in key order, actions decoded", () => {
		const snapshot = buildSnapshot(
			catalog({
				foreignKeyColumns: [
					fkRow(1, "customer_id", "id", { updateRule: "c", deleteRule: "r" }),
					fkRow(2, "order_id", "order_id", {
						constraintName: "fk_line",
						referencedSchema: "public",
						referencedTable: "order_lines",
						deleteRule: "n",
						updateRule: "d",
					}),
					fkRow(1, "line_no", "line_no", {
						constraintName: "fk_line",
						referencedSchema: "public",
						referencedTable: "order_lines",
						deleteRule: "n",
						updateRule: "d",
					}),
				],
			}),
		);
		assert.deepEqual(table(snapshot, "public", "orders").foreignKeys, [
			{
				name: "fk_line",
				columns: ["line_no", "order_id"],
				references: { database: "legacy", schema: "public", table: "order_lines", columns: ["line_no", "order_id"] },
				onDelete: "SET NULL",
				onUpdate: "SET DEFAULT",
			},
			{
				name: "fk_orders_customer",
				columns: ["customer_id"],
				references: { database: "legacy", schema: "billing", table: "customers", columns: ["id"] },
				onDelete: "RESTRICT",
				onUpdate: "CASCADE",
			},
		]);
		const noAction = buildSnapshot(catalog({ foreignKeyColumns: [fkRow(1, "customer_id", "id")] }));
		assert.equal(table(noAction, "public", "orders").foreignKeys[0]?.onDelete, "NO ACTION");
	});

	test("an unknown foreign key action is an error that names the constraint", () => {
		assert.throws(() => buildSnapshot(catalog({ foreignKeyColumns: [fkRow(1, "customer_id", "id", { deleteRule: "x" })] })), {
			message: 'unknown foreign key action "x" on legacy.public.orders.fk_orders_customer',
		});
	});

	test("triggers: timing and events decoded from the tgtype bits", () => {
		const trigger = (triggerName: string, type: number) => ({ schemaName: "public", tableName: "orders", triggerName, type });
		const snapshot = buildSnapshot(
			catalog({
				triggers: [
					trigger("trg_before", 1 | 2 | 4 | 16), // ROW, BEFORE, INSERT, UPDATE
					trigger("trg_after", 8 | 32), // statement level, AFTER, DELETE, TRUNCATE
					trigger("trg_instead", 1 | 64 | 4), // ROW, INSTEAD OF, INSERT
				],
			}),
		);
		assert.deepEqual(table(snapshot, "public", "orders").triggers, [
			{ name: "trg_after", timing: "AFTER", events: ["DELETE", "TRUNCATE"] },
			{ name: "trg_before", timing: "BEFORE", events: ["INSERT", "UPDATE"] },
			{ name: "trg_instead", timing: "INSTEAD OF", events: ["INSERT"] },
		]);
	});

	test("routines: functions and procedures, once per name; aggregates and window functions are skipped", () => {
		const routine = (routineName: string, kind: string) => ({ schemaName: "public", routineName, kind });
		const snapshot = buildSnapshot(
			catalog({
				routines: [
					routine("order_count", "f"),
					routine("add_item", "f"),
					routine("add_item", "f"), // an overload: same name, other arguments
					routine("close_order", "p"),
					routine("concat_all", "a"),
					routine("rank_orders", "w"),
				],
			}),
		);
		assert.deepEqual(snapshot.databases[0]?.schemas.find((s) => s.name === "public")?.routines, [
			{ name: "add_item", kind: "function" },
			{ name: "close_order", kind: "procedure" },
			{ name: "order_count", kind: "function" },
		]);
	});

	test("warns about requested schemas that do not exist and schemas the user cannot use", () => {
		const snapshot = buildSnapshot(
			catalog({
				requestedSchemas: ["public", "billing", "missing", "Billing.Old"],
				schemas: [
					{ schemaName: "public", usable: true },
					{ schemaName: "billing", usable: false },
				],
			}),
		);
		assert.deepEqual(snapshot.warnings, [
			{
				code: "schema_not_usable",
				message:
					'the user has no USAGE privilege on schema "billing": its structure is listed, but its tables cannot be queried with this user',
				target: "legacy.billing",
			},
			{
				code: "schema_not_visible",
				message: 'schema "Billing.Old" does not exist in database "legacy"',
				target: 'legacy."Billing.Old"',
			},
			{ code: "schema_not_visible", message: 'schema "missing" does not exist in database "legacy"', target: "legacy.missing" },
		]);
		assert.deepEqual(snapshot.databases[0]?.schemas.map((s) => s.name), ["billing", "public"], "billing is still captured");
	});

	test("a view whose definition could not be read keeps null and a warning", () => {
		const snapshot = buildSnapshot(
			catalog({ tables: [tableRow("public", "paid_orders", { relkind: "v", viewDefinition: null })], columns: [] }),
		);
		assert.deepEqual(snapshot.warnings, [
			{
				code: "view_definition_hidden",
				message: 'definition of view "public.paid_orders" could not be read',
				target: "legacy.public.paid_orders",
			},
		]);
	});

	test("the hash does not depend on the order of the rows", () => {
		const base = catalog({
			columns: [columnRow("public", "orders", "id", 1), columnRow("public", "orders", "total", 2)],
			indexColumns: [indexRow("orders", "idx_a", 1, "id"), indexRow("orders", "idx_b", 1, "total")],
		});
		const reversed: PostgresCatalog = {
			...base,
			schemas: [...base.schemas].reverse(),
			tables: [...base.tables].reverse(),
			columns: [...base.columns].reverse(),
			indexColumns: [...base.indexColumns].reverse(),
		};
		assert.equal(schemaHash(buildSnapshot(reversed)), schemaHash(buildSnapshot(base)));
	});
});

// The tools read snapshots and never know the engine; this checks a
// PostgreSQL snapshot renders and resolves like a MySQL one.
describe("a PostgreSQL snapshot through the tools' building blocks", () => {
	const snapshot = buildSnapshot(
		catalog({
			schemas: [
				{ schemaName: "public", usable: true },
				{ schemaName: "billing", usable: false },
			],
			tables: [
				tableRow("public", "orders", { reltuples: 1200, comment: "Customer orders" }),
				tableRow("public", "order_totals", { relkind: "m", reltuples: 2, viewDefinition: " SELECT 1;" }),
				tableRow("billing", "customers"),
			],
			columns: [
				columnRow("public", "orders", "id", 1, { dataType: "bigint", identity: "d" }),
				columnRow("public", "orders", "status", 2, { dataType: "public.order_status", enumLabels: ["draft", "paid"] }),
				columnRow("billing", "customers", "id", 1),
			],
			indexColumns: [indexRow("orders", "orders_pkey", 1, "id", { primary: true, unique: true })],
			foreignKeyColumns: [fkRow(1, "id", "id")],
		}),
	);

	test("the overview names schemas as database.schema and warns about billing", () => {
		const text = renderOverview(snapshot, emptyKnowledge(), { connection: "pg" });
		assert.match(text, /^# heydb · pg\npostgresql 16\.4 /);
		assert.match(text, /^- legacy\.billing: 1 table$/m);
		assert.match(text, /^- legacy\.public: 1 table, 1 view$/m);
		assert.match(text, /no USAGE privilege on schema "billing"/);
		assert.match(text, /^\| legacy\.public\.orders \| table \| ~1\.2k \| Customer orders \|$/m);
	});

	test("search results and resolve errors keep every level of a PostgreSQL name", () => {
		assert.match(renderSearch(searchSchema(snapshot, emptyKnowledge(), "orders")), /^- table legacy\.public\.orders · name · table comment: Customer orders$/m);
		assert.throws(() => resolveTable(snapshot, "ordrs"), { message: 'no table matches "ordrs". Did you mean: legacy.public.orders?' });
	});

	test("a table resolves as schema.table and renders its enum, identity and cross-schema foreign key", () => {
		const resolved = resolveTable(snapshot, "public.orders");
		assert.equal(resolved.name, "legacy.public.orders");
		const text = renderTable(resolved.table, resolved.name, knowledgeForTable(emptyKnowledge(), resolved.name));
		assert.match(text, /^# table legacy\.public\.orders$/m);
		assert.match(text, /public\.order_status enum\('draft','paid'\)/);
		assert.match(text, /GENERATED BY DEFAULT AS IDENTITY/);
		assert.match(text, /^- fk_orders_customer: \(id\) → legacy\.billing\.customers\(id\) · on delete NO ACTION · on update NO ACTION$/m);
	});
});
