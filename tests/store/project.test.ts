import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { findProjectRoot } from "../../lib/store/project.ts";

function tempDir(): string {
	// realpath: on macOS the temp dir is a symlink (/var → /private/var).
	return realpathSync(mkdtempSync(join(tmpdir(), "heydb-project-")));
}

describe("findProjectRoot", () => {
	test("finds .heydb/ in the start directory", () => {
		const root = tempDir();
		mkdirSync(join(root, ".heydb"));
		assert.equal(findProjectRoot(root), root);
	});

	test("finds .heydb/ in an ancestor, so commands work from any subdirectory", () => {
		const root = tempDir();
		mkdirSync(join(root, ".heydb"));
		const nested = join(root, "src", "app", "models");
		mkdirSync(nested, { recursive: true });
		assert.equal(findProjectRoot(nested), root);
	});

	test("returns the nearest project when projects are nested", () => {
		const outer = tempDir();
		mkdirSync(join(outer, ".heydb"));
		const inner = join(outer, "packages", "api");
		mkdirSync(join(inner, ".heydb"), { recursive: true });
		assert.equal(findProjectRoot(join(inner)), inner);
	});

	test("returns null when no ancestor has .heydb/", () => {
		assert.equal(findProjectRoot(tempDir()), null);
	});

	test("ignores a file named .heydb", () => {
		const root = tempDir();
		writeFileSync(join(root, ".heydb"), "not a directory");
		assert.equal(findProjectRoot(root), null);
	});
});
