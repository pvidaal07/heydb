import { existsSync } from "node:fs";
import { relative } from "node:path";

import { addConnection, pickConnection, removeConnection, setDefaultConnection } from "../config/operations.ts";
import { loadConfig, saveConfig } from "../config/store.ts";
import type { Config, ConnectionConfig } from "../config/types.ts";
import { validateConnection } from "../config/validate.ts";
import { introspect as introspectEngine } from "../engines/index.ts";
import { snapshotLookup } from "../knowledge/query.ts";
import type { Annotation, Knowledge, Relationship } from "../knowledge/types.ts";
import { formatName, parseName, parseSegments } from "../model/names.ts";
import type { Snapshot } from "../model/snapshot.ts";
import { type SecretSource, referenceVariable, resolveSecret, secretSource, suggestedReference } from "../secrets.ts";
import { removeEnvValue, setEnvValue } from "../store/envfile.ts";
import { assertConnectionName } from "../store/guards.ts";
import { knowledgePath, loadKnowledge } from "../store/knowledge.ts";
import { findProjectRoot } from "../store/project.ts";
import { loadSnapshot, snapshotPath } from "../store/snapshots.ts";
import { ensureEnvIgnored } from "./init.ts";
import { forgetAnnotation, forgetRelationship } from "./knowledge.ts";
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
	const root = findProjectRoot(cwd);
	if (root === null) throw new ProjectError("not_initialized", "no heydb project here (no .heydb/ in this folder or above)");
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
			const synced = existsSync(snapshotPath(root, name));
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
	saveConfig(root, next);

	const shared = Object.values(next.connections).some((entry) => entry.password === reference);
	const passwordRemoved = !shared && removeEnvValue(root, referenceVariable(reference, name));
	const kept = [snapshotPath(root, name), knowledgePath(root, name)]
		.filter((path) => existsSync(path))
		.map((path) => relative(root, path).replaceAll("\\", "/"));
	return { passwordRemoved, kept };
}

/**
 * Stores a typed password in .heydb/.env under the variable `reference` names,
 * after making sure git ignores that file. Returns the variable name.
 */
export function savePassword(root: string, reference: string, value: string): string {
	const variable = referenceVariable(reference);
	ensureEnvIgnored(root);
	setEnvValue(root, variable, value);
	return variable;
}

export type Forgotten =
	| { readonly kind: "annotation"; readonly annotation: Annotation }
	| { readonly kind: "relationship"; readonly relationship: Relationship };

/** Ids are unique across both lists (random UUIDs), so one id names one entry. */
export function forgetById(root: string, connection: string, id: string): Forgotten {
	const knowledge = loadKnowledge(root, connection);
	if (knowledge.annotations.some((item) => item.id === id)) {
		return { kind: "annotation", annotation: forgetAnnotation(root, connection, id) };
	}
	if (knowledge.relationships.some((item) => item.id === id)) {
		return { kind: "relationship", relationship: forgetRelationship(root, connection, id) };
	}
	throw new Error(`no annotation or relationship has id "${id}"`);
}

export type TargetKind = "database" | "table" | "column";

/**
 * What a note is about, from what an agent typed: a database ("shop",
 * "shop.shop"), a table or a column in any form resolveTable and resolveColumn
 * accept. A complete canonical name that exists is taken as written. Otherwise
 * every reading is tried, and the target must be exactly one object.
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
	attempt("column", () => resolveColumn(snapshot, input).name);

	const [ambiguity] = ambiguities;
	if (ambiguity !== undefined) throw new Error(ambiguity);
	const [only] = found;
	if (only !== undefined && found.length === 1) return only;
	if (found.length > 1) {
		throw new Error(
			[`"${input}" names more than one object; use the full name:`, ...found.map((item) => `- ${item.kind} ${item.name}`)].join("\n"),
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
