import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { parseEnvFile, resolveSecret, secretSource } from "../lib/secrets.ts";

const SECRET = "s3cr3t-Value#1";
const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "heydb-secrets-"));
	dirs.push(dir);
	return dir;
}

/** A project root whose .heydb/.env holds the given content. */
function projectWithEnv(content: string): string {
	const root = tempDir();
	mkdirSync(join(root, ".heydb"));
	writeFileSync(join(root, ".heydb", ".env"), content);
	return root;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Everything an error could leak through: message, String(), JSON, stack and cause chain. */
function everythingIn(error: unknown): string {
	const parts: string[] = [];
	let current: unknown = error;
	while (current !== undefined && current !== null) {
		parts.push(String(current), JSON.stringify(current), JSON.stringify(current, Object.getOwnPropertyNames(current)));
		current = current instanceof Error ? current.cause : undefined;
	}
	return parts.join("\n");
}

function assertNoSecret(run: () => unknown, message: string | RegExp): void {
	assert.throws(run, (error: Error) => {
		if (typeof message === "string") assert.equal(error.message, message);
		else assert.match(error.message, message);
		assert.equal(everythingIn(error).includes(SECRET), false, "the secret leaked into the error");
		return true;
	});
}

describe("resolveSecret", () => {
	test("reads env:NAME from the environment first", () => {
		const env = { HEYDB_LOCAL_PASSWORD: SECRET };
		const projectRoot = projectWithEnv("HEYDB_LOCAL_PASSWORD=from-file\n");
		assert.equal(resolveSecret("env:HEYDB_LOCAL_PASSWORD", { connection: "local", env, projectRoot }), SECRET);
	});

	test("falls back to the .env file", () => {
		const projectRoot = projectWithEnv(`# local secrets\nHEYDB_LOCAL_PASSWORD=${SECRET}\n`);
		assert.equal(resolveSecret("env:HEYDB_LOCAL_PASSWORD", { connection: "local", env: {}, projectRoot }), SECRET);
	});

	test("an empty variable is set: some local servers have no password", () => {
		assert.equal(resolveSecret("env:HEYDB_EMPTY", { connection: "local", env: { HEYDB_EMPTY: "" } }), "");
	});

	test("explains how to set a missing variable, without leaking other secrets", () => {
		const projectRoot = projectWithEnv(`OTHER=${SECRET}\n`);
		const message =
			'password for connection "local" comes from env:HEYDB_LOCAL_PASSWORD, which is not set. ' +
			"Set it in your shell or in .heydb/.env (ignored by git).";
		assertNoSecret(() => resolveSecret("env:HEYDB_LOCAL_PASSWORD", { connection: "local", env: { X: SECRET }, projectRoot }), message);
		assertNoSecret(() => resolveSecret("env:HEYDB_LOCAL_PASSWORD", { connection: "local", env: {} }), message);
		// A project without .heydb/.env, and a folder that is not a project at all.
		const withoutEnv = tempDir();
		mkdirSync(join(withoutEnv, ".heydb"));
		assertNoSecret(() => resolveSecret("env:HEYDB_LOCAL_PASSWORD", { connection: "local", env: {}, projectRoot: withoutEnv }), message);
		assertNoSecret(() => resolveSecret("env:HEYDB_LOCAL_PASSWORD", { connection: "local", env: {}, projectRoot: tempDir() }), message);
	});

	test("rejects anything that is not an env:HEYDB_* reference, without echoing it", () => {
		const message =
			'password for connection "local" must be a reference such as "env:HEYDB_LOCAL_PASSWORD": ' +
			"only HEYDB_* variables can be used, so a shared config cannot read unrelated secrets from your environment";
		assertNoSecret(() => resolveSecret(SECRET, { connection: "local", env: {} }), message);
		// A committed config must not be able to send, say, your AWS key to its own host as a password.
		const env = { AWS_SECRET_ACCESS_KEY: SECRET, HEYDB_: SECRET, lower: SECRET };
		for (const reference of ["env:AWS_SECRET_ACCESS_KEY", "env:HEYDB_", "env:heydb_x", "env:lower"]) {
			assertNoSecret(() => resolveSecret(reference, { connection: "local", env }), message);
		}
	});

	test("refuses a symbolic link instead of .heydb/.env, without reading it", () => {
		const projectRoot = tempDir();
		mkdirSync(join(projectRoot, ".heydb"));
		const outside = join(tempDir(), "secrets");
		writeFileSync(outside, `HEYDB_LOCAL_PASSWORD=${SECRET}\n`);
		symlinkSync(outside, join(projectRoot, ".heydb", ".env"));
		assertNoSecret(
			() => resolveSecret("env:HEYDB_LOCAL_PASSWORD", { connection: "local", env: {}, projectRoot }),
			".heydb/.env is a symbolic link; heydb refuses to follow it",
		);
	});

	test("a malformed .env line is reported by number, never by content", () => {
		const projectRoot = projectWithEnv(`HEYDB_A=1\n${SECRET}\n`);
		assertNoSecret(
			() => resolveSecret("env:HEYDB_A", { connection: "local", env: {}, projectRoot }),
			/^\.heydb\/\.env line 2 is not KEY=VALUE/,
		);
	});
});

describe("secretSource", () => {
	test("says where a password would come from, never what it is", () => {
		const projectRoot = projectWithEnv(`HEYDB_FILE=${SECRET}\nHEYDB_BOTH=file\n`);
		const env = { HEYDB_ENV: SECRET, HEYDB_BOTH: "env" };
		const source = (reference: string) => secretSource(reference, { connection: "local", env, projectRoot });
		assert.equal(source("env:HEYDB_ENV"), "environment");
		assert.equal(source("env:HEYDB_FILE"), "env-file");
		assert.equal(source("env:HEYDB_BOTH"), "environment", "the environment wins, as in resolveSecret");
		assert.equal(source("env:HEYDB_NONE"), null);
		assert.equal(secretSource("env:HEYDB_FILE", { connection: "local", env: {} }), null, "no project, no file");
	});

	test("rejects what resolveSecret rejects, without echoing it", () => {
		assertNoSecret(() => secretSource(SECRET, { connection: "local", env: {} }), /must be a reference/);
		const projectRoot = projectWithEnv(`${SECRET}\n`);
		assertNoSecret(() => secretSource("env:HEYDB_A", { connection: "local", env: {}, projectRoot }), /line 1 is not KEY=VALUE/);
	});
});

describe("parseEnvFile", () => {
	test("reads KEY=VALUE lines, comments, blank lines and optional quotes", () => {
		const text = [
			"# comment",
			"",
			"PLAIN=abc",
			"  SPACED  =  padded value  ",
			'DOUBLE="with # hash and spaces "',
			"SINGLE='it''s'",
			"EQUALS=a=b=c",
			"HASH=pa#ss",
			"export EXPORTED=yes",
			"CRLF=windows\r",
			'HALF="unclosed',
		].join("\n");
		assert.deepEqual(parseEnvFile(text), {
			PLAIN: "abc",
			SPACED: "padded value",
			DOUBLE: "with # hash and spaces ",
			SINGLE: "it''s",
			EQUALS: "a=b=c",
			HASH: "pa#ss",
			EXPORTED: "yes",
			CRLF: "windows",
			HALF: '"unclosed',
		});
	});

	test("a UTF-8 byte order mark does not hide the first key", () => {
		assert.deepEqual(parseEnvFile("\uFEFFX=1\r\n"), { X: "1" });
	});

	test("the last definition wins and __proto__ is a plain key", () => {
		const values = parseEnvFile("A=1\nA=2\n__proto__=x\n");
		assert.equal(values.A, "2");
		assert.equal(Object.hasOwn(values, "__proto__"), true);
	});

	test("rejects lines that are not KEY=VALUE, by number only", () => {
		assert.throws(() => parseEnvFile("A=1\nnot a pair\n"), {
			message: ".heydb/.env line 2 is not KEY=VALUE (names use letters, digits and _)",
		});
		assert.throws(() => parseEnvFile("1A=x"), { message: ".heydb/.env line 1 is not KEY=VALUE (names use letters, digits and _)" });
	});
});
