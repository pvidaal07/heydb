import { type Change, diffSnapshots } from "../model/diff.ts";
import { schemaHash } from "../model/hash.ts";
import type { Snapshot } from "../model/snapshot.ts";
import { loadSnapshot } from "../store/snapshots.ts";

// Use cases combine the store and the model into one answer for a user
// question. The engine is not called here: the caller captures the live
// snapshot (with introspectMysql today, other engines later) and passes it in,
// so these functions are tested with plain snapshots and no server, and lib/
// stays free of any particular entry point (Pi, a CLI, an MCP server).

/**
 * Exactly one of three states. `state` tells them apart, and TypeScript only
 * lets callers read `changes` after checking that the state is "drifted".
 */
export type StatusResult =
	| { readonly state: "never_synced" }
	| { readonly state: "up_to_date"; readonly hash: string }
	| {
			readonly state: "drifted";
			readonly storedHash: string;
			readonly liveHash: string;
			readonly changes: readonly Change[];
	  };

/** Compares the live database with the stored snapshot of `connection`. */
export function checkStatus(projectRoot: string, connection: string, live: Snapshot): StatusResult {
	const stored = loadSnapshot(projectRoot, connection);
	if (stored === null) return { state: "never_synced" };

	// The hash answers "did anything change?"; only when it did is the diff
	// worth computing to answer "what?".
	const storedHash = schemaHash(stored);
	const liveHash = schemaHash(live);
	if (storedHash === liveHash) return { state: "up_to_date", hash: liveHash };
	return { state: "drifted", storedHash, liveHash, changes: diffSnapshots(stored, live) };
}
