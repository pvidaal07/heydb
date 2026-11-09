import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildSnapshot, type MysqlCatalog } from "../../lib/engines/mysql/catalog.ts";

// Rows shaped like the answers of the INFORMATION_SCHEMA queries in introspect.ts.
function catalog(overrides: Partial<MysqlCatalog> = {}): MysqlCatalog {
	return {
		version: "8.0.36",
		capturedAt: "2026-11-03T10:00:00.000Z",
		requestedDatabases: null,
		databases: ["shop"],
		tables: [
			{ databaseName: "shop", tableName: "orders", tableType: "BASE TABLE", storageEngine: "InnoDB", tableRows: 1200, tableComment: "Customer orders" },
		],
		columns: [
			{ databaseName: "shop", tableName: "orders", columnName: "id", position: 1, columnType: "int unsigned", isNullable: "NO", columnDefault: null, columnComment: "", extra: "auto_increment", collation: null, generationExpression: "" },
			{ databaseName: "shop", tableName: "orders", columnName: "status", position: 2, columnType: "enum('draft','paid')", isNullable: "NO", columnDefault: "draft", columnComment: "Order state", extra: "", collation: "utf8mb4_unicode_ci", generationExpression: "" },
		],
		indexColumns: [
			{ databaseName: "shop", tableName: "orders", indexName: "PRIMARY", sequence: 1, columnName: "id", nonUnique: 0, indexType: "BTREE" },
		],
		foreignKeyColumns: [],
		triggers: [],
		routines: [],
		views: [],
		privileges: [
			{ databaseName: null, privilege: "TRIGGER" },
			{ databaseName: null, privilege: "SHOW_ROUTINE" },
		],
		...overrides,
	};
}

function onlyTable(snapshot: ReturnType<typeof buildSnapshot>, database = "shop", table = "orders") {
	const found = snapshot.databases
		.find((d) => d.name === database)
		?.schemas[0]?.tables.find((t) => t.name === table);
	assert.ok(found, `table ${database}.${table} exists`);
	return found;
}

describe("buildSnapshot: engine and databases", () => {
	test("detects MySQL from the version string", () => {
		assert.deepEqual(buildSnapshot(catalog()).engine, { kind: "mysql", version: "8.0.36" });
	});

	test("detects MariaDB from the version string", () => {
		assert.deepEqual(buildSnapshot(catalog({ version: "10.6.18-MariaDB-ubu2004" })).engine, {
			kind: "mariadb",
			version: "10.6.18-MariaDB-ubu2004",
		});
	});

	test("creates one schema per database, named like the database", () => {
		const snapshot = buildSnapshot(catalog({ databases: ["shop", "crm"] }));
		assert.deepEqual(
			snapshot.databases.map((d) => [d.name, d.schemas.map((s) => s.name)]),
			[
				["crm", ["crm"]],
				["shop", ["shop"]],
			],
		);
	});

	test("keeps capture time and format version", () => {
		const snapshot = buildSnapshot(catalog());
		assert.equal(snapshot.formatVersion, 1);
		assert.equal(snapshot.capturedAt, "2026-11-03T10:00:00.000Z");
	});

	test("warns about requested databases the user cannot see", () => {
		const snapshot = buildSnapshot(catalog({ requestedDatabases: ["shop", "secret"], databases: ["shop"] }));
		assert.deepEqual(snapshot.warnings, [
			{
				code: "database_not_visible",
				message: 'database "secret" does not exist or the user has no privileges on it',
				target: "secret",
			},
		]);
	});
});

describe("buildSnapshot: requested databases", () => {
	test("warns once per missing database, however often it was requested", () => {
		const snapshot = buildSnapshot(catalog({ requestedDatabases: ["secret", "secret"], databases: ["shop"] }));
		assert.deepEqual(
			snapshot.warnings.map((w) => w.target),
			["secret"],
		);
	});
});

