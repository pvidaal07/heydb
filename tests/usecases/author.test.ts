import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { gitUserName, resolveAuthor } from "../../lib/usecases/author.ts";

describe("resolveAuthor", () => {
	test("uses git user.name, trimmed, read from the given directory", async () => {
		const calls: string[] = [];
		const author = await resolveAuthor({
			cwd: "/work/shop",
			env: { HEYDB_AUTHOR: "ignored" },
			runGit: async (cwd) => {
				calls.push(cwd);
				return "Ana García\n";
			},
			osUser: () => "ana",
		});
		assert.equal(author, "Ana García");
		assert.deepEqual(calls, ["/work/shop"]);
	});

	test("falls back to HEYDB_AUTHOR when git has no name", async () => {
		for (const fromGit of [null, "", "  \n"]) {
			const author = await resolveAuthor({
				cwd: "/work",
				env: { HEYDB_AUTHOR: " Bea " },
				runGit: async () => fromGit,
				osUser: () => "bea",
			});
			assert.equal(author, "Bea");
		}
	});

	test("falls back to the operating system user last", async () => {
		const author = await resolveAuthor({ cwd: "/work", env: { HEYDB_AUTHOR: "" }, runGit: async () => null, osUser: () => "carla" });
		assert.equal(author, "carla");
	});

	test("says unknown when nothing names the author", async () => {
		const author = await resolveAuthor({
			cwd: "/work",
			env: {},
			runGit: async () => null,
			osUser: () => {
				throw new Error("no passwd entry");
			},
		});
		assert.equal(author, "unknown");
	});
});

describe("gitUserName", () => {
	test("returns null instead of throwing when git cannot run there", async () => {
		const missing = join(mkdtempSync(join(tmpdir(), "heydb-author-")), "gone");
		try {
			assert.equal(await gitUserName(missing), null);
		} finally {
			rmSync(join(missing, ".."), { recursive: true, force: true });
		}
	});
});
