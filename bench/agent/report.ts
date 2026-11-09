// What the real-agent benchmark keeps per run (one JSON line in runs.jsonl)
// and the markdown report built from those lines. Every comparison between
// two strategies is made over the questions both answered, so a strategy that
// skipped or never reached a question is not compared on it.
import type { RunUsage } from "./events.ts";
import type { Probe } from "./probe.ts";

export interface RunRecord {
	readonly strategy: string;
	readonly question: string;
	/** 1-based. */
	readonly repeat: number;
	readonly model: string;
	readonly usage: RunUsage;
	readonly toolCalls: Readonly<Record<string, number>>;
	readonly toolErrors: number;
	/** Model round trips. */
	readonly turns: number;
	/** Wall clock of the whole run, Pi's start included. */
	readonly ms: number;
	/** The reply's TABLES line as written; null when there was none. */
	readonly tablesLine: string | null;
	readonly named: readonly string[] | null;
	readonly correct: boolean;
	readonly hits: number;
	readonly expected: number;
	readonly extra: number;
	/** Context of the first model call: system prompt, tool definitions and question. */
	readonly firstContext: number | null;
	/** Timeout, provider error or Pi failure; null when the run ended normally. */
	readonly error: string | null;
	/** What the model was given, as the probe extension saw it. */
	readonly probe: Probe | null;
}

