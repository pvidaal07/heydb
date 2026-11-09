// Runs the token benchmark and prints a markdown report.
//
//   node bench/run.ts                       synthetic legacy ERP (10 companies)
//   node bench/run.ts --companies 50        the same with 50 company databases
//   node bench/run.ts --project ../app --questions questions.json [--connection erp]
//   node bench/run.ts --learn               any of the above, then again after noting
//                                           each answer (on a temporary copy)
//
// --project reads a real heydb project: its stored snapshot and notes, never
// the database. Keep the questions file and the report of a real project out
// of the repository: they name real tables.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { saveConfig } from "../lib/config/store.ts";
import { saveSnapshot } from "../lib/store/snapshots.ts";
import { initProject } from "../lib/usecases/init.ts";
import { LEGACY_ERP_QUESTIONS, legacyErpSnapshot } from "./legacy-erp.ts";
import { type Question, measure, measureLearning, renderLearning, renderReport } from "./measure.ts";

const { values } = parseArgs({
	options: {
		project: { type: "string" },
		connection: { type: "string" },
		questions: { type: "string" },
		companies: { type: "string" },
		json: { type: "boolean", default: false },
		learn: { type: "boolean", default: false },
	},
});

async function main(): Promise<void> {
	if (values.project !== undefined) {
		if (values.questions === undefined) throw new Error("--project needs --questions <file.json>");
		const questions = JSON.parse(readFileSync(values.questions, "utf8")) as Question[];
		await run(values.project, questions, values.connection);
		return;
	}
	const root = mkdtempSync(join(tmpdir(), "heydb-bench-"));
	try {
		initProject(root);
		const erp = { engine: "mysql" as const, host: "127.0.0.1", port: 3306, user: "bench", password: "env:HEYDB_BENCH_PASSWORD", databases: null };
		saveConfig(root, { formatVersion: 1, defaultConnection: "erp", connections: { erp } });
		const companies = values.companies === undefined ? undefined : Number(values.companies);
		saveSnapshot(root, "erp", legacyErpSnapshot(companies === undefined ? {} : { companies }));
		await run(root, LEGACY_ERP_QUESTIONS);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

async function run(cwd: string, questions: readonly Question[], connection?: string): Promise<void> {
	if (values.learn) {
		const learning = await measureLearning(cwd, questions, connection);
		console.log(values.json ? JSON.stringify(learning, null, "\t") : renderLearning(learning));
		return;
	}
	const report = await measure(cwd, questions, connection);
	console.log(values.json ? JSON.stringify(report, null, "\t") : renderReport(report));
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