describe("buildSnapshot: tables and columns", () => {
	test("maps table metadata", () => {
		const table = onlyTable(buildSnapshot(catalog()));
		assert.equal(table.kind, "table");
		assert.equal(table.storageEngine, "InnoDB");
		assert.equal(table.rowEstimate, 1200);
		assert.equal(table.comment, "Customer orders");
	});

	test("maps views, which have no storage engine or row estimate", () => {
		const snapshot = buildSnapshot(
			catalog({
				tables: [{ databaseName: "shop", tableName: "paid", tableType: "VIEW", storageEngine: null, tableRows: null, tableComment: "VIEW" }],
				columns: [],
				indexColumns: [],
			}),
		);
		const view = onlyTable(snapshot, "shop", "paid");
		assert.equal(view.kind, "view");
		assert.equal(view.storageEngine, null);
		assert.equal(view.rowEstimate, null);
		assert.equal(view.comment, "", 'MySQL reports the comment "VIEW" for every view; it carries no meaning');
	});

	test("maps the SQL definition of a view", () => {
		const snapshot = buildSnapshot(
			catalog({
				tables: [{ databaseName: "shop", tableName: "paid", tableType: "VIEW", storageEngine: null, tableRows: null, tableComment: "VIEW" }],
				views: [{ databaseName: "shop", tableName: "paid", viewDefinition: "select `shop`.`orders`.`id` AS `id` from `shop`.`orders`" }],
				columns: [],
				indexColumns: [],
			}),
		);
		assert.equal(onlyTable(snapshot, "shop", "paid").viewDefinition, "select `shop`.`orders`.`id` AS `id` from `shop`.`orders`");
		assert.deepEqual(snapshot.warnings, []);
	});

	test("gives tables no view definition", () => {
		assert.equal(onlyTable(buildSnapshot(catalog())).viewDefinition, null);
	});

	test("warns per view when its definition is hidden from the user", () => {
		const snapshot = buildSnapshot(
			catalog({
				databases: ["crm"],
				tables: [
					{ databaseName: "crm", tableName: "active", tableType: "VIEW", storageEngine: null, tableRows: null, tableComment: "VIEW" },
					{ databaseName: "crm", tableName: "v1.unlisted", tableType: "VIEW", storageEngine: null, tableRows: null, tableComment: "VIEW" },
				],
				// MySQL and MariaDB return an empty definition without SHOW VIEW; a
				// missing row is treated the same way, never as an empty SELECT.
				views: [{ databaseName: "crm", tableName: "active", viewDefinition: "" }],
				columns: [],
				indexColumns: [],
			}),
		);
		assert.equal(onlyTable(snapshot, "crm", "active").viewDefinition, null);
		assert.equal(onlyTable(snapshot, "crm", "v1.unlisted").viewDefinition, null);
		assert.deepEqual(snapshot.warnings, [
			{
				code: "view_definition_hidden",
				message: 'definition of view "crm.v1.unlisted" is only visible with the SHOW VIEW privilege',
				target: 'crm.crm."v1.unlisted"',
			},
			{
				code: "view_definition_hidden",
				message: 'definition of view "crm.active" is only visible with the SHOW VIEW privilege',
				target: "crm.crm.active",
			},
		]);
	});

	test("treats MariaDB system-versioned tables as tables", () => {
		const snapshot = buildSnapshot(
			catalog({ tables: [{ databaseName: "shop", tableName: "orders", tableType: "SYSTEM VERSIONED", storageEngine: "InnoDB", tableRows: 3, tableComment: "" }] }),
		);
		assert.equal(onlyTable(snapshot).kind, "table");
	});

	test("maps columns sorted by position", () => {
		const columns = catalog().columns;
		const table = onlyTable(buildSnapshot(catalog({ columns: [...columns].reverse() })));
		assert.deepEqual(
			table.columns.map((c) => c.name),
			["id", "status"],
		);
		assert.deepEqual(table.columns[1], {
			name: "status",
			position: 2,
			type: "enum('draft','paid')",
			nullable: false,
			default: "draft",
			comment: "Order state",
			autoIncrement: false,
			generated: null,
			collation: "utf8mb4_unicode_ci",
		});
		assert.equal(table.columns[0]?.autoIncrement, true);
	});

	test("maps MySQL generated columns", () => {
		const table = onlyTable(
			buildSnapshot(
				catalog({
					columns: [
						{ databaseName: "shop", tableName: "orders", columnName: "total", position: 1, columnType: "decimal(12,2)", isNullable: "YES", columnDefault: null, columnComment: "", extra: "STORED GENERATED", collation: null, generationExpression: "(`quantity` * `unit_price`)" },
						{ databaseName: "shop", tableName: "orders", columnName: "day", position: 2, columnType: "date", isNullable: "YES", columnDefault: null, columnComment: "", extra: "VIRTUAL GENERATED", collation: null, generationExpression: "cast(`shipped_at` as date)" },
					],
				}),
			),
		);
		assert.deepEqual(table.columns[0]?.generated, { expression: "(`quantity` * `unit_price`)", stored: true });
		assert.deepEqual(table.columns[1]?.generated, { expression: "cast(`shipped_at` as date)", stored: false });
	});

	test("maps MariaDB PERSISTENT generated columns as stored", () => {
		const table = onlyTable(
			buildSnapshot(
				catalog({
					version: "10.6.18-MariaDB",
					columns: [
						{ databaseName: "shop", tableName: "orders", columnName: "total", position: 1, columnType: "decimal(12,2)", isNullable: "YES", columnDefault: "NULL", columnComment: "", extra: "PERSISTENT GENERATED", collation: null, generationExpression: "`quantity` * `unit_price`" },
					],
				}),
			),
		);
		assert.deepEqual(table.columns[0]?.generated, { expression: "`quantity` * `unit_price`", stored: true });
	});

	test("reads MariaDB's textual NULL default as no default", () => {
		const table = onlyTable(
			buildSnapshot(
				catalog({
					version: "10.6.18-MariaDB",
					columns: [
						{ databaseName: "shop", tableName: "orders", columnName: "notes", position: 1, columnType: "text", isNullable: "YES", columnDefault: "NULL", columnComment: "", extra: "", collation: "utf8mb4_unicode_ci", generationExpression: null },
					],
				}),
			),
		);
		assert.equal(table.columns[0]?.default, null);
	});

	test("keeps the text NULL as a real default on MySQL", () => {
		const columns = catalog().columns.map((c) => (c.columnName === "status" ? { ...c, columnDefault: "NULL" } : c));
		assert.equal(onlyTable(buildSnapshot(catalog({ columns }))).columns[1]?.default, "NULL");
	});
});

