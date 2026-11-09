import { randomUUID } from "node:crypto";

import { formatName, parseName } from "../model/names.ts";
import { type Annotation, type Knowledge, PROJECT_TARGET, type Relationship, type RelationshipSide } from "./types.ts";

// Pure operations on Knowledge: each returns a new value and never mutates its
// input, so a failed validation can never leave half-applied changes behind,
// and callers decide when (and whether) to save.
//
// Entries are kept sorted, so the file written to disk depends only on its
// content, never on the order in which notes were added. That keeps git diffs
// small and lets two people annotating different objects merge line by line.

/** Long enough for a real explanation, short enough to keep the file reviewable. */
export const MAX_TEXT_LENGTH = 4000;

/**
 * Where time and ids come from. Production uses the real clock and random
 * UUIDs; tests pass fixed sequences so every result can be compared exactly.
 */
export interface KnowledgeOptions {
	readonly now?: () => string;
	readonly newId?: () => string;
}

const realClock = (): string => new Date().toISOString();

export interface AnnotationInput {
	readonly target: string;
	readonly text: string;
	readonly author: string;
}

export interface RelationshipInput {
	readonly from: RelationshipSide;
	readonly to: RelationshipSide;
	/** Why the relationship exists or how it was found; may be empty. */
	readonly note: string;
	readonly author: string;
}

export function emptyKnowledge(): Knowledge {
	return { formatVersion: 1, annotations: [], relationships: [] };
}

export function addAnnotation(
	knowledge: Knowledge,
	input: AnnotationInput,
	options: KnowledgeOptions = {},
): { knowledge: Knowledge; annotation: Annotation } {
	// Stored in canonical form, so '"shop".shop' and 'shop.shop' are the same target.
	return withAnnotation(knowledge, formatName(parseName(input.target)), input, options);
}

/** A note about the whole project, for the project file; it has no target to resolve. */
export function addProjectNote(
	knowledge: Knowledge,
	input: Omit<AnnotationInput, "target">,
	options: KnowledgeOptions = {},
): { knowledge: Knowledge; annotation: Annotation } {
	return withAnnotation(knowledge, PROJECT_TARGET, input, options);
}

function withAnnotation(
	knowledge: Knowledge,
	target: string,
	input: Omit<AnnotationInput, "target">,
	options: KnowledgeOptions,
): { knowledge: Knowledge; annotation: Annotation } {
	const { now = realClock, newId = randomUUID } = options;
	const text = cleanText(input.text, "annotation text", { allowEmpty: false });
	const author = cleanAuthor(input.author);
	const timestamp = now();
	const annotation: Annotation = { id: newId(), target, text, author, createdAt: timestamp, updatedAt: timestamp };
	return { knowledge: withEntries(knowledge, [...knowledge.annotations, annotation]), annotation };
}

/** Replaces the text of a note. Who wrote it and when stay as they were. */
export function editAnnotation(
	knowledge: Knowledge,
	id: string,
	text: string,
	options: KnowledgeOptions = {},
): { knowledge: Knowledge; annotation: Annotation } {
	const { now = realClock } = options;
	const existing = findById(knowledge.annotations, id, "annotation");
	const annotation: Annotation = { ...existing, text: cleanText(text, "annotation text", { allowEmpty: false }), updatedAt: now() };
	const annotations = knowledge.annotations.map((item) => (item.id === id ? annotation : item));
	return { knowledge: withEntries(knowledge, annotations), annotation };
}

export function removeAnnotation(knowledge: Knowledge, id: string): { knowledge: Knowledge; annotation: Annotation } {
	const annotation = findById(knowledge.annotations, id, "annotation");
	const annotations = knowledge.annotations.filter((item) => item.id !== id);
	return { knowledge: withEntries(knowledge, annotations), annotation };
}

export function addRelationship(
	knowledge: Knowledge,
	input: RelationshipInput,
	options: KnowledgeOptions = {},
): { knowledge: Knowledge; relationship: Relationship } {
	const { now = realClock, newId = randomUUID } = options;
	const from = cleanSide(input.from, "from");
	const to = cleanSide(input.to, "to");
	if (from.columns.length !== to.columns.length) {
		throw new Error(
			`relationship sides must have the same number of columns: from has ${from.columns.length}, to has ${to.columns.length}`,
		);
	}
	// A table may point to itself (staff.manager_id → staff.id); a column may not.
	if (sameSide(from, to)) throw new Error("relationship from and to are the same columns");
	const duplicate = knowledge.relationships.find((item) => sameSide(item.from, from) && sameSide(item.to, to));
	if (duplicate !== undefined) throw new Error(`relationship already exists (id "${duplicate.id}")`);

	const relationship: Relationship = {
		id: newId(),
		from,
		to,
		note: cleanText(input.note, "relationship note", { allowEmpty: true }),
		author: cleanAuthor(input.author),
		createdAt: now(),
	};
	return { knowledge: withEntries(knowledge, undefined, [...knowledge.relationships, relationship]), relationship };
}

