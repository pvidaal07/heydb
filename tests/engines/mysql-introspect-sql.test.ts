import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import { attachForeignKeyRules } from "../../lib/engines/mysql/catalog.ts";
import { type QueryableConnection, TimedSession } from "../../lib/engines/mysql/introspect.ts";

// On MariaDB, a statement that names two INFORMATION_SCHEMA views (a JOIN, or a
// UNION of both) can make the server scan the second view without the
// database filter: it opens every table of every database on the server.
// On a shared server with many databases the sync then hangs for minutes.
// Every MySQL/MariaDB engine query reads one view; the code combines them.

const ENGINE_DIR = join(import.meta.dirname, "../../lib/engines/mysql");

// Every string and template literal in the engine source that mentions
// INFORMATION_SCHEMA. The engine writes each query as one literal.
function informationSchemaQueries(): { file: string; sql: string }[] {
	const queries: { file: string; sql: string }[] = [];
	for (const file of readdirSync(ENGINE_DIR).filter((name) => name.endsWith(".ts"))) {
		// Comments go first: a quote or backtick in prose would misalign the literals.
		const source = readFileSync(join(ENGINE_DIR, file), "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "");
		for (const match of source.matchAll(/`[^`]*`|"(?:[^"\\\n]|\\.)*"/g)) {
			if (/INFORMATION_SCHEMA\s*\./i.test(match[0])) queries.push({ file, sql: match[0] });
		}
	}
	return queries;
}

function viewsIn(sql: string): string[] {
	return [...sql.matchAll(/INFORMATION_SCHEMA\s*\.\s*`?(\w+)/gi)].map((m) => m[1]!.toUpperCase());
}

describe("MySQL engine SQL", () => {
	test("finds the engine's INFORMATION_SCHEMA queries (the check below is not vacuous)", () => {
		const views = new Set(informationSchemaQueries().flatMap((q) => viewsIn(q.sql)));
		for (const view of ["SCHEMATA", "TABLES", "COLUMNS", "STATISTICS", "KEY_COLUMN_USAGE", "REFERENTIAL_CONSTRAINTS"]) {
			assert.ok(views.has(view), `expected a query on INFORMATION_SCHEMA.${view}`);
		}
	});

	test("never reads two INFORMATION_SCHEMA views in one statement", () => {
		const offending = informationSchemaQueries()
			.filter((q) => viewsIn(q.sql).length > 1)
			.map((q) => `${q.file}: ${viewsIn(q.sql).join(" + ")}`);
		assert.deepEqual(offending, []);
	});
});

describe("foreign key rules read apart from their columns", () => {
	const column = (tableName: string, constraintName: string, position: number, columnName: string, referencedDatabase = "shop") => ({
		databaseName: "shop", tableName, constraintName, position, columnName,
		referencedDatabase, referencedTable: "customers", referencedColumn: `ref_${columnName}`,
	});

	test("attaches the rules of each constraint to every column of it, composite and cross-database", () => {
		const rows = attachForeignKeyRules(
			[column("orders", "fk_line", 2, "b"), column("orders", "fk_customer", 1, "customer_id", "crm"), column("orders", "fk_line", 1, "a")],
			[
				{ databaseName: "shop", tableName: "orders", constraintName: "fk_customer", updateRule: "CASCADE", deleteRule: "RESTRICT" },
				{ databaseName: "shop", tableName: "orders", constraintName: "fk_line", updateRule: "NO ACTION", deleteRule: "SET NULL" },
			],
		);
		assert.deepEqual(rows, [
			{ ...column("orders", "fk_line", 2, "b"), updateRule: "NO ACTION", deleteRule: "SET NULL" },
			{ ...column("orders", "fk_customer", 1, "customer_id", "crm"), updateRule: "CASCADE", deleteRule: "RESTRICT" },
			{ ...column("orders", "fk_line", 1, "a"), updateRule: "NO ACTION", deleteRule: "SET NULL" },
		]);
	});

	test("matches by database, table and constraint name, and drops columns without rules like the former join", () => {
		const rows = attachForeignKeyRules(
			[column("orders", "fk_x", 1, "a"), column("lines", "fk_x", 1, "b"), column("orphans", "fk_none", 1, "c")],
			[
				{ databaseName: "shop", tableName: "lines", constraintName: "fk_x", updateRule: "CASCADE", deleteRule: "CASCADE" },
				{ databaseName: "shop", tableName: "orders", constraintName: "fk_x", updateRule: "RESTRICT", deleteRule: "NO ACTION" },
				{ databaseName: "crm", tableName: "orphans", constraintName: "fk_none", updateRule: "CASCADE", deleteRule: "CASCADE" },
			],
		);
		assert.deepEqual(
			rows.map((r) => `${r.tableName}.${r.constraintName}:${r.updateRule}/${r.deleteRule}`),
			["orders.fk_x:RESTRICT/NO ACTION", "lines.fk_x:CASCADE/CASCADE"],
		);
	});
});

describe("time limit on every MySQL query", () => {
	function fakeConnection(answer: (options: { sql: string; timeout: number; values?: unknown[] }) => Promise<[unknown, unknown]>) {
		const calls: { sql: string; timeout: number; values?: unknown[] }[] = [];
		let destroyed = 0;
		const connection: QueryableConnection = {
			query: (options) => {
				calls.push(options);
				return answer(options);
			},
			destroy: () => {
				destroyed += 1;
			},
		};
		return { connection, calls, destroyedCount: () => destroyed };
	}

	const timeout = () => Promise.reject(Object.assign(new Error("Query inactivity timeout"), { code: "PROTOCOL_SEQUENCE_TIMEOUT" }));

	test("passes the limit to every query and returns its rows", async () => {
		const fake = fakeConnection(async () => [[{ n: 1 }], []]);
		const session = new TimedSession(fake.connection, "db.example:3306", 60_000);
		assert.deepEqual(await session.select("tables", "SELECT 1 AS n", [["shop"]]), [{ n: 1 }]);
		assert.deepEqual(await session.select("version", "SELECT 2"), [{ n: 1 }]);
		assert.deepEqual(fake.calls, [
			{ sql: "SELECT 1 AS n", timeout: 60_000, values: [["shop"]] },
			{ sql: "SELECT 2", timeout: 60_000 },
		]);
		assert.equal(fake.destroyedCount(), 0);
		assert.equal(session.destroyed, false);
	});

	test("a query over the limit fails naming the step, the server and the limit, and closes the connection", async () => {
		const fake = fakeConnection(timeout);
		const session = new TimedSession(fake.connection, "db.example:3306", 60_000);
		await assert.rejects(session.select("foreign keys", "SELECT 1"), (error: Error) => {
			assert.equal(
				error.message,
				"mysql: reading foreign keys on db.example:3306 took longer than 60 s; the server did not answer in time (it may be overloaded, or scanning every database on a shared server)",
			);
			assert.equal(String(error).startsWith("Error: mysql: reading foreign keys"), true);
			return true;
		});
		assert.equal(fake.destroyedCount(), 1, "the connection is destroyed, so the process can exit");
		assert.equal(session.destroyed, true);
	});

	test("shows a limit under a second in seconds too, and destroys the connection only once", async () => {
		const fake = fakeConnection(timeout);
		const session = new TimedSession(fake.connection, "127.0.0.1:3306", 1_500);
		await assert.rejects(session.select("the session setup (sql_mode)", "SET x"), /^Error: mysql: reading the session setup \(sql_mode\) on 127\.0\.0\.1:3306 took longer than 1\.5 s; /);
		await assert.rejects(session.select("columns", "SELECT 1"), /took longer than 1\.5 s/);
		assert.equal(fake.destroyedCount(), 1);
	});

	test("any other error passes through unchanged and leaves the connection to its owner", async () => {
		const original = new Error("Access denied");
		const fake = fakeConnection(() => Promise.reject(original));
		const session = new TimedSession(fake.connection, "db.example:3306", 60_000);
		await assert.rejects(session.select("tables", "SELECT 1"), (error) => error === original);
		assert.equal(fake.destroyedCount(), 0);
		assert.equal(session.destroyed, false);
	});
});
