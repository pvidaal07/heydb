import assert from "node:assert/strict";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { loadKnowledge } from "../../lib/store/knowledge.ts";
import { customersTable, ordersTable, snapshot } from "../fixtures/snapshot.ts";
import { fakeContext, fakeIntrospect, loadHeydb, runCommand, runTool, tempDirs } from "./fake-pi.ts";

const tempDir = tempDirs("heydb-e2e-");

// The whole journey through the extension only, as a person and an agent
// would take it: no database (the engine is a fake) and no Pi.
test("init → connect → sync → overview, table, search and annotate via tools", async () => {
	const root = tempDir();
	const app = join(root, "app");
	mkdirSync(app);
	const live = snapshot([customersTable(), ordersTable()]);
	const { introspect, passwords } = fakeIntrospect(live);
	const pi = loadHeydb({ introspect });

	const init = fakeContext(root);
	await runCommand(pi, "heydb:init", "", init);
	assert.match(init.notifications[0]?.message ?? "", /^heydb project ready/);

	// The password is typed once, in the masked input, and read back by the sync.
	const connect = fakeContext(app, { answers: ["local", "mysql", "", "", "root", "shop", "typed pass"] });
	await runCommand(pi, "heydb:connect", "", connect);
	assert.match(connect.notifications[0]?.message ?? "", /Password saved in \.heydb\/\.env as HEYDB_LOCAL_PASSWORD/);

	const sync = fakeContext(app);
	await runCommand(pi, "heydb:sync", "", sync);
	assert.equal(sync.notifications[0]?.level, "info");
	assert.deepEqual(passwords, ["typed pass"]);
	assert.deepEqual(readdirSync(join(root, ".heydb", "snapshots")), ["local.json.gz"], "the shared copy is compressed");

	const overview = await runTool(pi, "heydb_overview", {}, app);
	assert.equal(overview.isError, false);
	assert.match(overview.text, /^# heydb · local/);
	assert.match(overview.text, /\| shop\.orders \| table \|/);

	const annotated = await runTool(pi, "heydb_annotate", { target: "orders.total", text: "Includes VAT, in euros." }, app);
	assert.equal(annotated.isError, false);

	// What the tools print is accepted back: the short name from the overview.
	const table = await runTool(pi, "heydb_table", { table: "shop.orders" }, app);
	assert.match(table.text, /^# table shop\.orders\n/);
	assert.match(table.text, /Includes VAT, in euros\. \[id id-001 · Ana \(via agent\) · 2026-11-06\]/);

	const search = await runTool(pi, "heydb_search", { query: "euros" }, app);
	assert.equal(search.text, '1 match.\n- table shop.orders · columns: total "Includes VAT, in euros."');

	assert.equal(loadKnowledge(root, "local").annotations[0]?.author, "Ana (via agent)");
});
