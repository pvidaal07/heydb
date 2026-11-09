import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { describe, test } from "node:test";

import { emptyKnowledge } from "../lib/knowledge/operations.ts";
import type { Column, Snapshot, Table } from "../lib/model/snapshot.ts";
import { foldWord, normalizeText, type SearchResult, searchSchema } from "../lib/search.ts";
import { column, customersTable, ordersTable, snapshot } from "./fixtures/snapshot.ts";
import { annotation, knowledge, relationship } from "./knowledge/fixtures.ts";

const legacy: Snapshot = snapshot([
	ordersTable({ comment: "Pedidos de la tienda" }),
	customersTable(),
	ordersTable({
		name: "facturación",
		columns: [column("id", 1), column("año", 2, { comment: "Año fiscal de la factura" })],
	}),
	ordersTable({ name: "order_lines", columns: [column("order_id", 1)] }),
	ordersTable({
		name: "v_orders",
		kind: "view",
		rowEstimate: null,
		viewDefinition: "select `id` from `shop`.`orders` where `status` = 'DEVUELTO'",
	}),
]);

const notes = knowledge(
	[
		annotation("a-db", "shop.shop", { text: "Base principal de la tienda online" }),
		annotation("a-col", "shop.shop.orders.total", { text: "Incluye IVA.\nSin gastos de envío." }),
	],
	[{ ...relationship("r-1", "shop.shop.orders", ["customer_id"], "shop.shop.customers", ["id"]), note: "Sin FK: tablas MyISAM" }],
);

function lines(results: readonly SearchResult[]): string[] {
	return results.map((result) => `${result.object} ${result.target} · ${result.matchedIn.join(" · ")}`);
}

function table(name: string, columns: Column[], overrides: Partial<Table> = {}): Table {
	return { ...customersTable(), name, columns, ...overrides };
}

// The ERP of the field report, in miniature. gcl (customers) and gar
// (articles) have no useful comment; what they mean is only in the comments
// of the columns that point to them. eagle.clientes is an unrelated table
// that happens to be called "clientes".
const erp: Snapshot = snapshot([], {
	engine: { kind: "mysql", version: "5.7.27" },
	databases: [
		{
			name: "gestion",
			schemas: [
				{
					name: "gestion",
					routines: [],
					tables: [
						table("gcl", [column("id", 1), column("nom", 2, { comment: "Nombre" })]),
						table("gar", [column("id", 1), column("des", 2, { comment: "Descripción" })], { comment: "Productos" }),
						...["gcv", "ghc", "gpr", "gfg", "whcar"].map((name) =>
							table(name, [column("id", 1), column("cod_gcl", 2, { comment: "Cliente Habitual" })]),
						),
						table("gal", [column("id", 1), column("cod_gcl", 2, { comment: "Cliente" }), column("ref_gar", 3, { comment: "Artículo" })]),
						table("gpe", [column("id", 1), column("cod_gcl", 2, { comment: "Cliente" }), column("ref_gar", 3, { comment: "artículo." })]),
						table("gfc", [column("id", 1), column("num", 2, { comment: "Nº Factura" }), column("fec", 3, { comment: "Fecha" })]),
						table("gfl", [column("id", 1), column("num_gfc", 2, { comment: "Factura" }), column("ref_gar", 3, { comment: "Artículo" })]),
						table("clientela_web", [column("id", 1)]),
					],
				},
			],
		},
		{ name: "eagle", schemas: [{ name: "eagle", routines: [], tables: [table("clientes", [column("id", 1), column("email", 2)])] }] },
	],
});

describe("normalizeText", () => {
	test("ignores case and accents, composed or not", () => {
		assert.equal(normalizeText("FacturaCIÓN Año"), "facturacion ano");
		assert.equal(normalizeText("facturáción"), "facturacion");
	});
});

