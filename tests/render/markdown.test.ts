import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { emptyKnowledge } from "../../lib/knowledge/operations.ts";
import { knowledgeForTable } from "../../lib/knowledge/query.ts";
import type { Change } from "../../lib/model/diff.ts";
import {
	approximateRows,
	escapeCell,
	renderChanges,
	renderOverview,
	renderSearch,
	renderStatus,
	renderTable,
} from "../../lib/render/markdown.ts";
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

	test("summarizes engine, databases, warnings and tables", () => {
		assert.equal(
			renderOverview(shop, notes, { connection: "local" }),
			[
				"# heydb · local",
				"mysql 8.0.36 · captured 2026-11-03T10:00:00.000Z",
				"",
				"## Databases",
				"- shop: 2 tables, 1 view · Main store.",
				"",
				"## Warnings",
				"- routines are hidden: missing privilege (shop.shop)",
				"",
				"## Tables",
				"| table | kind | rows | note |",
				"|---|---|---|---|",
				"| shop.shop.customers | table | ~1.2k |  |",
				`| shop.shop.orders | table | ~1.2k | ${"x".repeat(79)}… |`,
				"| shop.shop.v_orders | view |  |  |",
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
				"",
				"## Tables",
				"| table | kind | rows | note |",
				"|---|---|---|---|",
				"| shop.shop.orders | table | ~1.2k | Checkout \\| orders |",
			].join("\n"),
		);
	});

	test("lists at most maxTables tables and points to search for the rest", () => {
		const text = renderOverview(shop, notes, { connection: "local", maxTables: 2 });
		assert.ok(text.endsWith("| shop.shop.orders | table | ~1.2k | " + "x".repeat(79) + "… |\n… 1 more table — use heydb_search"));
		assert.doesNotMatch(text, /v_orders/);
	});
});

describe("renderTable", () => {
	test("renders columns, keys, relationships, triggers and every note with its id", () => {
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
		assert.equal(
			renderTable(orders, "shop.shop.orders", knowledgeForTable(notes, "shop.shop.orders")),
			[
				"# table shop.shop.orders",
				"InnoDB · ~1.2k rows",
				"Comment: One row per checkout. Legacy ERP.",
				"",
				"## Columns",
				"| column | type | null | default | comment | notes |",
				"|---|---|---|---|---|---|",
				"| id | int auto_increment | no |  |  |  |",
				"| customer_id | int | no |  |  |  |",
				"| total | decimal(10,2) | yes | 0.00 | With VAT | Includes VAT \\| taxes. [id a-col · ana · 2026-11-06] |",
				"| code | varchar(8) | no | '' |  |  |",
				"",
				"Primary key: (id)",
				"",
				"## Indexes",
				"- idx_customer (customer_id) BTREE",
				"",
				"## Relationships",
				"- fk_orders_customer: (customer_id) → shop.shop.customers(id) · on delete RESTRICT · on update CASCADE",
				"- (customer_id) → shop.shop.customers(id) · implicit, documented by ana · MyISAM: no FK [id r-1 · 2026-11-06]",
				"- shop.shop.refunds(order_id) → (id) · implicit, documented by ana [id r-2 · 2026-11-06]",
				"",
				"## Triggers",
				"- trg_audit: AFTER INSERT, UPDATE",
				"",
				"## Notes",
				"- database: Main store. [id a-db · ana · 2026-11-06]",
				"- table: Status 3 means returned.",
				"  Status 4 is unused. [id a-t · ana · 2026-11-06]",
			].join("\n"),
		);
	});

	test("renders a view with its definition and drops empty columns and sections", () => {
		assert.equal(
			renderTable(ordersView, "shop.shop.v_orders", knowledgeForTable(emptyKnowledge(), "shop.shop.v_orders")),
			[
				"# view shop.shop.v_orders",
				"",
				"## Columns",
				"| column | type | null | default |",
				"|---|---|---|---|",
				"| id | int | no |  |",
				"",
				"## Definition",
				"```sql",
				"select `id` from `shop`.`orders`",
				"```",
			].join("\n"),
		);
	});

	test("says when a view definition is hidden, and shows generated columns", () => {
		const hidden = { ...ordersView, viewDefinition: null, columns: [column("net", 1, { generated: { expression: "`total` / 1.21", stored: false } })] };
		const text = renderTable(hidden, "shop.shop.v_orders", knowledgeForTable(emptyKnowledge(), "shop.shop.v_orders"));
		assert.match(text, /\| net \| int generated \(`total` \/ 1\.21\) virtual \| no \|  \|/);
		assert.ok(text.endsWith("## Definition\nnot visible to this user (see the snapshot warnings)"));
	});

	test("a table without a primary key says so", () => {
		const text = renderTable(ordersTable({ primaryKey: [] }), "shop.shop.orders", knowledgeForTable(emptyKnowledge(), "shop.shop.orders"));
		assert.match(text, /\nPrimary key: none\n/);
	});
});

const changes: Change[] = [
	{ kind: "added", object: "table", target: "shop.shop.carts", details: [] },
	{ kind: "modified", object: "column", target: "shop.shop.orders.total", details: ["type: int → bigint", "nullable: false → true"] },
	{ kind: "removed", object: "foreignKey", target: "shop.shop.orders.fk_old", details: [] },
	{ kind: "added", object: "routine", target: "shop.shop.calc", details: ["procedure"] },
];

describe("renderChanges", () => {
	test("one line per change, details after a colon", () => {
		assert.equal(
			renderChanges(changes),
			[
				"- added table shop.shop.carts",
				"- modified column shop.shop.orders.total: type: int → bigint; nullable: false → true",
				"- removed foreign key shop.shop.orders.fk_old",
				"- added routine shop.shop.calc: procedure",
			].join("\n"),
		);
	});

	test("truncates after max changes and says how many are left", () => {
		assert.equal(renderChanges(changes, { max: 1 }), "- added table shop.shop.carts\n… 3 more changes");
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
			"Drifted: the live database differs from the snapshot in 1 change.\n\n- added table shop.shop.carts",
		);
	});
});

describe("renderSearch", () => {
	const results = [
		{ target: "shop.shop.orders", object: "table" as const, matchedIn: "name" as const, snippet: "orders" },
		{ target: "shop.shop.orders.total", object: "column" as const, matchedIn: "annotation" as const, snippet: "Includes VAT." },
	];

	test("lists matches, with a snippet when the match is not the name", () => {
		assert.equal(
			renderSearch({ results, total: 2 }),
			["2 matches.", "- table shop.shop.orders", "- column shop.shop.orders.total · annotation: Includes VAT."].join("\n"),
		);
	});

	test("says when the list is partial, and when there is nothing", () => {
		assert.equal(renderSearch({ results: results.slice(0, 1), total: 87 }).split("\n")[0], "Showing 1 of 87 matches; refine the query to narrow them.");
		assert.equal(renderSearch({ results: [], total: 0 }), "No matches.");
	});
});
