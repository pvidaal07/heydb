import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import { saveConfig } from "../../lib/config/store.ts";
import { knowledgeForTable } from "../../lib/knowledge/query.ts";
import { incomingReferences } from "../../lib/model/references.ts";
import { renderOverview, renderSearch, renderTable } from "../../lib/render/markdown.ts";
import { searchSchema } from "../../lib/search.ts";
import { loadKnowledge } from "../../lib/store/knowledge.ts";
import { saveSnapshot } from "../../lib/store/snapshots.ts";
import { initProject } from "../../lib/usecases/init.ts";
import { annotate, relate } from "../../lib/usecases/knowledge.ts";
import { fixedClock } from "../knowledge/fixtures.ts";
import { column, customersTable, ordersTable, snapshot } from "../fixtures/snapshot.ts";
import { loadHeydb, runTool, tempDirs } from "./fake-pi.ts";

const tempDir = tempDirs("heydb-tools-");

const noGit = spawnSync("git", ["--version"]).error !== undefined && "git is not installed";

const TOOLS = [
	"heydb_overview",
	"heydb_table",
	"heydb_search",
	"heydb_annotate",
	"heydb_relate",
	"heydb_edit_note",
	"heydb_forget",
];

const stored = snapshot([customersTable(), ordersTable({ comment: "One row per checkout." })]);

const local = {
	engine: "mysql" as const,
	host: "127.0.0.1",
	port: 3306,
	user: "root",
	password: "env:HEYDB_LOCAL_PASSWORD",
	databases: null,
};

/** A project with one connection, "local"; synced unless told otherwise. */
function project({ synced = true } = {}): string {
	const root = tempDir();
	initProject(root);
	saveConfig(root, { formatVersion: 1, defaultConnection: "local", connections: { local } });
	if (synced) saveSnapshot(root, "local", stored);
	return root;
}

describe("tool registration", () => {
	test("registers every heydb tool, sequential, with an object JSON Schema", () => {
		const pi = loadHeydb();
		assert.deepEqual([...pi.tools.keys()], TOOLS);
		for (const tool of pi.tools.values()) {
			assert.equal(tool.executionMode, "sequential", tool.name);
			assert.equal((tool.parameters as { type?: string }).type, "object", tool.name);
			assert.ok(tool.description.length <= 200, `${tool.name} description stays short`);
			assert.ok(tool.promptSnippet, `${tool.name} has a prompt snippet`);
		}
	});

	test("no description claims notes are shared by themselves", () => {
		const pi = loadHeydb();
		const texts = [...pi.tools.values()].flatMap((tool) => [tool.description, tool.promptSnippet ?? "", ...(tool.promptGuidelines ?? [])]);
		for (const text of texts) assert.doesNotMatch(text, /committed/i, text);
		assert.match(pi.tools.get("heydb_annotate")?.description ?? "", /\.heydb\/knowledge.*commits \.heydb\//);
	});

	test("every prompt guideline names the tool it is about", () => {
		const pi = loadHeydb();
		const guidelines = [...pi.tools.values()].flatMap((tool) => tool.promptGuidelines ?? []);
		assert.ok(guidelines.length > 0);
		for (const line of guidelines) assert.match(line, /heydb_[a-z_]+/, line);
		const all = guidelines.join("\n");
		assert.match(all, /before writing/i);
		assert.match(all, /heydb_table header .* before concluding what a table is/);
		assert.match(all, /inference/);
		assert.match(all, /never invent/i);
		assert.match(all, /heydb_relate/);
	});

	test("heydb_annotate says where a note comes from: the code file, or the user", () => {
		const guidelines = (loadHeydb().tools.get("heydb_annotate")?.promptGuidelines ?? []).join("\n");
		assert.match(guidelines, /\(code: [^)]+\)/);
		assert.match(guidelines, /\(told by the user\)/);
		assert.match(guidelines, /inference.*confirm/i);
	});
});

