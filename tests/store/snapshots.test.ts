import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";

import { stableJson } from "../../lib/store/files.ts";
import { loadSnapshot, saveSnapshot, snapshotPath, storedSnapshotPath } from "../../lib/store/snapshots.ts";
import { column, customersTable, ordersTable, snapshot } from "../fixtures/snapshot.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

function projectRoot(): string {
	const root = tempDir("heydb-store-");
	mkdirSync(join(root, ".heydb"));
	return root;
}

function legacyPath(root: string, connection: string): string {
	return join(root, ".heydb", "snapshots", `${connection}.json`);
}

describe("saveSnapshot / loadSnapshot", () => {
	test("stores the snapshot compressed under .heydb/snapshots/<connection>.json.gz", () => {
		const root = projectRoot();
		saveSnapshot(root, "local", snapshot([ordersTable()]));
		assert.equal(snapshotPath(root, "local"), join(root, ".heydb", "snapshots", "local.json.gz"));
		assert.deepEqual(readdirSync(join(root, ".heydb", "snapshots")), ["local.json.gz"]);
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
		assert.deepEqual(readFileSync(snapshotPath(a, "local")), readFileSync(snapshotPath(b, "local")));
	});

	test("compresses readable JSON: sorted keys, two-space indent, trailing newline", () => {
		const root = projectRoot();
		saveSnapshot(root, "local", snapshot([customersTable()]));
		const text = gunzipSync(readFileSync(snapshotPath(root, "local"))).toString("utf8");
		assert.ok(text.endsWith("}\n"), "ends with a newline");
		assert.ok(text.startsWith('{\n  "capturedAt": '), "keys sorted alphabetically, two-space indent");
	});

	test("writes a gzip header without time, file name or operating system, so every machine writes the same bytes", () => {
		const root = projectRoot();
		saveSnapshot(root, "local", snapshot([customersTable()]));
		const header = readFileSync(snapshotPath(root, "local")).subarray(0, 10);
		// magic, deflate, no flags (no file name), mtime 0, maximum compression, OS "unknown"
		assert.equal(header.toString("hex"), "1f8b08000000000002ff");
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
		assert.deepEqual(readdirSync(join(root, ".heydb", "snapshots")), ["local.json.gz"]);
	});

	test("returns null when the connection was never synced", () => {
		assert.equal(loadSnapshot(projectRoot(), "local"), null);
	});

	test("only a missing file means never synced; other read errors propagate", () => {
		const root = projectRoot();
		mkdirSync(join(root, ".heydb", "snapshots", "local.json.gz"), { recursive: true });
		assert.throws(() => loadSnapshot(root, "local"), { code: "EISDIR" });
	});

	test("a failed write leaves no temporary file behind", () => {
		const root = projectRoot();
		const dir = join(root, ".heydb", "snapshots");
		mkdirSync(join(dir, "local.json.gz"), { recursive: true });
		assert.throws(() => saveSnapshot(root, "local", snapshot([])));
		assert.deepEqual(readdirSync(dir), ["local.json.gz"]);
	});

	test("writes the same bytes whatever order the warnings were collected in", () => {
		const a = projectRoot();
		const b = projectRoot();
		const first = { code: "routines_hidden", message: "no SHOW_ROUTINE privilege" };
		const second = { code: "views_hidden", message: "no SHOW VIEW privilege" };
		saveSnapshot(a, "local", snapshot([], { warnings: [first, second] }));
		saveSnapshot(b, "local", snapshot([], { warnings: [second, first] }));
		assert.deepEqual(readFileSync(snapshotPath(a, "local")), readFileSync(snapshotPath(b, "local")));
	});

	test("does not modify the snapshot it is given", () => {
		const root = projectRoot();
		const original = snapshot([ordersTable(), customersTable()]);
		const before = JSON.stringify(original);
		saveSnapshot(root, "local", original);
		assert.equal(JSON.stringify(original), before);
	});
});

