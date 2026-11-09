import assert from "node:assert/strict";
import { test } from "node:test";

import heydb from "../extensions/heydb.ts";
import pkg from "../package.json" with { type: "json" };
import { fakeContext, fakePi, runCommand } from "./extension/fake-pi.ts";

// The default export is what Pi loads: it must register everything with the
// real dependencies, without connecting anywhere or loading a driver.
test("the default export registers the heydb commands, tools and prompt context", () => {
	const pi = fakePi();
	heydb(pi.api);
	assert.deepEqual(
		[...pi.commands.keys()],
		["heydb:about", "heydb:init", "heydb:connect", "heydb:sync", "heydb:status", "heydb:password", "heydb:connections"],
	);
	assert.equal(pi.tools.size, 7);
	assert.deepEqual([...pi.handlers.keys()], ["before_agent_start"]);
});

test("/heydb:about reports the package version", async () => {
	const pi = fakePi();
	heydb(pi.api);
	const ctx = fakeContext(process.cwd());

	await runCommand(pi, "heydb:about", "", ctx);

	assert.deepEqual(ctx.notifications, [{ message: `heydb ${pkg.version} (v2 in development)`, level: "info" }]);
});
