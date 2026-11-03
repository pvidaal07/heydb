import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { loadSnapshot, saveSnapshot, snapshotPath } from "../../lib/store/snapshots.ts";
import { customersTable, ordersTable, snapshot } from "../fixtures/snapshot.ts";

function projectRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "heydb-store-"));
	mkdirSync(join(root, ".heydb"));
	return root;
}

describe("saveSnapshot / loadSnapshot", () => {
	test("stores the snapshot under .heydb/snapshots/<connection>.json", () => {
		const root = projectRoot();
		saveSnapshot(root, "local", snapshot([ordersTable()]));
		assert.equal(snapshotPath(root, "local"), join(root, ".heydb", "snapshots", "local.json"));
		assert.ok(existsSync(snapshotPath(root, "local")));
	});

	test("round-trips a snapshot", () => {
		const root = projectRoot();
		const original = snapshot([customersTable(), ordersTable()]);
		saveSnapshot(root, "local", original);
		assert.deepEqual(loadSnapshot(root, "local"), original);
	});

	test("writes byte-identical files whatever order the snapshot was read in, so git diffs show only real changes", () => {
		const a = projectRoot();
		const b = projectRoot();
		const orders = ordersTable();
		saveSnapshot(a, "local", snapshot([customersTable(), orders]));
		saveSnapshot(b, "local", snapshot([{ ...orders, columns: [...orders.columns].reverse() }, customersTable()]));
		assert.equal(readFileSync(snapshotPath(a, "local"), "utf8"), readFileSync(snapshotPath(b, "local"), "utf8"));
	});

	test("writes readable JSON: sorted keys, two-space indent, trailing newline", () => {
		const root = projectRoot();
		saveSnapshot(root, "local", snapshot([customersTable()]));
		const text = readFileSync(snapshotPath(root, "local"), "utf8");
		assert.ok(text.endsWith("}\n"), "ends with a newline");
		assert.ok(text.startsWith('{\n  "capturedAt": '), "keys sorted alphabetically, two-space indent");
	});

	test("keeps primary key and index column order", () => {
		const root = projectRoot();
		const table = ordersTable({
			primaryKey: ["total", "id"],
			indexes: [{ name: "idx_mix", columns: ["total", "customer_id"], unique: false, method: "BTREE" }],
		});
		saveSnapshot(root, "local", snapshot([table]));
		const loaded = loadSnapshot(root, "local");
		const loadedTable = loaded?.databases[0]?.schemas[0]?.tables[0];
		assert.deepEqual(loadedTable?.primaryKey, ["total", "id"]);
		assert.deepEqual(loadedTable?.indexes[0]?.columns, ["total", "customer_id"]);
	});

	test("overwrites an existing snapshot and leaves no temporary files", () => {
		const root = projectRoot();
		saveSnapshot(root, "local", snapshot([ordersTable()]));
		const updated = snapshot([ordersTable({ comment: "v2" })]);
		saveSnapshot(root, "local", updated);
		assert.deepEqual(loadSnapshot(root, "local"), updated);
		assert.deepEqual(readdirSync(join(root, ".heydb", "snapshots")), ["local.json"]);
	});

	test("returns null when the connection was never synced", () => {
		assert.equal(loadSnapshot(projectRoot(), "local"), null);
	});

	test("only a missing file means never synced; other read errors propagate", () => {
		const root = projectRoot();
		mkdirSync(join(root, ".heydb", "snapshots", "local.json"), { recursive: true });
		assert.throws(() => loadSnapshot(root, "local"), { code: "EISDIR" });
	});

	test("a failed write leaves no temporary file behind", () => {
		const root = projectRoot();
		const dir = join(root, ".heydb", "snapshots");
		mkdirSync(join(dir, "local.json"), { recursive: true });
		assert.throws(() => saveSnapshot(root, "local", snapshot([])));
		assert.deepEqual(readdirSync(dir), ["local.json"]);
	});

	test("writes the same bytes whatever order the warnings were collected in", () => {
		const a = projectRoot();
		const b = projectRoot();
		const first = { code: "routines_hidden", message: "no SHOW_ROUTINE privilege" };
		const second = { code: "views_hidden", message: "no SHOW VIEW privilege" };
		saveSnapshot(a, "local", snapshot([], { warnings: [first, second] }));
		saveSnapshot(b, "local", snapshot([], { warnings: [second, first] }));
		assert.equal(readFileSync(snapshotPath(a, "local"), "utf8"), readFileSync(snapshotPath(b, "local"), "utf8"));
	});

	test("does not modify the snapshot it is given", () => {
		const root = projectRoot();
		const original = snapshot([ordersTable(), customersTable()]);
		const before = JSON.stringify(original);
		saveSnapshot(root, "local", original);
		assert.equal(JSON.stringify(original), before);
	});
});

