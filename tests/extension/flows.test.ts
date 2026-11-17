import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import { saveConfig } from "../../lib/config/store.ts";
import { loadKnowledge } from "../../lib/store/knowledge.ts";
import { saveSnapshot } from "../../lib/store/snapshots.ts";
import { initProject } from "../../lib/usecases/init.ts";
import { parseWrite, saveFlow } from "../../lib/usecases/flows.ts";
import { fixedClock } from "../knowledge/fixtures.ts";
import { column, customersTable, ordersTable, snapshot } from "../fixtures/snapshot.ts";
import { loadHeydb, runTool, tempDirs } from "./fake-pi.ts";

const tempDir = tempDirs("heydb-flows-");

const stored = snapshot([
	customersTable(),
	ordersTable({ comment: "One row per checkout." }),
	ordersTable({
		name: "invoices",
		comment: "Facturas emitidas",
		columns: [column("id", 1), column("order_id", 2), column("total", 3), column("status", 4)],
		indexes: [],
		foreignKeys: [],
	}),
	ordersTable({ name: "invoice_lines", columns: [column("invoice_id", 1), column("amount", 2)], indexes: [], foreignKeys: [] }),
	ordersTable({ name: "products", comment: "Catálogo", columns: [column("id", 1)], indexes: [], foreignKeys: [] }),
]);

const local = {
	engine: "mysql" as const,
	host: "127.0.0.1",
	port: 3306,
	user: "root",
	password: "env:HEYDB_LOCAL_PASSWORD",
	databases: null,
};

function project(): string {
	const root = tempDir();
	initProject(root);
	saveConfig(root, { formatVersion: 1, defaultConnection: "local", connections: { local } });
	saveSnapshot(root, "local", stored);
	return root;
}

const invoiceFlow = {
	name: "emitir factura",
	synonyms: ["facturar pedido", "sacar factura"],
	entry: "src/billing/invoice.ts:issueInvoice",
	writes: ["invoices(order_id, total, status)", "shop.invoice_lines (invoice_id,amount)"],
	reads: ["orders", "Customers"],
	sources: ["src/billing/invoice.ts"],
};

const invoiceFlowText = [
	"flow: emitir factura (also: facturar pedido, sacar factura)",
	"entry: src/billing/invoice.ts:issueInvoice",
	"writes: shop.invoices(order_id, total, status), shop.invoice_lines(invoice_id, amount)",
	"reads: shop.orders, shop.customers",
	"sources: src/billing/invoice.ts",
].join("\n");

const flowLine =
	"- flow: emitir factura — writes shop.invoices, shop.invoice_lines; reads shop.orders, shop.customers (entry src/billing/invoice.ts:issueInvoice)";

function knowledgeFile(root: string): string {
	return readFileSync(join(root, ".heydb", "knowledge", "local.json"), "utf8");
}

