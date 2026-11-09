import { formatName } from "./names.ts";
import { sortSnapshot } from "./order.ts";
import type { Column, ForeignKey, Index, Routine, Schema, Snapshot, Table, Trigger } from "./snapshot.ts";

// The schema hash says WHETHER the structure changed; the diff says WHAT
// changed. Both must agree: the diff compares exactly the fields hash.ts
// copies into its canonical form, and nothing else (never capture time,
// engine version, row estimates or warnings). If hash.ts gains a field, this
// file must compare it too; a test checks that both always agree.
//
// Objects are matched by name. A renamed column therefore shows up as one
// removed and one added column: the catalog cannot tell a rename from a drop
// plus a create, and a wrong guess would be worse than no guess.

export type ChangeKind = "added" | "removed" | "modified";

export type ChangeObject =
	| "database"
	| "schema"
	| "table"
	| "view"
	| "column"
	| "index"
	| "foreignKey"
	| "trigger"
	| "routine";

export interface Change {
	readonly kind: ChangeKind;
	readonly object: ChangeObject;
	/**
	 * Canonical name of the object. Indexes, foreign keys and triggers belong to a
	 * table, so they are named like a column of it: "shop.shop.orders.idx_customer".
	 */
	readonly target: string;
	/** For modified objects, one line per changed field, e.g. "type: int → bigint". */
	readonly details: readonly string[];
}

export function diffSnapshots(before: Snapshot, after: Snapshot): Change[] {
	const changes: Change[] = [];
	const add = (kind: ChangeKind, object: ChangeObject, target: string, details: readonly string[] = []) =>
		changes.push({ kind, object, target, details });

	// sortSnapshot puts both sides in canonical form first (columns by position,
	// trigger events sorted), so lists compare exactly as the hash sees them.
	const a = sortSnapshot(before);
	const b = sortSnapshot(after);

	matchByKey(a.databases, b.databases, (database) => database.name, {
		added: (database) => add("added", "database", databaseName(database.name)),
		removed: (database) => add("removed", "database", databaseName(database.name)),
		both: (old, current) =>
			matchByKey(old.schemas, current.schemas, (schema) => schema.name, {
				added: (schema) => add("added", "schema", formatName({ database: current.name, schema: schema.name })),
				removed: (schema) => add("removed", "schema", formatName({ database: current.name, schema: schema.name })),
				both: (oldSchema, schema) => diffSchema(current.name, oldSchema, schema, add),
			}),
	});

	return changes.sort(compareChanges);
}

type AddChange = (kind: ChangeKind, object: ChangeObject, target: string, details?: readonly string[]) => void;

function diffSchema(database: string, before: Schema, after: Schema, add: AddChange): void {
	const schema = after.name;
	const tableName = (table: Table) => formatName({ database, schema, table: table.name });

	matchByKey(before.tables, after.tables, (table) => table.name, {
		added: (table) => add("added", table.kind, tableName(table)),
		removed: (table) => add("removed", table.kind, tableName(table)),
		both: (old, current) => diffTable(tableName(current), { database, schema, table: current.name }, old, current, add),
	});

	// MySQL lets a procedure and a function share a name, so the kind is part of
	// the key: a procedure replaced by a function is one removed and one added.
	const routineName = (routine: Routine) => formatName({ database, schema, table: routine.name });
	matchByKey(before.routines, after.routines, (routine) => `${routine.kind}\u0000${routine.name}`, {
		added: (routine) => add("added", "routine", routineName(routine), [routine.kind]),
		removed: (routine) => add("removed", "routine", routineName(routine), [routine.kind]),
		both: () => {},
	});
}

interface TableRef {
	readonly database: string;
	readonly schema: string;
	readonly table: string;
}

