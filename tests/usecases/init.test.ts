import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { emptyConfig } from "../../lib/config/operations.ts";
import { loadConfig } from "../../lib/config/store.ts";
import { ensureEnvIgnored, initProject } from "../../lib/usecases/init.ts";

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
			["*.tmp", ".env"],
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

describe("ensureEnvIgnored", () => {
	const APPENDED = "# Added by heydb: .env holds local secrets for env:HEYDB_NAME references; never commit it.\n.env\n";

	function gitignore(root: string): string {
		return readFileSync(join(root, ".heydb", ".gitignore"), "utf8");
	}

	function projectWith(content: string | null): string {
		const root = tempDir();
		mkdirSync(join(root, ".heydb"));
		if (content !== null) writeFileSync(join(root, ".heydb", ".gitignore"), content);
		return root;
	}

	test("leaves a .gitignore that already ignores .env alone", () => {
		const root = tempDir();
		initProject(root);
		const before = gitignore(root);
		assert.equal(ensureEnvIgnored(root), false);
		assert.equal(gitignore(root), before);
	});

	test("writes the usual .gitignore when there is none", () => {
		const root = projectWith(null);
		assert.equal(ensureEnvIgnored(root), true);
		const fresh = tempDir();
		initProject(fresh);
		assert.equal(gitignore(root), gitignore(fresh));
	});

	test("appends .env to a .gitignore that lacks it or un-ignores it, keeping what was there", () => {
		const cases: [before: string, after: string][] = [
			["custom\n", `custom\n${APPENDED}`],
			["custom", `custom\n${APPENDED}`],
			[".env\n!.env\n", `.env\n!.env\n${APPENDED}`],
			["", APPENDED],
		];
		for (const [before, after] of cases) {
			const root = projectWith(before);
			assert.equal(ensureEnvIgnored(root), true, JSON.stringify(before));
			assert.equal(gitignore(root), after);
			assert.equal(ensureEnvIgnored(root), false, "a second call changes nothing");
		}
	});

	test("refuses a .gitignore that is a symbolic link", () => {
		const root = projectWith(null);
		symlinkSync(join(tempDir(), "target"), join(root, ".heydb", ".gitignore"));
		assert.throws(() => ensureEnvIgnored(root), { message: ".heydb/.gitignore is a symbolic link; heydb refuses to follow it" });
	});

	// The promise that matters: git itself agrees the secrets file is ignored.
	const git = spawnSync("git", ["--version"]).status === 0;
	test("git ignores .heydb/.env afterwards", { skip: !git && "git is not installed" }, () => {
		for (const before of [null, "custom\n", ".env\n!.env\n", "!.env\n"]) {
			const root = projectWith(before);
			execFileSync("git", ["init", "-q"], { cwd: root });
			ensureEnvIgnored(root);
			writeFileSync(join(root, ".heydb", ".env"), "HEYDB_A=x\n");
			const check = spawnSync("git", ["check-ignore", "-q", ".heydb/.env"], { cwd: root });
			assert.equal(check.status, 0, `not ignored after ${JSON.stringify(before)}`);
		}
	});

	test("git ignores .heydb/.env whatever the hand-edited .gitignore says before the rule", { skip: !git && "git is not installed" }, () => {
		const cases = ["  .env\n", "\t.env\n", ".env\n!*\n", ".env\n!.env*\n", ".env\n!**/.env\n", ".env\n!*env\n"];
		for (const before of cases) {
			const root = projectWith(before);
			execFileSync("git", ["init", "-q"], { cwd: root });
			ensureEnvIgnored(root);
			writeFileSync(join(root, ".heydb", ".env"), "HEYDB_A=x\n");
			const check = spawnSync("git", ["check-ignore", "-q", ".heydb/.env"], { cwd: root });
			assert.equal(check.status, 0, `not ignored after ${JSON.stringify(before)}`);
		}
	});

	test("trusts only a last rule that is exactly .env or /.env, ignoring blank lines, comments and trailing spaces", () => {
		for (const before of [".env\n", "/.env\n", "!.env\n.env  \n\n# done\n"]) {
			const root = projectWith(before);
			assert.equal(ensureEnvIgnored(root), false, JSON.stringify(before));
			assert.equal(gitignore(root), before);
		}
		for (const before of ["  .env\n", ".env\n*.tmp\n", ".env\n!*\n"]) {
			const root = projectWith(before);
			assert.equal(ensureEnvIgnored(root), true, JSON.stringify(before));
			assert.equal(gitignore(root), `${before}${APPENDED}`);
		}
	});
});
