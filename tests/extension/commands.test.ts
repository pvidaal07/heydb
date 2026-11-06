import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import { loadConfig, saveConfig } from "../../lib/config/store.ts";
import { renderChanges } from "../../lib/render/markdown.ts";
import { loadSnapshot, saveSnapshot } from "../../lib/store/snapshots.ts";
import { initProject } from "../../lib/usecases/init.ts";
import { column, customersTable, ordersTable, snapshot } from "../fixtures/snapshot.ts";
import { fakeContext, fakeIntrospect, loadHeydb, runCommand, tempDirs } from "./fake-pi.ts";

const tempDir = tempDirs("heydb-commands-");

const local = {
	engine: "mysql" as const,
	host: "127.0.0.1",
	port: 3306,
	user: "root",
	password: "env:HEYDB_LOCAL_PASSWORD",
	databases: null,
};

const live = snapshot([customersTable(), ordersTable()], {
	warnings: [{ code: "triggers_hidden", message: "Triggers are not visible to this user", target: "shop" }],
});

function project(): string {
	const root = tempDir();
	initProject(root);
	saveConfig(root, { formatVersion: 1, defaultConnection: "local", connections: { local } });
	return root;
}

test("registers the human commands", () => {
	const pi = loadHeydb();
	assert.deepEqual([...pi.commands.keys()], ["heydb:about", "heydb:init", "heydb:connect", "heydb:sync", "heydb:status"]);
	for (const command of pi.commands.values()) assert.ok(command.description, "every command has a description");
});

describe("/heydb:init", () => {
	test("creates .heydb/ in the current folder and says what is next", async () => {
		const pi = loadHeydb();
		const root = tempDir();
		const ctx = fakeContext(root);
		await runCommand(pi, "heydb:init", "", ctx);
		assert.ok(existsSync(join(root, ".heydb", "config.json")));
		assert.deepEqual(ctx.notifications, [
			{
				message: `heydb project ready in ${root}: created .heydb/, .heydb/.gitignore, .heydb/config.json. Next: /heydb:connect.`,
				level: "info",
			},
		]);
	});

	test("run again from a subfolder, fills in the existing project and creates nothing new", async () => {
		const pi = loadHeydb();
		const root = project();
		const ctx = fakeContext(join(root, ".heydb"));
		await runCommand(pi, "heydb:init", "", ctx);
		assert.deepEqual(ctx.notifications, [{ message: `heydb project already initialized in ${root}.`, level: "info" }]);
	});
});

