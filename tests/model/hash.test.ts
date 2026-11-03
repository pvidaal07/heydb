import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { schemaHash } from "../../lib/model/hash.ts";
import type { Column, Snapshot, Table } from "../../lib/model/snapshot.ts";

function column(name: string, position: number, overrides: Partial<Column> = {}): Column {
	return {
		name,
		position,
		type: "int",
		nullable: false,
		default: null,
		comment: "",
		autoIncrement: false,
		generated: null,
		collation: null,
		...overrides,
	};
}

function ordersTable(overrides: Partial<Table> = {}): Table {
	return {
		name: "orders",
		kind: "table",
		comment: "",
		storageEngine: "InnoDB",
		rowEstimate: 1200,
		columns: [column("id", 1, { autoIncrement: true }), column("customer_id", 2), column("total", 3, { type: "decimal(10,2)" })],
		primaryKey: ["id"],
		indexes: [{ name: "idx_customer", columns: ["customer_id"], unique: false, method: "BTREE" }],
		foreignKeys: [
			{
				name: "fk_orders_customer",
				columns: ["customer_id"],
				references: { database: "shop", schema: "shop", table: "customers", columns: ["id"] },
				onDelete: "RESTRICT",
				onUpdate: "CASCADE",
			},
		],
		triggers: [],
		...overrides,
	};
}

function customersTable(): Table {
	return {
		...ordersTable(),
		name: "customers",
		columns: [column("id", 1), column("email", 2, { type: "varchar(255)" })],
		indexes: [],
		foreignKeys: [],
	};
}

function snapshot(tables: Table[], overrides: Partial<Snapshot> = {}): Snapshot {
	return {
		formatVersion: 1,
		engine: { kind: "mysql", version: "8.0.36" },
		capturedAt: "2026-11-03T10:00:00.000Z",
		databases: [{ name: "shop", schemas: [{ name: "shop", tables, routines: [] }] }],
		warnings: [],
		...overrides,
	};
}

describe("schemaHash", () => {
	test("returns a sha256-prefixed hex digest", () => {
		assert.match(schemaHash(snapshot([ordersTable()])), /^sha256:[0-9a-f]{64}$/);
	});

	test("ignores the order in which tables and columns were read", () => {
		const a = snapshot([ordersTable(), customersTable()]);
		const shuffled = ordersTable();
		const b = snapshot([customersTable(), { ...shuffled, columns: [...shuffled.columns].reverse() }]);
		assert.equal(schemaHash(a), schemaHash(b));
	});

	test("ignores when, where and how big: capture time, engine version, row estimate, warnings", () => {
		const a = snapshot([ordersTable()]);
		const b = snapshot([ordersTable({ rowEstimate: 999_999 })], {
			capturedAt: "2027-01-01T00:00:00.000Z",
			engine: { kind: "mysql", version: "8.4.0" },
			warnings: [{ code: "routines_hidden", message: "no SHOW_ROUTINE privilege" }],
		});
		assert.equal(schemaHash(a), schemaHash(b));
	});

	test("changes when a column type changes", () => {
		const changed = ordersTable({ columns: [column("id", 1, { autoIncrement: true }), column("customer_id", 2, { type: "bigint" }), column("total", 3, { type: "decimal(10,2)" })] });
		assert.notEqual(schemaHash(snapshot([ordersTable()])), schemaHash(snapshot([changed])));
	});

	test("changes when an index changes, which the Go version missed", () => {
		const changed = ordersTable({ indexes: [{ name: "idx_customer", columns: ["customer_id"], unique: true, method: "BTREE" }] });
		assert.notEqual(schemaHash(snapshot([ordersTable()])), schemaHash(snapshot([changed])));
	});

	test("changes when a foreign key action changes", () => {
		const base = ordersTable();
		const fk = base.foreignKeys[0]!;
		const changed = ordersTable({ foreignKeys: [{ ...fk, onDelete: "CASCADE" }] });
		assert.notEqual(schemaHash(snapshot([base])), schemaHash(snapshot([changed])));
	});

	test("changes when the primary key column order changes", () => {
		const a = ordersTable({ primaryKey: ["id", "customer_id"] });
		const b = ordersTable({ primaryKey: ["customer_id", "id"] });
		assert.notEqual(schemaHash(snapshot([a])), schemaHash(snapshot([b])));
	});

	test("changes when a table comment changes", () => {
		assert.notEqual(
			schemaHash(snapshot([ordersTable()])),
			schemaHash(snapshot([ordersTable({ comment: "Customer orders" })])),
		);
	});
});
