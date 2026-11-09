import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { type GitRun, type RunGit, SHARE_NOTES_HINT, knowledgeSharing } from "../../lib/usecases/sharing.ts";

const roots: string[] = [];

function tempDir(): string {
	const root = mkdtempSync(join(tmpdir(), "heydb-sharing-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A git that answers `answer` and records how it was called. */
function fakeGit(answer: GitRun | "missing") {
	const calls: { args: readonly string[]; cwd: string }[] = [];
	const runGit: RunGit = async (args, cwd) => {
		calls.push({ args, cwd });
		return answer;
	};
	return { runGit, calls };
}

describe("knowledgeSharing", () => {
	test("asks git whether it ignores the connection's notes file, from the project root", async () => {
		const { runGit, calls } = fakeGit({ exitCode: 1, stdout: "", stderr: "" });
		assert.deepEqual(await knowledgeSharing("/project", { connection: "local", runGit }), { state: "shared" });
		assert.deepEqual(calls, [{ args: ["check-ignore", "-v", "--", ".heydb/knowledge/local.json"], cwd: "/project" }]);
	});

	test("reports the rule that ignores the notes", async () => {
		const { runGit } = fakeGit({ exitCode: 0, stdout: ".gitignore:26:.heydb/\t.heydb/knowledge/local.json\n", stderr: "" });
		assert.deepEqual(await knowledgeSharing("/project", { connection: "local", runGit }), {
			state: "ignored",
			rule: ".gitignore:26: .heydb/",
		});
	});

	test("a negated rule (!pattern) re-includes the notes: they are shared", async () => {
		const { runGit } = fakeGit({ exitCode: 0, stdout: ".gitignore:2:!.heydb/knowledge/local.json\t.heydb/knowledge/local.json\n", stderr: "" });
		assert.deepEqual(await knowledgeSharing("/project", { connection: "local", runGit }), { state: "shared" });
	});

	test("without git, or outside a repository, there is nothing to share through", async () => {
		assert.deepEqual(await knowledgeSharing("/project", { connection: "local", runGit: fakeGit("missing").runGit }), { state: "no-git" });
		const outside = fakeGit({ exitCode: 128, stdout: "", stderr: "fatal: not a git repository (or any of the parent directories): .git\n" });
		assert.deepEqual(await knowledgeSharing("/project", { connection: "local", runGit: outside.runGit }), { state: "no-git" });
	});

	test("any other git failure is an error that says what was asked", async () => {
		const { runGit } = fakeGit({ exitCode: 128, stdout: "", stderr: "fatal: detected dubious ownership in repository\nmore\n" });
		await assert.rejects(knowledgeSharing("/project", { connection: "local", runGit }), {
			message: "could not ask git whether it ignores .heydb/knowledge/local.json: fatal: detected dubious ownership in repository",
		});
	});

	test("the advice names what to commit and never the password file", () => {
		assert.equal(SHARE_NOTES_HINT, "To share notes, commit .heydb/config.json, .heydb/snapshots/ and .heydb/knowledge/ (never .heydb/.env).");
	});
});

describe("knowledgeSharing with the real git", { skip: spawnSync("git", ["--version"]).error !== undefined && "git is not installed" }, () => {
	function repository(gitignore: string): string {
		const root = tempDir();
		execFileSync("git", ["init", "-q"], { cwd: root });
		mkdirSync(join(root, ".heydb", "knowledge"), { recursive: true });
		writeFileSync(join(root, ".gitignore"), gitignore);
		return root;
	}

	test("finds the rule of the field report and never changes .gitignore", async () => {
		const root = repository("node_modules/\n.heydb/\n");
		assert.deepEqual(await knowledgeSharing(root, { connection: "local" }), { state: "ignored", rule: ".gitignore:2: .heydb/" });
		assert.equal(readFileSync(join(root, ".gitignore"), "utf8"), "node_modules/\n.heydb/\n");
	});

	test("notes git does not ignore are shared; a folder outside any repository has no git", async () => {
		assert.deepEqual(await knowledgeSharing(repository(".heydb/.env\n"), { connection: "local" }), { state: "shared" });
		assert.deepEqual(await knowledgeSharing(tempDir(), { connection: "local" }), { state: "no-git" });
	});
});
