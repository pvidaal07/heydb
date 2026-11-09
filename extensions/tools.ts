import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { knowledgeForTable } from "../lib/knowledge/query.ts";
import type { RelationshipSide } from "../lib/knowledge/types.ts";
import { displayNameOf } from "../lib/model/names.ts";
import { incomingReferences } from "../lib/model/references.ts";
import { renderOverview, renderSearch, renderTable } from "../lib/render/markdown.ts";
import { searchSchema } from "../lib/search.ts";
import { annotate, editNote, relate } from "../lib/usecases/knowledge.ts";
import { ProjectError, forgetById, openConnection, openSnapshot, resolveTarget } from "../lib/usecases/project.ts";
import { resolveTable } from "../lib/usecases/resolve.ts";
import type { HeydbDeps } from "./deps.ts";

// Tools are what the model calls. They read the stored snapshot and the
// knowledge files, and write knowledge; they never connect to a database.
// Connecting needs a password and may hit production, so only the human
// commands (/heydb:sync, /heydb:status) do it, when a person asks.
//
// Every failure comes back as text with isError, never as a thrown error: the
// model reads the message and can fix its call or tell the user what to run.
// Tools run one at a time ("sequential"): two notes saved in the same turn
// must not both read the file before either writes it.

interface ToolDetails {
	/** The connection the call used; null when it failed before picking one. */
	readonly connection: string | null;
}

type Result = AgentToolResult<ToolDetails>;

const CONNECTION = {
	type: "string",
	description: "Connection name from .heydb/config.json; omit to use the default.",
} as const;

/** The suffix that tells readers a note was written by an agent, not typed by a person. */
export const AGENT_AUTHOR_SUFFIX = " (via agent)";

export function registerHeydbTools(pi: ExtensionAPI, deps: HeydbDeps): void {
	pi.registerTool(createOverviewTool());
	pi.registerTool(createTableTool());
	pi.registerTool(createSearchTool());
	pi.registerTool(createAnnotateTool(deps));
	pi.registerTool(createRelateTool(deps));
	pi.registerTool(createEditNoteTool(deps));
	pi.registerTool(createForgetTool());
}

const OVERVIEW_PARAMETERS = {
	type: "object",
	properties: { connection: CONNECTION },
	additionalProperties: false,
} as const;

export function createOverviewTool(): ToolDefinition<typeof OVERVIEW_PARAMETERS, ToolDetails> {
	return {
		name: "heydb_overview",
		label: "heydb overview",
		description:
			"Summary of the project's schema snapshot: per database comment coverage, name prefixes and most referenced tables; warnings; tables with notes.",
		promptSnippet: "Summarize the database schema of this project (stored snapshot)",
		promptGuidelines: ["Use heydb_overview first when you do not know the database schema of a heydb project."],
		parameters: OVERVIEW_PARAMETERS,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return guarded(() => {
				const opened = openSnapshot(ctx.cwd, params.connection);
				return ok(renderOverview(opened.snapshot, opened.knowledge, { connection: opened.name }), opened.name);
			});
		},
	};
}

const TABLE_PARAMETERS = {
	type: "object",
	properties: {
		table: { type: "string", description: 'Table or view: "orders", "shop.orders" or "shop.shop.orders".' },
		columns: {
			anyOf: [{ type: "string", const: "all" }, { type: "integer", minimum: 1 }],
			description: 'How many columns to list (default 60, most telling first), or "all".',
		},
		column_filter: { type: "string", description: "Only columns whose name or comment contains this text; ignores case and accents." },
		connection: CONNECTION,
	},
	required: ["table"],
	additionalProperties: false,
} as const;

export function createTableTool(): ToolDefinition<typeof TABLE_PARAMETERS, ToolDetails> {
	return {
		name: "heydb_table",
		label: "heydb table",
		description:
			"One table or view: comment, team notes (with ids), keys, relationships both ways (who references it), then its most relevant columns.",
		promptSnippet: "Show what one database table means and its columns, keys, relationships and notes",
		promptGuidelines: [
			"Before writing or changing SQL in a heydb project, check heydb_table (or heydb_search) for the tables involved instead of guessing names, columns or joins.",
			"Read the heydb_table header (comment, notes, referenced by) before concluding what a table is; when its meaning comes from inference (columns, references, name), say it is an inference and ask the user before saving it with heydb_annotate.",
		],
		parameters: TABLE_PARAMETERS,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return guarded(() => {
				// Pi validates the schema, but the check is repeated so no other caller can pass 0 or 2.5.
				const { columns } = params;
				if (columns !== undefined && columns !== "all" && !(Number.isInteger(columns) && columns >= 1)) {
					throw new Error('columns must be "all" or an integer of at least 1');
				}
				const opened = openSnapshot(ctx.cwd, params.connection);
				const resolved = resolveTable(opened.snapshot, params.table);
				const knowledge = knowledgeForTable(opened.knowledge, resolved.name);
				const incoming = incomingReferences(opened.snapshot, opened.knowledge, resolved.name);
				const options = {
					...(columns !== undefined && { columns }),
					...(params.column_filter !== undefined && { columnFilter: params.column_filter }),
				};
				return ok(renderTable(resolved.table, resolved.name, knowledge, incoming, options), opened.name);
			});
		},
	};
}

