import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, test } from "node:test";
import { gunzipSync } from "node:zlib";

import { loadConfig, saveConfig } from "../../lib/config/store.ts";
import { renderChanges } from "../../lib/render/markdown.ts";
import { loadKnowledge } from "../../lib/store/knowledge.ts";
import { loadSnapshot, saveSnapshot } from "../../lib/store/snapshots.ts";
import { initProject } from "../../lib/usecases/init.ts";
import { annotate } from "../../lib/usecases/knowledge.ts";
import { fixedClock } from "../knowledge/fixtures.ts";
import { column, customersTable, ordersTable, snapshot } from "../fixtures/snapshot.ts";
import { learnMessage } from "../../extensions/commands.ts";
import type { SchemaUsage } from "../../lib/usecases/code-scan.ts";
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

const PASSWORD_LOCAL =
	"Password for local (stored in .heydb/.env, ignored by git; leave empty to set HEYDB_LOCAL_PASSWORD yourself)";
/** What the masked input shows under its title before anything is typed. */
const SECRET_HINT = "> \nenter saves · esc cancels";

/** The summary line of a sync when the project has no code that uses the tables. */
const NO_CODE = "\nNo code using these tables was found here; heydb will learn from your conversations (the agent annotates what you explain).";

function project(): string {
	const root = tempDir();
	initProject(root);
	saveConfig(root, { formatVersion: 1, defaultConnection: "local", connections: { local } });
	return root;
}

