import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// ADR-0006 seen from Pi: loading the extension and registering everything
// must not load mysql2; only /heydb:sync and /heydb:status do, when they run.
// Same detector as tests/engines/index.test.ts (a fresh Node process that
// records every resolved module); its positive control lives there.
test("loading and registering the extension does not load mysql2", () => {
	const script = `
		import { registerHooks } from "node:module";
		const seen = [];
		registerHooks({
			resolve(specifier, context, next) {
				const result = next(specifier, context);
				seen.push(result.url);
				return result;
			},
		});
		const { default: heydb } = await import(${JSON.stringify(new URL("../../extensions/heydb.ts", import.meta.url).href)});
		const registered = [];
		heydb({
			registerTool: (tool) => registered.push(tool.name),
			registerCommand: (name) => registered.push(name),
			on: (event) => registered.push(event),
		});
		const hit = seen.some((url) => url.replaceAll("\\\\", "/").includes("/node_modules/mysql2/"));
		process.stdout.write(registered.length + " registered, " + (hit ? "mysql2 loaded" : "mysql2 not loaded"));
	`;
	const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout, "15 registered, mysql2 not loaded");
});