function diffTable(target: string, ref: TableRef, before: Table, after: Table, add: AddChange): void {
	const details = present([
		field("kind", before.kind, after.kind),
		field("comment", quote(before.comment), quote(after.comment)),
		field("storage engine", quote(before.storageEngine), quote(after.storageEngine)),
		field("primary key", list(before.primaryKey), list(after.primaryKey)),
		before.viewDefinition === after.viewDefinition ? null : "definition changed",
	]);
	if (details.length > 0) add("modified", after.kind, target, details);

	const childName = (name: string) => formatName({ ...ref, column: name });
	const diffChildren = <T extends { readonly name: string }>(
		object: ChangeObject,
		old: readonly T[],
		current: readonly T[],
		compare: (a: T, b: T) => string[],
	) =>
		matchByKey(old, current, (item) => item.name, {
			added: (item) => add("added", object, childName(item.name)),
			removed: (item) => add("removed", object, childName(item.name)),
			both: (a, b) => {
				const changed = compare(a, b);
				if (changed.length > 0) add("modified", object, childName(b.name), changed);
			},
		});

	diffChildren("column", before.columns, after.columns, compareColumns);
	diffChildren("index", before.indexes, after.indexes, compareIndexes);
	diffChildren("foreignKey", before.foreignKeys, after.foreignKeys, compareForeignKeys);
	diffChildren("trigger", before.triggers, after.triggers, compareTriggers);
}

function compareColumns(a: Column, b: Column): string[] {
	return present([
		field("position", String(a.position), String(b.position)),
		field("type", a.type, b.type),
		field("nullable", String(a.nullable), String(b.nullable)),
		field("default", quote(a.default), quote(b.default)),
		field("comment", quote(a.comment), quote(b.comment)),
		field("auto increment", String(a.autoIncrement), String(b.autoIncrement)),
		field("generated", generated(a.generated), generated(b.generated)),
		field("collation", quote(a.collation), quote(b.collation)),
	]);
}

function compareIndexes(a: Index, b: Index): string[] {
	return present([
		field("columns", list(a.columns), list(b.columns)),
		field("unique", String(a.unique), String(b.unique)),
		field("method", a.method, b.method),
	]);
}

function compareForeignKeys(a: ForeignKey, b: ForeignKey): string[] {
	return present([
		field("columns", list(a.columns), list(b.columns)),
		field("references", references(a), references(b)),
		field("onDelete", a.onDelete, b.onDelete),
		field("onUpdate", a.onUpdate, b.onUpdate),
	]);
}

function compareTriggers(a: Trigger, b: Trigger): string[] {
	return present([field("timing", a.timing, b.timing), field("events", list(a.events), list(b.events))]);
}

// Pairs up two lists by key and calls one handler per key: only in `before`
// (removed), only in `after` (added), or in both. The final sort fixes the order.
function matchByKey<T>(
	before: readonly T[],
	after: readonly T[],
	key: (item: T) => string,
	on: { added: (item: T) => void; removed: (item: T) => void; both: (before: T, after: T) => void },
): void {
	const old = new Map(before.map((item) => [key(item), item]));
	const current = new Map(after.map((item) => [key(item), item]));
	for (const [name, item] of old) {
		const match = current.get(name);
		if (match === undefined) on.removed(item);
		else on.both(item, match);
	}
	for (const [name, item] of current) {
		if (!old.has(name)) on.added(item);
	}
}

/** "name: before → after", or null when both sides print the same. */
function field(name: string, before: string, after: string): string | null {
	return before === after ? null : `${name}: ${before} → ${after}`;
}

function present(details: (string | null)[]): string[] {
	return details.filter((detail) => detail !== null);
}

// Free text is quoted SQL-style so null, "" and the text "NULL" never look alike.
function quote(value: string | null): string {
	return value === null ? "null" : `'${value.replaceAll("'", "''")}'`;
}

function list(items: readonly string[]): string {
	return `(${items.join(", ")})`;
}

function generated(value: Column["generated"]): string {
	return value === null ? "null" : `${value.expression} ${value.stored ? "STORED" : "VIRTUAL"}`;
}

function references(foreignKey: ForeignKey): string {
	const { database, schema, table, columns } = foreignKey.references;
	return `${formatName({ database, schema, table })}${list(columns)}`;
}

// formatName needs at least a schema. Formatting with an empty schema (always
// written as "") and cutting it off reuses its quoting rule for a database alone.
function databaseName(name: string): string {
	return formatName({ database: name, schema: "" }).slice(0, -'.""'.length);
}

function compareChanges(a: Change, b: Change): number {
	return compareText(a.target, b.target) || compareText(a.object, b.object) || compareText(a.kind, b.kind);
}

// Plain code-unit comparison, like byName: the order never depends on the locale.
function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
