import { type FlowInput, type FlowWriteInput, matchingFlows, putFlow, writtenByAgent } from "../knowledge/flows.ts";
import type { KnowledgeOptions } from "../knowledge/operations.ts";
import type { Flow, FlowWrite } from "../knowledge/types.ts";
import { displayName, parseName } from "../model/names.ts";
import type { Snapshot } from "../model/snapshot.ts";
import { MAX_FLOW_LENGTH, renderFlowBody } from "../render/markdown.ts";
import { loadKnowledge, saveKnowledge } from "../store/knowledge.ts";
import { requireSnapshot } from "./knowledge.ts";
import { resolveColumn, resolveTable } from "./resolve.ts";

// Flows are saved like notes: load, apply a pure operation, check, save
// atomically; a failure anywhere leaves the file as it was. Every table and
// written column is resolved against the stored snapshot with the rules
// notes use ("orders", "shop.orders", any case when unique), so a typo is
// rejected with suggestions instead of creating a flow nobody finds.

/** A flow as an agent or a person gives it: table names in any form resolveTable accepts. */
export interface FlowRequest extends FlowInput {
	/** The user said to replace a flow a person wrote. */
	readonly userConfirmed?: boolean;
}

/**
 * Thrown when the save would replace a flow a person wrote and the user has
 * not confirmed it. The entry point says how to confirm; `flow` is the one
 * that would be replaced, to show the user.
 */
export class FlowConfirmationError extends Error {
	readonly flow: Flow;

	constructor(flow: Flow) {
		super(`flow "${flow.name}" was written by ${flow.author}, a person: replacing it needs the user's confirmation`);
		this.name = "FlowConfirmationError";
		this.flow = flow;
	}
}

/** Adds the flow or replaces the one with its name or a synonym; returns what was replaced, if anything. */
export function saveFlow(
	projectRoot: string,
	connection: string,
	request: FlowRequest,
	options: KnowledgeOptions = {},
): { flow: Flow; replaced: Flow | null } {
	const snapshot = requireSnapshot(projectRoot, connection);
	const resolve = (part: { readonly writes?: readonly FlowWriteInput[]; readonly reads?: readonly string[] }, path: string) => ({
		writes: (part.writes ?? []).map((item, index) => resolveWrite(snapshot, item, `${path}writes[${index}]`)),
		reads: (part.reads ?? []).map((table, index) => explained(`${path}reads[${index}]`, () => resolveTable(snapshot, table).name)),
	});
	const input: FlowInput = {
		...request,
		...resolve(request, ""),
		...(request.stages !== undefined && {
			stages: request.stages.map((stage, index) => ({ ...stage, ...resolve(stage, `stages[${index}].`) })),
		}),
	};

	const knowledge = loadKnowledge(projectRoot, connection);
	const [existing] = matchingFlows(knowledge, [input.name, ...(input.synonyms ?? [])]);
	if (existing !== undefined && !writtenByAgent(existing) && request.userConfirmed !== true) throw new FlowConfirmationError(existing);
	const result = putFlow(knowledge, input, options);
	// Spreading a string splits it by code point, so an accent or an emoji counts as one character.
	const length = [...renderFlowBody(result.flow)].length;
	if (length > MAX_FLOW_LENGTH) {
		throw new Error(
			`flow is too long: ${length} characters rendered (max ${MAX_FLOW_LENGTH}). Keep every table and column; shorten synonyms, open and stage names, or save each stage as its own flow.`,
		);
	}
	saveKnowledge(projectRoot, connection, result.knowledge);
	return { flow: result.flow, replaced: result.replaced };
}

/**
 * A written table as typed: "invoices(order_id, total)" or just "invoices",
 * the same form a flow is shown in. Commas separate the columns.
 */
export function parseWrite(text: string): FlowWriteInput {
	const found = /^(.*?)\s*\(([^()]*)\)\s*$/su.exec(text);
	if (found === null) return { table: text.trim() };
	const columns = (found[2] as string).split(",").map((column) => column.trim());
	return { table: (found[1] as string).trim(), columns: columns.length === 1 && columns[0] === "" ? [] : columns };
}

/** Flow names listed when the one asked for is not there. */
const MAX_NAMES_LISTED = 10;

/** The flow whose name or a synonym is `name`, case and accents aside. Needs no snapshot. */
export function getFlow(projectRoot: string, connection: string, name: string): Flow {
	const knowledge = loadKnowledge(projectRoot, connection);
	const [found] = matchingFlows(knowledge, [name]);
	if (found !== undefined) return found;
	const names = (knowledge.flows ?? []).map((flow) => `"${flow.name}"`);
	if (names.length === 0) throw new Error(`no flow is called "${name}": none is saved for connection "${connection}" yet`);
	const more = names.length > MAX_NAMES_LISTED ? ` and ${names.length - MAX_NAMES_LISTED} more` : "";
	throw new Error(`no flow is called "${name}"; saved flows: ${names.slice(0, MAX_NAMES_LISTED).join(", ")}${more}`);
}

function resolveWrite(snapshot: Snapshot, item: FlowWriteInput, path: string): FlowWrite {
	const table = explained(`${path}.table`, () => resolveTable(snapshot, item.table).name);
	const columns = (item.columns ?? []).map((column, index) =>
		explained(`${path}.columns[${index}]`, () => {
			if (column.trim() === "") throw new Error("must not be empty");
			return resolveColumn(snapshot, displayName({ ...parseName(table), column: column.trim() })).column.name;
		}),
	);
	return { table, columns };
}

/** Prefixes the resolver's message ("no table matches …. Did you mean: …?") with the field at fault. */
function explained<T>(path: string, resolve: () => T): T {
	try {
		return resolve();
	} catch (error) {
		throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
}
