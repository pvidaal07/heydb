import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { formatName, parseName } from "../../lib/model/names.ts";

describe("formatName", () => {
	test("joins database, schema, table and column with dots", () => {
		assert.equal(
			formatName({ database: "shop", schema: "public", table: "orders", column: "total" }),
			"shop.public.orders.total",
		);
	});

	test("stops at the deepest level given", () => {
		assert.equal(formatName({ database: "shop", schema: "public" }), "shop.public");
		assert.equal(formatName({ database: "shop", schema: "public", table: "orders" }), "shop.public.orders");
	});

	test("quotes a segment that contains a dot, doubling inner quotes", () => {
		assert.equal(
			formatName({ database: "shop", schema: "shop", table: 'v1.old"data' }),
			'shop.shop."v1.old""data"',
		);
	});

	test("quotes an empty segment so it does not vanish", () => {
		assert.equal(formatName({ database: "shop", schema: "" }), 'shop.""');
	});

	test("rejects a column without a table", () => {
		assert.throws(
			() => formatName({ database: "shop", schema: "public", column: "total" }),
			/column "total" needs a table/,
		);
	});
});

describe("parseName", () => {
	test("is the inverse of formatName, including quoted segments", () => {
		const refs = [
			{ database: "shop", schema: "public" },
			{ database: "shop", schema: "public", table: "orders" },
			{ database: "shop", schema: "public", table: "orders", column: "total" },
			{ database: "shop", schema: "shop", table: 'v1.old"data', column: "a.b" },
			{ database: "shop", schema: "" },
		];
		for (const ref of refs) {
			assert.deepEqual(parseName(formatName(ref)), ref);
		}
	});

	test("rejects fewer than two or more than four segments", () => {
		assert.throws(() => parseName("shop"), /expected 2 to 4 segments, got 1/);
		assert.throws(() => parseName("a.b.c.d.e"), /expected 2 to 4 segments, got 5/);
	});

	test("rejects an unterminated quote", () => {
		assert.throws(() => parseName('shop."public'), /unterminated quote/);
	});

	test("rejects text after a closing quote", () => {
		assert.throws(() => parseName('shop."public"x'), /unexpected "x" after closing quote/);
	});

	test("rejects an unquoted empty segment", () => {
		assert.throws(() => parseName("shop.public."), /empty segment must be written as ""/);
		assert.throws(() => parseName("shop..orders"), /empty segment must be written as ""/);
	});

	test("rejects a quote inside an unquoted segment", () => {
		assert.throws(() => parseName('shop.pub"lic'), /quote inside unquoted segment "pub"lic"/);
	});
});
