// The competitive benchmark: the ways people give an agent knowledge of a
// database, each a strategy under bench/strategies/, run on the same
// questions with the same fixed policy (search with the question's queries in
// order until the expected tables are named, fall back when one never is,
// read the expected tables' definitions). Per strategy: characters the model
// read, calls (model round trips), expected tables found and their rank in
// the first call's output, and the calls' wall-clock time.
//
// Generated files (SCHEMA.md, schema.prisma) go to a temporary folder; the
// measured project and the code folder are only read.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openSnapshot } from "../lib/usecases/project.ts";
import { type LearningReport, type Question, type Report, fixedToolChars, heydbTools, measure, measureLearning, renderLearning, renderReport, tokens } from "./measure.ts";
import { codeGrep } from "./strategies/code-grep.ts";
import { dbMcp } from "./strategies/db-mcp.ts";
import { dbSmart } from "./strategies/db-smart.ts";
import { heydbStrategy } from "./strategies/heydb.ts";
import { infoSchemaColumns, infoSchemaGuided } from "./strategies/info-schema.ts";
import { ormSchema } from "./strategies/orm-schema.ts";
import { schemaDocFull, schemaDocGrep } from "./strategies/schema-doc.ts";
import { type Answer, type Strategy, benchContext } from "./strategies/shared.ts";

export interface CompeteOptions {
	readonly connection?: string;
	/** A code and docs folder for code-grep; without it the strategy is skipped. */
	readonly codeDir?: string;
	/** Adds heydb after noting each answer (measureLearning). */
	readonly learn?: boolean;
}

export interface StrategyRow {
	readonly id: string;
	readonly label: string;
	readonly simulated: boolean;
	readonly answers: readonly Answer[];
	readonly chars: number;
	readonly calls: number;
	/** Expected tables found, of `expected`. */
	readonly seen: number;
	readonly expected: number;
	/** Expected tables first or in the first five of the first call's output; null when a rank has no meaning. */
	readonly top1: number | null;
	readonly top5: number | null;
	readonly ms: number;
}

export interface Comparison {
	readonly connection: string;
	readonly databases: number;
	readonly tables: number;
	readonly columns: number;
	readonly questions: number;
	/** Characters of heydb's tool definitions, sent every turn. */
	readonly fixedChars: number;
	readonly rows: readonly StrategyRow[];
	/** Strategies left out, and why. */
	readonly skipped: readonly string[];
	readonly heydb: Report;
	readonly learning?: LearningReport;
}

export async function compete(cwd: string, questions: readonly Question[], options: CompeteOptions = {}): Promise<Comparison> {
	const learning = options.learn === true ? await measureLearning(cwd, questions, options.connection) : undefined;
	const report = learning?.before ?? (await measure(cwd, questions, options.connection));
	const { snapshot } = openSnapshot(cwd, options.connection);
	const workdir = mkdtempSync(join(tmpdir(), "heydb-bench-compete-"));
	try {
		const ctx = benchContext(snapshot, workdir, options.codeDir);
		const code = codeGrep(ctx);
		const strategies: Strategy[] = [
			heydbStrategy("heydb", "heydb tools", report),
			...(learning === undefined ? [] : [heydbStrategy("heydb-notes", "heydb tools, one note per answer", learning.after)]),
			schemaDocFull(ctx),
			schemaDocGrep(ctx),
			...(code === undefined ? [] : [code]),
			dbSmart(ctx),
			ormSchema(ctx),
			dbMcp(ctx),
			infoSchemaGuided(ctx),
			infoSchemaColumns(ctx),
		];
		const rows: StrategyRow[] = [];
		for (const strategy of strategies) {
			const answers: Answer[] = [];
			for (const question of questions) answers.push(await strategy.run(question));
			rows.push(row(strategy, answers, questions));
		}
		return {
			connection: report.connection,
			databases: report.databases,
			tables: report.tables,
			columns: report.columns,
			questions: questions.length,
			fixedChars: fixedToolChars(heydbTools()),
			rows,
			skipped: code === undefined ? ["code-grep: no --code folder"] : [],
			heydb: report,
			...(learning === undefined ? {} : { learning }),
		};
	} finally {
		rmSync(workdir, { recursive: true, force: true });
	}
}

function row(strategy: Strategy, answers: readonly Answer[], questions: readonly Question[]): StrategyRow {
	const steps = answers.flatMap((answer) => answer.steps);
	const ranked = answers.every((answer) => answer.firstRanks !== null);
	const ranks = answers.flatMap((answer) => answer.firstRanks ?? []);
	const within = (limit: number) => ranks.filter((rank) => rank !== null && rank <= limit).length;
	return {
		id: strategy.id,
		label: strategy.label,
		simulated: strategy.simulated,
		answers,
		chars: steps.reduce((sum, step) => sum + step.chars, 0),
		calls: steps.length,
		seen: answers.reduce((sum, answer) => sum + answer.seen, 0),
		expected: questions.reduce((sum, question) => sum + question.expect.length, 0),
		top1: ranked ? within(1) : null,
		top5: ranked ? within(5) : null,
		ms: steps.reduce((sum, step) => sum + step.ms, 0),
	};
}

const format = (chars: number): string => tokens(chars).toLocaleString("en-US");

export function formatMs(ms: number): string {
	return ms < 10_000 ? `${ms.toFixed(1)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function renderComparison(comparison: Comparison): string {
	const lines = [
		`# Competitive benchmark — ${comparison.connection}`,
		"",
		`${comparison.databases} databases · ${comparison.tables.toLocaleString("en-US")} tables · ${comparison.columns.toLocaleString("en-US")} columns · ${comparison.questions} questions, the same policy for every strategy. Tokens ≈ characters / 4.`,
		"",
		"| strategy | ≈tokens | calls | found | first call: top 1 / top 5 | time |",
		"|---|---|---|---|---|---|",
		...comparison.rows.map((row) => {
			const ranks = row.top1 === null ? "—" : `${row.top1} / ${row.top5}`;
			return `| ${row.id}: ${row.label}${row.simulated ? " *" : ""} | ≈${format(row.chars)} | ${row.calls} | ${row.seen} of ${row.expected} | ${ranks} | ${formatMs(row.ms)} |`;
		}),
		"",
		"- found: expected tables named by what the model read before reading their definitions; from a list of names, only by the name-pick rule (bench/README.md).",
		"- —: the whole schema is in context, a rank means nothing.",
		"- *: a database server simulated over the snapshot; the time is this machine's, a real server adds a network round trip per call.",
		`- Not in the totals: heydb's tool definitions, ≈${format(comparison.fixedChars)} tokens every turn (grep, read and bash come with any agent; a database MCP server's tools cost their own).`,
		...comparison.skipped.map((reason) => `- Skipped: ${reason}.`),
		"",
		comparison.learning === undefined ? renderReport(comparison.heydb) : renderLearning(comparison.learning),
	];
	return lines.join("\n");
}
