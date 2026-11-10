// The real-agent benchmark: a real model inside Pi answers each question with
// exactly one strategy's tools, and every run records what the provider says
// it spent and whether the model named the expected tables.
//
//   node bench/agent/run.ts [--limit 2]               synthetic legacy ERP and its code (a pilot)
//   node bench/agent/run.ts --scenario small [--limit 2]   synthetic small app (one database) and its code
//   node bench/agent/run.ts --project ../app --questions q.json [--connection erp] [--code ../app/src]
//   options: --strategies heydb,code,db  --model claude-bridge/claude-sonnet-5-5  --thinking low
//            --timeout 300  --repeat 3  --out <dir>  --resume  --yes  --estimate-from <runs.jsonl>
//            --provider-extension <file>  --pi <bin>  --mysql-image mysql:8.0  --companies 10
//   node bench/agent/run.ts --report <dir>            render report.md again from <dir>/runs.jsonl
//
// Costs real tokens: without --yes it prints the plan and stops, unless it is
// a pilot (--limit 3 or fewer, one repeat). Results go to --out (by default a
// new temporary folder): runs.jsonl, one line per run, written as it goes,
// meta.json and report.md. A real project's questions and runs.jsonl name
// real tables: keep them out of this repository.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { saveConfig } from "../../lib/config/store.ts";
import { saveSnapshot } from "../../lib/store/snapshots.ts";
import { initProject } from "../../lib/usecases/init.ts";
import { openSnapshot } from "../../lib/usecases/project.ts";
import { LEGACY_ERP_QUESTIONS, legacyErpSnapshot } from "../legacy-erp.ts";
import { type Question, allTables } from "../measure.ts";
import { SMALL_APP_QUESTIONS, smallAppSnapshot, writeSmallAppCode } from "../small-app.ts";
import { writeSyntheticCode } from "../synthetic-code.ts";
import { schemaDdl } from "./ddl.ts";
import { parseEvents } from "./events.ts";
import { judge, tablesLine } from "./judge.ts";
import { type LoadStats, type MysqlServer, createReader, dockerProblem, loadSchema, startMysql } from "./mysql.ts";
import { piArgs, runProcess } from "./pi.ts";
import type { Probe } from "./probe.ts";
import { type ReportMeta, type RunRecord, renderReport, tokensText } from "./report.ts";
import { STRATEGIES, type StrategyId, type Workspace, prepareWorkspace } from "./workspace.ts";

const REPO = resolve(import.meta.dirname, "..", "..");
const PILOT_QUESTIONS = 3;

const { values } = parseArgs({
	options: {
		project: { type: "string" },
		connection: { type: "string" },
		questions: { type: "string" },
		code: { type: "string" },
		companies: { type: "string" },
		scenario: { type: "string", default: "erp" },
		strategies: { type: "string" },
		model: { type: "string", default: "claude-bridge/claude-haiku-5-5" },
		thinking: { type: "string", default: "low" },
		timeout: { type: "string", default: "300" },
		limit: { type: "string" },
		repeat: { type: "string", default: "1" },
		out: { type: "string" },
		resume: { type: "boolean", default: false },
		yes: { type: "boolean", default: false },
		"estimate-from": { type: "string" },
		"provider-extension": { type: "string" },
		pi: { type: "string", default: "pi" },
		"mysql-image": { type: "string", default: "mysql:8.0" },
		report: { type: "string" },
	},
});

interface Meta extends ReportMeta {
	readonly strategies: readonly string[];
	readonly repeats: number;
	readonly piVersion: string;
	readonly providerExtension: string | null;
	readonly startedAt: string;
}

/** Cleanup that must run however the process ends: the container above all. */
const cleanups: (() => Promise<void> | void)[] = [];
async function cleanup(): Promise<void> {
	for (const step of cleanups.splice(0).reverse()) await step();
}
process.on("SIGINT", () => {
	console.error("\ninterrupted: cleaning up");
	void cleanup().finally(() => process.exit(130));
});

function positive(name: string, value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const number = Number(value);
	if (!Number.isInteger(number) || number < 1) throw new Error(`--${name} must be a positive integer`);
	return number;
}