describe("foldWord", () => {
	test("folds simple Spanish and English plurals to one stem", () => {
		for (const [a, b] of [
			["cliente", "clientes"],
			["articulo", "articulos"],
			["factura", "facturas"],
			["proveedor", "proveedores"],
			["order", "orders"],
			["address", "addresses"],
		]) {
			assert.equal(foldWord(a as string), foldWord(b as string), `${a} / ${b}`);
		}
	});

	test("leaves words of 4 characters or fewer alone", () => {
		assert.equal(foldWord("mes"), "mes");
		assert.equal(foldWord("note"), "note");
		assert.equal(foldWord("pais"), "pais");
		assert.equal(foldWord("paises"), "pais");
	});
});

describe("searchSchema: the field report", () => {
	test('"cliente" finds gcl from the columns that reference it, and says it is an inference', () => {
		const { results } = searchSchema(erp, emptyKnowledge(), "cliente");
		// A table literally called "clientes" legitimately ranks first.
		assert.equal(results[0]?.target, "eagle.eagle.clientes");
		const gcl = results.slice(0, 3).find((result) => result.target === "gestion.gestion.gcl");
		assert.ok(gcl, lines(results).join("\n"));
		assert.equal(gcl.object, "table");
		assert.equal(gcl.inferred, true);
		assert.deepEqual(gcl.matchedIn, ['referenced as "Cliente Habitual" ×5, "Cliente" ×2 (inferred)']);
		// The plural finds it too.
		assert.ok(searchSchema(erp, emptyKnowledge(), "clientes").results.slice(0, 3).some((result) => result.target === "gestion.gestion.gcl"));
	});

	test('"artículo" and "articulos" find gar, whose own comment says "Productos"', () => {
		for (const query of ["artículo", "articulos", "ARTICULO"]) {
			const [first] = searchSchema(erp, emptyKnowledge(), query).results;
			assert.equal(first?.target, "gestion.gestion.gar", query);
			assert.deepEqual(first?.matchedIn, ['referenced as "Artículo" ×3 (inferred)'], query);
		}
	});

	test('"factura" lists the invoice header as a table, with its matching columns', () => {
		const { results } = searchSchema(erp, emptyKnowledge(), "factura");
		const header = results.find((result) => result.target === "gestion.gestion.gfc");
		assert.ok(header);
		assert.equal(header.object, "table");
		assert.deepEqual(header.matchedIn, ['referenced as "Factura" ×1 (inferred)', 'columns: num ("Nº Factura")']);
		assert.deepEqual(header.columns, [{ name: "num", snippet: "Nº Factura" }]);
		assert.equal(results[0]?.target, "gestion.gestion.gfc");
		assert.ok(results.every((result) => (result.object as string) !== "column"));
	});

	test("a referencing table is listed by its columns, after the table they point to", () => {
		const { results } = searchSchema(erp, emptyKnowledge(), "cliente habitual");
		assert.equal(results[0]?.target, "gestion.gestion.gcl");
		assert.deepEqual(results[1]?.matchedIn, ['columns: cod_gcl ("Cliente Habitual")']);
		assert.equal(results[1]?.inferred, false);
	});
});

