import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { diffSnapshots } from "../../lib/model/diff.ts";
import { schemaHash } from "../../lib/model/hash.ts";
import type { Snapshot, Table } from "../../lib/model/snapshot.ts";
import { column, customersTable, ordersTable, snapshot } from "../fixtures/snapshot.ts";

const base = () => snapshot([customersTable(), ordersTable()]);

function withOrders(overrides: Partial<Table>): Snapshot {
	return snapshot([customersTable(), ordersTable(overrides)]);
}

function ordersColumns(...changes: [string, Parameters<typeof column>[2]][]): Table["columns"] {
	return ordersTable().columns.map((c) => {
		const change = changes.find(([name]) => name === c.name);
		return change ? { ...c, ...change[1] } : c;
	});
}

describe("diffSnapshots", () => {
	test("finds nothing between a snapshot and itself", () => {
		assert.deepEqual(diffSnapshots(base(), base()), []);
	});

	test("ignores capture time, engine version, row estimates, warnings and read order, like the hash", () => {
		const after = snapshot([ordersTable({ rowEstimate: 5 }), customersTable()], {
			capturedAt: "2027-01-01T00:00:00.000Z",
			engine: { kind: "mysql", version: "8.4.0" },
			warnings: [{ code: "routines_hidden", message: "hidden" }],
		});
		assert.deepEqual(diffSnapshots(base(), after), []);
	});

	test("reports a column type, nullability and default change with plain-English details", () => {
		const after = withOrders({
			columns: ordersColumns(["customer_id", { type: "bigint", nullable: true, default: "0" }]),
		});
		assert.deepEqual(diffSnapshots(base(), after), [
			{
				kind: "modified",
				object: "column",
				target: "shop.shop.orders.customer_id",
				details: ["type: int → bigint", "nullable: false → true", "default: null → '0'"],
			},
		]);
	});

	test("reports column comment, auto increment, collation, position and generated changes", () => {
		const after = withOrders({
			columns: ordersColumns(
				["id", { autoIncrement: false, comment: "it's the key" }],
				["total", { collation: "utf8mb4_bin", generated: { expression: "`a` * 2", stored: true } }],
			),
		});
		assert.deepEqual(diffSnapshots(base(), after), [
			{
				kind: "modified",
				object: "column",
				target: "shop.shop.orders.id",
				details: ["comment: '' → 'it''s the key'", "auto increment: true → false"],
			},
			{
				kind: "modified",
				object: "column",
				target: "shop.shop.orders.total",
				details: ["generated: null → `a` * 2 STORED", "collation: null → 'utf8mb4_bin'"],
			},
		]);
	});

	test("reports a column moved to another position", () => {
		const after = withOrders({ columns: ordersColumns(["customer_id", { position: 3 }], ["total", { position: 2 }]) });
		assert.deepEqual(
			diffSnapshots(base(), after).map((c) => `${c.target} ${c.details.join(", ")}`),
			["shop.shop.orders.customer_id position: 2 → 3", "shop.shop.orders.total position: 3 → 2"],
		);
	});

	test("reports a renamed column as removed plus added, never guessing the rename", () => {
		const after = withOrders({ columns: ordersColumns(["total", { name: "amount" }]) });
		assert.deepEqual(diffSnapshots(base(), after), [
			{ kind: "added", object: "column", target: "shop.shop.orders.amount", details: [] },
			{ kind: "removed", object: "column", target: "shop.shop.orders.total", details: [] },
		]);
	});

	test("reports table-level changes: comment, storage engine and primary key order", () => {
		const after = withOrders({ comment: "Orders", storageEngine: "MyISAM", primaryKey: ["id", "tenant_id"] });
		assert.deepEqual(diffSnapshots(base(), after), [
			{
				kind: "modified",
				object: "table",
				target: "shop.shop.orders",
				details: ["comment: '' → 'Orders'", "storage engine: 'InnoDB' → 'MyISAM'", "primary key: (id) → (id, tenant_id)"],
			},
		]);
	});

	test("reports a table turned into a view as one modified object", () => {
		const after = withOrders({ kind: "view", storageEngine: null, viewDefinition: "select 1" });
		assert.deepEqual(diffSnapshots(base(), after), [
			{
				kind: "modified",
				object: "view",
				target: "shop.shop.orders",
				details: ["kind: table → view", "storage engine: 'InnoDB' → null", "definition changed"],
			},
		]);
	});

	test("reports a changed view definition", () => {
		const view = (definition: string) => snapshot([ordersTable({ kind: "view", viewDefinition: definition })]);
		assert.deepEqual(diffSnapshots(view("select 1"), view("select 2")), [
			{ kind: "modified", object: "view", target: "shop.shop.orders", details: ["definition changed"] },
		]);
	});

	test("reports added and removed tables and views without listing their contents", () => {
		const after = snapshot([ordersTable(), ordersTable({ name: "paid_orders", kind: "view", viewDefinition: "select 1" })]);
		assert.deepEqual(diffSnapshots(base(), after), [
			{ kind: "removed", object: "table", target: "shop.shop.customers", details: [] },
			{ kind: "added", object: "view", target: "shop.shop.paid_orders", details: [] },
		]);
	});

	test("reports index changes under the table name plus the index name", () => {
		const after = withOrders({
			indexes: [
				{ name: "idx_customer", columns: ["customer_id", "total"], unique: true, method: "HASH" },
				{ name: "idx_total", columns: ["total"], unique: false, method: "BTREE" },
			],
		});
		assert.deepEqual(diffSnapshots(base(), after), [
			{
				kind: "modified",
				object: "index",
				target: "shop.shop.orders.idx_customer",
				details: ["columns: (customer_id) → (customer_id, total)", "unique: false → true", "method: BTREE → HASH"],
			},
			{ kind: "added", object: "index", target: "shop.shop.orders.idx_total", details: [] },
		]);
	});

	test("reports foreign key column, reference and action changes", () => {
		const fk = ordersTable().foreignKeys[0]!;
		const after = withOrders({
			foreignKeys: [
				{
					...fk,
					columns: ["customer_id", "id"],
					references: { database: "crm", schema: "crm", table: "customers", columns: ["id", "x"] },
					onDelete: "CASCADE",
					onUpdate: "NO ACTION",
				},
			],
		});
		assert.deepEqual(diffSnapshots(base(), after), [
			{
				kind: "modified",
				object: "foreignKey",
				target: "shop.shop.orders.fk_orders_customer",
				details: [
					"columns: (customer_id) → (customer_id, id)",
					"references: shop.shop.customers(id) → crm.crm.customers(id, x)",
					"onDelete: RESTRICT → CASCADE",
					"onUpdate: CASCADE → NO ACTION",
				],
			},
		]);
	});

	test("reports trigger timing and event changes, and removed triggers", () => {
		const before = withOrders({
			triggers: [
				{ name: "trg_a", timing: "BEFORE", events: ["INSERT"] },
				{ name: "trg_b", timing: "AFTER", events: ["DELETE"] },
			],
		});
		const after = withOrders({ triggers: [{ name: "trg_a", timing: "AFTER", events: ["UPDATE", "INSERT"] }] });
		assert.deepEqual(diffSnapshots(before, after), [
			{
				kind: "modified",
				object: "trigger",
				target: "shop.shop.orders.trg_a",
				details: ["timing: BEFORE → AFTER", "events: (INSERT) → (INSERT, UPDATE)"],
			},
			{ kind: "removed", object: "trigger", target: "shop.shop.orders.trg_b", details: [] },
		]);
	});

	test("reports routines, treating a procedure and a function of the same name as different objects", () => {
		const withRoutines = (routines: Snapshot["databases"][number]["schemas"][number]["routines"]) =>
			snapshot([], { databases: [{ name: "shop", schemas: [{ name: "shop", tables: [], routines }] }] });
		const before = withRoutines([{ name: "close_order", kind: "procedure" }]);
		const after = withRoutines([
			{ name: "close_order", kind: "function" },
			{ name: "order_count", kind: "function" },
		]);
		assert.deepEqual(diffSnapshots(before, after), [
			{ kind: "added", object: "routine", target: "shop.shop.close_order", details: ["function"] },
			{ kind: "removed", object: "routine", target: "shop.shop.close_order", details: ["procedure"] },
			{ kind: "added", object: "routine", target: "shop.shop.order_count", details: ["function"] },
		]);
	});

	test("reports added and removed databases and schemas, quoting names with dots", () => {
		const before = snapshot([], {
			databases: [
				{ name: "shop", schemas: [{ name: "shop", tables: [], routines: [] }] },
				{ name: "v1.old", schemas: [] },
			],
		});
		const after = snapshot([], {
			databases: [
				{
					name: "shop",
					schemas: [
						{ name: "shop", tables: [], routines: [] },
						{ name: "audit", tables: [], routines: [] },
					],
				},
				{ name: "crm", schemas: [] },
			],
		});
		// Plain code-unit order: a quoted name sorts before letters.
		assert.deepEqual(diffSnapshots(before, after), [
			{ kind: "removed", object: "database", target: '"v1.old"', details: [] },
			{ kind: "added", object: "database", target: "crm", details: [] },
			{ kind: "added", object: "schema", target: "shop.audit", details: [] },
		]);
	});

	test("orders the result by target, then object, then kind, whatever the input order", () => {
		const after = withOrders({
			columns: [...ordersColumns(["total", { type: "bigint" }])].reverse(),
			indexes: [],
			comment: "x",
		});
		const changes = diffSnapshots(base(), after);
		assert.deepEqual(
			changes.map((c) => `${c.target}|${c.object}|${c.kind}`),
			[
				"shop.shop.orders|table|modified",
				"shop.shop.orders.idx_customer|index|removed",
				"shop.shop.orders.total|column|modified",
			],
		);
	});

	test("does not modify its inputs", () => {
		const before = base();
		const after = withOrders({ comment: "x" });
		const frozen = JSON.stringify([before, after]);
		diffSnapshots(before, after);
		assert.equal(JSON.stringify([before, after]), frozen);
	});

	test("finds changes exactly when the schema hash changes, in both directions", () => {
		const fk = ordersTable().foreignKeys[0]!;
		const mutations: Record<string, Snapshot> = {
			"same structure, new capture": snapshot([ordersTable({ rowEstimate: 1 }), customersTable()], { capturedAt: "x" }),
			"column type": withOrders({ columns: ordersColumns(["total", { type: "decimal(12,2)" }]) }),
			"column nullable": withOrders({ columns: ordersColumns(["total", { nullable: true }]) }),
			"column default": withOrders({ columns: ordersColumns(["total", { default: "0.00" }]) }),
			"column comment": withOrders({ columns: ordersColumns(["total", { comment: "c" }]) }),
			"column auto increment": withOrders({ columns: ordersColumns(["id", { autoIncrement: false }]) }),
			"column collation": withOrders({ columns: ordersColumns(["total", { collation: "x" }]) }),
			"column generated": withOrders({ columns: ordersColumns(["total", { generated: { expression: "1", stored: false } }]) }),
			"generated stored": snapshot([
				customersTable(),
				ordersTable({ columns: ordersColumns(["total", { generated: { expression: "1", stored: true } }]) }),
			]),
			"column position": withOrders({ columns: ordersColumns(["total", { position: 4 }]) }),
			"column renamed": withOrders({ columns: ordersColumns(["total", { name: "amount" }]) }),
			"table comment": withOrders({ comment: "c" }),
			"table engine": withOrders({ storageEngine: null }),
			"table kind": withOrders({ kind: "view" }),
			"view definition": withOrders({ viewDefinition: "select 1" }),
			"primary key order": withOrders({ primaryKey: ["customer_id", "id"] }),
			"index unique": withOrders({ indexes: [{ name: "idx_customer", columns: ["customer_id"], unique: true, method: "BTREE" }] }),
			"index method": withOrders({ indexes: [{ name: "idx_customer", columns: ["customer_id"], unique: false, method: "HASH" }] }),
			"index removed": withOrders({ indexes: [] }),
			"fk action": withOrders({ foreignKeys: [{ ...fk, onUpdate: "RESTRICT" }] }),
			"fk reference": withOrders({ foreignKeys: [{ ...fk, references: { ...fk.references, schema: "x" } }] }),
			"trigger added": withOrders({ triggers: [{ name: "t", timing: "AFTER", events: ["INSERT"] }] }),
			"table removed": snapshot([ordersTable()]),
			"routine added": snapshot([customersTable(), ordersTable()], {
				databases: [
					{
						name: "shop",
						schemas: [{ name: "shop", tables: [customersTable(), ordersTable()], routines: [{ name: "r", kind: "function" }] }],
					},
				],
			}),
			"database added": snapshot([customersTable(), ordersTable()], {
				databases: [...base().databases, { name: "crm", schemas: [] }],
			}),
		};
		const samples = [base(), ...Object.values(mutations)];
		for (const [label, mutated] of Object.entries(mutations)) {
			for (const [a, b] of [
				[base(), mutated],
				[mutated, base()],
			] as const) {
				const sameHash = schemaHash(a) === schemaHash(b);
				assert.equal(diffSnapshots(a, b).length === 0, sameHash, `${label}: diff and hash disagree`);
			}
		}
		// Every pair, not only against the base.
		for (const a of samples) {
			for (const b of samples) {
				assert.equal(diffSnapshots(a, b).length === 0, schemaHash(a) === schemaHash(b));
			}
		}
	});
});