describe("/heydb:connect", () => {
	test("asks for everything but the password and saves the first connection as the default", async () => {
		const pi = loadHeydb();
		const root = tempDir();
		initProject(root);
		const ctx = fakeContext(root, { answers: ["local", "mariadb", "", "3307", "root", "shop, crm"] });
		await runCommand(pi, "heydb:connect", "", ctx);

		assert.deepEqual(
			ctx.dialogs.map((dialog) => [dialog.kind, dialog.title]),
			[
				["input", "Connection name"],
				["select", "Engine"],
				["input", "Host"],
				["input", "Port"],
				["input", "User"],
				["input", "Databases (comma-separated, empty for all)"],
			],
		);
		for (const dialog of ctx.dialogs) assert.doesNotMatch(`${dialog.title} ${dialog.hint}`, /password|secret/i);

		assert.deepEqual(loadConfig(root), {
			formatVersion: 1,
			defaultConnection: "local",
			connections: {
				local: {
					engine: "mariadb",
					host: "127.0.0.1",
					port: 3307,
					user: "root",
					password: "env:HEYDB_LOCAL_PASSWORD",
					databases: ["shop", "crm"],
				},
			},
		});
		assert.deepEqual(ctx.notifications, [
			{
				message:
					'Saved connection "local" (mariadb root@127.0.0.1:3307, databases shop, crm) as the default.\n' +
					"heydb never stores passwords: set HEYDB_LOCAL_PASSWORD in your shell or in .heydb/.env (ignored by git), " +
					"then run /heydb:sync local.",
				level: "info",
			},
		]);
	});

	test("a second connection does not take the default", async () => {
		const pi = loadHeydb();
		const root = project();
		const ctx = fakeContext(root, { answers: ["prod", "mysql", "db.internal", "", "reader", ""] });
		await runCommand(pi, "heydb:connect", "", ctx);
		assert.equal(loadConfig(root).defaultConnection, "local");
		assert.equal(
			ctx.notifications[0]?.message,
			'Saved connection "prod" (mysql reader@db.internal:3306, all databases).\n' +
				"heydb never stores passwords: set HEYDB_PROD_PASSWORD in your shell or in .heydb/.env (ignored by git), " +
				"then run /heydb:sync prod.",
		);
	});

	test("stops without saving when a dialog is cancelled", async () => {
		const pi = loadHeydb();
		const root = project();
		const before = readFileSync(join(root, ".heydb", "config.json"), "utf8");
		const ctx = fakeContext(root, { answers: ["prod", "mysql", undefined] });
		await runCommand(pi, "heydb:connect", "", ctx);
		assert.equal(readFileSync(join(root, ".heydb", "config.json"), "utf8"), before);
		assert.deepEqual(ctx.notifications, [{ message: "heydb:connect cancelled; nothing was saved.", level: "info" }]);
	});

	test("reports invalid answers and saves nothing", async () => {
		const pi = loadHeydb();
		const root = project();
		const before = readFileSync(join(root, ".heydb", "config.json"), "utf8");
		const ctx = fakeContext(root, { answers: ["prod", "mysql", "", "33o6", "root", ""] });
		await runCommand(pi, "heydb:connect", "", ctx);
		assert.equal(readFileSync(join(root, ".heydb", "config.json"), "utf8"), before);
		assert.deepEqual(ctx.notifications, [{ message: "connections.prod.port must be an integer from 1 to 65535", level: "error" }]);
	});

	test("without an interactive UI, explains how to edit config.json and asks nothing", async () => {
		const pi = loadHeydb();
		const root = project();
		const ctx = fakeContext(root, { hasUI: false });
		await runCommand(pi, "heydb:connect", "", ctx);
		assert.deepEqual(ctx.dialogs, []);
		assert.equal(ctx.notifications.length, 1);
		assert.match(ctx.notifications[0]?.message ?? "", /needs an interactive session/);
		assert.match(ctx.notifications[0]?.message ?? "", /"password": "env:HEYDB_LOCAL_PASSWORD"/);
	});

	test("outside a project, says to run /heydb:init first", async () => {
		const pi = loadHeydb();
		const ctx = fakeContext(tempDir(), { answers: ["local"] });
		await runCommand(pi, "heydb:connect", "", ctx);
		assert.deepEqual(ctx.dialogs, []);
		assert.deepEqual(ctx.notifications, [{ message: "No heydb project here: run /heydb:init first.", level: "error" }]);
	});
});

