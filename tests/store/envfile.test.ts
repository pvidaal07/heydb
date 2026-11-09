import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { resolveSecret } from "../../lib/secrets.ts";
import { envLine, removeEnvValue, setEnvValue } from "../../lib/store/envfile.ts";

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "heydb-envfile-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A project root; with `content`, its .heydb/.env holds it. */
function project(content?: string): string {
	const root = tempDir();
	mkdirSync(join(root, ".heydb"));
	if (content !== undefined) writeFileSync(join(root, ".heydb", ".env"), content);
	return root;
}

function envText(root: string): string {
	return readFileSync(join(root, ".heydb", ".env"), "utf8");
}

function resolved(root: string, name: string): string {
	return resolveSecret(`env:${name}`, { connection: "local", env: {}, projectRoot: root });
}

const posix = process.platform !== "win32";

// Passwords people really use: every one must come back exactly as typed.
const TRICKY = [
	"",
	"simple",
	" leading space",
	"trailing space ",
	"  both  ",
	"\tTab",
	"#starts-with-hash",
	"pa#ss",
	"a=b=c",
	"'single'",
	'"double"',
	"it's",
	'say "hi"',
	`it's "both"`,
	`'it's "both"'`,
	`"mixed'`,
	"'",
	'"',
	"''",
	'""',
	"back\\slash\\n",
	"$HOME and ${PATH}",
	"export X=1",
	"ünïcødé 密码 🔑",
	"\uFEFFbom",
	"nbsp\u00A0",
];

describe("setEnvValue", () => {
	test("every tricky password comes back exactly through resolveSecret", () => {
		const root = project("# mine\nOTHER=1\n");
		for (const value of TRICKY) {
			setEnvValue(root, "HEYDB_LOCAL_PASSWORD", value);
			assert.equal(resolved(root, "HEYDB_LOCAL_PASSWORD"), value, JSON.stringify(value));
		}
		// Many names at once, each kept apart from the others.
		const fresh = project();
		TRICKY.forEach((value, index) => setEnvValue(fresh, `HEYDB_P${index}`, value));
		TRICKY.forEach((value, index) => assert.equal(resolved(fresh, `HEYDB_P${index}`), value, JSON.stringify(value)));
	});

	test("writes plain values plainly and quotes only what needs it", () => {
		assert.equal(envLine("HEYDB_A", "plain"), "HEYDB_A=plain");
		assert.equal(envLine("HEYDB_A", ""), "HEYDB_A=");
		assert.equal(envLine("HEYDB_A", "pa#ss"), "HEYDB_A=pa#ss");
		assert.equal(envLine("HEYDB_A", " x"), "HEYDB_A=' x'");
		assert.equal(envLine("HEYDB_A", "#x"), "HEYDB_A='#x'");
		assert.equal(envLine("HEYDB_A", '"x"'), "HEYDB_A='\"x\"'");
		assert.equal(envLine("HEYDB_A", "'x "), "HEYDB_A=\"'x \"");
	});

	test("creates .heydb/.env readable by its owner only", () => {
		const root = project();
		setEnvValue(root, "HEYDB_LOCAL_PASSWORD", "s3cret");
		assert.equal(envText(root), "HEYDB_LOCAL_PASSWORD=s3cret\n");
		if (posix) assert.equal(statSync(join(root, ".heydb", ".env")).mode & 0o777, 0o600);
	});

	test("replaces the value in place and keeps every other line byte for byte", () => {
		const before = "# my notes\r\nOTHER='x'\r\nHEYDB_A=old\r\n\n  export HEYDB_B = keep \n";
		const root = project(before);
		setEnvValue(root, "HEYDB_A", "new value");
		assert.equal(envText(root), "# my notes\r\nOTHER='x'\r\nHEYDB_A=new value\r\n\n  export HEYDB_B = keep \n");
		setEnvValue(root, "HEYDB_B", "changed");
		assert.equal(envText(root), "# my notes\r\nOTHER='x'\r\nHEYDB_A=new value\r\n\nHEYDB_B=changed\n");
	});

	test("appends a new name, adding the missing final newline first", () => {
		const root = project("OTHER=1");
		setEnvValue(root, "HEYDB_A", "x");
		assert.equal(envText(root), "OTHER=1\nHEYDB_A=x\n");
	});

	test("replaces the last definition of a repeated name and removes the earlier ones, so no old password stays", () => {
		const root = project("\uFEFFHEYDB_A=first\r\n# keep\nexport HEYDB_A='old'\nOTHER=1\nHEYDB_A=second\r\nTAIL=2");
		setEnvValue(root, "HEYDB_A", "third");
		assert.equal(envText(root), "\uFEFF# keep\nOTHER=1\nHEYDB_A=third\r\nTAIL=2");
		assert.doesNotMatch(envText(root), /first|old|second/);
		assert.equal(resolved(root, "HEYDB_A"), "third");
	});

	test("tightens the permissions of an existing file", { skip: !posix && "no POSIX permissions on Windows" }, () => {
		const root = project("OTHER=1\n");
		const path = join(root, ".heydb", ".env");
		writeFileSync(path, "OTHER=1\n", { mode: 0o644 });
		setEnvValue(root, "HEYDB_A", "x");
		assert.equal(statSync(path).mode & 0o777, 0o600);
	});

	test("refuses a value with a line break, never echoing it, and writes nothing", () => {
		for (const value of ["first\nSECRET-PART", "first\rSECRET-PART"]) {
			const root = project("OTHER=1\n");
			assert.throws(
				() => setEnvValue(root, "HEYDB_A", value),
				(error: Error) => {
					assert.equal(
						error.message,
						"the value for HEYDB_A has a line break, which .heydb/.env cannot hold: set HEYDB_A in your shell instead",
					);
					assert.doesNotMatch(String(error.stack), /SECRET-PART/);
					return true;
				},
			);
			assert.equal(envText(root), "OTHER=1\n");
		}
	});

	test("only writes HEYDB_* names", () => {
		const root = project("OTHER=1\n");
		for (const name of ["AWS_SECRET_ACCESS_KEY", "HEYDB_", "heydb_a", "HEYDB_A=B", "HEYDB A"]) {
			assert.throws(() => setEnvValue(root, name, "x"), {
				message:
					`${JSON.stringify(name)} is not a heydb variable: ` +
					"only HEYDB_* variables can be used, so a shared config cannot read unrelated secrets from your environment",
			});
		}
		assert.equal(envText(root), "OTHER=1\n");
	});

	test("refuses a symbolic link instead of .heydb/.env and leaves its target alone", () => {
		const root = project();
		const outside = join(tempDir(), "target");
		writeFileSync(outside, "KEEP=1\n");
		symlinkSync(outside, join(root, ".heydb", ".env"));
		assert.throws(() => setEnvValue(root, "HEYDB_A", "x"), {
			message: ".heydb/.env is a symbolic link; heydb refuses to follow it",
		});
		assert.equal(readFileSync(outside, "utf8"), "KEEP=1\n");
	});

	test("refuses to rewrite a .env it cannot read, naming the line only", () => {
		const root = project("HEYDB_A=1\nnot a pair SECRET-PART\n");
		assert.throws(
			() => setEnvValue(root, "HEYDB_B", "x"),
			(error: Error) => {
				assert.match(error.message, /^\.heydb\/\.env line 2 is not KEY=VALUE/);
				assert.doesNotMatch(error.message, /SECRET-PART/);
				return true;
			},
		);
		assert.equal(envText(root), "HEYDB_A=1\nnot a pair SECRET-PART\n");
	});
});

