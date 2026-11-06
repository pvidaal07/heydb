import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { addConnection, emptyConfig, setDefaultConnection } from "../../lib/config/operations.ts";
import { configPath, loadConfig, saveConfig } from "../../lib/config/store.ts";
import { validateConfig } from "../../lib/config/validate.ts";

const roots: string[] = [];

function projectRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "heydb-config-"));
	mkdirSync(join(root, ".heydb"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const local = {
	engine: "mariadb" as const,
	host: "db.internal",
	port: 3306,
	user: "reader",
	password: "env:HEYDB_LOCAL_PASSWORD",
	databases: ["shop", "crm"],
};

function writeRaw(root: string, data: unknown): void {
	writeFileSync(configPath(root), JSON.stringify(data));
}

describe("config store", () => {
	test("a missing file is an empty config", () => {
		assert.deepEqual(loadConfig(projectRoot()), emptyConfig());
	});

	test("saves stable JSON and loads the same config back", () => {
		const root = projectRoot();
		const config = setDefaultConnection(addConnection(emptyConfig(), "local", local), "local");
		saveConfig(root, config);
		assert.deepEqual(loadConfig(root), config);
		assert.equal(
			readFileSync(configPath(root), "utf8"),
			[
				"{",
				'  "connections": {',
				'    "local": {',
				'      "databases": [',
				'        "shop",',
				'        "crm"',
				"      ],",
				'      "engine": "mariadb",',
				'      "host": "db.internal",',
				'      "password": "env:HEYDB_LOCAL_PASSWORD",',
				'      "port": 3306,',
				'      "user": "reader"',
				"    }",
				"  },",
				'  "defaultConnection": "local",',
				'  "formatVersion": 1',
				"}",
				"",
			].join("\n"),
		);
	});

	test("rejects files that are not a heydb config", () => {
		const root = projectRoot();
		writeFileSync(configPath(root), "{nope");
		assert.throws(() => loadConfig(root), /^Error: config\.json is not valid JSON/);
		writeRaw(root, []);
		assert.throws(() => loadConfig(root), { message: "config.json is not a heydb config: expected a JSON object" });
		writeRaw(root, { connections: {} });
		assert.throws(() => loadConfig(root), { message: 'config.json is not a heydb config: missing "formatVersion"' });
		writeRaw(root, { formatVersion: 2 });
		assert.throws(() => loadConfig(root), {
			message: "config.json: unsupported config formatVersion 2 (expected 1); update heydb",
		});
	});

	test("validation names the exact path, and a literal password is never echoed", () => {
		const root = projectRoot();
		writeRaw(root, { formatVersion: 1, defaultConnection: null, connections: { local: { ...local, password: "hunter2" } } });
		assert.throws(
			() => loadConfig(root),
			(error: Error) => {
				assert.match(error.message, /^config\.json is not a heydb config: connections\.local\.password must be a reference/);
				assert.doesNotMatch(String(error) + JSON.stringify(error), /hunter2/);
				return true;
			},
		);
	});

	test("rejects a password typed under an unknown field, naming the field but never its value", () => {
		const root = projectRoot();
		writeRaw(root, {
			formatVersion: 1,
			defaultConnection: null,
			connections: { prod: { ...local, pasword: "hunter2-under-a-typo" } },
		});
		assert.throws(
			() => loadConfig(root),
			(error: Error) => {
				assert.equal(error.message, 'config.json is not a heydb config: connections.prod has an unknown field "pasword"');
				assert.doesNotMatch(String(error) + JSON.stringify(error) + String(error.stack), /hunter2/);
				return true;
			},
		);
	});

	test("refuses a symbolic link instead of the config file", () => {
		const root = projectRoot();
		const outside = join(mkdtempSync(join(tmpdir(), "heydb-config-outside-")), "config.json");
		roots.push(join(outside, ".."));
		writeFileSync(outside, JSON.stringify(emptyConfig()));
		symlinkSync(outside, configPath(root));
		const message = ".heydb/config.json is a symbolic link; heydb refuses to follow it";
		assert.throws(() => loadConfig(root), { message });
		assert.throws(() => saveConfig(root, emptyConfig()), { message });
	});
});

describe("validateConfig", () => {
	test("rebuilds the config field by field", () => {
		const data = { formatVersion: 1, defaultConnection: null, connections: { local } };
		assert.deepEqual(validateConfig(data), { formatVersion: 1, defaultConnection: null, connections: { local } });
	});

	test("rejects unknown fields at the root and in each connection, by name only", () => {
		const cases: [unknown, string][] = [
			[{ formatVersion: 1, defaultConnection: null, connections: {}, extra: "hunter2" }, 'config has an unknown field "extra"'],
			[
				{ formatVersion: 1, defaultConnection: null, connections: { local: { ...local, ssl: "hunter2" } } },
				'connections.local has an unknown field "ssl"',
			],
			[
				{ formatVersion: 1, defaultConnection: null, connections: JSON.parse('{"local":{"__proto__":"hunter2"}}') },
				'connections.local has an unknown field "__proto__"',
			],
		];
		for (const [data, message] of cases) {
			assert.throws(
				() => validateConfig(data),
				(error: Error) => {
					assert.equal(error.message, message);
					assert.doesNotMatch(String(error.stack), /hunter2/);
					return true;
				},
			);
		}
	});

	test("checks connection names, the default and every entry", () => {
		const cases: [unknown, string][] = [
			[{ formatVersion: 1, defaultConnection: null }, "connections is missing"],
			[{ formatVersion: 1, defaultConnection: null, connections: [] }, "connections must be an object"],
			[{ formatVersion: 1, connections: {} }, "defaultConnection is missing"],
			[{ formatVersion: 1, defaultConnection: 3, connections: {} }, "defaultConnection must be null or a string"],
			[
				{ formatVersion: 1, defaultConnection: "prod", connections: { local } },
				'defaultConnection "prod" is not one of the configured connections',
			],
			[
				{ formatVersion: 1, defaultConnection: null, connections: { Prod: local } },
				'connections: invalid connection name "Prod": use 1-64 lowercase letters, digits, "-" or "_", starting with a letter or digit',
			],
			[{ formatVersion: 1, defaultConnection: null, connections: { local: "x" } }, "connections.local must be an object"],
			[
				{ formatVersion: 1, defaultConnection: null, connections: { local: { ...local, host: undefined } } },
				"connections.local.host is missing",
			],
		];
		for (const [data, message] of cases) {
			assert.throws(() => validateConfig(JSON.parse(JSON.stringify(data))), { message });
		}
	});
});
