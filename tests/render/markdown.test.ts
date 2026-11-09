import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { emptyKnowledge } from "../../lib/knowledge/operations.ts";
import { knowledgeForTable } from "../../lib/knowledge/query.ts";
import type { Change } from "../../lib/model/diff.ts";
import type { Knowledge } from "../../lib/knowledge/types.ts";
import { incomingReferences } from "../../lib/model/references.ts";
import type { Snapshot, Table } from "../../lib/model/snapshot.ts";
import {
	approximateRows,
	escapeCell,
	renderChanges,
	renderOverview,
	renderSearch,
	renderStatus,
	renderTable,
	type TableOptions,
} from "../../lib/render/markdown.ts";
import type { SearchResult } from "../../lib/search.ts";
import { column, customersTable, ordersTable, snapshot } from "../fixtures/snapshot.ts";
import { annotation, knowledge, relationship } from "../knowledge/fixtures.ts";

const ordersView = ordersTable({
	name: "v_orders",
	kind: "view",
	storageEngine: null,
	rowEstimate: null,
	columns: [column("id", 1)],
	primaryKey: [],
	indexes: [],
	foreignKeys: [],
	viewDefinition: "select `id` from `shop`.`orders`",
});

describe("escapeCell", () => {
	test("escapes pipes and turns line breaks into <br>", () => {
		assert.equal(escapeCell("a|b\nc\r\nd\re"), "a\\|b<br>c<br>d<br>e");
	});
});

describe("approximateRows", () => {
	test("rounds like a person would say it", () => {
		const cases: [number, string][] = [
			[0, "~0"],
			[999, "~999"],
			[1000, "~1k"],
			[1200, "~1.2k"],
			[9960, "~10k"],
			[15_300, "~15k"],
			[999_999, "~1M"],
			[2_500_000, "~2.5M"],
			[3_000_000_000, "~3B"],
		];
		for (const [rows, text] of cases) assert.equal(approximateRows(rows), text, String(rows));
	});
});

