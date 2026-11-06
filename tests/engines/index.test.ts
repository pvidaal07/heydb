import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";

import { mysqlOptions } from "../../lib/engines/index.ts";

describe("mysqlOptions", () => {
	test("maps a config entry and the resolved password to driver options", () => {
		const entry = {
			engine: "mariadb" as const,
			host: "db.internal",
			port: 3307,
			user: "reader",
			password: "env:HEYDB_LOCAL_PASSWORD",
			databases: ["shop"],
		};
		assert.deepEqual(mysqlOptions(entry, "resolved"), {
			host: "db.internal",
			port: 3307,
			user: "reader",
			password: "resolved",
			databases: ["shop"],
		});
		assert.equal(mysqlOptions({ ...entry, databases: null }, "x").databases, null);
	});
});

// ADR-0006: a driver is loaded only when its engine is used, so a session that
// never connects (reading the snapshot, searching, annotating) pays nothing
// for mysql2. The test runs a fresh Node process, because this one may have
// loaded mysql2 already through another test file. Inside it, a module
// resolution hook (module.registerHooks) records every URL Node resolves,
// for import and require alike; then the script imports one module and prints
// whether any recorded URL lies inside node_modules/mysql2/. The second case
// imports the engine directly and must see mysql2: it proves the detector
// works, so the first case cannot pass just because nothing was recorded.
function loadsMysql2(module: string): boolean {
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
		await import(${JSON.stringify(new URL(module, import.meta.url).href)});
		const hit = seen.some((url) => url.replaceAll("\\\\", "/").includes("/node_modules/mysql2/"));
		process.stdout.write(hit ? "mysql2 loaded" : "mysql2 not loaded");
	`;
	const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });
	assert.equal(child.status, 0, child.stderr);
	return child.stdout === "mysql2 loaded";
}

describe("lazy driver loading", () => {
	test("importing lib/engines/index.ts does not load mysql2", () => {
		assert.equal(loadsMysql2("../../lib/engines/index.ts"), false);
	});

	test("the detector sees mysql2 when the MySQL engine itself is imported", () => {
		assert.equal(loadsMysql2("../../lib/engines/mysql/introspect.ts"), true);
	});
});
