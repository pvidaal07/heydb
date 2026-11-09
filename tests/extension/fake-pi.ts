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
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";

import type { HeydbDeps } from "../../extensions/deps.ts";
import { registerHeydb } from "../../extensions/heydb.ts";
import type { Snapshot } from "../../lib/model/snapshot.ts";
import { fixedClock } from "../knowledge/fixtures.ts";

type Command = Omit<RegisteredCommand, "name" | "sourceInfo">;
type CustomFactory = (
	tui: { requestRender(): void },
	theme: { fg(color: string, text: string): string },
	keybindings: KeybindingsManager,
	done: (value: unknown) => void,
) => { render(width: number): string[]; handleInput?(data: string): void } | Promise<{ render(width: number): string[]; handleInput?(data: string): void }>;
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
	readonly kind: "input" | "select" | "confirm" | "secret";
	readonly title: string;
	readonly hint: string;
}

type Mode = "tui" | "rpc" | "print";

/**
 * A context whose dialogs answer from `answers`, in order. `undefined` plays
 * a person pressing Escape. Every dialog is recorded, so a test can check
 * what was (and was not) asked.
 *
 * `idle` is what ctx.isIdle() answers: false plays an agent still working.
 *
 * `mode` is Pi's run mode: in "tui" (the default with a UI) custom components
 * such as the masked password input are typed into key by key with Pi's real
 * key table, and every frame they draw is kept in `screens`. In "rpc" custom()
 * returns undefined, as Pi does there.
 */
export function fakeContext(
	cwd: string,
	{ hasUI = true, mode = (hasUI ? "tui" : "print") as Mode, answers = [] as (string | undefined)[], idle = true } = {},
) {
	const notifications: Notification[] = [];
	const dialogs: Dialog[] = [];
	const screens: string[] = [];
	const queue = [...answers];
	const next = () => queue.shift();
	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
	const ctx = {
		cwd,
		hasUI,
		mode,
		isIdle: () => idle,
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
			async custom(factory: CustomFactory) {
				if (mode !== "tui") return undefined;
				let result: unknown;
				let finished = false;
				const component = await factory(
					{ requestRender: () => screens.push(component.render(80).join("\n")) },
					{ fg: (_color: string, text: string) => text },
					keybindings,
					(value) => {
						result = value;
						finished = true;
					},
				);
				// Wide enough that the title stays on one line, as in the dialogs above.
				const [title = "", ...rest] = component.render(400);
				screens.push([title, ...rest].join("\n"));
				dialogs.push({ kind: "secret", title, hint: rest.join("\n") });
				const answer = next();
				for (const data of answer === undefined ? ["\x1b"] : [...answer, "\r"]) {
					if (finished) break;
					component.handleInput?.(data);
				}
				return result;
			},
		},
	};
	return {
		command: ctx as unknown as ExtensionCommandContext,
		tool: ctx as unknown as ExtensionToolContext,
		notifications,
		dialogs,
		screens,
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
