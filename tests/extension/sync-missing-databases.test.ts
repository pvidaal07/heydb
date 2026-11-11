import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import type { HeydbDeps } from "../../extensions/deps.ts";
import { loadConfig, saveConfig } from "../../lib/config/store.ts";
import type { Config, ConnectionConfig } from "../../lib/config/types.ts";
import { stableJson } from "../../lib/store/files.ts";
import { loadSnapshot } from "../../lib/store/snapshots.ts";
import { initProject } from "../../lib/usecases/init.ts";
import { customersTable, ordersTable, snapshot } from "../fixtures/snapshot.ts";
import { fakeContext, loadHeydb, runCommand, tempDirs } from "./fake-pi.ts";

// Issue #144: a connection lists a database the server does not have (or the
// user cannot see). Before a sync heydb checks, asks once per missing database
// whether to remove it from .heydb/config.json, and a kept one is skipped and
// named in the result instead of hiding behind "1 warning".

const tempDir = tempDirs("heydb-missing-db-");

const acme: ConnectionConfig = {
	engine: "mariadb",
	host: "db.example.test",
	port: 3306,
	user: "root",
	password: "env:HEYDB_ACME_PASSWORD",
	databases: ["shop", "sales_2019"],
};
const other: ConnectionConfig = { ...acme, host: "10.0.0.2", port: 3306, password: "env:HEYDB_OTHER_PASSWORD", databases: ["crm"] };

/** The server of these tests has only "shop". */
const ON_SERVER = ["shop"];

const NO_CODE = "\nNo code using these tables was found here; heydb will learn from your conversations (the agent annotates what you explain).";

const QUESTION = (database: string) =>
	`Database "${database}" does not exist on db.example.test:3306 or is not visible to root. Remove it from connection "acme"?`;
const QUESTION_HINT = "Yes removes it from .heydb/config.json. No keeps it there, and the sync skips it.";

function project(databases: readonly string[] | null = acme.databases): { root: string; config: Config } {
	const root = tempDir();
	initProject(root);
	const config: Config = { formatVersion: 1, defaultConnection: "acme", connections: { acme: { ...acme, databases }, other } };
	saveConfig(root, config);
	return { root, config };
}

/** Plays the engine: what it checks, what it captures, and the warning it gives for a database it cannot see. */
function fakeServer() {
	const checked: (readonly string[] | null)[] = [];
	const captured: (readonly string[] | null)[] = [];
	const missingDatabases: HeydbDeps["missingDatabases"] = async (entry, password) => {
		assert.equal(password, "s3cret");
		checked.push(entry.databases);
		return (entry.databases ?? []).filter((name) => !ON_SERVER.includes(name));
	};
	const introspect: HeydbDeps["introspect"] = async (entry) => {
		captured.push(entry.databases);
		const requested = entry.databases ?? ON_SERVER;
		const warnings = requested
			.filter((name) => !ON_SERVER.includes(name))
			.map((name) => ({
				code: "database_not_visible",
				message: `database "${name}" does not exist or the user has no privileges on it`,
				target: name,
			}));
		const visible = requested.filter((name) => ON_SERVER.includes(name));
		return snapshot(visible.length === 0 ? [] : [customersTable(), ordersTable()], {
			databases: visible.length === 0 ? [] : snapshot([customersTable(), ordersTable()]).databases,
			warnings,
		});
	};
	return { checked, captured, deps: { missingDatabases, introspect, env: { HEYDB_ACME_PASSWORD: "s3cret" } } };
}

function configText(root: string): string {
	return readFileSync(join(root, ".heydb", "config.json"), "utf8");
}

