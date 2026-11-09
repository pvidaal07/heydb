import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { LEGACY_ERP_QUESTIONS, legacyErpSnapshot } from "../bench/legacy-erp.ts";
import { columnsDump, measure, measureLearning, renderLearning, renderReport } from "../bench/measure.ts";
import { saveConfig } from "../lib/config/store.ts";
import { emptyKnowledge } from "../lib/knowledge/operations.ts";
import { searchSchema } from "../lib/search.ts";
import { knowledgePath } from "../lib/store/knowledge.ts";
import { saveSnapshot } from "../lib/store/snapshots.ts";
import { initProject } from "../lib/usecases/init.ts";
import { customersTable } from "./fixtures/snapshot.ts";

// The benchmark is a tool for people, not part of the package; these tests
// only keep it running and honest as the code it measures changes.

describe("the token benchmark", () => {
	const root = mkdtempSync(join(tmpdir(), "heydb-bench-test-"));
	after(() => rmSync(root, { recursive: true, force: true }));
	initProject(root);
	const erp = { engine: "mysql" as const, host: "127.0.0.1", port: 3306, user: "bench", password: "env:HEYDB_BENCH_PASSWORD", databases: null };
	saveConfig(root, { formatVersion: 1, defaultConnection: "erp", connections: { erp } });
	saveSnapshot(root, "erp", legacyErpSnapshot({ companies: 2, fillerTables: 6 }));

	test("builds a schema with one database per company", () => {
		const snapshot = legacyErpSnapshot({ companies: 3, fillerTables: 6 });
		assert.deepEqual(
			snapshot.databases.map((database) => database.name),
			["emp_001", "emp_002", "emp_003"],
		);
		const names = snapshot.databases[0]!.schemas[0]!.tables.map((table) => table.name);
		for (const question of LEGACY_ERP_QUESTIONS) {
			for (const expected of question.expect) assert.ok(names.includes(expected), `${question.id}: ${expected}`);
		}
	});

	test("ends every question reading the expected tables, and counts what the tools returned", async () => {
		const report = await measure(root, LEGACY_ERP_QUESTIONS);
		assert.equal(report.connection, "erp");
		assert.equal(report.databases, 2);
		assert.equal(report.questions.length, LEGACY_ERP_QUESTIONS.length);
		for (const [index, result] of report.questions.entries()) {
			const question = LEGACY_ERP_QUESTIONS[index]!;
			const read = result.steps.filter((step) => step.tool === "heydb_table").map((step) => step.args.split(".").at(-1));
			assert.deepEqual(read, question.expect, question.id);
			assert.equal(result.steps[0]?.tool, "heydb_search", question.id);
			assert.equal(result.found, !result.steps.some((step) => step.tool === "heydb_overview"), question.id);
			assert.equal(result.chars, result.steps.reduce((sum, step) => sum + step.chars, 0));
			assert.ok(result.steps.every((step) => step.chars > 0));
			assert.ok(result.guidedChars > 0);
		}
		assert.ok(report.fixedChars > 1000);
		assert.ok(report.fullDumpChars > report.overviewChars);
		const text = renderReport(report);
		assert.match(text, /^# heydb token benchmark — erp\n/);
		assert.match(text, /\| heydb, all questions \| ≈[\d,]+ tokens \|/);
		assert.match(text, /\| first search: expected table in top 1 \/ top 5 \/ anywhere \| \d+ \/ \d+ \/ \d+ of 11 \|/);
	});

	test("the learning loop notes each answer on a copy and finds every expected table first time after", async () => {
		const learning = await measureLearning(root, LEGACY_ERP_QUESTIONS);
		const expected = LEGACY_ERP_QUESTIONS.reduce((sum, question) => sum + question.expect.length, 0);
		assert.equal(learning.notes, expected);
		assert.equal(existsSync(knowledgePath(root, "erp")), false, "the measured project was written");
		assert.deepEqual(
			learning.before.questions.map((question) => question.chars),
			(await measure(root, LEGACY_ERP_QUESTIONS)).questions.map((question) => question.chars),
		);
		for (const question of learning.after.questions) {
			assert.equal(question.found, true, question.id);
			assert.ok(question.firstRanks.every((rank) => rank !== null && rank <= 5), `${question.id}: ${question.firstRanks.join(", ")}`);
		}
		const text = renderLearning(learning);
		assert.match(text, /^# heydb learning loop — erp\n/);
		assert.match(text, /\| questions that needed the overview \| \d+ of 10 \| 0 of 10 \|/);
	});

	test("copies of the module tables no longer push fac_cab out of the top results", () => {
		const erp = legacyErpSnapshot({ companies: 2 });
		const found = searchSchema(erp, emptyKnowledge(), "facturas pendientes de cobro", { limit: 10 }).results;
		const names = found.map((result) => result.target.split(".").at(-1));
		assert.ok(names.includes("fac_cab"), names.join("\n"));
		const facCab = found.find((result) => result.target === "emp_001.emp_001.fac_cab");
		assert.deepEqual(
			facCab?.copies?.filter((name) => name.startsWith("fac_cab_")),
			["fac_cab_2019", "fac_cab_2020", "fac_cab_2021"],
		);
		assert.deepEqual(facCab?.alsoIn, ["emp_002"]);
	});

	test("prints information_schema columns as mysql --batch does", () => {
		const table = customersTable();
		const dump = columnsDump([{ schema: "shop", name: "shop.shop.customers", table }], true);
		assert.equal(
			dump,
			"TABLE_SCHEMA\tTABLE_NAME\tCOLUMN_NAME\tCOLUMN_TYPE\tCOLUMN_KEY\tCOLUMN_COMMENT\nshop\tcustomers\tid\tint\tPRI\t\nshop\tcustomers\temail\tvarchar(255)\t\t",
		);
	});
});
