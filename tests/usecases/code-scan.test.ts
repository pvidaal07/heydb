import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { type CodeFiles, type ScanLimits, findSchemaUsage } from "../../lib/usecases/code-scan.ts";
import type { RunGit } from "../../lib/usecases/sharing.ts";
import type { Table } from "../../lib/model/snapshot.ts";
import { customersTable, ordersTable, snapshot } from "../fixtures/snapshot.ts";

function table(name: string): Table {
	return { ...customersTable(), name };
}

// gar holds the articles, gcl the customers: legacy names the code explains.
const erp = snapshot([
	table("gar"),
	table("gcl"),
	table("gcv"),
	table("ab"),
]);

/** An in-memory project: path → content. Records every file read. */
function memoryFiles(contents: Record<string, string>) {
	const reads: string[] = [];
	const files: CodeFiles = {
		async list(dir) {
			const prefix = dir === "" ? "" : `${dir}/`;
			const entries = new Map<string, "file" | "dir">();
			for (const path of Object.keys(contents)) {
				if (!path.startsWith(prefix)) continue;
				const [name = "", ...rest] = path.slice(prefix.length).split("/");
				entries.set(name, rest.length > 0 ? "dir" : "file");
			}
			return [...entries].map(([name, kind]) => ({ name, kind }));
		},
		async size(path) {
			const content = contents[path];
			return content === undefined ? null : Buffer.byteLength(content);
		},
		async read(path) {
			reads.push(path);
			const content = contents[path];
			if (content === undefined) throw new Error(`no file ${path}`);
			return content;
		},
	};
	return { files, reads };
}

const noGit: RunGit = async () => "missing";

const project = {
	"src/Models/Articulo.php": "class Articulo extends Model { protected $table = 'gar'; }\n// gar.ref is the article code; GAR in SQL too\n",
	"src/Models/Cliente.php": "class Cliente extends Model { protected $table = 'gcl'; }\n",
	"src/Repo/Ventas.php": "SELECT * FROM gar JOIN gcl ON gcl.ref = gar.ref_gcl",
	"src/garage.php": "garage ref_gar gar_id", // only whole identifiers count
	"vendor/lib/Gar.php": "gar gar gar gar gar gar",
	"node_modules/x/index.js": "gcl gcl gcl",
	"README.md": "gar gcl gcv",
	".heydb/.env": "HEYDB_LOCAL_PASSWORD=gar",
	".heydb/knowledge/local.json": '{"target":"gar"}',
};

