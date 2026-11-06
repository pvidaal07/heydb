import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { addAnnotation, emptyKnowledge } from "../../lib/knowledge/operations.ts";
import { knowledgePath, loadKnowledge, saveKnowledge } from "../../lib/store/knowledge.ts";
import { annotation, fixedClock, knowledge, relationship } from "../knowledge/fixtures.ts";

const roots: string[] = [];

function projectRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "heydb-knowledge-"));
	mkdirSync(join(root, ".heydb"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function gitAvailable(): boolean {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

const sample = knowledge(
	[annotation("a1", "shop.shop"), annotation("a2", "shop.shop.orders"), annotation("a3", "shop.shop.orders.total")],
	[
		relationship("r1", "shop.shop.lines", ["order_id"], "shop.shop.orders", ["id"]),
		relationship("r2", "shop.shop.orders", ["customer_id"], "shop.shop.customers", ["id"]),
	],
);

describe("saveKnowledge / loadKnowledge", () => {
	test("stores knowledge under .heydb/knowledge/<connection>.json", () => {
		const root = projectRoot();
		assert.equal(knowledgePath(root, "local"), join(root, ".heydb", "knowledge", "local.json"));
		saveKnowledge(root, "local", sample);
		assert.deepEqual(readdirSync(join(root, ".heydb", "knowledge")), ["local.json"]);
	});

	test("returns empty knowledge when nothing was saved yet", () => {
		assert.deepEqual(loadKnowledge(projectRoot(), "local"), emptyKnowledge());
	});

	test("round-trips knowledge", () => {
		const root = projectRoot();
		saveKnowledge(root, "local", sample);
		assert.deepEqual(loadKnowledge(root, "local"), sample);
	});

	test("writes byte-identical files whatever order the entries were added in", () => {
		const a = projectRoot();
		const b = projectRoot();
		saveKnowledge(a, "local", sample);
		saveKnowledge(b, "local", knowledge([...sample.annotations].reverse(), [...sample.relationships].reverse()));
		assert.equal(readFileSync(knowledgePath(a, "local"), "utf8"), readFileSync(knowledgePath(b, "local"), "utf8"));
	});

	test("writes readable JSON: sorted keys, two-space indent, one line per field", () => {
		const root = projectRoot();
		saveKnowledge(root, "local", knowledge([annotation("a1", "shop.shop")]));
		assert.equal(
			readFileSync(knowledgePath(root, "local"), "utf8"),
			[
				"{",
				'  "annotations": [',
				"    {",
				'      "author": "ana",',
				'      "createdAt": "2026-11-06T10:00:00.000Z",',
				'      "id": "a1",',
				'      "target": "shop.shop",',
				'      "text": "note a1",',
				'      "updatedAt": "2026-11-06T10:00:00.000Z"',
				"    }",
				"  ],",
				'  "formatVersion": 1,',
				'  "relationships": []',
				"}",
				"",
			].join("\n"),
		);
	});

	test("two people annotating different tables from the same base merge cleanly in git", { skip: gitAvailable() ? false : "git is not installed" }, () => {
		// Base: notes on customers, orders and products. Ana annotates a column of
		// customers while Bruno annotates products: each adds a block in a
		// different place of the sorted list, so the line changes do not touch.
		const base = knowledge([
			annotation("a1", "shop.shop.customers"),
			annotation("a2", "shop.shop.orders"),
			annotation("a3", "shop.shop.products"),
		]);
		const ana = addAnnotation(base, { target: "shop.shop.customers.email", text: "Unique per tenant.", author: "ana" }, { now: () => "2026-11-06T11:00:00.000Z", newId: () => "ana-1" });
		const bruno = addAnnotation(base, { target: "shop.shop.products", text: "Soft-deleted rows stay.", author: "bruno" }, { now: () => "2026-11-06T12:00:00.000Z", newId: () => "bruno-1" });
		const both = knowledge([...ana.knowledge.annotations, bruno.annotation]);

		const files = projectRoot();
		const write = (name: string, value: typeof base): string => {
			const root = join(files, name);
			mkdirSync(join(root, ".heydb"), { recursive: true });
			saveKnowledge(root, "local", value);
			return knowledgePath(root, "local");
		};
		const [mine, original, theirs, expected] = [write("ana", ana.knowledge), write("base", base), write("bruno", bruno.knowledge), write("both", both)];

		let merged: string;
		try {
			merged = execFileSync("git", ["merge-file", "-p", mine, original, theirs], { encoding: "utf8" });
		} catch (error) {
			// merge-file exits with the number of conflicts; stdout holds the conflicted file.
			const output = (error as { stdout?: string }).stdout ?? String(error);
			assert.fail(`git merge-file reported conflicts:\n${output}`);
		}
		assert.equal(merged, readFileSync(expected, "utf8"));

		writeFileSync(knowledgePath(join(files, "base"), "local"), merged);
		assert.deepEqual(loadKnowledge(join(files, "base"), "local"), both);
	});

	test("overwrites without leaving temporary files", () => {
		const root = projectRoot();
		saveKnowledge(root, "local", sample);
		saveKnowledge(root, "local", emptyKnowledge());
		assert.deepEqual(loadKnowledge(root, "local"), emptyKnowledge());
		assert.deepEqual(readdirSync(join(root, ".heydb", "knowledge")), ["local.json"]);
	});

	test("rejects unsafe connection names before touching the disk", () => {
		const root = projectRoot();
		assert.throws(() => loadKnowledge(root, "../evil"), {
			message:
				'invalid connection name "../evil": use 1-64 lowercase letters, digits, "-" or "_", starting with a letter or digit',
		});
		assert.throws(() => saveKnowledge(root, "nul", sample), {
			message: 'invalid connection name "nul": reserved name on Windows',
		});
		assert.deepEqual(readdirSync(join(root, ".heydb")), []);
	});

	test("refuses to follow a symbolic link at .heydb/knowledge", (context) => {
		const root = projectRoot();
		const elsewhere = projectRoot();
		try {
			symlinkSync(elsewhere, join(root, ".heydb", "knowledge"), "dir");
		} catch {
			context.skip("this system cannot create symbolic links");
			return;
		}
		const message = ".heydb/knowledge is a symbolic link; heydb refuses to follow it";
		assert.throws(() => saveKnowledge(root, "local", sample), { message });
		assert.throws(() => loadKnowledge(root, "local"), { message });
		assert.deepEqual(readdirSync(elsewhere), [".heydb"]);
	});

	test("explains damaged files with the file name", () => {
		const root = projectRoot();
		const path = knowledgePath(root, "local");
		mkdirSync(join(root, ".heydb", "knowledge"));
		const cases: [string, string][] = [
			["{", `knowledge/local.json is not valid JSON (${path})`],
			["[]", "knowledge/local.json is not a heydb knowledge file: expected a JSON object"],
			["{}", 'knowledge/local.json is not a heydb knowledge file: missing "formatVersion"'],
			['{"formatVersion":2}', "knowledge/local.json: unsupported knowledge formatVersion 2 (expected 1); update heydb"],
			[
				'{"formatVersion":1,"annotations":[{"id":"a"}],"relationships":[]}',
				"knowledge/local.json is not a heydb knowledge file: annotations[0].target is missing",
			],
		];
		for (const [content, message] of cases) {
			writeFileSync(path, content);
			assert.throws(() => loadKnowledge(root, "local"), { message }, content);
		}
	});

	test("only a missing file means empty; other read errors propagate", () => {
		const root = projectRoot();
		mkdirSync(knowledgePath(root, "local"), { recursive: true });
		assert.throws(() => loadKnowledge(root, "local"), { code: "EISDIR" });
	});
});
