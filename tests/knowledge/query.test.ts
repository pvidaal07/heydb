import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { findOrphans, knowledgeForTable, relationshipsInto, snapshotLookup } from "../../lib/knowledge/query.ts";
import type { Relationship } from "../../lib/knowledge/types.ts";
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

describe("relationships across connections", () => {
	// Stored in crm's file: crm.clientes(cod_erp) → erp:cus(cod).
	const toErp: Relationship = {
		...relationship("x1", "crm.crm.clientes", ["cod_erp"], "erp.erp.cus", ["cod"]),
		to: { connection: "erp", table: "erp.erp.cus", columns: ["cod"] },
	};
	const cus = { ...customersTable(), name: "cus", columns: [column("cod", 1)] };
	const erpSnapshot = snapshot([], { databases: [{ name: "erp", schemas: [{ name: "erp", tables: [cus], routines: [] }] }] });
	const crmSnapshot = snapshot([], {
		databases: [{ name: "crm", schemas: [{ name: "crm", tables: [{ ...cus, name: "clientes", columns: [column("cod_erp", 1)] }], routines: [] }] }],
	});

	test("knowledgeForTable never takes a side in another connection for a table of this one", () => {
		// The same canonical name, but in erp: crm's own erp.erp.cus is not its target.
		assert.deepEqual(knowledgeForTable(knowledge([], [toErp]), "erp.erp.cus").relationships, []);
		assert.deepEqual(knowledgeForTable(knowledge([], [toErp]), "crm.crm.clientes").relationships, [toErp]);
	});

	test("relationshipsInto finds what another connection's file says points to a table of this one", () => {
		const local = relationship("x2", "erp.erp.cus", ["cod"], "erp.erp.cus", ["cod"]);
		assert.deepEqual(relationshipsInto(knowledge([], [toErp, local]), "erp", "erp.erp.cus"), [toErp]);
		assert.deepEqual(relationshipsInto(knowledge([], [toErp]), "erp", "erp.erp.other"), []);
		assert.deepEqual(relationshipsInto(knowledge([], [toErp]), "sales", "erp.erp.cus"), []);
	});

	test("findOrphans checks the other side against the other connection's snapshot", () => {
		const k = knowledge([], [toErp]);
		assert.deepEqual(findOrphans(k, crmSnapshot, (name) => (name === "erp" ? snapshotLookup(erpSnapshot) : null)).relationships, []);
		const dropped = snapshot([], { databases: [{ name: "erp", schemas: [{ name: "erp", tables: [{ ...cus, columns: [column("id", 1)] }], routines: [] }] }] });
		assert.deepEqual(findOrphans(k, crmSnapshot, () => snapshotLookup(dropped)).relationships, [toErp]);
		assert.deepEqual(findOrphans(k, crmSnapshot, () => null).relationships, [toErp], "connection gone or never synced");
	});

	test("findOrphans without other connections leaves their sides unchecked", () => {
		assert.deepEqual(findOrphans(knowledge([], [toErp]), crmSnapshot).relationships, []);
	});
});
