import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";

import { aboutMessage } from "../lib/about.ts";
import { addConnection, removeConnection } from "../lib/config/operations.ts";
import { loadConfig } from "../lib/config/store.ts";
import type { ConnectionConfig } from "../lib/config/types.ts";
import { validateConnection } from "../lib/config/validate.ts";
import type { Snapshot } from "../lib/model/snapshot.ts";
import { renderChanges, renderStatus } from "../lib/render/markdown.ts";
import { toConnectionName } from "../lib/store/guards.ts";
import { findProjectRoot } from "../lib/store/project.ts";
import { type SchemaUsage, findSchemaUsage } from "../lib/usecases/code-scan.ts";
import { initProject } from "../lib/usecases/init.ts";
import {
	type ConnectionSummary,
	type OpenedConnection,
	ProjectError,
	buildConnection,
	captureLive,
	chooseDefaultConnection,
	forgetConnection,
	listConnections,
	openConnection,
	openSnapshot,
	projectConnections,
	saveNewConnection,
	savePassword,
} from "../lib/usecases/project.ts";
import { SHARE_NOTES_HINT, knowledgeSharing } from "../lib/usecases/sharing.ts";
import { checkStatus } from "../lib/usecases/status.ts";
import { syncSnapshot } from "../lib/usecases/sync.ts";
import type { HeydbDeps } from "./deps.ts";
import { askSecret } from "./secret-input.ts";

// Commands are what a person types. Unlike tools, /heydb:sync and
// /heydb:status connect to the database: a person chose to run them, and
// their own environment holds the password. Results are notifications;
// errors are notifications with level "error", never thrown at Pi.
//
// A password a person types (/heydb:connect, /heydb:password) goes from the
// masked input straight to .heydb/.env: never into a notification, a message,
// the session or an error.

type Command = Omit<RegisteredCommand, "name" | "sourceInfo">;

/** Sends a message into the session; it is shown and becomes context for the model. */
export type SendMessage = ExtensionAPI["sendMessage"];

const ENGINES = ["mysql", "mariadb", "postgresql"];

// What each engine is usually reached with: shown as hints, and the port is
// also what an empty answer means.
const ENGINE_DEFAULTS: Readonly<Record<string, { port: string; user: string }>> = {
	mysql: { port: "3306", user: "root" },
	mariadb: { port: "3306", user: "root" },
	postgresql: { port: "5432", user: "postgres" },
};

export function registerHeydbCommands(pi: ExtensionAPI, deps: HeydbDeps): void {
	for (const [name, command] of createHeydbCommands(deps, (message, options) => pi.sendMessage(message, options))) {
		pi.registerCommand(name, command);
	}
}

export function createHeydbCommands(deps: HeydbDeps, sendMessage: SendMessage): [name: string, command: Command][] {
	// Commands that connect run one at a time, in order. Pi may start a second
	// one while the first awaits the server; two syncs of one connection would
	// race on its snapshot file, and under Pi's module loader two first-time
	// loads of mysql2 at once break the second (seen with RPC; plain Node is fine).
	let queue: Promise<void> = Promise.resolve();
	const oneAtATime = (work: () => Promise<void>): Promise<void> => {
		const run = queue.then(work);
		queue = run.catch(() => {});
		return run;
	};

	return [
		[
			"heydb:about",
			{
				description: "Show the installed heydb version",
				handler: async (_args, ctx) => {
					ctx.ui.notify(aboutMessage(), "info");
				},
			},
		],
		["heydb:init", { description: "Make this folder a heydb project (.heydb/)", handler: async (_args, ctx) => init(ctx) }],
		[
			"heydb:connect",
			{
				description: "Add a database connection (a typed password is kept in .heydb/.env, ignored by git)",
				handler: (_args, ctx) => connect(deps, ctx),
			},
		],
		[
			"heydb:sync",
			{
				description: "Capture the live schema and store it if it changed: /heydb:sync [connection]",
				getArgumentCompletions: (prefix) => completeConnection(deps, prefix),
				handler: (args, ctx) => oneAtATime(() => sync(deps, sendMessage, args, ctx)),
			},
		],
		[
			"heydb:status",
			{
				description: "Compare the live schema with the stored snapshot: /heydb:status [connection]",
				getArgumentCompletions: (prefix) => completeConnection(deps, prefix),
				handler: (args, ctx) => oneAtATime(() => status(deps, args, ctx)),
			},
		],
		[
			"heydb:password",
			{
				description: "Type a connection's password, kept in .heydb/.env (ignored by git): /heydb:password [connection]",
				getArgumentCompletions: (prefix) => completeConnection(deps, prefix),
				handler: (args, ctx) => password(deps, args, ctx),
			},
		],
		[
			"heydb:connections",
			{
				description: "List connections, change the default or remove one: /heydb:connections [list | use <name> | remove <name>]",
				getArgumentCompletions: (prefix) => completeConnections(deps, prefix),
				handler: (args, ctx) => connections(deps, args, ctx),
			},
		],
		[
			"heydb:learn-code",
			{
				description: "Offer the agent this project's code that uses the tables, to note what it shows: /heydb:learn-code [connection]",
				getArgumentCompletions: (prefix) => completeConnection(deps, prefix),
				handler: (args, ctx) => learnCode(sendMessage, args, ctx),
			},
		],
	];
}

