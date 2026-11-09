import { formatName, parseName } from "../model/names.ts";
import type { Snapshot } from "../model/snapshot.ts";
import { canonicalTable } from "./operations.ts";
import type { Annotation, Knowledge, Relationship, RelationshipSide } from "./types.ts";

// Pure reads over Knowledge. Nothing here changes or deletes an entry.

/** Everything known about one table, at every level that applies to it. */
export interface TableKnowledge {
	/** Notes on the table's database (target "db.schema"). */
	readonly database: readonly Annotation[];
	readonly table: readonly Annotation[];
	/** Notes per column name; only columns that have notes appear. */
	readonly columns: Readonly<Record<string, readonly Annotation[]>>;
	/** Implicit foreign keys where the table is on either side. */
	readonly relationships: readonly Relationship[];
}

/** A relationship read from another connection's knowledge file. */
export interface ExternalRelationship {
	/** The connection whose file stores it; its sides without a connection are tables of that one. */
	readonly connection: string;
	readonly relationship: Relationship;
}

/**
 * Returns database, table and column notes together. heydb v1 only returned
 * table notes, so an agent asked to annotate columns could never read them back.
 */
export function knowledgeForTable(knowledge: Knowledge, tableName: string): TableKnowledge {
	const table = canonicalTable(tableName);
	if (table === null) throw new Error(`expected a table name (database.schema.table): got "${tableName}"`);
	const ref = parseName(table);

	const database: Annotation[] = [];
	const tableNotes: Annotation[] = [];
	// A Map, not a plain object: a legacy column called "__proto__" must still be a normal key.
	const columns = new Map<string, Annotation[]>();
	for (const annotation of knowledge.annotations) {
		// Compared segment by segment, never by prefix: "shop.shop.orders" is
		// not a prefix match for "shop.shop.orders_archive".
		const target = parseName(annotation.target);
		if (target.database !== ref.database || target.schema !== ref.schema) continue;
		if (target.table === undefined) database.push(annotation);
		else if (target.table !== ref.table) continue;
		else if (target.column === undefined) tableNotes.push(annotation);
		else columns.set(target.column, [...(columns.get(target.column) ?? []), annotation]);
	}

	return {
		database,
		table: tableNotes,
		columns: Object.fromEntries(columns),
		// A side in another connection is never a table of this one, even with the same name.
		relationships: knowledge.relationships.filter((item) => isHere(item.from, table) || isHere(item.to, table)),
	};
}

/**
 * The relationships of a knowledge file that point to `table` of another
 * connection, `connection`: crm's file stores crm.clientes(cod_erp) → erp's
 * gcl(cod), and erp's gcl must show it.
 */
export function relationshipsInto(knowledge: Knowledge, connection: string, table: string): Relationship[] {
	const into = (side: RelationshipSide) => side.connection === connection && side.table === table;
	return knowledge.relationships.filter((item) => into(item.from) || into(item.to));
}

function isHere(side: RelationshipSide, table: string): boolean {
	return side.connection === undefined && side.table === table;
}

export interface Orphans {
	readonly annotations: readonly Annotation[];
	readonly relationships: readonly Relationship[];
}

/** Answers "does this canonical name exist?" for one snapshot. */
export type Lookup = (name: string) => boolean;

/** The lookup of another connection, or null when it is gone or was never synced. */
export type OtherConnections = (connection: string) => Lookup | null;

/**
 * Knowledge whose database, table or column is no longer in the snapshot.
 * Only reported, never deleted: a note on a dropped column may still be the
 * only explanation of old rows, backups or the code that used it.
 *
 * A side in another connection is checked against `others`: a relationship
 * whose other connection is gone or unsynced is reported too. Without
 * `others`, those sides are not checked.
 */
export function findOrphans(knowledge: Knowledge, snapshot: Snapshot, others?: OtherConnections): Orphans {
	const exists = snapshotLookup(snapshot);
	const missing = (side: RelationshipSide): boolean => {
		if (side.connection === undefined) return missingInSide(side, exists) !== null;
		if (others === undefined) return false;
		const lookup = others(side.connection);
		return lookup === null || missingInSide(side, lookup) !== null;
	};
	return {
		annotations: knowledge.annotations.filter((annotation) => !exists(annotation.target)),
		relationships: knowledge.relationships.filter((relationship) => missing(relationship.from) || missing(relationship.to)),
	};
}

/** Answers "does this canonical name exist in the snapshot?" for databases, tables and columns. */
export function snapshotLookup(snapshot: Snapshot): Lookup {
	const names = new Set<string>();
	for (const database of snapshot.databases) {
		for (const schema of database.schemas) {
			const base = { database: database.name, schema: schema.name };
			names.add(formatName(base));
			for (const table of schema.tables) {
				names.add(formatName({ ...base, table: table.name }));
				for (const column of table.columns) names.add(formatName({ ...base, table: table.name, column: column.name }));
			}
		}
	}
	// Re-formatting the parsed name accepts any valid spelling of it.
	return (name) => names.has(formatName(parseName(name)));
}

/** The table, or else the first column, of one relationship side missing from a snapshot; null when all exist. */
export function missingInSide(side: RelationshipSide, exists: Lookup): string | null {
	const ref = parseName(side.table);
	const names = [side.table, ...side.columns.map((column) => formatName({ ...ref, column }))];
	return names.find((name) => !exists(name)) ?? null;
}
