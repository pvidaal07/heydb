// A stand-in for Pi, shared by the extension tests. Not a test file: the
// runner only picks *.test.ts. It records what the extension registers and
// plays the person in front of the UI with scripted answers, so commands and
// tools run without Pi, a model or a terminal.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "node:test";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionToolContext,
	RegisteredCommand,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { HeydbDeps } from "../../extensions/deps.ts";
import { registerHeydb } from "../../extensions/heydb.ts";
import type { Snapshot } from "../../lib/model/snapshot.ts";
import { fixedClock } from "../knowledge/fixtures.ts";

type Command = Omit<RegisteredCommand, "name" | "sourceInfo">;
type Handler = (event: unknown, ctx: unknown) => unknown;

export interface SentMessage {
	readonly message: { customType: string; content: unknown; display: boolean };
	readonly options: unknown;
}

export function fakePi() {
	const tools = new Map<string, ToolDefinition>();
	const commands = new Map<string, Command>();
	const handlers = new Map<string, Handler[]>();
	const messages: SentMessage[] = [];
	const api = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, options: Command) {
			commands.set(name, options);
		},
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => {};
		},
		async sendMessage(message: SentMessage["message"], options?: unknown) {
			messages.push({ message, options });
		},
	};
	return { api: api as unknown as ExtensionAPI, tools, commands, handlers, messages };
}

export interface Notification {
	readonly message: string;
	readonly level: string;
}

export interface Dialog {
	readonly kind: "input" | "select" | "confirm";
	readonly title: string;
	readonly hint: string;
}

/**
 * A context whose dialogs answer from `answers`, in order. `undefined` plays
 * a person pressing Escape. Every dialog is recorded, so a test can check
 * what was (and was not) asked.
 */
export function fakeContext(cwd: string, { hasUI = true, answers = [] as (string | undefined)[] } = {}) {
	const notifications: Notification[] = [];
	const dialogs: Dialog[] = [];
	const queue = [...answers];
	const next = () => queue.shift();
	const ctx = {
		cwd,
		hasUI,
		ui: {
			notify(message: string, level = "info") {
				notifications.push({ message, level });
			},
			async input(title: string, placeholder = "") {
				dialogs.push({ kind: "input", title, hint: placeholder });
				return next();
			},
			async select(title: string, options: string[]) {
				dialogs.push({ kind: "select", title, hint: options.join(",") });
				return next();
			},
			async confirm(title: string, message: string) {
				dialogs.push({ kind: "confirm", title, hint: message });
				return next() === "yes";
			},
		},
	};
	return {
		command: ctx as unknown as ExtensionCommandContext,
		tool: ctx as unknown as ExtensionToolContext,
		notifications,
		dialogs,
	};
}

/** Registers heydb on a fake Pi with deterministic dependencies; `overrides` replace any of them. */
export function loadHeydb(overrides: Partial<HeydbDeps> = {}) {
	const pi = fakePi();
	registerHeydb(pi.api, {
		env: {},
		introspect: async () => {
			throw new Error("tests must not connect: pass an introspect override");
		},
		author: async () => "Ana",
		knowledge: fixedClock(),
		cwd: () => {
			throw new Error("tests must pass a cwd override");
		},
		...overrides,
	});
	return pi;
}

export interface ToolText {
	readonly text: string;
	readonly isError: boolean;
}

export async function runTool(
	pi: ReturnType<typeof fakePi>,
	name: string,
	params: Record<string, unknown>,
	cwd: string,
): Promise<ToolText> {
	const tool = pi.tools.get(name);
	if (tool === undefined) throw new Error(`tool ${name} is not registered`);
	const result = await tool.execute("call-1", params as never, undefined, undefined, fakeContext(cwd).tool);
	const texts = result.content.map((part) => (part.type === "text" ? part.text : ""));
	return { text: texts.join("\n"), isError: result.isError === true };
}

export async function runCommand(pi: ReturnType<typeof fakePi>, name: string, args: string, ctx: ReturnType<typeof fakeContext>) {
	const command = pi.commands.get(name);
	if (command === undefined) throw new Error(`command /${name} is not registered`);
	await command.handler(args, ctx.command);
}

/** Temporary folders removed after every test of the file that calls it. */
export function tempDirs(prefix: string): () => string {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});
	return () => {
		const root = mkdtempSync(join(tmpdir(), prefix));
		roots.push(root);
		return root;
	};
}

/** An introspect that records the password it got and returns snapshots in turn. */
export function fakeIntrospect(...snapshots: Snapshot[]) {
	const passwords: string[] = [];
	const introspect: HeydbDeps["introspect"] = async (_entry, password) => {
		passwords.push(password);
		const next = snapshots.length > 1 ? snapshots.shift() : snapshots[0];
		if (next === undefined) throw new Error("no snapshot left");
		return next;
	};
	return { introspect, passwords };
}