function init(ctx: ExtensionCommandContext): void {
	// Run inside an existing project, init fills in what is missing there instead of nesting a new one.
	const root = findProjectRoot(ctx.cwd) ?? ctx.cwd;
	attempt(ctx, () => {
		const { created } = initProject(root);
		ctx.ui.notify(
			created.length === 0
				? `heydb project already initialized in ${root}.`
				: `heydb project ready in ${root}: created ${created.join(", ")}. Next: /heydb:connect.`,
			"info",
		);
	});
}

async function connect(deps: HeydbDeps, ctx: ExtensionCommandContext): Promise<void> {
	const root = findProjectRoot(ctx.cwd);
	if (root === null) return failed(ctx, new ProjectError("not_initialized", ""));
	if (!ctx.hasUI) {
		ctx.ui.notify(
			"/heydb:connect needs an interactive session. Add the connection to .heydb/config.json instead, for example:\n" +
				'"connections": { "local": { "engine": "mysql", "host": "127.0.0.1", "port": 3306, "user": "root", ' +
				'"password": "env:HEYDB_LOCAL_PASSWORD", "databases": null } }\n' +
				'"password" is only the name of the variable that holds it; set HEYDB_LOCAL_PASSWORD in your shell or in .heydb/.env.\n' +
				'For PostgreSQL use "engine": "postgresql", port 5432, exactly one database in "databases" and, optionally, ' +
				'"schemas": ["public"] (null captures every non-system schema).',
			"info",
		);
		return;
	}

	// The password is asked last, with the masked input: ctx.ui.input shows
	// what is typed. config.json only holds the name of the variable that has it.
	const name = await ctx.ui.input("Connection name", "local");
	const engine = name === undefined ? undefined : await ctx.ui.select("Engine", ENGINES);
	const defaults = ENGINE_DEFAULTS[engine ?? "mysql"] ?? { port: "3306", user: "root" };
	const host = engine === undefined ? undefined : await ctx.ui.input("Host", "127.0.0.1");
	const port = host === undefined ? undefined : await ctx.ui.input("Port", defaults.port);
	const user = port === undefined ? undefined : await ctx.ui.input("User", defaults.user);
	// A PostgreSQL connection reaches one database and chooses schemas inside it;
	// in MySQL and MariaDB each database is its own schema.
	const postgres = engine === "postgresql";
	const databases =
		user === undefined
			? undefined
			: postgres
				? await ctx.ui.input("Database (exactly one: a PostgreSQL connection reaches one database)", "postgres")
				: await ctx.ui.input("Databases (comma-separated, empty for all)", "shop, crm");
	const schemas =
		databases === undefined || !postgres
			? ""
			: await ctx.ui.input("Schemas (comma-separated, empty for all non-system schemas)", "public");
	if (
		name === undefined ||
		engine === undefined ||
		host === undefined ||
		port === undefined ||
		user === undefined ||
		databases === undefined ||
		schemas === undefined
	) {
		ctx.ui.notify("heydb:connect cancelled; nothing was saved.", "info");
		return;
	}

	// Everything is checked before the password is asked, so nobody types one for nothing.
	let prepared: { connectionName: string; entry: ConnectionConfig; renamed: string };
	try {
		const typed = name.trim() === "" ? "local" : name.trim();
		const connectionName = toConnectionName(typed);
		if (connectionName === null) {
			return ctx.ui.notify(
				`"${typed}" has no letters or digits to build a connection name from; use lowercase letters, digits, "-" or "_".`,
				"error",
			);
		}
		const renamed =
			connectionName === typed
				? ""
				: `Connection names are lowercase letters, digits, "-" and "_", so "${typed}" became "${connectionName}".\n`;
		const answers = { engine, host, port: port.trim() === "" ? defaults.port : port, user, databases };
		const built = buildConnection(connectionName, answers);
		const entry = postgres ? validateConnection({ ...built, schemas: list(schemas) }, connectionName) : built;
		addConnection(loadConfig(root), connectionName, entry); // only to refuse a taken name now
		prepared = { connectionName, entry, renamed };
	} catch (error) {
		return failed(ctx, error);
	}
	const { connectionName, entry, renamed } = prepared;
	const variable = variableOf(entry);

	const typedPassword = await askSecret(
		ctx,
		`Password for ${connectionName} (stored in .heydb/.env, ignored by git; leave empty to set ${variable} yourself)`,
	);
	if (typedPassword === undefined) {
		ctx.ui.notify("heydb:connect cancelled; nothing was saved.", "info");
		return;
	}

	attempt(ctx, () => {
		const { isDefault } = saveNewConnection(root, connectionName, entry);
		const saved = `Saved connection "${connectionName}" (${describe(entry)})${isDefault ? " as the default" : ""}.\n${renamed}`;
		// null: no terminal to type it in (RPC); empty: the person sets it themselves.
		if (typedPassword === null || typedPassword === "") {
			return ctx.ui.notify(
				`${saved}heydb never stores passwords: set ${variable} in your shell or in .heydb/.env (ignored by git), ` +
					`then run /heydb:sync ${connectionName}.`,
				"info",
			);
		}
		try {
			savePassword(root, entry.password, typedPassword);
		} catch (error) {
			throw new Error(`${saved}The password was not saved: ${message(error)}`, { cause: error });
		}
		ctx.ui.notify(
			`${saved}Password saved in .heydb/.env as ${variable} (ignored by git). Next: /heydb:sync ${connectionName}.` +
				environmentNote(deps, variable),
			"info",
		);
	});
}