describe("/heydb:sync with a configured database the server does not have", () => {
	test("asks once per missing database, naming it and host:port, and removes it when told to", async () => {
		const server = fakeServer();
		const pi = loadHeydb(server.deps);
		const { root, config } = project();
		const ctx = fakeContext(root, { answers: ["yes"] });
		await runCommand(pi, "heydb:sync", "", ctx);

		assert.deepEqual(ctx.dialogs, [{ kind: "confirm", title: QUESTION("sales_2019"), hint: QUESTION_HINT }]);
		const expected: Config = { ...config, connections: { ...config.connections, acme: { ...acme, databases: ["shop"] } } };
		assert.deepEqual(loadConfig(root), expected);
		// Written like every other config change: same file, same format, the rest intact.
		assert.equal(configText(root), stableJson(expected));
		assert.deepEqual(server.captured, [["shop"]]);
		assert.deepEqual(ctx.notifications, [
			{
				message: `heydb sync acme: removed sales_2019 from .heydb/config.json · snapshot written · 1 database, 2 tables · 1 change.${NO_CODE}`,
				level: "info",
			},
		]);
	});

	test("keeps it when told to: the config is untouched, the sync skips it and names it", async () => {
		const server = fakeServer();
		const pi = loadHeydb(server.deps);
		const { root } = project();
		const before = configText(root);
		const ctx = fakeContext(root, { answers: ["no"] });
		await runCommand(pi, "heydb:sync", "", ctx);

		assert.deepEqual(ctx.dialogs, [{ kind: "confirm", title: QUESTION("sales_2019"), hint: QUESTION_HINT }]);
		assert.equal(configText(root), before);
		assert.deepEqual(server.captured, [["shop", "sales_2019"]]);
		assert.deepEqual(ctx.notifications, [
			{
				message:
					"heydb sync acme: snapshot written · 1 database, 2 tables · 1 change · " +
					`skipped sales_2019 (does not exist on db.example.test:3306 or is not visible to root).${NO_CODE}`,
				level: "info",
			},
		]);
	});

	test("asks one question per missing database and applies each answer", async () => {
		const server = fakeServer();
		const pi = loadHeydb(server.deps);
		const { root } = project(["shop", "sales_2019", "archive", "legacy"]);
		const ctx = fakeContext(root, { answers: ["yes", "no", "yes"] });
		await runCommand(pi, "heydb:sync", "", ctx);

		assert.deepEqual(
			ctx.dialogs.map((dialog) => dialog.title),
			[QUESTION("sales_2019"), QUESTION("archive"), QUESTION("legacy")],
		);
		assert.deepEqual(loadConfig(root).connections.acme?.databases, ["shop", "archive"]);
		assert.deepEqual(server.captured, [["shop", "archive"]]);
		assert.equal(
			ctx.notifications[0]?.message,
			"heydb sync acme: removed sales_2019, legacy from .heydb/config.json · snapshot written · 1 database, 2 tables · 1 change · " +
				`skipped archive (does not exist on db.example.test:3306 or is not visible to root).${NO_CODE}`,
		);
	});

	test("without a UI asks nothing, keeps the config and names what it skipped", async () => {
		const server = fakeServer();
		const pi = loadHeydb(server.deps);
		const { root } = project(["shop", "sales_2019", "archive"]);
		const before = configText(root);
		const ctx = fakeContext(root, { hasUI: false });
		await runCommand(pi, "heydb:sync", "", ctx);

		assert.deepEqual(ctx.dialogs, []);
		assert.equal(configText(root), before);
		assert.deepEqual(ctx.notifications, [
			{
				message:
					"heydb sync acme: snapshot written · 1 database, 2 tables · 1 change · " +
					`skipped sales_2019, archive (do not exist on db.example.test:3306 or are not visible to root).${NO_CODE}`,
				level: "info",
			},
		]);
	});

	test("when none of its databases exist, asks nothing, reads nothing and writes no snapshot", async () => {
		const server = fakeServer();
		const pi = loadHeydb(server.deps);
		const { root } = project(["sales_2019", "archive"]);
		const before = configText(root);
		for (const hasUI of [true, false]) {
			const ctx = fakeContext(root, { hasUI, answers: ["yes", "yes"] });
			await runCommand(pi, "heydb:sync", "", ctx);
			assert.deepEqual(ctx.dialogs, []);
			assert.deepEqual(ctx.notifications, [
				{
					message:
						"heydb sync acme: none of its databases (sales_2019, archive) exist on db.example.test:3306 or are visible to root, " +
						"so nothing was synced. Fix its databases in .heydb/config.json, or remove the connection with /heydb:connections remove acme.",
					level: "error",
				},
			]);
		}
		assert.deepEqual(server.captured, []);
		assert.equal(loadSnapshot(root, "acme"), null);
		assert.equal(configText(root), before);
	});

	test("with every database present, asks nothing and reports as before", async () => {
		const server = fakeServer();
		const pi = loadHeydb(server.deps);
		const { root } = project(["shop"]);
		const before = configText(root);
		const ctx = fakeContext(root);
		await runCommand(pi, "heydb:sync", "", ctx);

		assert.deepEqual(server.checked, [["shop"]]);
		assert.deepEqual(ctx.dialogs, []);
		assert.equal(configText(root), before);
		assert.deepEqual(ctx.notifications, [
			{ message: `heydb sync acme: snapshot written · 1 database, 2 tables · 1 change.${NO_CODE}`, level: "info" },
		]);
	});

	test("a connection that captures every visible database has nothing to check", async () => {
		const server = fakeServer();
		const pi = loadHeydb(server.deps);
		const { root } = project(null);
		const ctx = fakeContext(root);
		await runCommand(pi, "heydb:sync", "", ctx);

		assert.deepEqual(server.checked, []);
		assert.deepEqual(ctx.dialogs, []);
		assert.equal(ctx.notifications[0]?.level, "info");
	});

	test("a failing check is reported like any other failed sync, and nothing is written", async () => {
		const pi = loadHeydb({
			env: { HEYDB_ACME_PASSWORD: "s3cret" },
			missingDatabases: async () => {
				throw new Error("mysql: cannot connect to db.example.test:3306 as root: connect ETIMEDOUT");
			},
			introspect: async () => assert.fail("must not read the structure after a failed check"),
		});
		const { root } = project();
		const ctx = fakeContext(root);
		await runCommand(pi, "heydb:sync", "", ctx);
		assert.deepEqual(ctx.notifications, [
			{ message: "heydb sync acme failed: mysql: cannot connect to db.example.test:3306 as root: connect ETIMEDOUT", level: "error" },
		]);
		assert.equal(loadSnapshot(root, "acme"), null);
		assert.equal(ctx.statuses.get("heydb"), undefined, "progress cleared after the error");
	});
});