describe("renderOverview", () => {
	const shop = snapshot([ordersTable(), customersTable(), ordersView], {
		warnings: [{ code: "routines_hidden", message: "routines are hidden: missing privilege", target: "shop.shop" }],
	});
	const notes = knowledge([
		annotation("a-db", "shop.shop", { text: "Main store.\nSecond line." }),
		annotation("a-t", "shop.shop.orders", { text: `${"x".repeat(100)}\nsecond` }),
	]);

	test("summarizes engine, each database with its coverage and main tables, warnings and tables", () => {
		assert.equal(
			renderOverview(shop, notes, { connection: "local" }),
			[
				"# heydb · local",
				"mysql 8.0.36 · captured 2026-11-03T10:00:00.000Z",
				"",
				"## Databases",
				"- shop: 2 tables, 1 view · Main store.",
				"  Comment coverage: 0% of 2 tables, 0% of 5 columns",
				"  Most referenced tables:",
				"  - shop.customers · 1 reference · ~1.2k rows · no comment",
				"  Most tables have no comment: do not infer meaning from table names alone.",
				"",
				"## Warnings",
				"- routines are hidden: missing privilege (shop)",
				"",
				"## Tables",
				"Tables with notes first, then the most referenced, then by name; rows are engine estimates.",
				"| table | kind | rows | note |",
				"|---|---|---|---|",
				`| shop.orders | table | ~1.2k | ${"x".repeat(79)}… |`,
				"| shop.customers | table | ~1.2k |  |",
				"| shop.v_orders | view |  |  |",
			].join("\n"),
		);
	});

	test("uses the table comment when there is no note, and omits empty sections", () => {
		const plain = snapshot([ordersTable({ comment: "Checkout | orders" })]);
		assert.equal(
			renderOverview(plain, emptyKnowledge(), { connection: "local" }),
			[
				"# heydb · local",
				"mysql 8.0.36 · captured 2026-11-03T10:00:00.000Z",
				"",
				"## Databases",
				"- shop: 1 table",
				"  Comment coverage: 100% of 1 table, 0% of 3 columns",
				"",
				"## Tables",
				"Tables with notes first, then the most referenced, then by name; rows are engine estimates.",
				"| table | kind | rows | note |",
				"|---|---|---|---|",
				"| shop.orders | table | ~1.2k | Checkout \\| orders |",
			].join("\n"),
		);
	});

	test("lists at most maxTables tables and points to search for the rest", () => {
		const text = renderOverview(shop, notes, { connection: "local", maxTables: 2 });
		assert.ok(text.endsWith("| shop.customers | table | ~1.2k |  |\n… 1 more table — use heydb_search"));
		assert.doesNotMatch(text, /v_orders/);
	});

	test("shows name prefixes and orders tables: notes, most referenced, then by name", () => {
		const names = ["sii_a", "sii_b", "sii_c", "log1", "log2", "zeta", "alpha"];
		const tables = names.map((name) => ({ ...customersTable(), name, columns: [column("id", 1)] }));
		tables.push({ ...customersTable(), name: "art", comment: "Productos", columns: [column("id", 1)] });
		tables.push({ ...customersTable(), name: "lines", columns: [column("id", 1), column("ref_art", 2), column("cod_zeta", 3)] });
		tables.push({ ...customersTable(), name: "moves", columns: [column("id", 1), column("art_id", 2)] });
		const text = renderOverview(snapshot(tables), knowledge([annotation("a-1", "shop.shop.zeta", { text: "Zeta rows." })]), {
			connection: "local",
		});
		assert.match(text, /\n {2}Name prefixes: sii_ ×3, log0-9 ×2\n/);
		assert.match(
			text,
			/\n {2}Most referenced tables:\n {2}- shop\.art · 2 references · ~1\.2k rows · Productos\n {2}- shop\.zeta · 1 reference · ~1\.2k rows · Zeta rows\.\n/,
		);
		const order = text
			.split("\n")
			.filter((line) => line.startsWith("| shop."))
			.map((line) => line.split(" | ")[0]?.slice(2));
		assert.deepEqual(order, [
			"shop.zeta",
			"shop.art",
			"shop.alpha",
			"shop.lines",
			"shop.log1",
			"shop.log2",
			"shop.moves",
			"shop.sii_a",
			"shop.sii_b",
			"shop.sii_c",
		]);
	});

	test("keeps every level of a PostgreSQL name and says when rows are unknown", () => {
		const postgres = snapshot([], {
			engine: { kind: "postgresql", version: "16.4" },
			databases: [
				{
					name: "app",
					schemas: [
						{
							name: "public",
							routines: [],
							tables: [
								{ ...customersTable(), storageEngine: null, rowEstimate: null, comment: "People" },
								ordersTable({
									storageEngine: null,
									rowEstimate: null,
									comment: "Checkouts",
									foreignKeys: [
										{
											...ordersTable().foreignKeys[0]!,
											references: { database: "app", schema: "public", table: "customers", columns: ["id"] },
										},
									],
								}),
							],
						},
					],
				},
			],
		});
		const text = renderOverview(postgres, emptyKnowledge(), { connection: "pg" });
		assert.match(text, /\n## Databases\n- app\.public: 2 tables\n/);
		assert.match(text, /\n {2}- app\.public\.customers · 1 reference · rows unknown · People\n/);
		assert.match(text, /\n\| app\.public\.orders \| table \|  \| Checkouts \|/);
		assert.doesNotMatch(text, /do not infer meaning/);
	});
});

// orders, the tables that point to it, and what the team wrote about them.
function ordersWorld() {
	const orders = ordersTable({
		comment: "One row per checkout.\nLegacy ERP.",
		columns: [
			column("id", 1, { autoIncrement: true }),
			column("customer_id", 2),
			column("total", 3, { type: "decimal(10,2)", nullable: true, default: "0.00", comment: "With VAT" }),
			column("code", 4, { type: "varchar(8)", default: "" }),
		],
		triggers: [{ name: "trg_audit", timing: "AFTER", events: ["INSERT", "UPDATE"] }],
	});
	const invoices = {
		...customersTable(),
		name: "invoices",
		columns: [column("id", 1), column("order_id", 2, { comment: "Order" })],
		foreignKeys: [
			{
				name: "fk_invoices_order",
				columns: ["order_id"],
				references: { database: "shop", schema: "shop", table: "orders", columns: ["id"] },
				onDelete: "RESTRICT" as const,
				onUpdate: "RESTRICT" as const,
			},
		],
	};
	const refunds = { ...customersTable(), name: "refunds", columns: [column("id", 1), column("order_id", 2, { comment: "Pedido" })] };
	const lines = {
		...customersTable(),
		name: "lines",
		columns: [column("id", 1), column("orders_ref", 2, { comment: "Pedido." }), column("ref_orders", 3)],
	};
	const world = snapshot([customersTable(), invoices, lines, orders, refunds]);
	const notes = knowledge(
		[
			annotation("a-db", "shop.shop", { text: "Main store." }),
			annotation("a-t", "shop.shop.orders", { text: "Status 3 means returned.\nStatus 4 is unused." }),
			annotation("a-col", "shop.shop.orders.total", { text: "Includes VAT | taxes." }),
		],
		[
			{ ...relationship("r-1", "shop.shop.orders", ["customer_id"], "shop.shop.customers", ["id"]), note: "MyISAM: no FK" },
			relationship("r-2", "shop.shop.refunds", ["order_id"], "shop.shop.orders", ["id"]),
		],
	);
	return { orders, world, notes };
}

function render(table: Table, world: Snapshot, notes: Knowledge, name: string, options?: TableOptions): string {
	return renderTable(table, name, knowledgeForTable(notes, name), incomingReferences(world, notes, name), options);
}

describe("renderTable", () => {
	test("header first: meaning, notes, keys, relationships both ways and triggers; then columns and indexes", () => {
		const { orders, world, notes } = ordersWorld();
		assert.equal(
			render(orders, world, notes, "shop.shop.orders"),
			[
				"# table shop.orders",
				"InnoDB · ~1.2k rows (engine estimate)",
				"Comment: One row per checkout. Legacy ERP.",
				"Primary key: (id)",
				"",
				"## Notes",
				"- database: Main store. [id a-db · ana · 2026-11-06]",
				"- table: Status 3 means returned.",
				"  Status 4 is unused. [id a-t · ana · 2026-11-06]",
				"",
				"## Relationships",
				"- fk_orders_customer: (customer_id) → shop.customers(id) · on delete RESTRICT · on update CASCADE",
				"- (customer_id) → shop.customers(id) · implicit, documented by ana · MyISAM: no FK [id r-1 · 2026-11-06]",
				"",
				"## Referenced by",
				'Referencing columns are commented as: "Pedido" ×2, "Order" ×1',
				"- shop.invoices(order_id) → (id) · foreign key fk_invoices_order",
				"- shop.refunds(order_id) → (id) · implicit, documented by ana [id r-2 · 2026-11-06]",
				"Name pattern, not enforced (guesses):",
				'- shop.lines.orders_ref · "Pedido."',
				"- shop.lines.ref_orders",
				"",
				"## Triggers",
				"- trg_audit: AFTER INSERT, UPDATE",
				"",
				"## Columns",
				"| # | column | type | null | default | comment | notes |",
				"|---|---|---|---|---|---|---|",
				"| 1 | id | int auto_increment | no |  |  |  |",
				"| 2 | customer_id | int | no |  |  |  |",
				"| 3 | total | decimal(10,2) | yes | 0.00 | With VAT | Includes VAT \\| taxes. [id a-col · ana · 2026-11-06] |",
				"| 4 | code | varchar(8) | no | '' |  |  |",
				"",
				"## Indexes",
				"- idx_customer (customer_id) BTREE",
			].join("\n"),
		);
	});

	test("renders a view with its definition and drops empty columns and sections", () => {
		assert.equal(
			render(ordersView, snapshot([ordersView]), emptyKnowledge(), "shop.shop.v_orders"),
			[
				"# view shop.v_orders",
				NO_EVIDENCE,
				"",
				"## Definition",
				"```sql",
				"select `id` from `shop`.`orders`",
				"```",
				"",
				"## Columns",
				"| # | column | type | null | default |",
				"|---|---|---|---|---|",
				"| 1 | id | int | no |  |",
			].join("\n"),
		);
	});

	test("says when a view definition is hidden, and shows generated columns", () => {
		const hidden = { ...ordersView, viewDefinition: null, columns: [column("net", 1, { generated: { expression: "`total` / 1.21", stored: false } })] };
		const text = render(hidden, snapshot([hidden]), emptyKnowledge(), "shop.shop.v_orders");
		assert.match(text, /\| 1 \| net \| int generated \(`total` \/ 1\.21\) virtual \| no \|  \|/);
		assert.match(text, /\n## Definition\nnot visible to this user \(see the snapshot warnings\)\n/);
	});

	test("cuts a very long view definition and says where the rest is", () => {
		const definition = `select ${"`a`, ".repeat(2000)}1`;
		const long = { ...ordersView, viewDefinition: definition };
		const text = render(long, snapshot([long]), emptyKnowledge(), "shop.shop.v_orders");
		assert.ok(text.includes(`\`\`\`sql\n${definition.slice(0, 3000)}\n\`\`\`\n`));
		assert.match(text, new RegExp(`\\n… definition cut at 3000 of ${definition.length} characters; the full text is in the stored snapshot \\(\\.heydb/snapshots/\\)\\n`));
	});

	test("a table without a primary key says so; unknown rows are said too", () => {
		const table = ordersTable({ primaryKey: [], rowEstimate: null, storageEngine: null });
		const text = render(table, snapshot([table]), emptyKnowledge(), "shop.shop.orders");
		assert.match(text, /^# table shop\.orders\nrows unknown\n/);
		assert.match(text, /\nPrimary key: none\n/);
	});

	test("without comment or table note, says meaning must be inferred and confirmed", () => {
		const table = ordersTable();
		const world = snapshot([table]);
		const bare = render(table, world, knowledge([annotation("a-db", "shop.shop")]), "shop.shop.orders");
		assert.match(bare, new RegExp(`^# table shop\\.orders\\nInnoDB · ~1\\.2k rows \\(engine estimate\\)\\n${escape(NO_EVIDENCE)}\\n`));
		const noted = render(table, world, knowledge([annotation("a-t", "shop.shop.orders")]), "shop.shop.orders");
		assert.match(noted, /\nNo table comment\.\n/);
		assert.doesNotMatch(noted, /inferred/);
		const commented = render(ordersTable({ comment: "Orders." }), world, emptyKnowledge(), "shop.shop.orders");
		assert.doesNotMatch(commented, /inferred|No table comment/);
	});

	test("caps the name-pattern guesses it lists and says how many more there are", () => {
		const art = { ...customersTable(), name: "art", columns: [column("id", 1)] };
		const lines = { ...customersTable(), name: "lines", columns: Array.from({ length: 230 }, (_, index) => column(`ref${index}_art`, index + 1)) };
		const world = snapshot([art, lines]);
		const text = render(art, world, emptyKnowledge(), "shop.shop.art");
		assert.equal(text.split("\n").filter((line) => line.startsWith("- shop.lines.ref")).length, 15);
		assert.match(text, /\n… 215 more name-pattern guesses\n/);
	});
});

describe("renderTable columns", () => {
	// 600 columns; only a few say anything about the table.
	const columns = Array.from({ length: 600 }, (_, index) => column(`c${index + 1}`, index + 1));
	columns[299] = column("c300", 300, { autoIncrement: true });
	columns[399] = column("c400", 400, { comment: "Precio de venta" });
	columns[400] = column("precio_coste", 401);
	const wide = ordersTable({
		columns,
		primaryKey: ["c300"],
		indexes: [],
		foreignKeys: [{ ...ordersTable().foreignKeys[0]!, columns: ["c500"] }],
	});
	const notes = knowledge(
		[annotation("a-c", "shop.shop.orders.c450", { text: "Legacy flag." })],
		[relationship("r-1", "shop.shop.orders", ["c520"], "shop.shop.customers", ["id"])],
	);
	const world = snapshot([customersTable(), wide]);
	const positions = (text: string) =>
		text
			.split("\n")
			.filter((line) => /^\| \d+ \| /.test(line))
			.map((line) => Number(line.split(" | ")[0]?.slice(2)));

	test("by default shows 60: keys, related, commented or noted first, then by position, in position order", () => {
		const text = render(wide, world, notes, "shop.shop.orders");
		assert.match(text, /\n## Columns \(60 of 600; keys, relationships and commented first\)\n/);
		assert.deepEqual(positions(text), [...Array.from({ length: 55 }, (_, index) => index + 1), 300, 400, 450, 500, 520]);
		assert.match(text, /\n… 540 more columns — call heydb_table with columns: "all" or a column_filter/);
	});

	test("a smaller limit keeps the strongest columns", () => {
		assert.deepEqual(positions(render(wide, world, notes, "shop.shop.orders", { columns: 3 })), [300, 500, 520]);
		assert.deepEqual(positions(render(wide, world, notes, "shop.shop.orders", { columns: 4 })), [300, 400, 500, 520]);
	});

	test('columns: "all" shows every column and no footer', () => {
		const text = render(wide, world, notes, "shop.shop.orders", { columns: "all" });
		assert.equal(positions(text).length, 600);
		assert.match(text, /\n## Columns\n/);
		assert.doesNotMatch(text, /more columns/);
	});

	test("column_filter matches name or comment, ignoring case and accents", () => {
		const text = render(wide, world, notes, "shop.shop.orders", { columnFilter: "PRÉCIO" });
		assert.match(text, /\n## Columns matching "PRÉCIO" \(2 of 600\)\n/);
		assert.deepEqual(positions(text), [400, 401]);
		const none = render(wide, world, notes, "shop.shop.orders", { columnFilter: "zzz" });
		assert.match(none, /\n## Columns matching "zzz" \(0 of 600\)\nNo column matches; try another column_filter or columns: "all"\./);
	});
});

const NO_EVIDENCE =
	"No table comment or team note: meaning must be inferred from columns and references; say it is an inference and ask the user to confirm.";

function escape(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const changes: Change[] = [
	{ kind: "added", object: "table", target: "shop.shop.carts", details: [] },
	{ kind: "modified", object: "column", target: "shop.shop.orders.total", details: ["type: int → bigint", "nullable: false → true"] },
	{ kind: "removed", object: "foreignKey", target: "shop.shop.orders.fk_old", details: [] },
	{ kind: "added", object: "routine", target: "shop.shop.calc", details: ["procedure"] },
];

describe("renderChanges", () => {
	test("one line per change, details after a colon, names as displayed", () => {
		assert.equal(
			renderChanges(changes),
			[
				"- added table shop.carts",
				"- modified column shop.orders.total: type: int → bigint; nullable: false → true",
				"- removed foreign key shop.orders.fk_old",
				"- added routine shop.calc: procedure",
			].join("\n"),
		);
	});

	test("keeps database names and every PostgreSQL level", () => {
		assert.equal(
			renderChanges([
				{ kind: "added", object: "database", target: "shop", details: [] },
				{ kind: "added", object: "schema", target: "legacy.billing", details: [] },
				{ kind: "removed", object: "column", target: "legacy.public.orders.status", details: [] },
			]),
			["- added database shop", "- added schema legacy.billing", "- removed column legacy.public.orders.status"].join("\n"),
		);
	});

	test("truncates after max changes and says how many are left", () => {
		assert.equal(renderChanges(changes, { max: 1 }), "- added table shop.carts\n… 3 more changes");
		assert.equal(renderChanges(changes, { max: 3 }).split("\n").at(-1), "… 1 more change");
	});

	test("says when there is nothing", () => {
		assert.equal(renderChanges([]), "No changes.");
	});
});

describe("renderStatus", () => {
	test("covers the three states", () => {
		assert.equal(renderStatus({ state: "never_synced" }), "Never synced: there is no stored snapshot for this connection yet.");
		assert.equal(
			renderStatus({ state: "up_to_date", hash: "0123456789abcdef0123" }),
			"Up to date: the live database matches the snapshot (hash 0123456789ab).",
		);
		assert.equal(
			renderStatus({ state: "drifted", storedHash: "a", liveHash: "b", changes: changes.slice(0, 1) }),
			"Drifted: the live database differs from the snapshot in 1 change.\n\n- added table shop.carts",
		);
	});
});

describe("renderSearch", () => {
	const base = { snippet: "", inferred: false, columns: [], moreColumns: 0 };
	const results: SearchResult[] = [
		{ ...base, target: "shop.shop.orders", object: "table", matchedIn: ["name", 'columns: total ("Includes VAT.")'] },
		{ ...base, target: "legacy.public.cus", object: "table", matchedIn: ['referenced as "Cliente" ×3 (inferred)'], inferred: true },
		{ ...base, target: "shop.shop", object: "database", matchedIn: ["note: The web store."], snippet: "The web store." },
	];

	test("one line per result with why it matched, names as displayed", () => {
		assert.equal(
			renderSearch({ results: results.slice(0, 1).concat(results.slice(2)), total: 2 }),
			["2 matches.", '- table shop.orders · name · columns: total ("Includes VAT.")', "- database shop · note: The web store."].join("\n"),
		);
	});

	test("says inferred results are inferences", () => {
		assert.equal(
			renderSearch({ results: results.slice(1, 2), total: 1 }),
			[
				"1 match.",
				'- table legacy.public.cus · referenced as "Cliente" ×3 (inferred)',
				"(inferred): only the comments of columns that reference the table match; present that meaning as an inference and ask the user to confirm it.",
			].join("\n"),
		);
	});

	test("shows relationship sides by display name", () => {
		const relationship = { from: { table: "shop.shop.refunds", columns: ["order_id"] }, to: { table: "shop.shop.orders", columns: ["id"] } };
		const target = "shop.shop.refunds(order_id) → shop.shop.orders(id)";
		assert.equal(
			renderSearch({
				results: [{ ...base, target, object: "relationship", matchedIn: ["relationship note: app code"], snippet: "app code", relationship }],
				total: 1,
			}),
			"1 match.\n- relationship shop.refunds(order_id) → shop.orders(id) · relationship note: app code",
		);
	});

	test("says when the list is partial, and when there is nothing", () => {
		assert.equal(renderSearch({ results: results.slice(0, 1), total: 87 }).split("\n")[0], "Showing 1 of 87 matches; refine the query to narrow them.");
		assert.equal(renderSearch({ results: [], total: 0 }), "No matches.");
	});

	test("names the words that matched nothing and what to try instead", () => {
		assert.equal(
			renderSearch({ results: [], total: 0, unmatched: ["xyzzy", "plugh"] }),
			'No matches for "xyzzy", "plugh". Try synonyms, another language (English or Spanish) or single words.',
		);
		assert.deepEqual(renderSearch({ results: results.slice(0, 1), total: 1, unmatched: ["xyzzy"] }).split("\n"), [
			"1 match.",
			'Nothing matches "xyzzy"; these results match the other words.',
			'- table shop.orders · name · columns: total ("Includes VAT.")',
		]);
	});

	test("shows the other databases of an identical table compactly", () => {
		const alsoIn = Array.from({ length: 9 }, (_, index) => `emp_${String(index + 2).padStart(3, "0")}`);
		assert.equal(
			renderSearch({ results: [{ ...base, target: "emp_001.emp_001.fac_cab", object: "table", matchedIn: ["name"], alsoIn }], total: 1 }),
			"1 match.\n- table emp_001.fac_cab (+9 identical: emp_002, emp_003, emp_004, …) · name",
		);
		const twice = ["fac_cab", "fac_lin"].map((name): SearchResult => ({ ...base, target: `emp_001.emp_001.${name}`, object: "table", matchedIn: ["name"], alsoIn: ["emp_002"] }));
		assert.equal(
			renderSearch({ results: twice, total: 2 }),
			"2 matches.\n- table emp_001.fac_cab (+1 identical: emp_002) · name\n- table emp_001.fac_lin (+1 identical) · name",
		);
	});
});

describe("project notes and other connections", () => {
	const cus: Table = { ...customersTable(), name: "cus", columns: [column("cod", 1)], primaryKey: ["cod"] };
	const clientes: Table = { ...customersTable(), name: "clientes", columns: [column("id", 1), column("cod_erp", 2)] };
	// Stored in crm's file: crm.clientes(cod_erp) → erp:cus(cod).
	const toErp = {
		...relationship("r-9", "crm.crm.clientes", ["cod_erp"], "erp.erp.cus", ["cod"]),
		to: { connection: "erp", table: "erp.erp.cus", columns: ["cod"] },
		note: "Same code.",
	};

	test("the overview shows project notes first, with their ids", () => {
		const shop = snapshot([customersTable()]);
		const projectNotes = [annotation("p-1", "project", { text: "One database per client.\nThe central one is acme." })];
		const text = renderOverview(shop, emptyKnowledge(), { connection: "local", projectNotes });
		assert.deepEqual(text.split("\n").slice(0, 7), [
			"# heydb · local",
			"mysql 8.0.36 · captured 2026-11-03T10:00:00.000Z",
			"",
			"## Project notes",
			"- One database per client.",
			"  The central one is acme. [id p-1 · ana · 2026-11-06]",
			"",
		]);
		assert.equal(renderOverview(shop, emptyKnowledge(), { connection: "local", projectNotes: [] }), renderOverview(shop, emptyKnowledge(), { connection: "local" }));
	});

	test("a table shows relationships stored in other connections that point to it, with their connection", () => {
		const text = renderTable(cus, "erp.erp.cus", knowledgeForTable(emptyKnowledge(), "erp.erp.cus"), undefined, {
			connection: "erp",
			external: [{ connection: "crm", relationship: toErp }],
		});
		assert.match(
			text,
			/## Referenced by\n- crm: crm\.clientes\(cod_erp\) → \(cod\) · implicit, documented by ana · Same code\. \[id r-9 · connection crm · 2026-11-06\]\n/,
		);
	});

	test("an outgoing relationship to another connection names that connection", () => {
		const text = renderTable(clientes, "crm.crm.clientes", knowledgeForTable(knowledge([], [toErp]), "crm.crm.clientes"), undefined, {
			connection: "crm",
		});
		assert.match(text, /## Relationships\n- \(cod_erp\) → erp: erp\.cus\(cod\) · implicit, documented by ana · Same code\. \[id r-9 · 2026-11-06\]/);
	});

	test("a relationship into another connection is not shown on a same-named table of this one", () => {
		const text = renderTable(cus, "erp.erp.cus", knowledgeForTable(knowledge([], [toErp]), "erp.erp.cus"), undefined, { connection: "crm" });
		assert.doesNotMatch(text, /r-9/);
	});

	test("says which knowledge files of other connections could not be read", () => {
		const text = renderTable(cus, "erp.erp.cus", knowledgeForTable(emptyKnowledge(), "erp.erp.cus"), undefined, {
			connection: "erp",
			unreadable: ["knowledge/crm.json is not valid JSON"],
		});
		assert.match(text, /## Referenced by\n- not read: knowledge\/crm\.json is not valid JSON/);
	});

	test("search shows the connection of a relationship side in another connection", () => {
		const relationship = { from: { table: "crm.crm.clientes", columns: ["cod_erp"] }, to: { connection: "erp", table: "erp.erp.cus", columns: ["cod"] } };
		const base = { snippet: "", inferred: false, columns: [], moreColumns: 0 };
		assert.equal(
			renderSearch({
				results: [{ ...base, target: "x", object: "relationship", matchedIn: ["relationship note: code"], snippet: "code", relationship }],
				total: 1,
			}),
			"1 match.\n- relationship crm.clientes(cod_erp) → erp: erp.cus(cod) · relationship note: code",
		);
	});
});