describe("snapshots written by earlier builds (plain .json)", () => {
	test("are still read", () => {
		const root = projectRoot();
		const original = snapshot([customersTable(), ordersTable()]);
		mkdirSync(join(root, ".heydb", "snapshots"));
		writeFileSync(legacyPath(root, "local"), stableJson(original));
		assert.deepEqual(loadSnapshot(root, "local"), original);
		assert.equal(storedSnapshotPath(root, "local"), legacyPath(root, "local"));
	});

	test("are replaced by the compressed file on the next save", () => {
		const root = projectRoot();
		mkdirSync(join(root, ".heydb", "snapshots"));
		writeFileSync(legacyPath(root, "local"), stableJson(snapshot([ordersTable()])));
		const updated = snapshot([ordersTable({ comment: "v2" })]);
		saveSnapshot(root, "local", updated);
		assert.deepEqual(readdirSync(join(root, ".heydb", "snapshots")), ["local.json.gz"]);
		assert.deepEqual(loadSnapshot(root, "local"), updated);
		assert.equal(storedSnapshotPath(root, "local"), snapshotPath(root, "local"));
	});

	test("lose to the compressed file when both exist", () => {
		const root = projectRoot();
		const current = snapshot([ordersTable({ comment: "current" })]);
		saveSnapshot(root, "local", current);
		writeFileSync(legacyPath(root, "local"), stableJson(snapshot([ordersTable({ comment: "old" })])));
		assert.deepEqual(loadSnapshot(root, "local"), current);
	});

	test("storedSnapshotPath is null when the connection was never synced", () => {
		assert.equal(storedSnapshotPath(projectRoot(), "local"), null);
	});
});