async function main(): Promise<void> {
	if (values.report !== undefined) {
		const dir = resolve(values.report);
		const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as Meta;
		const report = renderReport(readRecords(join(dir, "runs.jsonl")), meta);
		writeFileSync(join(dir, "report.md"), `${report}\n`);
		console.log(report);
		return;
	}
	if (values.scenario !== "erp" && values.scenario !== "small") throw new Error("--scenario must be erp or small");
	const limit = positive("limit", values.limit);
	const repeats = positive("repeat", values.repeat) ?? 1;
	const timeoutSeconds = positive("timeout", values.timeout) ?? 300;
	const companies = positive("companies", values.companies);

	// The measured project: a real one, only read, or the synthetic ERP or small app in a temporary folder.
	let root: string;
	let codeDir: string | undefined;
	let questions: readonly Question[];
	let dataset: string;
	if (values.project !== undefined) {
		if (values.questions === undefined) throw new Error("--project needs --questions <file.json>");
		root = resolve(values.project);
		codeDir = values.code === undefined ? undefined : resolve(values.code);
		questions = JSON.parse(readFileSync(values.questions, "utf8")) as Question[];
		dataset = "project";
	} else {
		root = mkdtempSync(join(tmpdir(), "heydb-agent-erp-"));
		const synthetic = root;
		cleanups.push(() => rmSync(synthetic, { recursive: true, force: true }));
		initProject(root);
		const small = values.scenario === "small";
		const connection = small ? "app" : "erp";
		const server = { engine: "mysql" as const, host: "127.0.0.1", port: 3306, user: "bench", password: "env:HEYDB_BENCH_PASSWORD", databases: null };
		saveConfig(root, { formatVersion: 1, defaultConnection: connection, connections: { [connection]: server } });
		saveSnapshot(root, connection, small ? smallAppSnapshot() : legacyErpSnapshot(companies === undefined ? {} : { companies }));
		codeDir = values.code === undefined ? join(root, "src") : resolve(values.code);
		if (values.code === undefined) (small ? writeSmallAppCode : writeSyntheticCode)(codeDir);
		questions = small ? SMALL_APP_QUESTIONS : LEGACY_ERP_QUESTIONS;
		dataset = small ? "synthetic small app" : "synthetic legacy ERP";
	}
	if (limit !== undefined) questions = questions.slice(0, limit);
	const { snapshot } = openSnapshot(root, values.connection);
	const tables = allTables(snapshot);
	const databases = new Set(tables.map((entry) => entry.schema)).size;
	const columns = tables.reduce((total, entry) => total + entry.table.columns.length, 0);
	dataset = `${dataset}: ${databases} databases, ${tables.length.toLocaleString("en-US")} tables, ${columns.toLocaleString("en-US")} columns`;

	// Strategies, and why any is left out.
	const requested = (values.strategies?.split(",").map((id) => id.trim()) ?? [...STRATEGIES]) as StrategyId[];
	for (const id of requested) if (!STRATEGIES.includes(id)) throw new Error(`unknown strategy ${id}; known: ${STRATEGIES.join(", ")}`);
	const skipped: string[] = [];
	let strategies = requested.filter((id) => {
		if (id === "code" && codeDir === undefined) skipped.push("code: no --code folder");
		else return true;
		return false;
	});
	const wantsDb = strategies.some((id) => id === "db" || id === "db-mcp");
	if (wantsDb) {
		const problem = snapshot.engine.kind === "postgresql" ? "the snapshot is PostgreSQL; the schema-only server is MySQL" : await dockerProblem();
		if (problem !== null) {
			for (const id of strategies.filter((id) => id === "db" || id === "db-mcp")) skipped.push(`${id}: ${problem}`);
			strategies = strategies.filter((id) => id !== "db" && id !== "db-mcp");
		}
	}
	if (strategies.length === 0) throw new Error(`no strategy left to run (${skipped.join("; ")})`);

	// The plan, and what it may cost.
	const runs = strategies.length * questions.length * repeats;
	console.error(`${dataset}`);
	console.error(`plan: ${strategies.length} strategies (${strategies.join(", ")}) × ${questions.length} questions × ${repeats} ${repeats === 1 ? "repeat" : "repeats"} = ${runs} runs, model ${values.model}, thinking ${values.thinking}, timeout ${timeoutSeconds} s`);
	for (const reason of skipped) console.error(`skipped: ${reason}`);
	const estimate = values["estimate-from"] === undefined ? null : estimateFrom(readRecords(values["estimate-from"]), strategies, questions.length * repeats);
	if (estimate !== null) console.error(estimate);
	else console.error(`no estimate: run a pilot (--limit 2) and pass its runs.jsonl with --estimate-from`);
	const pilot = limit !== undefined && limit <= PILOT_QUESTIONS && repeats === 1;
	if (!values.yes && !pilot) {
		console.error(`not started: add --yes to run it (a pilot with --limit ${PILOT_QUESTIONS} or fewer and one repeat needs none)`);
		await cleanup();
		return;
	}

	const providerExtension = values["provider-extension"] ?? process.env.HEYDB_BENCH_PROVIDER_EXTENSION ?? discoverProvider(values.model);
	const out = resolve(values.out ?? mkdtempSync(join(tmpdir(), "heydb-agent-results-")));
	mkdirSync(out, { recursive: true });
	const runsPath = join(out, "runs.jsonl");
	if (existsSync(runsPath) && !values.resume) throw new Error(`${runsPath} exists: pass --resume to continue it, or another --out`);
	const done = new Set(existsSync(runsPath) ? readRecords(runsPath).map(runKey) : []);
	const piVersion = (await runProcess(values.pi, ["--version"], { cwd: tmpdir(), env: process.env, timeoutMs: 30_000 })).stdout.trim();

	// One workspace per strategy, prepared once.
	const scratch = mkdtempSync(join(tmpdir(), "heydb-agent-ws-"));
	cleanups.push(() => rmSync(scratch, { recursive: true, force: true }));
	const source = { root, ...(values.connection === undefined ? {} : { connection: values.connection }), ...(codeDir === undefined ? {} : { codeDir }), questions, repo: REPO };
	const workspaces = new Map<StrategyId, Workspace>();
	for (const id of strategies) workspaces.set(id, await prepareWorkspace(id, source, join(scratch, id)));
	const notes: string[] = [];
	const noted = workspaces.get("heydb-notes")?.notes;
	if (noted !== undefined) notes.push(`heydb-notes: ${noted} notes, one per expected table with the question as asked (the upper bound of what notes buy).`);

	// The schema-only server for the database strategies.
	let dbEnv: Record<string, string> = {};
	if (strategies.includes("db") || strategies.includes("db-mcp")) {
		console.error(`starting ${values["mysql-image"]} in docker…`);
		const server: MysqlServer = await startMysql(values["mysql-image"]);
		cleanups.push(() => server.stop());
		console.error(`loading the schema into ${server.container} (port ${server.port})…`);
		const plan = schemaDdl(snapshot);
		const stats: LoadStats = await loadSchema(server, plan, (count, total) => console.error(`  ${count} of ${total} statements`));
		const reader = await createReader(server, plan.databases);
		dbEnv = { HEYDB_BENCH_DB: JSON.stringify({ host: server.host, port: server.port, user: reader.user, password: reader.password, databases: plan.databases }) };
		notes.push(
			`Database server: ${values["mysql-image"]}, schema only (no rows): ${stats.databases} databases, ${stats.tables} tables (${stats.simplified} without defaults or secondary indexes), ${stats.views} views, ${stats.foreignKeys} foreign keys; ${stats.skipped.length} objects skipped.`,
		);
		if (stats.skipped.length > 0) writeFileSync(join(out, "ddl-skipped.json"), `${JSON.stringify(stats.skipped, null, "\t")}\n`);
	}

	const meta: Meta = {
		model: values.model,
		thinking: values.thinking,
		timeoutSeconds,
		questions: questions.length,
		dataset,
		skipped,
		notes,
		strategies,
		repeats,
		piVersion,
		providerExtension: providerExtension ?? null,
		startedAt: new Date().toISOString(),
	};
	writeFileSync(join(out, "meta.json"), `${JSON.stringify(meta, null, "\t")}\n`);
	console.error(`results: ${out}`);

	// Sequential runs; per question every strategy in turn, so time-dependent effects spread evenly.
	let count = 0;
	for (let repeat = 1; repeat <= repeats; repeat += 1) {
		for (const question of questions) {
			for (const id of strategies) {
				count += 1;
				if (done.has(runKey({ strategy: id, question: question.id, repeat }))) continue;
				const workspace = workspaces.get(id)!;
				const record = await runOne(workspace, question, repeat, { providerExtension, timeoutSeconds, scratch, dbEnv, mode: id === "db" ? "sql" : id === "db-mcp" ? "mcp" : undefined });
				appendFileSync(runsPath, `${JSON.stringify(record)}\n`);
				const verdict = record.error !== null ? `error: ${record.error}` : record.correct ? "correct" : `${record.hits}/${record.expected}`;
				console.error(`[${count}/${runs}] ${id} ${question.id} #${repeat}: ${tokensText(record.usage.total)} tokens, ${Object.values(record.toolCalls).reduce((a, b) => a + b, 0)} calls, ${(record.ms / 1000).toFixed(1)} s, ${verdict}`);
			}
		}
	}

	const report = renderReport(readRecords(runsPath), meta);
	writeFileSync(join(out, "report.md"), `${report}\n`);
	console.log(report);
}

