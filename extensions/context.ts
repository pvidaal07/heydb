import type { BeforeAgentStartEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { projectConnections } from "../lib/usecases/project.ts";

// One line in the system prompt, only inside a heydb project, so the model
// knows the schema is a tool call away before it writes SQL from memory.
// It runs before every agent turn, so it stays cheap: it finds .heydb/ and
// reads config.json, never a snapshot. Anything unexpected adds nothing; the
// tools report problems when they are actually used.
//
// It sets a named prompt section instead of returning a new system prompt:
// Pi compares sections between turns and only sends what changed, so an
// unchanged line costs nothing after the first turn.

export const PROMPT_SECTION = "heydb";

export function heydbPromptLine(cwd: string): string | null {
	let names: string[];
	try {
		names = projectConnections(cwd)?.names ?? [];
	} catch {
		return null;
	}
	if (names.length === 0) return null;
	return (
		`This project has a heydb schema snapshot (connections: ${names.join(", ")}). ` +
		"Before writing SQL or reading code about the database, find tables with heydb_search and check them with heydb_table. " +
		"If a heydb note answers the question, use it; read the source it cites only for what the note does not cover. " +
		// Agents took "Billing cycles, one row per cycle" as the answer to "what does the renewal do": they neither read the code nor learned the process.
		"A note that only says what a table holds does not answer what a process does: for a process question without a process note, read the code, then save the process as its own note."
	);
}

export function createContextHandler() {
	return (event: BeforeAgentStartEvent, ctx: ExtensionContext): undefined => {
		const line = heydbPromptLine(ctx.cwd);
		if (line !== null) event.systemPromptOptions.sections[PROMPT_SECTION] = line;
		return undefined;
	};
}
