import type {
	Column,
	Database,
	EngineKind,
	ForeignKey,
	GeneratedColumn,
	Index,
	ReferentialAction,
	Routine,
	Schema,
	Snapshot,
	Table,
	TableKind,
	Trigger,
	Warning,
} from "./snapshot.ts";

// Snapshot files come from disk, and .heydb/ is committed: a teammate's old
// heydb, a bad merge or a hand edit can put anything in them. TypeScript types
// vanish at runtime, so this checks every field of every object once, at the
// boundary, and the rest of heydb can trust the Snapshot type.
//
// The result is built field by field from the input, so unknown fields are
// dropped and never written back. Errors name the exact path of the first bad
// value, e.g. "databases[0].schemas[0].tables[2].columns[1].nullable must be a boolean".

const ENGINE_KINDS: readonly EngineKind[] = ["mysql", "mariadb", "postgresql"];
const TABLE_KINDS: readonly TableKind[] = ["table", "view"];
const ROUTINE_KINDS: readonly Routine["kind"][] = ["procedure", "function"];
const REFERENTIAL_ACTIONS: readonly ReferentialAction[] = ["CASCADE", "SET NULL", "SET DEFAULT", "RESTRICT", "NO ACTION"];
const TRIGGER_TIMINGS: readonly Trigger["timing"][] = ["BEFORE", "AFTER", "INSTEAD OF"];
const TRIGGER_EVENTS: readonly Trigger["events"][number][] = ["INSERT", "UPDATE", "DELETE", "TRUNCATE"];

export function validateSnapshot(data: unknown): Snapshot {
	const root = object(data, "snapshot");
	const at = reader(root, "");
	if (at.value("formatVersion") !== 1) throw new Error("formatVersion must be 1");
	const engine = at.object("engine");
	return {
		formatVersion: 1,
		engine: {
			kind: engine.oneOf("kind", ENGINE_KINDS),
			version: engine.string("version"),
		},
		capturedAt: at.string("capturedAt"),
		databases: at.list("databases", validateDatabase),
		warnings: at.list("warnings", validateWarning),
	};
}

function validateDatabase(at: Reader): Database {
	return { name: at.string("name"), schemas: at.list("schemas", validateSchema) };
}

function validateSchema(at: Reader): Schema {
	return {
		name: at.string("name"),
		tables: at.list("tables", validateTable),
		routines: at.list("routines", (routine) => ({
			name: routine.string("name"),
			kind: routine.oneOf("kind", ROUTINE_KINDS),
		})),
	};
}

function validateTable(at: Reader): Table {
	return {
		name: at.string("name"),
		kind: at.oneOf("kind", TABLE_KINDS),
		comment: at.string("comment"),
		storageEngine: at.stringOrNull("storageEngine"),
		rowEstimate: at.countOrNull("rowEstimate"),
		columns: at.list("columns", validateColumn),
		primaryKey: at.strings("primaryKey"),
		indexes: at.list("indexes", validateIndex),
		foreignKeys: at.list("foreignKeys", validateForeignKey),
		triggers: at.list("triggers", validateTrigger),
		viewDefinition: at.stringOrNull("viewDefinition"),
	};
}

function validateColumn(at: Reader): Column {
	return {
		name: at.string("name"),
		position: at.position("position"),
		type: at.string("type"),
		nullable: at.boolean("nullable"),
		default: at.stringOrNull("default"),
		comment: at.string("comment"),
		autoIncrement: at.boolean("autoIncrement"),
		generated: at.objectOrNull("generated", validateGenerated),
		collation: at.stringOrNull("collation"),
	};
}

function validateGenerated(at: Reader): GeneratedColumn {
	return { expression: at.string("expression"), stored: at.boolean("stored") };
}

function validateIndex(at: Reader): Index {
	return {
		name: at.string("name"),
		columns: at.strings("columns"),
		unique: at.boolean("unique"),
		method: at.string("method"),
	};
}