describe("/heydb:sync", () => {
	test("captures the live schema with the resolved password and reports the first sync", async () => {
		const { introspect, passwords } = fakeIntrospect(live);
		const pi = loadHeydb({ introspect, env: { HEYDB_LOCAL_PASSWORD: "s3cret" } });
		const root = project();
		const ctx = fakeContext(root);
		await runCommand(pi, "heydb:sync", "", ctx);

		assert.deepEqual(passwords, ["s3cret"]);
		assert.deepEqual(loadSnapshot(root, "local"), live);
		assert.deepEqual(ctx.notifications, [
			{ message: "heydb sync local: snapshot written · 1 database, 2 tables · 1 warning · 1 change.", level: "info" },
		]);
		assert.equal(pi.messages.length, 1);
		assert.equal(pi.messages[0]?.message.customType, "heydb");
		assert.equal(pi.messages[0]?.message.display, true);
		assert.match(String(pi.messages[0]?.message.content), /^heydb sync local changed the stored snapshot:\n\n- added database shop/);
		for (const sent of pi.messages) assert.doesNotMatch(JSON.stringify(sent), /s3cret/);
	});

	test("leaves the snapshot alone when nothing changed", async () => {
		const pi = loadHeydb({ introspect: fakeIntrospect(live).introspect, env: { HEYDB_LOCAL_PASSWORD: "" } });
		const root = project();
		saveSnapshot(root, "local", live);
		const ctx = fakeContext(root);
		await runCommand(pi, "heydb:sync", "", ctx);
		assert.deepEqual(ctx.notifications, [
			{ message: "heydb sync local: unchanged · 1 database, 2 tables · 1 warning.", level: "info" },
		]);
		assert.deepEqual(pi.messages, []);
	});

	test("syncs the connection named in the arguments and lists the changes", async () => {
		const changed = snapshot([customersTable(), ordersTable({ columns: [...ordersTable().columns, column("status", 4)] })]);
		const pi = loadHeydb({ introspect: fakeIntrospect(changed).introspect, env: { HEYDB_PROD_PASSWORD: "x" } });
		const root = project();
		saveConfig(root, {
			formatVersion: 1,
			defaultConnection: "local",
			connections: { local, prod: { ...local, password: "env:HEYDB_PROD_PASSWORD" } },
		});
		saveSnapshot(root, "prod", live);
		const ctx = fakeContext(root);
		await runCommand(pi, "heydb:sync", " prod ", ctx);
		assert.equal(ctx.notifications[0]?.message, "heydb sync prod: snapshot written · 1 database, 2 tables · 1 change.");
		assert.equal(String(pi.messages[0]?.message.content), `heydb sync prod changed the stored snapshot:\n\n${renderChanges([
			{ kind: "added", object: "column", target: "shop.shop.orders.status", details: [] },
		])}`);
	});

	test("never connects without a password, and never echoes one", async () => {
		let connected = false;
		const pi = loadHeydb({
			introspect: async () => {
				connected = true;
				return live;
			},
		});
		const root = project();
		const ctx = fakeContext(root);
		await runCommand(pi, "heydb:sync", "", ctx);
		assert.equal(connected, false);
		assert.deepEqual(ctx.notifications, [
			{
				message:
					'password for connection "local" comes from env:HEYDB_LOCAL_PASSWORD, which is not set. Set it in your shell or in .heydb/.env (ignored by git).',
				level: "error",
			},
		]);
		assert.equal(loadSnapshot(root, "local"), null);
	});

	test("reports engine failures as an error notification", async () => {
		const pi = loadHeydb({
			introspect: async () => {
				throw new Error("connect ECONNREFUSED 127.0.0.1:3306");
			},
			env: { HEYDB_LOCAL_PASSWORD: "x" },
		});
		const ctx = fakeContext(project());
		await runCommand(pi, "heydb:sync", "", ctx);
		assert.deepEqual(ctx.notifications, [{ message: "heydb sync local failed: connect ECONNREFUSED 127.0.0.1:3306", level: "error" }]);
	});

	test("outside a project or without connections, says which command to run", async () => {
		const pi = loadHeydb();
		const outside = fakeContext(tempDir());
		await runCommand(pi, "heydb:sync", "", outside);
		assert.deepEqual(outside.notifications, [{ message: "No heydb project here: run /heydb:init first.", level: "error" }]);

		const empty = tempDir();
		initProject(empty);
		const none = fakeContext(empty);
		await runCommand(pi, "heydb:sync", "", none);
		assert.deepEqual(none.notifications, [{ message: "No connections yet: run /heydb:connect first.", level: "error" }]);
	});
});

