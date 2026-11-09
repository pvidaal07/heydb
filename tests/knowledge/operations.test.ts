import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
	addAnnotation,
	addProjectNote,
	addRelationship,
	editAnnotation,
	emptyKnowledge,
	removeAnnotation,
	removeRelationship,
} from "../../lib/knowledge/operations.ts";
import { type Knowledge, PROJECT_TARGET } from "../../lib/knowledge/types.ts";
import { annotation, fixedClock, knowledge, relationship } from "./fixtures.ts";

// Freezes the whole tree, so any attempt to mutate the input throws in strict mode.
function frozen(value: Knowledge): Knowledge {
	const freeze = (item: unknown): void => {
		if (item === null || typeof item !== "object") return;
		Object.freeze(item);
		for (const child of Object.values(item)) freeze(child);
	};
	freeze(value);
	return value;
}

const ordersToCustomers = {
	from: { table: "shop.shop.orders", columns: ["customer_id"] },
	to: { table: "shop.shop.customers", columns: ["id"] },
	note: "",
	author: "ana",
};

describe("emptyKnowledge", () => {
	test("has no entries", () => {
		assert.deepEqual(emptyKnowledge(), { formatVersion: 1, annotations: [], relationships: [] });
	});
});

describe("addAnnotation", () => {
	test("adds a note with id, timestamps, trimmed text and author, and a canonical target", () => {
		const { knowledge: result, annotation: added } = addAnnotation(
			emptyKnowledge(),
			{ target: '"shop".shop.orders', text: "  One row per checkout.  ", author: " ana " },
			fixedClock(),
		);
		const expected = {
			id: "id-001",
			target: "shop.shop.orders",
			text: "One row per checkout.",
			author: "ana",
			createdAt: "2026-11-06T10:00:00.000Z",
			updatedAt: "2026-11-06T10:00:00.000Z",
		};
		assert.deepEqual(added, expected);
		assert.deepEqual(result, { formatVersion: 1, annotations: [expected], relationships: [] });
	});

	test("never mutates the input", () => {
		const input = frozen(knowledge([annotation("a", "shop.shop.orders")]));
		const before = JSON.stringify(input);
		addAnnotation(input, { target: "shop.shop.customers", text: "x", author: "ana" }, fixedClock());
		assert.equal(JSON.stringify(input), before);
	});

	test("keeps notes sorted by target, then creation time, then id, whatever the insertion order", () => {
		const clock = fixedClock();
		let result = emptyKnowledge();
		for (const target of ["shop.shop.orders.total", "shop.shop", "shop.shop.orders", "shop.shop.customers", "shop.shop.orders"]) {
			result = addAnnotation(result, { target, text: target, author: "ana" }, clock).knowledge;
		}
		assert.deepEqual(
			result.annotations.map((item) => `${item.target} ${item.id}`),
			[
				"shop.shop id-002",
				"shop.shop.customers id-004",
				"shop.shop.orders id-003",
				"shop.shop.orders id-005",
				"shop.shop.orders.total id-001",
			],
		);
	});

	test("defaults to the real clock and random UUIDs", () => {
		const { annotation: added } = addAnnotation(emptyKnowledge(), { target: "shop.shop", text: "x", author: "ana" });
		assert.match(added.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		assert.equal(new Date(added.createdAt).toISOString(), added.createdAt);
	});

	test("accepts exactly 4000 characters, counting emoji as one", () => {
		const text = `${"a".repeat(3999)}🙂`;
		assert.equal(addAnnotation(emptyKnowledge(), { target: "shop.shop", text, author: "ana" }, fixedClock()).annotation.text, text);
	});

	test("rejects invalid input with exact messages", () => {
		const add = (target: string, text: string, author: string) => () =>
			addAnnotation(emptyKnowledge(), { target, text, author }, fixedClock());
		assert.throws(add("shop.shop", "   ", "ana"), { message: "annotation text must not be empty" });
		assert.throws(add("shop.shop", "a".repeat(4001), "ana"), {
			message: "annotation text is too long: 4001 characters (max 4000)",
		});
		assert.throws(add("shop.shop", "x", "  "), { message: "author must not be empty" });
		assert.throws(add("shop", "x", "ana"), { message: 'invalid name "shop": expected 2 to 4 segments, got 1' });
	});
});

describe("editAnnotation", () => {
	test("replaces the text and updatedAt, and keeps id, target, author and createdAt", () => {
		const clock = fixedClock();
		const start = addAnnotation(emptyKnowledge(), { target: "shop.shop.orders", text: "old", author: "ana" }, clock);
		const { knowledge: result, annotation: edited } = editAnnotation(frozen(start.knowledge), "id-001", " new ", clock);
		assert.deepEqual(edited, { ...start.annotation, text: "new", updatedAt: "2026-11-06T10:00:01.000Z" });
		assert.deepEqual(result.annotations, [edited]);
		assert.equal(start.knowledge.annotations[0]?.text, "old");
	});

	test("rejects an unknown id and invalid text", () => {
		const start = knowledge([annotation("a", "shop.shop")]);
		assert.throws(() => editAnnotation(start, "nope", "x", fixedClock()), { message: 'unknown annotation id "nope"' });
		assert.throws(() => editAnnotation(start, "a", " ", fixedClock()), { message: "annotation text must not be empty" });
	});
});

describe("removeAnnotation", () => {
	test("removes the note and returns it", () => {
		const keep = annotation("b", "shop.shop.orders");
		const gone = annotation("a", "shop.shop");
		const start = frozen(knowledge([gone, keep]));
		assert.deepEqual(removeAnnotation(start, "a"), { knowledge: knowledge([keep]), annotation: gone });
		assert.equal(start.annotations.length, 2);
	});

	test("rejects an unknown id", () => {
		assert.throws(() => removeAnnotation(emptyKnowledge(), "nope"), { message: 'unknown annotation id "nope"' });
	});
});

describe("addRelationship", () => {
	test("adds an implicit foreign key with canonical table names and a trimmed note", () => {
		const { knowledge: result, relationship: added } = addRelationship(
			emptyKnowledge(),
			{ ...ordersToCustomers, from: { table: '"shop".shop.orders', columns: ["customer_id"] }, note: " legacy " },
			fixedClock(),
		);
		const expected = {
			id: "id-001",
			from: { table: "shop.shop.orders", columns: ["customer_id"] },
			to: { table: "shop.shop.customers", columns: ["id"] },
			note: "legacy",
			author: "ana",
			createdAt: "2026-11-06T10:00:00.000Z",
		};
		assert.deepEqual(added, expected);
		assert.deepEqual(result.relationships, [expected]);
	});

	test("accepts composite keys and self-references on different columns", () => {
		const clock = fixedClock();
		const composite = addRelationship(
			emptyKnowledge(),
			{ ...ordersToCustomers, from: { table: "shop.shop.lines", columns: ["order_id", "shop_id"] }, to: { table: "shop.shop.orders", columns: ["id", "shop_id"] } },
			clock,
		);
		const self = addRelationship(
			composite.knowledge,
			{ ...ordersToCustomers, from: { table: "shop.shop.staff", columns: ["manager_id"] }, to: { table: "shop.shop.staff", columns: ["id"] } },
			clock,
		);
		assert.equal(self.knowledge.relationships.length, 2);
	});

	test("keeps relationships sorted by from table, then to table, then id", () => {
		const clock = fixedClock();
		let result = emptyKnowledge();
		for (const [from, to] of [["shop.shop.orders", "shop.shop.users"], ["shop.shop.lines", "shop.shop.orders"], ["shop.shop.orders", "shop.shop.customers"]] as const) {
			result = addRelationship(result, { ...ordersToCustomers, from: { table: from, columns: ["a"] }, to: { table: to, columns: ["b"] } }, clock).knowledge;
		}
		assert.deepEqual(
			result.relationships.map((item) => `${item.from.table} > ${item.to.table}`),
			["shop.shop.lines > shop.shop.orders", "shop.shop.orders > shop.shop.customers", "shop.shop.orders > shop.shop.users"],
		);
	});

	test("rejects invalid relationships with exact messages", () => {
		const add = (change: Partial<typeof ordersToCustomers>, start: Knowledge = emptyKnowledge()) => () =>
			addRelationship(start, { ...ordersToCustomers, ...change }, fixedClock());
		assert.throws(add({ from: { table: "shop.shop", columns: ["a"] } }), {
			message: 'relationship from must be a table name (database.schema.table): got "shop.shop"',
		});
		assert.throws(add({ to: { table: "shop.shop.customers.id", columns: ["a"] } }), {
			message: 'relationship to must be a table name (database.schema.table): got "shop.shop.customers.id"',
		});
		assert.throws(add({ from: { table: "shop.shop.orders", columns: [] } }), {
			message: "relationship from.columns must not be empty",
		});
		assert.throws(add({ to: { table: "shop.shop.customers", columns: [""] } }), {
			message: "relationship to.columns[0] must not be empty",
		});
		assert.throws(add({ from: { table: "shop.shop.orders", columns: ["a", "a"] } }), {
			message: 'relationship from.columns repeats "a"',
		});
		assert.throws(add({ to: { table: "shop.shop.customers", columns: ["id", "shop_id"] } }), {
			message: "relationship sides must have the same number of columns: from has 1, to has 2",
		});
		assert.throws(add({ to: { table: "shop.shop.orders", columns: ["customer_id"] } }), {
			message: "relationship from and to are the same columns",
		});
		assert.throws(add({ author: "" }), { message: "author must not be empty" });
		assert.throws(add({ note: "a".repeat(4001) }), { message: "relationship note is too long: 4001 characters (max 4000)" });
		const existing = knowledge([], [relationship("r1", "shop.shop.orders", ["customer_id"], "shop.shop.customers", ["id"])]);
		assert.throws(add({ note: "again" }, existing), { message: 'relationship already exists (id "r1")' });
	});
});

describe("removeRelationship", () => {
	test("removes the relationship and returns it, without mutating the input", () => {
		const gone = relationship("r1", "shop.shop.orders", ["customer_id"], "shop.shop.customers", ["id"]);
		const start = frozen(knowledge([], [gone]));
		assert.deepEqual(removeRelationship(start, "r1"), { knowledge: emptyKnowledge(), relationship: gone });
		assert.equal(start.relationships.length, 1);
	});

	test("rejects an unknown id", () => {
		assert.throws(() => removeRelationship(emptyKnowledge(), "nope"), { message: 'unknown relationship id "nope"' });
	});
});

describe("relationships across connections", () => {
	const toErp = { ...ordersToCustomers, to: { connection: "erp", table: "erp.erp.cus", columns: ["cod"] } };

	test("keeps the connection of the other side", () => {
		const { relationship: added } = addRelationship(emptyKnowledge(), toErp, fixedClock());
		assert.deepEqual(added.to, { connection: "erp", table: "erp.erp.cus", columns: ["cod"] });
		assert.equal("connection" in added.from, false);
	});

	test("the same table name in another connection is a different side", () => {
		const local = { ...ordersToCustomers, to: { table: "erp.erp.cus", columns: ["cod"] } };
		const { knowledge: once } = addRelationship(emptyKnowledge(), local, fixedClock());
		const { knowledge: twice } = addRelationship(once, toErp, fixedClock());
		assert.equal(twice.relationships.length, 2);
		assert.throws(() => addRelationship(twice, toErp, fixedClock()), { message: /^relationship already exists/ });
	});

	test("rejects an empty connection", () => {
		assert.throws(() => addRelationship(emptyKnowledge(), { ...toErp, to: { ...toErp.to, connection: " " } }, fixedClock()), {
			message: "relationship to.connection must not be empty",
		});
	});
});

describe("addProjectNote", () => {
	test("adds a note about the whole project, target project", () => {
		const { knowledge: result, annotation: added } = addProjectNote(
			frozen(emptyKnowledge()),
			{ text: " One database per client. ", author: "ana" },
			fixedClock(),
		);
		assert.deepEqual(added, {
			id: "id-001",
			target: PROJECT_TARGET,
			text: "One database per client.",
			author: "ana",
			createdAt: "2026-11-06T10:00:00.000Z",
			updatedAt: "2026-11-06T10:00:00.000Z",
		});
		assert.deepEqual(result, knowledge([added]));
		assert.equal(PROJECT_TARGET, "project");
	});

	test("rejects empty text", () => {
		assert.throws(() => addProjectNote(emptyKnowledge(), { text: "  ", author: "ana" }), { message: "annotation text must not be empty" });
	});
});
