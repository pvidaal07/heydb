import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { relative } from "node:path";

import { addConnection, pickConnection, removeConnection, setDefaultConnection } from "../config/operations.ts";
import { loadConfig, saveConfig } from "../config/store.ts";
import type { Config, ConnectionConfig } from "../config/types.ts";
import { validateConnection } from "../config/validate.ts";
import { introspect as introspectEngine } from "../engines/index.ts";
import { snapshotLookup } from "../knowledge/query.ts";
import type { Annotation, Knowledge, Relationship } from "../knowledge/types.ts";
import { displayNameOf, formatName, parseName, parseSegments } from "../model/names.ts";
import type { Snapshot } from "../model/snapshot.ts";
import { ENV_FILE, type SecretSource, referenceVariable, resolveSecret, secretSource, suggestedReference } from "../secrets.ts";
import { removeEnvValue, setEnvValue } from "../store/envfile.ts";
import { assertConnectionName } from "../store/guards.ts";
import { knowledgePath, loadKnowledge, loadProjectKnowledge } from "../store/knowledge.ts";
import { HEYDB_DIR, findProjectRoot } from "../store/project.ts";
import { loadSnapshot, storedSnapshotPath } from "../store/snapshots.ts";
import { ensureEnvIgnored } from "./init.ts";
import { forgetAnnotation, forgetProjectNote, forgetRelationship } from "./knowledge.ts";
import { resolveColumn, resolveTable } from "./resolve.ts";

// The steps every entry point (Pi today, a CLI or MCP server later) repeats
// before doing anything: find the project, pick the connection, load what is
// stored. Errors an entry point must answer with its own instructions ("run
// init", "run sync") are ProjectErrors with a code, so the wording of those
// instructions stays with the entry point and lib/ never names its commands.

export type ProjectErrorCode = "not_initialized" | "no_connections" | "never_synced";

export class ProjectError extends Error {
	readonly code: ProjectErrorCode;
	/** The connection concerned, when there is one. */
	readonly connection: string | null;

	constructor(code: ProjectErrorCode, message: string, connection: string | null = null) {
		super(message);
		this.name = "ProjectError";
		this.code = code;
		this.connection = connection;
	}
}

export interface OpenedConnection {
	readonly root: string;
	readonly config: Config;
	readonly name: string;
	readonly connection: ConnectionConfig;
}

export interface OpenedSnapshot extends OpenedConnection {
	readonly snapshot: Snapshot;
	readonly knowledge: Knowledge;
}

/** Finds the project above `cwd` and picks a connection with pickConnection's rules. */
export function openConnection(cwd: string, name?: string): OpenedConnection {
	const { root, config } = openProject(cwd);
	return { root, config, ...pickConnection(config, name) };
}

/** The project above `cwd` and its config, which must have at least one connection. */
function openProject(cwd: string): { root: string; config: Config } {
	const root = openProjectRoot(cwd);
	const config = loadConfig(root);
	if (Object.keys(config.connections).length === 0) {
		throw new ProjectError("no_connections", "no connections are configured in this heydb project");
	}
	return { root, config };
}

/** Like openConnection, plus the stored snapshot and knowledge. Never connects to the server. */
export function openSnapshot(cwd: string, name?: string): OpenedSnapshot {
	const opened = openConnection(cwd, name);
	const snapshot = loadSnapshot(opened.root, opened.name);
	if (snapshot === null) {
		throw new ProjectError(
			"never_synced",
			`connection "${opened.name}" was never synced: there is no stored snapshot yet`,
			opened.name,
		);
	}
	return { ...opened, snapshot, knowledge: loadKnowledge(opened.root, opened.name) };
}

/** The root of the project above `cwd`, which may have no connections yet. */
export function openProjectRoot(cwd: string): string {
	const root = findProjectRoot(cwd);
	if (root === null) throw new ProjectError("not_initialized", "no heydb project here (no .heydb/ in this folder or above)");
	return root;
}

