import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, describe, test } from "node:test";

import { compete, renderComparison } from "../../bench/compare.ts";
import type { Question } from "../../bench/measure.ts";
import { columnsDump, guidedBaseline } from "../../bench/measure.ts";
import { codeGrep, grepTree } from "../../bench/strategies/code-grep.ts";
import { dbMcp } from "../../bench/strategies/db-mcp.ts";
import { dbSmart, likeSearch } from "../../bench/strategies/db-smart.ts";
import { infoSchemaColumns, infoSchemaGuided } from "../../bench/strategies/info-schema.ts";
import { ormSchema, prismaSchema } from "../../bench/strategies/orm-schema.ts";
import { schemaDocFull, schemaDocGrep, schemaMarkdown, grepText } from "../../bench/strategies/schema-doc.ts";
import { type BenchContext, benchContext, namePick, tablesNamed } from "../../bench/strategies/shared.ts";
import { writeSyntheticCode } from "../../bench/synthetic-code.ts";
import { saveConfig } from "../../lib/config/store.ts";
import type { Snapshot } from "../../lib/model/snapshot.ts";
import { saveSnapshot } from "../../lib/store/snapshots.ts";
import { initProject } from "../../lib/usecases/init.ts";
import { column, customersTable, ordersTable, snapshot } from "../fixtures/snapshot.ts";

// Small, hand-made schema: every strategy's policy can be followed by hand.
function shop(): Snapshot {
	const customers = {
		...customersTable(),
		comment: "Clientes",
		columns: [column("id", 1, { autoIncrement: true }), column("email", 2, { type: "varchar(255)", comment: "Correo" })],
	};
	return snapshot([customers, ordersTable()]);
}

const FOUND_BY_COMMENT: Question = { id: "customers", ask: "Dónde están los clientes", queries: ["clientes"], expect: ["customers"] };
const NOWHERE: Question = { id: "shipments", ask: "Envíos de un pedido", queries: ["envios", "remesas"], expect: ["orders"] };

function project(data: Snapshot): string {
	const root = mkdtempSync(join(tmpdir(), "heydb-bench-strategies-"));
	initProject(root);
	const erp = { engine: "mysql" as const, host: "127.0.0.1", port: 3306, user: "bench", password: "env:HEYDB_BENCH_PASSWORD", databases: null };
	saveConfig(root, { formatVersion: 1, defaultConnection: "erp", connections: { erp } });
	saveSnapshot(root, "erp", data);
	return root;
}

function context(data: Snapshot, workdir: string, codeDir?: string): BenchContext {
	return benchContext(data, workdir, codeDir);
}