describe("findSchemaUsage", () => {
	test("counts whole, case-insensitive table names in source files and skips vendored code", async () => {
		const { files, reads } = memoryFiles(project);
		const usage = await findSchemaUsage("/app", erp, { files, runGit: noGit });
		assert.deepEqual(usage, {
			hasCode: true,
			filesScanned: 4,
			filesMatched: 3,
			tablesMatched: 2,
			matches: [
				{ table: "shop.gar", name: "gar", files: ["src/Models/Articulo.php", "src/Repo/Ventas.php"], hits: 5 },
				{ table: "shop.gcl", name: "gcl", files: ["src/Repo/Ventas.php", "src/Models/Cliente.php"], hits: 3 },
			],
			truncated: false,
		});
		assert.deepEqual(reads.sort(), ["src/Models/Articulo.php", "src/Models/Cliente.php", "src/Repo/Ventas.php", "src/garage.php"]);
	});

	test("never reads anything under .heydb, the secrets file included, even when git lists it", async () => {
		const { files, reads } = memoryFiles({ ...project, ".heydb/model.php": "gar" });
		const listed = Object.keys(project).concat(".heydb/model.php").join("\0");
		const runGit: RunGit = async () => ({ exitCode: 0, stdout: `${listed}\0`, stderr: "" });
		const usage = await findSchemaUsage("/app", erp, { files, runGit });
		assert.equal(usage.filesScanned, 4);
		for (const path of reads) assert.doesNotMatch(path, /^\.heydb\/|vendor|node_modules|\.env/, path);
	});

	test("lists files with git ls-files from the project root when there is a repository", async () => {
		const calls: { args: readonly string[]; cwd: string }[] = [];
		const { files, reads } = memoryFiles(project);
		const runGit: RunGit = async (args, cwd) => {
			calls.push({ args, cwd });
			return { exitCode: 0, stdout: "src/Models/Cliente.php\0", stderr: "" };
		};
		const usage = await findSchemaUsage("/app", erp, { files, runGit });
		assert.deepEqual(calls, [{ args: ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd: "/app" }]);
		assert.deepEqual(reads, ["src/Models/Cliente.php"]);
		assert.deepEqual(usage.matches, [{ table: "shop.gcl", name: "gcl", files: ["src/Models/Cliente.php"], hits: 1 }]);
	});

	test("walks the folder when git is missing or this is not a repository", async () => {
		const notRepo: RunGit = async () => ({ exitCode: 128, stdout: "", stderr: "fatal: not a git repository" });
		for (const runGit of [noGit, notRepo]) {
			const { files } = memoryFiles(project);
			assert.equal((await findSchemaUsage("/app", erp, { files, runGit })).filesScanned, 4);
		}
	});

	test("without source files there is no code, and no code using the tables is no match", async () => {
		const empty = memoryFiles({ "README.md": "gar", "notes.txt": "gcl" });
		assert.deepEqual(await findSchemaUsage("/app", erp, { files: empty.files, runGit: noGit }), {
			hasCode: false,
			filesScanned: 0,
			filesMatched: 0,
			tablesMatched: 0,
			matches: [],
			truncated: false,
		});
		const unrelated = memoryFiles({ "src/app.ts": "export const x = 1;" });
		const usage = await findSchemaUsage("/app", erp, { files: unrelated.files, runGit: noGit });
		assert.equal(usage.hasCode, true);
		assert.deepEqual(usage.matches, []);
	});

	test("skips files bigger than the per-file limit without calling the scan truncated", async () => {
		const { files, reads } = memoryFiles({ "big.sql": `${"x".repeat(100)} gar`, "small.sql": "gcl" });
		const usage = await findSchemaUsage("/app", erp, { files, runGit: noGit, limits: { maxFileBytes: 50 } });
		assert.deepEqual(reads, ["small.sql"]);
		assert.equal(usage.truncated, false);
	});

	test("stops at the file, byte and time limits and returns what it found, marked truncated", async () => {
		const many = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`src/m${i}.php`, "gar"]));
		const cases: [Partial<ScanLimits>, number][] = [
			[{ maxFiles: 3 }, 3],
			[{ maxBytes: 7 }, 2],
		];
		for (const [limits, scanned] of cases) {
			const { files } = memoryFiles(many);
			const usage = await findSchemaUsage("/app", erp, { files, runGit: noGit, limits });
			assert.equal(usage.filesScanned, scanned, JSON.stringify(limits));
			assert.equal(usage.truncated, true);
			assert.equal(usage.matches[0]?.hits, scanned);
		}
		let clock = 0;
		const { files } = memoryFiles(many);
		const usage = await findSchemaUsage("/app", erp, {
			files: { ...files, read: async (path) => ((clock += 400), files.read(path)) },
			runGit: noGit,
			now: () => clock,
			limits: { maxMillis: 1000 },
		});
		assert.equal(usage.truncated, true);
		assert.equal(usage.filesScanned, 3);
	});

	test("in a huge schema looks only for the most referenced tables", async () => {
		const { files } = memoryFiles({ "src/app.sql": "SELECT * FROM accounts, orders JOIN customers" });
		// accounts comes first by name, but orders points to customers.
		const usage = await findSchemaUsage("/app", snapshot([table("accounts"), customersTable(), ordersTable()]), {
			files,
			runGit: noGit,
			limits: { maxTables: 1 },
		});
		assert.deepEqual(usage.matches, [{ table: "shop.customers", name: "customers", files: ["src/app.sql"], hits: 1 }]);
	});

	test("keeps at most 5 files per table and the 30 most used tables", async () => {
		const tables = Array.from({ length: 35 }, (_, i) => table(`t${String(i).padStart(2, "0")}x`));
		const contents: Record<string, string> = {};
		tables.forEach((item, i) => {
			contents[`src/${item.name}.sql`] = `${item.name} `.repeat(i + 1);
		});
		for (let i = 0; i < 7; i++) contents[`src/extra${i}.sql`] = "t34x";
		const { files } = memoryFiles(contents);
		const usage = await findSchemaUsage("/app", snapshot(tables), { files, runGit: noGit });
		assert.equal(usage.tablesMatched, 35);
		assert.equal(usage.matches.length, 30);
		assert.deepEqual(usage.matches[0], {
			table: "shop.t34x",
			name: "t34x",
			files: ["src/t34x.sql", "src/extra0.sql", "src/extra1.sql", "src/extra2.sql", "src/extra3.sql"],
			hits: 42,
		});
		assert.equal(usage.matches.at(-1)?.name, "t05x");
	});
});
