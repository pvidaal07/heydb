import { randomUUID } from "node:crypto";

import { type KnowledgeOptions, canonicalTable, withEntries } from "./operations.ts";
import type { Flow, FlowStage, FlowWrite, Knowledge } from "./types.ts";

// Pure operations on flows, like operations.ts for notes: each returns a new
// Knowledge and never mutates its input. Table names come in canonical form;
// whether they exist is checked by the caller, which has the snapshot.
//
// One flow per name: saving a flow whose name or a synonym is the name or a
// synonym of a stored one (case, accents and spaces aside) replaces that one,
// keeping its id, author and creation date, and adds one to its revision.

/** The suffix that tells readers an entry was written by an agent, not typed by a person. */
export const AGENT_AUTHOR_SUFFIX = " (via agent)";

export interface FlowInput {
	readonly name: string;
	readonly synonyms?: readonly string[];
	readonly entry: string;
	readonly writes?: readonly FlowWriteInput[];
	readonly reads?: readonly string[];
	readonly stages?: readonly FlowStageInput[];
	readonly open?: string;
	readonly sources?: readonly string[];
	readonly author: string;
}

/** A written table; without columns when they are not known or the whole row is (a delete). */
export interface FlowWriteInput {
	readonly table: string;
	readonly columns?: readonly string[] | undefined;
}

export interface FlowStageInput {
	readonly name: string;
	readonly writes?: readonly FlowWriteInput[];
	readonly reads?: readonly string[];
}

/** How names are compared: "Facturación  de venta" and "facturacion de venta" are the same. */
export function flowKey(text: string): string {
	return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** The stored flows whose name or a synonym is one of `names`, in stored order. */
export function matchingFlows(knowledge: Knowledge, names: readonly string[]): Flow[] {
	const wanted = new Set(names.map(flowKey).filter((key) => key !== ""));
	return (knowledge.flows ?? []).filter((flow) => [flow.name, ...flow.synonyms].some((name) => wanted.has(flowKey(name))));
}

/** Every table a flow writes or reads, at any stage: unique, canonical, in the order first named. */
export function flowTables(flow: Pick<Flow, "writes" | "reads" | "stages">): string[] {
	const all = [flow, ...(flow.stages ?? [])].flatMap((part) => [...part.writes.map((item) => item.table), ...part.reads]);
	return [...new Set(all)];
}

/** The tables written at any stage, then the tables only read: unique, canonical. */
export function flowWritesAndReads(flow: Pick<Flow, "writes" | "reads" | "stages">): { writes: string[]; reads: string[] } {
	const parts = [flow, ...(flow.stages ?? [])];
	const writes = [...new Set(parts.flatMap((part) => part.writes.map((item) => item.table)))];
	const reads = [...new Set(parts.flatMap((part) => part.reads))].filter((table) => !writes.includes(table));
	return { writes, reads };
}

/** True when nobody but an agent wrote it: replacing it needs no one's confirmation. */
export function writtenByAgent(flow: Flow): boolean {
	return flow.author.endsWith(AGENT_AUTHOR_SUFFIX);
}

/**
 * Adds the flow, or replaces the one its name or a synonym matches. Throws
 * when they match more than one stored flow: which one to replace is the
 * caller's decision.
 */
export function putFlow(
	knowledge: Knowledge,
	input: FlowInput,
	options: KnowledgeOptions = {},
): { knowledge: Knowledge; flow: Flow; replaced: Flow | null } {
	const { now = () => new Date().toISOString(), newId = randomUUID } = options;
	const fields = cleanFlow(input);
	const matches = matchingFlows(knowledge, [fields.name, ...fields.synonyms]);
	if (matches.length > 1) {
		throw new Error(
			`flow "${fields.name}" and its synonyms match ${matches.length} saved flows: ${matches.map((flow) => `"${flow.name}"`).join(", ")}; save it under the name of one of them`,
		);
	}
	const replaced = matches[0] ?? null;
	const timestamp = now();
	const flow: Flow = {
		id: replaced?.id ?? newId(),
		...fields,
		author: replaced?.author ?? cleanRequired(input.author, "author"),
		createdAt: replaced?.createdAt ?? timestamp,
		updatedAt: timestamp,
		revision: replaced === null ? 1 : replaced.revision + 1,
	};
	const others = (knowledge.flows ?? []).filter((item) => item.id !== replaced?.id);
	return { knowledge: withEntries(knowledge, undefined, undefined, [...others, flow]), flow, replaced };
}

type FlowFields = Omit<Flow, "id" | "author" | "createdAt" | "updatedAt" | "revision">;

function cleanFlow(input: FlowInput): FlowFields {
	const name = cleanRequired(input.name, "flow name");
	const synonyms = uniqueTexts(input.synonyms ?? [], "synonyms").filter((synonym) => flowKey(synonym) !== flowKey(name));
	const entry = cleanRequired(input.entry, "entry");
	const writes = cleanWrites(input.writes ?? [], "writes");
	const reads = cleanReads(input.reads ?? [], "reads");
	const stages = (input.stages ?? []).map((stage, index): FlowStage => {
		const path = `stages[${index}]`;
		const cleaned = {
			name: cleanRequired(stage.name, `${path}.name`),
			writes: cleanWrites(stage.writes ?? [], `${path}.writes`),
			reads: cleanReads(stage.reads ?? [], `${path}.reads`),
		};
		if (cleaned.writes.length === 0 && cleaned.reads.length === 0) throw new Error(`${path} names no table: give its writes or reads`);
		return cleaned;
	});
	uniqueTexts(
		stages.map((stage) => stage.name),
		"stage names",
	);
	if (writes.length === 0 && reads.length === 0 && stages.length === 0) {
		throw new Error("a flow names at least one table: give writes, reads or stages");
	}
	const open = input.open?.trim() ?? "";
	return {
		name,
		synonyms,
		entry,
		writes,
		reads,
		...(stages.length > 0 && { stages }),
		...(open !== "" && { open }),
		sources: uniqueTexts(input.sources ?? [], "sources"),
	};
}

function cleanWrites(writes: readonly FlowWriteInput[], path: string): FlowWrite[] {
	const cleaned = writes.map((item, index) => ({
		table: tableName(item.table, `${path}[${index}].table`),
		columns: uniqueTexts(item.columns ?? [], `${path}[${index}].columns`, exact),
	}));
	uniqueTexts(
		cleaned.map((item) => item.table),
		path,
		exact,
	);
	return cleaned;
}

function cleanReads(reads: readonly string[], path: string): string[] {
	return uniqueTexts(
		reads.map((table, index) => tableName(table, `${path}[${index}]`)),
		path,
		exact,
	);
}

function tableName(name: string, path: string): string {
	const table = canonicalTable(name);
	if (table === null) throw new Error(`${path} must be a table name (database.schema.table): got "${name}"`);
	return table;
}

/**
 * Trimmed, none empty; a repeated entry is an error, not silently dropped, so
 * a typo in a list is seen. Words compare like flow names; table and column
 * names exactly, since "Orders" and "orders" may be two tables.
 */
function uniqueTexts(values: readonly string[], path: string, key: (text: string) => string = flowKey): string[] {
	const cleaned = values.map((value, index) => cleanRequired(value, `${path}[${index}]`));
	cleaned.forEach((value, index) => {
		if (cleaned.findIndex((other) => key(other) === key(value)) !== index) throw new Error(`${path} repeats "${value}"`);
	});
	return cleaned;
}

function exact(text: string): string {
	return text;
}

function cleanRequired(value: string, label: string): string {
	const text = value.trim();
	if (text === "") throw new Error(`${label} must not be empty`);
	return text;
}
