import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { saveConfig } from "../../lib/config/store.ts";
import { emptyKnowledge } from "../../lib/knowledge/operations.ts";
import { knowledgePath, loadKnowledge, loadProjectKnowledge, saveKnowledge } from "../../lib/store/knowledge.ts";
import { saveSnapshot } from "../../lib/store/snapshots.ts";
import {
	annotate,
	annotateProject,
	editNote,
	forgetAnnotation,
	forgetProjectNote,
	forgetRelationship,
	orphanedKnowledge,
	projectNotes,
	relate,
	relationshipsFromOtherConnections,
	tableKnowledge,
} from "../../lib/usecases/knowledge.ts";
import { annotation, fixedClock, knowledge, relationship } from "../knowledge/fixtures.ts";
import { column, customersTable, ordersTable, snapshot } from "../fixtures/snapshot.ts";

const roots: string[] = [];

function projectRoot(synced = true): string {
	const root = mkdtempSync(join(tmpdir(), "heydb-knowledge-usecase-"));
	mkdirSync(join(root, ".heydb"));
	roots.push(root);
	if (synced) saveSnapshot(root, "local", snapshot([customersTable(), ordersTable()]));
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ordersToCustomers = {
	from: { table: "shop.shop.orders", columns: ["customer_id"] },
	to: { table: "shop.shop.customers", columns: ["id"] },
	note: "No FK: orders are MyISAM.",
	author: "ana",
};

describe("annotate", () => {
	test("saves notes on a database, a table and a column", () => {
		const root = projectRoot();
		const clock = fixedClock();
		const db = annotate(root, "local", { target: "shop.shop", text: "Main store.", author: "ana" }, clock);
		const table = annotate(root, "local", { target: "shop.shop.orders", text: "One per checkout.", author: "ana" }, clock);
		const col = annotate(root, "local", { target: "shop.shop.orders.total", text: "Includes VAT.", author: "ana" }, clock);
		assert.deepEqual(loadKnowledge(root, "local"), knowledge([db, table, col]));
		assert.equal(col.id, "id-003");
	});

	test("rejects a target that is not in the snapshot, and saves nothing", () => {
		const root = projectRoot();
		for (const target of ["shop.shop.orders.nope", "shop.shop.carts", "legacy.legacy"]) {
			assert.throws(() => annotate(root, "local", { target, text: "x", author: "ana" }, fixedClock()), {
				message: `${target} does not exist in the snapshot of "local"; if it was created recently, run sync first`,
			});
		}
		assert.deepEqual(loadKnowledge(root, "local"), emptyKnowledge());
	});

	test("rejects every annotation before the first sync", () => {
		assert.throws(() => annotate(projectRoot(false), "local", { target: "shop.shop", text: "x", author: "ana" }), {
			message: 'connection "local" was never synced: run sync first',
		});
	});

	test("propagates validation errors from the operation", () => {
		assert.throws(() => annotate(projectRoot(), "local", { target: "shop.shop", text: " ", author: "ana" }), {
			message: "annotation text must not be empty",
		});
	});
});

describe("relate", () => {
	test("saves an implicit foreign key between existing columns", () => {
		const root = projectRoot();
		const added = relate(root, "local", ordersToCustomers, fixedClock());
		assert.deepEqual(added, {
			id: "id-001",
			from: { table: "shop.shop.orders", columns: ["customer_id"] },
			to: { table: "shop.shop.customers", columns: ["id"] },
			note: "No FK: orders are MyISAM.",
			author: "ana",
			createdAt: "2026-11-06T10:00:00.000Z",
		});
		assert.deepEqual(loadKnowledge(root, "local").relationships, [added]);
	});

	test("names the first missing table or column", () => {
		const root = projectRoot();
		const cases: [Partial<typeof ordersToCustomers>, string][] = [
			[{ from: { table: "shop.shop.carts", columns: ["id"] } }, "shop.shop.carts"],
			[{ from: { table: "shop.shop.orders", columns: ["customer_id", "shop_id"] }, to: { table: "shop.shop.customers", columns: ["id", "x"] } }, "shop.shop.orders.shop_id"],
			[{ to: { table: "shop.shop.customers", columns: ["uuid"] } }, "shop.shop.customers.uuid"],
		];
		for (const [change, missing] of cases) {
			assert.throws(() => relate(root, "local", { ...ordersToCustomers, ...change }, fixedClock()), {
				message: `${missing} does not exist in the snapshot of "local"; if it was created recently, run sync first`,
			});
		}
		assert.deepEqual(loadKnowledge(root, "local"), emptyKnowledge());
	});
});

describe("editNote / forgetAnnotation / forgetRelationship", () => {
	test("edit and forget work by id, also on orphaned entries", () => {
		const root = projectRoot();
		const orphanNote = annotation("a1", "shop.shop.orders.legacy_flag");
		const orphanLink = relationship("r1", "shop.shop.carts", ["id"], "shop.shop.orders", ["id"]);
		saveKnowledge(root, "local", knowledge([orphanNote, annotation("a2", "shop.shop.orders")], [orphanLink]));

		const edited = editNote(root, "local", { id: "a1", text: "Was 1 for wholesale." }, fixedClock());
		assert.deepEqual(edited, { ...orphanNote, text: "Was 1 for wholesale.", updatedAt: "2026-11-06T10:00:00.000Z" });
		assert.deepEqual(forgetAnnotation(root, "local", "a1"), edited);
		assert.deepEqual(forgetRelationship(root, "local", "r1"), orphanLink);
		assert.deepEqual(loadKnowledge(root, "local"), knowledge([annotation("a2", "shop.shop.orders")]));
	});

	test("unknown ids leave the file untouched", () => {
		const root = projectRoot();
		saveKnowledge(root, "local", knowledge([annotation("a1", "shop.shop")]));
		const before = readFileSync(knowledgePath(root, "local"), "utf8");
		assert.throws(() => forgetAnnotation(root, "local", "nope"), { message: 'unknown annotation id "nope"' });
		assert.throws(() => forgetRelationship(root, "local", "nope"), { message: 'unknown relationship id "nope"' });
		assert.throws(() => editNote(root, "local", { id: "nope", text: "x" }), { message: 'unknown annotation id "nope"' });
		assert.equal(readFileSync(knowledgePath(root, "local"), "utf8"), before);
	});
});

describe("tableKnowledge", () => {
	test("returns database, table and column notes plus relationships (v1 only returned table notes)", () => {
		const root = projectRoot();
		const clock = fixedClock();
		const db = annotate(root, "local", { target: "shop.shop", text: "Main store.", author: "ana" }, clock);
		const table = annotate(root, "local", { target: "shop.shop.orders", text: "One per checkout.", author: "ana" }, clock);
		const col = annotate(root, "local", { target: "shop.shop.orders.total", text: "Includes VAT.", author: "ana" }, clock);
		annotate(root, "local", { target: "shop.shop.customers", text: "Other table.", author: "ana" }, clock);
		const link = relate(root, "local", ordersToCustomers, clock);
		assert.deepEqual(tableKnowledge(root, "local", "shop.shop.orders"), {
			database: [db],
			table: [table],
			columns: { total: [col] },
			relationships: [link],
		});
	});

	test("is empty when nothing was annotated yet", () => {
		assert.deepEqual(tableKnowledge(projectRoot(false), "local", "shop.shop.orders"), {
			database: [],
			table: [],
			columns: {},
			relationships: [],
		});
	});
});

describe("orphanedKnowledge", () => {
	test("reports knowledge about a dropped column after a sync, and keeps it in the file", () => {
		const root = projectRoot();
		const clock = fixedClock();
		const col = annotate(root, "local", { target: "shop.shop.orders.total", text: "Includes VAT.", author: "ana" }, clock);
		annotate(root, "local", { target: "shop.shop.orders", text: "One per checkout.", author: "ana" }, clock);
		saveSnapshot(root, "local", snapshot([customersTable(), ordersTable({ columns: [column("id", 1), column("customer_id", 2)] })]));
		const before = readFileSync(knowledgePath(root, "local"), "utf8");
		assert.deepEqual(orphanedKnowledge(root, "local"), { annotations: [col], relationships: [] });
		assert.equal(readFileSync(knowledgePath(root, "local"), "utf8"), before);
	});

	test("needs a snapshot to compare with", () => {
		assert.throws(() => orphanedKnowledge(projectRoot(false), "local"), {
			message: 'connection "local" was never synced: run sync first',
		});
	});
});

// Two connections: "local" (shop) and "erp", whose cus table holds the customer codes.
const cus = { ...customersTable(), name: "cus", columns: [column("cod", 1), column("nombre", 2)] };
const erpSnapshot = snapshot([], { databases: [{ name: "erp", schemas: [{ name: "erp", tables: [cus], routines: [] }] }] });
const connection = { engine: "mysql" as const, host: "127.0.0.1", port: 3306, user: "root", databases: null };

function twoConnections({ erpSynced = true } = {}): string {
	const root = projectRoot();
	saveConfig(root, {
		formatVersion: 1,
		defaultConnection: "local",
		connections: {
			local: { ...connection, password: "env:HEYDB_LOCAL_PASSWORD" },
			erp: { ...connection, password: "env:HEYDB_ERP_PASSWORD" },
		},
	});
	if (erpSynced) saveSnapshot(root, "erp", erpSnapshot);
	return root;
}

const customersToErp = {
	from: { table: "shop.shop.customers", columns: ["id"] },
	to: { connection: "erp", table: "erp.erp.cus", columns: ["cod"] },
	note: "Same customer code in both.",
	author: "ana",
};

describe("relate across connections", () => {
	test("stores the relationship in the from connection's file, naming the other connection", () => {
		const root = twoConnections();
		const link = relate(root, "local", customersToErp, fixedClock());
		assert.deepEqual(link.to, { connection: "erp", table: "erp.erp.cus", columns: ["cod"] });
		assert.deepEqual(loadKnowledge(root, "local").relationships, [link]);
		assert.deepEqual(loadKnowledge(root, "erp"), emptyKnowledge());
	});

	test("a to.connection naming the from connection is a plain relationship", () => {
		const root = twoConnections();
		const link = relate(root, "local", { ...ordersToCustomers, to: { ...ordersToCustomers.to, connection: "local" } }, fixedClock());
		assert.equal("connection" in link.to, false);
	});

	test("refuses an unknown connection, naming the configured ones", () => {
		const root = twoConnections();
		assert.throws(() => relate(root, "local", { ...customersToErp, to: { ...customersToErp.to, connection: "crm" } }, fixedClock()), {
			message: 'unknown connection "crm"; configured: erp, local',
		});
		assert.deepEqual(loadKnowledge(root, "local"), emptyKnowledge());
	});

	test("refuses a connection that was never synced", () => {
		const root = twoConnections({ erpSynced: false });
		assert.throws(() => relate(root, "local", customersToErp, fixedClock()), {
			message: 'connection "erp" was never synced: run sync first',
		});
		assert.deepEqual(loadKnowledge(root, "local"), emptyKnowledge());
	});

	test("checks each side against its own connection's snapshot", () => {
		const root = twoConnections();
		assert.throws(() => relate(root, "local", { ...customersToErp, to: { ...customersToErp.to, columns: ["codigo"] } }, fixedClock()), {
			message: 'erp.erp.cus.codigo does not exist in the snapshot of "erp"; if it was created recently, run sync first',
		});
		// shop.shop.customers exists in local, not in erp.
		assert.throws(() => relate(root, "local", { ...customersToErp, to: { ...customersToErp.from, connection: "erp" } }, fixedClock()), {
			message: 'shop.shop.customers does not exist in the snapshot of "erp"; if it was created recently, run sync first',
		});
		assert.deepEqual(loadKnowledge(root, "local"), emptyKnowledge());
	});

	test("refuses a from side in another connection: the relationship is stored with its from side", () => {
		const root = twoConnections();
		assert.throws(() => relate(root, "local", { ...customersToErp, from: { ...customersToErp.from, connection: "erp" } }, fixedClock()), {
			message: 'a relationship is stored in its "from" connection: relate it from connection "erp"',
		});
	});
});

describe("relationshipsFromOtherConnections", () => {
	test("finds relationships stored in other connections' files that point to the table", () => {
		const root = twoConnections();
		const link = relate(root, "local", customersToErp, fixedClock());
		assert.deepEqual(relationshipsFromOtherConnections(root, "erp", "erp.erp.cus"), {
			relationships: [{ connection: "local", relationship: link }],
			unreadable: [],
		});
		assert.deepEqual(relationshipsFromOtherConnections(root, "local", "erp.erp.cus"), { relationships: [], unreadable: [] });
	});

	test("reports an unreadable file instead of failing", () => {
		const root = twoConnections();
		relate(root, "local", customersToErp, fixedClock());
		writeFileSync(knowledgePath(root, "crm"), "{");
		const result = relationshipsFromOtherConnections(root, "erp", "erp.erp.cus");
		assert.equal(result.relationships.length, 1);
		assert.deepEqual(result.unreadable, [`knowledge/crm.json is not valid JSON (${knowledgePath(root, "crm")})`]);
	});
});

describe("orphanedKnowledge across connections", () => {
	test("reports a relationship whose other side's column was dropped, and keeps it", () => {
		const root = twoConnections();
		const link = relate(root, "local", customersToErp, fixedClock());
		assert.deepEqual(orphanedKnowledge(root, "local"), { annotations: [], relationships: [] });
		saveSnapshot(root, "erp", snapshot([], { databases: [{ name: "erp", schemas: [{ name: "erp", tables: [{ ...cus, columns: [column("id", 1)] }], routines: [] }] }] }));
		const before = readFileSync(knowledgePath(root, "local"), "utf8");
		assert.deepEqual(orphanedKnowledge(root, "local"), { annotations: [], relationships: [link] });
		assert.equal(readFileSync(knowledgePath(root, "local"), "utf8"), before);
	});

	test("reports a relationship whose other connection is gone", () => {
		const root = twoConnections();
		const link = relate(root, "local", customersToErp, fixedClock());
		saveConfig(root, { formatVersion: 1, defaultConnection: "local", connections: { local: { ...connection, password: "env:HEYDB_LOCAL_PASSWORD" } } });
		assert.deepEqual(orphanedKnowledge(root, "local").relationships, [link]);
	});
});

describe("project notes", () => {
	test("annotateProject saves a note about the whole project, without any snapshot", () => {
		const root = projectRoot(false);
		const note = annotateProject(root, { text: "One database per client; the central one is acme.", author: "ana" }, fixedClock());
		assert.equal(note.target, "project");
		assert.deepEqual(projectNotes(root), [note]);
		assert.deepEqual(loadProjectKnowledge(root).annotations, [note]);
	});

	test("editNote finds a project note by id from any connection, and keeps its author", () => {
		const root = projectRoot();
		const clock = fixedClock();
		const note = annotateProject(root, { text: "Old.", author: "ana" }, clock);
		const edited = editNote(root, "local", { id: note.id, text: "New." }, clock);
		assert.deepEqual(edited, { ...note, text: "New.", updatedAt: "2026-11-06T10:00:01.000Z" });
		assert.deepEqual(projectNotes(root), [edited]);
		assert.throws(() => editNote(root, "local", { id: "nope", text: "x" }, clock), { message: 'unknown annotation id "nope"' });
	});

	test("forgetProjectNote removes it", () => {
		const root = projectRoot(false);
		const note = annotateProject(root, { text: "x", author: "ana" }, fixedClock());
		assert.deepEqual(forgetProjectNote(root, note.id), note);
		assert.deepEqual(projectNotes(root), []);
	});
});
