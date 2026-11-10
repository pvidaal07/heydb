import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { promisify } from "node:util";

import { previewLearnCode, renderPreview } from "../../bench/learn-code.ts";
import { saveConfig } from "../../lib/config/store.ts";
import type { Table } from "../../lib/model/snapshot.ts";
import { saveSnapshot } from "../../lib/store/snapshots.ts";
import { initProject } from "../../lib/usecases/init.ts";
import { annotate } from "../../lib/usecases/knowledge.ts";
import { customersTable, ordersTable, snapshot } from "../fixtures/snapshot.ts";

const REPO = resolve(import.meta.dirname, "..", "..");
const run = promisify(execFile);

const scratch: string[] = [];
after(() => {
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function table(name: string, overrides: Partial<Table> = {}): Table {
	return { ...customersTable(), name, ...overrides };
}

/** A heydb project with code and docs: cst is cryptic and referenced, clientes commented, pedidos noted. */
function project(): string {
	const root = mkdtempSync(join(tmpdir(), "heydb-bench-learn-src-"));
	scratch.push(root);
	initProject(root);
	const erp = { engine: "mysql" as const, host: "127.0.0.1", port: 3306, user: "bench", password: "env:HEYDB_BENCH_PASSWORD", databases: null };
	saveConfig(root, { formatVersion: 1, defaultConnection: "erp", connections: { erp } });
	const toCst = { ...ordersTable().foreignKeys[0]!, references: { database: "shop", schema: "shop", table: "cst", columns: ["id"] } };
	saveSnapshot(
		root,
		"erp",
		snapshot([
			table("cst"),
			table("clientes", { comment: "Clientes: uno por cliente" }),
			table("pedidos"),
			table("lineas", { foreignKeys: [toCst] }),
		]),
	);
	annotate(root, "erp", { target: "shop.shop.pedidos", text: "Pedidos de venta (orders)", author: "Ana" });
	const files: Record<string, string> = {
		"src/Cst.php": "class Cst extends Model { protected $table = 'cst'; }\n",
		"src/ventas.sql": "SELECT * FROM pedidos JOIN clientes ON 1 = 1;\nSELECT * FROM pedidos;\n",
		"docs/tablas.md": "| cst | Cabeceras de clientes |\n",
		".heydb/.env": "HEYDB_ERP_PASSWORD=secret\n",
	};
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	return root;
}

/** Every file under `root` with its content and modification time. */
function tree(root: string): Record<string, string> {
	const files: Record<string, string> = {};
	for (const path of readdirSync(root, { recursive: true }) as string[]) {
		const full = join(root, path);
		const stats = statSync(full);
		files[path] = stats.isFile() ? `${stats.mtimeMs} ${readFileSync(full, "base64")}` : "dir";
	}
	return files;
}

const leftovers = () => readdirSync(tmpdir()).filter((name) => name.startsWith("heydb-bench-learn-code-"));

describe("bench/learn-code.ts", () => {
	test("shows, without a model, the tables in the order the agent gets them, their evidence and the message size", async () => {
		const root = project();
		const preview = await previewLearnCode(root);
		assert.equal(preview.connection, "erp");
		assert.deepEqual(
			preview.usage.matches.map((match) => [match.table, match.described, match.files, match.docs]),
			[
				["shop.cst", "nothing", ["src/Cst.php"], ["docs/tablas.md"]],
				["shop.clientes", "comment", ["src/ventas.sql"], []],
				["shop.pedidos", "note", ["src/ventas.sql"], []],
			],
		);
		assert.match(preview.message, /^heydb: the user agreed that you learn about the database of connection "erp" from this project's code\./);
		assert.ok(preview.message.includes("- shop.cst (1 use): src/Cst.php; docs: docs/tablas.md\n"), preview.message);
		assert.equal(preview.tokens, Math.round(preview.message.length / 4));
		const report = renderPreview(preview);
		assert.match(report, /^learn-code erp: 2 code files and 1 docs read, 3 tables used or defined, 3 listed, 0 more need a note, message ≈\d+ tokens\n/);
		assert.ok(report.includes("| 1 | shop.cst | nothing | yes | 1 | 1 | src/Cst.php | docs/tablas.md |"), report);
	});

	test("never writes into the project or the code folder, and removes its temporary copy", async () => {
		const root = project();
		const code = mkdtempSync(join(tmpdir(), "heydb-bench-legacy-"));
		scratch.push(code);
		writeFileSync(join(code, "legacy.prg"), 'cSql := "SELECT * FROM clientes"\n');
		const before = [tree(root), tree(code)];
		const temporary = leftovers();

		const other = await previewLearnCode(root, { code });
		assert.deepEqual(other.usage.matches.map((match) => match.name), ["clientes"]);
		assert.ok(other.message.includes(`from the code in ${realpathSync(code)}. File paths below are relative to that folder.`), other.message);
		const { stdout } = await run(process.execPath, ["bench/learn-code.ts", "--project", root, "--message"], { cwd: REPO });
		assert.match(stdout, /\| 1 \| shop\.cst \|/);
		assert.ok(stdout.includes("Rules:\n"), stdout);

		assert.deepEqual([tree(root), tree(code)], before);
		assert.deepEqual(leftovers(), temporary);
	});
});