/** Comma-separated names; nothing typed means null, "all". */
function list(text: string): string[] | null {
	const items = text
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item !== "");
	return items.length === 0 ? null : items;
}

async function password(deps: HeydbDeps, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const words = argumentWords(args);
	if (words.length > 1) return ctx.ui.notify("Usage: /heydb:password [connection]", "error");
	let opened: OpenedConnection;
	try {
		opened = openConnection(ctx.cwd, words[0]);
	} catch (error) {
		return failed(ctx, error);
	}
	const variable = variableOf(opened.connection);
	const typed = await askSecret(ctx, `Password for ${opened.name} (stored in .heydb/.env, ignored by git; leave empty to keep it as it is)`);
	if (typed === null) {
		return ctx.ui.notify(
			`Typing a password needs Pi's interactive terminal. Set ${variable} in your shell or in .heydb/.env (ignored by git).`,
			"info",
		);
	}
	if (typed === undefined) return ctx.ui.notify("heydb:password cancelled; nothing was saved.", "info");
	if (typed === "") return ctx.ui.notify(`Nothing changed: the password for "${opened.name}" was left as it is.`, "info");
	attempt(ctx, () => {
		savePassword(opened.root, opened.connection.password, typed);
		ctx.ui.notify(
			`Password for "${opened.name}" saved in .heydb/.env as ${variable} (ignored by git). Next: /heydb:sync ${opened.name}.` +
				environmentNote(deps, variable),
			"info",
		);
	});
}

/** The environment wins over .heydb/.env, so a value saved there would otherwise be ignored without a word. */
function environmentNote(deps: HeydbDeps, variable: string): string {
	if (deps.env[variable] === undefined) return "";
	return `\nNote: ${variable} is also set in your environment, and that value wins over .heydb/.env.`;
}

const CONNECTIONS_USAGE = "Usage: /heydb:connections [list | use <name> | remove <name>]";
const SUBCOMMANDS = ["list", "use", "remove"];

async function connections(deps: HeydbDeps, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const [action = "list", name, ...extra] = argumentWords(args);
	const takesName = action === "use" || action === "remove";
	if (!SUBCOMMANDS.includes(action) || extra.length > 0 || takesName !== (name !== undefined)) {
		return ctx.ui.notify(CONNECTIONS_USAGE, "error");
	}
	try {
		const { root, connections: listed } = listConnections(ctx.cwd, deps.env);
		if (name === undefined) {
			const lines = [
				`heydb connections in ${root}:`,
				...listed.map(summaryLine),
				...(await sharingLine(root, listed)),
				"Change the default with /heydb:connections use <name>; set a password with /heydb:password <name>.",
			];
			return ctx.ui.notify(lines.join("\n"), "info");
		}
		if (action === "use") {
			chooseDefaultConnection(root, name);
			return ctx.ui.notify(`Default connection is now "${name}".`, "info");
		}
		await remove(root, name, ctx);
	} catch (error) {
		failed(ctx, error);
	}
}