const MAX_SEARCH_LIMIT = 50;

const SEARCH_PARAMETERS = {
	type: "object",
	properties: {
		query: { type: "string", description: "Text to find; case and accents are ignored." },
		limit: { type: "integer", minimum: 1, maximum: MAX_SEARCH_LIMIT, description: "Maximum results (default 20)." },
		connection: CONNECTION,
	},
	required: ["query"],
	additionalProperties: false,
} as const;

export function createSearchTool(): ToolDefinition<typeof SEARCH_PARAMETERS, ToolDetails> {
	return {
		name: "heydb_search",
		label: "heydb search",
		description: "Search names, comments, view definitions and team notes of the schema; ignores case and accents.",
		promptSnippet: "Search the database schema and its notes by keyword",
		promptGuidelines: ["Use heydb_search to find which tables or columns hold a concept before writing SQL."],
		parameters: SEARCH_PARAMETERS,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return guarded(() => {
				// Pi validates the schema, but the check is repeated so no other caller can ask for 10,000 results.
				const { limit = 20 } = params;
				if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
					throw new Error(`limit must be an integer from 1 to ${MAX_SEARCH_LIMIT}`);
				}
				const opened = openSnapshot(ctx.cwd, params.connection);
				return ok(renderSearch(searchSchema(opened.snapshot, opened.knowledge, params.query, { limit })), opened.name);
			});
		},
	};
}

const ANNOTATE_PARAMETERS = {
	type: "object",
	properties: {
		target: {
			type: "string",
			description: 'Database ("shop"), table ("orders", "shop.orders") or column ("orders.status").',
		},
		text: { type: "string", description: "Short, factual note." },
		connection: CONNECTION,
	},
	required: ["target", "text"],
	additionalProperties: false,
} as const;

export function createAnnotateTool(deps: HeydbDeps): ToolDefinition<typeof ANNOTATE_PARAMETERS, ToolDetails> {
	return {
		name: "heydb_annotate",
		label: "heydb annotate",
		description:
			"Save a note on a database, table or column in .heydb/knowledge; the team gets it when the project commits .heydb/.",
		promptSnippet: "Record what a database, table or column means, for the whole team",
		promptGuidelines: [
			"When you learn what a table or column means (valid values, units, legacy quirks), save it with heydb_annotate: one or two factual sentences, never invent or guess.",
			"Before heydb_annotate, read the existing notes with heydb_table; fix a wrong note with heydb_edit_note instead of adding a contradicting one.",
		],
		parameters: ANNOTATE_PARAMETERS,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return guarded(async () => {
				const opened = openSnapshot(ctx.cwd, params.connection);
				const target = resolveTarget(opened.snapshot, params.target);
				const author = await agentAuthor(deps, ctx.cwd);
				const note = annotate(opened.root, opened.name, { target: target.name, text: params.text, author }, deps.knowledge);
				return ok(`Saved note ${note.id} on ${target.kind} ${displayNameOf(note.target)} (author: ${note.author}).`, opened.name);
			});
		},
	};
}

const COLUMNS = { type: "array", items: { type: "string" }, minItems: 1 } as const;

const RELATE_PARAMETERS = {
	type: "object",
	properties: {
		from_table: { type: "string", description: "Table holding the reference, e.g. orders." },
		from_columns: { ...COLUMNS, description: "Referencing columns, in order." },
		to_table: { type: "string", description: "Referenced table, e.g. customers." },
		to_columns: { ...COLUMNS, description: "Referenced columns, same order and count." },
		note: { type: "string", description: "How you know, briefly." },
		connection: CONNECTION,
	},
	required: ["from_table", "from_columns", "to_table", "to_columns"],
	additionalProperties: false,
} as const;

