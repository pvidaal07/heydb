import { execFile } from "node:child_process";
import { userInfo } from "node:os";

// Every note carries its author, so a team can ask whoever wrote it. The name
// comes from where people already set it, in this order:
//   1. git user.name, read in the project folder (it may differ per repository);
//   2. the HEYDB_AUTHOR environment variable, for machines without git config;
//   3. the operating system user.
// Entry points add their own suffix: notes written by an agent end in
// "(via agent)", so a reader knows a person did not type them.

const GIT_TIMEOUT_MS = 2000;

export interface AuthorOptions {
	readonly cwd: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** Returns git user.name for `cwd`, or null; replaced in tests so no git is needed. */
	readonly runGit?: (cwd: string) => Promise<string | null>;
	readonly osUser?: () => string;
}

export async function resolveAuthor(options: AuthorOptions): Promise<string> {
	const { cwd, env = process.env, runGit = gitUserName, osUser = () => userInfo().username } = options;
	const fromGit = (await runGit(cwd))?.trim();
	if (fromGit) return fromGit;
	const fromEnv = env.HEYDB_AUTHOR?.trim();
	if (fromEnv) return fromEnv;
	try {
		const fromOs = osUser().trim();
		if (fromOs) return fromOs;
	} catch {
		// Some containers have no user entry for the current uid.
	}
	return "unknown";
}

/**
 * `git config user.name` in `cwd`, or null when git is missing, the folder is
 * gone, the name is not set or git takes too long. execFile with an argument
 * list never goes through a shell, so nothing in the path is interpreted.
 */
export function gitUserName(cwd: string): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(
			"git",
			["config", "user.name"],
			{ cwd, timeout: GIT_TIMEOUT_MS, shell: false, windowsHide: true, encoding: "utf8" },
			(error, stdout) => resolve(error === null ? stdout : null),
		);
	});
}
