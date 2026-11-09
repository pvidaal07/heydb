import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { writeFileAtomic } from "../../lib/store/files.ts";

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "heydb-files-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Windows has no owner/group/other permission bits: Node maps a mode to the
// read-only flag only, so the permission checks run on POSIX systems.
const posix = process.platform !== "win32";

describe("writeFileAtomic", () => {
	test("writes the content and leaves no temporary file behind", () => {
		const dir = tempDir();
		const path = join(dir, "a.json");
		writeFileAtomic(path, "one");
		writeFileAtomic(path, "two");
		assert.equal(readFileSync(path, "utf8"), "two");
		assert.deepEqual(readdirSync(dir), ["a.json"]);
	});

	test("creates the file with the given mode, replacing a more open one", { skip: !posix && "no POSIX permissions on Windows" }, () => {
		const dir = tempDir();
		const path = join(dir, ".env");
		writeFileSync(path, "old", { mode: 0o644 });
		writeFileAtomic(path, "new", 0o600);
		assert.equal(statSync(path).mode & 0o777, 0o600);
		assert.equal(readFileSync(path, "utf8"), "new");
	});

	test("without a mode, keeps the usual permissions", { skip: !posix && "no POSIX permissions on Windows" }, () => {
		const dir = tempDir();
		writeFileSync(join(dir, "plain.json"), "{}");
		writeFileAtomic(join(dir, "config.json"), "{}");
		assert.equal(statSync(join(dir, "config.json")).mode & 0o777, statSync(join(dir, "plain.json")).mode & 0o777);
	});
});
