import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
	addConnection,
	emptyConfig,
	pickConnection,
	removeConnection,
	setDefaultConnection,
	updateConnection,
} from "../../lib/config/operations.ts";
import type { Config, ConnectionConfig } from "../../lib/config/types.ts";

function entry(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
	return {
		engine: "mysql",
		host: "127.0.0.1",
		port: 3306,
		user: "reader",
		password: "env:HEYDB_LOCAL_PASSWORD",
		databases: null,
		...overrides,
	};
}

function config(names: string[], defaultConnection: string | null = null): Config {
	let result = emptyConfig();
	for (const name of names) result = addConnection(result, name, entry());
	return setDefaultConnection(result, defaultConnection);
}

describe("emptyConfig", () => {
	test("has no connections and no default", () => {
		assert.deepEqual(emptyConfig(), { formatVersion: 1, defaultConnection: null, connections: {} });
	});
});

describe("addConnection", () => {
	test("adds a validated entry and leaves the input untouched", () => {
		const before = Object.freeze(emptyConfig());
		const after = addConnection(before, "local", entry({ databases: ["shop"] }));
		assert.deepEqual(after.connections, { local: entry({ databases: ["shop"] }) });
		assert.deepEqual(before, emptyConfig());
	});

	test("rejects a duplicate name", () => {
		assert.throws(() => addConnection(config(["local"]), "local", entry()), {
			message: 'connection "local" already exists; update or remove it instead',
		});
	});

	test("rejects an unsafe connection name", () => {
		assert.throws(() => addConnection(emptyConfig(), "../prod", entry()), /invalid connection name "\.\.\/prod"/);
		assert.throws(() => addConnection(emptyConfig(), "nul", entry()), /reserved name on Windows/);
	});

	test("rejects a literal password, explains why, and never echoes it", () => {
		const secret = "Sup3r-Secret!";
		assert.throws(
			() => addConnection(emptyConfig(), "prod-eu", entry({ password: secret })),
			(error: Error) => {
				assert.equal(
					error.message,
					'connections.prod-eu.password must be a reference such as "env:HEYDB_PROD_EU_PASSWORD", never the password itself: ' +
						".heydb/config.json is committed to git, so anything written there is readable by everyone with the repository. " +
						"Put the password in that environment variable (or in .heydb/.env, which git ignores).",
				);
				assert.doesNotMatch(String(error) + JSON.stringify(error) + String(error.stack), new RegExp(secret));
				return true;
			},
		);
	});

	test("only accepts HEYDB_* variables, so a shared config cannot read unrelated secrets", () => {
		const message =
			'connections.local.password must be a reference such as "env:HEYDB_LOCAL_PASSWORD": ' +
			"only HEYDB_* variables can be used, so a shared config cannot read unrelated secrets from your environment";
		const rejected = ["env:AWS_SECRET_ACCESS_KEY", "env:HOME", "env:HEYDB_", "env:HEYDB_lower", "env:heydb_x", "env:lower", "env:1ABC", "env:", "env:HEYDB_A-B"];
		for (const password of rejected) {
			assert.throws(
				() => addConnection(emptyConfig(), "local", entry({ password })),
				(error: Error) => {
					assert.equal(error.message, message);
					// The rejected value is never repeated: "env:" may be followed by a pasted password.
					// ("env:" and "env:HEYDB_" are part of the suggested reference itself.)
					if (!message.includes(password)) assert.equal(String(error.stack).includes(password), false);
					return true;
				},
			);
		}
		for (const password of ["env:HEYDB_X", "env:HEYDB_PROD_EU_PASSWORD", "env:HEYDB_1"]) {
			assert.equal(addConnection(emptyConfig(), "local", entry({ password })).connections.local?.password, password);
		}
	});

	test("rejects an unknown field without echoing its value", () => {
		const secret = "Sup3r-Secret!";
		const withSecret = { ...entry(), secret } as ConnectionConfig;
		assert.throws(
			() => addConnection(emptyConfig(), "prod", withSecret),
			(error: Error) => {
				assert.equal(error.message, 'connections.prod has an unknown field "secret"');
				assert.equal(String(error.stack).includes(secret), false);
				return true;
			},
		);
	});

	test("accepts PostgreSQL with exactly one database and an optional list of schemas", () => {
		const pg = entry({ engine: "postgresql", port: 5432, databases: ["legacy"], schemas: ["public", "billing"] });
		assert.deepEqual(addConnection(emptyConfig(), "pg", pg).connections.pg, pg);
		// Without "schemas" every non-system schema is captured, written as an explicit null.
		const all = addConnection(emptyConfig(), "pg", entry({ engine: "postgresql", databases: ["legacy"] }));
		assert.deepEqual(all.connections.pg, entry({ engine: "postgresql", databases: ["legacy"], schemas: null }));
	});

	test("a PostgreSQL connection names exactly one database, and says why", () => {
		const message =
			"connections.pg.databases must list exactly one database for postgresql: a PostgreSQL connection only reaches " +
			'the database it connects to, so add one connection per database (and use "schemas" to choose schemas inside it)';
		for (const databases of [null, ["legacy", "other"]]) {
			assert.throws(() => addConnection(emptyConfig(), "pg", entry({ engine: "postgresql", databases })), { message });
		}
	});

	test("schemas are checked like databases, and only PostgreSQL may have them", () => {
		const pg = (schemas: unknown) => entry({ engine: "postgresql", databases: ["legacy"], schemas: schemas as string[] });
		const cases: [ConnectionConfig, string][] = [
			[pg([]), "connections.local.schemas must be null (every non-system schema) or a non-empty list of names"],
			[pg("public"), "connections.local.schemas must be null (every non-system schema) or a non-empty list of names"],
			[pg(["public", ""]), "connections.local.schemas[1] must be a non-empty string"],
			[pg(["public", "public"]), 'connections.local.schemas repeats "public"'],
			[
				entry({ schemas: null }),
				'connections.local.schemas is only allowed for postgresql: in MySQL and MariaDB every database is its own schema, so choose them with "databases"',
			],
		];
		for (const [connection, message] of cases) {
			assert.throws(() => addConnection(emptyConfig(), "local", connection), { message });
		}
	});

	test("MySQL and MariaDB entries keep their shape: no schemas field is added", () => {
		for (const engine of ["mysql", "mariadb"] as const) {
			const added = addConnection(emptyConfig(), "local", entry({ engine, databases: ["shop", "crm"] })).connections.local;
			assert.deepEqual(added, entry({ engine, databases: ["shop", "crm"] }));
			assert.equal(added !== undefined && "schemas" in added, false);
		}
	});

	test("checks every field", () => {
		const cases: [Partial<Record<keyof ConnectionConfig, unknown>>, string][] = [
			[{ engine: "oracle" }, 'connections.local.engine must be "mysql", "mariadb" or "postgresql"'],
			[{ host: "" }, "connections.local.host must be a non-empty string"],
			[{ port: 0 }, "connections.local.port must be an integer from 1 to 65535"],
			[{ port: 3306.5 }, "connections.local.port must be an integer from 1 to 65535"],
			[{ port: "3306" }, "connections.local.port must be an integer from 1 to 65535"],
			[{ user: 7 }, "connections.local.user must be a non-empty string"],
			[{ databases: [] }, "connections.local.databases must be null (every database) or a non-empty list of names"],
			[{ databases: ["shop", ""] }, "connections.local.databases[1] must be a non-empty string"],
			[{ databases: ["shop", "shop"] }, 'connections.local.databases repeats "shop"'],
		];
		for (const [overrides, message] of cases) {
			assert.throws(() => addConnection(emptyConfig(), "local", entry(overrides as Partial<ConnectionConfig>)), { message });
		}
	});
});

