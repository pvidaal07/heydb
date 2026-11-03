import { createHash } from "node:crypto";

import type { Column, Database, ForeignKey, Index, Schema, Snapshot, Table } from "./snapshot.ts";

// The schema hash is a fingerprint of the STRUCTURE only. Two captures of an
// unchanged database must produce the same hash on any machine, so the
// canonical form:
//
// 1. Copies fields explicitly (a whitelist). Anything not listed here — capture
//    time, engine version, row estimates, warnings — never affects the hash,
//    even if a future engine adapter adds new fields.
// 2. Sorts collections whose order carries no meaning (databases, tables,
//    indexes…) by name, and columns by their position.
// 3. Keeps the order that DOES carry meaning: primary key columns, index
//    columns and foreign key columns.
//
// Changing this canonical form changes every hash: treat it as a breaking change.

export function schemaHash(snapshot: Snapshot): string {
	const canonical = byName(snapshot.databases).map(canonicalDatabase);
	const digest = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
	return `sha256:${digest}`;
}

function canonicalDatabase(database: Database) {
	return { name: database.name, schemas: byName(database.schemas).map(canonicalSchema) };
}

function canonicalSchema(schema: Schema) {
	return {
		name: schema.name,
		tables: byName(schema.tables).map(canonicalTable),
		routines: byName(schema.routines).map((routine) => ({ name: routine.name, kind: routine.kind })),
	};
}

function canonicalTable(table: Table) {
	return {
		name: table.name,
		kind: table.kind,
		comment: table.comment,
		storageEngine: table.storageEngine,
		columns: [...table.columns].sort((a, b) => a.position - b.position).map(canonicalColumn),
		primaryKey: [...table.primaryKey],
		indexes: byName(table.indexes).map(canonicalIndex),
		foreignKeys: byName(table.foreignKeys).map(canonicalForeignKey),
		triggers: byName(table.triggers).map((trigger) => ({
			name: trigger.name,
			timing: trigger.timing,
			events: [...trigger.events].sort(),
		})),
	};
}

function canonicalColumn(column: Column) {
	return {
		name: column.name,
		position: column.position,
		type: column.type,
		nullable: column.nullable,
		default: column.default,
		comment: column.comment,
		autoIncrement: column.autoIncrement,
		generated: column.generated && { expression: column.generated.expression, stored: column.generated.stored },
		collation: column.collation,
	};
}

function canonicalIndex(index: Index) {
	return { name: index.name, columns: [...index.columns], unique: index.unique, method: index.method };
}

function canonicalForeignKey(foreignKey: ForeignKey) {
	const { references } = foreignKey;
	return {
		name: foreignKey.name,
		columns: [...foreignKey.columns],
		references: {
			database: references.database,
			schema: references.schema,
			table: references.table,
			columns: [...references.columns],
		},
		onDelete: foreignKey.onDelete,
		onUpdate: foreignKey.onUpdate,
	};
}

// Returns a sorted copy; never mutates the snapshot. Plain code-unit comparison
// (not localeCompare) so the result does not depend on the machine's locale.
function byName<T extends { readonly name: string }>(items: readonly T[]): T[] {
	return [...items].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
