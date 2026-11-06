import { createHash } from "node:crypto";

import { sortSnapshot } from "./order.ts";
import type { Column, Database, ForeignKey, Index, Schema, Snapshot, Table } from "./snapshot.ts";

// The schema hash is a fingerprint of the STRUCTURE only. Two captures of an
// unchanged database must produce the same hash on any machine, so the
// canonical form:
//
// 1. Copies fields explicitly (a whitelist). Anything not listed here — capture
//    time, engine version, row estimates, warnings — never affects the hash,
//    even if a future engine adapter adds new fields.
// 2. Sorts first with sortSnapshot (order.ts), the same rules the snapshot
//    files use: unordered collections by name, columns by position, and
//    meaningful lists (key and index columns) untouched.
//
// Changing this canonical form changes every hash: treat it as a breaking change.

export function schemaHash(snapshot: Snapshot): string {
	const canonical = sortSnapshot(snapshot).databases.map(canonicalDatabase);
	const digest = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
	return `sha256:${digest}`;
}

function canonicalDatabase(database: Database) {
	return { name: database.name, schemas: database.schemas.map(canonicalSchema) };
}

function canonicalSchema(schema: Schema) {
	return {
		name: schema.name,
		tables: schema.tables.map(canonicalTable),
		routines: schema.routines.map((routine) => ({ name: routine.name, kind: routine.kind })),
	};
}

function canonicalTable(table: Table) {
	return {
		name: table.name,
		kind: table.kind,
		comment: table.comment,
		storageEngine: table.storageEngine,
		columns: table.columns.map(canonicalColumn),
		primaryKey: [...table.primaryKey],
		indexes: table.indexes.map(canonicalIndex),
		foreignKeys: table.foreignKeys.map(canonicalForeignKey),
		triggers: table.triggers.map((trigger) => ({
			name: trigger.name,
			timing: trigger.timing,
			events: [...trigger.events],
		})),
		viewDefinition: table.viewDefinition,
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