/** The project above `cwd` and its connection names, sorted; null outside a project. */
export function projectConnections(cwd: string): { root: string; names: string[] } | null {
	const root = findProjectRoot(cwd);
	if (root === null) return null;
	return { root, names: Object.keys(loadConfig(root).connections).sort() };
}

export interface CaptureOptions {
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** The engine entry point; replaced in tests so no server is needed. */
	readonly introspect?: (entry: ConnectionConfig, password: string) => Promise<Snapshot>;
}

/**
 * Captures the live structure of an opened connection. The password is
 * resolved here, at connect time, and only handed to the engine: it is never
 * returned, stored or put in an error.
 */
export async function captureLive(opened: OpenedConnection, options: CaptureOptions = {}): Promise<Snapshot> {
	const { env = process.env, introspect = introspectEngine } = options;
	const password = resolveSecret(opened.connection.password, { connection: opened.name, env, projectRoot: opened.root });
	return introspect(opened.connection, password);
}

/** What a person typed when adding a connection; every field is text, as typed. */
export interface ConnectionAnswers {
	readonly engine: string;
	readonly host: string;
	readonly port: string;
	readonly user: string;
	/** Comma-separated names; empty captures every database the user can see. */
	readonly databases: string;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3306;

/**
 * Turns typed answers into a validated connection. There is no password
 * answer: the password field is always the suggested reference, and the
 * person sets that variable on their own machine.
 */
export function buildConnection(name: string, answers: ConnectionAnswers): ConnectionConfig {
	assertConnectionName(name);
	const host = answers.host.trim();
	const port = answers.port.trim();
	const databases = answers.databases
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item !== "");
	return validateConnection(
		{
			engine: answers.engine,
			host: host === "" ? DEFAULT_HOST : host,
			// Anything that is not plain digits becomes NaN, which validation rejects with its usual message.
			port: port === "" ? DEFAULT_PORT : /^\d+$/.test(port) ? Number(port) : Number.NaN,
			user: answers.user.trim(),
			password: suggestedReference(name),
			databases: databases.length === 0 ? null : databases,
		},
		name,
	);
}

/** Adds a connection to config.json; the first one of a project becomes the default. */
export function saveNewConnection(root: string, name: string, entry: ConnectionConfig): { isDefault: boolean } {
	const before = loadConfig(root);
	let config = addConnection(before, name, entry);
	if (before.defaultConnection === null && Object.keys(before.connections).length === 0) {
		config = setDefaultConnection(config, name);
	}
	saveConfig(root, config);
	return { isDefault: config.defaultConnection === name };
}

export interface ConnectionSummary {
	readonly name: string;
	readonly connection: ConnectionConfig;
	readonly isDefault: boolean;
	/** Where its password is set, never the value; "unreadable" when .heydb/.env cannot be parsed. */
	readonly password: SecretSource | "missing" | "unreadable";
	/** Whether a snapshot is stored for it. */
	readonly synced: boolean;
}

/** Every connection of the project above `cwd`, sorted by name, with what a person needs to pick one. */
export function listConnections(
	cwd: string,
	env: Readonly<Record<string, string | undefined>>,
): { root: string; connections: ConnectionSummary[] } {
	const { root, config } = openProject(cwd);
	const connections = Object.keys(config.connections)
		.sort()
		.map((name) => {
			const connection = config.connections[name] as ConnectionConfig;
			let password: ConnectionSummary["password"];
			try {
				password = secretSource(connection.password, { connection: name, env, projectRoot: root }) ?? "missing";
			} catch {
				// A broken .heydb/.env must not hide the list; the next sync explains the line at fault.
				password = "unreadable";
			}
			const synced = storedSnapshotPath(root, name) !== null;
			return { name, connection, isDefault: config.defaultConnection === name, password, synced };
		});
	return { root, connections };
}

/** Makes `name` the connection commands use when they are given none. */
export function chooseDefaultConnection(root: string, name: string): void {
	saveConfig(root, setDefaultConnection(loadConfig(root), name));
}