/** Every file under a folder with a hash of its content, to prove nothing was written. */
function fingerprint(root: string): Map<string, string> {
	const files = new Map<string, string>();
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else files.set(relative(root, path), `${statSync(path).mtimeMs}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
		}
	};
	walk(root);
	return files;
}

describe("the competitive benchmark: generated material", () => {
	test("SCHEMA.md has, per table, a heading, its comment and a column table", () => {
		assert.equal(
			schemaMarkdown(snapshot([{ ...customersTable(), comment: "Clientes", columns: [column("id", 1), column("email", 2, { type: "varchar(255)", nullable: true, comment: "Correo | principal" })] }])),
			[
				"# Database schema",
				"",
				"## shop.customers",
				"",
				"Clientes",
				"",
				"| column | type | null | key | comment |",
				"|---|---|---|---|---|",
				"| id | int | NO | PRI |  |",
				"| email | varchar(255) | YES |  | Correo \\| principal |",
				"",
			].join("\n"),
		);
	});

	test("schema.prisma has, per table, a model mapped to it, with typed fields and /// comments", () => {
		assert.equal(
			prismaSchema(shop()),
			[
				"generator client {",
				'  provider = "prisma-client-js"',
				"}",
				"",
				"datasource db {",
				'  provider = "mysql"',
				'  url      = env("DATABASE_URL")',
				"}",
				"",
				"/// Clientes",
				"model Customers {",
				"  id    Int    @id @default(autoincrement())",
				"  /// Correo",
				"  email String @db.VarChar(255)",
				"",
				'  @@map("customers")',
				"}",
				"",
				"model Orders {",
				"  id          Int     @id @default(autoincrement())",
				"  customer_id Int",
				"  total       Decimal @db.Decimal(10, 2)",
				"",
				'  @@map("orders")',
				"}",
				"",
			].join("\n"),
		);
	});

	test("direct SQL prints what mysql --batch prints, matching names and comments like a _ci collation", () => {
		const { tables } = context(shop(), tmpdir());
		assert.deepEqual(likeSearch(tables, ["clientes"]), {
			text: "TABLE_SCHEMA\tTABLE_NAME\tTABLE_COMMENT\nshop\tcustomers\tClientes",
			named: ["customers"],
		});
		assert.deepEqual(likeSearch(tables, ["CORREO", "total"]), {
			text: "TABLE_SCHEMA\tTABLE_NAME\tCOLUMN_NAME\tCOLUMN_COMMENT\nshop\tcustomers\temail\tCorreo\nshop\torders\ttotal\t",
			named: ["customers", "orders"],
		});
		assert.deepEqual(likeSearch(tables, ["almacén"]), { text: "", named: [] });
	});

	test("grep over one file prints like rg -i -n -C2, with -- between groups, at most 100 lines", () => {
		const text = ["uno", "dos", "Factura", "cuatro", "cinco", "seis", "siete", "ocho", "facturas", "diez"].join("\n");
		assert.equal(grepText(text, ["factura"]), ["1-uno", "2-dos", "3:Factura", "4-cuatro", "5-cinco", "--", "7-siete", "8-ocho", "9:facturas", "10-diez"].join("\n"));
		assert.equal(grepText(text, ["nada"]), "");
		const long = Array.from({ length: 500 }, (_, index) => `factura ${index}`).join("\n");
		assert.equal(grepText(long, ["factura"]).split("\n").length, 100);
	});
});

describe("the competitive benchmark: code grep", () => {
	const root = mkdtempSync(join(tmpdir(), "heydb-bench-grep-"));
	after(() => rmSync(root, { recursive: true, force: true }));
	const write = (path: string, content: string | Buffer) => {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), content);
	};
	write("app/Facturas.php", "<?php\n// Facturas pendientes de cobro\n$sql = 'SELECT * FROM fac_ven';\n");
	write("docs/notas.md", "Las REMESAS van al banco.\n" + "x".repeat(400) + " remesas\n");
	write("node_modules/lib/index.js", "facturas remesas\n");
	write(".git/HEAD", "facturas\n");
	write(".heydb/knowledge/erp.json", '{"note":"facturas"}\n');
	write("assets/logo.png", Buffer.concat([Buffer.from("facturas"), Buffer.from([0, 1, 2]), Buffer.from("remesas")]));
	write("dump/huge.sql", `facturas\n${"y".repeat(2 * 1024 * 1024)}\n`);
	write("many/lines.txt", Array.from({ length: 150 }, (_, index) => `factura ${index}`).join("\n"));

	test("prints path:line:text for any query word, case-insensitive, lines cut at 200 characters", async () => {
		const result = await grepTree(root, ["facturas", "remesas"]);
		assert.deepEqual(result.lines.slice(0, 2), ["app/Facturas.php:2:// Facturas pendientes de cobro", "docs/notas.md:1:Las REMESAS van al banco."]);
		assert.equal(result.lines[2]?.length, "docs/notas.md:2:".length + 200);
	});

	test("skips binary files, files over 2 MB, node_modules, .git and .heydb", async () => {
		const result = await grepTree(root, ["facturas", "remesas"]);
		const files = new Set(result.lines.map((line) => line.split(":")[0]));
		assert.deepEqual([...files], ["app/Facturas.php", "docs/notas.md"]);
	});

	test("the synthetic code tree names tables with business words, and hides some where a grep must not look", async (t) => {
		const code = mkdtempSync(join(tmpdir(), "heydb-bench-code-"));
		t.after(() => rmSync(code, { recursive: true, force: true }));
		writeSyntheticCode(code);
		const result = await grepTree(code, ["facturas", "clientes"]);
		const files = [...new Set(result.lines.map((line) => line.split(":")[0]))];
		assert.deepEqual(files, ["app/Clientes.php", "app/Pedidos.php", "docs/README.md", "sql/informes_facturacion.sql"]);
		assert.ok(result.lines.includes("sql/informes_facturacion.sql:1:-- Informe de facturas pendientes de cobro por cliente"));
	});

	test("stops at the first 100 matching lines", async () => {
		const result = await grepTree(root, ["factura"]);
		assert.equal(result.lines.length, 100);
		assert.equal(result.capped, true);
		assert.equal(result.lines.at(-1), "many/lines.txt:99:factura 98");
	});
});

describe("the competitive benchmark: policies", () => {
	const workdir = mkdtempSync(join(tmpdir(), "heydb-bench-policies-"));
	after(() => rmSync(workdir, { recursive: true, force: true }));
	const code = join(workdir, "code");
	mkdirSync(join(code, "app"), { recursive: true });
	writeFileSync(join(code, "app", "Clientes.php"), "<?php\n// Alta de clientes en la tabla customers\n$db->query('SELECT * FROM customers');\n");
	const ctx = context(shop(), workdir, code);

	test("a table counts as picked from its name only if a part of it is a query word or abbreviates one", () => {
		assert.equal(namePick("fac_cab", "", ["facturas pendientes"]), true);
		assert.equal(namePick("cta_asi", "", ["asiento contable"]), true);
		assert.equal(namePick("alb_lin", "", ["lineas albaran"]), true);
		assert.equal(namePick("cli", "", ["customer invoice"]), false);
		assert.equal(namePick("fa", "", ["facturas"]), false, "two letters are not an abbreviation");
		assert.equal(namePick("customers", "Clientes", ["clientes"]), true, "a listed comment counts");
	});

	test("a table is named by the output only as a whole name, in the order the output names it", () => {
		const lookup = new Map([["fac_cab", "fac_cab"], ["fac_ven", "fac_ven"], ["customers", "customers"]]);
		assert.deepEqual(tablesNamed("fac_ven, emp_001.fac_cab and fac_cab_2019 FAC_VEN", lookup), ["fac_ven", "fac_cab"]);
		assert.deepEqual(tablesNamed("model Customers {", lookup), ["customers"]);
	});

	test("schema-doc-full reads the whole file once per question: everything seen, rank has no meaning", async () => {
		const answer = await schemaDocFull(ctx).run(NOWHERE);
		assert.deepEqual(
			answer.steps.map((step) => [step.tool, step.chars]),
			[["read", schemaMarkdown(shop()).length]],
		);
		assert.equal(answer.seen, 1);
		assert.equal(answer.firstRanks, null);
	});

	test("schema-doc-grep greps until the table is named, then reads its section", async () => {
		const answer = await schemaDocGrep(ctx).run(FOUND_BY_COMMENT);
		assert.deepEqual(answer.steps.map((step) => step.tool), ["grep", "read section"]);
		assert.equal(answer.seen, 1);
		assert.deepEqual(answer.firstRanks, [1]);
		const section = answer.steps[1]!;
		assert.equal(section.chars, schemaMarkdown(shop()).split("\n").slice(2, 10).join("\n").length);
	});

	test("schema-doc-grep and orm-schema list every heading or model when no grep names the table, then read it", async () => {
		const doc = await schemaDocGrep(ctx).run(NOWHERE);
		assert.deepEqual(
			doc.steps.map((step) => [step.tool, step.chars]),
			[["grep", 0], ["grep", 0], ["grep headings", "3:## shop.customers\n12:## shop.orders".length], ["read section", doc.steps[3]!.chars]],
		);
		assert.equal(doc.seen, 0);
		assert.deepEqual(doc.firstRanks, [null]);
		const orm = await ormSchema(ctx).run(NOWHERE);
		assert.deepEqual(
			orm.steps.map((step) => [step.tool, step.chars]),
			[["grep", 0], ["grep", 0], ["grep models", "11:model Customers {\n19:model Orders {".length], ["read model", orm.steps[3]!.chars]],
		);
		assert.equal(orm.seen, 0);
	});

	test("orm-schema finds a model through its /// comment and reads the model block", async () => {
		const answer = await ormSchema(ctx).run(FOUND_BY_COMMENT);
		assert.deepEqual(answer.steps.map((step) => step.tool), ["grep", "read model"]);
		assert.deepEqual(answer.firstRanks, [1]);
		assert.equal(answer.steps[1]!.chars, ["/// Clientes", "model Customers {", "  id    Int    @id @default(autoincrement())", "  /// Correo", "  email String @db.VarChar(255)", "", '  @@map("customers")', "}"].join("\n").length);
	});

	test("code-grep searches the code, then reads the columns through information_schema", async () => {
		const strategy = codeGrep(ctx);
		assert.ok(strategy !== undefined);
		const answer = await strategy.run(FOUND_BY_COMMENT);
		assert.deepEqual(answer.steps.map((step) => step.tool), ["grep", "sql columns"]);
		assert.equal(answer.steps[0]!.chars, "app/Clientes.php:2:// Alta de clientes en la tabla customers".length);
		assert.equal(answer.seen, 1);
		assert.deepEqual(answer.firstRanks, [1]);
		const missed = await strategy.run(NOWHERE);
		assert.deepEqual(missed.steps.map((step) => step.tool), ["grep", "grep", "sql databases", "sql tables", "sql columns"]);
		assert.equal(codeGrep(context(shop(), workdir)), undefined, "no --code, no strategy");
	});

	test("db-smart searches names and comments with LIKE, then reads the chosen table's columns", async () => {
		const answer = await dbSmart(ctx).run(FOUND_BY_COMMENT);
		assert.deepEqual(answer.steps.map((step) => step.tool), ["sql like", "sql columns"]);
		assert.deepEqual(answer.firstRanks, [1]);
		assert.equal(answer.steps[1]!.chars, columnsDump([ctx.tables[0]!], false).length);
		const missed = await dbSmart(ctx).run(NOWHERE);
		assert.deepEqual(missed.steps.map((step) => step.tool), ["sql like", "sql like", "sql tables", "sql columns"]);
	});

	test("db-mcp lists the tables, picks from names only, and describes the expected tables", async () => {
		const answer = await dbMcp(ctx).run(FOUND_BY_COMMENT);
		assert.deepEqual(answer.steps.map((step) => [step.tool, step.args]), [["list_tables", "shop"], ["describe_table", "customers"]]);
		assert.equal(answer.steps[0]!.chars, "customers\norders".length);
		assert.equal(answer.seen, 0, "the comment is not listed: customers is no word of 'clientes'");
		assert.deepEqual(answer.firstRanks, [null]);
		const named = await dbMcp(ctx).run({ ...NOWHERE, queries: ["pedidos orders"] });
		assert.equal(named.seen, 1);
		assert.deepEqual(named.firstRanks, [1]);
	});

	test("the information_schema baselines keep their cost and now count calls and picks", async () => {
		const guided = await infoSchemaGuided(ctx).run(FOUND_BY_COMMENT);
		assert.equal(guided.steps.length, 3);
		assert.equal(guided.steps.reduce((sum, step) => sum + step.chars, 0), guidedBaseline(shop(), ["customers"]));
		assert.equal(guided.seen, 1, "the listing shows the comment");
		const columns = await infoSchemaColumns(ctx).run(NOWHERE);
		assert.deepEqual(columns.steps.map((step) => step.chars), [columnsDump(ctx.tables, true).length]);
		assert.equal(columns.firstRanks, null);
	});
});

describe("the competitive benchmark: comparison", () => {
	const root = project(shop());
	const code = join(root, "src");
	writeSyntheticCode(code);
	after(() => rmSync(root, { recursive: true, force: true }));
	const questions = [FOUND_BY_COMMENT, NOWHERE];

	test("runs every strategy on the same questions and writes nothing to the measured project", async () => {
		const before = fingerprint(root);
		const comparison = await compete(root, questions, { codeDir: code });
		assert.deepEqual(fingerprint(root), before);
		assert.deepEqual(
			comparison.rows.map((row) => row.id),
			["heydb", "schema-doc-full", "schema-doc-grep", "code-grep", "db-smart", "orm-schema", "db-mcp", "info-schema-guided", "info-schema-columns"],
		);
		for (const row of comparison.rows) {
			assert.equal(row.answers.length, 2, row.id);
			assert.equal(row.calls, row.answers.reduce((sum, answer) => sum + answer.steps.length, 0), row.id);
			assert.equal(row.chars, row.answers.reduce((sum, answer) => sum + answer.steps.reduce((total, step) => total + step.chars, 0), 0), row.id);
			assert.equal(row.expected, 2, row.id);
			assert.ok(row.ms >= 0, row.id);
		}
		const text = renderComparison(comparison);
		assert.match(text, /^# Competitive benchmark — erp\n/);
		assert.match(text, /\| strategy \| ≈tokens \| calls \| found \| first call: top 1 \/ top 5 \| time \|/);
		assert.match(text, /\| schema-doc-full: SCHEMA\.md read whole \| ≈[\d,]+ \| 2 \| 2 of 2 \| — \| [\d.]+ ms \|/);
		assert.match(text, /# heydb token benchmark — erp/, "the heydb per-question report follows");
	});

	test("skips code-grep without a code folder and adds heydb with notes with --learn", async () => {
		const before = fingerprint(root);
		const comparison = await compete(root, questions, { learn: true });
		assert.deepEqual(fingerprint(root), before);
		const ids = comparison.rows.map((row) => row.id);
		assert.deepEqual(ids.slice(0, 2), ["heydb", "heydb-notes"]);
		assert.equal(ids.includes("code-grep"), false);
		assert.deepEqual(comparison.skipped, ["code-grep: no --code folder"]);
		assert.match(renderComparison(comparison), /# heydb learning loop — erp/);
	});
});
