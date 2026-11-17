import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Knowledge } from "../../lib/knowledge/types.ts";
import { type CodeFiles, QUESTION_PREFIX, type ScanLimits, findSchemaUsage, isCrypticName, isQuestionNote } from "../../lib/usecases/code-scan.ts";
import type { Table } from "../../lib/model/snapshot.ts";
import { customersTable, ordersTable, snapshot } from "../fixtures/snapshot.ts";

function table(name: string, overrides: Partial<Table> = {}): Table {
	return { ...customersTable(), name, ...overrides };
}

/** What every match of an uncommented, unreferenced table found only in code carries besides its files. */
const plain = { docs: [], described: "nothing", referenced: 0 } as const;

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
			docsScanned: 1,
			filesMatched: 3,
			tablesMatched: 2,
			matches: [
				{ table: "shop.art", name: "art", files: ["src/Models/Articulo.php", "src/Repo/Ventas.php"], anchor: "src/Models/Articulo.php", hits: 2, cryptic: true, ...plain },
				{ table: "shop.cus", name: "cus", files: ["src/Models/Cliente.php", "src/Repo/Ventas.php"], anchor: "src/Models/Cliente.php", hits: 2, cryptic: true, ...plain },
			],
			remaining: 0,
			truncated: false,
			estimate: {
				tables: 2,
				files: 3,
				bytes: ["src/Models/Articulo.php", "src/Models/Cliente.php", "src/Repo/Ventas.php"].reduce((sum, path) => sum + Buffer.byteLength(project[path as keyof typeof project]), 0),
				largestFile: Buffer.byteLength(project["src/Models/Articulo.php"]),
				anchored: 2,
			},
		});
		// README.md is read as documentation; "art cus dln" only names the tables, so it is no evidence.
		assert.deepEqual(reads.sort(), ["README.md", "src/Models/Articulo.php", "src/Models/Cliente.php", "src/Repo/Ventas.php", "src/article.php"]);
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
			docsScanned: 2,
			filesMatched: 0,
			tablesMatched: 0,
			matches: [],
			remaining: 0,
			truncated: false,
			estimate: { tables: 0, files: 0, bytes: 0, largestFile: 0, anchored: 0 },
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
		assert.deepEqual(usage.matches, [
			{ table: "shop.customers", name: "customers", files: ["src/app.sql"], hits: 1, cryptic: false, ...plain, referenced: 1 },
		]);
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
			cryptic: true,
			...plain,
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
			{ table: "shop.art", name: "art", files: ["from.php", "into.py", "table.sql", "update.go"], hits: 4, cryptic: true, ...plain },
			{ table: "shop.cus", name: "cus", files: ["update.go", "join.sql"], hits: 3, cryptic: true, ...plain },
			{ table: "shop.dln", name: "dln", files: ["delete.ts", "join.sql", "table.sql"], hits: 3, cryptic: true, ...plain },
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
			docsScanned: 1,
			filesMatched: 0,
			tablesMatched: 0,
			matches: [],
			remaining: 0,
			truncated: false,
			estimate: { tables: 0, files: 0, bytes: 0, largestFile: 0, anchored: 0 },
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

	// Projects often document their tables in markdown or text: "`cst` = maestro de clientes",
	// "| tda | Almacenes |". That is the best evidence of what a cryptic table is.
	test("documentation that defines a table is evidence; a passing mention in prose is not", async () => {
		const tables = snapshot(["cst", "tda", "dln", "art", "albaranes"].map((name) => table(name)));
		const { files } = memoryFiles({
			"docs/tablas.md": "# Tablas\n\n| Tabla | Descripción |\n|---|---|\n| tda | Almacenes |\n\n- `cst` = maestro de clientes\n",
			"docs/notas.txt": "dln: líneas de albarán de venta\n**albaranes** – cabeceras de albarán\n",
			"README.md": "Close dln and cst before the month ends. The art table is old; see albaranes: later.\nart\n",
			"CHANGELOG.md": "- fix(art): export\n| 2 | tda was renamed |\n",
			"src/app.php": "SELECT * FROM cst",
		});
		const usage = await findSchemaUsage("/app", tables, { files });
		assert.equal(usage.hasCode, true);
		assert.equal(usage.filesScanned, 1);
		assert.equal(usage.docsScanned, 4);
		assert.equal(usage.filesMatched, 3);
		assert.deepEqual(
			usage.matches.map((match) => [match.name, match.files, match.docs, match.hits]),
			[
				["cst", ["src/app.php"], ["docs/tablas.md"], 1],
				["dln", [], ["docs/notas.txt"], 0],
				["tda", [], ["docs/tablas.md"], 0],
				["albaranes", [], ["docs/notas.txt"], 0],
			],
		);
	});

	test("documentation is read within the same file, byte and size limits", async () => {
		const many = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`docs/t${i}.md`, "- `art`: articles"]));
		const { files, reads } = memoryFiles({ ...many, "docs/huge.md": `${"x".repeat(100)}\n- \`cus\`: customers` });
		const usage = await findSchemaUsage("/app", erp, { files, limits: { maxFiles: 3, maxFileBytes: 50 } });
		assert.deepEqual(reads, ["docs/t0.md", "docs/t1.md"]);
		assert.equal(usage.truncated, true);
		assert.deepEqual(usage.matches.map((match) => [match.name, match.docs]), [["art", ["docs/t0.md", "docs/t1.md"]]]);
	});

	// A legacy project whose code folders come before docs/ in folder order: walking in that
	// order, the code used up the time and byte limits and the module docs were never read.
	const legacyCode = (count: number, folder = "a-legacy") =>
		Object.fromEntries(
			Array.from({ length: count }, (_, i) => [`${folder}/m${String(i).padStart(2, "0")}.prg`, "SELECT * FROM art;".padEnd(100, " ")]),
		);
	const moduleDocs = (count: number) =>
		Object.fromEntries(
			Array.from({ length: count }, (_, i) => [`docs/mod${String(i).padStart(2, "0")}.md`, "- `cus`: customers".padEnd(100, " ")]),
		);

	test("reads documentation before code, so code that comes first in folder order cannot use up the byte or time limit", async () => {
		const contents = { ...legacyCode(20), ...moduleDocs(2) };
		const bytes = memoryFiles(contents);
		const byBytes = await findSchemaUsage("/app", erp, { files: bytes.files, limits: { maxBytes: 1000 } });
		assert.deepEqual(byBytes.matches.map((match) => [match.name, match.docs]), [
			["art", []],
			["cus", ["docs/mod00.md", "docs/mod01.md"]],
		]);
		// The docs took 200 bytes; the code gets the rest of the limit.
		assert.deepEqual([byBytes.docsScanned, byBytes.filesScanned, byBytes.truncated], [2, 8, true]);
		assert.deepEqual(bytes.reads.slice(0, 2), ["docs/mod00.md", "docs/mod01.md"]);

		let clock = 0;
		const timed = memoryFiles(contents);
		const byTime = await findSchemaUsage("/app", erp, {
			files: { ...timed.files, read: async (path) => ((clock += 100), timed.files.read(path)) },
			now: () => clock,
			limits: { maxMillis: 1000 },
		});
		assert.deepEqual(byTime.matches.find((match) => match.name === "cus")?.docs, ["docs/mod00.md", "docs/mod01.md"]);
		assert.deepEqual([byTime.docsScanned, byTime.filesScanned, byTime.truncated], [2, 9, true]);
	});

	test("documentation gets at most a quarter of each limit while code waits, so huge docs never starve the code", async () => {
		const contents = { ...legacyCode(5, "src"), ...moduleDocs(40) };
		const bytes = memoryFiles(contents);
		const byBytes = await findSchemaUsage("/app", erp, { files: bytes.files, limits: { maxBytes: 1000 } });
		assert.deepEqual([byBytes.docsScanned, byBytes.filesScanned, byBytes.truncated], [2, 5, true]);
		assert.deepEqual(byBytes.matches.map((match) => [match.name, match.files.length, match.docs.length]), [
			["art", 5, 0],
			["cus", 0, 2],
		]);

		let clock = 0;
		const timed = memoryFiles(contents);
		const byTime = await findSchemaUsage("/app", erp, {
			files: { ...timed.files, read: async (path) => ((clock += 100), timed.files.read(path)) },
			now: () => clock,
			limits: { maxMillis: 1000 },
		});
		// Docs are read at 0, 100 and 200 ms; at 300 ms their quarter is spent.
		assert.deepEqual([byTime.docsScanned, byTime.filesScanned, byTime.truncated], [3, 5, true]);

		const counted = memoryFiles({ ...legacyCode(10, "src"), ...moduleDocs(10) });
		const byFiles = await findSchemaUsage("/app", erp, { files: counted.files, limits: { maxFiles: 8 } });
		assert.deepEqual([byFiles.docsScanned, byFiles.filesScanned, byFiles.truncated], [2, 6, true]);
	});

	test("documentation and code together stay within the file, byte and time limits", async () => {
		const contents: Record<string, string> = { ...legacyCode(30), ...moduleDocs(30) };
		const sizes = (reads: string[]) => reads.reduce((sum, path) => sum + Buffer.byteLength(contents[path] ?? ""), 0);
		const bytes = memoryFiles(contents);
		await findSchemaUsage("/app", erp, { files: bytes.files, limits: { maxBytes: 1050 } });
		assert.equal(sizes(bytes.reads), 1000);
		const counted = memoryFiles(contents);
		await findSchemaUsage("/app", erp, { files: counted.files, limits: { maxFiles: 9 } });
		assert.equal(counted.reads.length, 9);
		let clock = 0;
		const timed = memoryFiles(contents);
		await findSchemaUsage("/app", erp, {
			files: { ...timed.files, read: async (path) => ((clock += 100), timed.files.read(path)) },
			now: () => clock,
			limits: { maxMillis: 1000 },
		});
		assert.ok(clock <= 1100, `read until ${clock} ms`);
	});

	// The agent notes the listed tables in order: spend that round where a note changes what search finds.
	test("orders by need: an uncommented cryptic much-referenced table first, a commented one later, a noted one last", async () => {
		const pointsTo = (target: string, i: number) => ({ ...ordersTable().foreignKeys[0]!, name: `fk_${i}`, columns: ["x"], references: { database: "shop", schema: "shop", table: target, columns: ["id"] } });
		const tables = snapshot([
			table("cst"),
			table("warehouse"),
			table("customers_master", { comment: "Customers: one row per customer" }),
			table("orders_history"),
			table("sales_lines", { foreignKeys: [pointsTo("cst", 1)] }),
			table("payments_log", { foreignKeys: [pointsTo("cst", 2), pointsTo("orders_history", 3)] }),
		]);
		const knowledge: Knowledge = {
			formatVersion: 1,
			annotations: [
				{ id: "1", target: "shop.shop.orders_history", text: "Closed orders (pedidos)", author: "Ana", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" },
			],
			relationships: [],
		};
		const { files } = memoryFiles({
			"src/a.sql": "SELECT * FROM cst;\nSELECT * FROM warehouse;\n".repeat(2),
			"src/b.sql": "SELECT * FROM customers_master;\n".repeat(10),
			"src/c.sql": "SELECT * FROM orders_history;\n".repeat(20),
		});
		const usage = await findSchemaUsage("/app", tables, { files, knowledge });
		assert.deepEqual(
			usage.matches.map((match) => [match.name, match.hits, match.described, match.cryptic, match.referenced]),
			[
				["cst", 2, "nothing", true, 2],
				["warehouse", 2, "nothing", false, 0],
				["customers_master", 10, "comment", false, 0],
				["orders_history", 20, "note", false, 1],
			],
		);
		// Among tables that need a note alike, more code using it comes first.
		const more = memoryFiles({ "src/a.sql": "SELECT * FROM warehouse;\n".repeat(4), "src/b.sql": "SELECT * FROM orders_history;" });
		const plainOrder = await findSchemaUsage("/app", tables, { files: more.files });
		assert.deepEqual(plainOrder.matches.map((match) => match.name), ["warehouse", "orders_history"]);
	});

	// Rounds: the agent notes the listed tables; the next scan lists the next ones.
	test("counts the undescribed tables left out of the list, and a second round lists new tables", async () => {
		const names = Array.from({ length: 35 }, (_, i) => `tabla_${String(i).padStart(2, "0")}`);
		const tables = snapshot([
			...names.map((name) => table(name)),
			table("almacenes", { comment: "Almacenes: uno por almacén" }),
			table("articulos", { comment: "Artículos" }),
			table("pedidos"),
		]);
		const note = (name: string, id: string) => ({ id, target: `shop.shop.${name}`, text: `Notes on ${name}`, author: "Ana", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" });
		const { files } = memoryFiles({
			"src/a.sql": [...names, "almacenes", "articulos", "pedidos"].map((name) => `SELECT * FROM ${name};`).join("\n"),
		});
		const first = await findSchemaUsage("/app", tables, {
			files,
			knowledge: { formatVersion: 1, annotations: [note("pedidos", "0")], relationships: [] },
		});
		assert.equal(first.tablesMatched, 38);
		assert.equal(first.matches.length, 30);
		// 35 undescribed matched tables, 30 listed: 5 left; commented and noted ones never count.
		assert.equal(first.remaining, 5);

		const noted = first.matches.map((match, i) => note(match.name, String(i + 1)));
		const second = await findSchemaUsage("/app", tables, {
			files,
			knowledge: { formatVersion: 1, annotations: [note("pedidos", "0"), ...noted], relationships: [] },
		});
		const firstNames = new Set(first.matches.map((match) => match.name));
		const fresh = second.matches.slice(0, 5);
		assert.deepEqual(
			fresh.map((match) => match.described),
			Array(5).fill("nothing"),
		);
		assert.ok(fresh.every((match) => !firstNames.has(match.name)), JSON.stringify(fresh));
		assert.deepEqual(second.matches.slice(5, 7).map((match) => match.described), ["comment", "comment"]);
		assert.ok(second.matches.slice(7).every((match) => match.described === "note"));
		assert.equal(second.remaining, 0);
	});

	test("a comment that only repeats the name is no description", async () => {
		const { files } = memoryFiles({ "src/a.sql": "SELECT * FROM cst JOIN tda" });
		const usage = await findSchemaUsage("/app", snapshot([table("cst", { comment: "cst" }), table("tda", { comment: "Almacenes" })]), { files });
		assert.deepEqual(usage.matches.map((match) => [match.name, match.described]), [["cst", "nothing"], ["tda", "comment"]]);
	});

	// L5: the Drizzle schema explained most tables but was never listed; half of what the agent read were migrations.
	describe("anchoring and file order", () => {
		const shop = snapshot([table("orders"), table("invoices"), table("customers")]);
		/** The repository names orders three times, more than the mapping file does. */
		const repo = { "src/repo.ts": "SELECT * FROM orders;\nUPDATE orders SET paid = 1;\nDELETE FROM orders WHERE id = 1;\n" };

		const mappings: [string, string, string][] = [
			["Drizzle pgTable", "src/db/schema.ts", 'export const orders = pgTable("orders", { id: serial("id") });'],
			["Drizzle mysqlTable", "src/db/schema.ts", "export const orders = mysqlTable('orders', {});"],
			["Drizzle sqliteTable", "src/db/schema.ts", 'export const orders = sqliteTable("orders", {});'],
			["TypeORM @Entity with a name", "src/entities/Order.ts", '@Entity("orders")\nexport class Order {}'],
			["TypeORM @Entity with options", "src/entities/Order.ts", '@Entity({ name: "orders", schema: "shop" })\nexport class Order {}'],
			["Prisma @@map", "prisma/schema.prisma", 'model Order {\n  id Int @id\n  @@map("orders")\n}\n'],
			["Prisma model named like the table", "prisma/schema.prisma", "model orders {\n  id Int @id\n}\n"],
			["SQLAlchemy __tablename__", "src/models.py", 'class Order(Base):\n    __tablename__ = "orders"'],
			["Eloquent $table property", "src/Order.php", "class Order extends Model { protected $table = 'orders'; }"],
			["JPA @Table", "src/Order.java", '@Entity\n@Table(name = "orders")\npublic class Order {}'],
		];
		for (const [form, path, code] of mappings) {
			test(`ORM mapping: ${form} is the anchor, listed first though it names the table once`, async () => {
				const { files } = memoryFiles({ ...repo, [path]: code });
				const usage = await findSchemaUsage("/app", shop, { files });
				assert.deepEqual(
					usage.matches.map((match) => [match.name, match.files, match.anchor]),
					[["orders", [path, "src/repo.ts"], path]],
					code,
				);
			});
		}

		test("Prisma: a model with @@map maps only to that table, never to its model name", async () => {
			const { files } = memoryFiles({ "prisma/schema.prisma": 'model customers {\n  id Int @id\n  @@map("orders")\n}\n' });
			const usage = await findSchemaUsage("/app", shop, { files });
			assert.deepEqual(usage.matches.map((match) => match.name), ["orders"]);
		});

		test("query code and table variables are uses, not anchors", async () => {
			const { files } = memoryFiles({
				"src/a.php": "DB::table('orders')->get(); $tableName = 'orders';",
				"src/b.prg": 'qUpd:cTabla := "orders"',
			});
			const usage = await findSchemaUsage("/app", shop, { files });
			assert.deepEqual(usage.matches.map((match) => [match.name, match.anchor]), [["orders", undefined]]);
			assert.ok(!("anchor" in (usage.matches[0] ?? {})));
		});

		const lastKinds: [string, string][] = [
			["migration folder", "db/migrations/0001_orders.ts"],
			["Rails db/migrate", "db/migrate/20240101_create_orders.rb"],
			["numbered SQL migration", "drizzle/0000_init.sql"],
			["Flyway migration", "sql/V1__init.sql"],
			["SQL schema dump", "sql/schema.sql"],
			["*.test.* file", "src/orders.test.ts"],
			["*.spec.* file", "src/orders.spec.js"],
			["tests folder", "tests/orders.py"],
			["__tests__ folder", "src/__tests__/orders.ts"],
			["seed file", "db/seed.ts"],
			["seeder", "database/OrdersSeeder.php"],
			["fixtures folder", "src/fixtures/orders.ts"],
			["old copy", "src/orders_old.php"],
			["backup", "src/ordersBak.php"],
			["copy", "src/orders copy.php"],
			["does not compile", "src/no se compila/orders.prg"],
			["nocompila", "src/orders_nocompila.prg"],
			["digit-suffixed variant", "src/billing_00123.php"],
		];
		for (const [kind, path] of lastKinds) {
			test(`files go last for their table: ${kind}`, async () => {
				const { files } = memoryFiles({
					"src/billing.php": "SELECT * FROM invoices;",
					[path]: "SELECT * FROM orders;\n".repeat(4),
					"src/OrderService.ts": "SELECT * FROM orders;",
				});
				const usage = await findSchemaUsage("/app", shop, { files });
				assert.deepEqual(usage.matches.find((match) => match.name === "orders")?.files, ["src/OrderService.ts", path], path);
			});
		}

		test("application code that only shares a word with a migration or a test is not demoted", async () => {
			const { files } = memoryFiles({
				"src/a.ts": "SELECT * FROM orders;",
				"src/latest.ts": "SELECT * FROM orders;\n".repeat(2),
				"src/bold.ts": "SELECT * FROM orders;\n".repeat(3),
				"src/order.ts": "SELECT * FROM invoices;",
				"src/order_service.ts": "import { db } from './db';\nexport function list() {\n  return db.query('SELECT * FROM orders');\n}\n" + "SELECT * FROM orders;\n".repeat(3),
			});
			const usage = await findSchemaUsage("/app", shop, { files });
			assert.deepEqual(usage.matches.find((match) => match.name === "orders")?.files, ["src/order_service.ts", "src/bold.ts", "src/latest.ts", "src/a.ts"]);
		});

		// L12: on a legacy project the scan listed customer variants of a program instead of the program.
		test("a program with many customer variants: the base file comes first, near-copies with a tag or digits go last", async () => {
			const body = (extra: string) =>
				["FUNCTION Invoice()", "  LOCAL cSql", "  cSql := 'SELECT * FROM invoices'", "  oQry := Run(cSql)", "  Total(oQry)", "RETURN NIL", extra].join("\n");
			const { files } = memoryFiles({
				"prg/invoice.prg": body(""),
				"prg/invoice_00123.prg": body("cSql := 'SELECT * FROM invoices WHERE x'\ncSql := 'SELECT * FROM invoices WHERE y'"),
				"prg/invoice_00456.prg": body("cSql := 'SELECT * FROM invoices WHERE x'\ncSql := 'SELECT * FROM invoices WHERE y'"),
				"prg/invoice-acme.prg": body("cSql := 'SELECT * FROM invoices WHERE a'\ncSql := 'SELECT * FROM invoices WHERE b'"),
				"prg/invoice-north.prg": body("cSql := 'SELECT * FROM invoices WHERE a'\ncSql := 'SELECT * FROM invoices WHERE b'"),
				"prg/invoice2.prg": body("cSql := 'SELECT * FROM invoices WHERE z'\ncSql := 'SELECT * FROM invoices WHERE w'"),
			});
			const usage = await findSchemaUsage("/app", shop, { files });
			const invoices = usage.matches.find((match) => match.name === "invoices");
			assert.equal(invoices?.files[0], "prg/invoice.prg");
			assert.equal(invoices?.hits, 16);
		});

		test("the mapping file and the application code come before migrations, tests and seeds", async () => {
			const { files } = memoryFiles({
				"db/migrations/0001.sql": "CREATE TABLE orders (id int);\nALTER TABLE orders ADD x int;\n".repeat(3),
				"tests/orders.test.ts": "SELECT * FROM orders;\n".repeat(5),
				"db/seeds/orders.ts": "INSERT INTO orders VALUES (1);\n".repeat(5),
				"src/db/schema.ts": 'export const orders = pgTable("orders", {});',
				"src/checkout.ts": "UPDATE orders SET paid = 1;",
			});
			const usage = await findSchemaUsage("/app", shop, { files });
			const [orders] = usage.matches;
			assert.deepEqual(orders?.files.slice(0, 2), ["src/db/schema.ts", "src/checkout.ts"]);
			assert.deepEqual(new Set(orders?.files.slice(2)), new Set(["db/migrations/0001.sql", "tests/orders.test.ts", "db/seeds/orders.ts"]));
		});
	});

	// A table the agent could not explain was left as a question: the next round must not list it first again.
	test("a table left as a question goes after the tables nothing describes and the commented ones, and is not counted as remaining", async () => {
		const at = "2026-11-01T00:00:00.000Z";
		const note = (name: string, text: string, id: string) => ({ id, target: `shop.shop.${name}`, text, author: "agent (via agent)", createdAt: at, updatedAt: at });
		const pointsTo = (target: string, i: number) => ({ ...ordersTable().foreignKeys[0]!, name: `fk_${i}`, references: { database: "shop", schema: "shop", table: target, columns: ["id"] } });
		const tables = snapshot([
			table("cst"),
			table("warehouse"),
			table("payments", { comment: "Payments received" }),
			table("orders"),
			table("answered"),
			table("lines", { foreignKeys: [pointsTo("cst", 1), pointsTo("answered", 2)] }),
		]);
		const knowledge: Knowledge = {
			formatVersion: 1,
			annotations: [
				note("cst", `${QUESTION_PREFIX}what does cst hold? The code only reads it in src/a.sql.`, "1"),
				note("orders", "Customer orders (pedidos)", "2"),
				note("answered", `${QUESTION_PREFIX}what is answered?`, "3"),
				note("answered", "Answers to surveys (respuestas)", "4"),
			],
			relationships: [],
		};
		const once = ["cst", "warehouse", "payments", "orders", "answered", "lines"].map((name) => `SELECT * FROM ${name};\n`).join("");
		const { files } = memoryFiles({ "src/a.sql": once + "SELECT * FROM cst;\n".repeat(9) });
		const usage = await findSchemaUsage("/app", tables, { files, knowledge });
		assert.deepEqual(
			usage.matches.map((match) => [match.name, match.described]),
			[
				["lines", "nothing"],
				["warehouse", "nothing"],
				["payments", "comment"],
				["cst", "question"],
				["answered", "note"],
				["orders", "note"],
			],
		);
		assert.ok(isQuestionNote(`  ${QUESTION_PREFIX}¿qué guarda cst?`));
		assert.ok(!isQuestionNote("Customer master (clientes). Question: who writes it?"));

		// With more undescribed tables than fit, the questioned one is never counted as waiting for a note.
		const many = Array.from({ length: 31 }, (_, i) => table(`tabla_${String(i).padStart(2, "0")}`));
		const big = memoryFiles({ "src/a.sql": [...many.map((item) => item.name), "cst"].map((name) => `SELECT * FROM ${name};`).join("\n") });
		const round = await findSchemaUsage("/app", snapshot([...many, table("cst")]), { files: big.files, knowledge });
		assert.equal(round.tablesMatched, 32);
		assert.equal(round.remaining, 1);
		assert.ok(!round.matches.some((match) => match.name === "cst"));
	});

	// What a caller shows before the agent starts: how much it would be pointed to read.
	test("estimates the listed tables and the files and bytes the agent is pointed to", async () => {
		const contents = {
			"src/db/schema.ts": 'export const orders = pgTable("orders", {});\nexport const invoices = pgTable("invoices", {});\n',
			"src/checkout.ts": "UPDATE orders SET paid = 1;\nINSERT INTO invoices (id) VALUES (1);\n",
			"src/report.sql": "SELECT * FROM customers;",
			"src/unused.ts": "export const x = 1;",
			"docs/tables.md": "- `customers`: people who buy\n",
		};
		const { files } = memoryFiles(contents);
		const usage = await findSchemaUsage("/app", snapshot([table("orders"), table("invoices"), table("customers")]), { files });
		const size = (path: keyof typeof contents) => Buffer.byteLength(contents[path]);
		assert.deepEqual(usage.estimate, {
			tables: 3,
			files: 4,
			bytes: size("src/db/schema.ts") + size("src/checkout.ts") + size("src/report.sql") + size("docs/tables.md"),
			largestFile: size("src/db/schema.ts"),
			anchored: 2,
		});
		const none = await findSchemaUsage("/app", erp, { files: memoryFiles({ "src/app.ts": "export const x = 1;" }).files });
		assert.deepEqual(none.estimate, { tables: 0, files: 0, bytes: 0, largestFile: 0, anchored: 0 });
	});

	test("a cryptic name: 4 letters or fewer, a part without vowels, or mostly parts of 3 letters or fewer", () => {
		for (const name of ["cst", "art", "tda", "fac_cab", "mvtos_stk", "tblcntr", "t00x", "CliPrv", "a_b_clientes"]) assert.ok(isCrypticName(name), name);
		for (const name of ["customers", "warehouse", "asistencia_rec", "order_items", "CustomerOrders", "almacenes", "clientes_2024", "работники"]) {
			assert.ok(!isCrypticName(name), name);
		}
	});

});