async function remove(root: string, name: string, ctx: ExtensionCommandContext): Promise<void> {
	// Checked before asking: nobody should confirm the removal of a connection that does not exist.
	removeConnection(loadConfig(root), name);
	if (!ctx.hasUI) {
		return ctx.ui.notify("Removing a connection needs an interactive session to confirm it; edit .heydb/config.json instead.", "error");
	}
	const confirmed = await ctx.ui.confirm(
		`Remove connection "${name}"?`,
		"It is removed from .heydb/config.json and its password from .heydb/.env. Its snapshot and notes stay on disk.",
	);
	if (!confirmed) return ctx.ui.notify("heydb:connections remove cancelled; nothing was changed.", "info");
	const { passwordRemoved, kept } = forgetConnection(root, name);
	const lines = [`Removed connection "${name}"${passwordRemoved ? " and its password line in .heydb/.env" : ""}.`];
	if (kept.length > 0) {
		lines.push(`Kept on disk, so no notes are lost: ${kept.join(", ")}. Delete them yourself if you no longer need them.`);
	}
	ctx.ui.notify(lines.join("\n"), "info");
}

/**
 * Whether git shares the notes, said once for the project: every connection
 * keeps them in the same folder. A failing git check leaves the line out
 * rather than hiding the list.
 */
async function sharingLine(root: string, listed: readonly ConnectionSummary[]): Promise<string[]> {
	const connection = (listed.find((item) => item.isDefault) ?? listed[0])?.name;
	try {
		const sharing = await knowledgeSharing(root, connection === undefined ? {} : { connection });
		switch (sharing.state) {
			case "shared":
				return ["Notes in .heydb/knowledge/ are visible to git: the team gets them once they are committed."];
			case "no-git":
				return ["No git repository here: notes in .heydb/knowledge/ stay on this machine."];
			case "ignored":
				return [`Notes in .heydb/knowledge/ are ignored by git (${sharing.rule}), so the team will not get them. ${SHARE_NOTES_HINT}`];
		}
	} catch {
		return [];
	}
}

const PASSWORD_STATES: Readonly<Record<ConnectionSummary["password"], string>> = {
	environment: "set in your environment",
	"env-file": "in .heydb/.env",
	missing: "not set",
	unreadable: ".heydb/.env is unreadable",
};

function summaryLine(item: ConnectionSummary): string {
	return (
		`- ${item.name}${item.isDefault ? " (default)" : ""}: ${describe(item.connection)} · ` +
		`password ${variableOf(item.connection)}: ${PASSWORD_STATES[item.password]} · ${item.synced ? "synced" : "never synced"}`
	);
}

/** "env:HEYDB_LOCAL_PASSWORD" → "HEYDB_LOCAL_PASSWORD"; config validation guarantees the prefix. */
function variableOf(entry: ConnectionConfig): string {
	return entry.password.slice("env:".length);
}

async function sync(deps: HeydbDeps, sendMessage: SendMessage, args: string, ctx: ExtensionCommandContext): Promise<void> {
	await withLive(deps, args, ctx, "sync", async (opened, live) => {
		const result = syncSnapshot(opened.root, opened.name, live);
		const facts = [result.written ? "snapshot written" : "unchanged", ...summary(live)];
		if (result.written) facts.push(count(result.changes.length, "change"));
		// A failing scan must not turn a good sync into an error: it only loses the offer.
		const usage = await findSchemaUsage(opened.root, live).catch(() => null);
		const noCode = usage !== null && usage.matches.length === 0 ? `\n${NO_CODE}` : "";
		ctx.ui.notify(`heydb sync ${opened.name}: ${facts.join(" · ")}.${noCode}`, "info");
		// The changes also go into the session, so the model knows the schema it reads just moved.
		if (result.written && result.changes.length > 0) {
			await sendMessage({
				customType: "heydb",
				content: `heydb sync ${opened.name} changed the stored snapshot:\n\n${renderChanges(result.changes)}`,
				display: true,
			});
		}
		if (usage !== null && usage.matches.length > 0 && ctx.hasUI) await offerCode(sendMessage, opened.name, usage, ctx);
	});
}