test("registers the human commands", () => {
	const pi = loadHeydb();
	assert.deepEqual(
		[...pi.commands.keys()],
		[
			"heydb:about",
			"heydb:init",
			"heydb:connect",
			"heydb:sync",
			"heydb:status",
			"heydb:password",
			"heydb:connections",
			"heydb:learn-code",
		],
	);
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
	test("asks for the connection, then for the password hidden, and saves the first connection as the default", async () => {
		const pi = loadHeydb();
		const root = tempDir();
		initProject(root);
		const ctx = fakeContext(root, { answers: ["local", "mariadb", "", "3307", "root", "shop, crm", ""] });
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
				["secret", PASSWORD_LOCAL],
			],
		);
		// Only the masked input asks for it: anything typed in a plain input is shown on screen.
		for (const dialog of ctx.dialogs.filter((dialog) => dialog.kind !== "secret")) {
			assert.doesNotMatch(`${dialog.title} ${dialog.hint}`, /password|secret/i);
		}
		assert.equal(existsSync(join(root, ".heydb", ".env")), false, "an empty answer stores nothing");

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
		const ctx = fakeContext(root, { answers: ["prod", "mysql", "db.internal", "", "reader", "", ""] });
		await runCommand(pi, "heydb:connect", "", ctx);
		assert.deepEqual(
			ctx.dialogs.map((dialog) => [dialog.title, dialog.hint]),
			[
				["Connection name", "local"],
				["Engine", "mysql,mariadb,postgresql"],
				["Host", "127.0.0.1"],
				["Port", "3306"],
				["User", "root"],
				["Databases (comma-separated, empty for all)", "shop, crm"],
				[
					"Password for prod (stored in .heydb/.env, ignored by git; leave empty to set HEYDB_PROD_PASSWORD yourself)",
					SECRET_HINT,
				],
			],
			"MySQL keeps its questions and hints",
		);
		assert.equal(loadConfig(root).connections.prod?.port, 3306);
		assert.equal(loadConfig(root).defaultConnection, "local");
		assert.equal(
			ctx.notifications[0]?.message,
			'Saved connection "prod" (mysql reader@db.internal:3306, all databases).\n' +
				"heydb never stores passwords: set HEYDB_PROD_PASSWORD in your shell or in .heydb/.env (ignored by git), " +
				"then run /heydb:sync prod.",
		);
	});

	test("turns a typed name like Acme into a valid one and says so", async () => {
		const pi = loadHeydb();
		const root = project();
		const ctx = fakeContext(root, { answers: ["Acme", "mysql", "db.internal", "", "reader", "", ""] });
		await runCommand(pi, "heydb:connect", "", ctx);
		assert.ok(loadConfig(root).connections.acme, "saved as acme");
		assert.equal(
			ctx.notifications[0]?.message,
			'Saved connection "acme" (mysql reader@db.internal:3306, all databases).\n' +
				'Connection names are lowercase letters, digits, "-" and "_", so "Acme" became "acme".\n' +
				"heydb never stores passwords: set HEYDB_ACME_PASSWORD in your shell or in .heydb/.env (ignored by git), " +
				"then run /heydb:sync acme.",
		);
	});

	test("PostgreSQL: default port 5432, one database and optional schemas", async () => {
		const pi = loadHeydb();
		const root = tempDir();
		initProject(root);
		const ctx = fakeContext(root, { answers: ["pg", "postgresql", "", "", "reader", " legacy ", "public, billing", ""] });
		await runCommand(pi, "heydb:connect", "", ctx);

		assert.deepEqual(ctx.dialogs, [
			{ kind: "input", title: "Connection name", hint: "local" },
			{ kind: "select", title: "Engine", hint: "mysql,mariadb,postgresql" },
			{ kind: "input", title: "Host", hint: "127.0.0.1" },
			{ kind: "input", title: "Port", hint: "5432" },
			{ kind: "input", title: "User", hint: "postgres" },
			{ kind: "input", title: "Database (exactly one: a PostgreSQL connection reaches one database)", hint: "postgres" },
			{ kind: "input", title: "Schemas (comma-separated, empty for all non-system schemas)", hint: "public" },
			{
				kind: "secret",
				title: "Password for pg (stored in .heydb/.env, ignored by git; leave empty to set HEYDB_PG_PASSWORD yourself)",
				hint: SECRET_HINT,
			},
		]);
		assert.deepEqual(loadConfig(root).connections.pg, {
			engine: "postgresql",
			host: "127.0.0.1",
			port: 5432,
			user: "reader",
			password: "env:HEYDB_PG_PASSWORD",
			databases: ["legacy"],
			schemas: ["public", "billing"],
		});
		assert.equal(
			ctx.notifications[0]?.message,
			'Saved connection "pg" (postgresql reader@127.0.0.1:5432, database legacy, schemas public, billing) as the default.\n' +
				"heydb never stores passwords: set HEYDB_PG_PASSWORD in your shell or in .heydb/.env (ignored by git), " +
				"then run /heydb:sync pg.",
		);
	});

	test("PostgreSQL: empty schemas capture every non-system schema", async () => {
		const pi = loadHeydb();
		const root = project();
		const ctx = fakeContext(root, { answers: ["pg", "postgresql", "pg.internal", "5433", "reader", "legacy", "", ""] });
		await runCommand(pi, "heydb:connect", "", ctx);
		assert.equal(loadConfig(root).connections.pg?.schemas, null);
		assert.match(ctx.notifications[0]?.message ?? "", /^Saved connection "pg" \(postgresql reader@pg\.internal:5433, database legacy, all schemas\)\.\n/);
	});

	test("PostgreSQL: no database, or more than one, is reported and nothing is saved", async () => {
		for (const database of ["", "legacy, other"]) {
			const pi = loadHeydb();
			const root = project();
			const before = readFileSync(join(root, ".heydb", "config.json"), "utf8");
			const ctx = fakeContext(root, { answers: ["pg", "postgresql", "", "", "reader", database, ""] });
			await runCommand(pi, "heydb:connect", "", ctx);
			assert.equal(readFileSync(join(root, ".heydb", "config.json"), "utf8"), before);
			assert.deepEqual(ctx.notifications, [
				{
					message:
						"connections.pg.databases must list exactly one database for postgresql: a PostgreSQL connection only reaches " +
						'the database it connects to, so add one connection per database (and use "schemas" to choose schemas inside it)',
					level: "error",
				},
			]);
		}
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

describe("/heydb:connect password", () => {
	const answers = (password: string | undefined) => ["local", "mysql", "", "", "root", "", password];
	const envFile = (root: string) => readFileSync(join(root, ".heydb", ".env"), "utf8");

	test("saves a typed password in .heydb/.env, owner-only and ignored by git", async () => {
		const pi = loadHeydb();
		const root = tempDir();
		initProject(root);
		const ctx = fakeContext(root, { answers: answers("p4ss word") });
		await runCommand(pi, "heydb:connect", "", ctx);

		assert.equal(envFile(root), "HEYDB_LOCAL_PASSWORD=p4ss word\n");
		if (process.platform !== "win32") assert.equal(statSync(join(root, ".heydb", ".env")).mode & 0o777, 0o600);
		assert.match(readFileSync(join(root, ".heydb", ".gitignore"), "utf8"), /^\.env$/m);
		assert.equal(loadConfig(root).connections.local?.password, "env:HEYDB_LOCAL_PASSWORD");
		assert.deepEqual(ctx.notifications, [
			{
				message:
					'Saved connection "local" (mysql root@127.0.0.1:3306, all databases) as the default.\n' +
					"Password saved in .heydb/.env as HEYDB_LOCAL_PASSWORD (ignored by git). Next: /heydb:sync local.",
				level: "info",
			},
		]);
	});

	test("says when the environment already sets the variable, because that value wins", async () => {
		const pi = loadHeydb({ env: { HEYDB_LOCAL_PASSWORD: "old" } });
		const root = tempDir();
		initProject(root);
		const ctx = fakeContext(root, { answers: answers("new") });
		await runCommand(pi, "heydb:connect", "", ctx);
		assert.match(
			ctx.notifications[0]?.message ?? "",
			/\nNote: HEYDB_LOCAL_PASSWORD is also set in your environment, and that value wins over \.heydb\/\.env\.$/,
		);
	});

	test("escape at the password cancels everything", async () => {
		const pi = loadHeydb();
		const root = tempDir();
		initProject(root);
		const before = readFileSync(join(root, ".heydb", "config.json"), "utf8");
		const ctx = fakeContext(root, { answers: answers(undefined) });
		await runCommand(pi, "heydb:connect", "", ctx);
		assert.equal(readFileSync(join(root, ".heydb", "config.json"), "utf8"), before);
		assert.equal(existsSync(join(root, ".heydb", ".env")), false);
		assert.deepEqual(ctx.notifications, [{ message: "heydb:connect cancelled; nothing was saved.", level: "info" }]);
	});

	test("an existing name is reported before the password is asked", async () => {
		const pi = loadHeydb();
		const root = project();
		const ctx = fakeContext(root, { answers: answers("never-asked") });
		await runCommand(pi, "heydb:connect", "", ctx);
		assert.equal(ctx.dialogs.some((dialog) => dialog.kind === "secret"), false);
		assert.deepEqual(ctx.notifications, [
			{ message: 'connection "local" already exists; update or remove it instead', level: "error" },
		]);
	});

	test("without Pi's terminal (RPC), skips the password and explains how to set it", async () => {
		const pi = loadHeydb();
		const root = tempDir();
		initProject(root);
		const ctx = fakeContext(root, { mode: "rpc", answers: answers("unused") });
		await runCommand(pi, "heydb:connect", "", ctx);
		assert.equal(ctx.dialogs.some((dialog) => dialog.kind === "secret"), false);
		assert.ok(loadConfig(root).connections.local);
		assert.match(ctx.notifications[0]?.message ?? "", /heydb never stores passwords: set HEYDB_LOCAL_PASSWORD in your shell/);
	});

	// The one place the password may live is .heydb/.env. Everything else a
	// person, the model or git can see is searched for it after a full run.
	test("the typed password ends up in .heydb/.env and nowhere else", async () => {
		const password = "Zq9!leak#Pass 'w\"rd";
		const { introspect, passwords } = fakeIntrospect(live);
		const pi = loadHeydb({ introspect });
		const root = tempDir();
		initProject(root);
		const connect = fakeContext(root, { answers: answers(password) });
		await runCommand(pi, "heydb:connect", "", connect);
		const sync = fakeContext(root);
		await runCommand(pi, "heydb:sync", "", sync);
		annotate(root, "local", { target: "shop.shop.orders", text: "One per checkout.", author: "Ana" }, fixedClock());
		const list = fakeContext(root);
		await runCommand(pi, "heydb:connections", "", list);
		const again = fakeContext(root, { answers: [password] });
		await runCommand(pi, "heydb:password", "", again);

		assert.deepEqual(passwords, [password], "the engine got it, read back from .heydb/.env");
		const seen = JSON.stringify([
			[connect, sync, list, again].map((ctx) => [ctx.notifications, ctx.dialogs, ctx.screens]),
			pi.messages,
			loadKnowledge(root, "local"),
		]);
		assert.equal(seen.includes(password), false, "shown to a person or the model");
		const files = filesUnder(root);
		assert.ok(files.includes(".heydb/snapshots/local.json.gz"), "the search covers the snapshot");
		assert.ok(files.includes(".heydb/knowledge/local.json"), "the search covers the notes");
		for (const file of files) {
			const bytes = readFileSync(join(root, file));
			const found = (file.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8").includes(password);
			assert.equal(found, file === ".heydb/.env", file);
		}
	});
});

function filesUnder(root: string): string[] {
	return readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => relative(root, join(entry.parentPath, entry.name)).replaceAll("\\", "/"));
}

describe("/heydb:password", () => {
	const TITLE = "Password for local (stored in .heydb/.env, ignored by git; leave empty to keep it as it is)";

	test("asks for the default connection's password hidden and replaces it in .heydb/.env", async () => {
		const pi = loadHeydb();
		const root = project();
		writeFileSync(join(root, ".heydb", ".env"), "# mine\nHEYDB_LOCAL_PASSWORD=old\n");
		const ctx = fakeContext(root, { answers: ["n3w"] });
		await runCommand(pi, "heydb:password", "", ctx);
		assert.deepEqual(ctx.dialogs, [{ kind: "secret", title: TITLE, hint: SECRET_HINT }]);
		assert.equal(readFileSync(join(root, ".heydb", ".env"), "utf8"), "# mine\nHEYDB_LOCAL_PASSWORD=n3w\n");
		assert.deepEqual(ctx.notifications, [
			{
				message: 'Password for "local" saved in .heydb/.env as HEYDB_LOCAL_PASSWORD (ignored by git). Next: /heydb:sync local.',
				level: "info",
			},
		]);
		assert.doesNotMatch(ctx.screens.join("\n"), /n3w/);
	});

	test("uses the variable the connection names, for the connection in the arguments", async () => {
		const pi = loadHeydb({ env: { HEYDB_SHARED: "x" } });
		const root = project();
		saveConfig(root, {
			formatVersion: 1,
			defaultConnection: "local",
			connections: { local, prod: { ...local, password: "env:HEYDB_SHARED" } },
		});
		const ctx = fakeContext(root, { answers: ["p"] });
		await runCommand(pi, "heydb:password", " prod ", ctx);
		assert.equal(readFileSync(join(root, ".heydb", ".env"), "utf8"), "HEYDB_SHARED=p\n");
		assert.equal(
			ctx.notifications[0]?.message,
			'Password for "prod" saved in .heydb/.env as HEYDB_SHARED (ignored by git). Next: /heydb:sync prod.\n' +
				"Note: HEYDB_SHARED is also set in your environment, and that value wins over .heydb/.env.",
		);
	});

	test("an empty answer or escape changes nothing", async () => {
		const pi = loadHeydb();
		const root = project();
		const empty = fakeContext(root, { answers: [""] });
		await runCommand(pi, "heydb:password", "", empty);
		assert.deepEqual(empty.notifications, [{ message: 'Nothing changed: the password for "local" was left as it is.', level: "info" }]);
		const escape = fakeContext(root, { answers: [undefined] });
		await runCommand(pi, "heydb:password", "", escape);
		assert.deepEqual(escape.notifications, [{ message: "heydb:password cancelled; nothing was saved.", level: "info" }]);
		assert.equal(existsSync(join(root, ".heydb", ".env")), false);
	});

	test("without Pi's terminal, explains where to set the variable", async () => {
		for (const options of [{ mode: "rpc" as const }, { hasUI: false }]) {
			const pi = loadHeydb();
			const ctx = fakeContext(project(), { ...options, answers: ["unused"] });
			await runCommand(pi, "heydb:password", "", ctx);
			assert.deepEqual(ctx.dialogs, []);
			assert.deepEqual(ctx.notifications, [
				{
					message:
						"Typing a password needs Pi's interactive terminal. " +
						"Set HEYDB_LOCAL_PASSWORD in your shell or in .heydb/.env (ignored by git).",
					level: "info",
				},
			]);
		}
	});

	test("reports unknown connections, missing projects and extra arguments", async () => {
		const pi = loadHeydb();
		const root = project();
		const cases: [cwd: string, args: string, message: string][] = [
			[root, "qa", 'unknown connection "qa"; configured: local'],
			[root, "local extra", "Usage: /heydb:password [connection]"],
			[tempDir(), "", "No heydb project here: run /heydb:init first."],
		];
		for (const [cwd, args, message] of cases) {
			const ctx = fakeContext(cwd, { answers: ["unused"] });
			await runCommand(pi, "heydb:password", args, ctx);
			assert.deepEqual(ctx.dialogs, []);
			assert.deepEqual(ctx.notifications, [{ message, level: "error" }]);
		}
	});
});

describe("/heydb:connections", () => {
	const prod = { ...local, host: "db.internal", user: "reader", password: "env:HEYDB_PROD_PASSWORD", databases: ["shop"] };

	function twoConnections(): string {
		const root = project();
		saveConfig(root, { formatVersion: 1, defaultConnection: "local", connections: { local, prod } });
		return root;
	}

	test("lists the connections, the default, whether each password is set and whether it was synced", async () => {
		const pi = loadHeydb({ env: { HEYDB_PROD_PASSWORD: "x" } });
		const root = twoConnections();
		writeFileSync(join(root, ".heydb", ".env"), "HEYDB_LOCAL_PASSWORD=s3cret\n");
		saveSnapshot(root, "local", live);
		for (const args of ["", " list "]) {
			const ctx = fakeContext(root);
			await runCommand(pi, "heydb:connections", args, ctx);
			assert.deepEqual(ctx.notifications, [
				{
					message:
						`heydb connections in ${root}:\n` +
						"- local (default): mysql root@127.0.0.1:3306, all databases · password HEYDB_LOCAL_PASSWORD: in .heydb/.env · synced\n" +
						"- prod: mysql reader@db.internal:3306, databases shop · password HEYDB_PROD_PASSWORD: set in your environment · never synced\n" +
						"No git repository here: notes in .heydb/knowledge/ stay on this machine.\n" +
						"Change the default with /heydb:connections use <name>; set a password with /heydb:password <name>.",
					level: "info",
				},
			]);
		}
	});

	test("says once whether git shares the notes", { skip: spawnSync("git", ["--version"]).error !== undefined && "git is not installed" }, async () => {
		const pi = loadHeydb();
		const root = twoConnections();
		execFileSync("git", ["init", "-q"], { cwd: root });
		writeFileSync(join(root, ".gitignore"), ".heydb/\n");
		const ignored = fakeContext(root);
		await runCommand(pi, "heydb:connections", "", ignored);
		const lines = (ignored.notifications[0]?.message ?? "").split("\n");
		assert.deepEqual(
			lines.filter((line) => line.includes("git")),
			[
				"Notes in .heydb/knowledge/ are ignored by git (.gitignore:1: .heydb/), so the team will not get them. " +
					"To share notes, commit .heydb/config.json, .heydb/snapshots/ and .heydb/knowledge/ (never .heydb/.env).",
			],
		);
		writeFileSync(join(root, ".gitignore"), "");
		const shared = fakeContext(root);
		await runCommand(pi, "heydb:connections", "", shared);
		assert.match(shared.notifications[0]?.message ?? "", /^Notes in \.heydb\/knowledge\/ are visible to git: the team gets them once they are committed\.$/m);
	});

	test("shows a missing or unreadable password without failing", async () => {
		const pi = loadHeydb();
		const root = project();
		const missing = fakeContext(root);
		await runCommand(pi, "heydb:connections", "", missing);
		assert.match(missing.notifications[0]?.message ?? "", /password HEYDB_LOCAL_PASSWORD: not set · never synced/);
		writeFileSync(join(root, ".heydb", ".env"), "broken s3cret\n");
		const unreadable = fakeContext(root);
		await runCommand(pi, "heydb:connections", "", unreadable);
		assert.match(unreadable.notifications[0]?.message ?? "", /password HEYDB_LOCAL_PASSWORD: \.heydb\/\.env is unreadable · never synced/);
		assert.doesNotMatch(unreadable.notifications[0]?.message ?? "", /s3cret/);
	});

	test("use makes a connection the default", async () => {
		const pi = loadHeydb();
		const root = twoConnections();
		const ctx = fakeContext(root);
		await runCommand(pi, "heydb:connections", "use prod", ctx);
		assert.equal(loadConfig(root).defaultConnection, "prod");
		assert.deepEqual(ctx.notifications, [{ message: 'Default connection is now "prod".', level: "info" }]);
	});

	test("remove asks first, then drops the entry and its password, and keeps snapshot and notes on disk", async () => {
		const pi = loadHeydb();
		const root = twoConnections();
		writeFileSync(join(root, ".heydb", ".env"), "HEYDB_LOCAL_PASSWORD=a\nHEYDB_PROD_PASSWORD=b\n");
		saveSnapshot(root, "prod", live);
		annotate(root, "prod", { target: "shop.shop.orders", text: "One per checkout.", author: "Ana" }, fixedClock());

		const ctx = fakeContext(root, { answers: ["yes"] });
		await runCommand(pi, "heydb:connections", "remove prod", ctx);
		assert.deepEqual(ctx.dialogs, [
			{
				kind: "confirm",
				title: 'Remove connection "prod"?',
				hint: "It is removed from .heydb/config.json and its password from .heydb/.env. Its snapshot and notes stay on disk.",
			},
		]);
		assert.deepEqual(Object.keys(loadConfig(root).connections), ["local"]);
		assert.equal(readFileSync(join(root, ".heydb", ".env"), "utf8"), "HEYDB_LOCAL_PASSWORD=a\n");
		assert.ok(existsSync(join(root, ".heydb", "snapshots", "prod.json.gz")));
		assert.equal(loadKnowledge(root, "prod").annotations.length, 1);
		assert.deepEqual(ctx.notifications, [
			{
				message:
					'Removed connection "prod" and its password line in .heydb/.env.\n' +
					"Kept on disk, so no notes are lost: .heydb/snapshots/prod.json.gz, .heydb/knowledge/prod.json. " +
					"Delete them yourself if you no longer need them.",
				level: "info",
			},
		]);
	});

	test("remove changes nothing unless confirmed, and needs a UI to confirm", async () => {
		const pi = loadHeydb();
		const root = twoConnections();
		const before = readFileSync(join(root, ".heydb", "config.json"), "utf8");
		const declined = fakeContext(root, { answers: ["no"] });
		await runCommand(pi, "heydb:connections", "remove prod", declined);
		assert.deepEqual(declined.notifications, [
			{ message: "heydb:connections remove cancelled; nothing was changed.", level: "info" },
		]);
		const headless = fakeContext(root, { hasUI: false });
		await runCommand(pi, "heydb:connections", "remove prod", headless);
		assert.deepEqual(headless.notifications, [
			{
				message: "Removing a connection needs an interactive session to confirm it; edit .heydb/config.json instead.",
				level: "error",
			},
		]);
		assert.equal(readFileSync(join(root, ".heydb", "config.json"), "utf8"), before);
	});

	test("reports unknown names, wrong arguments and missing projects", async () => {
		const pi = loadHeydb();
		const root = twoConnections();
		const usage = "Usage: /heydb:connections [list | use <name> | remove <name>]";
		const empty = tempDir();
		initProject(empty);
		const cases: [cwd: string, args: string, message: string][] = [
			[root, "use qa", 'unknown connection "qa"; configured: local, prod'],
			[root, "remove qa", 'unknown connection "qa"; configured: local, prod'],
			[root, "use", usage],
			[root, "use local prod", usage],
			[root, "list all", usage],
			[root, "delete prod", usage],
			[tempDir(), "", "No heydb project here: run /heydb:init first."],
			[empty, "", "No connections yet: run /heydb:connect first."],
		];
		for (const [cwd, args, message] of cases) {
			const ctx = fakeContext(cwd, { answers: ["yes"] });
			await runCommand(pi, "heydb:connections", args, ctx);
			assert.deepEqual(ctx.notifications, [{ message, level: "error" }], args);
			assert.deepEqual(ctx.dialogs, []);
		}
		assert.deepEqual(Object.keys(loadConfig(root).connections), ["local", "prod"]);
	});
});

describe("extra arguments", () => {
	test("/heydb:sync and /heydb:status take one connection at most and never connect otherwise", async () => {
		let connected = false;
		const pi = loadHeydb({
			env: { HEYDB_LOCAL_PASSWORD: "x" },
			introspect: async () => {
				connected = true;
				return live;
			},
		});
		const root = project();
		for (const name of ["sync", "status"]) {
			const ctx = fakeContext(root);
			await runCommand(pi, `heydb:${name}`, "local prod", ctx);
			assert.deepEqual(ctx.notifications, [{ message: `Usage: /heydb:${name} [connection]`, level: "error" }]);
		}
		assert.equal(connected, false);
	});
});

describe("/heydb:sync", () => {
	test("shows what it is doing while it reads the database, and clears it afterwards", async () => {
		const seen: (string | undefined)[] = [];
		const seenWidgets: (string[] | undefined)[] = [];
		let ctx: ReturnType<typeof fakeContext> | undefined;
		const pi = loadHeydb({
			introspect: async () => {
				seen.push(ctx?.statuses.get("heydb"));
				seenWidgets.push(ctx?.widgets.get("heydb"));
				return live;
			},
			env: { HEYDB_LOCAL_PASSWORD: "s3cret" },
		});
		ctx = fakeContext(project());
		await runCommand(pi, "heydb:sync", "", ctx);

		assert.equal(seen.length, 1);
		assert.match(seen[0] ?? "", /^heydb: syncing local · reading the structure of [^ ]+:\d+…$/);
		// The footer may be too narrow to show it (Gentle Shell keeps one status row in a
		// narrow split), so the same text also goes above the editor, with the seconds.
		assert.match(seenWidgets[0]?.join("\n") ?? "", /^heydb: syncing local · reading the structure of [^ ]+:\d+… \(0s\)$/);
		assert.equal(ctx.statuses.get("heydb"), undefined, "cleared when done");
		assert.equal(ctx.widgets.get("heydb"), undefined, "widget removed when done");
	});

	test("clears the progress status when the database cannot be read", async () => {
		const pi = loadHeydb({
			introspect: async () => {
				throw new Error("connect ECONNREFUSED");
			},
			env: { HEYDB_LOCAL_PASSWORD: "s3cret" },
		});
		const ctx = fakeContext(project());
		await runCommand(pi, "heydb:sync", "", ctx);
		assert.equal(ctx.statuses.has("heydb"), true, "a status was shown");
		assert.equal(ctx.statuses.get("heydb"), undefined, "and cleared after the error");
		assert.equal(ctx.widgets.get("heydb"), undefined, "widget removed after the error");
	});

	test("captures the live schema with the resolved password and reports the first sync", async () => {
		const { introspect, passwords } = fakeIntrospect(live);
		const pi = loadHeydb({ introspect, env: { HEYDB_LOCAL_PASSWORD: "s3cret" } });
		const root = project();
		const ctx = fakeContext(root);
		await runCommand(pi, "heydb:sync", "", ctx);

		assert.deepEqual(passwords, ["s3cret"]);
		assert.deepEqual(loadSnapshot(root, "local"), live);
		assert.deepEqual(ctx.notifications, [
			{ message: `heydb sync local: snapshot written · 1 database, 2 tables · 1 warning · 1 change.${NO_CODE}`, level: "info" },
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
			{ message: `heydb sync local: unchanged · 1 database, 2 tables · 1 warning.${NO_CODE}`, level: "info" },
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
		assert.equal(ctx.notifications[0]?.message, `heydb sync prod: snapshot written · 1 database, 2 tables · 1 change.${NO_CODE}`);
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
			order.push(`${name} ${ctx.notifications[0]?.message.split("\n")[0]?.split(":")[1]?.trim()}`);
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
				"- removed table shop.orders\n\nRun /heydb:sync local to store it.",
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
		for (const name of ["heydb:sync", "heydb:status", "heydb:password", "heydb:learn-code"]) {
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

	test("completes /heydb:connections subcommands, then connection names", async () => {
		const root = project();
		saveConfig(root, {
			formatVersion: 1,
			defaultConnection: "local",
			connections: { local, prod: { ...local, password: "env:HEYDB_PROD_PASSWORD" } },
		});
		const complete = loadHeydb({ cwd: () => root }).commands.get("heydb:connections")?.getArgumentCompletions;
		assert.ok(complete);
		assert.deepEqual(await complete(""), [
			{ value: "list", label: "list" },
			{ value: "use ", label: "use" },
			{ value: "remove ", label: "remove" },
		]);
		assert.deepEqual(await complete("r"), [{ value: "remove ", label: "remove" }]);
		// Pi replaces everything typed after the command, so each value repeats the subcommand.
		assert.deepEqual(await complete("use "), [
			{ value: "use local", label: "local" },
			{ value: "use prod", label: "prod" },
		]);
		assert.deepEqual(await complete("remove p"), [{ value: "remove prod", label: "prod" }]);
		assert.equal(await complete("list "), null);
		assert.equal(await complete("use prod "), null);
		assert.equal(await complete("x"), null);
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

/** Writes `files` (path → content) into the project at `root`. */
function writeCode(root: string, files: Record<string, string>): void {
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
}

const CODE = {
	"src/Models/Customer.php": "class Customer extends Model { protected $table = 'customers'; }\n",
	"src/Repo/orders.sql": "SELECT * FROM orders JOIN customers ON customers.id = orders.customer_id\n",
	"vendor/acme/Orders.php": "orders orders orders",
};

const LEARN_TITLE = "Learn from this project's code?";
const LEARN_BODY =
	"Found 2 files that use 2 tables (e.g. customers, orders). " +
	"heydb can ask the agent to read them and save notes about what the code shows. It will use tokens.";
const LANGUAGE_RULE =
	"- Answer the user and write the notes in the language the user uses in this conversation (Spanish if they write Spanish); " +
	"keep table and column names as they are.";
const LEARN_FILES =
	"Tables, the ones that most need a note first, with the code that uses them and the docs that define them:\n" +
	"- shop.customers (2 uses): src/Models/Customer.php, src/Repo/orders.sql\n" +
	"- shop.orders (1 use): src/Repo/orders.sql\n\n";
const LEARN_RULES =
	"Rules:\n" +
	`${LANGUAGE_RULE}\n` +
	"- Go down the list. For each table read heydb_table and its files (models, repositories, queries, docs); skip what its comment and notes already say.\n" +
	"- Save one heydb_annotate note per table: what it holds in business words, with the other words people use for it " +
	"(synonyms, both languages when the team mixes them), like \"Customer master (clientes, customers): one row per customer\". " +
	"heydb_search finds tables by those words.\n" +
	"- Add valid values, enums and magic numbers with their meaning, units or soft-delete flags only when the code states them. " +
	"Record joins the code makes without a foreign key with heydb_relate.\n" +
	'- End every note with its source, like "(code: src/Models/Customer.php)".\n' +
	"- Never invent or guess: what the code or docs do not make explicit is not saved; ask the user about it.\n" +
	"- At most one note per table in the list: a table the code or docs do not explain is a question for the user, not a note.\n" +
	"- Finish with a short summary for the user: what you saved, and what remains unclear, as questions.\n" +
	"- Then tell the user, in one line, that the code has been fully covered: every table it uses or defines is in this list or already described.";
const LEARN_MESSAGE =
	'heydb: the user agreed that you learn about the database of connection "local" from this project\'s code.\n\n' +
	LEARN_FILES +
	LEARN_RULES;

describe("learning from code", () => {
	function codeProject(): string {
		const root = project();
		writeCode(root, CODE);
		return root;
	}

	test("after a sync, offers to read the code that uses the tables and, if accepted, starts one agent turn", async () => {
		const pi = loadHeydb({ introspect: fakeIntrospect(live).introspect, env: { HEYDB_LOCAL_PASSWORD: "x" } });
		const root = codeProject();
		saveSnapshot(root, "local", live);
		const ctx = fakeContext(root, { answers: ["yes"] });
		await runCommand(pi, "heydb:sync", "", ctx);

		assert.deepEqual(ctx.dialogs, [{ kind: "confirm", title: LEARN_TITLE, hint: LEARN_BODY }]);
		assert.deepEqual(ctx.notifications, [
			{ message: "heydb sync local: unchanged · 1 database, 2 tables · 1 warning.", level: "info" },
			{ message: "Asked the agent to read the code and note what it shows.", level: "info" },
		]);
		assert.deepEqual(pi.messages, [
			{
				message: { customType: "heydb", content: LEARN_MESSAGE, display: true },
				options: { triggerTurn: true, deliverAs: "followUp" },
			},
		]);
	});

	// Rounds: one note per listed table, then the next run lists the next tables (noted ones go last).
	test("asks for one note per listed table and says how many tables still need one and how to cover them", () => {
		const usage: SchemaUsage = {
			hasCode: true,
			filesScanned: 1,
			docsScanned: 0,
			filesMatched: 1,
			tablesMatched: 42,
			matches: [{ table: "shop.cst", name: "cst", files: ["src/a.sql"], hits: 1, docs: [], described: "nothing", cryptic: true, referenced: 0 }],
			remaining: 12,
			truncated: false,
		};
		const message = learnMessage("erp", usage);
		assert.ok(!message.includes("about 20"), message);
		assert.ok(message.includes("\n- At most one note per table in the list: a table the code or docs do not explain is a question for the user, not a note.\n"), message);
		assert.ok(
			message.endsWith(
				"\n- Then tell the user, in one line, that 12 more tables in the code still need a note and that running /heydb:learn-code erp again covers the next ones.",
			),
			message,
		);
		const one = learnMessage("erp", { ...usage, remaining: 1 }, { root: "/srv/legacy", typed: "../legacy" });
		assert.ok(one.endsWith("that 1 more table in the code still needs a note and that running /heydb:learn-code erp ../legacy again covers the next ones."), one);
		const done = learnMessage("erp", { ...usage, remaining: 0 });
		assert.ok(
			done.endsWith("\n- Then tell the user, in one line, that the code has been fully covered: every table it uses or defines is in this list or already described."),
			done,
		);
	});

	test("comes after the message with the changes when the sync wrote the snapshot", async () => {
		const pi = loadHeydb({ introspect: fakeIntrospect(live).introspect, env: { HEYDB_LOCAL_PASSWORD: "x" } });
		const ctx = fakeContext(codeProject(), { answers: ["yes"] });
		await runCommand(pi, "heydb:sync", "", ctx);
		assert.equal(pi.messages.length, 2);
		assert.match(String(pi.messages[0]?.message.content), /^heydb sync local changed the stored snapshot/);
		assert.equal(pi.messages[1]?.message.content, LEARN_MESSAGE);
	});

	test("declined, sends nothing and says how to do it later", async () => {
		const pi = loadHeydb({ introspect: fakeIntrospect(live).introspect, env: { HEYDB_LOCAL_PASSWORD: "x" } });
		const root = codeProject();
		saveSnapshot(root, "local", live);
		const ctx = fakeContext(root, { answers: ["no"] });
		await runCommand(pi, "heydb:sync", "", ctx);
		assert.equal(ctx.dialogs.length, 1);
		assert.deepEqual(pi.messages, []);
		assert.deepEqual(ctx.notifications[1], {
			message: "Nothing was sent. Run /heydb:learn-code local whenever you want the agent to read it.",
			level: "info",
		});
	});

	test("while the agent is working, the request waits for it to finish", async () => {
		const pi = loadHeydb({ introspect: fakeIntrospect(live).introspect, env: { HEYDB_LOCAL_PASSWORD: "x" } });
		const root = codeProject();
		saveSnapshot(root, "local", live);
		const ctx = fakeContext(root, { answers: ["yes"], idle: false });
		await runCommand(pi, "heydb:sync", "", ctx);
		assert.deepEqual(pi.messages[0]?.options, { triggerTurn: true, deliverAs: "followUp" });
		assert.deepEqual(ctx.notifications[1], {
			message: "The agent is busy: it will read the code and note what it shows when it finishes its current work.",
			level: "info",
		});
	});

	test("without code that uses the tables, asks nothing and says notes will come from conversations", async () => {
		const pi = loadHeydb({ introspect: fakeIntrospect(live).introspect, env: { HEYDB_LOCAL_PASSWORD: "x" } });
		const root = project();
		saveSnapshot(root, "local", live);
		writeCode(root, { "src/app.ts": "export const answer = 42;\n", "vendor/x/Orders.php": "orders" });
		const ctx = fakeContext(root, { answers: ["yes"] });
		await runCommand(pi, "heydb:sync", "", ctx);
		assert.deepEqual(ctx.dialogs, []);
		assert.deepEqual(ctx.notifications, [{ message: `heydb sync local: unchanged · 1 database, 2 tables · 1 warning.${NO_CODE}`, level: "info" }]);
		assert.deepEqual(pi.messages, []);
	});

	test("without an interactive session, a sync asks nothing and sends nothing", async () => {
		const pi = loadHeydb({ introspect: fakeIntrospect(live).introspect, env: { HEYDB_LOCAL_PASSWORD: "x" } });
		const root = codeProject();
		saveSnapshot(root, "local", live);
		const ctx = fakeContext(root, { hasUI: false, answers: ["yes"] });
		await runCommand(pi, "heydb:sync", "", ctx);
		assert.deepEqual(ctx.dialogs, []);
		assert.deepEqual(ctx.notifications, [{ message: "heydb sync local: unchanged · 1 database, 2 tables · 1 warning.", level: "info" }]);
		assert.deepEqual(pi.messages, []);
	});

	test("/heydb:learn-code offers the same from the stored snapshot, without connecting", async () => {
		const pi = loadHeydb({
			introspect: async () => {
				throw new Error("must not connect");
			},
		});
		const root = codeProject();
		saveSnapshot(root, "local", live);
		const ctx = fakeContext(root, { answers: ["yes"] });
		await runCommand(pi, "heydb:learn-code", " local ", ctx);
		assert.deepEqual(ctx.dialogs, [{ kind: "confirm", title: LEARN_TITLE, hint: LEARN_BODY }]);
		assert.deepEqual(ctx.notifications, [{ message: "Asked the agent to read the code and note what it shows.", level: "info" }]);
		assert.deepEqual(pi.messages, [
			{
				message: { customType: "heydb", content: LEARN_MESSAGE, display: true },
				options: { triggerTurn: true, deliverAs: "followUp" },
			},
		]);
	});

	test("/heydb:learn-code says when there is no code, no UI, no snapshot or too many arguments", async () => {
		const pi = loadHeydb();
		const empty = project();
		saveSnapshot(empty, "local", live);
		const none = fakeContext(empty);
		await runCommand(pi, "heydb:learn-code", "", none);
		assert.deepEqual(none.notifications, [{ message: `heydb learn-code local: ${NO_CODE.trim()}`, level: "info" }]);

		const code = codeProject();
		saveSnapshot(code, "local", live);
		const headless = fakeContext(code, { hasUI: false });
		await runCommand(pi, "heydb:learn-code", "", headless);
		assert.deepEqual(headless.notifications, [
			{ message: "/heydb:learn-code needs an interactive session to ask before the agent spends tokens.", level: "error" },
		]);

		const unsynced = fakeContext(codeProject());
		await runCommand(pi, "heydb:learn-code", "", unsynced);
		assert.deepEqual(unsynced.notifications, [{ message: 'Connection "local" was never synced: run /heydb:sync local.', level: "error" }]);

		const extra = fakeContext(code);
		await runCommand(pi, "heydb:learn-code", "local . prod", extra);
		assert.deepEqual(extra.notifications, [{ message: "Usage: /heydb:learn-code [connection] [path]", level: "error" }]);
		assert.deepEqual(pi.messages, []);
	});

	test("the agent is told first to answer and write the notes in the user's language", async () => {
		const pi = loadHeydb();
		const root = codeProject();
		saveSnapshot(root, "local", live);
		await runCommand(pi, "heydb:learn-code", "", fakeContext(root, { answers: ["yes"] }));
		const content = String(pi.messages[0]?.message.content);
		assert.ok(content.includes(`Rules:\n${LANGUAGE_RULE}\n`), content);
	});

	test("lists first the tables that most need a note, marks the described ones and cites the docs that define a table", async () => {
		const pi = loadHeydb();
		const root = project();
		writeCode(root, { ...CODE, "docs/tables.md": "- `orders`: one row per order\n", "docs/intro.md": "We keep orders and customers.\n" });
		saveSnapshot(root, "local", live);
		annotate(root, "local", { target: "shop.shop.customers", text: "Customer master (clientes)", author: "Ana" }, fixedClock());
		const ctx = fakeContext(root, { answers: ["yes"] });
		await runCommand(pi, "heydb:learn-code", "", ctx);
		assert.deepEqual(ctx.dialogs, [
			{
				kind: "confirm",
				title: LEARN_TITLE,
				hint: "Found 3 files that use 2 tables (e.g. orders, customers). heydb can ask the agent to read them and save notes about what the code shows. It will use tokens.",
			},
		]);
		const content = String(pi.messages[0]?.message.content);
		assert.ok(
			content.includes(
				"- shop.orders (1 use): src/Repo/orders.sql; docs: docs/tables.md\n" +
					"- shop.customers (2 uses, has a note): src/Models/Customer.php, src/Repo/orders.sql\n",
			),
			content,
		);
		assert.ok(content.includes('- End every note with its source, like "(code: src/Repo/orders.sql)" or "(docs: docs/tables.md)".\n'), content);
		assert.ok(content.includes("in business words, with the other words people use for it (synonyms,"), content);
		assert.ok(content.includes("- Never invent or guess:"), content);
	});

	test("field case: ordinary-word tables named only in lockfiles, CI, comments and help text are no code", async () => {
		const words = snapshot(["para", "destino", "config", "project"].map((name) => ({ ...customersTable(), name })));
		const pi = loadHeydb({ introspect: fakeIntrospect(words).introspect, env: { HEYDB_LOCAL_PASSWORD: "x" } });
		const root = project();
		saveSnapshot(root, "local", words);
		writeCode(root, {
			"pnpm-lock.yaml": "packages:\n  config@1.0.0: {}\n  project@2.0.0: {}\n",
			"src/cli.ts": 'export const HELP = "Usa --help para ver los comandos";\n',
			"src/git.ts": "// rama destino: la rama sobre la que se fusiona\n",
			".gitlab/ci/node.yml": "script:\n  - pnpm config set store-dir .pnpm-store\n",
		});
		const ctx = fakeContext(root, { answers: ["yes"] });
		await runCommand(pi, "heydb:sync", "", ctx);
		assert.deepEqual(ctx.dialogs, []);
		assert.deepEqual(ctx.notifications, [{ message: `heydb sync local: unchanged · 1 database, 4 tables.${NO_CODE}`, level: "info" }]);
		assert.deepEqual(pi.messages, []);
	});

	test("/heydb:learn-code [connection] [path] scans another folder and names it", async () => {
		const root = project();
		saveSnapshot(root, "local", live);
		const other = tempDir();
		writeCode(other, CODE);
		const folder = realpathSync(other);
		const typed = relative(root, other).split("\\").join("/");
		for (const args of [`local ${typed}`, typed, folder]) {
			const pi = loadHeydb();
			const ctx = fakeContext(root, { answers: ["yes"] });
			await runCommand(pi, "heydb:learn-code", args, ctx);
			assert.deepEqual(
				ctx.dialogs,
				[
					{
						kind: "confirm",
						title: LEARN_TITLE,
						hint:
							`Found 2 files in ${folder} that use 2 tables (e.g. customers, orders). ` +
							"heydb can ask the agent to read them and save notes about what the code shows. It will use tokens.",
					},
				],
				args,
			);
			assert.equal(
				pi.messages[0]?.message.content,
				`heydb: the user agreed that you learn about the database of connection "local" from the code in ${folder}. ` +
					"File paths below are relative to that folder.\n\n" +
					LEARN_FILES +
					LEARN_RULES,
				args,
			);
		}

		const pi = loadHeydb();
		const declined = fakeContext(root, { answers: ["no"] });
		await runCommand(pi, "heydb:learn-code", typed, declined);
		assert.deepEqual(declined.notifications, [
			{ message: `Nothing was sent. Run /heydb:learn-code local ${typed} whenever you want the agent to read it.`, level: "info" },
		]);
	});

	test("/heydb:learn-code never follows a symbolic link out of the scanned folder", async () => {
		const root = project();
		saveSnapshot(root, "local", live);
		const outside = tempDir();
		writeCode(outside, CODE);
		mkdirSync(join(root, "src"));
		symlinkSync(join(outside, "src"), join(root, "src", "linked"), "dir");
		symlinkSync(join(outside, "src", "Repo", "orders.sql"), join(root, "orders.sql"));
		const pi = loadHeydb();
		const ctx = fakeContext(root, { answers: ["yes"] });
		await runCommand(pi, "heydb:learn-code", "local .", ctx);
		assert.deepEqual(ctx.notifications, [{ message: `heydb learn-code local: ${NO_CODE.trim()}`, level: "info" }]);
		assert.deepEqual(pi.messages, []);
	});

	test("/heydb:learn-code says when the path is missing or not a folder", async () => {
		const root = codeProject();
		saveSnapshot(root, "local", live);
		const pi = loadHeydb();
		const cases: [string, string][] = [
			["local ../nowhere", 'Folder "../nowhere" does not exist.'],
			["local src/Repo/orders.sql", '"src/Repo/orders.sql" is not a folder.'],
			// One argument that is neither a connection nor a folder is a connection name.
			["nowhere", 'unknown connection "nowhere"'],
		];
		for (const [args, message] of cases) {
			const ctx = fakeContext(root);
			await runCommand(pi, "heydb:learn-code", args, ctx);
			assert.equal(ctx.notifications[0]?.level, "error", args);
			assert.match(ctx.notifications[0]?.message ?? "", new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), args);
		}
		assert.deepEqual(pi.messages, []);
	});
});
