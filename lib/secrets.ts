import { readFileSync } from "node:fs";
import { join } from "node:path";

import { assertNoSymlinks } from "./store/guards.ts";
import { HEYDB_DIR } from "./store/project.ts";

// Resolves a password reference from .heydb/config.json (ADR-0005). heydb
// stores no secrets, so it has none to leak; what remains is not leaking the
// ones it reads at connect time. No error built here ever contains a value:
// not the resolved password, not a line of .env, not even a reference that
// failed to parse (it might be a password typed in the wrong field).
//
// Lookup order for "env:HEYDB_NAME":
//   1. the process environment (shell, CI, a secrets manager that exports it);
//   2. the project's .heydb/.env, which .heydb/.gitignore excludes.
// The environment wins so a one-off `HEYDB_PROD_PASSWORD=… pi` overrides the file.

/**
 * The only shape a password may take, here and in config validation. Just
 * HEYDB_* variables: config.json is shared through git, and a reference to any
 * variable would let a malicious config send, say, AWS_SECRET_ACCESS_KEY as the
 * password to a host it chose.
 */
export const PASSWORD_REFERENCE = /^env:(HEYDB_[A-Z0-9_]+)$/;

/** Why a reference was refused; shared so both checks explain it the same way. */
export const REFERENCE_RULE = "only HEYDB_* variables can be used, so a shared config cannot read unrelated secrets from your environment";

/** The reference heydb suggests for a connection: "prod-eu" → "env:HEYDB_PROD_EU_PASSWORD". */
export function suggestedReference(name: string): string {
	return `env:HEYDB_${name.toUpperCase().replaceAll("-", "_")}_PASSWORD`;
}

const ENV_FILE = ".env";
const ENV_LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

export interface SecretOptions {
	/** Connection name, used only to say which password is missing. */
	readonly connection: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** Read <projectRoot>/.heydb/.env when the environment lacks the variable. */
	readonly projectRoot?: string;
}

export function resolveSecret(reference: string, options: SecretOptions): string {
	const { connection, env = process.env, projectRoot } = options;
	const match = PASSWORD_REFERENCE.exec(reference);
	if (match === null) {
		throw new Error(
			`password for connection "${connection}" must be a reference such as "${suggestedReference(connection)}": ${REFERENCE_RULE}`,
		);
	}
	const name = match[1] as string;

	// An empty value counts as set: local servers often have no password.
	const fromEnv = env[name];
	if (fromEnv !== undefined) return fromEnv;

	if (projectRoot !== undefined) {
		const fromFile = readEnvFile(projectRoot);
		if (fromFile !== null && Object.hasOwn(fromFile, name)) return fromFile[name] as string;
	}

	throw new Error(
		`password for connection "${connection}" comes from env:${name}, which is not set. ` +
			"Set it in your shell or in .heydb/.env (ignored by git).",
	);
}

/** The parsed file, or null when it does not exist. */
function readEnvFile(projectRoot: string): Readonly<Record<string, string>> | null {
	// A committed symbolic link could point .env at any file on this machine.
	assertNoSymlinks(projectRoot, ENV_FILE);
	let text: string;
	try {
		text = readFileSync(join(projectRoot, HEYDB_DIR, ENV_FILE), "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error; // a permission error names the path, never the content
	}
	return parseEnvFile(text);
}

/**
 * A deliberately small .env reader. Supported: KEY=VALUE lines, an optional
 * "export " prefix, "#" comment lines, blank lines, Windows line endings, a
 * leading byte order mark, and one pair of matching single or double quotes
 * around the value. The value is everything after the first "=", trimmed, so
 * "a=b" and "#" are kept as part of it: passwords often contain them.
 *
 * Not supported, on purpose: multi-line values, escapes such as \n, variable
 * expansion ($OTHER) and comments after a value. A line that is not KEY=VALUE
 * is an error that names the line number only, never its content.
 */
export function parseEnvFile(text: string): Readonly<Record<string, string>> {
	// A Map, then Object.fromEntries: a key called "__proto__" stays a plain key.
	const values = new Map<string, string>();
	// Some Windows editors start the file with a byte order mark.
	text.replace(/^\uFEFF/, "").split("\n").forEach((raw, index) => {
		const line = raw.replace(/\r$/, "").trim();
		if (line === "" || line.startsWith("#")) return;
		const match = ENV_LINE.exec(line);
		if (match === null) {
			throw new Error(`.heydb/.env line ${index + 1} is not KEY=VALUE (names use letters, digits and _)`);
		}
		values.set(match[1] as string, unquote((match[2] as string).trim()));
	});
	return Object.fromEntries(values);
}

function unquote(value: string): string {
	const first = value[0];
	if (value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first)) return value.slice(1, -1);
	return value;
}