describe("searchSchema: ranking", () => {
	test("exact name, then stated meaning, then inferred meaning, then name prefix, then columns", () => {
		const ranked: Snapshot = snapshot([
			table("cliente_tmp", [column("id", 1)]),
			table("gcl", [column("id", 1)]),
			table("socios", [column("id", 1)], { comment: "Clientes con cuota" }),
			table("gcv", [column("id", 1), column("cod_gcl", 2, { comment: "Cliente" })]),
			table("clientes", [column("id", 1)]),
		]);
		assert.deepEqual(lines(searchSchema(ranked, emptyKnowledge(), "cliente").results), [
			"table shop.shop.clientes · name",
			"table shop.shop.socios · table comment: Clientes con cuota",
			'table shop.shop.gcl · referenced as "Cliente" ×1 (inferred)',
			"table shop.shop.cliente_tmp · name",
			'table shop.shop.gcv · columns: cod_gcl ("Cliente")',
		]);
	});

	test("a whole word ranks above the same letters inside a longer word", () => {
		const words: Snapshot = snapshot([
			table("a", [column("id", 1)], { comment: "Facturación anual" }),
			table("b", [column("id", 1)], { comment: "Factura de venta" }),
		]);
		assert.deepEqual(lines(searchSchema(words, emptyKnowledge(), "factura").results), [
			"table shop.shop.b · table comment: Factura de venta",
			"table shop.shop.a · table comment: Facturación anual",
		]);
	});

	test("a team note on a table counts like its comment", () => {
		const team = knowledge([annotation("n-1", "shop.shop.gcl", { text: "Clientes del ERP." })]);
		const plain: Snapshot = snapshot([table("gcl", [column("id", 1)])]);
		assert.deepEqual(lines(searchSchema(plain, team, "cliente").results), ["table shop.shop.gcl · note: Clientes del ERP."]);
	});

	test("groups columns under their table: at most 5 listed, the rest counted", () => {
		const wide: Snapshot = snapshot([table("t", Array.from({ length: 7 }, (_, index) => column(`fecha_${index}`, index + 1)))]);
		const [result] = searchSchema(wide, emptyKnowledge(), "fecha").results;
		assert.equal(result?.object, "table");
		assert.deepEqual(
			result?.columns.map((item) => item.name),
			["fecha_0", "fecha_1", "fecha_2", "fecha_3", "fecha_4"],
		);
		assert.equal(result?.moreColumns, 2);
		assert.deepEqual(result?.matchedIn, ["columns: fecha_0, fecha_1, fecha_2, fecha_3, fecha_4 (+2 more)"]);
	});

	test("column notes are found and shown under their table", () => {
		assert.deepEqual(lines(searchSchema(legacy, notes, "envio").results), ['table shop.shop.orders · columns: total ("Incluye IVA. Sin gastos de envío.")']);
	});
});

describe("searchSchema: what it covers", () => {
	test("ignores accents and case on both sides", () => {
		assert.deepEqual(lines(searchSchema(legacy, emptyKnowledge(), "FACTURACION").results), ["table shop.shop.facturación · name"]);
		assert.deepEqual(lines(searchSchema(legacy, emptyKnowledge(), "fiscal").results), [
			'table shop.shop.facturación · columns: año ("Año fiscal de la factura")',
		]);
	});

	test("finds names by prefix and inside", () => {
		assert.deepEqual(lines(searchSchema(legacy, emptyKnowledge(), "order").results), [
			"table shop.shop.orders · name",
			"table shop.shop.order_lines · name · columns: order_id",
			"view shop.shop.v_orders · name · definition: select `id` from `shop`.`orders` where `status` = 'DEVUELTO'",
		]);
	});

	test("finds view definitions, database names and notes, and relationship notes", () => {
		assert.deepEqual(lines(searchSchema(legacy, emptyKnowledge(), "devuelto").results), [
			"view shop.shop.v_orders · definition: select `id` from `shop`.`orders` where `status` = 'DEVUELTO'",
		]);
		assert.deepEqual(lines(searchSchema(legacy, notes, "shop").results), [
			"database shop.shop · name",
			"view shop.shop.v_orders · definition: select `id` from `shop`.`orders` where `status` = 'DEVUELTO'",
		]);
		assert.deepEqual(lines(searchSchema(legacy, notes, "tienda").results), [
			"database shop.shop · note: Base principal de la tienda online",
			"table shop.shop.orders · table comment: Pedidos de la tienda",
		]);
		const [link] = searchSchema(legacy, notes, "myisam").results;
		assert.deepEqual(link, {
			target: "shop.shop.orders(customer_id) → shop.shop.customers(id)",
			object: "relationship",
			matchedIn: ["relationship note: Sin FK: tablas MyISAM"],
			snippet: "Sin FK: tablas MyISAM",
			inferred: false,
			columns: [],
			moreColumns: 0,
			relationship: { from: { table: "shop.shop.orders", columns: ["customer_id"] }, to: { table: "shop.shop.customers", columns: ["id"] } },
		});
	});

	test("cuts a long text to a snippet of at most 120 characters around the match", () => {
		const long = `${"x".repeat(200)} la facturación anual ${"y".repeat(200)}`;
		const withLong = snapshot([ordersTable({ comment: long })]);
		const [result] = searchSchema(withLong, emptyKnowledge(), "facturacion anual").results;
		assert.ok(result !== undefined);
		assert.ok(result.snippet.length <= 120, `${result.snippet.length}`);
		assert.match(result.snippet, /^….* la facturación anual .*…$/);
	});

	test("returns the first `limit` results and the total", () => {
		const tables = Array.from({ length: 30 }, (_, index) => ordersTable({ name: `t_${String(index).padStart(2, "0")}`, columns: [] }));
		const many = snapshot(tables);
		const page = searchSchema(many, emptyKnowledge(), "t_");
		assert.equal(page.total, 30);
		assert.equal(page.results.length, 20);
		assert.equal(page.results[0]?.target, "shop.shop.t_00");
		assert.equal(searchSchema(many, emptyKnowledge(), "t_", { limit: 5 }).results.length, 5);
	});

	test("rejects an empty query", () => {
		assert.throws(() => searchSchema(legacy, emptyKnowledge(), "  "), { message: "search query must not be empty" });
	});
});