describe("buildSnapshot: keys and indexes", () => {
	test("orders primary key columns by key sequence, not by table position", () => {
		const table = onlyTable(
			buildSnapshot(
				catalog({
					indexColumns: [
						{ databaseName: "shop", tableName: "orders", indexName: "PRIMARY", sequence: 2, columnName: "id", nonUnique: 0, indexType: "BTREE" },
						{ databaseName: "shop", tableName: "orders", indexName: "PRIMARY", sequence: 1, columnName: "status", nonUnique: 0, indexType: "BTREE" },
					],
				}),
			),
		);
		assert.deepEqual(table.primaryKey, ["status", "id"]);
		assert.deepEqual(table.indexes, [], "the primary key is not repeated as an index");
	});

	test("groups index columns by index, in sequence order", () => {
		const table = onlyTable(
			buildSnapshot(
				catalog({
					indexColumns: [
						{ databaseName: "shop", tableName: "orders", indexName: "idx_mix", sequence: 2, columnName: "id", nonUnique: 1, indexType: "BTREE" },
						{ databaseName: "shop", tableName: "orders", indexName: "uq_status", sequence: 1, columnName: "status", nonUnique: 0, indexType: "BTREE" },
						{ databaseName: "shop", tableName: "orders", indexName: "idx_mix", sequence: 1, columnName: "status", nonUnique: 1, indexType: "BTREE" },
						{ databaseName: "shop", tableName: "orders", indexName: "ft_notes", sequence: 1, columnName: "notes", nonUnique: 1, indexType: "FULLTEXT" },
					],
				}),
			),
		);
		assert.deepEqual(table.indexes, [
			{ name: "ft_notes", columns: ["notes"], unique: false, method: "FULLTEXT" },
			{ name: "idx_mix", columns: ["status", "id"], unique: false, method: "BTREE" },
			{ name: "uq_status", columns: ["status"], unique: true, method: "BTREE" },
		]);
	});

	test("names functional index parts, which have no column", () => {
		const table = onlyTable(
			buildSnapshot(
				catalog({
					indexColumns: [
						{ databaseName: "shop", tableName: "orders", indexName: "idx_lower", sequence: 1, columnName: null, nonUnique: 1, indexType: "BTREE" },
					],
				}),
			),
		);
		assert.deepEqual(table.indexes[0]?.columns, ["(expression)"]);
	});

	test("groups composite foreign keys with their actions and the referenced database", () => {
		const table = onlyTable(
			buildSnapshot(
				catalog({
					foreignKeyColumns: [
						{ databaseName: "shop", tableName: "orders", constraintName: "fk_line", position: 2, columnName: "id", referencedDatabase: "shop", referencedTable: "lines", referencedColumn: "order_id", updateRule: "NO ACTION", deleteRule: "SET NULL" },
						{ databaseName: "shop", tableName: "orders", constraintName: "fk_customer", position: 1, columnName: "status", referencedDatabase: "crm", referencedTable: "customers", referencedColumn: "id", updateRule: "CASCADE", deleteRule: "RESTRICT" },
						{ databaseName: "shop", tableName: "orders", constraintName: "fk_line", position: 1, columnName: "status", referencedDatabase: "shop", referencedTable: "lines", referencedColumn: "line_no", updateRule: "NO ACTION", deleteRule: "SET NULL" },
					],
				}),
			),
		);
		assert.deepEqual(table.foreignKeys, [
			{
				name: "fk_customer",
				columns: ["status"],
				references: { database: "crm", schema: "crm", table: "customers", columns: ["id"] },
				onDelete: "RESTRICT",
				onUpdate: "CASCADE",
			},
			{
				name: "fk_line",
				columns: ["status", "id"],
				references: { database: "shop", schema: "shop", table: "lines", columns: ["line_no", "order_id"] },
				onDelete: "SET NULL",
				onUpdate: "NO ACTION",
			},
		]);
	});
});

