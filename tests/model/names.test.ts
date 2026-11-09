import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { displayName, displayNameOf, formatDatabaseName, formatName, parseName, parseSegments } from "../../lib/model/names.ts";

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

describe("formatDatabaseName", () => {
	test("uses the same quoting rule as the segments of formatName", () => {
		assert.equal(formatDatabaseName("shop"), "shop");
		assert.equal(formatDatabaseName("v1.old"), '"v1.old"');
		assert.equal(formatDatabaseName('say"hi'), '"say""hi"');
		assert.equal(formatDatabaseName(""), '""');
	});

	test("is the first segment of the canonical name", () => {
		for (const database of ["shop", "v1.old", 'a"b', ""]) {
			assert.equal(formatName({ database, schema: "x" }), `${formatDatabaseName(database)}.x`);
		}
	});
});

describe("parseSegments", () => {
	test("splits any number of segments with the parseName rules", () => {
		assert.deepEqual(parseSegments("orders"), ["orders"]);
		assert.deepEqual(parseSegments('shop."v1.old"'), ["shop", "v1.old"]);
		assert.deepEqual(parseSegments("a.b.c.d.e"), ["a", "b", "c", "d", "e"]);
	});

	test("rejects the same malformed input as parseName", () => {
		assert.throws(() => parseSegments(""), /empty segment must be written as ""/);
		assert.throws(() => parseSegments('"open'), /unterminated quote/);
	});
});

describe("displayName", () => {
	test("omits the schema when it repeats the database, as MySQL and MariaDB name things", () => {
		assert.equal(displayName({ database: "shop", schema: "shop" }), "shop");
		assert.equal(displayName({ database: "shop", schema: "shop", table: "orders" }), "shop.orders");
		assert.equal(displayName({ database: "shop", schema: "shop", table: "orders", column: "total" }), "shop.orders.total");
	});

	test("keeps every level when the schema differs, as in PostgreSQL", () => {
		assert.equal(displayName({ database: "app", schema: "public", table: "orders", column: "total" }), "app.public.orders.total");
		assert.equal(displayName({ database: "app", schema: "public" }), "app.public");
	});

	test("quotes segments with the canonical rule", () => {
		assert.equal(displayName({ database: "v1.old", schema: "v1.old", table: 'a"b' }), '"v1.old"."a""b"');
	});

	test("displayNameOf reads a canonical name and never changes what it names", () => {
		assert.equal(displayNameOf("shop.shop.orders"), "shop.orders");
		assert.equal(displayNameOf("app.public.orders"), "app.public.orders");
		assert.throws(() => displayNameOf("orders"), /expected 2 to 4 segments/);
	});
});
