import { formatName, parseName } from "../model/names.ts";
import { canonicalTable } from "./operations.ts";
import { type Annotation, type Knowledge, PROJECT_TARGET, type Relationship, type RelationshipSide } from "./types.ts";

// Knowledge files are committed and edited by people, merges and older
// heydb versions, so every field is checked once, at the boundary, like
// snapshots are in lib/model/validate.ts. The result is rebuilt field by field:
// unknown fields are dropped and names come back in canonical form. Errors
// name the exact path, e.g. "relationships[0].to.columns must not be empty".
//
// This file has its own small reader because the one in lib/model/validate.ts
// is private to that module; sharing one is a follow-up.

export function validateKnowledge(data: unknown): Knowledge {
	return validate(data, (target, path) => canonical(target, path, (name) => formatName(parseName(name))));
}

/**
 * The project file: the same shape, but only notes about the whole project.
 * A note on a database there would be found by nobody looking at that
 * database, and relationships always belong to a connection.
 */
export function validateProjectKnowledge(data: unknown): Knowledge {
	const knowledge = validate(data, (target, path) => {
		if (target !== PROJECT_TARGET) throw new Error(`${path} must be "${PROJECT_TARGET}" in the project file: got "${target}"`);
		return target;
	});
	if (knowledge.relationships.length > 0) throw new Error("relationships must be empty: the project file holds only project notes");
	return knowledge;
}

type TargetReader = (target: string, path: string) => string;

function validate(data: unknown, readTarget: TargetReader): Knowledge {
	const root = object(data, "knowledge");
	if (root.formatVersion !== 1) throw new Error("formatVersion must be 1");
	const annotations = list(root, "annotations", (record, path) => validateAnnotation(record, path, readTarget));
	const relationships = list(root, "relationships", validateRelationship);
	unique(annotations, "annotations");
	unique(relationships, "relationships");
	return { formatVersion: 1, annotations, relationships };
}

function validateAnnotation(record: Record<string, unknown>, path: string, readTarget: TargetReader): Annotation {
	const target = string(record, "target", path);
	return {
		id: id(record, path),
		target: readTarget(target, `${path}.target`),
		text: string(record, "text", path),
		author: string(record, "author", path),
		createdAt: string(record, "createdAt", path),
		updatedAt: string(record, "updatedAt", path),
	};
}

function validateRelationship(record: Record<string, unknown>, path: string): Relationship {
	const from = side(record, "from", path);
	const to = side(record, "to", path);
	if (to.columns.length !== from.columns.length) {
		throw new Error(`${path}.to.columns must have as many columns as from.columns (${from.columns.length})`);
	}
	return {
		id: id(record, path),
		from,
		to,
		note: string(record, "note", path),
		author: string(record, "author", path),
		createdAt: string(record, "createdAt", path),
	};
}

function side(parent: Record<string, unknown>, key: "from" | "to", parentPath: string): RelationshipSide {
	const path = `${parentPath}.${key}`;
	const record = object(read(parent, key, parentPath), path);
	const name = string(record, "table", path);
	const table = canonical(name, `${path}.table`, canonicalTable);
	if (table === null) {
		throw new Error(`${path}.table must be a table name (database.schema.table): got "${name}"`);
	}
	const columns = read(record, "columns", path);
	if (!Array.isArray(columns)) throw new Error(`${path}.columns must be a list`);
	if (columns.length === 0) throw new Error(`${path}.columns must not be empty`);
	// Optional: files written before relationships could cross connections have none.
	const connection = record.connection;
	if (connection !== undefined && (typeof connection !== "string" || connection === "")) {
		throw new Error(`${path}.connection must be a non-empty string`);
	}
	return {
		...(connection !== undefined && { connection }),
		table,
		columns: columns.map((column, index) => {
			if (typeof column !== "string") throw new Error(`${path}.columns[${index}] must be a string`);
			return column;
		}),
	};
}

// Prefixes parseName's own message with the path, so it is clear which entry is bad.
function canonical<T>(name: string, path: string, convert: (name: string) => T): T {
	try {
		return convert(name);
	} catch (error) {
		throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
}

function id(record: Record<string, unknown>, path: string): string {
	const value = string(record, "id", path);
	if (value === "") throw new Error(`${path}.id must not be empty`);
	return value;
}

// Edits and removals find entries by id; a bad merge that duplicates one
// would make them touch the wrong entry.
function unique(items: readonly { readonly id: string }[], path: string): void {
	const seen = new Map<string, number>();
	items.forEach((item, index) => {
		const first = seen.get(item.id);
		if (first !== undefined) throw new Error(`${path}[${index}].id "${item.id}" is already used by ${path}[${first}]`);
		seen.set(item.id, index);
	});
}

function list<T>(record: Record<string, unknown>, key: string, readItem: (item: Record<string, unknown>, path: string) => T): T[] {
	const value = read(record, key, "");
	if (!Array.isArray(value)) throw new Error(`${key} must be a list`);
	return value.map((item, index) => {
		const path = `${key}[${index}]`;
		return readItem(object(item, path), path);
	});
}

function string(record: Record<string, unknown>, key: string, path: string): string {
	const value = read(record, key, path);
	if (typeof value !== "string") throw new Error(`${join(path, key)} must be a string`);
	return value;
}

function read(record: Record<string, unknown>, key: string, path: string): unknown {
	if (!(key in record)) throw new Error(`${join(path, key)} is missing`);
	return record[key];
}

function join(path: string, key: string): string {
	return path === "" ? key : `${path}.${key}`;
}

function object(value: unknown, path: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
	return value as Record<string, unknown>;
}