describe("buildSnapshot: triggers and routines", () => {
	test("attaches triggers to their table", () => {
		const table = onlyTable(
			buildSnapshot(
				catalog({
					triggers: [{ databaseName: "shop", tableName: "orders", triggerName: "trg_orders_bi", timing: "BEFORE", event: "INSERT" }],
				}),
			),
		);
		assert.deepEqual(table.triggers, [{ name: "trg_orders_bi", timing: "BEFORE", events: ["INSERT"] }]);
	});

	test("lists routines per database", () => {
		const snapshot = buildSnapshot(
			catalog({
				routines: [
					{ databaseName: "shop", routineName: "order_count", routineType: "FUNCTION" },
					{ databaseName: "shop", routineName: "close_order", routineType: "PROCEDURE" },
				],
			}),
		);
		assert.deepEqual(snapshot.databases[0]?.schemas[0]?.routines, [
			{ name: "close_order", kind: "procedure" },
			{ name: "order_count", kind: "function" },
		]);
	});
});

describe("buildSnapshot: objects the user may not be allowed to see", () => {
	test("does not warn when global privileges reveal triggers and routines", () => {
		assert.deepEqual(buildSnapshot(catalog()).warnings, []);
	});

	test("warns per database when the user cannot see triggers or routines", () => {
		const snapshot = buildSnapshot(catalog({ databases: ["shop"], privileges: [{ databaseName: "shop", privilege: "SELECT" }] }));
		assert.deepEqual(snapshot.warnings, [
			{
				code: "routines_hidden",
				message: 'routines in "shop" are only listed with the SHOW_ROUTINE, EXECUTE, ALTER ROUTINE or CREATE ROUTINE privilege; the list may be incomplete',
				target: "shop",
			},
			{
				code: "triggers_hidden",
				message: 'triggers in "shop" are only listed with the TRIGGER privilege; the list may be incomplete',
				target: "shop",
			},
		]);
	});

	test("accepts database-level privileges", () => {
		const snapshot = buildSnapshot(
			catalog({
				privileges: [
					{ databaseName: "shop", privilege: "TRIGGER" },
					{ databaseName: "shop", privilege: "EXECUTE" },
				],
			}),
		);
		assert.deepEqual(snapshot.warnings, []);
	});

	test("a wildcard database grant covers the databases it matches", () => {
		const snapshot = buildSnapshot(
			catalog({
				databases: ["shop_es", "shopXes"],
				privileges: [
					{ databaseName: "shop\\_%", privilege: "TRIGGER" },
					{ databaseName: "shop\\_%", privilege: "EXECUTE" },
				],
			}),
		);
		assert.deepEqual(
			snapshot.warnings.map((w) => `${w.code}:${w.target}`),
			["routines_hidden:shopXes", "triggers_hidden:shopXes"],
			"shop\\_% matches shop_es but not shopXes: the escaped _ is a literal underscore",
		);
	});

	test("an unescaped _ in a grant matches any single character, as in MySQL", () => {
		const snapshot = buildSnapshot(
			catalog({
				databases: ["shopXes"],
				privileges: [
					{ databaseName: "shop_es", privilege: "TRIGGER" },
					{ databaseName: "shop_es", privilege: "EXECUTE" },
				],
			}),
		);
		assert.deepEqual(snapshot.warnings, []);
	});

	test("treats SHOW_ROUTINE as global only, since MySQL grants it only globally", () => {
		const snapshot = buildSnapshot(
			catalog({
				privileges: [
					{ databaseName: null, privilege: "TRIGGER" },
					{ databaseName: "shop", privilege: "SHOW_ROUTINE" },
				],
			}),
		);
		assert.deepEqual(
			snapshot.warnings.map((w) => w.code),
			["routines_hidden"],
		);
	});
});

describe("buildSnapshot: unexpected values", () => {
	test("rejects an unknown foreign key rule instead of guessing", () => {
		assert.throws(
			() =>
				buildSnapshot(
					catalog({
						foreignKeyColumns: [
							{ databaseName: "shop", tableName: "orders", constraintName: "fk_x", position: 1, columnName: "id", referencedDatabase: "shop", referencedTable: "t", referencedColumn: "id", updateRule: "CASCADE", deleteRule: "EXPLODE" },
						],
					}),
				),
			/unknown foreign key rule "EXPLODE" on shop\.orders\.fk_x/,
		);
	});

	test("ignores rows of tables outside the captured databases", () => {
		const snapshot = buildSnapshot(
			catalog({
				columns: [
					...catalog().columns,
					{ databaseName: "other", tableName: "x", columnName: "id", position: 1, columnType: "int", isNullable: "NO", columnDefault: null, columnComment: "", extra: "", collation: null, generationExpression: "" },
				],
			}),
		);
		assert.deepEqual(
			snapshot.databases.map((d) => d.name),
			["shop"],
		);
	});
});