/**
 * Removes a connection from config.json and its password from .heydb/.env
 * (unless another connection uses the same variable). Its snapshot and notes
 * stay on disk: notes are written by people and cannot be recaptured, so
 * deleting them is left to a person. Returns the paths kept, relative to the
 * project root, so the caller can say where they are.
 */
export function forgetConnection(root: string, name: string): { passwordRemoved: boolean; kept: string[] } {
	const config = loadConfig(root);
	const next = removeConnection(config, name);
	const reference = (config.connections[name] as ConnectionConfig).password;
	// The password line goes first: if .heydb/.env cannot be changed (a
	// symbolic link, say), config.json is still as it was.
	const shared = Object.values(next.connections).some((entry) => entry.password === reference);
	const passwordRemoved = !shared && removeEnvValue(root, referenceVariable(reference, name));
	saveConfig(root, next);

	const kept = [storedSnapshotPath(root, name), knowledgePath(root, name)]
		.filter((path): path is string => path !== null && existsSync(path))
		.map((path) => relative(root, path).replaceAll("\\", "/"));
	return { passwordRemoved, kept };
}

export interface SavePasswordOptions {
	/** Whether git tracks .heydb/.env in `root`; replaced in tests so no git is needed. */
	readonly isTracked?: (root: string) => boolean;
}

/**
 * Stores a typed password in .heydb/.env under the variable `reference` names,
 * after making sure git ignores that file. Ignoring does not untrack a file
 * already committed (git add -f), so such a file is refused. Returns the
 * variable name.
 */
export function savePassword(root: string, reference: string, value: string, options: SavePasswordOptions = {}): string {
	const { isTracked = gitTracksEnvFile } = options;
	const variable = referenceVariable(reference);
	if (isTracked(root)) {
		throw new Error(
			".heydb/.env is tracked by git, so heydb will not write a password into it; untrack it with git rm --cached .heydb/.env first",
		);
	}
	ensureEnvIgnored(root);
	setEnvValue(root, variable, value);
	return variable;
}

const GIT_TIMEOUT_MS = 2000;

/**
 * Whether git tracks .heydb/.env in the project at `root`. Without git, or
 * outside a repository, nothing is tracked. Any other failure (a timeout, a
 * repository git refuses to open) is an error: heydb does not guess before
 * writing a password. Synchronous because savePassword is; execFileSync with
 * an argument list never goes through a shell.
 */
export function gitTracksEnvFile(root: string): boolean {
	try {
		execFileSync("git", ["ls-files", "--error-unmatch", "--", `${HEYDB_DIR}/${ENV_FILE}`], {
			cwd: root,
			timeout: GIT_TIMEOUT_MS,
			shell: false,
			windowsHide: true,
			stdio: ["ignore", "ignore", "pipe"],
			encoding: "utf8",
		});
		return true;
	} catch (error) {
		const failure = error as { code?: unknown; status?: unknown; stderr?: unknown };
		const stderr = typeof failure.stderr === "string" ? failure.stderr : "";
		if (failure.code === "ENOENT") return false; // git is not installed
		if (failure.status === 1) return false; // --error-unmatch: not tracked
		if (/not a git repository/i.test(stderr)) return false;
		const reason = stderr.trim().split("\n")[0] || (error instanceof Error ? error.message : String(error));
		throw new Error(`could not ask git whether it tracks ${HEYDB_DIR}/${ENV_FILE}: ${reason}`, { cause: error });
	}
}

export type Forgotten =
	| { readonly kind: "annotation"; readonly annotation: Annotation }
	| { readonly kind: "relationship"; readonly relationship: Relationship };

/**
 * Ids are unique across both lists and the project file (random UUIDs), so
 * one id names one entry. The connection's file is searched first, then the
 * project notes, which belong to no connection.
 */
