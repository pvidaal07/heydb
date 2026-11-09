import { pickConnection } from "../config/operations.ts";
import { loadConfig } from "../config/store.ts";
import {
	type AnnotationInput,
	type KnowledgeOptions,
	type RelationshipInput,
	addAnnotation,
	addProjectNote,
	addRelationship,
	editAnnotation,
	removeAnnotation,
	removeRelationship,
} from "../knowledge/operations.ts";
import {
	type ExternalRelationship,
	type Lookup,
	type Orphans,
	type TableKnowledge,
	findOrphans,
	knowledgeForTable,
	missingInSide,
	relationshipsInto,
	snapshotLookup,
} from "../knowledge/query.ts";
import type { Annotation, Relationship, RelationshipSide } from "../knowledge/types.ts";
import type { Snapshot } from "../model/snapshot.ts";
import {
	knowledgeConnections,
	loadKnowledge,
	loadProjectKnowledge,
	saveKnowledge,
	saveProjectKnowledge,
} from "../store/knowledge.ts";
import { loadSnapshot } from "../store/snapshots.ts";

// Every write follows the same path: load, apply a pure operation, check the
// result against the stored snapshot when it names new objects, save
// atomically. A failure anywhere leaves the file as it was.
//
// New notes must point at objects that exist in the snapshot: a typo such as
// "orders.totla" would otherwise create knowledge nobody ever finds. Edits and
// removals work by id and skip that check, so orphaned entries can still be
// corrected or forgotten after a column is dropped.
//
// A relationship may cross connections (crm.clientes.cod_erp → erp's
// gcl.cod). It is stored in the file of its "from" connection, and its "to"
// side names the other connection and is checked against that snapshot.

export function annotate(
	projectRoot: string,
	connection: string,
	input: AnnotationInput,
	options: KnowledgeOptions = {},
): Annotation {
	const exists = snapshotLookup(requireSnapshot(projectRoot, connection));
	const { knowledge, annotation } = addAnnotation(loadKnowledge(projectRoot, connection), input, options);
	if (!exists(annotation.target)) throw notInSnapshot(annotation.target, connection);
	saveKnowledge(projectRoot, connection, knowledge);
	return annotation;
}

export function relate(
	projectRoot: string,
	connection: string,
	input: RelationshipInput,
	options: KnowledgeOptions = {},
): Relationship {
	if (input.from.connection !== undefined && input.from.connection !== connection) {
		throw new Error(`a relationship is stored in its "from" connection: relate it from connection "${input.from.connection}"`);
	}
	const from = withoutConnection(input.from);
	const to = input.to.connection === connection ? withoutConnection(input.to) : input.to;
	const exists = snapshotLookup(requireSnapshot(projectRoot, connection));
	const other = to.connection;
	let otherExists: Lookup = exists;
	if (other !== undefined) {
		pickConnection(loadConfig(projectRoot), other); // an unknown name fails with the configured ones
		otherExists = snapshotLookup(requireSnapshot(projectRoot, other));
	}
	const { knowledge, relationship } = addRelationship(loadKnowledge(projectRoot, connection), { ...input, from, to }, options);
	const missingFrom = missingInSide(relationship.from, exists);
	if (missingFrom !== null) throw notInSnapshot(missingFrom, connection);
	const missingTo = missingInSide(relationship.to, otherExists);
	if (missingTo !== null) throw notInSnapshot(missingTo, other ?? connection);
	saveKnowledge(projectRoot, connection, knowledge);
	return relationship;
}

/** Replaces the text of a note of the connection or, when the id is not there, of a project note. */
export function editNote(
	projectRoot: string,
	connection: string,
	input: { readonly id: string; readonly text: string },
	options: KnowledgeOptions = {},
): Annotation {
	const own = loadKnowledge(projectRoot, connection);
	if (!hasAnnotation(own.annotations, input.id)) {
		const project = loadProjectKnowledge(projectRoot);
		if (hasAnnotation(project.annotations, input.id)) {
			const { knowledge, annotation } = editAnnotation(project, input.id, input.text, options);
			saveProjectKnowledge(projectRoot, knowledge);
			return annotation;
		}
	}
	const { knowledge, annotation } = editAnnotation(own, input.id, input.text, options);
	saveKnowledge(projectRoot, connection, knowledge);
	return annotation;
}

