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

// The shape of a legacy schema: "art" has no comment, and what it
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
						table("art", [["id"], ["nombre"], ["parent_id"], ["art_old"]], { foreignKeys: [fk("fk_art_parent", ["parent_id"], "art")] }),
						table("cus", [["id"]]),
						table("pedidos", [["id"], ["ref_art", "Artículo"], ["cod_cus", "Cliente Habitual"], ["art_x"]]),
						table("albaranes", [["id"], ["id_art", " artículo. "], ["art_precio", "Precio"]]),
						table("stock", [["id"], ["articulo", "Artículo"]], { foreignKeys: [fk("fk_stock_art", ["articulo"], "art")] }),
						table("notas", [["id"], ["art_ref", "Referencia"], ["ref_art", "Cliente"]], {
							foreignKeys: [fk("fk_notas_cus", ["ref_art"], "cus")],
						}),
						table("movs", [["id"], ["codigo_articulo", "Referencia"]]),
						table("artistas", [["id"], ["ref_artista", "Artista"]]),
						table("pos", [["id"], ["art", "Artículo"]]),
						table("Facturas", [["id"], ["Ref_ART"]]),
						table("v_pedidos", [["id"], ["ref_art", "Artículo"]], { kind: "view", primaryKey: [] }),
					],
				},
			],
		},
		{ name: "otra", schemas: [{ name: "otra", routines: [], tables: [table("x", [["id"], ["ref_art", "Artículo"]])] }] },
	],
});

const notes = knowledge(
	[annotation("a-1", "erp.erp.art", { text: "Artículos." })],
	[
		{ ...relationship("r-1", "erp.erp.movs", ["codigo_articulo"], "erp.erp.art", ["id"]), note: "app code" },
		relationship("r-2", "erp.erp.art", ["id"], "erp.erp.art", ["parent_id"]),
	],
);

describe("incomingReferences", () => {
	const incoming = incomingReferences(erp, notes, "erp.erp.art");

	test("lists declared foreign keys pointing to the table, never its own", () => {
		assert.deepEqual(incoming.declared, [
			{ table: "erp.erp.stock", name: "fk_stock_art", columns: ["articulo"], toColumns: ["id"], comment: "Artículo" },
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
				["erp.erp.albaranes", "art_precio", "Precio"],
				["erp.erp.albaranes", "id_art", " artículo. "],
				["erp.erp.notas", "art_ref", "Referencia"],
				["erp.erp.pedidos", "ref_art", "Artículo"],
				["erp.erp.Facturas", "Ref_ART", ""],
				["erp.erp.pedidos", "art_x", ""],
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
			table("art", [["id"]]),
			table(
				"lineas",
				Array.from({ length: many }, (_, index): [string, string] => [`ref${index}_art`, index < 10 ? "Producto" : "Artículo"]),
			),
		]);
		const result = incomingReferences(wide, emptyKnowledge(), "shop.shop.art");
		assert.equal(MAX_NAME_PATTERN_GUESSES, 200);
		assert.equal(result.guesses.length, 200);
		assert.equal(result.moreGuesses, 50);
		assert.deepEqual(result.summary, [
			{ comment: "Artículo", count: 240 },
			{ comment: "Producto", count: 10 },
		]);
	});

	test("rejects a name that is not a canonical table name", () => {
		assert.throws(() => incomingReferences(erp, notes, "art"), /expected a table name \(database\.schema\.table\)/);
	});
});

describe("incomingCounts", () => {
	test("counts, for every table, exactly what incomingReferences finds", () => {
		const counts = incomingCounts(erp, notes);
		assert.equal(counts.get("erp.erp.art"), 8);
		assert.equal(counts.get("erp.erp.cus"), 2);
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
		[{ ...relationship("x-1", "erp.erp.stock", ["articulo"], "erp.erp.art", ["id"]), to: { connection: "other", table: "erp.erp.art", columns: ["id"] } }],
	);

	test("are not references to a same-named table of this connection", () => {
		assert.deepEqual(incomingReferences(erp, cross, "erp.erp.art").implicit, []);
		assert.deepEqual(incomingCounts(erp, cross), incomingCounts(erp, emptyKnowledge()));
	});
});
