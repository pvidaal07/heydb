import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { promisify } from "node:util";

import type { Comparison } from "../../bench/compare.ts";
import { compete } from "../../bench/compare.ts";
import { allTables, matches } from "../../bench/measure.ts";
import { SMALL_APP_QUESTIONS, smallAppSnapshot, writeSmallAppCode } from "../../bench/small-app.ts";
import { saveConfig } from "../../lib/config/store.ts";
import { loadSnapshot, saveSnapshot } from "../../lib/store/snapshots.ts";
import { initProject } from "../../lib/usecases/init.ts";

const REPO = resolve(import.meta.dirname, "..", "..");
const run = promisify(execFile);

const scratch: string[] = [];
after(() => {
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function project(): string {
	const root = mkdtempSync(join(tmpdir(), "heydb-bench-small-"));
	scratch.push(root);
	initProject(root);
	const app = { engine: "mysql" as const, host: "127.0.0.1", port: 3306, user: "bench", password: "env:HEYDB_BENCH_PASSWORD", databases: null };
	saveConfig(root, { formatVersion: 1, defaultConnection: "app", connections: { app } });
	saveSnapshot(root, "app", smallAppSnapshot());
	return root;
}

describe("the small-app scenario", () => {
	test("is one InnoDB database of 12 to 15 tables that heydb stores and loads back unchanged", () => {
		const root = project();
		const loaded = loadSnapshot(root, "app");
		assert.ok(loaded !== null);
		assert.deepEqual(loaded, smallAppSnapshot());
		assert.deepEqual(
			loaded.databases.map((database) => database.name),
			["shop"],
		);
		const tables = allTables(loaded);
		assert.ok(tables.length >= 12 && tables.length <= 15, `${tables.length} tables`);
		for (const { table } of tables) assert.equal(table.storageEngine, "InnoDB", table.name);
		// Same input, same schema: two runs compare tools, not data.
		assert.deepEqual(smallAppSnapshot(), smallAppSnapshot());
	});

	test("has a few comments, not most, and declares foreign keys to tables and columns that exist", () => {
		const tables = allTables(smallAppSnapshot());
		const commented = tables.filter(({ table }) => table.comment !== "").length;
		assert.ok(commented >= 2 && commented < tables.length / 2, `${commented} table comments`);
		const columns = tables.flatMap(({ table }) => table.columns);
		const columnComments = columns.filter((column) => column.comment !== "").length;
		assert.ok(columnComments >= 2 && columnComments < columns.length / 4, `${columnComments} column comments`);
		const keys = tables.flatMap(({ table }) => table.foreignKeys.map((key) => ({ table, key })));
		assert.ok(keys.length >= 10, `${keys.length} foreign keys`);
		for (const { table, key } of keys) {
			const target = tables.find((entry) => entry.table.name === key.references.table && entry.schema === key.references.schema);
			assert.ok(target !== undefined, `${table.name}.${key.name} points to ${key.references.table}`);
			for (const name of key.columns) assert.ok(table.columns.some((column) => column.name === name), `${table.name}.${name}`);
			for (const name of key.references.columns) assert.ok(target.table.columns.some((column) => column.name === name), `${key.references.table}.${name}`);
		}
	});

	test("asks about ten questions, mostly in English, each expecting tables that exist", () => {
		const tables = allTables(smallAppSnapshot());
		assert.ok(SMALL_APP_QUESTIONS.length >= 9 && SMALL_APP_QUESTIONS.length <= 12);
		assert.equal(new Set(SMALL_APP_QUESTIONS.map((question) => question.id)).size, SMALL_APP_QUESTIONS.length);
		for (const question of SMALL_APP_QUESTIONS) {
			assert.ok(question.ask.length > 0 && question.queries.length > 0 && question.expect.length > 0, question.id);
			for (const expected of question.expect) assert.equal(tables.filter((entry) => matches(entry.name, expected)).length, 1, `${question.id}: ${expected}`);
		}
		const spanish = SMALL_APP_QUESTIONS.filter((question) => /[áéíóúñ¿]|\b(de|un|una|del)\b/i.test(question.ask));
		assert.ok(spanish.length >= 2 && spanish.length <= 3, `${spanish.length} in Spanish`);
		assert.ok(SMALL_APP_QUESTIONS.some((question) => question.expect.length === 2));
	});

	test("comes with a small code tree that names its tables", () => {
		const dir = mkdtempSync(join(tmpdir(), "heydb-bench-small-code-"));
		scratch.push(dir);
		writeSmallAppCode(dir);
		const models = readFileSync(join(dir, "src", "models.ts"), "utf8");
		assert.match(models, /"coupons"/);
		assert.match(readFileSync(join(dir, "README.md"), "utf8"), /## Database/);
	});

	test("runs the simulated comparison end to end", async () => {
		const root = project();
		const code = join(root, "src-tree");
		writeSmallAppCode(code);
		const comparison = await compete(root, SMALL_APP_QUESTIONS, { codeDir: code, learn: true });
		assert.equal(comparison.databases, 1);
		assert.equal(comparison.questions, SMALL_APP_QUESTIONS.length);
		const ids = comparison.rows.map((row) => row.id);
		for (const id of ["heydb", "heydb-notes", "code-grep", "db-smart", "db-mcp"]) assert.ok(ids.includes(id), id);
		const expected = SMALL_APP_QUESTIONS.reduce((sum, question) => sum + question.expect.length, 0);
		for (const row of comparison.rows) assert.equal(row.expected, expected, row.id);
	});
});

describe("bench/run.ts --scenario", () => {
	test("small runs the comparison on the small app", async () => {
		const { stdout } = await run(process.execPath, ["bench/run.ts", "--scenario", "small", "--json"], { cwd: REPO });
		const comparison = JSON.parse(stdout) as Comparison;
		assert.equal(comparison.databases, 1);
		assert.equal(comparison.tables, allTables(smallAppSnapshot()).length);
		assert.equal(comparison.questions, SMALL_APP_QUESTIONS.length);
		assert.ok(comparison.rows.some((row) => row.id === "code-grep"));
	});

	test("erp, the default, still runs the synthetic legacy ERP", async () => {
		const { stdout } = await run(process.execPath, ["bench/run.ts", "--json"], { cwd: REPO });
		const comparison = JSON.parse(stdout) as Comparison;
		assert.equal(comparison.connection, "erp");
		assert.equal(comparison.databases, 10);
		assert.equal(comparison.questions, 10);
	});

	test("bench/agent/run.ts --scenario small plans its runs on the small app, and stops without --yes", async () => {
		const { stderr } = await run(process.execPath, ["bench/agent/run.ts", "--scenario", "small", "--strategies", "heydb,code"], { cwd: REPO });
		const tables = allTables(smallAppSnapshot());
		const columns = tables.reduce((sum, entry) => sum + entry.table.columns.length, 0);
		assert.match(stderr, new RegExp(`^synthetic small app: 1 databases, ${tables.length} tables, ${columns} columns$`, "m"));
		assert.match(stderr, new RegExp(`× ${SMALL_APP_QUESTIONS.length} questions × 1 repeat`));
		assert.match(stderr, /^not started: add --yes/m);
	});

	test("an unknown scenario is refused", async () => {
		await assert.rejects(run(process.execPath, ["bench/run.ts", "--scenario", "huge"], { cwd: REPO }), (error: { code: number; stderr: string }) => {
			assert.equal(error.code, 1);
			assert.equal(error.stderr.trim(), "--scenario must be erp or small");
			return true;
		});
	});
});
