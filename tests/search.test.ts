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

// A legacy schema in miniature. cus (customers) and art
// (articles) have no useful comment; what they mean is only in the comments
// of the columns that point to them. acme.clientes is an unrelated table
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
						table("cus", [column("id", 1), column("nom", 2, { comment: "Nombre" })]),
						table("art", [column("id", 1), column("des", 2, { comment: "Descripción" })], { comment: "Productos" }),
						...["dln", "mov", "sup", "exp", "cart"].map((name) =>
							table(name, [column("id", 1), column("cod_cus", 2, { comment: "Cliente Habitual" })]),
						),
						table("dnl", [column("id", 1), column("cod_cus", 2, { comment: "Cliente" }), column("ref_art", 3, { comment: "Artículo" })]),
						table("ord", [column("id", 1), column("cod_cus", 2, { comment: "Cliente" }), column("ref_art", 3, { comment: "artículo." })]),
						table("inv", [column("id", 1), column("num", 2, { comment: "Nº Factura" }), column("fec", 3, { comment: "Fecha" })]),
						table("inl", [column("id", 1), column("num_inv", 2, { comment: "Factura" }), column("ref_art", 3, { comment: "Artículo" })]),
						table("clientela_web", [column("id", 1)]),
					],
				},
			],
		},
		{ name: "acme", schemas: [{ name: "acme", routines: [], tables: [table("clientes", [column("id", 1), column("email", 2)])] }] },
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
	test('"cliente" finds cus from the columns that reference it, and says it is an inference', () => {
		const { results } = searchSchema(erp, emptyKnowledge(), "cliente");
		// A table literally called "clientes" legitimately ranks first.
		assert.equal(results[0]?.target, "acme.acme.clientes");
		const cus = results.slice(0, 3).find((result) => result.target === "gestion.gestion.cus");
		assert.ok(cus, lines(results).join("\n"));
		assert.equal(cus.object, "table");
		assert.equal(cus.inferred, true);
		assert.deepEqual(cus.matchedIn, ['referenced as "Cliente Habitual" ×5, "Cliente" ×2 (inferred)']);
		// The plural finds it too.
		assert.ok(searchSchema(erp, emptyKnowledge(), "clientes").results.slice(0, 3).some((result) => result.target === "gestion.gestion.cus"));
	});

	test('"artículo" and "articulos" find art, whose own comment says "Productos", also as an abbreviation', () => {
		for (const query of ["artículo", "articulos", "ARTICULO"]) {
			const [first] = searchSchema(erp, emptyKnowledge(), query).results;
			assert.equal(first?.target, "gestion.gestion.art", query);
			assert.deepEqual(first?.matchedIn, ['referenced as "Artículo" ×3 (inferred)', "name (abbreviation)"], query);
		}
	});

	test('"factura" lists the invoice header as a table, with its matching columns', () => {
		const { results } = searchSchema(erp, emptyKnowledge(), "factura");
		const header = results.find((result) => result.target === "gestion.gestion.inv");
		assert.ok(header);
		assert.equal(header.object, "table");
		assert.deepEqual(header.matchedIn, ['referenced as "Factura" ×1 (inferred)', 'columns: num ("Nº Factura")']);
		assert.deepEqual(header.columns, [{ name: "num", snippet: "Nº Factura" }]);
		assert.equal(results[0]?.target, "gestion.gestion.inv");
		assert.ok(results.every((result) => (result.object as string) !== "column"));
	});

	test("a referencing table is listed by its columns, after the table they point to", () => {
		const { results } = searchSchema(erp, emptyKnowledge(), "cliente habitual");
		assert.equal(results[0]?.target, "gestion.gestion.cus");
		assert.deepEqual(results[1]?.matchedIn, ['columns: cod_cus ("Cliente Habitual")']);
		assert.equal(results[1]?.inferred, false);
	});
});