/** A note about the whole project, above any database. Needs no connection or snapshot. */
export function annotateProject(
	projectRoot: string,
	input: Omit<AnnotationInput, "target">,
	options: KnowledgeOptions = {},
): Annotation {
	const { knowledge, annotation } = addProjectNote(loadProjectKnowledge(projectRoot), input, options);
	saveProjectKnowledge(projectRoot, knowledge);
	return annotation;
}

export function projectNotes(projectRoot: string): readonly Annotation[] {
	return loadProjectKnowledge(projectRoot).annotations;
}

export function forgetProjectNote(projectRoot: string, id: string): Annotation {
	const { knowledge, annotation } = removeAnnotation(loadProjectKnowledge(projectRoot), id);
	saveProjectKnowledge(projectRoot, knowledge);
	return annotation;
}

/** Removes a note and returns it, so the caller can show what was forgotten. */
export function forgetAnnotation(projectRoot: string, connection: string, id: string): Annotation {
	const { knowledge, annotation } = removeAnnotation(loadKnowledge(projectRoot, connection), id);
	saveKnowledge(projectRoot, connection, knowledge);
	return annotation;
}

export function forgetRelationship(projectRoot: string, connection: string, id: string): Relationship {
	const { knowledge, relationship } = removeRelationship(loadKnowledge(projectRoot, connection), id);
	saveKnowledge(projectRoot, connection, knowledge);
	return relationship;
}

/** Database, table and column notes plus relationships for one table. Needs no snapshot. */
export function tableKnowledge(projectRoot: string, connection: string, table: string): TableKnowledge {
	return knowledgeForTable(loadKnowledge(projectRoot, connection), table);
}

/** Files read at most, so a folder full of stray files cannot slow every table down. */
export const MAX_OTHER_KNOWLEDGE_FILES = 100;

/**
 * Relationships stored in other connections' knowledge files that point to
 * `table` of `connection`. A file that cannot be read is reported in
 * `unreadable`, not thrown: a broken crm.json must not hide erp's tables.
 */
export function relationshipsFromOtherConnections(
	projectRoot: string,
	connection: string,
	table: string,
): { relationships: ExternalRelationship[]; unreadable: string[] } {
	const relationships: ExternalRelationship[] = [];
	const unreadable: string[] = [];
	const others = knowledgeConnections(projectRoot).filter((name) => name !== connection);
	for (const other of others.slice(0, MAX_OTHER_KNOWLEDGE_FILES)) {
		try {
			for (const relationship of relationshipsInto(loadKnowledge(projectRoot, other), connection, table)) {
				relationships.push({ connection: other, relationship });
			}
		} catch (error) {
			unreadable.push(error instanceof Error ? error.message : String(error));
		}
	}
	const skipped = others.length - MAX_OTHER_KNOWLEDGE_FILES;
	if (skipped > 0) unreadable.push(`${skipped} more knowledge files were not read (limit ${MAX_OTHER_KNOWLEDGE_FILES})`);
	return { relationships, unreadable };
}

/**
 * Knowledge whose target is gone from the stored snapshot, including
 * relationships whose other connection is gone, unsynced or no longer has
 * the table or columns. Reported only; the file is not changed.
 */
export function orphanedKnowledge(projectRoot: string, connection: string): Orphans {
	const snapshot = requireSnapshot(projectRoot, connection);
	const configured = loadConfig(projectRoot).connections;
	const lookups = new Map<string, Lookup | null>();
	const others = (name: string): Lookup | null => {
		if (!lookups.has(name)) {
			const stored = Object.hasOwn(configured, name) ? loadSnapshot(projectRoot, name) : null;
			lookups.set(name, stored === null ? null : snapshotLookup(stored));
		}
		return lookups.get(name) ?? null;
	};
	return findOrphans(loadKnowledge(projectRoot, connection), snapshot, others);
}

function requireSnapshot(projectRoot: string, connection: string): Snapshot {
	const snapshot = loadSnapshot(projectRoot, connection);
	if (snapshot === null) throw new Error(`connection "${connection}" was never synced: run sync first`);
	return snapshot;
}

function hasAnnotation(annotations: readonly Annotation[], id: string): boolean {
	return annotations.some((item) => item.id === id);
}

function withoutConnection(side: RelationshipSide): RelationshipSide {
	return { table: side.table, columns: side.columns };
}

function notInSnapshot(name: string, connection: string): Error {
	return new Error(`${name} does not exist in the snapshot of "${connection}"; if it was created recently, run sync first`);
}
