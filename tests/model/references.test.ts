import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { emptyKnowledge } from "../../lib/knowledge/operations.ts";
import { formatName } from "../../lib/model/names.ts";
import { incomingCounts, incomingReferences, MAX_NAME_PATTERN_GUESSES } from "../../lib/model/references.ts";
import type { ForeignKey, Snapshot, Table } from "../../lib/model/snapshot.ts";
import { annotation, knowledge, relationship } from "../knowledge/fixtures.ts";
import { column, customersTable, snapshot } from "../fixtures/snapshot.ts";

function table(name: string, columns: [string, string?][], overrides: Partial<Table> = {}): Table {
	return {
		...customersTable(),
		name,
		columns: columns.map(([columnName, comment = ""], index) => column(columnName, index + 1, { comment })),
		primaryKey: ["id"],
		...overrides,
	};
}

function fk(name: string, columns: string[], target: string, database = "erp"): ForeignKey {
	return {
		name,
		columns,
		references: { database, schema: database, table: target, columns: ["id"] },
		onDelete: "RESTRICT",
		onUpdate: "RESTRICT",
	};
}

// The shape of the ERP of the field report: "gar" has no comment, and what it
// is shows in the columns that point to it.
const erp: Snapshot = snapshot([], {
	databases: [
		{
			name: "erp",
			schemas: [
				{
					name: "erp",
					routines: [],
					tables: [
						table("gar", [["id"], ["nombre"], ["parent_id"], ["gar_old"]], { foreignKeys: [fk("fk_gar_parent", ["parent_id"], "gar")] }),
						table("gcl", [["id"]]),
						table("pedidos", [["id"], ["ref_gar", "Artículo"], ["cod_gcl", "Cliente Habitual"], ["gar_x"]]),
						table("albaranes", [["id"], ["id_gar", " artículo. "], ["gar_precio", "Precio"]]),
						table("stock", [["id"], ["articulo", "Artículo"]], { foreignKeys: [fk("fk_stock_gar", ["articulo"], "gar")] }),
						table("notas", [["id"], ["gar_ref", "Referencia"], ["ref_gar", "Cliente"]], {
							foreignKeys: [fk("fk_notas_gcl", ["ref_gar"], "gcl")],
						}),
						table("movs", [["id"], ["codigo_articulo", "Referencia"]]),
						table("garantias", [["id"], ["ref_garantia", "Garantía"]]),
						table("postv", [["id"], ["gar", "Artículo"]]),
						table("Facturas", [["id"], ["Ref_GAR"]]),
						table("v_pedidos", [["id"], ["ref_gar", "Artículo"]], { kind: "view", primaryKey: [] }),
					],
				},
			],
		},
		{ name: "otra", schemas: [{ name: "otra", routines: [], tables: [table("x", [["id"], ["ref_gar", "Artículo"]])] }] },
	],
});

const notes = knowledge(
	[annotation("a-1", "erp.erp.gar", { text: "Artículos." })],
	[
		{ ...relationship("r-1", "erp.erp.movs", ["codigo_articulo"], "erp.erp.gar", ["id"]), note: "app code" },
		relationship("r-2", "erp.erp.gar", ["id"], "erp.erp.gar", ["parent_id"]),
	],
);

describe("incomingReferences", () => {
	const incoming = incomingReferences(erp, notes, "erp.erp.gar");

	test("lists declared foreign keys pointing to the table, never its own", () => {
		assert.deepEqual(incoming.declared, [
			{ table: "erp.erp.stock", name: "fk_stock_gar", columns: ["articulo"], toColumns: ["id"], comment: "Artículo" },
		]);
	});

	test("lists implicit relationships pointing to the table, with the comment of the referencing column", () => {
		assert.deepEqual(
			incoming.implicit.map((item) => [item.relationship.id, item.comment]),
			[["r-1", "Referencia"]],
		);
	});

	test("guesses columns named after the table as a whole _ token, commented ones first", () => {
		assert.deepEqual(
			incoming.guesses.map((guess) => [guess.table, guess.column, guess.comment]),
			[
				["erp.erp.albaranes", "gar_precio", "Precio"],
				["erp.erp.albaranes", "id_gar", " artículo. "],
				["erp.erp.notas", "gar_ref", "Referencia"],
				["erp.erp.pedidos", "ref_gar", "Artículo"],
				["erp.erp.Facturas", "Ref_GAR", ""],
				["erp.erp.pedidos", "gar_x", ""],
			],
		);
		assert.equal(incoming.moreGuesses, 0);
	});

	test("summarizes the comments of every referencing column, grouped without case, accents or end punctuation", () => {
		assert.deepEqual(incoming.summary, [
			{ comment: "Artículo", count: 3 },
			{ comment: "Referencia", count: 2 },
			{ comment: "Precio", count: 1 },
		]);
	});

	test("a table nobody points to has nothing", () => {
		assert.deepEqual(incomingReferences(erp, emptyKnowledge(), "erp.erp.movs"), {
			declared: [],
			implicit: [],
			guesses: [],
			moreGuesses: 0,
			summary: [],
		});
	});

	test("keeps at most MAX_NAME_PATTERN_GUESSES guesses, but summarizes all of them", () => {
		const many = 250;
		const wide = snapshot([
			table("gar", [["id"]]),
			table(
				"lineas",
				Array.from({ length: many }, (_, index): [string, string] => [`ref${index}_gar`, index < 10 ? "Producto" : "Artículo"]),
			),
		]);
		const result = incomingReferences(wide, emptyKnowledge(), "shop.shop.gar");
		assert.equal(MAX_NAME_PATTERN_GUESSES, 200);
		assert.equal(result.guesses.length, 200);
		assert.equal(result.moreGuesses, 50);
		assert.deepEqual(result.summary, [
			{ comment: "Artículo", count: 240 },
			{ comment: "Producto", count: 10 },
		]);
	});

	test("rejects a name that is not a canonical table name", () => {
		assert.throws(() => incomingReferences(erp, notes, "gar"), /expected a table name \(database\.schema\.table\)/);
	});
});

describe("incomingCounts", () => {
	test("counts, for every table, exactly what incomingReferences finds", () => {
		const counts = incomingCounts(erp, notes);
		assert.equal(counts.get("erp.erp.gar"), 8);
		assert.equal(counts.get("erp.erp.gcl"), 2);
		for (const database of erp.databases) {
			for (const schema of database.schemas) {
				for (const { name } of schema.tables) {
					const canonical = formatName({ database: database.name, schema: schema.name, table: name });
					const found = incomingReferences(erp, notes, canonical);
					const total = found.declared.length + found.implicit.length + found.guesses.length + found.moreGuesses;
					assert.equal(counts.get(canonical) ?? 0, total, canonical);
				}
			}
		}
	});
});

describe("relationships into another connection", () => {
	// Stored here, but its target lives in the "other" connection, whose database is also called erp.
	const cross = knowledge(
		[],
		[{ ...relationship("x-1", "erp.erp.stock", ["articulo"], "erp.erp.gar", ["id"]), to: { connection: "other", table: "erp.erp.gar", columns: ["id"] } }],
	);

	test("are not references to a same-named table of this connection", () => {
		assert.deepEqual(incomingReferences(erp, cross, "erp.erp.gar").implicit, []);
		assert.deepEqual(incomingCounts(erp, cross), incomingCounts(erp, emptyKnowledge()));
	});
});