export function createRelateTool(deps: HeydbDeps): ToolDefinition<typeof RELATE_PARAMETERS, ToolDetails> {
	return {
		name: "heydb_relate",
		label: "heydb relate",
		description: "Document an implicit relationship: columns that join two tables without a foreign key.",
		promptSnippet: "Record a join between tables that has no foreign key",
		promptGuidelines: [
			"When you find tables joined without a foreign key (in code, queries or data), record it with heydb_relate and say how you know in the note.",
		],
		parameters: RELATE_PARAMETERS,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return guarded(async () => {
				const opened = openSnapshot(ctx.cwd, params.connection);
				const from = { table: resolveTable(opened.snapshot, params.from_table).name, columns: params.from_columns };
				const to = { table: resolveTable(opened.snapshot, params.to_table).name, columns: params.to_columns };
				const author = await agentAuthor(deps, ctx.cwd);
				const link = relate(opened.root, opened.name, { from, to, note: params.note ?? "", author }, deps.knowledge);
				return ok(`Saved relationship ${link.id}: ${side(link.from)} → ${side(link.to)} (author: ${link.author}).`, opened.name);
			});
		},
	};
}

const EDIT_PARAMETERS = {
	type: "object",
	properties: {
		id: { type: "string", description: "Note id, as shown by heydb_table." },
		text: { type: "string", description: "The new text, replacing the old one." },
		connection: CONNECTION,
	},
	required: ["id", "text"],
	additionalProperties: false,
} as const;

export function createEditNoteTool(deps: HeydbDeps): ToolDefinition<typeof EDIT_PARAMETERS, ToolDetails> {
	return {
		name: "heydb_edit_note",
		label: "heydb edit note",
		description: "Replace the text of a heydb note by id; author and creation date are kept.",
		promptSnippet: "Correct the text of an existing heydb note",
		parameters: EDIT_PARAMETERS,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return guarded(() => {
				const opened = openConnection(ctx.cwd, params.connection);
				const note = editNote(opened.root, opened.name, { id: params.id, text: params.text }, deps.knowledge);
				return ok(`Updated note ${note.id} on ${displayNameOf(note.target)}.`, opened.name);
			});
		},
	};
}

const FORGET_PARAMETERS = {
	type: "object",
	properties: {
		id: { type: "string", description: "Id of a note or relationship, as shown by heydb_table." },
		connection: CONNECTION,
	},
	required: ["id"],
	additionalProperties: false,
} as const;

export function createForgetTool(): ToolDefinition<typeof FORGET_PARAMETERS, ToolDetails> {
	return {
		name: "heydb_forget",
		label: "heydb forget",
		description: "Delete a heydb note or implicit relationship by id.",
		promptSnippet: "Delete a wrong or obsolete heydb note or relationship",
		promptGuidelines: ["Use heydb_forget only for notes that are wrong or obsolete, and say which one you removed."],
		parameters: FORGET_PARAMETERS,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return guarded(() => {
				const opened = openConnection(ctx.cwd, params.connection);
				const forgotten = forgetById(opened.root, opened.name, params.id);
				const text =
					forgotten.kind === "annotation"
						? `Forgot note ${forgotten.annotation.id} on ${displayNameOf(forgotten.annotation.target)}.`
						: `Forgot relationship ${forgotten.relationship.id}: ${side(forgotten.relationship.from)} → ${side(forgotten.relationship.to)}.`;
				return ok(text, opened.name);
			});
		},
	};
}

async function agentAuthor(deps: HeydbDeps, cwd: string): Promise<string> {
	return `${await deps.author(cwd)}${AGENT_AUTHOR_SUFFIX}`;
}

function side(value: RelationshipSide): string {
	return `${displayNameOf(value.table)}(${value.columns.join(", ")})`;
}

function ok(text: string, connection: string): Result {
	return { content: [{ type: "text", text }], details: { connection } };
}

async function guarded(work: () => Result | Promise<Result>): Promise<Result> {
	try {
		return await work();
	} catch (error) {
		return { content: [{ type: "text", text: forAgent(error) }], details: { connection: null }, isError: true };
	}
}

// The agent cannot run slash commands; it has to ask the user to.
function forAgent(error: unknown): string {
	if (error instanceof ProjectError) {
		switch (error.code) {
			case "not_initialized":
				return "No heydb project in this folder or above. Ask the user to run /heydb:init, then /heydb:connect and /heydb:sync.";
			case "no_connections":
				return "This heydb project has no connections yet. Ask the user to run /heydb:connect, then /heydb:sync.";
			case "never_synced":
				return `Connection "${error.connection}" was never synced, so there is no schema snapshot yet. Ask the user to run /heydb:sync ${error.connection}.`;
		}
	}
	return error instanceof Error ? error.message : String(error);
}