describe("updateConnection", () => {
	test("changes only the given fields and validates the result", () => {
		const updated = updateConnection(config(["local"]), "local", { port: 3307, databases: ["crm"] });
		assert.deepEqual(updated.connections.local, entry({ port: 3307, databases: ["crm"] }));
		assert.throws(() => updateConnection(config(["local"]), "local", { password: "hunter2" }), /must be a reference/);
	});

	test("rejects an unknown connection, naming the configured ones", () => {
		assert.throws(() => updateConnection(config(["b", "a"]), "c", { port: 1 }), {
			message: 'unknown connection "c"; configured: a, b',
		});
		assert.throws(() => updateConnection(emptyConfig(), "c", { port: 1 }), {
			message: 'unknown connection "c"; no connections are configured',
		});
	});
});

describe("removeConnection", () => {
	test("removes the entry and keeps the default when it was another one", () => {
		const after = removeConnection(config(["a", "b"], "a"), "b");
		assert.deepEqual(Object.keys(after.connections), ["a"]);
		assert.equal(after.defaultConnection, "a");
	});

	test("clears the default when it was the default", () => {
		assert.equal(removeConnection(config(["a", "b"], "a"), "a").defaultConnection, null);
	});

	test("rejects an unknown connection", () => {
		assert.throws(() => removeConnection(config(["a"]), "z"), { message: 'unknown connection "z"; configured: a' });
	});
});

describe("setDefaultConnection", () => {
	test("sets and clears the default", () => {
		assert.equal(setDefaultConnection(config(["a", "b"]), "b").defaultConnection, "b");
		assert.equal(setDefaultConnection(config(["a", "b"], "b"), null).defaultConnection, null);
	});

	test("rejects an unknown connection", () => {
		assert.throws(() => setDefaultConnection(config(["a"]), "z"), { message: 'unknown connection "z"; configured: a' });
	});
});

describe("pickConnection", () => {
	test("uses the explicit name first", () => {
		assert.deepEqual(pickConnection(config(["a", "b"], "a"), "b"), { name: "b", connection: entry() });
	});

	test("falls back to the default, then to the only connection", () => {
		assert.equal(pickConnection(config(["a", "b"], "b")).name, "b");
		assert.equal(pickConnection(config(["solo"])).name, "solo");
	});

	test("rejects an unknown explicit name, naming the configured ones", () => {
		assert.throws(() => pickConnection(config(["a", "b"], "a"), "c"), { message: 'unknown connection "c"; configured: a, b' });
	});

	test("asks for a name when several exist and none is the default", () => {
		assert.throws(() => pickConnection(config(["b", "a"])), {
			message: "several connections are configured (a, b) and none is the default: pass a connection name or set a default",
		});
	});

	test("says when there is nothing to pick", () => {
		assert.throws(() => pickConnection(emptyConfig()), { message: "no connections are configured: add one first" });
	});
});
