import { type Change, diffSnapshots } from "../model/diff.ts";
import { schemaHash } from "../model/hash.ts";
import type { Snapshot } from "../model/snapshot.ts";
import { saveSnapshot } from "../store/snapshots.ts";
import { checkStatus } from "./status.ts";

export interface SyncResult {
	/** false when the stored snapshot already had the same structure. */
	readonly written: boolean;
	readonly hash: string;
	/** What the new file changed; every database counts as added on the first sync. */
	readonly changes: readonly Change[];
}

/**
 * Stores the live snapshot of `connection`, but only when its structure
 * differs from the stored one. Snapshot files are committed: rewriting them
 * because the capture time, a row estimate or a warning changed would create
 * a git change on every sync with nothing real to review.
 */
export function syncSnapshot(projectRoot: string, connection: string, live: Snapshot): SyncResult {
	const status = checkStatus(projectRoot, connection, live);
	switch (status.state) {
		case "up_to_date":
			return { written: false, hash: status.hash, changes: [] };
		case "never_synced":
			saveSnapshot(projectRoot, connection, live);
			return { written: true, hash: schemaHash(live), changes: diffSnapshots({ ...live, databases: [] }, live) };
		case "drifted":
			saveSnapshot(projectRoot, connection, live);
			return { written: true, hash: status.liveHash, changes: status.changes };
	}
}