describe("searchSchema: ranking", () => {
	test("exact name, then stated meaning, then a word of the name, then inferred meaning, then columns", () => {
		const ranked: Snapshot = snapshot([
			table("cliente_tmp", [column("id", 1)]),
			table("cus", [column("id", 1)]),
			table("socios", [column("id", 1)], { comment: "Clientes con cuota" }),
			table("dln", [column("id", 1), column("cod_cus", 2, { comment: "Cliente" })]),
			table("clientes", [column("id", 1)]),
		]);
		assert.deepEqual(lines(searchSchema(ranked, emptyKnowledge(), "cliente").results), [
			"table shop.shop.clientes · name",
			"table shop.shop.socios · table comment: Clientes con cuota",
			"table shop.shop.cliente_tmp · name",
			'table shop.shop.cus · referenced as "Cliente" ×1 (inferred)',
			'table shop.shop.dln · columns: cod_cus ("Cliente")',
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
		const team = knowledge([annotation("n-1", "shop.shop.cus", { text: "Clientes del ERP." })]);
		const plain: Snapshot = snapshot([table("cus", [column("id", 1)])]);
		assert.deepEqual(lines(searchSchema(plain, team, "cliente").results), ["table shop.shop.cus · note: Clientes del ERP."]);
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
		// The shorter text that matches ranks first.
		assert.deepEqual(lines(searchSchema(legacy, notes, "tienda").results), [
			"table shop.shop.orders · table comment: Pedidos de la tienda",
			"database shop.shop · note: Base principal de la tienda online",
		]);
		const [link] = searchSchema(legacy, notes, "myisam").results;
		assert.deepEqual(link, {
			target: "shop.shop.orders(customer_id) → shop.shop.customers(id)",
			object: "relationship",
			matchedIn: ["relationship note: Sin FK: tablas MyISAM"],
			snippet: "Sin FK: tablas MyISAM",
			about: "Sin FK: tablas MyISAM",
			inferred: false,
			abbreviated: false,
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

	test("returns the first `limit` results (10 by default) and the total", () => {
		const tables = Array.from({ length: 30 }, (_, index) => ordersTable({ name: `t_${String(index).padStart(2, "0")}`, columns: [] }));
		const many = snapshot(tables);
		const page = searchSchema(many, emptyKnowledge(), "t_");
		assert.equal(page.total, 30);
		assert.equal(page.results.length, 10);
		assert.equal(page.weaker, 0);
		assert.equal(page.results[0]?.target, "shop.shop.t_00");
		assert.equal(searchSchema(many, emptyKnowledge(), "t_", { limit: 5 }).results.length, 5);
	});

	test("rejects an empty query", () => {
		assert.throws(() => searchSchema(legacy, emptyKnowledge(), "  "), { message: "search query must not be empty" });
	});
});

describe("searchSchema: database filter", () => {
	test("keeps one database, named as shown or canonically", () => {
		for (const database of ["acme", "acme.acme", "ACME"]) {
			assert.deepEqual(lines(searchSchema(erp, emptyKnowledge(), "cliente", { database }).results), ["table acme.acme.clientes · name"], database);
		}
		const gestion = searchSchema(erp, emptyKnowledge(), "cliente", { database: "gestion" }).results;
		assert.ok(gestion.every((result) => result.target.startsWith("gestion.")));
		assert.equal(gestion[0]?.target, "gestion.gestion.cus");
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
			message: 'no database matches "nope"; databases: acme, gestion',
		});
	});
});

describe("searchSchema: performance", () => {
	// 2,000 tables of 30 columns; every table points to a "cliente" table by name.
	test("searches a 2,000-table schema in under 500 ms after the first search", () => {
		const databases = Array.from({ length: 4 }, (_, d) => {
			const name = `db${d}`;
			const tables: Table[] = Array.from({ length: 500 }, (_, t) =>
				table(
					`t${t}`,
					Array.from({ length: 30 }, (_, c) =>
						column(c === 0 ? "id" : c === 1 ? "cod_cus" : c === 2 ? `ref_t${(t + 1) % 500}` : `campo_${c}`, c + 1, {
							comment: c === 1 ? "Cliente Habitual" : c === 2 ? "Artículo relacionado" : c % 5 === 0 ? `Comentario ${c}` : "",
						}),
					),
				),
			);
			return { name, schemas: [{ name, tables: [...tables, table("cus", [column("id", 1)])], routines: [] }] };
		});
		const large = snapshot([], { databases });
		// The first search on a snapshot also finds the copies of every table, once,
		// and keeps them for the snapshot's later searches; slow CI runners need room.
		const firstStarted = performance.now();
		searchSchema(large, emptyKnowledge(), "cliente");
		const first = performance.now() - firstStarted;
		assert.ok(first < 2_000, `first search: ${first.toFixed(0)} ms`);
		for (const query of ["cliente", "articulo", "campo", "articulo relacionado del cliente habitual", "tabla de comentarios"]) {
			const started = performance.now();
			const found = searchSchema(large, emptyKnowledge(), query);
			const elapsed = performance.now() - started;
			assert.ok(found.total > 0, query);
			assert.ok(elapsed < 500, `${query}: ${elapsed.toFixed(0)} ms`);
		}
		assert.equal(searchSchema(large, emptyKnowledge(), "cliente").results[0]?.target, "db0.db0.cus");
	});
});

// A legacy schema with abbreviated names: what the words of a question must
// reach without being typed in the same order, or at all.
const abbreviated: Snapshot = snapshot([
	table("fac_cab", [column("id", 1), column("num_fac", 2), column("cod_cli", 3, { comment: "Cliente" }), column("fec", 4)], {
		comment: "Cabecera de facturas emitidas",
	}),
	table("fac_lin", [column("num_fac", 1, { comment: "Número de factura" }), column("lin", 2), column("can", 3, { comment: "Cantidad" })]),
	table("alb_cab", [column("num_alb", 1), column("cod_cli", 2, { comment: "Cliente" }), column("fec", 3)]),
	table("alb_lin", [column("num_alb", 1), column("lin", 2), column("can", 3, { comment: "Cantidad" })]),
	table("ped_cab", [column("num_ped", 1), column("cod_cli", 2, { comment: "Cliente" })]),
	table("cli", [column("cod_cli", 1), column("nom", 2, { comment: "Nombre" })], { comment: "Clientes" }),
	table("res_anu", [column("id", 1)], { comment: "Resumen de facturación por año" }),
	table("ven_a", [column("id", 1)], { comment: "Factura de venta" }),
	table("ven_b", [column("id", 1)], { comment: "Venta de material, factura aparte" }),
]);

function targets(query: string, data: Snapshot = abbreviated): string[] {
	return searchSchema(data, emptyKnowledge(), query).results.map((result) => result.target);
}

describe("searchSchema: words", () => {
	test("finds a table whose text has every word of the query, in any order", () => {
		assert.equal(targets("facturas emitidas cabecera")[0], "shop.shop.fac_cab");
	});

	test("ignores stopwords and meta words, and does not report them as unmatched", () => {
		const found = searchSchema(abbreviated, emptyKnowledge(), "tabla donde se guardan las líneas del albarán");
		assert.equal(found.results[0]?.target, "shop.shop.alb_lin");
		assert.deepEqual(found.unmatched, []);
		assert.deepEqual(
			found.results.map((result) => result.target),
			targets("lineas albaran"),
		);
	});

	test("keeps a table that matches only some words, below those that match more", () => {
		// The limit lists the weak matches too: by default cli scores too far below ped_cab to be shown.
		const found = searchSchema(abbreviated, emptyKnowledge(), "pedido cliente", { limit: 50 }).results.map((result) => result.target);
		assert.equal(found[0], "shop.shop.ped_cab");
		assert.ok(found.includes("shop.shop.cli"), found.join("\n"));
	});

	test("reads abbreviated name parts: albaran finds alb_cab, factura finds fac_cab", () => {
		const [cab] = searchSchema(abbreviated, emptyKnowledge(), "albaran cabecera").results;
		assert.equal(cab?.target, "shop.shop.alb_cab");
		assert.equal(cab?.matchedIn[0], "name (abbreviation)");
		assert.ok(targets("factura").includes("shop.shop.fac_cab"));
		assert.equal(targets("lineas albaran")[0], "shop.shop.alb_lin");
	});

	test("a column name part repeating its table's abbreviation is not listed again", () => {
		const [cab] = searchSchema(abbreviated, emptyKnowledge(), "albaran", { limit: 50 }).results.filter((result) => result.target === "shop.shop.alb_cab");
		assert.deepEqual([cab?.matchedIn, cab?.columns], [["name (abbreviation)"], []]);
		const client = searchSchema(abbreviated, emptyKnowledge(), "cliente").results.find((result) => result.target === "shop.shop.alb_cab");
		assert.deepEqual(client?.columns, [{ name: "cod_cli", snippet: "Cliente" }]);
	});

	test("a query word of 4 letters or more finds the longer words it starts", () => {
		const [first] = searchSchema(abbreviated, emptyKnowledge(), "factur año").results;
		assert.equal(first?.target, "shop.shop.res_anu");
		assert.equal(first?.matchedIn[0], "table comment: Resumen de facturación por año");
	});

	test("the query as a phrase ranks above the same words apart", () => {
		const found = targets("factura de venta");
		assert.ok(found.indexOf("shop.shop.ven_a") >= 0 && found.indexOf("shop.shop.ven_a") < found.indexOf("shop.shop.ven_b"), found.join("\n"));
	});

	test("says which words matched nothing, with or without results", () => {
		const none = searchSchema(abbreviated, emptyKnowledge(), "xyzzy de plugh");
		assert.deepEqual({ total: none.total, results: none.results, unmatched: none.unmatched }, { total: 0, results: [], unmatched: ["xyzzy", "plugh"] });
		const some = searchSchema(abbreviated, emptyKnowledge(), "facturas xyzzy");
		assert.ok(some.total > 0);
		assert.deepEqual(some.unmatched, ["xyzzy"]);
	});
});

describe("searchSchema: identical databases", () => {
	const facCab = (extra: Column[] = []) =>
		table("fac_cab", [column("num_fac", 1, { type: "int(11)" }), column("cod_cli", 2, { comment: "Cliente" }), ...extra], { comment: "Facturas" });
	const companies: Snapshot = snapshot([], {
		databases: ["emp_001", "emp_002", "emp_003", "emp_004"].map((name, index) => ({
			name,
			schemas: [{ name, routines: [], tables: [facCab(index === 2 ? [column("extra", 3)] : [])] }],
		})),
	});

	test("one result per table repeated with the same columns, naming the other databases", () => {
		const found = searchSchema(companies, emptyKnowledge(), "facturas");
		assert.equal(found.total, 2);
		assert.deepEqual(
			found.results.map((result) => [result.target, result.alsoIn]),
			[
				["emp_001.emp_001.fac_cab", ["emp_002", "emp_004"]],
				["emp_003.emp_003.fac_cab", undefined],
			],
		);
	});

	test("the database filter keeps only its own copy", () => {
		const found = searchSchema(companies, emptyKnowledge(), "facturas", { database: "emp_002" });
		assert.deepEqual(
			found.results.map((result) => [result.target, result.alsoIn]),
			[["emp_002.emp_002.fac_cab", undefined]],
		);
	});
});

describe("searchSchema: what a result says", () => {
	test("says what the table is: its comment, else its team note, whatever matched", () => {
		const team = knowledge([annotation("n-1", "shop.shop.alb_cab", { text: "Albaranes de venta.\nUno por envío." })]);
		const found = searchSchema(abbreviated, team, "cliente", { limit: 50 }).results;
		const about = (name: string) => found.find((result) => result.target === `shop.shop.${name}`)?.about;
		assert.equal(about("fac_cab"), "Cabecera de facturas emitidas");
		assert.equal(about("alb_cab"), "Albaranes de venta. Uno por envío.");
		assert.equal(about("ped_cab"), "");
		const [database] = searchSchema(legacy, notes, "principal").results;
		assert.equal(database?.about, "Base principal de la tienda online");
	});

	test("marks a table found only by an abbreviation of its name", () => {
		const [cab] = searchSchema(abbreviated, emptyKnowledge(), "albaran cabecera").results;
		assert.equal(cab?.target, "shop.shop.alb_cab");
		assert.equal(cab?.abbreviated, true);
		const [fac] = searchSchema(abbreviated, emptyKnowledge(), "facturas emitidas").results;
		assert.equal(fac?.target, "shop.shop.fac_cab");
		assert.equal(fac?.abbreviated, false);
	});

	test("an inferred result carries the comments it was inferred from", () => {
		const cus = searchSchema(erp, emptyKnowledge(), "cliente").results.find((result) => result.target === "gestion.gestion.cus");
		assert.deepEqual(cus?.inferredFrom, [
			{ comment: "Cliente Habitual", count: 5 },
			{ comment: "Cliente", count: 2 },
		]);
		assert.equal(searchSchema(erp, emptyKnowledge(), "cliente").results[0]?.inferredFrom, undefined);
	});
});

describe("searchSchema: how many results", () => {
	test("leaves out matches far weaker than the best and counts them; an explicit limit lists them", () => {
		const found = searchSchema(abbreviated, emptyKnowledge(), "facturas emitidas cabecera");
		assert.deepEqual(
			found.results.map((result) => result.target),
			["shop.shop.fac_cab"],
		);
		assert.ok(found.total > 1, String(found.total));
		assert.equal(found.weaker, found.total - 1);
		const all = searchSchema(abbreviated, emptyKnowledge(), "facturas emitidas cabecera", { limit: 50 });
		assert.deepEqual([all.results.length, all.weaker], [found.total, 0]);
	});
});

// What the team learns, written down, must steer the next search: cst means
// nothing until someone notes it is the customer master, and from then on
// "clientes" finds it first, ahead of tables that only mention customers in
// a column comment or a name.
describe("searchSchema: the learning loop", () => {
	const gclColumns = () => [column("id", 1), column("nom", 2), column("nif", 3, { type: "varchar(15)" }), column("pob", 4, { type: "varchar(60)" })];
	const learned: Snapshot = snapshot([
		table("cst", gclColumns(), { rowEstimate: 48_000 }),
		// A temporary copy of cst that happens to carry the word in its name.
		table("clientes_tmp", gclColumns(), { rowEstimate: 12 }),
		...Array.from({ length: 30 }, (_, index) =>
			table(`doc_${String(index).padStart(2, "0")}`, [column("id", 1), column("cod_cst", 2, { comment: "Cliente" }), column("fec", 3, { type: "date" })]),
		),
		...["Artículos", "Almacenes", "Pedidos", "Bancos"].map((comment, index) => table(`t${index}`, [column("id", 1)], { comment })),
	]);
	const note = knowledge([annotation("n-cst", "shop.shop.cst", { text: "Maestro de clientes: ficha de gestión de clientes" })]);

	test("a note on a table makes it the first result for the words it uses", () => {
		for (const query of ["clientes", "cliente", "ficha de clientes"]) {
			const [first] = searchSchema(learned, note, query).results;
			assert.equal(first?.target, "shop.shop.cst", `${query}\n${lines(searchSchema(learned, note, query).results).join("\n")}`);
			assert.equal(first?.about, "Maestro de clientes: ficha de gestión de clientes", query);
		}
	});

	test("a long note outweighs the same word in another table's name", () => {
		const long = [
			"Fichero histórico que la aplicación de escritorio rellena cada noche con los movimientos de los clientes",
			"para el informe anual; se conserva porque contabilidad lo consulta a mano y no tiene otro uso conocido.",
		].join(" ");
		const data: Snapshot = snapshot([
			table("x01", [column("id", 1), column("a", 2), column("b", 3)]),
			table("clientes_hist", [column("id", 1), column("fecha", 2, { type: "date" }), column("importe", 3, { type: "decimal(12,2)" })]),
			...["Artículos", "Almacenes", "Pedidos"].map((comment, index) => table(`t${index}`, [column("id", 1)], { comment })),
		]);
		const team = knowledge([
			annotation("n-1", "shop.shop.x01", { text: long }),
			annotation("n-2", "shop.shop.t0", { text: "Maestro." }),
			annotation("n-3", "shop.shop.t1", { text: "Stock." }),
		]);
		assert.deepEqual(
			searchSchema(data, team, "clientes").results.map((result) => result.target),
			["shop.shop.x01", "shop.shop.clientes_hist"],
		);
	});

	test("a note outweighs column comments that say the same word", () => {
		const data: Snapshot = snapshot([
			table("zz", [column("id", 1), column("c1", 2)]),
			table("mov", [
				column("id", 1),
				column("cod_cli", 2, { comment: "Cliente" }),
				column("cli_fac", 3, { comment: "Cliente de facturación" }),
				column("cli_env", 4, { comment: "Cliente de envío" }),
			]),
		]);
		const team = knowledge([annotation("n-1", "shop.shop.zz", { text: "Clientes potenciales captados en ferias." })]);
		assert.equal(searchSchema(data, team, "cliente").results[0]?.target, "shop.shop.zz");
	});
});

// Legacy databases keep copies of a table next to it (one per year, a
// backup, a temporary one), named however each company likes. They are
// recognized by their columns, never by their names.
describe("searchSchema: copies of a table in the same database", () => {
	const facColumns = (extra: Column[] = []) => [
		column("id", 1),
		column("num_fac", 2),
		column("cod_cli", 3, { comment: "Cliente" }),
		column("fec", 4, { type: "date" }),
		column("tot", 5, { type: "decimal(12,2)" }),
		...extra,
	];
	const yearly: Snapshot = snapshot([
		table("fac_cab", facColumns(), { rowEstimate: 175_000 }),
		...[2019, 2020, 2021].map((year) => table(`fac_cab_${year}`, facColumns(), { rowEstimate: 50_000 })),
		table("fac_lin", [column("num_fac", 1), column("lin", 2), column("can", 3, { comment: "Cantidad" })]),
	]);

	test("a copy that matches only what it shares with its original is folded under it and counted once", () => {
		const found = searchSchema(yearly, emptyKnowledge(), "cliente");
		assert.deepEqual(
			found.results.map((result) => [result.target, result.copies]),
			[["shop.shop.fac_cab", ["fac_cab_2019", "fac_cab_2020", "fac_cab_2021"]]],
		);
		assert.equal(found.total, 1);
	});

	test("a copy whose own name word is asked for is a result of its own", () => {
		const found = searchSchema(yearly, emptyKnowledge(), "facturas 2019", { limit: 50 }).results;
		assert.equal(found[0]?.target, "shop.shop.fac_cab_2019");
		assert.equal(found[0]?.copies, undefined);
		assert.deepEqual(
			found.find((result) => result.target === "shop.shop.fac_cab")?.copies,
			["fac_cab_2020", "fac_cab_2021"],
		);
	});

	test("a copy with its own matching note or column is a result of its own", () => {
		const team = knowledge([annotation("n-1", "shop.shop.fac_cab_2020", { text: "Cliente: facturas rectificadas a mano." })]);
		const noted = searchSchema(yearly, team, "cliente").results.map((result) => result.target);
		assert.ok(noted.includes("shop.shop.fac_cab_2020"), noted.join("\n"));
		const wider: Snapshot = snapshot([
			table("fac_cab", facColumns(), { rowEstimate: 175_000 }),
			table("fac_cab_ant", facColumns([column("cli_ant", 6, { comment: "Cliente anterior" })])),
		]);
		// fac_cab_ant has 5 of its 6 columns in fac_cab: under 90%, not a copy.
		assert.deepEqual(
			searchSchema(wider, emptyKnowledge(), "cliente")
				.results.map((result) => [result.target, result.copies])
				.sort(),
			[
				["shop.shop.fac_cab", undefined],
				["shop.shop.fac_cab_ant", undefined],
			],
		);
	});

	test("a near-total copy (90% of its columns in the original) is folded too", () => {
		const many = Array.from({ length: 10 }, (_, index) => column(`c${index}`, index + 1, { comment: index === 3 ? "Cliente" : "" }));
		const data: Snapshot = snapshot([
			table("ventas", many, { rowEstimate: 900 }),
			table("ventas_sel", many.slice(0, 9)),
			table("x", many.slice(0, 2)),
		]);
		assert.deepEqual(
			searchSchema(data, emptyKnowledge(), "cliente").results.map((result) => [result.target, result.copies]),
			[["shop.shop.ventas", ["ventas_sel"]]],
		);
	});

	test("the original is the shortest name, then the one with most rows", () => {
		const data: Snapshot = snapshot([
			table("cli_a", facColumns(), { rowEstimate: 10 }),
			table("cli_b", facColumns(), { rowEstimate: 500 }),
			table("cli_old", facColumns(), { rowEstimate: 90_000 }),
		]);
		assert.deepEqual(
			searchSchema(data, emptyKnowledge(), "cliente").results.map((result) => [result.target, result.copies]),
			[["shop.shop.cli_b", ["cli_a", "cli_old"]]],
		);
	});

	test('"rectificación de asistencia" finds the copy whose name abbreviates it; same prefix and other columns is no copy', () => {
		const clock = () => [column("id", 1), column("cod_emp", 2, { comment: "Empleado" }), column("fec", 3, { type: "date" }), column("hor_ent", 4), column("hor_sal", 5)];
		const data: Snapshot = snapshot([
			table("asistencia", clock(), { rowEstimate: 900_000 }),
			table("asistencia_rec", clock(), { rowEstimate: 3_000 }),
			table("asistencia_partes", [column("id", 1), column("cod_emp", 2, { comment: "Empleado" }), column("parte", 3), column("horas", 4)]),
		]);
		const found = searchSchema(data, emptyKnowledge(), "rectificación de asistencia").results;
		assert.equal(found[0]?.target, "shop.shop.asistencia_rec", lines(found).join("\n"));
		assert.equal(found[0]?.copies, undefined);
		assert.deepEqual(
			searchSchema(data, emptyKnowledge(), "asistencia").results.map((result) => [result.target, result.copies]),
			[
				["shop.shop.asistencia", ["asistencia_rec"]],
				["shop.shop.asistencia_partes", undefined],
			],
		);
	});

	test("tables with a single column or two in common are never copies", () => {
		const data: Snapshot = snapshot([
			table("provincias", [column("id", 1), column("nom", 2, { comment: "Nombre" })]),
			table("paises", [column("id", 1), column("nom", 2, { comment: "Nombre" })]),
		]);
		assert.equal(searchSchema(data, emptyKnowledge(), "nombre").total, 2);
	});
});