describe("tools outside a usable project", () => {
	test("every tool says to run /heydb:init outside a project, as an error result", async () => {
		const pi = loadHeydb();
		const cwd = tempDir();
		for (const name of TOOLS) {
			const result = await runTool(pi, name, { table: "orders", query: "x", target: "x", text: "x", id: "x" }, cwd);
			assert.equal(result.isError, true, name);
			assert.equal(
				result.text,
				"No heydb project in this folder or above. Ask the user to run /heydb:init, then /heydb:connect and /heydb:sync.",
				name,
			);
		}
	});

	test("says to add a connection when the project has none", async () => {
		const pi = loadHeydb();
		const root = tempDir();
		initProject(root);
		const result = await runTool(pi, "heydb_overview", {}, root);
		assert.deepEqual(result, {
			isError: true,
			text: "This heydb project has no connections yet. Ask the user to run /heydb:connect, then /heydb:sync.",
		});
	});

	test("says to sync a connection that has no snapshot", async () => {
		const pi = loadHeydb();
		const root = project({ synced: false });
		for (const [name, params] of [
			["heydb_overview", {}],
			["heydb_table", { table: "orders" }],
			["heydb_search", { query: "orders" }],
			["heydb_annotate", { target: "orders", text: "x" }],
			["heydb_relate", { from_table: "orders", from_columns: ["customer_id"], to_table: "customers", to_columns: ["id"] }],
		] as const) {
			assert.deepEqual(
				await runTool(pi, name, params, root),
				{
					isError: true,
					text: 'Connection "local" was never synced, so there is no schema snapshot yet. Ask the user to run /heydb:sync local.',
				},
				name,
			);
		}
	});

	test("reports an unknown connection name with the configured ones", async () => {
		const pi = loadHeydb();
		const root = project();
		assert.deepEqual(await runTool(pi, "heydb_overview", { connection: "prod" }, root), {
			isError: true,
			text: 'unknown connection "prod"; configured: local',
		});
	});

	test("never connects to a database", async () => {
		let connected = false;
		const pi = loadHeydb({
			introspect: async () => {
				connected = true;
				return stored;
			},
		});
		const root = project();
		await runTool(pi, "heydb_overview", {}, root);
		await runTool(pi, "heydb_table", { table: "orders" }, root);
		await runTool(pi, "heydb_search", { query: "orders" }, root);
		await runTool(pi, "heydb_annotate", { target: "orders", text: "x" }, root);
		assert.equal(connected, false);
	});
});

