import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { emptyKnowledge } from "../../lib/knowledge/operations.ts";
import { knowledgePath, loadKnowledge, saveKnowledge } from "../../lib/store/knowledge.ts";
import { saveSnapshot } from "../../lib/store/snapshots.ts";
import {
	annotate,
	editNote,
	forgetAnnotation,
	forgetRelationship,
	orphanedKnowledge,
	relate,
	tableKnowledge,
} from "../../lib/usecases/knowledge.ts";
import { annotation, fixedClock, knowledge, relationship } from "../knowledge/fixtures.ts";
import { column, customersTable, ordersTable, snapshot } from "../fixtures/snapshot.ts";

const roots: string[] = [];

function projectRoot(synced = true): string {
	const root = mkdtempSync(join(tmpdir(), "heydb-knowledge-usecase-"));
	mkdirSync(join(root, ".heydb"));
	roots.push(root);
	if (synced) saveSnapshot(root, "local", snapshot([customersTable(), ordersTable()]));
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ordersToCustomers = {
	from: { table: "shop.shop.orders", columns: ["customer_id"] },
	to: { table: "shop.shop.customers", columns: ["id"] },
	note: "No FK: orders are MyISAM.",
	author: "ana",
};

describe("annotate", () => {
	test("saves notes on a database, a table and a column", () => {
		const root = projectRoot();
		const clock = fixedClock();
		const db = annotate(root, "local", { target: "shop.shop", text: "Main store.", author: "ana" }, clock);
		const table = annotate(root, "local", { target: "shop.shop.orders", text: "One per checkout.", author: "ana" }, clock);
		const col = annotate(root, "local", { target: "shop.shop.orders.total", text: "Includes VAT.", author: "ana" }, clock);
		assert.deepEqual(loadKnowledge(root, "local"), knowledge([db, table, col]));
		assert.equal(col.id, "id-003");
	});

	test("rejects a target that is not in the snapshot, and saves nothing", () => {
		const root = projectRoot();
		for (const target of ["shop.shop.orders.nope", "shop.shop.carts", "legacy.legacy"]) {
			assert.throws(() => annotate(root, "local", { target, text: "x", author: "ana" }, fixedClock()), {
				message: `${target} does not exist in the snapshot of "local"; if it was created recently, run sync first`,
			});
		}
		assert.deepEqual(loadKnowledge(root, "local"), emptyKnowledge());
	});

	test("rejects every annotation before the first sync", () => {
		assert.throws(() => annotate(projectRoot(false), "local", { target: "shop.shop", text: "x", author: "ana" }), {
			message: 'connection "local" was never synced: run sync first',
		});
	});

	test("propagates validation errors from the operation", () => {
		assert.throws(() => annotate(projectRoot(), "local", { target: "shop.shop", text: " ", author: "ana" }), {
			message: "annotation text must not be empty",
		});
	});
});

describe("relate", () => {
	test("saves an implicit foreign key between existing columns", () => {
		const root = projectRoot();
		const added = relate(root, "local", ordersToCustomers, fixedClock());
		assert.deepEqual(added, {
			id: "id-001",
			from: { table: "shop.shop.orders", columns: ["customer_id"] },
			to: { table: "shop.shop.customers", columns: ["id"] },
			note: "No FK: orders are MyISAM.",
			author: "ana",
			createdAt: "2026-11-06T10:00:00.000Z",
		});
		assert.deepEqual(loadKnowledge(root, "local").relationships, [added]);
	});

	test("names the first missing table or column", () => {
		const root = projectRoot();
		const cases: [Partial<typeof ordersToCustomers>, string][] = [
			[{ from: { table: "shop.shop.carts", columns: ["id"] } }, "shop.shop.carts"],
			[{ from: { table: "shop.shop.orders", columns: ["customer_id", "shop_id"] }, to: { table: "shop.shop.customers", columns: ["id", "x"] } }, "shop.shop.orders.shop_id"],
			[{ to: { table: "shop.shop.customers", columns: ["uuid"] } }, "shop.shop.customers.uuid"],
		];
		for (const [change, missing] of cases) {
			assert.throws(() => relate(root, "local", { ...ordersToCustomers, ...change }, fixedClock()), {
				message: `${missing} does not exist in the snapshot of "local"; if it was created recently, run sync first`,
			});
		}
		assert.deepEqual(loadKnowledge(root, "local"), emptyKnowledge());
	});
});

describe("editNote / forgetAnnotation / forgetRelationship", () => {
	test("edit and forget work by id, also on orphaned entries", () => {
		const root = projectRoot();
		const orphanNote = annotation("a1", "shop.shop.orders.legacy_flag");
		const orphanLink = relationship("r1", "shop.shop.carts", ["id"], "shop.shop.orders", ["id"]);
		saveKnowledge(root, "local", knowledge([orphanNote, annotation("a2", "shop.shop.orders")], [orphanLink]));

		const edited = editNote(root, "local", { id: "a1", text: "Was 1 for wholesale." }, fixedClock());
		assert.deepEqual(edited, { ...orphanNote, text: "Was 1 for wholesale.", updatedAt: "2026-11-06T10:00:00.000Z" });
		assert.deepEqual(forgetAnnotation(root, "local", "a1"), edited);
		assert.deepEqual(forgetRelationship(root, "local", "r1"), orphanLink);
		assert.deepEqual(loadKnowledge(root, "local"), knowledge([annotation("a2", "shop.shop.orders")]));
	});

	test("unknown ids leave the file untouched", () => {
		const root = projectRoot();
		saveKnowledge(root, "local", knowledge([annotation("a1", "shop.shop")]));
		const before = readFileSync(knowledgePath(root, "local"), "utf8");
		assert.throws(() => forgetAnnotation(root, "local", "nope"), { message: 'unknown annotation id "nope"' });
		assert.throws(() => forgetRelationship(root, "local", "nope"), { message: 'unknown relationship id "nope"' });
		assert.throws(() => editNote(root, "local", { id: "nope", text: "x" }), { message: 'unknown annotation id "nope"' });
		assert.equal(readFileSync(knowledgePath(root, "local"), "utf8"), before);
	});
});

describe("tableKnowledge", () => {
	test("returns database, table and column notes plus relationships (v1 only returned table notes)", () => {
		const root = projectRoot();
		const clock = fixedClock();
		const db = annotate(root, "local", { target: "shop.shop", text: "Main store.", author: "ana" }, clock);
		const table = annotate(root, "local", { target: "shop.shop.orders", text: "One per checkout.", author: "ana" }, clock);
		const col = annotate(root, "local", { target: "shop.shop.orders.total", text: "Includes VAT.", author: "ana" }, clock);
		annotate(root, "local", { target: "shop.shop.customers", text: "Other table.", author: "ana" }, clock);
		const link = relate(root, "local", ordersToCustomers, clock);
		assert.deepEqual(tableKnowledge(root, "local", "shop.shop.orders"), {
			database: [db],
			table: [table],
			columns: { total: [col] },
			relationships: [link],
		});
	});

	test("is empty when nothing was annotated yet", () => {
		assert.deepEqual(tableKnowledge(projectRoot(false), "local", "shop.shop.orders"), {
			database: [],
			table: [],
			columns: {},
			relationships: [],
		});
	});
});

describe("orphanedKnowledge", () => {
	test("reports knowledge about a dropped column after a sync, and keeps it in the file", () => {
		const root = projectRoot();
		const clock = fixedClock();
		const col = annotate(root, "local", { target: "shop.shop.orders.total", text: "Includes VAT.", author: "ana" }, clock);
		annotate(root, "local", { target: "shop.shop.orders", text: "One per checkout.", author: "ana" }, clock);
		saveSnapshot(root, "local", snapshot([customersTable(), ordersTable({ columns: [column("id", 1), column("customer_id", 2)] })]));
		const before = readFileSync(knowledgePath(root, "local"), "utf8");
		assert.deepEqual(orphanedKnowledge(root, "local"), { annotations: [col], relationships: [] });
		assert.equal(readFileSync(knowledgePath(root, "local"), "utf8"), before);
	});

	test("needs a snapshot to compare with", () => {
		assert.throws(() => orphanedKnowledge(projectRoot(false), "local"), {
			message: 'connection "local" was never synced: run sync first',
		});
	});
});