describe("heydb_flow", () => {
	test("saves a flow with every table resolved, and returns it by name or synonym, case and accents aside", async () => {
		const pi = loadHeydb();
		const root = project();

		assert.deepEqual(await runTool(pi, "heydb_flow", invoiceFlow, root), {
			isError: false,
			text: 'Saved flow "emitir factura" id-001 (author: Ana (via agent)).',
		});
		assert.deepEqual(loadKnowledge(root, "local").flows, [
			{
				id: "id-001",
				name: "emitir factura",
				synonyms: ["facturar pedido", "sacar factura"],
				entry: "src/billing/invoice.ts:issueInvoice",
				writes: [
					{ table: "shop.shop.invoices", columns: ["order_id", "total", "status"] },
					{ table: "shop.shop.invoice_lines", columns: ["invoice_id", "amount"] },
				],
				reads: ["shop.shop.orders", "shop.shop.customers"],
				sources: ["src/billing/invoice.ts"],
				author: "Ana (via agent)",
				createdAt: "2026-11-06T10:00:00.000Z",
				updatedAt: "2026-11-06T10:00:00.000Z",
				revision: 1,
			},
		]);

		const expected = { isError: false, text: `${invoiceFlowText}\n[id id-001 · Ana (via agent) · 2026-11-06 · revision 1]` };
		for (const name of ["emitir factura", "Sacar  Factura", "facturár pedido"]) {
			assert.deepEqual(await runTool(pi, "heydb_flow", { name }, root), expected, name);
		}
	});

	test("a flow with stages shows each on its own line, and open when something could not be followed", async () => {
		const pi = loadHeydb();
		const root = project();
		const flow = {
			name: "facturar albaranes",
			entry: "src/billing/batch.ts:invoiceDeliveries",
			reads: ["customers"],
			stages: [
				{ name: "agrupar", reads: ["orders"] },
				{ name: "emitir", writes: ["invoices(order_id, total)", "invoice_lines()"] },
			],
			open: "numbering is done by a database function without code",
		};
		assert.equal((await runTool(pi, "heydb_flow", flow, root)).isError, false);
		assert.deepEqual(await runTool(pi, "heydb_flow", { name: "facturar albaranes" }, root), {
			isError: false,
			text: [
				"flow: facturar albaranes",
				"entry: src/billing/batch.ts:invoiceDeliveries",
				"reads: shop.customers",
				"stage agrupar: reads: shop.orders",
				"stage emitir: writes: shop.invoices(order_id, total), shop.invoice_lines",
				"open: numbering is done by a database function without code",
				"[id id-001 · Ana (via agent) · 2026-11-06 · revision 1]",
			].join("\n"),
		});
		assert.deepEqual(await runTool(pi, "heydb_flow", { ...flow, stages: [{ reads: ["orders"] }] }, root), {
			isError: true,
			text: "stages[0].name must not be empty",
		});
	});

	test("says which flows exist when the name matches none", async () => {
		const pi = loadHeydb();
		const root = project();
		assert.deepEqual(await runTool(pi, "heydb_flow", { name: "cobrar" }, root), {
			isError: true,
			text: 'no flow is called "cobrar": none is saved for connection "local" yet',
		});
		await runTool(pi, "heydb_flow", invoiceFlow, root);
		assert.deepEqual(await runTool(pi, "heydb_flow", { name: "cobrar" }, root), {
			isError: true,
			text: 'no flow is called "cobrar"; saved flows: "emitir factura"',
		});
	});

	test("rejects an unknown table or written column with suggestions and saves nothing", async () => {
		const pi = loadHeydb();
		const root = project();
		assert.deepEqual(await runTool(pi, "heydb_flow", { ...invoiceFlow, writes: ["invoice"] }, root), {
			isError: true,
			text: 'writes[0].table: no table matches "invoice". Did you mean: shop.invoices, shop.invoice_lines?',
		});
		assert.deepEqual(await runTool(pi, "heydb_flow", { ...invoiceFlow, reads: ["custmers"] }, root), {
			isError: true,
			text: 'reads[0]: no table matches "custmers". Did you mean: shop.customers?',
		});
		assert.deepEqual(await runTool(pi, "heydb_flow", { ...invoiceFlow, writes: ["invoices(totl)"] }, root), {
			isError: true,
			text: 'writes[0].columns[0]: no column matches "shop.invoices.totl". Did you mean: shop.invoices.total, shop.orders.total?',
		});
		const stages = [{ name: "líneas", writes: ["invoice_line()"] }];
		assert.deepEqual(await runTool(pi, "heydb_flow", { ...invoiceFlow, stages }, root), {
			isError: true,
			text: 'stages[0].writes[0].table: no table matches "invoice_line". Did you mean: shop.invoice_lines?',
		});
		assert.equal(loadKnowledge(root, "local").flows, undefined);
	});

	test("a save whose name matches a flow updates it, revision + 1, and shows what it replaced", async () => {
		const pi = loadHeydb();
		const root = project();
		await runTool(pi, "heydb_flow", invoiceFlow, root);

		const result = await runTool(pi, "heydb_flow", { ...invoiceFlow, name: "Emitir Factura", reads: ["orders", "customers", "products"] }, root);
		assert.deepEqual(result, {
			isError: false,
			text: `Updated flow "Emitir Factura" id-001 to revision 2 (author: Ana (via agent)). It replaced:\n${invoiceFlowText}\n[id id-001 · Ana (via agent) · 2026-11-06 · revision 1]`,
		});
		const [flow, ...others] = loadKnowledge(root, "local").flows ?? [];
		assert.deepEqual(others, []);
		assert.equal(flow?.name, "Emitir Factura");
		assert.deepEqual(flow?.reads, ["shop.shop.orders", "shop.shop.customers", "shop.shop.products"]);
		assert.equal(flow?.revision, 2);
		assert.equal(flow?.createdAt, "2026-11-06T10:00:00.000Z");
		assert.equal(flow?.updatedAt, "2026-11-06T10:00:01.000Z");
	});

	test("a save whose name or synonym is a synonym of a flow updates that flow", async () => {
		const pi = loadHeydb();
		const root = project();
		await runTool(pi, "heydb_flow", invoiceFlow, root);

		const bySynonym = await runTool(pi, "heydb_flow", { ...invoiceFlow, name: "facturación", synonyms: ["Sacar factura"] }, root);
		assert.equal(bySynonym.isError, false, bySynonym.text);
		assert.match(bySynonym.text, /^Updated flow "facturación" id-001 to revision 2 /);
		const byName = await runTool(pi, "heydb_flow", { ...invoiceFlow, name: "SACAR FACTURA", synonyms: [] }, root);
		assert.match(byName.text, /^Updated flow "SACAR FACTURA" id-001 to revision 3 /);
		const flows = loadKnowledge(root, "local").flows ?? [];
		assert.deepEqual(flows.map((flow) => [flow.id, flow.name, flow.synonyms, flow.revision]), [["id-001", "SACAR FACTURA", [], 3]]);
	});

	test("refuses to replace a flow a person wrote unless the user confirmed it", async () => {
		const pi = loadHeydb();
		const root = project();
		saveFlow(root, "local", { ...invoiceFlow, writes: invoiceFlow.writes.map(parseWrite), author: "Bea" }, fixedClock());
		const before = knowledgeFile(root);

		assert.deepEqual(await runTool(pi, "heydb_flow", { ...invoiceFlow, reads: ["orders"] }, root), {
			isError: true,
			text: `Flow "emitir factura" was written by Bea, a person. Show it to the user and ask before replacing it; if they agree, save again with user_confirmed: true.\n${invoiceFlowText}\n[id id-001 · Bea · 2026-11-06 · revision 1]`,
		});
		assert.equal(knowledgeFile(root), before);

		const confirmed = await runTool(pi, "heydb_flow", { ...invoiceFlow, reads: ["orders"], user_confirmed: true }, root);
		assert.match(confirmed.text, /^Updated flow "emitir factura" id-001 to revision 2 \(author: Bea\)\. It replaced:\n/);
		assert.deepEqual(loadKnowledge(root, "local").flows?.[0]?.reads, ["shop.shop.orders"]);
	});

	test("rejects a flow longer than 600 characters rendered, with its size", async () => {
		const pi = loadHeydb();
		const root = project();
		// "flow: x" 7 + "entry: a:b" 10 + "reads: shop.orders" 18 + "open: " 6 + 3 line breaks = 44.
		const flow = { name: "x", entry: "a:b", reads: ["orders"] };
		assert.deepEqual(await runTool(pi, "heydb_flow", { ...flow, open: "y".repeat(557) }, root), {
			isError: true,
			text: "flow is too long: 601 characters rendered (max 600). Keep every table and column; shorten synonyms, open and stage names, or save each stage as its own flow.",
		});
		assert.equal(loadKnowledge(root, "local").flows, undefined);
		const fits = await runTool(pi, "heydb_flow", { ...flow, open: "ñ".repeat(556) }, root);
		assert.equal(fits.isError, false, fits.text);
	});

	test("a flow names at least one table and an entry", async () => {
		const pi = loadHeydb();
		const root = project();
		assert.deepEqual(await runTool(pi, "heydb_flow", { name: "x", entry: "a:b" }, root), {
			isError: true,
			text: "a flow names at least one table: give writes, reads or stages",
		});
		assert.deepEqual(await runTool(pi, "heydb_flow", { name: "x", reads: ["orders"] }, root), {
			isError: true,
			text: "entry is required to save a flow (file:function); with only name, heydb_flow returns the saved flow",
		});
	});
});

