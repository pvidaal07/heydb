// A SCHEMA.md as schema-to-markdown tools write it, given to the agent two
// ways: loaded whole into context for every question (schema-doc-full), or
// grepped with the question's words, then read one table's section at a time
// (schema-doc-grep). When no grep named the table (a hit in a column table is
// usually more than 2 lines below its heading), the agent lists every heading
// and reads the right section.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { displayNameOf } from "../../lib/model/names.ts";
import type { Snapshot, Table } from "../../lib/model/snapshot.ts";
import { allTables, type Step } from "../measure.ts";
import { type BenchContext, MAX_LINE_LENGTH, MAX_LINES, type Strategy, grepWords, searchThenRead, wordsPattern } from "./shared.ts";

/** Per table a heading, its comment and a column table: name | type | null | key | comment. Every database, as the tools document a server. */
export function schemaMarkdown(snapshot: Snapshot): string {
	const lines = ["# Database schema", ""];
	for (const entry of allTables(snapshot)) {
		lines.push(`## ${displayNameOf(entry.name)}`, "");
		if (entry.table.comment !== "") lines.push(cell(entry.table.comment), "");
		lines.push("| column | type | null | key | comment |", "|---|---|---|---|---|");
		for (const column of entry.table.columns) {
			lines.push(`| ${column.name} | ${column.type} | ${column.nullable ? "YES" : "NO"} | ${columnKey(entry.table, column.name)} | ${cell(column.comment)} |`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

/** What information_schema.columns calls COLUMN_KEY. */
export function columnKey(table: Table, column: string): string {
	if (table.primaryKey.includes(column)) return "PRI";
	const first = table.indexes.filter((index) => index.columns[0] === column);
	if (first.some((index) => index.unique && index.columns.length === 1)) return "UNI";
	return first.length > 0 ? "MUL" : "";
}

const cell = (text: string): string => text.replaceAll("|", "\\|").replaceAll("\n", " ");

/**
 * `rg -i -n -C2 -e w1 -e w2 FILE | head -100`: matching lines as "N:text",
 * context as "N-text", "--" between groups that do not touch.
 */
export function grepText(text: string, words: readonly string[], context = 2): string {
	if (words.length === 0) return "";
	const pattern = wordsPattern(words);
	const lines = text.split("\n");
	const hits = lines.flatMap((line, index) => (pattern.test(line) ? [index] : []));
	const matched = new Set(hits);
	const out: string[] = [];
	let last = -1;
	for (const hit of hits) {
		const from = Math.max(hit - context, last + 1);
		const to = Math.min(hit + context, lines.length - 1);
		if (last >= 0 && from > last + 1) out.push("--");
		for (let index = from; index <= to; index += 1) {
			out.push(`${index + 1}${matched.has(index) ? ":" : "-"}${lines[index]!.slice(0, MAX_LINE_LENGTH)}`);
		}
		last = Math.max(last, to);
		if (out.length >= MAX_LINES) break;
	}
	return out.slice(0, MAX_LINES).join("\n");
}

/** `rg -n '^prefix' FILE`, whole: the table of contents an agent lists when its searches named nothing. */
export function linesStarting(text: string, prefix: string): string {
	return text
		.split("\n")
		.flatMap((line, index) => (line.startsWith(prefix) ? [`${index + 1}:${line.slice(0, MAX_LINE_LENGTH)}`] : []))
		.join("\n");
}

/** From the line `start` begins with to the next line starting with `next`, trailing blank lines dropped. */
export function block(text: string, start: string, next: (line: string) => boolean): string {
	const lines = text.split("\n");
	const from = lines.indexOf(start);
	if (from < 0) return "";
	let to = lines.findIndex((line, index) => index > from && next(line));
	if (to < 0) to = lines.length;
	return lines.slice(from, to).join("\n").trimEnd();
}

export function writeSchemaDoc(ctx: BenchContext): string {
	const path = join(ctx.workdir, "SCHEMA.md");
	writeFileSync(path, schemaMarkdown(ctx.snapshot));
	return path;
}

export function schemaDocFull(ctx: BenchContext): Strategy {
	const path = writeSchemaDoc(ctx);
	return {
		id: "schema-doc-full",
		label: "SCHEMA.md read whole",
		simulated: false,
		run: async (question) => {
			const steps: Step[] = [];
			const start = performance.now();
			const text = readFileSync(path, "utf8");
			steps.push({ tool: "read", args: "SCHEMA.md", chars: text.length, ms: performance.now() - start });
			return { steps, seen: question.expect.length, firstRanks: null };
		},
	};
}

export function schemaDocGrep(ctx: BenchContext): Strategy {
	const path = writeSchemaDoc(ctx);
	const read = () => readFileSync(path, "utf8");
	return {
		id: "schema-doc-grep",
		label: "grep SCHEMA.md, read the section",
		simulated: false,
		run: (question) =>
			searchThenRead(ctx, question, {
				lookup: ctx.lookup,
				search: (query) => ({ tool: "grep", args: query, text: grepText(read(), grepWords(query)) }),
				// Every heading, as heydb's agent opens the overview; then it reads the right section.
				fallback: () => ({ calls: [() => ({ tool: "grep headings", args: "^## ", text: linesStarting(read(), "## ") })], definitions: false }),
				read: (targets) =>
					targets.map((target) => () => {
						const heading = `## ${displayNameOf(target.name)}`;
						return { tool: "read section", args: heading, text: block(read(), heading, (line) => line.startsWith("## ")) };
					}),
			}),
	};
}
