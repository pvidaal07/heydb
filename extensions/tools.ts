import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { knowledgeForTable } from "../lib/knowledge/query.ts";
import type { Annotation, RelationshipSide } from "../lib/knowledge/types.ts";
import { displayNameOf } from "../lib/model/names.ts";
import { incomingReferences } from "../lib/model/references.ts";
import { renderOverview, renderSearch, renderTable } from "../lib/render/markdown.ts";
import { searchSchema } from "../lib/search.ts";
import { PROJECT_TARGET } from "../lib/knowledge/types.ts";
import { annotate, annotateProject, editNote, projectNotes, relate, relationshipsFromOtherConnections } from "../lib/usecases/knowledge.ts";
import { ProjectError, forgetById, openConnection, openProjectRoot, openSnapshot, resolveTarget } from "../lib/usecases/project.ts";
import { resolveTable } from "../lib/usecases/resolve.ts";
import { SHARE_NOTES_HINT, knowledgeSharing } from "../lib/usecases/sharing.ts";
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

// Sent with every tool on every turn, so it says nothing the name and the skill do not: omitted, the default connection is used.
const CONNECTION = { type: "string" } as const;

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
		description: "Per database: comment coverage, name prefixes, core tables; warnings; tables; project notes.",
		promptSnippet: "Map of an unknown schema",
		promptGuidelines: ["Use heydb_overview only to map an unknown schema, never for a question that names a table or concept."],
		parameters: OVERVIEW_PARAMETERS,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return guarded(() => {
				const opened = openSnapshot(ctx.cwd, params.connection);
				const options = { connection: opened.name, projectNotes: projectNotes(opened.root) };
				return ok(renderOverview(opened.snapshot, opened.knowledge, options), opened.name);
			});
		},
	};
}

const TABLE_PARAMETERS = {
	type: "object",
	properties: {
		table: { type: "string", description: '"orders" or "shop.orders".' },
		columns: {
			anyOf: [{ type: "string", const: "all" }, { type: "integer", minimum: 1 }],
			description: 'Columns to list (default 60, most telling first) or "all" (costly when wide).',
		},
		column_filter: { type: "string", description: "Only columns whose name or comment contains this text." },
		connection: CONNECTION,
	},
	required: ["table"],
	additionalProperties: false,
} as const;

export function createTableTool(): ToolDefinition<typeof TABLE_PARAMETERS, ToolDetails> {
	return {
		name: "heydb_table",
		label: "heydb table",
		description: "One table or view: comment, notes, keys, relationships both ways, most telling columns.",
		promptSnippet: "One table: meaning, columns, keys, joins, notes",
		promptGuidelines: [
			"Before writing SQL, check its tables with heydb_table; never guess names, columns or joins.",
			"Read the heydb_table header (comment, notes, referenced by) before concluding what a table is; meaning from columns or names is an inference: say so, ask the user.",
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
				const other = relationshipsFromOtherConnections(opened.root, opened.name, resolved.name);
				const options = {
					...(columns !== undefined && { columns }),
					...(params.column_filter !== undefined && { columnFilter: params.column_filter }),
					connection: opened.name,
					external: other.relationships,
					unreadable: other.unreadable,
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
		query: { type: "string", description: "Words to find." },
		limit: { type: "integer", minimum: 1, maximum: MAX_SEARCH_LIMIT, description: "Maximum results (default 10; set it to list weaker matches too)." },
		database: { type: "string", description: 'Only this database, e.g. "shop".' },
		connection: CONNECTION,
	},
	required: ["query"],
	additionalProperties: false,
} as const;

export function createSearchTool(): ToolDefinition<typeof SEARCH_PARAMETERS, ToolDetails> {
	return {
		name: "heydb_search",
		label: "heydb search",
		description:
			"Find tables by name, comment, notes, columns and meaning inferred from the columns that reference them.",
		promptSnippet: "Search the schema and its notes by keyword",
		promptGuidelines: [
			"Use heydb_search first to find which tables or columns hold a concept, before writing SQL.",
			"A heydb_search result marked (inferred) is an inference: confirm with the user before relying on it or saving it.",
		],
		parameters: SEARCH_PARAMETERS,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return guarded(() => {
				// Pi validates the schema, but the check is repeated so no other caller can ask for 10,000 results.
				const { limit } = params;
				if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT)) {
					throw new Error(`limit must be an integer from 1 to ${MAX_SEARCH_LIMIT}`);
				}
				const opened = openSnapshot(ctx.cwd, params.connection);
				// Without a limit, searchSchema leaves out the far weaker matches; with one, it lists that many.
				const options = {
					...(limit !== undefined && { limit }),
					...(params.database !== undefined && { database: params.database }),
					projectNotes: projectNotes(opened.root),
				};
				return ok(renderSearch(searchSchema(opened.snapshot, opened.knowledge, params.query, options)), opened.name);
			});
		},
	};
}

