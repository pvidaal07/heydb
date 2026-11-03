import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

// The core in lib/ must never depend on Pi: the same code has to power the Pi
// extension, a CLI and an MCP server. Only extensions/ may talk to Pi.
// Any mention of a Pi package specifier counts: static, side-effect, type-only
// and dynamic imports all start with a quoted "@earendil-works/" string.
test("lib/ never references @earendil-works/* packages", () => {
	const dir = new URL("../lib/", import.meta.url);
	for (const file of readdirSync(dir, { recursive: true }) as string[]) {
		if (!file.endsWith(".ts")) continue;
		const source = readFileSync(new URL(file, dir), "utf8");
		assert.doesNotMatch(source, /["'`]@earendil-works\//, `lib/${file} references a Pi package`);
	}
});
