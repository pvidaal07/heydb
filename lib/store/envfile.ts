import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ENV_FILE, PASSWORD_REFERENCE, REFERENCE_RULE, parseEnvFile, parseEnvLine } from "../secrets.ts";
import { writeFileAtomic } from "./files.ts";
import { assertNoSymlinks } from "./guards.ts";
import { HEYDB_DIR } from "./project.ts";

// Writes .heydb/.env, the one file where heydb keeps a secret: the password a
// person typed, so they do not have to set a variable by hand. The file is
// local (.heydb/.gitignore excludes it; callers make sure of that before
// writing) and readable by its owner only. Every line heydb does not own is
// kept byte for byte: the file is also the person's own.
//
// What it does not protect: anyone who can read files as this user, or the
// disk itself, can read the password. The system keychain would; it remains
// a future option (ADR-0005).

/** Owner read and write only. Windows ignores it: there the folder's permissions apply. */
const OWNER_ONLY = 0o600;

/**
 * The line that stores `value` under `name`, encoded so parseEnvFile reads
 * back exactly `value`. That reader trims the value and strips one pair of
 * matching quotes around it, without escapes. So quotes are needed only when
 * something would otherwise be lost: whitespace at either end, or a quote at
 * the start that could be taken for a pair. A leading "#" is quoted too, so no
 * .env reader mistakes the value for a comment. Inside the quotes nothing is
 * special (parseEnvFile only looks at the first and last character), so a
 * value with both kinds of quote is fine. A line break is the one thing the
 * format cannot hold.
 */
export function envLine(name: string, value: string): string {
	assertVariable(name);
	if (/[\r\n]/.test(value)) {
		// Never the value: it is a password.
		throw new Error(`the value for ${name} has a line break, which .heydb/.env cannot hold: set ${name} in your shell instead`);
	}
	if (value === value.trim() && !/^["'#]/.test(value)) return `${name}=${value}`;
	const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
	return `${name}=${quote}${value}${quote}`;
}

/** Sets `name` in .heydb/.env: replaces the definition that counts, or appends one. */
export function setEnvValue(projectRoot: string, name: string, value: string): void {
	const line = envLine(name, value);
	const text = readEnvText(projectRoot) ?? "";
	const lines = text.split("\n");
	const index = lines.findLastIndex((raw, at) => keyOf(raw, at) === name);

	let next: string;
	if (index === -1) {
		const newline = text.includes("\r\n") ? "\r\n" : "\n";
		const separator = text === "" || text.endsWith("\n") ? "" : newline;
		next = `${text}${separator}${line}${newline}`;
	} else {
		const old = lines[index] as string;
		const bom = index === 0 && old.startsWith("\uFEFF") ? "\uFEFF" : "";
		lines[index] = `${bom}${line}${old.endsWith("\r") ? "\r" : ""}`;
		next = lines.join("\n");
	}

	// The proof, before anything is written: the file as heydb will read it
	// gives back exactly this value. It also refuses a file with lines that
	// are not KEY=VALUE, reporting their number only.
	if (parseEnvFile(next)[name] !== value) {
		throw new Error(`${name} could not be written to .heydb/.env so that it reads back the same: set it in your shell instead`);
	}
	writeFileAtomic(envPath(projectRoot), next, OWNER_ONLY);
}

/** Removes every definition of `name`; false when there was none (or no file). */
export function removeEnvValue(projectRoot: string, name: string): boolean {
	assertVariable(name);
	const text = readEnvText(projectRoot);
	if (text === null) return false;
	const lines = text.split("\n");
	const kept = lines.filter((raw, at) => keyOf(raw, at) !== name);
	if (kept.length === lines.length) return false;
	writeFileAtomic(envPath(projectRoot), kept.join("\n"), OWNER_ONLY);
	return true;
}

function envPath(projectRoot: string): string {
	return join(projectRoot, HEYDB_DIR, ENV_FILE);
}

/** The file's text, or null when it does not exist. */
function readEnvText(projectRoot: string): string | null {
	// A committed symbolic link could point .env at any file on this machine.
	assertNoSymlinks(projectRoot, ENV_FILE);
	try {
		return readFileSync(envPath(projectRoot), "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
}

/** The name a line defines, read exactly as parseEnvFile reads it (byte order mark included). */
function keyOf(raw: string, index: number): string | undefined {
	return parseEnvLine(index === 0 ? raw.replace(/^\uFEFF/, "") : raw)?.key;
}

// The same rule as references in config.json: heydb only ever touches its own variables.
function assertVariable(name: string): void {
	if (!PASSWORD_REFERENCE.test(`env:${name}`)) throw new Error(`${JSON.stringify(name)} is not a heydb variable: ${REFERENCE_RULE}`);
}