interface RunOptions {
	readonly providerExtension: string | undefined;
	readonly timeoutSeconds: number;
	readonly scratch: string;
	readonly dbEnv: Record<string, string>;
	readonly mode: "sql" | "mcp" | undefined;
}

async function runOne(workspace: Workspace, question: Question, repeat: number, options: RunOptions): Promise<RunRecord> {
	const probePath = join(options.scratch, `probe-${workspace.strategy}-${question.id}-${repeat}.json`);
	rmSync(probePath, { force: true });
	const extensions = [...(options.providerExtension === undefined ? [] : [options.providerExtension]), ...workspace.extensions, join(REPO, "bench", "agent", "probe.ts")];
	const args = piArgs({ model: values.model, thinking: values.thinking, extensions, tools: workspace.tools, prompt: question.ask });
	const env = { ...process.env, HEYDB_BENCH_PROBE: probePath, ...(options.mode === undefined ? {} : { ...options.dbEnv, HEYDB_BENCH_DB_TOOLS: options.mode }) };
	const result = await runProcess(values.pi, args, { cwd: workspace.dir, env, timeoutMs: options.timeoutSeconds * 1000 });
	const parsed = parseEvents(result.stdout);
	const named = tablesLine(parsed.finalText);
	const verdict = judge(named, question.expect);
	const line = parsed.finalText.split(/\r?\n/).filter((text) => /TABLES\s*:/i.test(text)).at(-1) ?? null;
	let error: string | null = null;
	if (result.timedOut) error = `timeout after ${options.timeoutSeconds} s`;
	else if (parsed.errors.length > 0) error = parsed.errors.join("; ");
	else if (result.code !== 0) error = `pi exited with ${result.code}: ${result.stderr.trim().slice(-300)}`;
	else if (parsed.turns === 0) error = `no assistant message: ${result.stderr.trim().slice(-300)}`;
	let probe: Probe | null = null;
	try {
		probe = JSON.parse(readFileSync(probePath, "utf8")) as Probe;
	} catch {
		probe = null;
	}
	return {
		strategy: workspace.strategy,
		question: question.id,
		repeat,
		model: values.model,
		usage: parsed.usage,
		toolCalls: parsed.toolCalls,
		toolErrors: parsed.toolErrors,
		turns: parsed.turns,
		ms: Math.round(result.ms),
		tablesLine: line,
		named,
		...verdict,
		firstContext: parsed.firstContext,
		error,
		probe,
	};
}

