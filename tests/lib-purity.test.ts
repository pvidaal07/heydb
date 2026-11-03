import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

// ADR-0003: the core in lib/ never depends on Pi, so it can also power a CLI or an MCP server.
test("lib/ never imports @earendil-works/*", () => {
	const dir = new URL("../lib/", import.meta.url);
	for (const file of readdirSync(dir, { recursive: true }) as string[]) {
		if (!file.endsWith(".ts")) continue;
		const source = readFileSync(new URL(file, dir), "utf8");
		assert.doesNotMatch(source, /from\s+["']@earendil-works\//, `lib/${file} imports Pi`);
	}
});
