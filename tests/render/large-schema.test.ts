import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { describe, test } from "node:test";

import { emptyKnowledge } from "../../lib/knowledge/operations.ts";
import { knowledgeForTable } from "../../lib/knowledge/query.ts";
import { incomingReferences } from "../../lib/model/references.ts";
import type { Column, Snapshot, Table } from "../../lib/model/snapshot.ts";
import { renderOverview, renderSearch, renderTable } from "../../lib/render/markdown.ts";
import { searchSchema } from "../../lib/search.ts";
import { column, customersTable } from "../fixtures/snapshot.ts";

// A schema the size of a large legacy one (MySQL 5.7, ~1,500 tables,
// a 540-column table), built here instead of stored as a fixture:
// 4 databases × 500 tables × 50 columns, plus "art" with 600 columns that
// every table of its database points to by name only.

const DATABASES = 4;
const TABLES = 500;
const COLUMNS = 50;
const BUDGET_MS = 500;
// The first search on a snapshot also finds the copies of every table, once,
// and keeps them for the snapshot's later searches; slow CI runners need room.
const FIRST_SEARCH_BUDGET_MS = 2_000;

function largeSnapshot(): Snapshot {
	return {
		formatVersion: 1,
		engine: { kind: "mysql", version: "5.7.27" },
		capturedAt: "2026-11-09T10:00:00.000Z",
		warnings: [],
		databases: Array.from({ length: DATABASES }, (_, d) => {
			const name = `db${d}`;
			const tables: Table[] = Array.from({ length: TABLES }, (_, t) => {
				const prefix = ["sii", "cus", "cart", "log"][t % 4];
				const columns: Column[] = Array.from({ length: COLUMNS }, (_, c) =>
					column(c === 0 ? "id" : c === 1 ? "ref_art" : c === 2 ? `cod_${prefix}_${(t + 1) % TABLES}` : `campo_${c}`, c + 1, {
						type: "varchar(255)",
						comment: c === 1 ? "Artículo" : c % 7 === 0 ? `Comentario ${c}` : "",
					}),
				);
				return { ...customersTable(), name: `${prefix}_${t}`, rowEstimate: t * 1000, columns };
			});
			const art: Table = {
				...customersTable(),
				name: "art",
				rowEstimate: 120_000,
				columns: Array.from({ length: 600 }, (_, c) =>
					column(c === 0 ? "id" : `art_campo_${c}`, c + 1, { type: "decimal(12,4)", comment: c % 10 === 0 ? "Precio" : "" }),
				),
			};
			return { name, schemas: [{ name, tables: [...tables, art], routines: [] }] };
		}),
	};
}

function timed<T>(work: () => T): { value: T; ms: number } {
	const start = performance.now();
	const value = work();
	return { value, ms: performance.now() - start };
}

describe("a huge legacy schema", () => {
	const large = largeSnapshot();
	const knowledge = emptyKnowledge();

	test("the overview renders fast and stays small", () => {
		const { value: text, ms } = timed(() => renderOverview(large, knowledge, { connection: "erp" }));
		assert.ok(ms < BUDGET_MS, `overview took ${ms.toFixed(0)} ms`);
		assert.ok(text.length < 12_000, `overview has ${text.length} characters`);
		assert.match(text, /\n {2}- db0\.art · 500 references · ~120k rows · no comment\n/);
		assert.match(text, /\n… 1954 more tables — use heydb_search$/);
	});

	test("the 600-column table renders fast and stays small by default", () => {
		const { value: text, ms } = timed(() => {
			const incoming = incomingReferences(large, knowledge, "db0.db0.art");
			return renderTable(large.databases[0]!.schemas[0]!.tables[TABLES]!, "db0.db0.art", knowledgeForTable(knowledge, "db0.db0.art"), incoming);
		});
		assert.ok(ms < BUDGET_MS, `table took ${ms.toFixed(0)} ms`);
		assert.ok(text.length < 4_500, `table has ${text.length} characters`);
		assert.match(text, /\nReferencing columns are commented as: "Artículo" ×500\n/);
		assert.match(text, /\n… 485 more name-pattern guesses\n/);
		assert.match(text, /\n… 540 more columns — call heydb_table/);
	});

	test("a search renders fast and answers in about 250 tokens", () => {
		const first = timed(() => searchSchema(large, knowledge, "cliente"));
		assert.ok(first.ms < FIRST_SEARCH_BUDGET_MS, `first search took ${first.ms.toFixed(0)} ms`);
		for (const query of ["articulo", "precio", "articulo precio"]) {
			const { value: text, ms } = timed(() => renderSearch(searchSchema(large, knowledge, query)));
			assert.ok(ms < BUDGET_MS, `${query}: search took ${ms.toFixed(0)} ms`);
			assert.ok(text.length <= 1_000, `${query}: search has ${text.length} characters\n${text}`);
		}
		assert.match(renderSearch(searchSchema(large, knowledge, "precio")), /\n- table db0\.art \(\+3 identical: db1, db2, db3\) · columns: id/);
	});
});
