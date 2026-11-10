// What an agent pays, in context, to find the tables that answer a question:
// through the heydb tools, or by querying information_schema itself.
//
// The heydb side runs the real tools on a real project folder, so every
// character counted is one the model would read. The agent is simulated with
// a fixed, simple policy, the same for every run, so two versions of heydb
// can be compared:
// 1. heydb_search with each of the question's queries, in order, until every
//    expected table appears in the results;
// 2. if one is still missing, heydb_overview, to browse;
// 3. heydb_table on each expected table, with the default options.
//
// The information_schema side is what the same queries would print with
// `mysql --batch` (tab-separated, the most compact output). "Guided" is an
// optimistic lower bound: it assumes the model picks the right tables from a
// list of names and comments, which no notes, references or search help with.
//
// Tokens are estimated as characters / 4: good enough to compare, not a bill.
//
// The learning loop (measureLearning) answers the questions, notes on each
// table that answered one what the question asked, as an agent does once the
// user confirms which table holds a concept, and answers them again.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { defaultDeps } from "../extensions/deps.ts";
import { registerHeydbTools } from "../extensions/tools.ts";
import { saveConfig } from "../lib/config/store.ts";
import { displayNameOf } from "../lib/model/names.ts";
import type { Snapshot, Table } from "../lib/model/snapshot.ts";
import { searchSchema } from "../lib/search.ts";
import { knowledgeConnections, loadKnowledge, saveKnowledge } from "../lib/store/knowledge.ts";
import { saveSnapshot } from "../lib/store/snapshots.ts";
import { initProject } from "../lib/usecases/init.ts";
import { annotate } from "../lib/usecases/knowledge.ts";
import { openSnapshot } from "../lib/usecases/project.ts";

export interface Question {
	readonly id: string;
	/** The question as a person would ask it. */
	readonly ask: string;
	/** What a model would search for, tried in order. */
	readonly queries: readonly string[];
	/** Tables that answer it: bare names, or database.table to require one database. */
	readonly expect: readonly string[];
}

export interface Step {
	readonly tool: string;
	readonly args: string;
	readonly chars: number;
}

export interface QuestionResult {
	readonly id: string;
	readonly steps: readonly Step[];
	readonly chars: number;
	/** Per expected table, its 1-based rank in the first search, or null when not in its results. */
	readonly firstRanks: readonly (number | null)[];
	/** True when every expected table came up in some search, without the overview. */
	readonly found: boolean;
	/** Characters of the information_schema baseline that lists one database's tables, then their columns. */
	readonly guidedChars: number;
}

export interface Report {
	readonly connection: string;
	readonly databases: number;
	readonly tables: number;
	readonly columns: number;
	/** Characters of tool descriptions, prompt snippets, guidelines and parameter schemas, sent every turn. */
	readonly fixedChars: number;
	readonly overviewChars: number;
	readonly questions: readonly QuestionResult[];
	/** Characters of information_schema.columns for every table of the connection. */
	readonly fullDumpChars: number;
}

type AnyTool = ToolDefinition<never, unknown>;
type ToolResult = { content: readonly { type: string; text?: string }[]; isError?: boolean };

export function heydbTools(): Map<string, AnyTool> {
	const tools = new Map<string, AnyTool>();
	const pi = { registerTool: (tool: AnyTool) => tools.set(tool.name, tool) } as unknown as ExtensionAPI;
	registerHeydbTools(pi, defaultDeps());
	return tools;
}

/** What Pi puts in the prompt for each tool, every turn, used or not. */
export function fixedToolChars(tools: Map<string, AnyTool>): number {
	let chars = 0;
	for (const tool of tools.values()) {
		chars += tool.name.length + tool.description.length + (tool.promptSnippet ?? "").length;
		chars += (tool.promptGuidelines ?? []).join("\n").length;
		chars += JSON.stringify(tool.parameters).length;
	}
	return chars;
}

async function call(tools: Map<string, AnyTool>, cwd: string, name: string, params: Record<string, unknown>): Promise<string> {
	const tool = tools.get(name);
	if (tool === undefined) throw new Error(`no tool ${name}`);
	const execute = tool.execute as unknown as (...args: unknown[]) => Promise<ToolResult>;
	const result = await execute("bench", params, undefined, undefined, { cwd });
	const text = result.content.map((part) => part.text ?? "").join("\n");
	if (result.isError === true) throw new Error(`${name} ${JSON.stringify(params)} failed: ${text}`);
	return text;
}

