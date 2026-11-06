import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { findOrphans, knowledgeForTable } from "../../lib/knowledge/query.ts";
import { column, customersTable, ordersTable, snapshot } from "../fixtures/snapshot.ts";
import { annotation, knowledge, relationship } from "./fixtures.ts";

describe("knowledgeForTable", () => {
	const dbNote = annotation("d1", "shop.shop");
	const otherDbNote = annotation("d2", "legacy.legacy");
	const tableNote = annotation("t1", "shop.shop.orders");
	const sameNameOtherDb = annotation("t2", "legacy.legacy.orders");
	const otherTable = annotation("t3", "shop.shop.customers");
	const totalNote = annotation("c1", "shop.shop.orders.total");
	const totalNote2 = annotation("c2", "shop.shop.orders.total");
	const idNote = annotation("c3", "shop.shop.orders.id");
	const outgoing = relationship("r1", "shop.shop.orders", ["customer_id"], "shop.shop.customers", ["id"]);
	const incoming = relationship("r2", "shop.shop.lines", ["order_id"], "shop.shop.orders", ["id"]);
	const unrelated = relationship("r3", "shop.shop.lines", ["sku"], "shop.shop.products", ["sku"]);
	const all = knowledge(
		[dbNote, otherDbNote, tableNote, sameNameOtherDb, otherTable, totalNote, totalNote2, idNote],
		[outgoing, incoming, unrelated],
	);

	test("returns database, table and column notes and the relationships on either side", () => {
		assert.deepEqual(knowledgeForTable(all, "shop.shop.orders"), {
			database: [dbNote],
			table: [tableNote],
			columns: { total: [totalNote, totalNote2], id: [idNote] },
			relationships: [outgoing, incoming],
		});
	});

	test("never mixes a table with the same name in another database", () => {
		const result = knowledgeForTable(all, "legacy.legacy.orders");
		assert.deepEqual(result.database, [otherDbNote]);
		assert.deepEqual(result.table, [sameNameOtherDb]);
		assert.deepEqual(result.columns, {});
		assert.deepEqual(result.relationships, []);
	});

	test("accepts any spelling of the canonical name", () => {
		assert.deepEqual(knowledgeForTable(all, '"shop"."shop".orders'), knowledgeForTable(all, "shop.shop.orders"));
	});

	test("finds column notes whose names need quotes", () => {
		const dotted = annotation("q1", 'shop.shop.orders."v1.total"');
		assert.deepEqual(knowledgeForTable(knowledge([dotted]), "shop.shop.orders").columns, { "v1.total": [dotted] });
	});

	test("rejects a name that is not a table", () => {
		assert.throws(() => knowledgeForTable(all, "shop.shop"), {
			message: 'expected a table name (database.schema.table): got "shop.shop"',
		});
	});
});

describe("findOrphans", () => {
	const live = snapshot([customersTable(), ordersTable()]);
	const dbNote = annotation("d1", "shop.shop");
	const tableNote = annotation("t1", "shop.shop.orders");
	const totalNote = annotation("c1", "shop.shop.orders.total");
	const fk = relationship("r1", "shop.shop.orders", ["customer_id"], "shop.shop.customers", ["id"]);
	const all = knowledge([dbNote, tableNote, totalNote], [fk]);

	test("finds nothing when every target exists", () => {
		assert.deepEqual(findOrphans(all, live), { annotations: [], relationships: [] });
	});

	test("reports notes on a removed column and relationships that use it", () => {
		const withoutTotal = snapshot([
			customersTable(),
			ordersTable({ columns: [column("id", 1), column("customer_id", 2)] }),
		]);
		const usesTotal = relationship("r2", "shop.shop.customers", ["id"], "shop.shop.orders", ["total"]);
		const input = knowledge([dbNote, tableNote, totalNote], [fk, usesTotal]);
		assert.deepEqual(findOrphans(input, withoutTotal), { annotations: [totalNote], relationships: [usesTotal] });
		assert.equal(input.annotations.length, 3, "orphans are reported, never removed");
	});

	test("reports everything anchored to a removed table, and notes on an unknown database", () => {
		const onlyOrders = snapshot([ordersTable()]);
		const emailNote = annotation("c2", "shop.shop.customers.email");
		const customersNote = annotation("t2", "shop.shop.customers");
		const legacyNote = annotation("d2", "legacy.legacy");
		const result = findOrphans(knowledge([legacyNote, dbNote, customersNote, emailNote, tableNote], [fk]), onlyOrders);
		assert.deepEqual(result, { annotations: [legacyNote, customersNote, emailNote], relationships: [fk] });
	});
});