describe("reading tools", () => {
	test("heydb_overview renders the stored snapshot with its notes, from a subfolder", async () => {
		const pi = loadHeydb();
		const root = project();
		annotate(root, "local", { target: "shop.shop.orders", text: "Paid orders only.", author: "bea" }, fixedClock());
		const nested = join(root, "src");
		mkdirSync(nested);

		const result = await runTool(pi, "heydb_overview", {}, nested);
		assert.deepEqual(result, {
			isError: false,
			text: renderOverview(stored, loadKnowledge(root, "local"), { connection: "local" }),
		});
		assert.match(result.text, /Paid orders only\./);
	});

	test("heydb_table renders a table with every note and relationship", async () => {
		const pi = loadHeydb();
		const root = project();
		const clock = fixedClock();
		annotate(root, "local", { target: "shop.shop.orders.total", text: "Includes VAT.", author: "bea" }, clock);
		const knowledge = loadKnowledge(root, "local");
		const table = stored.databases[0]?.schemas[0]?.tables[1];
		assert.equal(table?.name, "orders");

		for (const input of ["orders", "shop.orders", "shop.shop.orders", "Orders"]) {
			assert.deepEqual(
				await runTool(pi, "heydb_table", { table: input }, root),
				{
					isError: false,
					text: renderTable(
						table,
						"shop.shop.orders",
						knowledgeForTable(knowledge, "shop.shop.orders"),
						incomingReferences(stored, knowledge, "shop.shop.orders"),
					),
				},
				input,
			);
		}
	});

	test("heydb_table passes columns and column_filter, and rejects a bad columns value", async () => {
		const pi = loadHeydb();
		const root = project();
		const knowledge = loadKnowledge(root, "local");
		const table = stored.databases[0]?.schemas[0]?.tables[1];
		assert.ok(table !== undefined);
		const expected = (options: { columns?: "all" | number; columnFilter?: string }) =>
			renderTable(
				table,
				"shop.shop.orders",
				knowledgeForTable(knowledge, "shop.shop.orders"),
				incomingReferences(stored, knowledge, "shop.shop.orders"),
				options,
			);
		assert.deepEqual(await runTool(pi, "heydb_table", { table: "orders", columns: 1 }, root), { isError: false, text: expected({ columns: 1 }) });
		assert.deepEqual(await runTool(pi, "heydb_table", { table: "orders", columns: "all", column_filter: "tot" }, root), {
			isError: false,
			text: expected({ columns: "all", columnFilter: "tot" }),
		});
		assert.match(expected({ columns: 1 }), /## Columns \(1 of 3;/);
		for (const columns of [0, 2.5, "some"]) {
			assert.deepEqual(await runTool(pi, "heydb_table", { table: "orders", columns }, root), {
				isError: true,
				text: 'columns must be "all" or an integer of at least 1',
			});
		}
	});

	test("heydb_table answers an unknown table with a short error and suggestions", async () => {
		const pi = loadHeydb();
		const root = project();
		assert.deepEqual(await runTool(pi, "heydb_table", { table: "ordrs" }, root), {
			isError: true,
			text: 'no table matches "ordrs". Did you mean: shop.orders?',
		});
	});

	test("heydb_search ranks matches and honours the limit", async () => {
		const pi = loadHeydb();
		const root = project();
		const knowledge = loadKnowledge(root, "local");
		assert.deepEqual(await runTool(pi, "heydb_search", { query: "id" }, root), {
			isError: false,
			text: renderSearch(searchSchema(stored, knowledge, "id")),
		});
		assert.deepEqual(await runTool(pi, "heydb_search", { query: "id", limit: 1 }, root), {
			isError: false,
			text: renderSearch(searchSchema(stored, knowledge, "id", { limit: 1 })),
		});
		assert.match((await runTool(pi, "heydb_search", { query: "id", limit: 1 }, root)).text, /^Showing 1 of \d+ matches/);
	});

	test("heydb_search filters by database and refuses an unknown one", async () => {
		const pi = loadHeydb();
		const root = project();
		const knowledge = loadKnowledge(root, "local");
		assert.deepEqual(await runTool(pi, "heydb_search", { query: "orders", database: "shop" }, root), {
			isError: false,
			text: renderSearch(searchSchema(stored, knowledge, "orders", { database: "shop" })),
		});
		assert.deepEqual(await runTool(pi, "heydb_search", { query: "orders", database: "crm" }, root), {
			isError: true,
			text: 'no database matches "crm"; databases: shop',
		});
	});

	test("heydb_search says its results include inferred meanings", () => {
		const tool = loadHeydb().tools.get("heydb_search");
		const text = [tool?.description ?? "", ...(tool?.promptGuidelines ?? [])].join("\n");
		assert.match(text, /inferred from the columns that reference them/);
		assert.match(text, /heydb_search.*inference/);
	});

	test("heydb_search rejects a limit outside 1-50 and an empty query", async () => {
		const pi = loadHeydb();
		const root = project();
		for (const limit of [0, 51, 2.5]) {
			assert.deepEqual(await runTool(pi, "heydb_search", { query: "id", limit }, root), {
				isError: true,
				text: "limit must be an integer from 1 to 50",
			});
		}
		assert.deepEqual(await runTool(pi, "heydb_search", { query: "  " }, root), {
			isError: true,
			text: "search query must not be empty",
		});
	});
});

describe("writing tools", () => {
	test("heydb_annotate resolves partial names and signs notes as written via the agent", async () => {
		const pi = loadHeydb();
		const root = project();

		const results = [
			await runTool(pi, "heydb_annotate", { target: "orders.total", text: "Includes VAT." }, root),
			await runTool(pi, "heydb_annotate", { target: "orders", text: "One row per checkout." }, root),
			await runTool(pi, "heydb_annotate", { target: "shop", text: "The web store." }, root),
		];
		assert.deepEqual(results, [
			{ isError: false, text: "Saved note id-001 on column shop.orders.total (author: Ana (via agent))." },
			{ isError: false, text: "Saved note id-002 on table shop.orders (author: Ana (via agent))." },
			{ isError: false, text: "Saved note id-003 on database shop (author: Ana (via agent))." },
		]);
		const notes = loadKnowledge(root, "local").annotations;
		assert.deepEqual(
			notes.map((note) => [note.target, note.text, note.author]),
			[
				["shop.shop", "The web store.", "Ana (via agent)"],
				["shop.shop.orders", "One row per checkout.", "Ana (via agent)"],
				["shop.shop.orders.total", "Includes VAT.", "Ana (via agent)"],
			],
		);
	});

	// The field report: "art" was ambiguous because a column pos.art exists.
	test("heydb_annotate takes a name without a dot as the table, even when a column shares it", async () => {
		const pi = loadHeydb();
		const root = project();
		saveSnapshot(root, "local", snapshot([{ ...customersTable(), name: "art" }, ordersTable({ name: "pos", columns: [column("art", 1)] })]));
		assert.deepEqual(await runTool(pi, "heydb_annotate", { target: "art", text: "Artículos." }, root), {
			isError: false,
			text: "Saved note id-001 on table shop.art (author: Ana (via agent)).",
		});
	});

	test("heydb_annotate and heydb_relate warn when git ignores the notes, naming the rule", { skip: noGit }, async () => {
		const pi = loadHeydb();
		const root = project();
		execFileSync("git", ["init", "-q"], { cwd: root });
		writeFileSync(join(root, ".gitignore"), "vendor/\n.heydb/\n");
		const warning =
			"\nNote saved locally; git ignores it (.gitignore:2: .heydb/), so the team will not get it. " +
			"To share notes, commit .heydb/config.json, .heydb/snapshots/ and .heydb/knowledge/ (never .heydb/.env).";
		assert.deepEqual(await runTool(pi, "heydb_annotate", { target: "orders", text: "x" }, root), {
			isError: false,
			text: `Saved note id-001 on table shop.orders (author: Ana (via agent)).${warning}`,
		});
		const related = await runTool(pi, "heydb_relate", { from_table: "orders", from_columns: ["customer_id"], to_table: "customers", to_columns: ["id"] }, root);
		assert.equal(related.text, `Saved relationship id-002: shop.orders(customer_id) → shop.customers(id) (author: Ana (via agent)).${warning}`);
		assert.equal(readFileSync(join(root, ".gitignore"), "utf8"), "vendor/\n.heydb/\n", ".gitignore is never changed");

		writeFileSync(join(root, ".gitignore"), "vendor/\n");
		assert.deepEqual(await runTool(pi, "heydb_annotate", { target: "orders", text: "y" }, root), {
			isError: false,
			text: "Saved note id-003 on table shop.orders (author: Ana (via agent)).",
		});
	});

	test("heydb_annotate reads the author from the project folder", async () => {
		const seen: string[] = [];
		const pi = loadHeydb({
			author: async (cwd) => {
				seen.push(cwd);
				return "Bea";
			},
		});
		const root = project();
		await runTool(pi, "heydb_annotate", { target: "orders", text: "x" }, root);
		assert.deepEqual(seen, [root]);
	});

	test("heydb_annotate refuses unknown targets and empty text, and saves nothing", async () => {
		const pi = loadHeydb();
		const root = project();
		assert.deepEqual(await runTool(pi, "heydb_annotate", { target: "ordrs", text: "x" }, root), {
			isError: true,
			text: 'nothing matches "ordrs":\n- no table matches "ordrs". Did you mean: shop.orders?\n- no column matches "ordrs"',
		});
		assert.deepEqual(await runTool(pi, "heydb_annotate", { target: "orders", text: " " }, root), {
			isError: true,
			text: "annotation text must not be empty",
		});
		assert.deepEqual(loadKnowledge(root, "local").annotations, []);
	});

	test("heydb_relate documents an implicit relationship between partial table names", async () => {
		const pi = loadHeydb();
		const root = project();
		const result = await runTool(
			pi,
			"heydb_relate",
			{ from_table: "orders", from_columns: ["customer_id"], to_table: "shop.customers", to_columns: ["id"], note: "No FK: MyISAM." },
			root,
		);
		assert.deepEqual(result, {
			isError: false,
			text: "Saved relationship id-001: shop.orders(customer_id) → shop.customers(id) (author: Ana (via agent)).",
		});
		assert.deepEqual(loadKnowledge(root, "local").relationships, [
			{
				id: "id-001",
				from: { table: "shop.shop.orders", columns: ["customer_id"] },
				to: { table: "shop.shop.customers", columns: ["id"] },
				note: "No FK: MyISAM.",
				author: "Ana (via agent)",
				createdAt: "2026-11-06T10:00:00.000Z",
			},
		]);
	});

	test("heydb_relate refuses a column that does not exist", async () => {
		const pi = loadHeydb();
		const root = project();
		assert.deepEqual(
			await runTool(pi, "heydb_relate", { from_table: "orders", from_columns: ["client"], to_table: "customers", to_columns: ["id"] }, root),
			{
				isError: true,
				text: 'shop.shop.orders.client does not exist in the snapshot of "local"; if it was created recently, run sync first',
			},
		);
		assert.deepEqual(loadKnowledge(root, "local").relationships, []);
	});

	test("heydb_edit_note replaces the text and keeps the original author", async () => {
		const pi = loadHeydb();
		const root = project();
		const note = annotate(root, "local", { target: "shop.shop.orders", text: "Old.", author: "bea" }, fixedClock());
		assert.deepEqual(await runTool(pi, "heydb_edit_note", { id: note.id, text: "New." }, root), {
			isError: false,
			text: `Updated note ${note.id} on shop.orders.`,
		});
		const [edited] = loadKnowledge(root, "local").annotations;
		assert.equal(edited?.text, "New.");
		assert.equal(edited?.author, "bea");
		assert.deepEqual(await runTool(pi, "heydb_edit_note", { id: "nope", text: "x" }, root), {
			isError: true,
			text: 'unknown annotation id "nope"',
		});
	});

	test("heydb_forget removes a note or a relationship by id", async () => {
		const pi = loadHeydb();
		const root = project();
		const clock = fixedClock();
		const note = annotate(root, "local", { target: "shop.shop.orders", text: "x", author: "bea" }, clock);
		const link = relate(
			root,
			"local",
			{
				from: { table: "shop.shop.orders", columns: ["customer_id"] },
				to: { table: "shop.shop.customers", columns: ["id"] },
				note: "",
				author: "bea",
			},
			clock,
		);
		assert.deepEqual(await runTool(pi, "heydb_forget", { id: note.id }, root), {
			isError: false,
			text: `Forgot note ${note.id} on shop.orders.`,
		});
		assert.deepEqual(await runTool(pi, "heydb_forget", { id: link.id }, root), {
			isError: false,
			text: `Forgot relationship ${link.id}: shop.orders(customer_id) → shop.customers(id).`,
		});
		assert.deepEqual(await runTool(pi, "heydb_forget", { id: note.id }, root), {
			isError: true,
			text: `no annotation or relationship has id "${note.id}"`,
		});
	});
});

describe("relationships across connections", () => {
	const cus = { ...customersTable(), name: "cus", columns: [column("cod", 1), column("nombre", 2)] };
	const erpSnapshot = snapshot([], { databases: [{ name: "erp", schemas: [{ name: "erp", tables: [cus], routines: [] }] }] });

	/** "local" (shop, the default) and "erp"; erp synced unless told otherwise. */
	function twoConnections({ erpSynced = true } = {}): string {
		const root = project();
		saveConfig(root, { formatVersion: 1, defaultConnection: "local", connections: { local, erp: { ...local, password: "env:HEYDB_ERP_PASSWORD" } } });
		if (erpSynced) saveSnapshot(root, "erp", erpSnapshot);
		return root;
	}

	const toErp = { from_table: "customers", from_columns: ["id"], to_table: "cus", to_columns: ["cod"], to_connection: "erp", note: "Same code." };

	test("heydb_relate with to_connection resolves the to side in that connection and stores it with the from side", async () => {
		const pi = loadHeydb();
		const root = twoConnections();
		assert.deepEqual(await runTool(pi, "heydb_relate", toErp, root), {
			isError: false,
			text: "Saved relationship id-001: shop.customers(id) → erp: erp.cus(cod) (author: Ana (via agent)).",
		});
		assert.deepEqual(loadKnowledge(root, "local").relationships[0]?.to, { connection: "erp", table: "erp.erp.cus", columns: ["cod"] });
		assert.deepEqual(loadKnowledge(root, "erp").relationships, []);
	});

	test("heydb_relate refuses an unknown or never synced to_connection and a missing column", async () => {
		const pi = loadHeydb();
		const root = twoConnections({ erpSynced: false });
		assert.deepEqual(await runTool(pi, "heydb_relate", { ...toErp, to_connection: "crm" }, root), {
			isError: true,
			text: 'unknown connection "crm"; configured: erp, local',
		});
		assert.deepEqual(await runTool(pi, "heydb_relate", toErp, root), {
			isError: true,
			text: 'Connection "erp" was never synced, so there is no schema snapshot yet. Ask the user to run /heydb:sync erp.',
		});
		saveSnapshot(root, "erp", erpSnapshot);
		assert.deepEqual(await runTool(pi, "heydb_relate", { ...toErp, to_columns: ["codigo"] }, root), {
			isError: true,
			text: 'erp.erp.cus.codigo does not exist in the snapshot of "erp"; if it was created recently, run sync first',
		});
		assert.deepEqual(loadKnowledge(root, "local").relationships, []);
	});

	test("heydb_table on the target shows the relationship stored in the other connection", async () => {
		const pi = loadHeydb();
		const root = twoConnections();
		await runTool(pi, "heydb_relate", toErp, root);
		const result = await runTool(pi, "heydb_table", { table: "cus", connection: "erp" }, root);
		assert.equal(result.isError, false);
		assert.match(
			result.text,
			/## Referenced by\n- local: shop\.customers\(id\) → \(cod\) · implicit, documented by Ana \(via agent\) · Same code\. \[id id-001 · connection local · 2026-11-06\]/,
		);
		const from = await runTool(pi, "heydb_table", { table: "customers" }, root);
		assert.match(from.text, /- \(id\) → erp: erp\.cus\(cod\) · implicit/);
	});
});

describe("project notes", () => {
	test("heydb_annotate with scope project saves a project note; the overview shows it first", async () => {
		const pi = loadHeydb();
		const root = project();
		assert.deepEqual(await runTool(pi, "heydb_annotate", { scope: "project", text: "One database per client; the central one is acme." }, root), {
			isError: false,
			text: "Saved project note id-001 (author: Ana (via agent)).",
		});
		assert.deepEqual(loadKnowledge(root, "local").annotations, []);
		const overview = await runTool(pi, "heydb_overview", {}, root);
		assert.match(overview.text, /^# heydb · local\n.*\n\n## Project notes\n- One database per client; the central one is acme\. \[id id-001 · Ana \(via agent\) · 2026-11-06\]\n\n## Databases/);
	});

	test("heydb_edit_note and heydb_forget find project notes by id", async () => {
		const pi = loadHeydb();
		const root = project();
		await runTool(pi, "heydb_annotate", { scope: "project", text: "Old." }, root);
		assert.deepEqual(await runTool(pi, "heydb_edit_note", { id: "id-001", text: "New." }, root), {
			isError: false,
			text: "Updated project note id-001.",
		});
		assert.match((await runTool(pi, "heydb_overview", {}, root)).text, /- New\. \[id id-001/);
		assert.deepEqual(await runTool(pi, "heydb_forget", { id: "id-001" }, root), { isError: false, text: "Forgot project note id-001." });
		assert.doesNotMatch((await runTool(pi, "heydb_overview", {}, root)).text, /Project notes/);
	});

	test("a table named project is still annotated with target project", async () => {
		const pi = loadHeydb();
		const root = project();
		saveSnapshot(root, "local", snapshot([{ ...customersTable(), name: "project" }]));
		assert.deepEqual(await runTool(pi, "heydb_annotate", { target: "project", text: "One row per job." }, root), {
			isError: false,
			text: "Saved note id-001 on table shop.project (author: Ana (via agent)).",
		});
		assert.deepEqual(
			loadKnowledge(root, "local").annotations.map((note) => note.target),
			["shop.shop.project"],
		);
	});

	test("target and scope project are not combined; a missing target says how to write a project note", async () => {
		const pi = loadHeydb();
		const root = project();
		assert.deepEqual(await runTool(pi, "heydb_annotate", { scope: "project", target: "orders", text: "x" }, root), {
			isError: true,
			text: 'a project note has no target: omit target with scope "project"',
		});
		assert.deepEqual(await runTool(pi, "heydb_annotate", { text: "x" }, root), {
			isError: true,
			text: 'target is required, unless scope is "project"',
		});
		const missing = await runTool(pi, "heydb_annotate", { target: "project", text: "x" }, root);
		assert.equal(missing.isError, true);
		assert.match(missing.text, /\nFor a note about the whole project, use scope: "project" without a target\.$/);
	});
});
