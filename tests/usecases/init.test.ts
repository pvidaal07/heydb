import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { emptyConfig } from "../../lib/config/operations.ts";
import { loadConfig } from "../../lib/config/store.ts";
import { initProject } from "../../lib/usecases/init.ts";

const roots: string[] = [];

function tempDir(): string {
	const root = mkdtempSync(join(tmpdir(), "heydb-init-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("initProject", () => {
	test("creates .heydb/, its .gitignore and an empty config, and says so", () => {
		const root = tempDir();
		assert.deepEqual(initProject(root), { created: [".heydb/", ".heydb/.gitignore", ".heydb/config.json"] });

		const gitignore = readFileSync(join(root, ".heydb", ".gitignore"), "utf8");
		assert.match(gitignore, /^#/);
		assert.deepEqual(
			gitignore.split("\n").filter((line) => line !== "" && !line.startsWith("#")),
			[".env", "*.tmp"],
		);
		assert.deepEqual(loadConfig(root), emptyConfig());
	});

	test("is idempotent and never overwrites existing files", () => {
		const root = tempDir();
		mkdirSync(join(root, ".heydb"));
		writeFileSync(join(root, ".heydb", ".gitignore"), "custom\n");
		assert.deepEqual(initProject(root), { created: [".heydb/config.json"] });
		assert.equal(readFileSync(join(root, ".heydb", ".gitignore"), "utf8"), "custom\n");

		const config = readFileSync(join(root, ".heydb", "config.json"), "utf8");
		assert.deepEqual(initProject(root), { created: [] });
		assert.equal(readFileSync(join(root, ".heydb", "config.json"), "utf8"), config);
	});

	test("refuses a .heydb that is a symbolic link", () => {
		const root = tempDir();
		const elsewhere = tempDir();
		symlinkSync(elsewhere, join(root, ".heydb"), "dir");
		assert.throws(() => initProject(root), { message: ".heydb is a symbolic link; heydb refuses to follow it" });
	});

	test("refuses a .gitignore or config.json that is a symbolic link, and writes nothing", () => {
		for (const file of [".gitignore", "config.json"]) {
			const root = tempDir();
			mkdirSync(join(root, ".heydb"));
			symlinkSync(join(tempDir(), "target"), join(root, ".heydb", file));
			assert.throws(() => initProject(root), { message: `.heydb/${file} is a symbolic link; heydb refuses to follow it` });
			assert.deepEqual(readdirSync(join(root, ".heydb")), [file]);
		}
	});

	test("refuses a .heydb that is a file", () => {
		const root = tempDir();
		writeFileSync(join(root, ".heydb"), "");
		assert.throws(() => initProject(root), { message: ".heydb exists but is not a directory" });
	});
});