export function removeRelationship(
	knowledge: Knowledge,
	id: string,
): { knowledge: Knowledge; relationship: Relationship } {
	const relationship = findById(knowledge.relationships, id, "relationship");
	const relationships = knowledge.relationships.filter((item) => item.id !== id);
	return { knowledge: withEntries(knowledge, undefined, relationships), relationship };
}

/**
 * A copy with every entry in canonical order: annotations by target, creation
 * time and id; relationships by source table, destination table and id.
 * Sorting by target groups a table's notes with its columns' notes, so a diff
 * reads like the schema. Plain code-unit comparison: the same on every machine.
 */
export function sortKnowledge(knowledge: Knowledge): Knowledge {
	return {
		formatVersion: 1,
		annotations: [...knowledge.annotations].sort((a, b) =>
			compareKeys([a.target, a.createdAt, a.id], [b.target, b.createdAt, b.id]),
		),
		relationships: [...knowledge.relationships].sort((a, b) =>
			compareKeys([a.from.table, a.to.table, a.id], [b.from.table, b.to.table, b.id]),
		),
	};
}

function withEntries(
	knowledge: Knowledge,
	annotations: readonly Annotation[] = knowledge.annotations,
	relationships: readonly Relationship[] = knowledge.relationships,
): Knowledge {
	return sortKnowledge({ formatVersion: 1, annotations, relationships });
}

function findById<T extends { readonly id: string }>(items: readonly T[], id: string, kind: string): T {
	const found = items.find((item) => item.id === id);
	if (found === undefined) throw new Error(`unknown ${kind} id "${id}"`);
	return found;
}

function cleanText(value: string, label: string, { allowEmpty }: { allowEmpty: boolean }): string {
	const text = value.trim();
	if (!allowEmpty && text === "") throw new Error(`${label} must not be empty`);
	// Spreading a string splits it by code point, so an emoji counts as one character.
	const length = [...text].length;
	if (length > MAX_TEXT_LENGTH) {
		throw new Error(`${label} is too long: ${length} characters (max ${MAX_TEXT_LENGTH})`);
	}
	return text;
}

function cleanAuthor(value: string): string {
	const author = value.trim();
	if (author === "") throw new Error("author must not be empty");
	return author;
}

function cleanSide(side: RelationshipSide, label: "from" | "to"): RelationshipSide {
	const table = canonicalTable(side.table);
	if (table === null) {
		throw new Error(`relationship ${label} must be a table name (database.schema.table): got "${side.table}"`);
	}
	if (side.columns.length === 0) throw new Error(`relationship ${label}.columns must not be empty`);
	side.columns.forEach((column, index) => {
		if (column === "") throw new Error(`relationship ${label}.columns[${index}] must not be empty`);
		if (side.columns.indexOf(column) !== index) throw new Error(`relationship ${label}.columns repeats "${column}"`);
	});
	if (side.connection === undefined) return { table, columns: [...side.columns] };
	// Whether the connection exists is checked by the caller, which has the config.
	const connection = side.connection.trim();
	if (connection === "") throw new Error(`relationship ${label}.connection must not be empty`);
	return { connection, table, columns: [...side.columns] };
}

/**
 * The canonical form of a table name, or null when the name is valid but
 * names a database or a column instead. Invalid names throw parseName's error.
 */
export function canonicalTable(name: string): string | null {
	const ref = parseName(name);
	if (ref.table === undefined || ref.column !== undefined) return null;
	return formatName(ref);
}

function sameSide(a: RelationshipSide, b: RelationshipSide): boolean {
	return a.connection === b.connection && a.table === b.table && a.columns.length === b.columns.length && a.columns.every((column, index) => column === b.columns[index]);
}

function compareKeys(a: readonly string[], b: readonly string[]): number {
	for (let index = 0; index < a.length; index++) {
		const left = a[index] ?? "";
		const right = b[index] ?? "";
		if (left !== right) return left < right ? -1 : 1;
	}
	return 0;
}
