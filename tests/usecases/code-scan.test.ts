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
	"src/garage.php": "SELECT * FROM garage JOIN ref_gar ON gar_id", // only whole names count
	"vendor/lib/Gar.php": "gar gar gar gar gar gar",
	"node_modules/x/index.js": "gcl gcl gcl",
	"README.md": "gar gcl gcv",
	".heydb/.env": "HEYDB_LOCAL_PASSWORD=gar",
	".heydb/knowledge/local.json": '{"target":"gar"}',
};

describe("findSchemaUsage", () => {
	test("counts table names in database context, case-insensitive, and skips vendored code", async () => {
		const { files, reads } = memoryFiles(project);
		const usage = await findSchemaUsage("/app", erp, { files, runGit: noGit });
		assert.deepEqual(usage, {
			hasCode: true,
			filesScanned: 4,
			filesMatched: 3,
			tablesMatched: 2,
			matches: [
				{ table: "shop.gar", name: "gar", files: ["src/Models/Articulo.php", "src/Repo/Ventas.php"], hits: 2 },
				{ table: "shop.gcl", name: "gcl", files: ["src/Models/Cliente.php", "src/Repo/Ventas.php"], hits: 2 },
			],
			truncated: false,
		});
		assert.deepEqual(reads.sort(), ["src/Models/Articulo.php", "src/Models/Cliente.php", "src/Repo/Ventas.php", "src/garage.php"]);
	});

	test("never reads anything under .heydb, the secrets file included, even when git lists it", async () => {
		const { files, reads } = memoryFiles({ ...project, ".heydb/model.php": "SELECT * FROM gar" });
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
		const empty = memoryFiles({ "README.md": "FROM gar", "notes.txt": "FROM gcl" });
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
		const { files, reads } = memoryFiles({ "big.sql": `${"x".repeat(100)} FROM gar`, "small.sql": "FROM gcl" });
		const usage = await findSchemaUsage("/app", erp, { files, runGit: noGit, limits: { maxFileBytes: 50 } });
		assert.deepEqual(reads, ["small.sql"]);
		assert.equal(usage.truncated, false);
	});

	test("stops at the file, byte and time limits and returns what it found, marked truncated", async () => {
		const many = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`src/m${i}.php`, "SELECT * FROM gar"]));
		const cases: [Partial<ScanLimits>, number][] = [
			[{ maxFiles: 3 }, 3],
			[{ maxBytes: 40 }, 2],
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
			contents[`src/${item.name}.sql`] = `SELECT * FROM ${item.name};\n`.repeat(i + 1);
		});
		for (let i = 0; i < 7; i++) contents[`src/extra${i}.sql`] = "SELECT * FROM t34x";
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

	test("SQL: the name right after FROM, JOIN, INTO, UPDATE, TABLE or DELETE FROM, quoted or qualified, inside strings too", async () => {
		const { files } = memoryFiles({
			"from.php": '$rows = $db->query("SELECT ref FROM gar WHERE id = 1");',
			"join.sql": "select *\nfrom `erp`.`gcl`\n  left join\n    [dbo].[gcv] on 1 = 1",
			"into.py": "cursor.execute('INSERT INTO \"public\".\"gar\" (ref) VALUES (%s)')",
			"update.go": 'db.Exec("UPDATE erp.gcl SET name = ?")\ndb.Exec("UPDATE gar a JOIN gcl b ON a.x = b.x SET a.y = 1")',
			"table.sql": "CREATE TABLE IF NOT EXISTS gcv (id int);\nALTER TABLE 'gar' ADD x int;",
			"delete.ts": "await sql`DELETE FROM gcv WHERE id = ${id}`;",
		});
		const usage = await findSchemaUsage("/app", erp, { files, runGit: noGit });
		assert.deepEqual(usage.matches, [
			{ table: "shop.gar", name: "gar", files: ["from.php", "into.py", "table.sql", "update.go"], hits: 4 },
			{ table: "shop.gcl", name: "gcl", files: ["update.go", "join.sql"], hits: 3 },
			{ table: "shop.gcv", name: "gcv", files: ["delete.ts", "join.sql", "table.sql"], hits: 3 },
		]);
	});

	// One documented example per ORM or mapping family; each must find exactly its table.
	const declarations: [string, string, string][] = [
		["Eloquent $table property", "Gar.php", "class Gar extends Model { protected $table = \"gar\"; }"],
		["plain table assignment", "gar.rb", "self.table = 'gar'"],
		["Laravel query builder", "Repo.php", "DB::table('gar')->get(); $q->from('gar');"],
		["fluent .table() call", "repo.js", 'db.table("gar").select()'],
		["knex", "repo.ts", "await knex('gar').where({ id })"],
		["JPA @Table", "Gar.java", '@Entity\n@Table(name = "gar")\npublic class Gar {}'],
		["JPA @Entity with a table name", "Gar.kt", '@Entity(name = "gar")\nclass Gar'],
		["C# [Table]", "Gar.cs", '[Table("gar")]\npublic class Gar {}'],
		["SQLAlchemy __tablename__", "models.py", 'class Gar(Base):\n    __tablename__ = "gar"'],
		["Django db_table", "models.py", "class Meta:\n    db_table = 'gar'"],
		["tableName option", "gar.ts", 'sequelize.define("Gar", {}, { tableName: "gar" });\nconst x = { tableName = "gar" };'],
		["Doctrine XML entity", "Gar.orm.xml", '<entity name="App\\Gar" table="gar">'],
		["YAML mapping", "Gar.orm.yml", "App\\Gar:\n  type: entity\n  table: gar\n"],
	];
	for (const [family, path, code] of declarations) {
		test(`ORM declaration: ${family}`, async () => {
			const { files } = memoryFiles({ [path]: code });
			const usage = await findSchemaUsage("/app", erp, { files, runGit: noGit });
			assert.deepEqual(
				usage.matches.map((match) => match.name),
				["gar"],
				code,
			);
		});
	}

	test("plain occurrences do not count: comments, prose, identifiers, help text", async () => {
		const { files } = memoryFiles({
			"src/a.ts": "// gar holds the articles\nconst gar = loadGar(gcl);\nconsole.log(\"Usa --help para ver gcv\");",
			"src/b.php": "/* see gcl and gcv */ $gar->save(); echo 'gar';",
			"src/c.yml": "name: gar\ndescription: the gcl table\n",
		});
		const usage = await findSchemaUsage("/app", erp, { files, runGit: noGit });
		assert.equal(usage.hasCode, true);
		assert.equal(usage.filesScanned, 3);
		assert.deepEqual(usage.matches, []);
	});

	test("never reads lockfiles, CI configuration or minified bundles", async () => {
		const skipped = [
			"pnpm-lock.yaml",
			"sub/pnpm-lock.yaml",
			"yarn.lock",
			"composer.lock",
			"Gemfile.lock",
			"poetry.lock",
			"Cargo.lock",
			"go.sum",
			"package-lock.json",
			".github/workflows/ci.yml",
			".gitlab/ci/node.yml",
			".gitlab-ci.yml",
			".circleci/config.yml",
			"public/app.min.js",
		];
		const contents = Object.fromEntries(skipped.map((path) => [path, "SELECT * FROM gar"]));
		const { files, reads } = memoryFiles({ ...contents, "src/app.js": "SELECT * FROM gcl" });
		for (const runGit of [noGit, async () => ({ exitCode: 0, stdout: `${Object.keys(contents).join("\0")}\0src/app.js\0`, stderr: "" })]) {
			reads.length = 0;
			const usage = await findSchemaUsage("/app", erp, { files, runGit });
			assert.deepEqual(reads, ["src/app.js"]);
			assert.deepEqual(usage.matches.map((match) => match.name), ["gcl"]);
		}
	});

	test("field case: ordinary-word table names in a project without database code match nothing", async () => {
		const words = snapshot([table("para"), table("destino"), table("config"), table("project")]);
		const { files } = memoryFiles({
			"pnpm-lock.yaml": "packages:\n  config@1.0.0:\n    resolution: {integrity: sha512-x}\n  project@2.0.0: {}\n",
			"src/cli.ts": 'export const HELP = "Usa --help para ver los comandos";\n',
			"src/git.ts": "// rama destino: la rama sobre la que se fusiona\nexport const destino = 'main';\n",
			".gitlab/ci/node.yml": "script:\n  - pnpm config set store-dir .pnpm-store\n",
			"docs/commits.md": "feat(project): update config",
			// SQL words in prose: no SELECT before "from", no SET after "update", no FROM before "join".
			"src/commits.ts": 'export const EXAMPLE = "chore(project): update config and join project";\n// read defaults from config\n',
		});
		const usage = await findSchemaUsage("/app", words, { files, runGit: noGit });
		assert.deepEqual(usage, {
			hasCode: true,
			filesScanned: 3,
			filesMatched: 0,
			tablesMatched: 0,
			matches: [],
			truncated: false,
		});
	});

	test("field case, positive: a PHP model and a repository query", async () => {
		const { files } = memoryFiles({
			"app/Models/Articulo.php": "<?php\nclass Articulo extends Model\n{\n    protected $table = 'gar';\n}\n",
			"app/Repositories/Ventas.php": '<?php\n$sql = "SELECT * FROM gcl JOIN gcv ON gcv.cliente = gcl.codigo";\n',
		});
		const usage = await findSchemaUsage("/app", erp, { files, runGit: noGit });
		assert.deepEqual(
			usage.matches.map((match) => [match.name, match.files]),
			[
				["gar", ["app/Models/Articulo.php"]],
				["gcl", ["app/Repositories/Ventas.php"]],
				["gcv", ["app/Repositories/Ventas.php"]],
			],
		);
	});
});