describe("removeEnvValue", () => {
	test("removes every definition of the name and keeps the rest byte for byte", () => {
		const root = project("# notes\r\nHEYDB_A=1\r\nOTHER=2\nexport HEYDB_A='x'\n");
		assert.equal(removeEnvValue(root, "HEYDB_A"), true);
		assert.equal(envText(root), "# notes\r\nOTHER=2\n");
		if (posix) assert.equal(statSync(join(root, ".heydb", ".env")).mode & 0o777, 0o600);
	});

	test("keeps the file's byte order mark when the first line is the one removed", () => {
		const root = project("\uFEFFHEYDB_A=1\nOTHER=2\nHEYDB_A=3\n");
		assert.equal(removeEnvValue(root, "HEYDB_A"), true);
		assert.equal(envText(root), "\uFEFFOTHER=2\n");
	});

	test("does nothing when the name or the file is not there", () => {
		const root = project("OTHER=2\n");
		assert.equal(removeEnvValue(root, "HEYDB_A"), false);
		assert.equal(envText(root), "OTHER=2\n");
		const empty = project();
		assert.equal(removeEnvValue(empty, "HEYDB_A"), false);
		assert.equal(existsSync(join(empty, ".heydb", ".env")), false);
	});

	test("only removes HEYDB_* names", () => {
		const root = project("OTHER=2\n");
		assert.throws(() => removeEnvValue(root, "OTHER"), { message: /^"OTHER" is not a heydb variable/ });
		assert.equal(envText(root), "OTHER=2\n");
	});
});