export async function measure(cwd: string, questions: readonly Question[], connection?: string): Promise<Report> {
	const tools = heydbTools();
	const opened = openSnapshot(cwd, connection);
	const { snapshot, knowledge } = opened;
	const withConnection = (params: Record<string, unknown>) => (connection === undefined ? params : { ...params, connection });
	const overview = await call(tools, cwd, "heydb_overview", withConnection({}));

	const results: QuestionResult[] = [];
	for (const question of questions) {
		const steps: Step[] = [];
		const located = new Map<string, string>();
		let firstRanks: (number | null)[] = [];
		for (const [index, query] of question.queries.entries()) {
			const text = await call(tools, cwd, "heydb_search", withConnection({ query }));
			steps.push({ tool: "heydb_search", args: query, chars: text.length });
			// Ranked with the tool's own defaults, and counted only when the text the
			// model read names the table: a result the tool cut is not a find.
			const targets = searchSchema(snapshot, knowledge, query)
				.results.filter((result) => result.object === "table" || result.object === "view")
				.map((result) => result.target)
				.filter((target) => names(text, displayNameOf(target)));
			const ranks = question.expect.map((expected) => {
				const rank = targets.findIndex((target) => matches(target, expected));
				if (rank >= 0 && !located.has(expected)) located.set(expected, targets[rank]!);
				return rank >= 0 ? rank + 1 : null;
			});
			if (index === 0) firstRanks = ranks;
			if (located.size === question.expect.length) break;
		}
		const found = located.size === question.expect.length;
		if (!found) steps.push({ tool: "heydb_overview", args: "", chars: overview.length });
		for (const expected of question.expect) {
			const name = located.get(expected) ?? firstTable(snapshot, expected)?.name;
			if (name === undefined) throw new Error(`question ${question.id}: no table ${expected} in the snapshot`);
			const text = await call(tools, cwd, "heydb_table", withConnection({ table: name }));
			steps.push({ tool: "heydb_table", args: name, chars: text.length });
		}
		results.push({
			id: question.id,
			steps,
			chars: steps.reduce((sum, step) => sum + step.chars, 0),
			firstRanks,
			found,
			guidedChars: guidedBaseline(snapshot, question.expect),
		});
	}

	const tables = allTables(snapshot);
	return {
		connection: opened.name,
		databases: snapshot.databases.reduce((sum, database) => sum + database.schemas.length, 0),
		tables: tables.length,
		columns: tables.reduce((sum, entry) => sum + entry.table.columns.length, 0),
		fixedChars: fixedToolChars(tools),
		overviewChars: overview.length,
		questions: results,
		fullDumpChars: columnsDump(tables, true).length,
	};
}

