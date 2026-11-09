import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { displayName, formatName } from "../../lib/model/names.ts";
import type { Snapshot, Table } from "../../lib/model/snapshot.ts";
import { resolveColumn, resolveTable } from "../../lib/usecases/resolve.ts";
import { column, customersTable, ordersTable, snapshot } from "../fixtures/snapshot.ts";

function table(name: string): Table {
	return { ...customersTable(), name };
}

// shop has orders and customers; crm has customers and a table with a dot in its name.
const twoDatabases: Snapshot = snapshot([], {
	databases: [
		{ name: "shop", schemas: [{ name: "shop", tables: [customersTable(), ordersTable()], routines: [] }] },
		{ name: "crm", schemas: [{ name: "crm", tables: [customersTable(), table("v1.old")], routines: [] }] },
	],
});

describe("resolveTable", () => {
	test("accepts a canonical name, db.table and a bare table name", () => {
		for (const input of ["shop.shop.orders", "shop.orders", "orders"]) {
			const resolved = resolveTable(twoDatabases, input);
			assert.equal(resolved.name, "shop.shop.orders");
			assert.equal(resolved.table.name, "orders");
			assert.equal(resolved.database, "shop");
			assert.equal(resolved.schema, "shop");
		}
	});

	test("accepts quoted names", () => {
		assert.equal(resolveTable(twoDatabases, 'crm."v1.old"').name, 'crm.crm."v1.old"');
		assert.equal(resolveTable(twoDatabases, '"v1.old"').name, 'crm.crm."v1.old"');
	});

	test("falls back to a case-insensitive match when there is no exact one", () => {
		assert.equal(resolveTable(twoDatabases, "SHOP.Orders").name, "shop.shop.orders");
	});

	test("prefers the exact case when two tables differ only by case", () => {
		const cased = snapshot([ordersTable(), table("Orders")]);
		assert.equal(resolveTable(cased, "Orders").table.name, "Orders");
		assert.equal(resolveTable(cased, "orders").table.name, "orders");
	});

	test("lists the candidates of an ambiguous name", () => {
		assert.throws(() => resolveTable(twoDatabases, "customers"), {
			message: [
				'"customers" matches 2 tables; use the full name:',
				"- crm.crm.customers",
				"- shop.shop.customers",
			].join("\n"),
		});
	});

	test("lists at most 10 candidates, then how many more", () => {
		const databases = Array.from({ length: 13 }, (_, index) => {
			const name = `db${String(index).padStart(2, "0")}`;
			return { name, schemas: [{ name, tables: [table("t")], routines: [] }] };
		});
		assert.throws(
			() => resolveTable(snapshot([], { databases }), "t"),
			(error: Error) => {
				const lines = error.message.split("\n");
				assert.equal(lines[0], '"t" matches 13 tables; use the full name:');
				assert.deepEqual(lines.slice(1, 3), ["- db00.db00.t", "- db01.db01.t"]);
				assert.equal(lines.length, 12);
				assert.equal(lines[11], "… and 3 more");
				return true;
			},
		);
	});

	test("suggests at most 5 similar names and never dumps every table (v1 bug #7)", () => {
		const many = snapshot(Array.from({ length: 3000 }, (_, index) => table(`table_${index}`)).concat(ordersTable()));
		assert.throws(() => resolveTable(many, "ordrs"), { message: 'no table matches "ordrs". Did you mean: shop.shop.orders?' });
		assert.throws(
			() => resolveTable(many, "table_12".replace("12", "x12")),
			(error: Error) => {
				const suggestions = error.message.split("Did you mean: ")[1]?.replace("?", "").split(", ") ?? [];
				assert.equal(suggestions.length, 5);
				assert.ok(error.message.length < 300, error.message);
				return true;
			},
		);
	});

	test("says so plainly when nothing is similar", () => {
		assert.throws(() => resolveTable(twoDatabases, "zzzzzz"), { message: 'no table matches "zzzzzz"' });
		assert.throws(() => resolveTable(twoDatabases, "nope.orders"), { message: 'no table matches "nope.orders". Did you mean: shop.shop.orders?' });
	});

	test("rejects names that cannot be a table", () => {
		assert.throws(() => resolveTable(twoDatabases, "a.b.c.d"), {
			message: 'expected a table name (table, database.table or database.schema.table): got "a.b.c.d"',
		});
		assert.throws(() => resolveTable(twoDatabases, "shop..orders"), /empty segment/);
	});
});

describe("resolveColumn", () => {
	test("accepts table.column, db.table.column, the canonical name and a bare column", () => {
		for (const input of ["orders.total", "shop.orders.total", "shop.shop.orders.total", "total"]) {
			const resolved = resolveColumn(twoDatabases, input);
			assert.equal(resolved.name, "shop.shop.orders.total");
			assert.equal(resolved.column.name, "total");
			assert.equal(resolved.table.name, "shop.shop.orders");
		}
	});

	test("lists the candidates of an ambiguous column", () => {
		assert.throws(() => resolveColumn(twoDatabases, "customers.email"), {
			message: ['"customers.email" matches 2 columns; use the full name:', "- crm.crm.customers.email", "- shop.shop.customers.email"].join(
				"\n",
			),
		});
	});

	test("suggests columns of the table when only the column is wrong", () => {
		assert.throws(() => resolveColumn(twoDatabases, "orders.totl"), {
			message: 'no column matches "orders.totl". Did you mean: shop.shop.orders.total?',
		});
	});

	test("reports the table when the table part is wrong", () => {
		assert.throws(() => resolveColumn(twoDatabases, "ordrs.total"), {
			message: 'no column matches "ordrs.total". Did you mean: shop.shop.orders.total?',
		});
	});

	test("works on a table with a column called __proto__", () => {
		const odd = snapshot([ordersTable({ columns: [column("__proto__", 1)] })]);
		assert.equal(resolveColumn(odd, "orders.__proto__").name, "shop.shop.orders.__proto__");
	});
});

describe("display names", () => {
	// What heydb prints must be something heydb accepts back, unchanged.
	const postgres: Snapshot = snapshot([], {
		engine: { kind: "postgresql", version: "16.4" },
		databases: [
			{
				name: "app",
				schemas: [
					{ name: "public", tables: [ordersTable()], routines: [] },
					{ name: "sales", tables: [ordersTable()], routines: [] },
				],
			},
		],
	});

	test("every table and column resolves from its display name", () => {
		for (const schema of [twoDatabases, postgres]) {
			for (const database of schema.databases) {
				for (const { name: schemaName, tables } of database.schemas) {
					for (const table of tables) {
						const ref = { database: database.name, schema: schemaName, table: table.name };
						assert.equal(resolveTable(schema, displayName(ref)).name, formatName(ref));
						for (const { name: columnName } of table.columns) {
							const columnRef = { ...ref, column: columnName };
							assert.equal(resolveColumn(schema, displayName(columnRef)).name, formatName(columnRef));
						}
					}
				}
			}
		}
	});
});
