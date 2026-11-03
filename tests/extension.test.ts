import assert from "node:assert/strict";
import { test } from "node:test";

import heydb from "../extensions/heydb.ts";
import pkg from "../package.json" with { type: "json" };

type Notification = { message: string; level: string };
type CommandHandler = (args: string, ctx: unknown) => Promise<void> | void;

// Minimal stand-in for Pi's ExtensionAPI: it records what the extension registers.
function fakePi() {
	const commands = new Map<string, { description: string; handler: CommandHandler }>();
	const api = {
		registerCommand(name: string, options: { description: string; handler: CommandHandler }) {
			commands.set(name, options);
		},
	};
	return { api, commands };
}

function fakeContext() {
	const notifications: Notification[] = [];
	const ctx = {
		ui: {
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
		},
	};
	return { ctx, notifications };
}

test("registers the heydb:about command", () => {
	const { api, commands } = fakePi();
	heydb(api as never);
	assert.ok(commands.has("heydb:about"), "expected /heydb:about to be registered");
	assert.equal(commands.size, 1, "step 0 registers only /heydb:about");
});

test("/heydb:about reports the package version", async () => {
	const { api, commands } = fakePi();
	heydb(api as never);
	const { ctx, notifications } = fakeContext();

	await commands.get("heydb:about")?.handler("", ctx);

	assert.deepEqual(notifications, [
		{ message: `heydb ${pkg.version} (v2 in development)`, level: "info" },
	]);
});
