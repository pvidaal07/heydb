import { introspect } from "../lib/engines/index.ts";
import type { KnowledgeOptions } from "../lib/knowledge/operations.ts";
import type { CaptureOptions } from "../lib/usecases/project.ts";
import { resolveAuthor } from "../lib/usecases/author.ts";

// Everything the extension needs from the outside world, in one place. Pi
// gets the real ones; tests pass fakes, so commands and tools run without a
// database, git, the real clock or the process folder.

export interface HeydbDeps {
	/** Where password references are looked up first (then .heydb/.env). */
	readonly env: Readonly<Record<string, string | undefined>>;
	/** Captures a live schema. Only /heydb:sync and /heydb:status call it; tools never do. */
	readonly introspect: NonNullable<CaptureOptions["introspect"]>;
	/** The person behind the session, for the author of new notes. */
	readonly author: (cwd: string) => Promise<string>;
	/** Clock and id generator for new notes. */
	readonly knowledge: KnowledgeOptions;
	/** The folder argument completion looks in; Pi passes completions no context. */
	readonly cwd: () => string;
}

export function defaultDeps(): HeydbDeps {
	return {
		env: process.env,
		// The engine module loads its driver on first use (ADR-0006), so this costs nothing until a sync.
		introspect,
		author: (cwd) => resolveAuthor({ cwd }),
		knowledge: {},
		cwd: () => process.cwd(),
	};
}
