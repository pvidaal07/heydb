import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { schemaHash } from "../../lib/model/hash.ts";
import { saveSnapshot } from "../../lib/store/snapshots.ts";
import { checkStatus } from "../../lib/usecases/status.ts";
import { column, customersTable, ordersTable, snapshot } from "../fixtures/snapshot.ts";

const roots: string[] = [];

function projectRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "heydb-status-"));
	mkdirSync(join(root, ".heydb"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("checkStatus", () => {
	test("says never_synced when the connection has no stored snapshot", () => {
		assert.deepEqual(checkStatus(projectRoot(), "local", snapshot([ordersTable()])), { state: "never_synced" });
	});

	test("says up_to_date when only capture time, row estimates or warnings differ", () => {
		const root = projectRoot();
		saveSnapshot(root, "local", snapshot([ordersTable()]));
		const live = snapshot([ordersTable({ rowEstimate: 9 })], {
			capturedAt: "2027-01-01T00:00:00.000Z",
			warnings: [{ code: "routines_hidden", message: "hidden" }],
		});
		assert.deepEqual(checkStatus(root, "local", live), { state: "up_to_date", hash: schemaHash(live) });
	});

	test("says drifted with both hashes and what changed", () => {
		const root = projectRoot();
		const stored = snapshot([customersTable(), ordersTable()]);
		saveSnapshot(root, "local", stored);
		const live = snapshot([
			customersTable(),
			ordersTable({ columns: [column("id", 1, { autoIncrement: true }), column("customer_id", 2, { type: "bigint" }), column("total", 3, { type: "decimal(10,2)" })] }),
		]);
		assert.deepEqual(checkStatus(root, "local", live), {
			state: "drifted",
			storedHash: schemaHash(stored),
			liveHash: schemaHash(live),
			changes: [{ kind: "modified", object: "column", target: "shop.shop.orders.customer_id", details: ["type: int → bigint"] }],
		});
	});

	test("propagates an invalid connection name", () => {
		assert.throws(() => checkStatus(projectRoot(), "../x", snapshot([])), /invalid connection name/);
	});
});