/** True when `text` names `name` as a whole name, not inside a longer one. */
function names(text: string, name: string): boolean {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|[^\\w.])${escaped}(?![\\w])`, "m").test(text);
}

/** "emp_001.emp_001.fac_cab" matches "fac_cab" and "emp_001.fac_cab". */
function matches(canonical: string, expected: string): boolean {
	const parts = canonical.split(".");
	const wanted = expected.split(".");
	return wanted.every((part, index) => parts[parts.length - wanted.length + index] === part);
}

export interface Located {
	readonly schema: string;
	readonly name: string;
	readonly table: Table;
}

function allTables(snapshot: Snapshot): Located[] {
	return snapshot.databases.flatMap((database) =>
		database.schemas.flatMap((schema) =>
			schema.tables.map((table) => ({ schema: schema.name, name: [database.name, schema.name, table.name].join("."), table })),
		),
	);
}

function firstTable(snapshot: Snapshot, expected: string): Located | undefined {
	return allTables(snapshot).find((entry) => matches(entry.name, expected));
}

/**
 * The cheapest route without heydb: list the databases, list one database's
 * tables with their comments, then the columns of the tables that answer.
 */
export function guidedBaseline(snapshot: Snapshot, expect: readonly string[]): number {
	const tables = allTables(snapshot);
	const targets = expect.map((expected) => tables.find((entry) => matches(entry.name, expected))).filter((entry) => entry !== undefined);
	const schema = targets[0]?.schema;
	const databases = ["SCHEMA_NAME", ...new Set(tables.map((entry) => entry.schema))].join("\n");
	const listed = ["TABLE_NAME\tTABLE_COMMENT", ...tables.filter((entry) => entry.schema === schema).map((entry) => `${entry.table.name}\t${entry.table.comment}`)].join("\n");
	return databases.length + listed.length + columnsDump(targets, false).length;
}

/** `SELECT [TABLE_SCHEMA,] TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, COLUMN_KEY, COLUMN_COMMENT FROM information_schema.columns`, batch output. */
export function columnsDump(tables: readonly Located[], withSchema: boolean): string {
	const header = `${withSchema ? "TABLE_SCHEMA\t" : ""}TABLE_NAME\tCOLUMN_NAME\tCOLUMN_TYPE\tCOLUMN_KEY\tCOLUMN_COMMENT`;
	const rows = tables.flatMap((entry) =>
		entry.table.columns.map((column) => {
			const key = entry.table.primaryKey.includes(column.name) ? "PRI" : "";
			return `${withSchema ? `${entry.schema}\t` : ""}${entry.table.name}\t${column.name}\t${column.type}\t${key}\t${column.comment}`;
		}),
	);
	return [header, ...rows].join("\n");
}

export interface LearningReport {
	/** The questions answered on a copy of the project, as it was. */
	readonly before: Report;
	/** The same questions after the notes. */
	readonly after: Report;
	/** Notes added: one per table read for each question. */
	readonly notes: number;
}

/**
 * Runs the questions on a copy of the project in a temporary folder (config
 * of the connection, snapshot, every knowledge file), notes on each table
 * read for a question the question's `ask`, and runs them again. The project
 * measured is only read.
 */
export async function measureLearning(cwd: string, questions: readonly Question[], connection?: string): Promise<LearningReport> {
	const opened = openSnapshot(cwd, connection);
	const root = mkdtempSync(join(tmpdir(), "heydb-bench-learn-"));
	try {
		initProject(root);
		saveConfig(root, { formatVersion: 1, defaultConnection: opened.name, connections: { [opened.name]: opened.connection } });
		saveSnapshot(root, opened.name, opened.snapshot);
		for (const name of knowledgeConnections(opened.root)) saveKnowledge(root, name, loadKnowledge(opened.root, name));
		const before = await measure(root, questions, opened.name);
		let notes = 0;
		for (const [index, question] of questions.entries()) {
			const read = before.questions[index]?.steps.filter((step) => step.tool === "heydb_table") ?? [];
			for (const step of read) {
				annotate(root, opened.name, { target: step.args, text: question.ask, author: "bench" });
				notes += 1;
			}
		}
		const after = await measure(root, questions, opened.name);
		return { before, after, notes };
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

export const tokens = (chars: number): number => Math.round(chars / 4);

const format = (chars: number): string => tokens(chars).toLocaleString("en-US");

interface Summary {
	readonly ranks: readonly (number | null)[];
	readonly hits: (limit: number) => number;
	readonly mrr: number;
	readonly heydbTotal: number;
	readonly guidedTotal: number;
	readonly tableSteps: readonly Step[];
	readonly searchSteps: readonly Step[];
	readonly overviews: number;
}

function summarize(report: Report): Summary {
	const questions = report.questions;
	const ranks = questions.flatMap((question) => question.firstRanks);
	return {
		ranks,
		hits: (limit) => ranks.filter((rank) => rank !== null && rank <= limit).length,
		mrr: ranks.reduce<number>((sum, rank) => sum + (rank === null ? 0 : 1 / rank), 0) / Math.max(ranks.length, 1),
		heydbTotal: questions.reduce((sum, question) => sum + question.chars, 0),
		guidedTotal: questions.reduce((sum, question) => sum + question.guidedChars, 0),
		tableSteps: questions.flatMap((question) => question.steps.filter((step) => step.tool === "heydb_table")),
		searchSteps: questions.flatMap((question) => question.steps.filter((step) => step.tool === "heydb_search")),
		overviews: questions.filter((question) => !question.found).length,
	};
}

const average = (steps: readonly Step[]) => steps.reduce((sum, step) => sum + step.chars, 0) / Math.max(steps.length, 1);

export function renderReport(report: Report): string {
	const questions = report.questions;
	const { ranks, hits, mrr, heydbTotal, guidedTotal, tableSteps, searchSteps, overviews } = summarize(report);
	const lines = [
		`# heydb token benchmark — ${report.connection}`,
		"",
		`${report.databases} databases · ${report.tables.toLocaleString("en-US")} tables · ${report.columns.toLocaleString("en-US")} columns. Tokens ≈ characters / 4.`,
		"",
		"## Per question",
		"",
		"| question | heydb calls | heydb ≈tokens | first-search rank | info_schema guided ≈tokens |",
		"|---|---|---|---|---|",
		...questions.map((question) => {
			const calls = question.steps.map((step) => step.tool.replace("heydb_", "")).join(", ");
			const rank = question.firstRanks.map((value) => value ?? "—").join(", ");
			return `| ${question.id}${question.found ? "" : " (overview)"} | ${calls} | ${format(question.chars)} | ${rank} | ${format(question.guidedChars)} |`;
		}),
		"",
		"## Summary",
		"",
		"| measure | value |",
		"|---|---|",
		`| heydb, all questions | ≈${format(heydbTotal)} tokens |`,
		`| info_schema guided, all questions (optimistic) | ≈${format(guidedTotal)} tokens |`,
		`| info_schema columns of every table (one query) | ≈${format(report.fullDumpChars)} tokens |`,
		`| heydb_overview | ≈${format(report.overviewChars)} tokens |`,
		`| heydb_table, average / max | ≈${format(average(tableSteps))} / ≈${format(Math.max(0, ...tableSteps.map((step) => step.chars)))} tokens |`,
		`| heydb_search, average | ≈${format(average(searchSteps))} tokens |`,
		`| fixed tool text, every turn | ≈${format(report.fixedChars)} tokens |`,
		`| first search: expected table in top 1 / top 5 / anywhere | ${hits(1)} / ${hits(5)} / ${hits(20)} of ${ranks.length} |`,
		`| first search: mean reciprocal rank | ${mrr.toFixed(2)} |`,
		`| questions that needed the overview | ${overviews} of ${questions.length} |`,
	];
	return lines.join("\n");
}

