import type { Snapshot, Table, Warning } from "./snapshot.ts";

// Ordering rules shared by everything that needs a stable snapshot (the hash,
// the files written to disk):
// - collections whose order carries no meaning are sorted by name (warnings by
//   code, target and message);
// - columns are sorted by their position in the table;
// - lists whose order DOES carry meaning are kept as they are: primary key
//   columns, index columns, foreign key columns.

// Returns a sorted copy; never mutates the input. Plain code-unit comparison
// (not localeCompare) so the result does not depend on the machine's locale.
export function byName<T extends { readonly name: string }>(items: readonly T[]): T[] {
	return [...items].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** A copy of the snapshot with every unordered collection in canonical order. */
export function sortSnapshot(snapshot: Snapshot): Snapshot {
	return {
		...snapshot,
		databases: byName(snapshot.databases).map((database) => ({
			...database,
			schemas: byName(database.schemas).map((schema) => ({
				...schema,
				tables: byName(schema.tables).map(sortTable),
				routines: byName(schema.routines),
			})),
		})),
		warnings: [...snapshot.warnings].sort(compareWarnings),
	};
}

function compareWarnings(a: Warning, b: Warning): number {
	const keyA = `${a.code}\u0000${a.target ?? ""}\u0000${a.message}`;
	const keyB = `${b.code}\u0000${b.target ?? ""}\u0000${b.message}`;
	return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
}

function sortTable(table: Table): Table {
	return {
		...table,
		columns: [...table.columns].sort((a, b) => a.position - b.position),
		indexes: byName(table.indexes),
		foreignKeys: byName(table.foreignKeys),
		triggers: byName(table.triggers).map((trigger) => ({ ...trigger, events: [...trigger.events].sort() })),
	};
}