const ANNOTATE_PARAMETERS = {
	type: "object",
	properties: {
		target: { type: "string", description: 'Database, table ("shop.orders") or column ("orders.status").' },
		scope: { type: "string", const: "project", description: "Without target: a note about the whole project." },
		text: { type: "string", description: "Short, factual note." },
		connection: CONNECTION,
	},
	required: ["text"],
	additionalProperties: false,
} as const;

export function createAnnotateTool(deps: HeydbDeps): ToolDefinition<typeof ANNOTATE_PARAMETERS, ToolDetails> {
	return {
		name: "heydb_annotate",
		label: "heydb annotate",
		description: "Save a note on the project, a database, table or column in .heydb/knowledge; shared if the project commits .heydb/.",
		promptSnippet: "Record what a database, table or column means",
		promptGuidelines: [
			"After reading code or docs for what heydb lacked, or when the user confirms something, save it with heydb_annotate in the words people search with: a process on its main table (entry file:function, tables read and written, their columns) or a meaning; never a guess.",
			'End a heydb_annotate note with "(code: path)" or "(told by the user)"; check notes with heydb_table first and extend a similar one with heydb_edit_note instead of adding another.',
		],
		parameters: ANNOTATE_PARAMETERS,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return guarded(async () => {
				// A separate scope, not a magic target: a table called "project" must stay reachable as target "project".
				if (params.scope === "project") {
					if (params.target !== undefined) throw new Error('a project note has no target: omit target with scope "project"');
					const root = openProjectRoot(ctx.cwd);
					const note = annotateProject(root, { text: params.text, author: await agentAuthor(deps, ctx.cwd) }, deps.knowledge);
					return ok(`Saved project note ${note.id} (author: ${note.author}).${await sharingWarning(root, PROJECT_FILE_SHARING)}`, null);
				}
				if (params.target === undefined) throw new Error('target is required, unless scope is "project"');
				const opened = openSnapshot(ctx.cwd, params.connection);
				const target = resolveProjectHint(params.target, () => resolveTarget(opened.snapshot, params.target as string));
				const author = await agentAuthor(deps, ctx.cwd);
				const note = annotate(opened.root, opened.name, { target: target.name, text: params.text, author }, deps.knowledge);
				const saved = `Saved note ${note.id} on ${target.kind} ${displayNameOf(note.target)} (author: ${note.author}).`;
				return ok(saved + (await sharingWarning(opened.root, opened.name)), opened.name);
			});
		},
	};
}

const COLUMNS = { type: "array", items: { type: "string" }, minItems: 1 } as const;

const RELATE_PARAMETERS = {
	type: "object",
	properties: {
		from_table: { type: "string", description: "Table holding the reference." },
		from_columns: COLUMNS,
		to_table: { type: "string", description: "Referenced table." },
		to_columns: COLUMNS,
		to_connection: { type: "string", description: "Connection of to_table, if another." },
		note: { type: "string", description: "How you know." },
		connection: CONNECTION,
	},
	required: ["from_table", "from_columns", "to_table", "to_columns"],
	additionalProperties: false,
} as const;

export function createRelateTool(deps: HeydbDeps): ToolDefinition<typeof RELATE_PARAMETERS, ToolDetails> {
	return {
		name: "heydb_relate",
		label: "heydb relate",
		description: "Document columns that join two tables without a foreign key.",
		promptSnippet: "Record a join that has no foreign key",
		promptGuidelines: ["Record a join without a foreign key with heydb_relate: its condition, and how you know in note."],
		parameters: RELATE_PARAMETERS,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return guarded(async () => {
				const opened = openSnapshot(ctx.cwd, params.connection);
				const from = { table: resolveTable(opened.snapshot, params.from_table).name, columns: params.from_columns };
				// The to side is resolved in its own connection's snapshot; a stored side names its connection only when it differs.
				const target = params.to_connection === undefined ? opened : openSnapshot(ctx.cwd, params.to_connection);
				const to = {
					...(target.name !== opened.name && { connection: target.name }),
					table: resolveTable(target.snapshot, params.to_table).name,
					columns: params.to_columns,
				};
				const author = await agentAuthor(deps, ctx.cwd);
				const link = relate(opened.root, opened.name, { from, to, note: params.note ?? "", author }, deps.knowledge);
				const saved = `Saved relationship ${link.id}: ${side(link.from)} → ${side(link.to)} (author: ${link.author}).`;
				return ok(saved + (await sharingWarning(opened.root, opened.name)), opened.name);
			});
		},
	};
}

