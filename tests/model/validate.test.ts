import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Snapshot } from "../../lib/model/snapshot.ts";
import { validateSnapshot } from "../../lib/model/validate.ts";
import { column, customersTable, ordersTable, snapshot } from "../fixtures/snapshot.ts";

// A JSON copy, as loadSnapshot would see it, that a test can damage freely.
function raw(value: Snapshot = full()): any {
	return JSON.parse(JSON.stringify(value));
}

function full(): Snapshot {
	return snapshot(
		[
			customersTable(),
			ordersTable({
				columns: [
					column("id", 1, { autoIncrement: true }),
					column("total", 2, { generated: { expression: "1", stored: true }, collation: "utf8mb4_bin", default: "0" }),
				],
				triggers: [{ name: "trg", timing: "BEFORE", events: ["INSERT", "UPDATE"] }],
			}),
			ordersTable({ name: "paid", kind: "view", storageEngine: null, rowEstimate: null, viewDefinition: "select 1" }),
		],
		{ warnings: [{ code: "x", message: "y", target: "shop.shop.orders" }, { code: "z", message: "w" }] },
	);
}

const TABLE = "databases[0].schemas[0].tables[1]";

describe("validateSnapshot", () => {
	test("accepts a complete snapshot and returns an equal value", () => {
		assert.deepEqual(validateSnapshot(raw()), full());
	});

	test("keeps an absent warning target absent", () => {
		const result = validateSnapshot(raw());
		assert.equal("target" in result.warnings[1]!, false);
	});

	test("drops fields heydb does not know, so they are never written back", () => {
		const data = raw();
		data.extra = 1;
		data.databases[0].schemas[0].tables[0].extra = 2;
		assert.deepEqual(validateSnapshot(data), full());
	});

	const cases: [string, (data: any) => void, string][] = [
		["root not an object", () => {}, "snapshot must be an object"],
		["formatVersion", (d) => (d.formatVersion = 2), "formatVersion must be 1"],
		["engine kind", (d) => (d.engine.kind = "oracle"), 'engine.kind must be one of "mysql", "mariadb", "postgresql"'],
		["engine version", (d) => (d.engine.version = 8), "engine.version must be a string"],
		["capturedAt", (d) => delete d.capturedAt, "capturedAt is missing"],
		["databases", (d) => (d.databases = {}), "databases must be a list"],
		["database name", (d) => (d.databases[0].name = null), "databases[0].name must be a string"],
		["schemas", (d) => delete d.databases[0].schemas, "databases[0].schemas is missing"],
		["routines", (d) => (d.databases[0].schemas[0].routines = [{ name: "r", kind: "job" }]),
			'databases[0].schemas[0].routines[0].kind must be one of "procedure", "function"'],
		["table entry", (d) => (d.databases[0].schemas[0].tables[1] = "orders"), `${TABLE} must be an object`],
		["table kind", (d) => (d.databases[0].schemas[0].tables[1].kind = "TABLE"), `${TABLE}.kind must be one of "table", "view"`],
		["table comment", (d) => (d.databases[0].schemas[0].tables[1].comment = null), `${TABLE}.comment must be a string`],
		["storage engine", (d) => (d.databases[0].schemas[0].tables[1].storageEngine = 1), `${TABLE}.storageEngine must be a string or null`],
		["row estimate", (d) => (d.databases[0].schemas[0].tables[1].rowEstimate = "12"), `${TABLE}.rowEstimate must be a non-negative integer or null`],
		["primary key", (d) => (d.databases[0].schemas[0].tables[1].primaryKey = ["id", 2]), `${TABLE}.primaryKey[1] must be a string`],
		["view definition missing (files saved before view definitions)", (d) => delete d.databases[0].schemas[0].tables[1].viewDefinition,
			`${TABLE}.viewDefinition is missing`],
		["column nullable", (d) => (d.databases[0].schemas[0].tables[1].columns[1].nullable = "NO"), `${TABLE}.columns[1].nullable must be a boolean`],
		["column position", (d) => (d.databases[0].schemas[0].tables[1].columns[0].position = 0), `${TABLE}.columns[0].position must be a positive integer`],
		["column type", (d) => delete d.databases[0].schemas[0].tables[1].columns[0].type, `${TABLE}.columns[0].type is missing`],
		["column default", (d) => (d.databases[0].schemas[0].tables[1].columns[0].default = 0), `${TABLE}.columns[0].default must be a string or null`],
		["column auto increment", (d) => (d.databases[0].schemas[0].tables[1].columns[0].autoIncrement = 1), `${TABLE}.columns[0].autoIncrement must be a boolean`],
		["column collation", (d) => delete d.databases[0].schemas[0].tables[1].columns[0].collation, `${TABLE}.columns[0].collation is missing`],
		["generated", (d) => (d.databases[0].schemas[0].tables[1].columns[1].generated = "1"), `${TABLE}.columns[1].generated must be an object or null`],
		["generated stored", (d) => (d.databases[0].schemas[0].tables[1].columns[1].generated.stored = "yes"), `${TABLE}.columns[1].generated.stored must be a boolean`],
		["index unique", (d) => (d.databases[0].schemas[0].tables[1].indexes[0].unique = 0), `${TABLE}.indexes[0].unique must be a boolean`],
		["index columns", (d) => (d.databases[0].schemas[0].tables[1].indexes[0].columns = "id"), `${TABLE}.indexes[0].columns must be a list`],
		["index method", (d) => (d.databases[0].schemas[0].tables[1].indexes[0].method = null), `${TABLE}.indexes[0].method must be a string`],
		["fk onDelete", (d) => (d.databases[0].schemas[0].tables[1].foreignKeys[0].onDelete = "cascade"),
			`${TABLE}.foreignKeys[0].onDelete must be one of "CASCADE", "SET NULL", "SET DEFAULT", "RESTRICT", "NO ACTION"`],
		["fk references", (d) => delete d.databases[0].schemas[0].tables[1].foreignKeys[0].references.table,
			`${TABLE}.foreignKeys[0].references.table is missing`],
		["trigger timing", (d) => (d.databases[0].schemas[0].tables[1].triggers[0].timing = "DURING"),
			`${TABLE}.triggers[0].timing must be one of "BEFORE", "AFTER", "INSTEAD OF"`],
		["trigger event", (d) => (d.databases[0].schemas[0].tables[1].triggers[0].events[1] = "SELECT"),
			`${TABLE}.triggers[0].events[1] must be one of "INSERT", "UPDATE", "DELETE", "TRUNCATE"`],
		["warnings", (d) => delete d.warnings, "warnings is missing"],
		["warning target", (d) => (d.warnings[0].target = null), "warnings[0].target must be a string when present"],
		["warning message", (d) => (d.warnings[1].message = 3), "warnings[1].message must be a string"],
	];

	for (const [label, damage, message] of cases) {
		test(`names the exact path of a bad value: ${label}`, () => {
			const data = label === "root not an object" ? [] : raw();
			damage(data);
			assert.throws(() => validateSnapshot(data), (error: Error) => {
				assert.equal(error.message, message);
				return true;
			});
		});
	}
});
