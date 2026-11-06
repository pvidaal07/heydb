import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";

import { mysqlOptions, postgresOptions } from "../../lib/engines/index.ts";

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

describe("postgresOptions", () => {
	const entry = {
		engine: "postgresql" as const,
		host: "pg.internal",
		port: 5433,
		user: "reader",
		password: "env:HEYDB_PG_PASSWORD",
		databases: ["legacy"],
		schemas: ["public", "billing"],
	};

	test("connects to the one configured database and passes the schemas", () => {
		assert.deepEqual(postgresOptions(entry, "resolved"), {
			host: "pg.internal",
			port: 5433,
			user: "reader",
			password: "resolved",
			database: "legacy",
			schemas: ["public", "billing"],
		});
		assert.equal(postgresOptions({ ...entry, schemas: null }, "x").schemas, null);
		assert.equal(postgresOptions({ ...entry, schemas: undefined }, "x").schemas, null);
	});

	test("refuses an entry without exactly one database instead of guessing", () => {
		const message = "a postgresql connection needs exactly one database";
		assert.throws(() => postgresOptions({ ...entry, databases: null }, "x"), { message });
		assert.throws(() => postgresOptions({ ...entry, databases: ["a", "b"] }, "x"), { message });
	});
});

// ADR-0006: a driver is loaded only when its engine is used, so a session that
// never connects (reading the snapshot, searching, annotating) pays nothing
// for mysql2 or pg. The test runs a fresh Node process, because this one may
// have loaded a driver already through another test file. Inside it, a module
// resolution hook (module.registerHooks) records every URL Node resolves,
// for import and require alike; then the script imports one module and prints
// which drivers' folders (node_modules/mysql2/, node_modules/pg/) any recorded
// URL lies in. The engine cases import each engine directly and must see its
// driver: they prove the detector works, so the first case cannot pass just
// because nothing was recorded.
function loadedDrivers(module: string): string[] {
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
		const urls = seen.map((url) => url.replaceAll("\\\\", "/"));
		const drivers = ["mysql2", "pg"].filter((driver) => urls.some((url) => url.includes("/node_modules/" + driver + "/")));
		process.stdout.write(JSON.stringify(drivers));
	`;
	const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout) as string[];
}

describe("lazy driver loading", () => {
	test("importing lib/engines/index.ts loads neither mysql2 nor pg", () => {
		assert.deepEqual(loadedDrivers("../../lib/engines/index.ts"), []);
	});

	test("the detector sees mysql2 when the MySQL engine itself is imported", () => {
		assert.deepEqual(loadedDrivers("../../lib/engines/mysql/introspect.ts"), ["mysql2"]);
	});

	test("the detector sees pg when the PostgreSQL engine itself is imported", () => {
		assert.deepEqual(loadedDrivers("../../lib/engines/postgres/introspect.ts"), ["pg"]);
	});
});
