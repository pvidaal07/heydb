import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { emptyKnowledge } from "../lib/knowledge/operations.ts";
import type { Snapshot } from "../lib/model/snapshot.ts";
import { normalizeText, type SearchResult, searchSchema } from "../lib/search.ts";
import { column, customersTable, ordersTable, snapshot } from "./fixtures/snapshot.ts";
import { annotation, knowledge, relationship } from "./knowledge/fixtures.ts";

const legacy: Snapshot = snapshot([
	ordersTable({ comment: "Pedidos de la tienda" }),
	customersTable(),
	ordersTable({
		name: "facturación",
		columns: [column("id", 1), column("año", 2, { comment: "Año fiscal de la factura" })],
	}),
	ordersTable({ name: "order_lines", columns: [column("order_id", 1)] }),
	ordersTable({
		name: "v_orders",
		kind: "view",
		rowEstimate: null,
		viewDefinition: "select `id` from `shop`.`orders` where `status` = 'DEVUELTO'",
	}),
]);

const notes = knowledge(
	[
		annotation("a-db", "shop.shop", { text: "Base principal de la tienda online" }),
		annotation("a-col", "shop.shop.orders.total", { text: "Incluye IVA.\nSin gastos de envío." }),
	],
	[{ ...relationship("r-1", "shop.shop.orders", ["customer_id"], "shop.shop.customers", ["id"]), note: "Sin FK: tablas MyISAM" }],
);

function lines(results: readonly SearchResult[]): string[] {
	return results.map((result) => `${result.matchedIn} ${result.object} ${result.target}`);
}

describe("normalizeText", () => {
	test("ignores case and accents, composed or not", () => {
		assert.equal(normalizeText("FacturaCIÓN Año"), "facturacion ano");
		assert.equal(normalizeText("factura\u0301cio\u0301n"), "facturacion");
	});
});

describe("searchSchema", () => {
	test("ranks exact name, then name prefix, then name contains", () => {
		assert.deepEqual(lines(searchSchema(legacy, emptyKnowledge(), "order").results), [
			"name table shop.shop.order_lines",
			"name table shop.shop.orders",
			"name column shop.shop.order_lines.order_id",
			"name view shop.shop.v_orders",
		]);
		assert.deepEqual(lines(searchSchema(legacy, emptyKnowledge(), "orders").results), [
			"name table shop.shop.orders",
			"name view shop.shop.v_orders",
		]);
	});

	test("one result per object: its best match", () => {
		// v_orders matches by name and by definition; only the name match is listed.
		const { results } = searchSchema(legacy, emptyKnowledge(), "orders");
		assert.equal(results.filter((result) => result.target === "shop.shop.v_orders").length, 1);
	});

	test("ignores accents and case on both sides", () => {
		assert.deepEqual(lines(searchSchema(legacy, emptyKnowledge(), "FACTURACION").results), ["name table shop.shop.facturación"]);
		assert.deepEqual(searchSchema(legacy, emptyKnowledge(), "fiscal").results, [
			{ target: "shop.shop.facturación.año", object: "column", matchedIn: "comment", snippet: "Año fiscal de la factura" },
		]);
	});

	test("finds view definitions, database names, annotations and relationship notes", () => {
		assert.deepEqual(searchSchema(legacy, emptyKnowledge(), "devuelto").results, [
			{
				target: "shop.shop.v_orders",
				object: "view",
				matchedIn: "definition",
				snippet: "select `id` from `shop`.`orders` where `status` = 'DEVUELTO'",
			},
		]);
		assert.deepEqual(lines(searchSchema(legacy, notes, "shop").results), [
			"name database shop",
			"definition view shop.shop.v_orders",
		]);
		assert.deepEqual(searchSchema(legacy, notes, "envio").results, [
			{
				target: "shop.shop.orders.total",
				object: "column",
				matchedIn: "annotation",
				snippet: "Incluye IVA. Sin gastos de envío.",
			},
		]);
		assert.deepEqual(searchSchema(legacy, notes, "myisam").results, [
			{
				target: "shop.shop.orders(customer_id) → shop.shop.customers(id)",
				object: "relationship",
				matchedIn: "relationship",
				snippet: "Sin FK: tablas MyISAM",
			},
		]);
	});

	test("ranks other text after names, databases first", () => {
		assert.deepEqual(lines(searchSchema(legacy, notes, "tienda").results), [
			"annotation database shop.shop",
			"comment table shop.shop.orders",
		]);
	});

	test("cuts a long text to a snippet of at most 120 characters around the match", () => {
		const long = `${"x".repeat(200)} la facturación anual ${"y".repeat(200)}`;
		const withLong = snapshot([ordersTable({ comment: long })]);
		const [result] = searchSchema(withLong, emptyKnowledge(), "facturacion anual").results;
		assert.ok(result !== undefined);
		assert.ok(result.snippet.length <= 120, `${result.snippet.length}`);
		assert.match(result.snippet, /^….* la facturación anual .*…$/);
	});

	test("returns the first `limit` results and the total", () => {
		const tables = Array.from({ length: 30 }, (_, index) => ordersTable({ name: `t_${String(index).padStart(2, "0")}`, columns: [] }));
		const many = snapshot(tables);
		const page = searchSchema(many, emptyKnowledge(), "t_");
		assert.equal(page.total, 30);
		assert.equal(page.results.length, 20);
		assert.equal(page.results[0]?.target, "shop.shop.t_00");
		assert.equal(searchSchema(many, emptyKnowledge(), "t_", { limit: 5 }).results.length, 5);
	});

	test("rejects an empty query", () => {
		assert.throws(() => searchSchema(legacy, emptyKnowledge(), "  "), { message: "search query must not be empty" });
	});
});