describe("connection names", () => {
	test("rejects names that could escape .heydb/ or are not plain file names, and writes nothing", () => {
		const root = projectRoot();
		const unsafe = ["", "../evil", "a/b", "a\\b", ".hidden", "with space", "local\n", "x".repeat(65)];
		for (const name of unsafe) {
			assert.throws(
				() => saveSnapshot(root, name, snapshot([])),
				/invalid connection name/,
				`expected "${name}" to be rejected`,
			);
		}
		assert.equal(existsSync(join(root, ".heydb", "snapshots")), false);
		assert.equal(existsSync(join(root, "evil.json")), false);
	});

	test("rejects uppercase, because Prod and prod would share one file on macOS and Windows", () => {
		assert.throws(() => snapshotPath(projectRoot(), "Prod"), /invalid connection name "Prod"/);
	});

	test("rejects Windows reserved device names in any case", () => {
		for (const name of ["con", "nul", "prn", "aux", "com1", "com9", "lpt1", "lpt9"]) {
			assert.throws(() => snapshotPath(projectRoot(), name), /reserved name on Windows/, name);
		}
	});

	test("accepts lowercase letters, digits, dashes and underscores", () => {
		const root = projectRoot();
		saveSnapshot(root, "prod_eu-1", snapshot([]));
		assert.ok(existsSync(snapshotPath(root, "prod_eu-1")));
	});
});

describe("symbolic links", () => {
	test("refuses to write through a symlinked snapshots directory", () => {
		const root = projectRoot();
		const outside = mkdtempSync(join(tmpdir(), "heydb-outside-"));
		symlinkSync(outside, join(root, ".heydb", "snapshots"));
		assert.throws(() => saveSnapshot(root, "local", snapshot([])), /\.heydb\/snapshots is a symbolic link/);
		assert.deepEqual(readdirSync(outside), []);
	});

	test("refuses to use a symlinked .heydb directory", () => {
		const outside = mkdtempSync(join(tmpdir(), "heydb-outside-"));
		const root = mkdtempSync(join(tmpdir(), "heydb-store-"));
		symlinkSync(outside, join(root, ".heydb"));
		assert.throws(() => saveSnapshot(root, "local", snapshot([])), /\.heydb is a symbolic link/);
		assert.throws(() => loadSnapshot(root, "local"), /\.heydb is a symbolic link/);
		assert.deepEqual(readdirSync(outside), []);
	});
});

describe("reading damaged or foreign files", () => {
	function writeRaw(root: string, text: string): void {
		mkdirSync(join(root, ".heydb", "snapshots"), { recursive: true });
		writeFileSync(join(root, ".heydb", "snapshots", "local.json"), text);
	}

	test("rejects invalid JSON naming the file", () => {
		const root = projectRoot();
		writeRaw(root, "{ not json");
		assert.throws(() => loadSnapshot(root, "local"), /local\.json is not valid JSON/);
	});

	test("rejects a snapshot written by an unknown format version", () => {
		const root = projectRoot();
		writeRaw(root, JSON.stringify({ ...snapshot([]), formatVersion: 2 }));
		assert.throws(() => loadSnapshot(root, "local"), /unsupported snapshot formatVersion 2 \(expected 1\)/);
	});

	test("names a missing formatVersion instead of printing undefined", () => {
		const root = projectRoot();
		writeRaw(root, "{}");
		assert.throws(() => loadSnapshot(root, "local"), /local\.json is not a heydb snapshot: missing "formatVersion"/);
	});

	test("rejects a file without the snapshot structure", () => {
		const root = projectRoot();
		writeRaw(root, JSON.stringify({ formatVersion: 1, hello: "world" }));
		assert.throws(() => loadSnapshot(root, "local"), /local\.json is not a heydb snapshot: missing "engine"/);
	});
});