const runKey = (record: Pick<RunRecord, "strategy" | "question" | "repeat">): string => `${record.strategy}\u0000${record.question}\u0000${record.repeat}`;

function readRecords(path: string): RunRecord[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as RunRecord);
}

/** Tokens per run of each strategy in a pilot, times the runs planned. */
function estimateFrom(pilot: readonly RunRecord[], strategies: readonly string[], runsPerStrategy: number): string {
	const lines = ["estimate from the pilot (mean tokens per run × runs):"];
	let total = 0;
	for (const id of strategies) {
		const runs = pilot.filter((record) => record.strategy === id);
		if (runs.length === 0) {
			lines.push(`  ${id}: no pilot runs`);
			continue;
		}
		const perRun = runs.reduce((sum, record) => sum + record.usage.total, 0) / runs.length;
		total += perRun * runsPerStrategy;
		lines.push(`  ${id}: ${tokensText(perRun)} per run × ${runsPerStrategy} = ${tokensText(perRun * runsPerStrategy)}`);
	}
	lines.push(`  total ${tokensText(total)} tokens (input, output and cache, as reported)`);
	return lines.join("\n");
}

/** The pi-claude-bridge extension installed by Pi, for claude-bridge/ models; undefined for other providers. */
function discoverProvider(model: string): string | undefined {
	if (!model.startsWith("claude-bridge/")) return undefined;
	const folder = join(homedir(), ".pi", "agent", "npm", "node_modules", "pi-claude-bridge");
	try {
		const manifest = JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) as { pi?: { extensions?: string[] } };
		const entry = manifest.pi?.extensions?.[0];
		if (entry !== undefined) return join(folder, entry);
	} catch {
		// not installed there
	}
	throw new Error("claude-bridge models need the pi-claude-bridge extension: pass --provider-extension <its entry file>");
}

main()
	.catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	})
	.finally(() => cleanup());
