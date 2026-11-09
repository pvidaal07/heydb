import { execFile } from "node:child_process";

import { HEYDB_DIR } from "../store/project.ts";

// Whether the team gets the notes. heydb keeps them in .heydb/knowledge/ and
// git shares them when the project commits that folder; but heydb v1 told
// projects to ignore .heydb/ entirely, and a project that still does keeps
// every note on one machine while the tool says it was saved. Nobody notices
// until a colleague asks why the notes are missing.
//
// Only git knows whether a path is ignored: rules come from every .gitignore
// on the way, .git/info/exclude and the global excludes file, and a later
// "!pattern" can re-include a path. So heydb asks `git check-ignore -v`,
// which also names the rule, and never edits any ignore file itself: what
// the project shares is the team's decision.

export type KnowledgeSharing =
	| { readonly state: "shared" }
	/** `rule` is "<source>:<line>: <pattern>", e.g. ".gitignore:26: .heydb/". */
	| { readonly state: "ignored"; readonly rule: string }
	| { readonly state: "no-git" };

export interface GitRun {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** Runs git with `args` in `cwd`; "missing" when git is not installed. */
export type RunGit = (args: readonly string[], cwd: string) => Promise<GitRun | "missing">;

export interface SharingOptions {
	/** The connection whose notes file is checked; without one, the knowledge folder. */
	readonly connection?: string;
	/** Replaced in tests; the default runs the real git. */
	readonly runGit?: RunGit;
}

export const SHARE_NOTES_HINT = `To share notes, commit ${HEYDB_DIR}/config.json, ${HEYDB_DIR}/snapshots/ and ${HEYDB_DIR}/knowledge/ (never ${HEYDB_DIR}/.env).`;

const GIT_TIMEOUT_MS = 2000;

/**
 * Whether git would share the notes of the project at `projectRoot`:
 * "shared" when git tracks them or does not ignore them, "ignored" with the
 * rule that ignores them, "no-git" without git or outside a repository. Any
 * other git failure is an error, so a broken repository is not reported as
 * fine.
 */
export async function knowledgeSharing(projectRoot: string, options: SharingOptions = {}): Promise<KnowledgeSharing> {
	const { connection, runGit = runRealGit } = options;
	const path = `${HEYDB_DIR}/knowledge/${connection === undefined ? "" : `${connection}.json`}`;
	// Tracked files are never reported as ignored, so tracked notes come back as shared.
	const run = await runGit(["check-ignore", "-v", "--", path], projectRoot);
	if (run === "missing") return { state: "no-git" };
	if (run.exitCode === 1) return { state: "shared" };
	if (run.exitCode === 0) {
		// "<source>:<line>:<pattern>\t<path>"; a pattern starting with "!" re-includes the path.
		const match = /^(.*):(\d+):([^\t]*)\t/.exec(run.stdout);
		if (match === null) throw new Error(`could not read git check-ignore's answer for ${path}: ${firstLine(run.stdout)}`);
		const [, source, line, pattern] = match as unknown as [string, string, string, string];
		return pattern.startsWith("!") ? { state: "shared" } : { state: "ignored", rule: `${source}:${line}: ${pattern}` };
	}
	if (/not a git repository/i.test(run.stderr)) return { state: "no-git" };
	throw new Error(`could not ask git whether it ignores ${path}: ${firstLine(run.stderr) || `exit code ${run.exitCode}`}`);
}

// An argument list and no shell: nothing in a path is ever interpreted.
function runRealGit(args: readonly string[], cwd: string): Promise<GitRun | "missing"> {
	return new Promise((resolve, reject) => {
		execFile("git", [...args], { cwd, timeout: GIT_TIMEOUT_MS, shell: false, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
			if (error === null) return resolve({ exitCode: 0, stdout, stderr });
			const failure = error as NodeJS.ErrnoException & { code?: unknown; killed?: boolean };
			if (failure.code === "ENOENT") return resolve("missing");
			if (typeof failure.code === "number" && !failure.killed) return resolve({ exitCode: failure.code, stdout, stderr });
			reject(new Error(`git ${args[0]} failed: ${failure.killed ? `no answer within ${GIT_TIMEOUT_MS} ms` : error.message}`, { cause: error }));
		});
	});
}

function firstLine(text: string): string {
	return text.trim().split("\n")[0] ?? "";
}
