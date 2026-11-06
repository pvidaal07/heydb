// Runs the MySQL engine against real servers started by compose.yaml:
//   docker compose -f tests/integration/compose.yaml up -d --wait
//   node --run test:integration
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import mysql, { type RowDataPacket } from "mysql2/promise";

import { connectReadOnly, introspectMysql, type MysqlConnectionOptions } from "../../lib/engines/mysql/introspect.ts";
import { schemaHash } from "../../lib/model/hash.ts";
import type { Snapshot, Table } from "../../lib/model/snapshot.ts";

const targets = [
	{ name: "MySQL 8.0", kind: "mysql", port: 33080 },
	{ name: "MariaDB 10.6", kind: "mariadb", port: 33106 },
] as const;

function options(port: number, overrides: Partial<MysqlConnectionOptions> = {}): MysqlConnectionOptions {
	return { host: "127.0.0.1", port, user: "root", password: "heydb-test", databases: ["shop", "crm"], ...overrides };
}

function table(snapshot: Snapshot, database: string, name: string): Table {
	const found = snapshot.databases
		.find((d) => d.name === database)
		?.schemas[0]?.tables.find((t) => t.name === name);
	assert.ok(found, `expected table ${database}.${name}`);
	return found;
}

for (const target of targets) {
	describe(`introspectMysql against ${target.name}`, () => {
		let snapshot: Snapshot;

		test("captures the requested databases and detects the engine", async () => {
			snapshot = await introspectMysql(options(target.port));
			assert.equal(snapshot.engine.kind, target.kind);
			assert.deepEqual(
				snapshot.databases.map((d) => d.name),
				["crm", "shop"],
			);
			assert.deepEqual(snapshot.warnings, []);
		});

		test("reads every table and view of the legacy fixture", () => {
			const shop = snapshot.databases.find((d) => d.name === "shop")?.schemas[0];
			assert.deepEqual(
				shop?.tables.map((t) => `${t.name}:${t.kind}`),
				[
					"legacy_invoices:table",
					"order_lines:table",
					"orders:table",
					"paid_orders:view",
					"shipments:table",
					"v1.old_orders:table",
				],
			);
		});

		test("reads the SQL definition of views, and none for tables", () => {
			assert.match(table(snapshot, "shop", "paid_orders").viewDefinition ?? "", /`orders`/);
			assert.match(table(snapshot, "crm", "active_customers").viewDefinition ?? "", /`customers`/);
			assert.equal(table(snapshot, "shop", "orders").viewDefinition, null);
		});

		test("keeps the primary key in key order, not column order", () => {
			assert.deepEqual(table(snapshot, "shop", "order_lines").primaryKey, ["line_no", "order_id"]);
		});

		test("reads a cross-database foreign key with its actions", () => {
			assert.deepEqual(table(snapshot, "shop", "orders").foreignKeys, [
				{
					name: "fk_orders_customer",
					columns: ["customer_id"],
					references: { database: "crm", schema: "crm", table: "customers", columns: ["id"] },
					onDelete: "RESTRICT",
					onUpdate: "CASCADE",
				},
			]);
		});

		test("reads a composite foreign key in column order", () => {
			const fk = table(snapshot, "shop", "shipments").foreignKeys[0];
			assert.deepEqual(fk?.columns, ["line_no", "order_id"]);
			assert.deepEqual(fk?.references.columns, ["line_no", "order_id"]);
			assert.equal(fk?.onDelete, "SET NULL");
		});

		test("shows that the MyISAM legacy table has no foreign keys and why", () => {
			const legacy = table(snapshot, "shop", "legacy_invoices");
			assert.equal(legacy.storageEngine, "MyISAM");
			assert.deepEqual(legacy.foreignKeys, []);
			assert.equal(legacy.comment, "Facturas antiguas (sin FKs)");
			assert.equal(legacy.columns.find((c) => c.name === "cod_cliente")?.collation, null, "int columns have no collation");
			assert.match(legacy.columns.find((c) => c.name === "fec_alta")?.type ?? "", /^date$/);
		});

		test("reads stored and virtual generated columns", () => {
			const lineTotal = table(snapshot, "shop", "order_lines").columns.find((c) => c.name === "line_total");
			assert.equal(lineTotal?.generated?.stored, true);
			assert.match(lineTotal?.generated?.expression ?? "", /quantity.*\*.*unit_price/);
			const day = table(snapshot, "shop", "shipments").columns.find((c) => c.name === "shipped_day");
			assert.equal(day?.generated?.stored, false);
		});

		test("reads defaults, comments, collations, auto-increment and unique/fulltext indexes", () => {
			const customers = table(snapshot, "crm", "customers");
			const status = customers.columns.find((c) => c.name === "status");
			assert.equal(status?.default, "1");
			assert.equal(status?.comment, "1=active 2=blocked 3=deleted");
			assert.equal(customers.columns.find((c) => c.name === "name")?.default, null);
			assert.equal(customers.columns.find((c) => c.name === "email")?.collation, "latin1_swedish_ci");
			assert.equal(customers.columns.find((c) => c.name === "id")?.autoIncrement, true);
			assert.deepEqual(customers.indexes, [{ name: "uq_email", columns: ["email"], unique: true, method: "BTREE" }]);
			assert.ok(table(snapshot, "shop", "orders").indexes.some((i) => i.name === "ft_notes" && i.method === "FULLTEXT"));
		});

		test("reads triggers and routines", () => {
			assert.deepEqual(table(snapshot, "shop", "orders").triggers, [
				{ name: "trg_orders_bi", timing: "BEFORE", events: ["INSERT"] },
			]);
			assert.deepEqual(snapshot.databases.find((d) => d.name === "shop")?.schemas[0]?.routines, [
				{ name: "close_order", kind: "procedure" },
				{ name: "order_count", kind: "function" },
			]);
		});

		test("produces the same hash on a second capture", async () => {
			const again = await introspectMysql(options(target.port));
			assert.equal(schemaHash(again), schemaHash(snapshot));
		});

		test("captures every visible user database when none is requested, never system ones", async () => {
			const all = await introspectMysql(options(target.port, { databases: null }));
			assert.deepEqual(
				all.databases.map((d) => d.name),
				["crm", "secret", "shop"],
			);
		});

		test("a read-only user does not see what it has no privileges on, and heydb says so", async () => {
			const reader = await introspectMysql(
				options(target.port, { user: "heydb_reader", password: "reader-pass", databases: ["shop", "crm", "secret"] }),
			);
			assert.deepEqual(
				reader.databases.map((d) => d.name),
				["crm", "shop"],
			);
			assert.deepEqual(
				reader.warnings.map((w) => `${w.code}:${w.target}`),
				[
					"database_not_visible:secret",
					"routines_hidden:crm",
					"routines_hidden:shop",
					"triggers_hidden:crm",
					"triggers_hidden:shop",
					"view_definition_hidden:crm.crm.active_customers",
				],
				"what the reader cannot see is reported, never silently left out",
			);
			assert.equal(table(reader, "crm", "active_customers").kind, "view", "the view itself is still listed");
			assert.match(table(reader, "shop", "paid_orders").viewDefinition ?? "", /`orders`/, "SHOW VIEW on shop reveals it");
		});

		test("works on servers running with sql_mode ANSI_QUOTES, common in legacy setups", async () => {
			const admin = await connectReadOnly(options(target.port));
			const [rows] = await admin.query<RowDataPacket[]>("SELECT @@GLOBAL.sql_mode AS mode");
			const original = String(rows[0]?.mode ?? "");
			await admin.query("SET GLOBAL sql_mode = ?", [original ? `${original},ANSI_QUOTES` : "ANSI_QUOTES"]);
			try {
				const underAnsi = await introspectMysql(options(target.port));
				assert.equal(schemaHash(underAnsi), schemaHash(snapshot));
				assert.deepEqual(underAnsi.warnings, []);
			} finally {
				await admin.query("SET GLOBAL sql_mode = ?", [original]);
				await admin.end();
			}
		});

		test("opens a read-only session: even root cannot write through it", async () => {
			const connection = await connectReadOnly(options(target.port));
			try {
				await assert.rejects(connection.query("INSERT INTO shop.orders (customer_id) VALUES (1)"), /READ ONLY/i);
			} finally {
				await connection.end();
			}
		});

		test("reports a wrong password clearly", async () => {
			await assert.rejects(
				introspectMysql(options(target.port, { password: "wrong" })),
				/mysql: cannot connect to 127\.0\.0\.1:\d+ as root: Access denied/,
			);
		});
	});
}

test("closes the connection when the session cannot be made read-only", async (t) => {
	// Simulates a server or proxy that rejects the SET statement.
	const prototype = (mysql as unknown as { PromiseConnection: { prototype: Record<string, (...args: unknown[]) => unknown> } })
		.PromiseConnection.prototype;
	const realQuery = prototype.query!;
	const end = t.mock.method(prototype, "end");
	const destroy = t.mock.method(prototype, "destroy");
	t.mock.method(prototype, "query", function (this: unknown, sql: unknown, ...rest: unknown[]) {
		if (typeof sql === "string" && sql.startsWith("SET SESSION TRANSACTION")) return Promise.reject(new Error("syntax error"));
		return realQuery.call(this, sql, ...rest);
	});
	await assert.rejects(
		introspectMysql(options(33080)),
		/^Error: mysql: cannot open a read-only session on 127\.0\.0\.1:33080: syntax error/,
	);
	assert.equal(end.mock.callCount() + destroy.mock.callCount(), 1, "the connection is closed exactly once");
});

test("reports an unreachable server clearly", async () => {
	await assert.rejects(
		introspectMysql(options(1, { connectTimeoutMs: 2000 })),
		/mysql: cannot connect to 127\.0\.0\.1:1 as root: /,
	);
});