function validateForeignKey(at: Reader): ForeignKey {
	const references = at.object("references");
	return {
		name: at.string("name"),
		columns: at.strings("columns"),
		references: {
			database: references.string("database"),
			schema: references.string("schema"),
			table: references.string("table"),
			columns: references.strings("columns"),
		},
		onDelete: at.oneOf("onDelete", REFERENTIAL_ACTIONS),
		onUpdate: at.oneOf("onUpdate", REFERENTIAL_ACTIONS),
	};
}

function validateTrigger(at: Reader): Trigger {
	return {
		name: at.string("name"),
		timing: at.oneOf("timing", TRIGGER_TIMINGS),
		events: at.values("events", (value, path) => oneOf(value, path, TRIGGER_EVENTS)),
	};
}

function validateWarning(at: Reader): Warning {
	const target = at.value("target");
	if (target !== undefined && typeof target !== "string") {
		throw new Error(`${at.path("target")} must be a string when present`);
	}
	return {
		code: at.string("code"),
		message: at.string("message"),
		// Absent stays absent: an optional field is never written as undefined.
		...(target !== undefined && { target }),
	};
}

// A Reader reads the fields of one JSON object and knows its path, so every
// check can name exactly where the bad value is.
interface Reader {
	path(key: string): string;
	value(key: string): unknown;
	string(key: string): string;
	stringOrNull(key: string): string | null;
	boolean(key: string): boolean;
	position(key: string): number;
	countOrNull(key: string): number | null;
	oneOf<T extends string>(key: string, allowed: readonly T[]): T;
	strings(key: string): string[];
	object(key: string): Reader;
	objectOrNull<T>(key: string, read: (at: Reader) => T): T | null;
	/** A list of objects. */
	list<T>(key: string, read: (at: Reader) => T): T[];
	/** A list of plain values. */
	values<T>(key: string, read: (value: unknown, path: string) => T): T[];
}

function reader(record: Record<string, unknown>, prefix: string): Reader {
	const path = (key: string) => (prefix === "" ? key : `${prefix}.${key}`);
	// Every typed read goes through here: a missing field gets its own message,
	// because "is missing" points at an old file, "must be" at a damaged one.
	const read = (key: string): unknown => {
		if (!(key in record)) throw new Error(`${path(key)} is missing`);
		return record[key];
	};
	const fail = (key: string, expected: string): never => {
		throw new Error(`${path(key)} must be ${expected}`);
	};
	const values = <T>(key: string, readItem: (value: unknown, path: string) => T): T[] => {
		const value = read(key);
		if (!Array.isArray(value)) return fail(key, "a list");
		return value.map((item, index) => readItem(item, `${path(key)}[${index}]`));
	};

	return {
		path,
		value: (key) => record[key],
		string(key) {
			const value = read(key);
			return typeof value === "string" ? value : fail(key, "a string");
		},
		stringOrNull(key) {
			const value = read(key);
			return value === null || typeof value === "string" ? value : fail(key, "a string or null");
		},
		boolean(key) {
			const value = read(key);
			return typeof value === "boolean" ? value : fail(key, "a boolean");
		},
		position(key) {
			const value = read(key);
			return Number.isInteger(value) && (value as number) > 0 ? (value as number) : fail(key, "a positive integer");
		},
		countOrNull(key) {
			const value = read(key);
			if (value === null) return null;
			return Number.isInteger(value) && (value as number) >= 0
				? (value as number)
				: fail(key, "a non-negative integer or null");
		},
		oneOf: (key, allowed) => oneOf(read(key), path(key), allowed),
		strings(key) {
			return values(key, (value, itemPath) => {
				if (typeof value !== "string") throw new Error(`${itemPath} must be a string`);
				return value;
			});
		},
		object: (key) => reader(object(read(key), path(key)), path(key)),
		objectOrNull(key, readValue) {
			const value = read(key);
			if (value === null) return null;
			if (!isRecord(value)) return fail(key, "an object or null");
			return readValue(reader(value, path(key)));
		},
		list: (key, readItem) => values(key, (item, itemPath) => readItem(reader(object(item, itemPath), itemPath))),
		values,
	};
}

function object(value: unknown, path: string): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`${path} must be an object`);
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
	if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
	throw new Error(`${path} must be one of ${allowed.map((item) => JSON.stringify(item)).join(", ")}`);
}
