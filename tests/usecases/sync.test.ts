import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { schemaHash } from "../../lib/model/hash.ts";
import { loadSnapshot, saveSnapshot, snapshotPath } from "../../lib/store/snapshots.ts";
import { syncSnapshot } from "../../lib/usecases/sync.ts";
import { customersTable, ordersTable, snapshot } from "../fixtures/snapshot.ts";

const roots: string[] = [];

function projectRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "heydb-sync-"));
	mkdirSync(join(root, ".heydb"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("syncSnapshot", () => {
	test("writes the first snapshot and reports its databases as added", () => {
		const root = projectRoot();
		const live = snapshot([ordersTable()]);
		assert.deepEqual(syncSnapshot(root, "local", live), {
			written: true,
			hash: schemaHash(live),
			changes: [{ kind: "added", object: "database", target: "shop", details: [] }],
		});
		assert.deepEqual(loadSnapshot(root, "local"), live);
	});

	test("rewrites the file when the structure changed, and says what changed", () => {
		const root = projectRoot();
		saveSnapshot(root, "local", snapshot([customersTable(), ordersTable()]));
		const live = snapshot([customersTable(), ordersTable({ comment: "Orders" })]);
		assert.deepEqual(syncSnapshot(root, "local", live), {
			written: true,
			hash: schemaHash(live),
			changes: [{ kind: "modified", object: "table", target: "shop.shop.orders", details: ["comment: '' → 'Orders'"] }],
		});
		assert.deepEqual(loadSnapshot(root, "local"), live);
	});

	test("leaves the file byte-for-byte untouched when only capture time, row estimates or warnings changed", () => {
		const root = projectRoot();
		saveSnapshot(root, "local", snapshot([ordersTable()]));
		const before = readFileSync(snapshotPath(root, "local"));
		const live = snapshot([ordersTable({ rowEstimate: 5 })], {
			capturedAt: "2027-01-01T00:00:00.000Z",
			engine: { kind: "mysql", version: "8.0.40" },
			warnings: [{ code: "routines_hidden", message: "hidden" }],
		});
		assert.deepEqual(syncSnapshot(root, "local", live), { written: false, hash: schemaHash(live), changes: [] });
		assert.deepEqual(readFileSync(snapshotPath(root, "local")), before);
	});

	test("refuses an invalid connection name and writes nothing", () => {
		const root = projectRoot();
		assert.throws(() => syncSnapshot(root, "Prod", snapshot([])), /invalid connection name/);
		assert.equal(existsSync(join(root, ".heydb", "snapshots")), false);
	});
});
