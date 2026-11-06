import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import type { ConnectionConfig } from "../../lib/config/types.ts";
import { loadConfig, saveConfig } from "../../lib/config/store.ts";
import type { Snapshot } from "../../lib/model/snapshot.ts";
import { loadKnowledge } from "../../lib/store/knowledge.ts";
import { saveSnapshot } from "../../lib/store/snapshots.ts";
import { initProject } from "../../lib/usecases/init.ts";
import { annotate, relate } from "../../lib/usecases/knowledge.ts";
import {
	ProjectError,
	buildConnection,
	captureLive,
	forgetById,
	openConnection,
	openSnapshot,
	projectConnections,
	resolveTarget,
	saveNewConnection,
} from "../../lib/usecases/project.ts";
import { fixedClock } from "../knowledge/fixtures.ts";
import { column, customersTable, ordersTable, snapshot } from "../fixtures/snapshot.ts";

const roots: string[] = [];

function tempDir(): string {
	const root = mkdtempSync(join(tmpdir(), "heydb-project-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const local: ConnectionConfig = {
	engine: "mysql",
	host: "127.0.0.1",
	port: 3306,
	user: "root",
	password: "env:HEYDB_LOCAL_PASSWORD",
	databases: null,
};

function project(connections: Record<string, ConnectionConfig> = { local }, defaultConnection: string | null = null): string {
	const root = tempDir();
	initProject(root);
	saveConfig(root, { formatVersion: 1, defaultConnection, connections });
	return root;
}

function errorCode(fn: () => unknown): { code: string; connection: string | null; message: string } {
	try {
		fn();
	} catch (error) {
		assert.ok(error instanceof ProjectError, `expected a ProjectError, got ${String(error)}`);
		return { code: error.code, connection: error.connection, message: error.message };
	}
	assert.fail("expected an error");
}

describe("openConnection", () => {
	test("finds the project from a subfolder and picks the only connection", () => {
		const root = project();
		const nested = join(root, "src", "app");
		mkdirSync(nested, { recursive: true });
		const opened = openConnection(nested);
		assert.equal(opened.root, root);
		assert.equal(opened.name, "local");
		assert.deepEqual(opened.connection, local);
	});

	test("uses the name it is given", () => {
		const root = project({ local, prod: { ...local, password: "env:HEYDB_PROD_PASSWORD" } }, "local");
		assert.equal(openConnection(root, "prod").name, "prod");
		assert.equal(openConnection(root).name, "local");
	});

	test("says the directory is not a heydb project", () => {
		assert.deepEqual(
			errorCode(() => openConnection(tempDir())),
			{ code: "not_initialized", connection: null, message: "no heydb project here (no .heydb/ in this folder or above)" },
		);
	});

	test("says the project has no connections yet", () => {
		const root = project({});
		for (const name of [undefined, "local"]) {
			assert.deepEqual(errorCode(() => openConnection(root, name)), {
				code: "no_connections",
				connection: null,
				message: "no connections are configured in this heydb project",
			});
		}
	});

	test("passes through the reason no connection was picked", () => {
		const root = project({ local, prod: { ...local, password: "env:HEYDB_PROD_PASSWORD" } });
		assert.throws(() => openConnection(root), { message: /several connections are configured \(local, prod\)/ });
		assert.throws(() => openConnection(root, "qa"), { message: 'unknown connection "qa"; configured: local, prod' });
	});
});

describe("openSnapshot", () => {
	test("returns the stored snapshot and knowledge of the connection", () => {
		const root = project();
		const stored = snapshot([ordersTable()]);
		saveSnapshot(root, "local", stored);
		annotate(root, "local", { target: "shop.shop.orders", text: "One per checkout.", author: "ana" }, fixedClock());

		const opened = openSnapshot(root);
		assert.deepEqual(opened.snapshot, stored);
		assert.deepEqual(opened.knowledge, loadKnowledge(root, "local"));
	});

	test("says the connection was never synced", () => {
		const root = project();
		assert.deepEqual(errorCode(() => openSnapshot(root)), {
			code: "never_synced",
			connection: "local",
			message: 'connection "local" was never synced: there is no stored snapshot yet',
		});
	});
});

describe("projectConnections", () => {
	test("lists connection names sorted, or null outside a project", () => {
		const root = project({ prod: { ...local, password: "env:HEYDB_PROD_PASSWORD" }, local });
		assert.deepEqual(projectConnections(join(root, ".heydb")), { root, names: ["local", "prod"] });
		assert.equal(projectConnections(tempDir()), null);
	});
});

describe("resolveTarget", () => {
	const twoDatabases: Snapshot = {
		...snapshot([customersTable(), ordersTable({ columns: [column("id", 1), column("status", 2)] })]),
		databases: [
			{ name: "shop", schemas: [{ name: "shop", tables: [customersTable(), ordersTable({ columns: [column("id", 1), column("status", 2)] })], routines: [] }] },
			{ name: "crm", schemas: [{ name: "crm", tables: [{ ...customersTable(), name: "leads" }], routines: [] }] },
		],
	};

	test("accepts databases, tables and columns in partial and canonical forms", () => {
		const cases: [string, string, string][] = [
			["shop", "database", "shop.shop"],
			["shop.shop", "database", "shop.shop"],
			["orders", "table", "shop.shop.orders"],
			["shop.orders", "table", "shop.shop.orders"],
			["shop.shop.orders", "table", "shop.shop.orders"],
			["status", "column", "shop.shop.orders.status"],
			["orders.status", "column", "shop.shop.orders.status"],
			["shop.orders.status", "column", "shop.shop.orders.status"],
			["shop.shop.orders.status", "column", "shop.shop.orders.status"],
			["Orders.STATUS", "column", "shop.shop.orders.status"],
		];
		for (const [input, kind, name] of cases) {
			assert.deepEqual(resolveTarget(twoDatabases, input), { kind, name }, input);
		}
	});

	test("explains an ambiguous column with its candidates", () => {
		assert.throws(() => resolveTarget(twoDatabases, "email"), {
			message: '"email" matches 2 columns; use the full name:\n- crm.crm.leads.email\n- shop.shop.customers.email',
		});
	});

	test("lists both readings when a name is a table and a column", () => {
		const tricky = snapshot([ordersTable({ name: "status" }), ordersTable({ columns: [column("id", 1), column("status", 2)] })]);
		assert.throws(() => resolveTarget(tricky, "status"), {
			message: '"status" names more than one object; use the full name:\n- table shop.shop.status\n- column shop.shop.orders.status',
		});
	});

	test("reports what nothing matched, with suggestions, in a few lines", () => {
		assert.throws(() => resolveTarget(twoDatabases, "ordrs"), {
			message: 'nothing matches "ordrs":\n- no table matches "ordrs". Did you mean: shop.shop.orders?\n- no column matches "ordrs"',
		});
	});

	test("rejects names with too many segments", () => {
		assert.throws(() => resolveTarget(twoDatabases, "a.b.c.d.e"), {
			message: 'expected a database, table or column name: got "a.b.c.d.e"',
		});
	});
});

describe("buildConnection", () => {
	test("turns typed answers into a connection whose password is only a reference", () => {
		assert.deepEqual(
			buildConnection("prod-eu", { engine: "mariadb", host: " db.internal ", port: "3307", user: "reader", databases: "shop, crm ,," }),
			{
				engine: "mariadb",
				host: "db.internal",
				port: 3307,
				user: "reader",
				password: "env:HEYDB_PROD_EU_PASSWORD",
				databases: ["shop", "crm"],
			},
		);
	});

	test("uses local defaults for empty host and port, and every database for an empty list", () => {
		assert.deepEqual(buildConnection("local", { engine: "mysql", host: "", port: " ", user: "root", databases: " " }), local);
	});

	test("rejects a port that is not a number with the same message as the config", () => {
		assert.throws(() => buildConnection("local", { engine: "mysql", host: "", port: "33o6", user: "root", databases: "" }), {
			message: "connections.local.port must be an integer from 1 to 65535",
		});
	});
});

describe("saveNewConnection", () => {
	test("makes the first connection the default and keeps the default afterwards", () => {
		const root = project({});
		assert.deepEqual(saveNewConnection(root, "local", local), { isDefault: true });
		assert.deepEqual(saveNewConnection(root, "prod", { ...local, password: "env:HEYDB_PROD_PASSWORD" }), { isDefault: false });
		const config = loadConfig(root);
		assert.equal(config.defaultConnection, "local");
		assert.deepEqual(Object.keys(config.connections), ["local", "prod"]);
	});

	test("refuses a name that already exists and leaves the file as it was", () => {
		const root = project();
		const before = loadConfig(root);
		assert.throws(() => saveNewConnection(root, "local", { ...local, port: 3307 }), {
			message: 'connection "local" already exists; update or remove it instead',
		});
		assert.deepEqual(loadConfig(root), before);
	});
});

describe("captureLive", () => {
	test("resolves the password reference and hands it to the engine", async () => {
		const root = project();
		const live = snapshot([ordersTable()]);
		const seen: [ConnectionConfig, string][] = [];
		const result = await captureLive(openConnection(root), {
			env: { HEYDB_LOCAL_PASSWORD: "s3cret" },
			introspect: async (entry, password) => {
				seen.push([entry, password]);
				return live;
			},
		});
		assert.equal(result, live);
		assert.deepEqual(seen, [[local, "s3cret"]]);
	});

	test("never calls the engine when the password is not set", async () => {
		const root = project();
		let called = false;
		await assert.rejects(
			captureLive(openConnection(root), {
				env: {},
				introspect: async () => {
					called = true;
					return snapshot([]);
				},
			}),
			{ message: /comes from env:HEYDB_LOCAL_PASSWORD, which is not set/ },
		);
		assert.equal(called, false);
	});
});

describe("forgetById", () => {
	test("removes an annotation or a relationship, whichever has the id", () => {
		const root = project();
		saveSnapshot(root, "local", snapshot([customersTable(), ordersTable()]));
		const clock = fixedClock();
		const note = annotate(root, "local", { target: "shop.shop.orders", text: "x", author: "ana" }, clock);
		const link = relate(
			root,
			"local",
			{
				from: { table: "shop.shop.orders", columns: ["customer_id"] },
				to: { table: "shop.shop.customers", columns: ["id"] },
				note: "",
				author: "ana",
			},
			clock,
		);

		assert.deepEqual(forgetById(root, "local", note.id), { kind: "annotation", annotation: note });
		assert.deepEqual(forgetById(root, "local", link.id), { kind: "relationship", relationship: link });
		assert.deepEqual(loadKnowledge(root, "local"), { formatVersion: 1, annotations: [], relationships: [] });
	});

	test("says no entry has an unknown id", () => {
		const root = project();
		assert.throws(() => forgetById(root, "local", "nope"), { message: 'no annotation or relationship has id "nope"' });
	});
});
