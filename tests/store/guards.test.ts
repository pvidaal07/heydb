import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { assertConnectionName, toConnectionName } from "../../lib/store/guards.ts";

describe("toConnectionName", () => {
	test("turns what a person types into a valid connection name", () => {
		const cases: [string, string][] = [
			["Eagle", "eagle"],
			["  Prod EU  ", "prod-eu"],
			["Producción", "produccion"],
			["db.internal", "db-internal"],
			["Clientes__2024", "clientes__2024"],
			["--Legacy--", "legacy"],
		];
		for (const [input, expected] of cases) {
			assert.equal(toConnectionName(input), expected, input);
			assert.doesNotThrow(() => assertConnectionName(expected));
		}
	});

	test("cuts long names to 64 characters", () => {
		assert.equal(toConnectionName("A".repeat(80)), "a".repeat(64));
	});

	test("avoids names Windows reserves", () => {
		assert.equal(toConnectionName("CON"), "con-db");
		assert.equal(toConnectionName("nul"), "nul-db");
	});

	test("returns null when nothing usable is left", () => {
		assert.equal(toConnectionName(""), null);
		assert.equal(toConnectionName("   "), null);
		assert.equal(toConnectionName("!!!"), null);
	});
});