const EDIT_PARAMETERS = {
	type: "object",
	properties: {
		id: { type: "string", description: "Note id." },
		text: { type: "string", description: "New text." },
		connection: CONNECTION,
	},
	required: ["id", "text"],
	additionalProperties: false,
} as const;

export function createEditNoteTool(deps: HeydbDeps): ToolDefinition<typeof EDIT_PARAMETERS, ToolDetails> {
	return {
		name: "heydb_edit_note",
		label: "heydb edit note",
		description: "Replace the text of a note by id; author and date are kept.",
		promptSnippet: "Correct an existing heydb note",
		parameters: EDIT_PARAMETERS,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return guarded(() => {
				const opened = openConnection(ctx.cwd, params.connection);
				const note = editNote(opened.root, opened.name, { id: params.id, text: params.text }, deps.knowledge);
				return ok(isProjectNote(note) ? `Updated project note ${note.id}.` : `Updated note ${note.id} on ${displayNameOf(note.target)}.`, opened.name);
			});
		},
	};
}

const FORGET_PARAMETERS = {
	type: "object",
	properties: {
		id: { type: "string", description: "Note or relationship id." },
		connection: CONNECTION,
	},
	required: ["id"],
	additionalProperties: false,
} as const;

export function createForgetTool(): ToolDefinition<typeof FORGET_PARAMETERS, ToolDetails> {
	return {
		name: "heydb_forget",
		label: "heydb forget",
		description: "Delete a note or implicit relationship by id.",
		promptSnippet: "Delete a wrong note or relationship",
		promptGuidelines: ["Use heydb_forget only for wrong or obsolete notes, and say which one you removed."],
		parameters: FORGET_PARAMETERS,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return guarded(() => {
				const opened = openConnection(ctx.cwd, params.connection);
				const forgotten = forgetById(opened.root, opened.name, params.id);
				const text =
					forgotten.kind === "annotation"
						? isProjectNote(forgotten.annotation)
							? `Forgot project note ${forgotten.annotation.id}.`
							: `Forgot note ${forgotten.annotation.id} on ${displayNameOf(forgotten.annotation.target)}.`
						: `Forgot relationship ${forgotten.relationship.id}: ${side(forgotten.relationship.from)} → ${side(forgotten.relationship.to)}.`;
				return ok(text, opened.name);
			});
		},
	};
}

/**
 * Said after saving only when git ignores the notes: the agent would
 * otherwise tell the user the team has them. Saving already succeeded, so a
 * failing git check adds nothing rather than turning it into an error.
 */
async function sharingWarning(root: string, connection: string): Promise<string> {
	try {
		const sharing = await knowledgeSharing(root, { connection });
		if (sharing.state !== "ignored") return "";
		return `\nNote saved locally; git ignores it (${sharing.rule}), so the team will not get it. ${SHARE_NOTES_HINT}`;
	} catch {
		return "";
	}
}

/** What knowledgeSharing checks for project notes: .heydb/knowledge/_project.json. */
const PROJECT_FILE_SHARING = "_project";

/** An agent that writes target "project" for a project note gets told about scope when nothing is called project. */
function resolveProjectHint<T>(target: string, resolve: () => T): T {
	try {
		return resolve();
	} catch (error) {
		if (target.trim().toLowerCase() !== PROJECT_TARGET || !(error instanceof Error)) throw error;
		throw new Error(`${error.message}\nFor a note about the whole project, use scope: "project" without a target.`, { cause: error });
	}
}

function isProjectNote(note: Annotation): boolean {
	return note.target === PROJECT_TARGET;
}

async function agentAuthor(deps: HeydbDeps, cwd: string): Promise<string> {
	return `${await deps.author(cwd)}${AGENT_AUTHOR_SUFFIX}`;
}

function side(value: RelationshipSide): string {
	const connection = value.connection === undefined ? "" : `${value.connection}: `;
	return `${connection}${displayNameOf(value.table)}(${value.columns.join(", ")})`;
}

function ok(text: string, connection: string | null): Result {
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
