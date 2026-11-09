import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { type CodeFiles, type ScanLimits, findSchemaUsage } from "../../lib/usecases/code-scan.ts";
import type { Table } from "../../lib/model/snapshot.ts";
import { customersTable, ordersTable, snapshot } from "../fixtures/snapshot.ts";

function table(name: string): Table {
	return { ...customersTable(), name };
}

// art holds the articles, cus the customers: legacy names the code explains.
const erp = snapshot([
	table("art"),
	table("cus"),
	table("dln"),
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


const project = {
	"src/Models/Articulo.php": "class Articulo extends Model { protected $table = 'art'; }\n// art.ref is the article code; ART in SQL too\n",
	"src/Models/Cliente.php": "class Cliente extends Model { protected $table = 'cus'; }\n",
	"src/Repo/Ventas.php": "SELECT * FROM art JOIN cus ON cus.ref = art.ref_cus",
	"src/article.php": "SELECT * FROM article JOIN ref_art ON art_id", // only whole names count
	"vendor/lib/Art.php": "art art art art art art",
	"node_modules/x/index.js": "cus cus cus",
	"README.md": "art cus dln",
	".heydb/.env": "HEYDB_LOCAL_PASSWORD=art",
	".heydb/knowledge/local.json": '{"target":"art"}',
};

describe("findSchemaUsage", () => {
	test("counts table names in database context, case-insensitive, and skips vendored code", async () => {
		const { files, reads } = memoryFiles(project);
		const usage = await findSchemaUsage("/app", erp, { files });
		assert.deepEqual(usage, {
			hasCode: true,
			filesScanned: 4,
			filesMatched: 3,
			tablesMatched: 2,
			matches: [
				{ table: "shop.art", name: "art", files: ["src/Models/Articulo.php", "src/Repo/Ventas.php"], hits: 2 },
				{ table: "shop.cus", name: "cus", files: ["src/Models/Cliente.php", "src/Repo/Ventas.php"], hits: 2 },
			],
			truncated: false,
		});
		assert.deepEqual(reads.sort(), ["src/Models/Articulo.php", "src/Models/Cliente.php", "src/Repo/Ventas.php", "src/article.php"]);
	});

	test("never reads anything under .heydb, the secrets file included", async () => {
		const { files, reads } = memoryFiles({ ...project, ".heydb/model.php": "SELECT * FROM art" });
		const usage = await findSchemaUsage("/app", erp, { files });
		assert.equal(usage.filesScanned, 4);
		for (const path of reads) assert.doesNotMatch(path, /^\.heydb\/|vendor|node_modules|\.env/, path);
	});

	// The code that uses a database is often a reference copy of another repository
	// kept in a folder git ignores (source-code/ here). Listing files through git
	// would hide it, so the folders are walked directly.
	test("reads code in folders git ignores, such as a reference copy of another repository", async () => {
		const { files } = memoryFiles({
			".gitignore": "source-code/\n",
			"src/cli.ts": "console.log('help')",
			"source-code/legacy-app-master/Articulos.pas": "x",
			"source-code/legacy-app-master/sql/ventas.sql": "SELECT * FROM cus JOIN art ON art.id = cus.id",
			"coverage/lcov-report/index.js": "SELECT * FROM dln",
		});
		const usage = await findSchemaUsage("/app", erp, { files });
		assert.deepEqual(
			usage.matches.map((match) => [match.name, match.files]),
			[
				["art", ["source-code/legacy-app-master/sql/ventas.sql"]],
				["cus", ["source-code/legacy-app-master/sql/ventas.sql"]],
			],
		);
	});

	test("without source files there is no code, and no code using the tables is no match", async () => {
		const empty = memoryFiles({ "README.md": "FROM art", "notes.txt": "FROM cus" });
		assert.deepEqual(await findSchemaUsage("/app", erp, { files: empty.files }), {
			hasCode: false,
			filesScanned: 0,
			filesMatched: 0,
			tablesMatched: 0,
			matches: [],
			truncated: false,
		});
		const unrelated = memoryFiles({ "src/app.ts": "export const x = 1;" });
		const usage = await findSchemaUsage("/app", erp, { files: unrelated.files });
		assert.equal(usage.hasCode, true);
		assert.deepEqual(usage.matches, []);
	});

	test("skips files bigger than the per-file limit without calling the scan truncated", async () => {
		const { files, reads } = memoryFiles({ "big.sql": `${"x".repeat(100)} FROM art`, "small.sql": "FROM cus" });
		const usage = await findSchemaUsage("/app", erp, { files, limits: { maxFileBytes: 50 } });
		assert.deepEqual(reads, ["small.sql"]);
		assert.equal(usage.truncated, false);
	});

	test("stops at the file, byte and time limits and returns what it found, marked truncated", async () => {
		const many = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`src/m${i}.php`, "SELECT * FROM art"]));
		const cases: [Partial<ScanLimits>, number][] = [
			[{ maxFiles: 3 }, 3],
			[{ maxBytes: 40 }, 2],
		];
		for (const [limits, scanned] of cases) {
			const { files } = memoryFiles(many);
			const usage = await findSchemaUsage("/app", erp, { files, limits });
			assert.equal(usage.filesScanned, scanned, JSON.stringify(limits));
			assert.equal(usage.truncated, true);
			assert.equal(usage.matches[0]?.hits, scanned);
		}
		let clock = 0;
		const { files } = memoryFiles(many);
		const usage = await findSchemaUsage("/app", erp, {
			files: { ...files, read: async (path) => ((clock += 400), files.read(path)) },
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
		const usage = await findSchemaUsage("/app", snapshot(tables), { files });
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
			"from.php": '$rows = $db->query("SELECT ref FROM art WHERE id = 1");',
			"join.sql": "select *\nfrom `erp`.`cus`\n  left join\n    [dbo].[dln] on 1 = 1",
			"into.py": "cursor.execute('INSERT INTO \"public\".\"art\" (ref) VALUES (%s)')",
			"update.go": 'db.Exec("UPDATE erp.cus SET name = ?")\ndb.Exec("UPDATE art a JOIN cus b ON a.x = b.x SET a.y = 1")',
			"table.sql": "CREATE TABLE IF NOT EXISTS dln (id int);\nALTER TABLE 'art' ADD x int;",
			"delete.ts": "await sql`DELETE FROM dln WHERE id = ${id}`;",
		});
		const usage = await findSchemaUsage("/app", erp, { files });
		assert.deepEqual(usage.matches, [
			{ table: "shop.art", name: "art", files: ["from.php", "into.py", "table.sql", "update.go"], hits: 4 },
			{ table: "shop.cus", name: "cus", files: ["update.go", "join.sql"], hits: 3 },
			{ table: "shop.dln", name: "dln", files: ["delete.ts", "join.sql", "table.sql"], hits: 3 },
		]);
	});

	// One documented example per ORM or mapping family; each must find exactly its table.
	const declarations: [string, string, string][] = [
		["Eloquent $table property", "Art.php", "class Art extends Model { protected $table = \"art\"; }"],
		["plain table assignment", "art.rb", "self.table = 'art'"],
		["Laravel query builder", "Repo.php", "DB::table('art')->get(); $q->from('art');"],
		["fluent .table() call", "repo.js", 'db.table("art").select()'],
		["knex", "repo.ts", "await knex('art').where({ id })"],
		["JPA @Table", "Art.java", '@Entity\n@Table(name = "art")\npublic class Art {}'],
		["JPA @Entity with a table name", "Art.kt", '@Entity(name = "art")\nclass Art'],
		["C# [Table]", "Art.cs", '[Table("art")]\npublic class Art {}'],
		["SQLAlchemy __tablename__", "models.py", 'class Art(Base):\n    __tablename__ = "art"'],
		["Django db_table", "models.py", "class Meta:\n    db_table = 'art'"],
		["tableName option", "art.ts", 'sequelize.define("Art", {}, { tableName: "art" });\nconst x = { tableName = "art" };'],
		["Doctrine XML entity", "Art.orm.xml", '<entity name="App\\Art" table="art">'],
		["YAML mapping", "Art.orm.yml", "App\\Art:\n  type: entity\n  table: art\n"],
	];
	for (const [family, path, code] of declarations) {
		test(`ORM declaration: ${family}`, async () => {
			const { files } = memoryFiles({ [path]: code });
			const usage = await findSchemaUsage("/app", erp, { files });
			assert.deepEqual(
				usage.matches.map((match) => match.name),
				["art"],
				code,
			);
		});
	}

	test("plain occurrences do not count: comments, prose, identifiers, help text", async () => {
		const { files } = memoryFiles({
			"src/a.ts": "// art holds the articles\nconst art = loadArt(cus);\nconsole.log(\"Usa --help para ver dln\");",
			"src/b.php": "/* see cus and dln */ $art->save(); echo 'art';",
			"src/c.yml": "name: art\ndescription: the cus table\n",
		});
		const usage = await findSchemaUsage("/app", erp, { files });
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
		const contents = Object.fromEntries(skipped.map((path) => [path, "SELECT * FROM art"]));
		const { files, reads } = memoryFiles({ ...contents, "src/app.js": "SELECT * FROM cus" });
		const usage = await findSchemaUsage("/app", erp, { files });
		assert.deepEqual(reads, ["src/app.js"]);
		assert.deepEqual(usage.matches.map((match) => match.name), ["cus"]);
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
		const usage = await findSchemaUsage("/app", words, { files });
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
			"app/Models/Articulo.php": "<?php\nclass Articulo extends Model\n{\n    protected $table = 'art';\n}\n",
			"app/Repositories/Ventas.php": '<?php\n$sql = "SELECT * FROM cus JOIN dln ON dln.cliente = cus.codigo";\n',
		});
		const usage = await findSchemaUsage("/app", erp, { files });
		assert.deepEqual(
			usage.matches.map((match) => [match.name, match.files]),
			[
				["art", ["app/Models/Articulo.php"]],
				["cus", ["app/Repositories/Ventas.php"]],
				["dln", ["app/Repositories/Ventas.php"]],
			],
		);
	});

	// Large legacy sources (Harbour .prg) took seconds per file because
	// the SQL rules looked back from every position of the file.
	test("scans large legacy source files quickly: the time grows with the text, not text × lookback", async () => {
		const filler = "  cVar := 'x' // from the old menu, select it\n".repeat(10_000); // ~470 KB, no statement ends
		const source = `${filler}  cSql := "SELECT cod FROM cus WHERE x = 1"\n${filler}`;
		const { files } = memoryFiles({ "src/clientes.prg": source, "src/articulos.prg": `${filler}USE art\nUPDATE art SET pvp = 1\n` });
		const started = performance.now();
		const usage = await findSchemaUsage("/app", erp, { files, limits: { maxFileBytes: 2 * 1024 * 1024 } });
		const elapsed = performance.now() - started;
		assert.deepEqual(usage.matches.map((match) => match.name).sort(), ["art", "cus"]);
		assert.equal(usage.truncated, false);
		assert.ok(elapsed < 1000, `took ${Math.round(elapsed)} ms`);
	});


	// Harbour lines as legacy code writes them: the database name is built by code, and the
	// table goes in variables named after "tabla". PHP and JS do the same.
	test("SQL whose database prefix is built by code, and variables named after a table", async () => {
		const { files } = memoryFiles({
			"src/browse.prg": [
				'oBrw:AddColumn( "(SELECT art.nom FROM "+cDb+".art WHERE lin.ref = art.ref) AS Product" , 200)',
				'qUpd:cDirect := "UPDATE "+cDb+".art SET "+CRLF',
				'cSql := "SELECT nom FROM "+cDb+".fam WHERE art.fa=fam.cod"',
				'qUpd:cTabla := "dln"',
			].join("\n"),
			"src/Repo.php": "$sql = \"SELECT * FROM \" . $db . \".cus WHERE cod = ?\";\n$tableName = 'mov';",
			"src/repo.ts": "const rows = await q(`SELECT * FROM ${db}.sup WHERE cod = ?`);",
			"src/menu.prg": 'cTitulo := "fam" // a title, not a table variable',
		});
		const tables = snapshot(["art", "cus", "dln", "fam", "mov", "sup"].map((name) => table(name)));
		const usage = await findSchemaUsage("/app", tables, { files });
		assert.deepEqual(
			usage.matches.map((match) => [match.name, match.files]),
			[
				["art", ["src/browse.prg"]],
				["cus", ["src/Repo.php"]],
				["dln", ["src/browse.prg"]],
				["fam", ["src/browse.prg"]],
				["mov", ["src/Repo.php"]],
				["sup", ["src/repo.ts"]],
			].sort((a, b) => (a[0]! < b[0]! ? -1 : 1)),
		);
	});

});