// A schema with about 1,500 tables: its pretty-printed snapshot is about 400,000 lines.
// The bounds are generous so slow CI machines pass; the measured values are
// printed as test diagnostics.
describe("a 1,500-table × 60-column schema", () => {
	test("compresses to well under a megabyte and loads in well under a second", (t) => {
		const root = projectRoot();
		const columns = Array.from({ length: 60 }, (_, c) =>
			column(`column_${c}`, c + 1, {
				type: c % 3 === 0 ? "int" : "varchar(255)",
				nullable: c % 2 === 0,
				comment: c % 5 === 0 ? `comment ${c}` : "",
				collation: c % 3 === 0 ? null : "utf8mb4_general_ci",
			}),
		);
		const tables = Array.from({ length: 1500 }, (_, i) =>
			ordersTable({ name: `table_${i}`, comment: `table ${i}`, columns, indexes: [], foreignKeys: [] }),
		);
		saveSnapshot(root, "erp", snapshot(tables));

		const size = readFileSync(snapshotPath(root, "erp")).length;
		const start = performance.now();
		const loaded = loadSnapshot(root, "erp");
		const elapsed = performance.now() - start;
		t.diagnostic(`gz size ${size} bytes, load ${elapsed.toFixed(0)} ms`);

		assert.equal(loaded?.databases[0]?.schemas[0]?.tables.length, 1500);
		assert.ok(size < 1_000_000, `gz size ${size} bytes`);
		assert.ok(elapsed < 1500, `load took ${elapsed.toFixed(0)} ms`);
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
		const outside = tempDir("heydb-outside-");
		symlinkSync(outside, join(root, ".heydb", "snapshots"));
		assert.throws(() => saveSnapshot(root, "local", snapshot([])), /\.heydb\/snapshots is a symbolic link/);
		assert.deepEqual(readdirSync(outside), []);
	});

	test("refuses to use a symlinked .heydb directory", () => {
		const outside = tempDir("heydb-outside-");
		const root = tempDir("heydb-store-");
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

	test("validates every table, naming the file and the exact path of the bad value", () => {
		const root = projectRoot();
		const data = JSON.parse(JSON.stringify(snapshot([customersTable(), ordersTable()])));
		data.databases[0].schemas[0].tables[1].columns[2].nullable = "YES";
		writeRaw(root, JSON.stringify(data));
		assert.throws(
			() => loadSnapshot(root, "local"),
			/^Error: local\.json is not a heydb snapshot: databases\[0\]\.schemas\[0\]\.tables\[1\]\.columns\[2\]\.nullable must be a boolean$/,
		);
	});

	test("rejects a compressed file that is not gzip, naming the file", () => {
		const root = projectRoot();
		mkdirSync(join(root, ".heydb", "snapshots"));
		writeFileSync(snapshotPath(root, "local"), "{ plain text }");
		assert.throws(() => loadSnapshot(root, "local"), /^Error: local\.json\.gz is not a valid gzip file \(.*local\.json\.gz\)$/);
	});

	test("rejects a truncated compressed file, naming the file", () => {
		const root = projectRoot();
		saveSnapshot(root, "local", snapshot([ordersTable()]));
		const bytes = readFileSync(snapshotPath(root, "local"));
		writeFileSync(snapshotPath(root, "local"), bytes.subarray(0, bytes.length - 12));
		assert.throws(() => loadSnapshot(root, "local"), /local\.json\.gz is not a valid gzip file/);
	});

	test("validates a compressed file like a plain one, naming the compressed file", () => {
		const root = projectRoot();
		mkdirSync(join(root, ".heydb", "snapshots"));
		writeFileSync(snapshotPath(root, "local"), gzipSync("{ not json"));
		assert.throws(() => loadSnapshot(root, "local"), /local\.json\.gz is not valid JSON/);
		const data = JSON.parse(JSON.stringify(snapshot([ordersTable()])));
		data.databases[0].schemas[0].tables[0].columns[0].nullable = "YES";
		writeFileSync(snapshotPath(root, "local"), gzipSync(JSON.stringify(data)));
		assert.throws(
			() => loadSnapshot(root, "local"),
			/^Error: local\.json\.gz is not a heydb snapshot: databases\[0\]\.schemas\[0\]\.tables\[0\]\.columns\[0\]\.nullable must be a boolean$/,
		);
	});

	test("rejects a snapshot saved before view definitions were captured", () => {
		const root = projectRoot();
		const data = JSON.parse(JSON.stringify(snapshot([ordersTable()])));
		delete data.databases[0].schemas[0].tables[0].viewDefinition;
		writeRaw(root, JSON.stringify(data));
		assert.throws(() => loadSnapshot(root, "local"), /tables\[0\]\.viewDefinition is missing$/);
	});
});

describe("loading the same snapshot again", () => {
	// Every agent tool call loads the snapshot: on a 1,500-table schema
	// unzipping and validating it again each time costs more than the search.
	test("returns the already loaded snapshot while the file is unchanged", () => {
		const root = projectRoot();
		saveSnapshot(root, "local", snapshot([ordersTable()]));
		const first = loadSnapshot(root, "local");
		assert.equal(loadSnapshot(root, "local"), first);
	});

	test("reads the file again once a sync rewrote it", () => {
		const root = projectRoot();
		saveSnapshot(root, "local", snapshot([ordersTable()]));
		const first = loadSnapshot(root, "local");
		saveSnapshot(root, "local", snapshot([ordersTable(), customersTable()]));
		const second = loadSnapshot(root, "local");
		assert.notEqual(second, first);
		assert.deepEqual(
			second?.databases[0]?.schemas[0]?.tables.map((table) => table.name),
			["customers", "orders"],
		);
	});

	test("reads the file again when it was replaced by hand, even with the same size", () => {
		const root = projectRoot();
		saveSnapshot(root, "local", snapshot([ordersTable({ comment: "aaaa" })]));
		const first = loadSnapshot(root, "local");
		const path = snapshotPath(root, "local");
		const text = gunzipSync(readFileSync(path)).toString("utf8").replace("aaaa", "bbbb");
		writeFileSync(path, gzipSync(text));
		assert.equal(loadSnapshot(root, "local")?.databases[0]?.schemas[0]?.tables[0]?.comment, "bbbb");
		assert.notEqual(loadSnapshot(root, "local"), first);
	});

	test("says never synced once the file is gone", () => {
		const root = projectRoot();
		saveSnapshot(root, "local", snapshot([ordersTable()]));
		loadSnapshot(root, "local");
		rmSync(snapshotPath(root, "local"));
		assert.equal(loadSnapshot(root, "local"), null);
	});
});