describe("searchSchema: database filter", () => {
	test("keeps one database, named as shown or canonically", () => {
		for (const database of ["eagle", "eagle.eagle", "EAGLE"]) {
			assert.deepEqual(lines(searchSchema(erp, emptyKnowledge(), "cliente", { database }).results), ["table eagle.eagle.clientes · name"], database);
		}
		const gestion = searchSchema(erp, emptyKnowledge(), "cliente", { database: "gestion" }).results;
		assert.ok(gestion.every((result) => result.target.startsWith("gestion.")));
		assert.equal(gestion[0]?.target, "gestion.gestion.gcl");
	});

	test("filters PostgreSQL schemas by database.schema", () => {
		const postgres = snapshot([], {
			engine: { kind: "postgresql", version: "16.4" },
			databases: [
				{
					name: "app",
					schemas: [
						{ name: "public", tables: [ordersTable()], routines: [] },
						{ name: "sales", tables: [ordersTable()], routines: [] },
					],
				},
			],
		});
		assert.deepEqual(lines(searchSchema(postgres, emptyKnowledge(), "orders", { database: "app.sales" }).results), ["table app.sales.orders · name"]);
		assert.equal(searchSchema(postgres, emptyKnowledge(), "orders", { database: "app" }).total, 2);
	});

	test("refuses an unknown database and lists the known ones", () => {
		assert.throws(() => searchSchema(erp, emptyKnowledge(), "cliente", { database: "nope" }), {
			message: 'no database matches "nope"; databases: eagle, gestion',
		});
	});
});

describe("searchSchema: performance", () => {
	// 2,000 tables of 30 columns; every table points to a "cliente" table by name.
	test("searches a 2,000-table schema in under 500 ms", () => {
		const databases = Array.from({ length: 4 }, (_, d) => {
			const name = `db${d}`;
			const tables: Table[] = Array.from({ length: 500 }, (_, t) =>
				table(
					`t${t}`,
					Array.from({ length: 30 }, (_, c) =>
						column(c === 0 ? "id" : c === 1 ? "cod_gcl" : c === 2 ? `ref_t${(t + 1) % 500}` : `campo_${c}`, c + 1, {
							comment: c === 1 ? "Cliente Habitual" : c === 2 ? "Artículo relacionado" : c % 5 === 0 ? `Comentario ${c}` : "",
						}),
					),
				),
			);
			return { name, schemas: [{ name, tables: [...tables, table("gcl", [column("id", 1)])], routines: [] }] };
		});
		const large = snapshot([], { databases });
		for (const query of ["cliente", "articulo", "campo"]) {
			const started = performance.now();
			const found = searchSchema(large, emptyKnowledge(), query);
			const elapsed = performance.now() - started;
			assert.ok(found.total > 0, query);
			assert.ok(elapsed < 500, `${query}: ${elapsed.toFixed(0)} ms`);
		}
		assert.equal(searchSchema(large, emptyKnowledge(), "cliente").results[0]?.target, "db0.db0.gcl");
	});
});
