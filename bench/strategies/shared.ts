// What every strategy of the competitive benchmark shares: one interface, the
// words an agent searches with, when an output counts as naming a table, and
// the search-then-read policy most of them follow.
import { foldWord, normalizeText } from "../../lib/search.ts";
import type { Snapshot } from "../../lib/model/snapshot.ts";
import { allTables, firstTable, type Located, type Question, type Step } from "../measure.ts";

export interface Answer {
	/** Every call, in order: one model round trip each. */
	readonly steps: readonly Step[];
	/** Expected tables named by what the model read before reading their definitions. */
	readonly seen: number;
	/** Per expected table, its 1-based rank in the first call's output, null when not in it; null when a rank has no meaning. */
	readonly firstRanks: readonly (number | null)[] | null;
}

export interface Strategy {
	readonly id: string;
	/** What it simulates, in a few words. */
	readonly label: string;
	/** True when it stands for calls to a database server, simulated over the snapshot. */
	readonly simulated: boolean;
	run(question: Question): Promise<Answer>;
}

export interface BenchContext {
	readonly snapshot: Snapshot;
	/** Every table, in snapshot order: the order a database returns them in. */
	readonly tables: readonly Located[];
	/** Scratch folder for generated files (SCHEMA.md, schema.prisma); never the measured project. */
	readonly workdir: string;
	/** A code and docs folder to grep, when there is one. */
	readonly codeDir?: string;
	/** Lowercase table name → table name, to find the tables an output names. */
	readonly lookup: ReadonlyMap<string, string>;
}

export function benchContext(snapshot: Snapshot, workdir: string, codeDir?: string): BenchContext {
	const tables = allTables(snapshot);
	const lookup = new Map(tables.map((entry) => [entry.table.name.toLowerCase(), entry.table.name]));
	return { snapshot, tables, workdir, lookup, ...(codeDir === undefined ? {} : { codeDir }) };
}

/** Lines a grep prints at most, as an agent piping to `head -100` would read. */
export const MAX_LINES = 100;
/** Characters of a grep line kept, as `rg --max-columns 200` does. */
export const MAX_LINE_LENGTH = 200;

/** Words an agent leaves out of a search: they say nothing about the schema. */
const STOPWORDS: ReadonlySet<string> = new Set([
	"del", "las", "los", "una", "unos", "unas", "por", "para", "con", "que", "sus", "esta", "este", "como", "cual",
	"donde", "cuando", "hay", "the", "and", "for", "with", "from", "are", "which", "where", "what", "how",
]);

/** The words of a query an agent greps for: three letters or more, no stopwords, as typed (grep folds no accents). */
export function grepWords(query: string): string[] {
	const words = query.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((word) => word.length >= 3 && !STOPWORDS.has(word));
	return [...new Set(words)];
}

export function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive, any of the words: `rg -i -e w1 -e w2`. */
export function wordsPattern(words: readonly string[]): RegExp {
	return new RegExp(words.map(escapeRegExp).join("|"), "iu");
}

/**
 * The tables an output names, as whole names (letters, digits and "_"), in
 * the order it first names them: "fac_cab_2019" does not name fac_cab, and
 * "emp_001.fac_cab" does.
 */
export function tablesNamed(text: string, lookup: ReadonlyMap<string, string>): string[] {
	const named = new Set<string>();
	for (const token of text.matchAll(/[\p{L}\p{N}_]+/gu)) {
		const table = lookup.get(token[0].toLowerCase());
		if (table !== undefined) named.add(table);
	}
	return [...named];
}

/**
 * The rule for every pick made from a list of names (a generic database MCP
 * server's list_tables, the guided information_schema listing): a table counts
 * as picked when a part of its name (split on "_" and digits) is a word of the
 * question's queries, or is 3 letters or more and starts one ("fac" for
 * "facturas"), or, where the listing shows comments, its comment holds one of
 * those words. Accents and plurals are folded: a model reads them as the same word.
 */
export function namePick(name: string, comment: string, queries: readonly string[]): boolean {
	const words = queries.flatMap(grepWords).map((word) => foldWord(normalizeText(word)));
	const parts = normalizeText(name).split(/[_\d]+/).filter((part) => part !== "");
	const said = new Set(normalizeText(comment).split(/[^\p{L}\p{N}]+/u).map(foldWord));
	return words.some(
		(word) => said.has(word) || parts.some((part) => foldWord(part) === word || (part.length >= 3 && word.startsWith(part))),
	);
}

/** The bare name of an expected table: "emp_001.fac_cab" is named by "fac_cab". */
export function bare(expected: string): string {
	return expected.split(".").at(-1) ?? expected;
}

export function located(ctx: BenchContext, question: Question): Located[] {
	return question.expect.map((expected) => {
		const entry = firstTable(ctx.snapshot, expected);
		if (entry === undefined) throw new Error(`question ${question.id}: no table ${expected} in the snapshot`);
		return entry;
	});
}

/** One call: what the model asked for and what it read back. */
export interface Output {
	readonly tool: string;
	readonly args: string;
	readonly text: string;
	/** The tables the output names, in order, when the output is rows of tables; otherwise read from the text. */
	readonly named?: readonly string[];
}

export type Call = () => Output | Promise<Output>;

/** Runs a call, timing it, and keeps it as a step. */
export async function timed(steps: Step[], call: Call): Promise<Output> {
	const start = performance.now();
	const output = await call();
	steps.push({ tool: output.tool, args: output.args, chars: output.text.length, ms: performance.now() - start });
	return output;
}

export interface SearchThenRead {
	search(query: string): Output | Promise<Output>;
	/** When some expected table was never named: what the agent falls back to, and whether it already holds the definitions. */
	fallback(targets: readonly Located[]): { readonly calls: readonly Call[]; readonly definitions: boolean };
	/** Reading the definitions of the expected tables. */
	read(targets: readonly Located[]): readonly Call[];
	readonly lookup: ReadonlyMap<string, string>;
}

/**
 * The fixed policy of the search strategies, the one heydb's agent follows:
 * search with each of the question's queries, in order, until every expected
 * table was named; fall back when one never was; then read the definitions of
 * the expected tables (the agent goes straight to the right ones, as it does
 * after heydb's overview).
 */
export async function searchThenRead(ctx: BenchContext, question: Question, policy: SearchThenRead): Promise<Answer> {
	const steps: Step[] = [];
	const wanted = [...new Set(question.expect.map(bare))];
	const seen = new Set<string>();
	let firstRanks: (number | null)[] = [];
	for (const [index, query] of question.queries.entries()) {
		const output = await timed(steps, () => policy.search(query));
		const named = output.named ?? tablesNamed(output.text, policy.lookup);
		for (const name of wanted) if (named.includes(name)) seen.add(name);
		if (index === 0) firstRanks = question.expect.map((expected) => rankIn(named, bare(expected)));
		if (seen.size === wanted.length) break;
	}
	const targets = located(ctx, question);
	let definitions = false;
	if (seen.size < wanted.length) {
		const fallback = policy.fallback(targets);
		for (const call of fallback.calls) await timed(steps, call);
		definitions = fallback.definitions;
	}
	if (!definitions) for (const call of policy.read(targets)) await timed(steps, call);
	return { steps, seen: question.expect.filter((expected) => seen.has(bare(expected))).length, firstRanks };
}

export function rankIn(named: readonly string[], name: string): number | null {
	const index = named.indexOf(name);
	return index < 0 ? null : index + 1;
}
