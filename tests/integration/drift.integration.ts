// Detects real schema drift end to end: capture, sync, ALTER, capture again.
// Needs the servers from compose.yaml (node --run db:up). Works in a scratch
// database, heydb_drift, that is always dropped afterwards.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import mysql, { type Connection } from "mysql2/promise";

import { introspectMysql } from "../../lib/engines/mysql/introspect.ts";
import { schemaHash } from "../../lib/model/hash.ts";
import type { Snapshot } from "../../lib/model/snapshot.ts";
import { checkStatus } from "../../lib/usecases/status.ts";
import { syncSnapshot } from "../../lib/usecases/sync.ts";

const DATABASE = "heydb_drift";

const targets = [
	// MariaDB still prints display widths for integer types.
	{ name: "MySQL 8.0", port: 33080, typeChange: "type: int → bigint" },
	{ name: "MariaDB 10.6", port: 33106, typeChange: "type: int(11) → bigint(20)" },
] as const;

for (const target of targets) {
	describe(`schema drift against ${target.name}`, () => {
		const credentials = { host: "127.0.0.1", port: target.port, user: "root", password: "heydb-test" };
		const capture = (): Promise<Snapshot> => introspectMysql({ ...credentials, databases: [DATABASE] });
		let admin: Connection;
		let root: string;

		// introspectMysql opens a read-only session, so DDL needs its own plain connection.
		before(async () => {
			admin = await mysql.createConnection(credentials);
			await admin.query(`DROP DATABASE IF EXISTS ${DATABASE}`);
			await admin.query(`CREATE DATABASE ${DATABASE}`);
			await admin.query(`CREATE TABLE ${DATABASE}.items (id INT NOT NULL PRIMARY KEY, code INT NOT NULL) ENGINE=InnoDB`);
			root = mkdtempSync(join(tmpdir(), "heydb-drift-"));
			mkdirSync(join(root, ".heydb"));
		});

		after(async () => {
			try {
				await admin?.query(`DROP DATABASE IF EXISTS ${DATABASE}`);
			} finally {
				await admin?.end();
				if (root) rmSync(root, { recursive: true, force: true });
			}
		});

		test("the first sync writes the snapshot", async () => {
			const result = syncSnapshot(root, "local", await capture());
			assert.equal(result.written, true);
			assert.deepEqual(result.changes, [{ kind: "added", object: "database", target: DATABASE, details: [] }]);
		});

		test("an unchanged database is up to date and sync writes nothing", async () => {
			const live = await capture();
			assert.equal(checkStatus(root, "local", live).state, "up_to_date");
			assert.equal(syncSnapshot(root, "local", live).written, false);
		});

		test("an ALTER is reported as drift with what changed, and sync stores it", async () => {
			await admin.query(`ALTER TABLE ${DATABASE}.items MODIFY code BIGINT NOT NULL`);
			await admin.query(`ALTER TABLE ${DATABASE}.items ADD INDEX idx_code (code)`);
			const live = await capture();

			const status = checkStatus(root, "local", live);
			// Narrows the result type: after this line TypeScript knows `changes` exists.
			if (status.state !== "drifted") assert.fail(`expected drifted, got ${status.state}`);
			const expected = [
				{ kind: "modified", object: "column", target: `${DATABASE}.${DATABASE}.items.code`, details: [target.typeChange] },
				{ kind: "added", object: "index", target: `${DATABASE}.${DATABASE}.items.idx_code`, details: [] },
			];
			assert.deepEqual(status.changes, expected);
			assert.notEqual(status.storedHash, status.liveHash);

			const result = syncSnapshot(root, "local", live);
			assert.equal(result.written, true);
			assert.equal(result.hash, status.liveHash);
			assert.deepEqual(result.changes, expected);
		});

		test("a second identical capture is up to date again and sync writes nothing", async () => {
			const live = await capture();
			assert.equal(checkStatus(root, "local", live).state, "up_to_date");
			assert.deepEqual(syncSnapshot(root, "local", live), { written: false, hash: schemaHash(live), changes: [] });
		});
	});
}
