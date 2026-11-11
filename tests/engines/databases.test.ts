import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { missingDatabases } from "../../lib/engines/index.ts";
import { findMissingDatabases } from "../../lib/engines/mysql/databases.ts";

// The check before a sync (issue #144) must be cheap: one query on
// INFORMATION_SCHEMA.SCHEMATA with a time limit, never a join of views.

function fakeConnection(names: string[]) {
	const queries: { sql: string; timeout: number | undefined; values: unknown }[] = [];
	const connection = {
		async query(options: { sql: string; timeout?: number }, values: unknown) {
			queries.push({ sql: options.sql, timeout: options.timeout, values });
			return [names.map((name) => ({ name })), []] as const;
		},
	};
	return { connection, queries };
}

describe("findMissingDatabases (MySQL, MariaDB)", () => {
	test("returns the configured databases the server does not show, in config order, with one SCHEMATA query", async () => {
		const { connection, queries } = fakeConnection(["shop"]);
		assert.deepEqual(await findMissingDatabases(connection, ["shop", "sales_2019", "archive"]), ["sales_2019", "archive"]);
		assert.equal(queries.length, 1);
		const [query] = queries;
		assert.match(query?.sql ?? "", /FROM INFORMATION_SCHEMA\.SCHEMATA WHERE SCHEMA_NAME IN \(\?\)/);
		assert.doesNotMatch(query?.sql ?? "", /JOIN/i);
		assert.deepEqual(query?.values, [["shop", "sales_2019", "archive"]]);
		assert.ok((query?.timeout ?? 0) > 0, "the query has a time limit");
	});

	test("compares names exactly, like the capture does", async () => {
		const { connection } = fakeConnection(["Shop"]);
		assert.deepEqual(await findMissingDatabases(connection, ["shop"]), ["shop"]);
	});

	test("returns nothing when every configured database is there", async () => {
		const { connection } = fakeConnection(["crm", "shop"]);
		assert.deepEqual(await findMissingDatabases(connection, ["shop", "crm"]), []);
	});
});

describe("missingDatabases", () => {
	const entry = { engine: "mysql" as const, host: "127.0.0.1", port: 1, user: "root", password: "env:HEYDB_X" };

	test("has nothing to check when the connection captures every visible database", async () => {
		// Port 1 would refuse a connection: an empty answer proves nothing was attempted.
		assert.deepEqual(await missingDatabases({ ...entry, databases: null }, "x"), []);
	});

	test("leaves PostgreSQL alone: connecting to a missing database already fails with a clear error", async () => {
		assert.deepEqual(await missingDatabases({ ...entry, engine: "postgresql", databases: ["legacy"], schemas: null }, "x"), []);
	});
});