describe("commands that connect", () => {
	// Pi can start a second command while the first awaits the server. Under
	// Pi's module loader, two first-time loads of mysql2 at once break the
	// second one, and two syncs of one connection would race on its file.
	test("run one at a time, in the order they were started", async () => {
		let running = 0;
		let most = 0;
		const order: string[] = [];
		const pi = loadHeydb({
			env: { HEYDB_LOCAL_PASSWORD: "x" },
			introspect: async () => {
				running += 1;
				most = Math.max(most, running);
				await new Promise((resolve) => setTimeout(resolve, 10));
				running -= 1;
				return live;
			},
		});
		const root = project();
		const runs = ["heydb:sync", "heydb:status", "heydb:sync"].map(async (name) => {
			const ctx = fakeContext(root);
			await runCommand(pi, name, "", ctx);
			order.push(`${name} ${ctx.notifications[0]?.message.split(":")[1]?.trim()}`);
		});
		await Promise.all(runs);
		assert.equal(most, 1);
		assert.deepEqual(order, ["heydb:sync snapshot written · 1 database, 2 tables · 1 warning · 1 change.", "heydb:status Up to date", "heydb:sync unchanged · 1 database, 2 tables · 1 warning."]);
	});

	test("a failed run does not block the next one", async () => {
		let calls = 0;
		const pi = loadHeydb({
			env: { HEYDB_LOCAL_PASSWORD: "x" },
			introspect: async () => {
				calls += 1;
				if (calls === 1) throw new Error("boom");
				return live;
			},
		});
		const root = project();
		const first = fakeContext(root);
		const second = fakeContext(root);
		await Promise.all([runCommand(pi, "heydb:sync", "", first), runCommand(pi, "heydb:sync", "", second)]);
		assert.equal(first.notifications[0]?.level, "error");
		assert.equal(second.notifications[0]?.level, "info");
	});
});

describe("/heydb:status", () => {
	test("says the connection was never synced and how to fix it", async () => {
		const pi = loadHeydb({ introspect: fakeIntrospect(live).introspect, env: { HEYDB_LOCAL_PASSWORD: "x" } });
		const ctx = fakeContext(project());
		await runCommand(pi, "heydb:status", "", ctx);
		assert.deepEqual(ctx.notifications, [
			{
				message: "heydb status local: Never synced: there is no stored snapshot for this connection yet. Run /heydb:sync local.",
				level: "warning",
			},
		]);
	});

	test("reports up to date and drifted without writing anything", async () => {
		const changed = snapshot([customersTable()]);
		const pi = loadHeydb({ introspect: fakeIntrospect(live, changed).introspect, env: { HEYDB_LOCAL_PASSWORD: "x" } });
		const root = project();
		saveSnapshot(root, "local", live);

		const first = fakeContext(root);
		await runCommand(pi, "heydb:status", "", first);
		assert.match(first.notifications[0]?.message ?? "", /^heydb status local: Up to date: the live database matches the snapshot/);
		assert.equal(first.notifications[0]?.level, "info");

		const second = fakeContext(root);
		await runCommand(pi, "heydb:status", "local", second);
		assert.equal(
			second.notifications[0]?.message,
			"heydb status local: Drifted: the live database differs from the snapshot in 1 change.\n\n" +
				"- removed table shop.shop.orders\n\nRun /heydb:sync local to store it.",
		);
		assert.equal(second.notifications[0]?.level, "warning");
		assert.deepEqual(loadSnapshot(root, "local"), live);
	});
});

describe("argument completion", () => {
	test("completes connection names of the project in the current folder", async () => {
		const root = project();
		saveConfig(root, {
			formatVersion: 1,
			defaultConnection: "local",
			connections: { local, prod: { ...local, password: "env:HEYDB_PROD_PASSWORD" } },
		});
		const pi = loadHeydb({ cwd: () => root });
		for (const name of ["heydb:sync", "heydb:status"]) {
			const complete = pi.commands.get(name)?.getArgumentCompletions;
			assert.ok(complete, name);
			assert.deepEqual(await complete("p"), [{ value: "prod", label: "prod" }]);
			assert.deepEqual(await complete(""), [
				{ value: "local", label: "local" },
				{ value: "prod", label: "prod" },
			]);
			assert.equal(await complete("x"), null);
		}
	});

	test("offers nothing outside a project or with a broken config", async () => {
		const outside = tempDir();
		assert.equal(await loadHeydb({ cwd: () => outside }).commands.get("heydb:sync")?.getArgumentCompletions?.(""), null);
		const broken = tempDir();
		initProject(broken);
		writeFileSync(join(broken, ".heydb", "config.json"), "{");
		assert.equal(await loadHeydb({ cwd: () => broken }).commands.get("heydb:sync")?.getArgumentCompletions?.(""), null);
	});
});
