import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { saveConfig } from "../../lib/config/store.ts";
import { initProject } from "../../lib/usecases/init.ts";
import { loadHeydb, tempDirs } from "./fake-pi.ts";

const tempDir = tempDirs("heydb-context-");

const entry = {
	engine: "mysql" as const,
	host: "127.0.0.1",
	port: 3306,
	user: "root",
	password: "env:HEYDB_LOCAL_PASSWORD",
	databases: null,
};

/** Runs the before_agent_start handlers like Pi does and returns the custom prompt sections. */
async function promptSections(cwd: string): Promise<Record<string, string>> {
	const pi = loadHeydb();
	const handlers = pi.handlers.get("before_agent_start") ?? [];
	assert.equal(handlers.length, 1);
	const sections: Record<string, string> = {};
	const event = { type: "before_agent_start", messageType: "user", prompt: "hi", systemPrompt: "", systemPromptOptions: { sections, cwd } };
	for (const handler of handlers) assert.equal(await handler(event, { cwd }), undefined, "the handler never replaces the prompt");
	return sections;
}

test("adds one short line about heydb inside a project with connections", async () => {
	const root = tempDir();
	initProject(root);
	saveConfig(root, {
		formatVersion: 1,
		defaultConnection: "prod",
		connections: { prod: { ...entry, password: "env:HEYDB_PROD_PASSWORD" }, local: entry },
	});
	const nested = join(root, "src");
	mkdirSync(nested);
	assert.deepEqual(await promptSections(nested), {
		heydb:
			"This project has a heydb schema snapshot (connections: local, prod). " +
			"Before writing SQL, find tables with heydb_search and check them with heydb_table; heydb_overview maps an unknown schema.",
	});
});

test("adds nothing outside a project, without connections, or with a broken config", async () => {
	assert.deepEqual(await promptSections(tempDir()), {});

	const empty = tempDir();
	initProject(empty);
	assert.deepEqual(await promptSections(empty), {});

	const broken = tempDir();
	initProject(broken);
	writeFileSync(join(broken, ".heydb", "config.json"), "{");
	assert.deepEqual(await promptSections(broken), {});
});