// Many heydb projects have no code at all (one made only to explore a
// database); there, the notes come from what the person explains.
const NO_CODE =
	"No code using these tables was found here; heydb will learn from your conversations (the agent annotates what you explain).";

/** Same offer as after a sync, from the stored snapshot: it never connects. */
async function learnCode(sendMessage: SendMessage, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const words = argumentWords(args);
	if (words.length > 1) return ctx.ui.notify("Usage: /heydb:learn-code [connection]", "error");
	try {
		const opened = openSnapshot(ctx.cwd, words[0]);
		const usage = await findSchemaUsage(opened.root, opened.snapshot);
		if (usage.matches.length === 0) return ctx.ui.notify(`heydb learn-code ${opened.name}: ${NO_CODE}`, "info");
		if (!ctx.hasUI) {
			return ctx.ui.notify("/heydb:learn-code needs an interactive session to ask before the agent spends tokens.", "error");
		}
		await offerCode(sendMessage, opened.name, usage, ctx);
	} catch (error) {
		failed(ctx, error);
	}
}

/**
 * Asks before the agent reads code: that costs tokens, and the person may
 * rather do it later. Accepted, one message starts an agent turn; while the
 * agent works it waits as a follow-up instead of interrupting it.
 */
async function offerCode(sendMessage: SendMessage, connection: string, usage: SchemaUsage, ctx: ExtensionCommandContext): Promise<void> {
	const examples = usage.matches.slice(0, 3).map((match) => match.name);
	const confirmed = await ctx.ui.confirm(
		"Learn from this project's code?",
		`Found ${usage.truncated ? "at least " : ""}${count(usage.filesMatched, "file")} that use ${count(usage.tablesMatched, "table")} ` +
			`(e.g. ${examples.join(", ")}). heydb can ask the agent to read them and save notes about what the code shows. It will use tokens.`,
	);
	if (!confirmed) {
		return ctx.ui.notify(`Nothing was sent. Run /heydb:learn-code ${connection} whenever you want the agent to read it.`, "info");
	}
	const idle = ctx.isIdle();
	await sendMessage(
		{ customType: "heydb", content: learnMessage(connection, usage), display: true },
		{ triggerTurn: true, deliverAs: "followUp" },
	);
	ctx.ui.notify(
		idle
			? "Asked the agent to read the code and note what it shows."
			: "The agent is busy: it will read the code and note what it shows when it finishes its current work.",
		"info",
	);
}

/** The agent's instructions: which files, and what is worth a note. Bounded by the scan's top 30 tables. */
function learnMessage(connection: string, usage: SchemaUsage): string {
	const example = usage.matches[0]?.files[0] ?? "src/Models/Order.php";
	return [
		`heydb: the user agreed that you learn about the database of connection "${connection}" from this project's code.`,
		"",
		"Files that use its tables, most used first:",
		...usage.matches.map((match) => `- ${match.table} (${count(match.hits, "use")}): ${match.files.join(", ")}`),
		"",
		"Rules:",
		"- Read these files: models, repositories, queries. Before noting a table, read it with heydb_table and skip what its notes already say.",
		"- Save with heydb_annotate only what the code makes explicit: what a table holds, valid values, enums and magic numbers with their meaning, units, soft-delete flags. " +
			"Record joins the code makes without a foreign key with heydb_relate.",
		`- End every note with its source, like "(code: ${example})".`,
		"- Never invent or guess: what the code does not make clear is not saved.",
		"- A few valuable notes beat many; stop after about 20.",
		"- Finish with a short summary for the user: what you saved, and what remains unclear, as questions.",
	].join("\n");
}

async function status(deps: HeydbDeps, args: string, ctx: ExtensionCommandContext): Promise<void> {
	await withLive(deps, args, ctx, "status", async (opened, live) => {
		const result = checkStatus(opened.root, opened.name, live);
		const text = `heydb status ${opened.name}: ${renderStatus(result)}`;
		switch (result.state) {
			case "up_to_date":
				return ctx.ui.notify(text, "info");
			case "never_synced":
				return ctx.ui.notify(`${text} Run /heydb:sync ${opened.name}.`, "warning");
			case "drifted":
				return ctx.ui.notify(`${text}\n\nRun /heydb:sync ${opened.name} to store it.`, "warning");
		}
	});
}

