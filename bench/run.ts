// Runs the competitive benchmark and prints a markdown report: one table
// comparing every strategy, then heydb's per-question report.
//
//   node bench/run.ts                       synthetic legacy ERP (10 companies) and its code
//   node bench/run.ts --companies 50        the same with 50 company databases
//   node bench/run.ts --scenario small      synthetic small app: one database, 15 tables, and its code
//   node bench/run.ts --project ../app --questions questions.json [--connection erp] [--code ../app/src]
//   node bench/run.ts --learn               any of the above, adding heydb after noting
//                                           each answer (on a temporary copy)
//
// --project reads a real heydb project: its stored snapshot and notes, never
// the database. --code is the folder code-grep searches; without it that
// strategy is skipped. Keep the questions file and the report of a real
// project out of the repository: they name real tables.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { saveConfig } from "../lib/config/store.ts";
import { saveSnapshot } from "../lib/store/snapshots.ts";
import { initProject } from "../lib/usecases/init.ts";
import { compete, renderComparison } from "./compare.ts";
import { LEGACY_ERP_QUESTIONS, legacyErpSnapshot } from "./legacy-erp.ts";
import type { Question } from "./measure.ts";
import { SMALL_APP_QUESTIONS, smallAppSnapshot, writeSmallAppCode } from "./small-app.ts";
import { writeSyntheticCode } from "./synthetic-code.ts";

const { values } = parseArgs({
	options: {
		project: { type: "string" },
		connection: { type: "string" },
		questions: { type: "string" },
		code: { type: "string" },
		companies: { type: "string" },
		scenario: { type: "string", default: "erp" },
		json: { type: "boolean", default: false },
		learn: { type: "boolean", default: false },
	},
});

async function main(): Promise<void> {
	if (values.scenario !== "erp" && values.scenario !== "small") throw new Error("--scenario must be erp or small");
	if (values.project !== undefined) {
		if (values.questions === undefined) throw new Error("--project needs --questions <file.json>");
		const questions = JSON.parse(readFileSync(values.questions, "utf8")) as Question[];
		await run(values.project, questions, values.connection, values.code);
		return;
	}
	const root = mkdtempSync(join(tmpdir(), "heydb-bench-"));
	try {
		initProject(root);
		const small = values.scenario === "small";
		const connection = small ? "app" : "erp";
		const server = { engine: "mysql" as const, host: "127.0.0.1", port: 3306, user: "bench", password: "env:HEYDB_BENCH_PASSWORD", databases: null };
		saveConfig(root, { formatVersion: 1, defaultConnection: connection, connections: { [connection]: server } });
		const companies = values.companies === undefined ? undefined : Number(values.companies);
		saveSnapshot(root, connection, small ? smallAppSnapshot() : legacyErpSnapshot(companies === undefined ? {} : { companies }));
		const code = values.code ?? join(root, "src");
		if (values.code === undefined) (small ? writeSmallAppCode : writeSyntheticCode)(code);
		await run(root, small ? SMALL_APP_QUESTIONS : LEGACY_ERP_QUESTIONS, undefined, code);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

async function run(cwd: string, questions: readonly Question[], connection?: string, codeDir?: string): Promise<void> {
	const comparison = await compete(cwd, questions, {
		...(connection === undefined ? {} : { connection }),
		...(codeDir === undefined ? {} : { codeDir }),
		learn: values.learn,
	});
	console.log(values.json ? JSON.stringify(comparison, null, "\t") : renderComparison(comparison));
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
