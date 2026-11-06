import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";

import { aboutMessage } from "../lib/about.ts";
import type { ConnectionConfig } from "../lib/config/types.ts";
import { validateConnection } from "../lib/config/validate.ts";
import type { Snapshot } from "../lib/model/snapshot.ts";
import { renderChanges, renderStatus } from "../lib/render/markdown.ts";
import { findProjectRoot } from "../lib/store/project.ts";
import { initProject } from "../lib/usecases/init.ts";
import {
	type OpenedConnection,
	ProjectError,
	buildConnection,
	captureLive,
	openConnection,
	projectConnections,
	saveNewConnection,
} from "../lib/usecases/project.ts";
import { checkStatus } from "../lib/usecases/status.ts";
import { syncSnapshot } from "../lib/usecases/sync.ts";
import type { HeydbDeps } from "./deps.ts";

// Commands are what a person types. Unlike tools, /heydb:sync and
// /heydb:status connect to the database: a person chose to run them, and
// their own environment holds the password. Results are notifications;
// errors are notifications with level "error", never thrown at Pi.

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
			{ description: "Add a database connection (the password stays in your environment)", handler: (_args, ctx) => connect(ctx) },
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

async function connect(ctx: ExtensionCommandContext): Promise<void> {
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

	// The password is never asked: anything typed here could end up in a log,
	// and config.json only holds the name of the variable that has it.
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

	attempt(ctx, () => {
		const connectionName = name.trim() === "" ? "local" : name.trim();
		const answers = { engine, host, port: port.trim() === "" ? defaults.port : port, user, databases };
		const built = buildConnection(connectionName, answers);
		const entry = postgres ? validateConnection({ ...built, schemas: list(schemas) }, connectionName) : built;
		const { isDefault } = saveNewConnection(root, connectionName, entry);
		const variable = entry.password.slice("env:".length);
		ctx.ui.notify(
			`Saved connection "${connectionName}" (${describe(entry)})${isDefault ? " as the default" : ""}.\n` +
				`heydb never stores passwords: set ${variable} in your shell or in .heydb/.env (ignored by git), ` +
				`then run /heydb:sync ${connectionName}.`,
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

async function sync(deps: HeydbDeps, sendMessage: SendMessage, args: string, ctx: ExtensionCommandContext): Promise<void> {
	await withLive(deps, args, ctx, "sync", async (opened, live) => {
		const result = syncSnapshot(opened.root, opened.name, live);
		const facts = [result.written ? "snapshot written" : "unchanged", ...summary(live)];
		if (result.written) facts.push(count(result.changes.length, "change"));
		ctx.ui.notify(`heydb sync ${opened.name}: ${facts.join(" · ")}.`, "info");
		// The changes also go into the session, so the model knows the schema it reads just moved.
		if (result.written && result.changes.length > 0) {
			await sendMessage({
				customType: "heydb",
				content: `heydb sync ${opened.name} changed the stored snapshot:\n\n${renderChanges(result.changes)}`,
				display: true,
			});
		}
	});
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
	const name = args.trim().split(/\s+/)[0] || undefined;
	try {
		const opened = openConnection(ctx.cwd, name);
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

/** Connection names of the project in the current folder; nothing when there is none or its config is broken. */
function completeConnection(deps: HeydbDeps, prefix: string): { value: string; label: string }[] | null {
	let names: string[];
	try {
		names = projectConnections(deps.cwd())?.names ?? [];
	} catch {
		return null; // completion must never fail loudly; /heydb:sync will report the broken config
	}
	const items = names.filter((name) => name.startsWith(prefix)).map((name) => ({ value: name, label: name }));
	return items.length > 0 ? items : null;
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