export function renderLearning({ before, after, notes }: LearningReport): string {
	const [was, now] = [summarize(before), summarize(after)];
	const total = before.questions.length;
	const row = (measure: string, value: (summary: Summary) => string) => `| ${measure} | ${value(was)} | ${value(now)} |`;
	const lines = [
		`# heydb learning loop — ${before.connection}`,
		"",
		`${before.databases} databases · ${before.tables.toLocaleString("en-US")} tables. After the first pass, ${notes} ${notes === 1 ? "note" : "notes"}: on each table read for a question, the question as asked. Tokens ≈ characters / 4.`,
		"",
		"## Per question",
		"",
		"| question | first-search rank, before | after | heydb ≈tokens, before | after |",
		"|---|---|---|---|---|",
		...before.questions.map((question, index) => {
			const later = after.questions[index] as QuestionResult;
			const rank = (result: QuestionResult) => `${result.firstRanks.map((value) => value ?? "—").join(", ")}${result.found ? "" : " (overview)"}`;
			return `| ${question.id} | ${rank(question)} | ${rank(later)} | ${format(question.chars)} | ${format(later.chars)} |`;
		}),
		"",
		"## Summary",
		"",
		"| measure | before notes | after notes |",
		"|---|---|---|",
		row("heydb, all questions", (summary) => `≈${format(summary.heydbTotal)} tokens`),
		row("heydb_search, average", (summary) => `≈${format(average(summary.searchSteps))} tokens`),
		row("heydb_table, average", (summary) => `≈${format(average(summary.tableSteps))} tokens`),
		row("first search: expected table in top 1 / top 5 / anywhere", (summary) => `${summary.hits(1)} / ${summary.hits(5)} / ${summary.hits(20)} of ${summary.ranks.length}`),
		row("first search: mean reciprocal rank", (summary) => summary.mrr.toFixed(2)),
		row("questions that needed the overview", (summary) => `${summary.overviews} of ${total}`),
	];
	return lines.join("\n");
}