describe("flows in search and tables", () => {
	test("heydb_search finds a flow by its name and by a synonym, as one line, before weaker table matches", async () => {
		const pi = loadHeydb();
		const root = project();
		await runTool(pi, "heydb_flow", invoiceFlow, root);

		for (const query of ["emitir factura", "sacar factura", "facturar pedidos"]) {
			const result = await runTool(pi, "heydb_search", { query }, root);
			const lines = result.text.split("\n");
			assert.equal(lines[1], flowLine, `${query}\n${result.text}`);
		}
	});

	test("heydb_search lists the flows touching a table it names, after the table", async () => {
		const pi = loadHeydb();
		const root = project();
		await runTool(pi, "heydb_flow", invoiceFlow, root);

		const result = await runTool(pi, "heydb_search", { query: "customers" }, root);
		const lines = result.text.split("\n").filter((line) => line.startsWith("- "));
		assert.match(lines[0] ?? "", /^- table shop\.customers/, result.text);
		assert.equal(lines[1], flowLine, result.text);
		// Without flows, the same search shows the same tables.
		const without = await runTool(loadHeydb(), "heydb_search", { query: "customers" }, project());
		assert.deepEqual(
			without.text.split("\n").filter((line) => line.startsWith("- ")),
			lines.filter((line) => line !== flowLine),
		);
	});

	test("a search kept to the database of its tables still finds the flow", async () => {
		const pi = loadHeydb();
		const root = project();
		await runTool(pi, "heydb_flow", invoiceFlow, root);
		const result = await runTool(pi, "heydb_search", { query: "emitir factura", database: "shop" }, root);
		assert.match(result.text, /- flow: emitir factura/);
	});

	test("heydb_table lists the names of the flows that touch the table, on one line", async () => {
		const pi = loadHeydb();
		const root = project();
		await runTool(pi, "heydb_flow", invoiceFlow, root);
		await runTool(pi, "heydb_flow", { name: "cobrar pedido", entry: "src/pay.ts:charge", writes: ["orders(total)"] }, root);

		const orders = await runTool(pi, "heydb_table", { table: "orders" }, root);
		assert.match(orders.text, /\n\nFlows: cobrar pedido, emitir factura \(steps: heydb_flow\)\n\n/);
		const customers = await runTool(pi, "heydb_table", { table: "customers" }, root);
		assert.match(customers.text, /\n\nFlows: emitir factura \(steps: heydb_flow\)\n\n/);
		const products = await runTool(pi, "heydb_table", { table: "products" }, root);
		assert.doesNotMatch(products.text, /Flows:/);
	});

	test("notes and relationships are saved as before, and a file without flows has no flows key", async () => {
		const pi = loadHeydb();
		const root = project();
		await runTool(pi, "heydb_annotate", { target: "orders", text: "Pedidos (code: src/orders.ts)" }, root);
		await runTool(pi, "heydb_relate", { from_table: "invoices", from_columns: ["order_id"], to_table: "orders", to_columns: ["id"] }, root);
		const before = JSON.parse(knowledgeFile(root));
		assert.deepEqual(Object.keys(before), ["annotations", "formatVersion", "relationships"]);

		await runTool(pi, "heydb_flow", invoiceFlow, root);
		const after = JSON.parse(knowledgeFile(root));
		assert.deepEqual(Object.keys(after), ["annotations", "flows", "formatVersion", "relationships"]);
		assert.deepEqual(after.annotations, before.annotations);
		assert.deepEqual(after.relationships, before.relationships);
		assert.match((await runTool(pi, "heydb_table", { table: "orders" }, root)).text, /- table: Pedidos \(code: src\/orders\.ts\) \[id id-001 · Ana \(via agent\) · 2026-11-06\]/);
		// A note saved after a flow keeps the flow.
		await runTool(pi, "heydb_annotate", { target: "invoices", text: "Facturas (code: src/billing/invoice.ts)" }, root);
		assert.deepEqual(JSON.parse(knowledgeFile(root)).flows, after.flows);
	});
});