/** Opens the connection named in `args` (or the default), captures its live schema and hands both to `work`. */
async function withLive(
	deps: HeydbDeps,
	args: string,
	ctx: ExtensionCommandContext,
	action: string,
	work: (opened: OpenedConnection, live: Snapshot) => Promise<void>,
): Promise<void> {
	// A second word is a mistake (two connections, a typo): better said than silently dropped.
	const words = argumentWords(args);
	if (words.length > 1) return ctx.ui.notify(`Usage: /heydb:${action} [connection]`, "error");
	try {
		const opened = openConnection(ctx.cwd, words[0]);
		// Config and password errors explain themselves; a driver error such as
		// "connect ECONNREFUSED" also needs to say what was being attempted.
		const introspect: HeydbDeps["introspect"] = async (entry, password) => {
			try {
				return await deps.introspect(entry, password);
			} catch (error) {
				throw new Error(`heydb ${action} ${opened.name} failed: ${message(error)}`, { cause: error });
			}
		};
		await work(opened, await captureLive(opened, { env: deps.env, introspect }));
	} catch (error) {
		failed(ctx, error);
	}
}

/** The words of a command's arguments; none for an empty or blank string. */
function argumentWords(args: string): string[] {
	return args
		.trim()
		.split(/\s+/)
		.filter((word) => word !== "");
}

type Completion = { value: string; label: string };

/** Connection names of the project in the current folder; nothing when there is none or its config is broken. */
function completeConnection(deps: HeydbDeps, prefix: string): Completion[] | null {
	const items = connectionNames(deps)
		.filter((name) => name.startsWith(prefix))
		.map((name) => ({ value: name, label: name }));
	return items.length > 0 ? items : null;
}

/**
 * The subcommand first, then a connection name for "use" and "remove". Pi
 * replaces everything typed after the command with the chosen value, so each
 * value repeats the subcommand.
 */
function completeConnections(deps: HeydbDeps, prefix: string): Completion[] | null {
	const [action = "", name, ...extra] = prefix.split(" ");
	let items: Completion[];
	if (name === undefined) {
		items = SUBCOMMANDS.filter((item) => item.startsWith(action)).map((item) => ({
			value: item === "list" ? item : `${item} `,
			label: item,
		}));
	} else if ((action === "use" || action === "remove") && extra.length === 0) {
		items = connectionNames(deps)
			.filter((item) => item.startsWith(name))
			.map((item) => ({ value: `${action} ${item}`, label: item }));
	} else {
		items = [];
	}
	return items.length > 0 ? items : null;
}

function connectionNames(deps: HeydbDeps): string[] {
	try {
		return projectConnections(deps.cwd())?.names ?? [];
	} catch {
		return []; // completion must never fail loudly; the command itself will report the broken config
	}
}

function attempt(ctx: ExtensionCommandContext, work: () => void): void {
	try {
		work();
	} catch (error) {
		failed(ctx, error);
	}
}

// A person can run slash commands, so the instructions name them directly.
function failed(ctx: ExtensionCommandContext, error: unknown): void {
	if (error instanceof ProjectError) {
		switch (error.code) {
			case "not_initialized":
				return ctx.ui.notify("No heydb project here: run /heydb:init first.", "error");
			case "no_connections":
				return ctx.ui.notify("No connections yet: run /heydb:connect first.", "error");
			case "never_synced":
				return ctx.ui.notify(`Connection "${error.connection}" was never synced: run /heydb:sync ${error.connection}.`, "error");
		}
	}
	ctx.ui.notify(message(error), "error");
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function describe(entry: ConnectionConfig): string {
	const server = `${entry.engine} ${entry.user}@${entry.host}:${entry.port}`;
	if (entry.engine === "postgresql") {
		const schemas = entry.schemas == null ? "all schemas" : `schemas ${entry.schemas.join(", ")}`;
		return `${server}, database ${entry.databases?.join(", ")}, ${schemas}`;
	}
	const databases = entry.databases === null ? "all databases" : `databases ${entry.databases.join(", ")}`;
	return `${server}, ${databases}`;
}

function summary(snapshot: Snapshot): string[] {
	const tables = snapshot.databases.reduce(
		(total, database) => total + database.schemas.reduce((sum, schema) => sum + schema.tables.length, 0),
		0,
	);
	const facts = [`${count(snapshot.databases.length, "database")}, ${count(tables, "table")}`];
	if (snapshot.warnings.length > 0) facts.push(count(snapshot.warnings.length, "warning"));
	return facts;
}

function count(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