export function forgetById(root: string, connection: string, id: string): Forgotten {
	const knowledge = loadKnowledge(root, connection);
	if (knowledge.annotations.some((item) => item.id === id)) {
		return { kind: "annotation", annotation: forgetAnnotation(root, connection, id) };
	}
	if (knowledge.relationships.some((item) => item.id === id)) {
		return { kind: "relationship", relationship: forgetRelationship(root, connection, id) };
	}
	if (loadProjectKnowledge(root).annotations.some((item) => item.id === id)) {
		return { kind: "annotation", annotation: forgetProjectNote(root, id) };
	}
	throw new Error(`no annotation or relationship has id "${id}"`);
}

export type TargetKind = "database" | "table" | "column";

/**
 * What a note is about, from what an agent typed: a database ("shop",
 * "shop.shop"), a table or a column in any form resolveTable and resolveColumn
 * accept. A complete canonical name that exists is taken as written. Otherwise
 * every reading is tried, and the target must be exactly one object.
 *
 * A name without a dot is a table (or a database), never a column when one
 * of those matches: in a legacy ERP the articles table "gar" shares its name
 * with a column postv.gar, and "gar" must still name the table. A column then
 * needs its table: "postv.gar". Errors use display names.
 */
export function resolveTarget(snapshot: Snapshot, input: string): { kind: TargetKind; name: string } {
	const segments = parseSegments(input);
	if (segments.length > 4) throw new Error(`expected a database, table or column name: got "${input}"`);
	if (segments.length >= 2) {
		const canonical = formatName(parseName(input));
		if (snapshotLookup(snapshot)(canonical)) return { kind: KINDS[segments.length - 2] as TargetKind, name: canonical };
	}

	const found: { kind: TargetKind; name: string }[] = [];
	const misses: string[] = [];
	const ambiguities: string[] = [];
	const attempt = (kind: TargetKind, resolve: () => string) => {
		try {
			found.push({ kind, name: resolve() });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// resolve.ts starts ambiguity errors with the quoted input and misses with "no ".
			(message.startsWith('"') ? ambiguities : misses).push(message);
		}
	};
	if (segments.length <= 2) found.push(...databaseMatches(snapshot, segments));
	if (segments.length <= 3) attempt("table", () => resolveTable(snapshot, input).name);
	const tableOrDatabase = found.length > 0 || ambiguities.length > 0;
	if (segments.length > 1 || !tableOrDatabase) attempt("column", () => resolveColumn(snapshot, input).name);

	const [ambiguity] = ambiguities;
	if (ambiguity !== undefined) throw new Error(ambiguity);
	const [only] = found;
	if (only !== undefined && found.length === 1) return only;
	if (found.length > 1) {
		throw new Error(
			[`"${input}" names more than one object; use the full name:`, ...found.map((item) => `- ${item.kind} ${displayNameOf(item.name)}`)].join(
				"\n",
			),
		);
	}
	const [miss] = misses;
	if (misses.length === 1 && miss !== undefined) throw new Error(miss);
	throw new Error([`nothing matches "${input}":`, ...misses.map((message) => `- ${message}`)].join("\n"));
}

const KINDS: readonly TargetKind[] = ["database", "table", "column"];

// "shop" names a database or its schema; "shop.shop" names both. Exact
// spelling first, then ignoring case, like resolve.ts.
function databaseMatches(snapshot: Snapshot, segments: readonly string[]): { kind: TargetKind; name: string }[] {
	const pairs = snapshot.databases.flatMap((database) => database.schemas.map((schema) => [database.name, schema.name] as const));
	const matching = (equal: (a: string, b: string) => boolean) =>
		pairs.filter(([database, schema]) => {
			const [first, second] = segments as [string, string?];
			if (second === undefined) return equal(first, database) || equal(first, schema);
			return equal(first, database) && equal(second, schema);
		});
	let matches = matching((a, b) => a === b);
	if (matches.length === 0) matches = matching((a, b) => a.toLowerCase() === b.toLowerCase());
	return matches.map(([database, schema]) => ({ kind: "database", name: formatName({ database, schema }) }));
}
