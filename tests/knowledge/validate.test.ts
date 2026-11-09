import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { validateKnowledge, validateProjectKnowledge } from "../../lib/knowledge/validate.ts";
import { annotation, knowledge, relationship } from "./fixtures.ts";

function valid(): any {
	return structuredClone(
		knowledge(
			[annotation("a1", "shop.shop"), annotation("a2", "shop.shop.orders.total")],
			[relationship("r1", "shop.shop.orders", ["customer_id", "shop_id"], "shop.shop.customers", ["id", "shop_id"])],
		),
	);
}

describe("validateKnowledge", () => {
	test("accepts a valid file and returns the same data", () => {
		assert.deepEqual(validateKnowledge(valid()), valid());
	});

	test("drops unknown fields and writes targets in canonical form", () => {
		const data = valid();
		data.extra = true;
		data.annotations[0].mood = "happy";
		data.annotations[0].target = '"shop".shop';
		data.relationships[0].from.table = '"shop"."shop".orders';
		const result = validateKnowledge(data);
		assert.deepEqual(result, valid());
	});

	const broken: [string, (data: any) => void, string][] = [
		["not an object", (data) => (data.annotations = 1), "annotations must be a list"],
		["wrong formatVersion", (data) => (data.formatVersion = 2), "formatVersion must be 1"],
		["missing field", (data) => delete data.annotations[1].target, "annotations[1].target is missing"],
		["wrong type", (data) => (data.annotations[0].text = 3), "annotations[0].text must be a string"],
		["empty id", (data) => (data.annotations[0].id = ""), "annotations[0].id must not be empty"],
		[
			"duplicated id",
			(data) => (data.annotations[1].id = "a1"),
			'annotations[1].id "a1" is already used by annotations[0]',
		],
		[
			"bad target",
			(data) => (data.annotations[0].target = "shop"),
			'annotations[0].target: invalid name "shop": expected 2 to 4 segments, got 1',
		],
		[
			"side is not a table",
			(data) => (data.relationships[0].from.table = "shop.shop"),
			'relationships[0].from.table must be a table name (database.schema.table): got "shop.shop"',
		],
		["empty columns", (data) => (data.relationships[0].to.columns = []), "relationships[0].to.columns must not be empty"],
		[
			"column not a string",
			(data) => (data.relationships[0].from.columns[1] = 7),
			"relationships[0].from.columns[1] must be a string",
		],
		[
			"different lengths",
			(data) => data.relationships[0].to.columns.pop(),
			"relationships[0].to.columns must have as many columns as from.columns (2)",
		],
		["side not an object", (data) => (data.relationships[0].to = "x"), "relationships[0].to must be an object"],
	];

	for (const [name, damage, message] of broken) {
		test(`rejects ${name} with the exact path`, () => {
			const data = valid();
			damage(data);
			assert.throws(() => validateKnowledge(data), { message });
		});
	}

	test("rejects a value that is not an object", () => {
		assert.throws(() => validateKnowledge([]), { message: "knowledge must be an object" });
	});
});

describe("validateKnowledge across connections", () => {
	test("a file written before cross-connection relationships loads with no connection on either side", () => {
		const [loaded] = validateKnowledge(valid()).relationships;
		assert.equal(loaded !== undefined && "connection" in loaded.from, false);
		assert.equal(loaded !== undefined && "connection" in loaded.to, false);
	});

	test("keeps the connection of a side that lives in another connection", () => {
		const data = valid();
		data.relationships[0].to.connection = "erp";
		assert.deepEqual(validateKnowledge(data).relationships[0]?.to, {
			connection: "erp",
			table: "shop.shop.customers",
			columns: ["id", "shop_id"],
		});
	});

	test("rejects a connection that is not a non-empty string", () => {
		for (const value of ["", 3]) {
			const data = valid();
			data.relationships[0].to.connection = value;
			assert.throws(() => validateKnowledge(data), { message: "relationships[0].to.connection must be a non-empty string" });
		}
	});
});

describe("validateProjectKnowledge", () => {
	const projectFile = (): any => structuredClone(knowledge([annotation("p1", "project"), annotation("p2", "project")]));

	test("accepts notes whose target is the literal project", () => {
		assert.deepEqual(validateProjectKnowledge(projectFile()), projectFile());
	});

	test("rejects a note on anything else, even a valid canonical name", () => {
		const data = projectFile();
		data.annotations[1].target = "shop.shop";
		assert.throws(() => validateProjectKnowledge(data), {
			message: 'annotations[1].target must be "project" in the project file: got "shop.shop"',
		});
	});

	test("rejects relationships: they belong to a connection", () => {
		const data = valid();
		data.annotations = [];
		assert.throws(() => validateProjectKnowledge(data), {
			message: "relationships must be empty: the project file holds only project notes",
		});
	});
});