export interface StrategySummary {
	readonly strategy: string;
	readonly runs: number;
	readonly questions: number;
	readonly tokens: RunUsage;
	readonly toolCalls: number;
	readonly toolCallsByName: Readonly<Record<string, number>>;
	readonly turns: number;
	readonly ms: number;
	readonly correct: number;
	readonly hits: number;
	readonly expected: number;
	readonly extra: number;
	readonly errors: number;
	/** Total tokens of each repeat over its questions. */
	readonly perRepeat: { readonly mean: number; readonly min: number; readonly max: number };
	readonly firstContext: number | null;
	readonly tools: readonly string[];
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
const mean = (values: readonly number[]): number => (values.length === 0 ? 0 : sum(values) / values.length);

/** One summary per strategy, in the order strategies first appear. */
export function summarize(records: readonly RunRecord[]): StrategySummary[] {
	const strategies = [...new Set(records.map((record) => record.strategy))];
	return strategies.map((strategy) => {
		const runs = records.filter((record) => record.strategy === strategy);
		const byName: Record<string, number> = {};
		for (const run of runs) for (const [name, count] of Object.entries(run.toolCalls)) byName[name] = (byName[name] ?? 0) + count;
		const repeats = [...new Set(runs.map((run) => run.repeat))].map((repeat) => sum(runs.filter((run) => run.repeat === repeat).map((run) => run.usage.total)));
		const contexts = runs.flatMap((run) => (run.firstContext === null ? [] : [run.firstContext]));
		const field = (key: keyof RunUsage) => sum(runs.map((run) => run.usage[key]));
		return {
			strategy,
			runs: runs.length,
			questions: new Set(runs.map((run) => run.question)).size,
			tokens: { input: field("input"), output: field("output"), cacheRead: field("cacheRead"), cacheWrite: field("cacheWrite"), total: field("total") },
			toolCalls: sum(Object.values(byName)),
			toolCallsByName: byName,
			turns: sum(runs.map((run) => run.turns)),
			ms: sum(runs.map((run) => run.ms)),
			correct: runs.filter((run) => run.correct).length,
			hits: sum(runs.map((run) => run.hits)),
			expected: sum(runs.map((run) => run.expected)),
			extra: sum(runs.map((run) => run.extra)),
			errors: runs.filter((run) => run.error !== null).length,
			perRepeat: { mean: mean(repeats), min: Math.min(...repeats), max: Math.max(...repeats) },
			firstContext: contexts.length === 0 ? null : mean(contexts),
			tools: runs.find((run) => run.probe !== null)?.probe?.activeTools ?? [],
		};
	});
}

export interface TokenComparison {
	/** Questions both strategies answered. */
	readonly questions: number;
	/** Total tokens of each over those questions, each question the mean of its repeats. */
	readonly a: number;
	readonly b: number;
	/** How many percent fewer tokens `a` used than `b`; negative when it used more. */
	readonly percent: number;
}

export function compareTokens(records: readonly RunRecord[], a: string, b: string): TokenComparison | null {
	const perQuestion = (strategy: string) => {
		const totals = new Map<string, number[]>();
		for (const record of records) if (record.strategy === strategy) totals.set(record.question, [...(totals.get(record.question) ?? []), record.usage.total]);
		return new Map([...totals].map(([question, values]) => [question, mean(values)]));
	};
	const [first, second] = [perQuestion(a), perQuestion(b)];
	const common = [...first.keys()].filter((question) => second.has(question));
	if (common.length === 0) return null;
	const totalA = sum(common.map((question) => first.get(question)!));
	const totalB = sum(common.map((question) => second.get(question)!));
	if (totalB === 0) return null;
	return { questions: common.length, a: totalA, b: totalB, percent: (1 - totalA / totalB) * 100 };
}

export interface ReportMeta {
	readonly model: string;
	readonly thinking: string;
	readonly timeoutSeconds: number;
	readonly questions: number;
	/** One line describing what was measured, e.g. "synthetic ERP: 10 databases, 2,560 tables". */
	readonly dataset?: string;
	/** Strategies left out, and why. */
	readonly skipped?: readonly string[];
	/** Notes on how the database strategies' server was built. */
	readonly notes?: readonly string[];
}

export function tokensText(value: number): string {
	const rounded = Math.round(value);
	if (rounded < 1000) return `≈${rounded}`;
	if (rounded < 1_000_000) return `≈${(rounded / 1000).toFixed(1)}k`;
	return `≈${(rounded / 1_000_000).toFixed(2)}M`;
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
const HEYDB = ["heydb", "heydb-notes"];

export function renderReport(records: readonly RunRecord[], meta: ReportMeta): string {
	const summaries = summarize(records);
	const repeats = new Set(records.map((record) => record.repeat)).size;
	const lines = [
		"# Real-agent benchmark",
		"",
		...(meta.dataset === undefined ? [] : [`${meta.dataset}.`, ""]),
		`Model ${meta.model}, thinking ${meta.thinking}, timeout ${meta.timeoutSeconds} s, ${meta.questions} questions, ${repeats} ${repeats === 1 ? "repeat" : "repeats"}, runs one at a time. Tokens as the provider reported them: total = input + output + cache read + cache write, every model call of the run.`,
		"",
		"| strategy | runs | tokens | per run | input / output | cache read / write | tool calls (per run) | time per run | fully correct | expected tables named | extra tables named | errors |",
		"|---|---|---|---|---|---|---|---|---|---|---|---|",
		...summaries.map((summary) => {
			const per = (value: number) => (summary.runs === 0 ? 0 : value / summary.runs);
			return [
				"",
				summary.strategy,
				summary.runs,
				tokensText(summary.tokens.total),
				tokensText(per(summary.tokens.total)),
				`${tokensText(summary.tokens.input)} / ${tokensText(summary.tokens.output)}`,
				`${tokensText(summary.tokens.cacheRead)} / ${tokensText(summary.tokens.cacheWrite)}`,
				`${summary.toolCalls} (${per(summary.toolCalls).toFixed(1)})`,
				seconds(per(summary.ms)),
				`${summary.correct} of ${summary.runs}`,
				`${summary.hits} of ${summary.expected}`,
				summary.extra,
				summary.errors,
				"",
			]
				.join(" | ")
				.trim();
		}),
		"",
	];

	const comparisons: string[] = [];
	for (const a of HEYDB.filter((id) => summaries.some((summary) => summary.strategy === id))) {
		for (const summary of summaries) {
			const b = summary.strategy;
			if (b === a || (HEYDB.includes(b) && a === "heydb")) continue;
			const comparison = compareTokens(records, a, b);
			if (comparison === null) continue;
			const rounded = Math.round(Math.abs(comparison.percent));
			const difference = comparison.percent >= 0 ? `${rounded}% fewer` : `${rounded}% more`;
			comparisons.push(`| ${a} vs ${b} | ${comparison.questions} | ${tokensText(comparison.a)} | ${tokensText(comparison.b)} | ${difference} |`);
		}
	}
	if (comparisons.length > 0) {
		lines.push("## heydb against each strategy, same questions", "", "| comparison | questions | heydb tokens | other tokens | heydb used |", "|---|---|---|---|---|", ...comparisons, "");
	}

	if (repeats > 1) {
		lines.push(
			"## Spread across repeats",
			"",
			"| strategy | tokens per repeat: mean | min | max |",
			"|---|---|---|---|",
			...summaries.map((summary) => `| ${summary.strategy} | ${tokensText(summary.perRepeat.mean)} | ${tokensText(summary.perRepeat.min)} | ${tokensText(summary.perRepeat.max)} |`),
			"",
		);
	}

	const questions = [...new Set(records.map((record) => record.question))];
	lines.push(
		"## Per question",
		"",
		"Mean tokens per run; ✓ every expected table named, otherwise expected tables named of expected; ! a run ended in error.",
		"",
		`| question | ${summaries.map((summary) => summary.strategy).join(" | ")} |`,
		`|---|${summaries.map(() => "---").join("|")}|`,
		...questions.map((question) => {
			const cells = summaries.map((summary) => {
				const runs = records.filter((record) => record.strategy === summary.strategy && record.question === question);
				if (runs.length === 0) return "—";
				const verdict = runs.every((run) => run.correct) ? "✓" : runs.map((run) => `${run.hits}/${run.expected}`).join(", ");
				return `${tokensText(mean(runs.map((run) => run.usage.total)))} ${verdict}${runs.some((run) => run.error !== null) ? " !" : ""}`;
			});
			return `| ${question} | ${cells.join(" | ")} |`;
		}),
		"",
		"## What each strategy was given",
		"",
		"| strategy | tools declared | context of the first call (mean) | tool calls by name |",
		"|---|---|---|---|",
		...summaries.map((summary) => {
			const calls = Object.entries(summary.toolCallsByName)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([name, count]) => `${name} ${count}`)
				.join(", ");
			return `| ${summary.strategy} | ${summary.tools.join(", ") || "—"} | ${summary.firstContext === null ? "—" : tokensText(summary.firstContext)} | ${calls || "—"} |`;
		}),
	);
	const errors = records.filter((record) => record.error !== null);
	if (errors.length > 0) lines.push("", "Errors:", "", ...errors.map((record) => `- ${record.strategy} / ${record.question} / repeat ${record.repeat}: ${record.error}`));
	const notes = [...(meta.skipped ?? []).map((reason) => `Skipped: ${reason}.`), ...(meta.notes ?? [])];
	if (notes.length > 0) lines.push("", ...notes.map((note) => `- ${note}`));
	return lines.join("\n");
}
