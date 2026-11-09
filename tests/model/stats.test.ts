import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { emptyKnowledge } from "../../lib/knowledge/operations.ts";
import { schemaStats, tablePrefix } from "../../lib/model/stats.ts";
import type { Table } from "../../lib/model/snapshot.ts";
import { relationship, knowledge } from "../knowledge/fixtures.ts";
import { column, customersTable, snapshot } from "../fixtures/snapshot.ts";

function table(name: string, columns: string[], overrides: Partial<Table> = {}): Table {
	return { ...customersTable(), name, columns: columns.map((columnName, index) => column(columnName, index + 1)), ...overrides };
}

describe("tablePrefix", () => {
	test("is the start of the name up to the first _ or digit, lowercased", () => {
		assert.equal(tablePrefix("sii_fac"), "sii_");
		assert.equal(tablePrefix("SII_Fac_Lin"), "sii_");
		assert.equal(tablePrefix("log2020"), "log0-9");
		assert.equal(tablePrefix("gcl"), null);
		assert.equal(tablePrefix("_tmp"), null);
		assert.equal(tablePrefix("2020_log"), null);
	});
});

describe("schemaStats", () => {
	const shop = snapshot([
		table("gar", ["id", "nombre"], { comment: "Productos" }),
		table("sii_a", ["id", "ref_gar"]),
		table("sii_b", ["id", "gar_id"]),
		table("sii_c", ["id"]),
		table("log1", ["id"]),
		table("log2", ["id", "cod_sii_c"]),
		table("tmp_x", ["id"]),
		table("v_gar", ["id", "ref_gar"], { kind: "view", comment: "A view" }),
	]);
	const shopWithComments = {
		...shop,
		databases: shop.databases.map((database) => ({
			...database,
			schemas: database.schemas.map((schema) => ({
				...schema,
				tables: schema.tables.map((item) =>
					item.name === "gar" ? { ...item, columns: [column("id", 1, { comment: "Código" }), column("nombre", 2)] } : item,
				),
			})),
		})),
	};
	const links = knowledge([], [relationship("r-1", "shop.shop.log1", ["id"], "shop.shop.sii_a", ["id"])]);

	test("counts tables, views and comment coverage, views apart", () => {
		const [stats] = schemaStats(shopWithComments, links);
		assert.ok(stats !== undefined);
		assert.equal(stats.database, "shop");
		assert.equal(stats.schema, "shop");
		assert.equal(stats.tables, 7);
		assert.equal(stats.views, 1);
		assert.equal(stats.tablesWithComment, 1);
		assert.equal(stats.columns, 11);
		assert.equal(stats.columnsWithComment, 1);
	});

	test("lists the top 5 name prefixes used by two tables or more", () => {
		const [stats] = schemaStats(shop, links);
		assert.deepEqual(stats?.prefixes, [
			{ prefix: "sii_", count: 3 },
			{ prefix: "log0-9", count: 2 },
		]);
	});

	test("ranks main tables by incoming references (declared, implicit and name pattern)", () => {
		const [stats] = schemaStats(shop, links);
		assert.deepEqual(
			stats?.mainTables.map((item) => [item.name, item.incoming]),
			[
				["shop.shop.gar", 2],
				["shop.shop.sii_a", 1],
				["shop.shop.sii_c", 1],
			],
		);
	});

	test("an empty schema has zeros and nothing to rank", () => {
		const [stats] = schemaStats(snapshot([]), emptyKnowledge());
		assert.deepEqual(stats, {
			database: "shop",
			schema: "shop",
			tables: 0,
			views: 0,
			tablesWithComment: 0,
			columns: 0,
			columnsWithComment: 0,
			prefixes: [],
			mainTables: [],
		});
	});
});
