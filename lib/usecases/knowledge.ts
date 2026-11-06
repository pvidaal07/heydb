import {
	type AnnotationInput,
	type KnowledgeOptions,
	type RelationshipInput,
	addAnnotation,
	addRelationship,
	editAnnotation,
	removeAnnotation,
	removeRelationship,
} from "../knowledge/operations.ts";
import { type Orphans, type TableKnowledge, findOrphans, knowledgeForTable, missingInRelationship, snapshotLookup } from "../knowledge/query.ts";
import type { Annotation, Relationship } from "../knowledge/types.ts";
import type { Snapshot } from "../model/snapshot.ts";
import { loadKnowledge, saveKnowledge } from "../store/knowledge.ts";
import { loadSnapshot } from "../store/snapshots.ts";

// Every write follows the same path: load, apply a pure operation, check the
// result against the stored snapshot when it names new objects, save
// atomically. A failure anywhere leaves the file as it was.
//
// New notes must point at objects that exist in the snapshot: a typo such as
// "orders.totla" would otherwise create knowledge nobody ever finds. Edits and
// removals work by id and skip that check, so orphaned entries can still be
// corrected or forgotten after a column is dropped.

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
	const exists = snapshotLookup(requireSnapshot(projectRoot, connection));
	const { knowledge, relationship } = addRelationship(loadKnowledge(projectRoot, connection), input, options);
	const missing = missingInRelationship(relationship, exists);
	if (missing !== null) throw notInSnapshot(missing, connection);
	saveKnowledge(projectRoot, connection, knowledge);
	return relationship;
}

export function editNote(
	projectRoot: string,
	connection: string,
	input: { readonly id: string; readonly text: string },
	options: KnowledgeOptions = {},
): Annotation {
	const { knowledge, annotation } = editAnnotation(loadKnowledge(projectRoot, connection), input.id, input.text, options);
	saveKnowledge(projectRoot, connection, knowledge);
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

/** Knowledge whose target is gone from the stored snapshot. Reported only; the file is not changed. */
export function orphanedKnowledge(projectRoot: string, connection: string): Orphans {
	return findOrphans(loadKnowledge(projectRoot, connection), requireSnapshot(projectRoot, connection));
}

function requireSnapshot(projectRoot: string, connection: string): Snapshot {
	const snapshot = loadSnapshot(projectRoot, connection);
	if (snapshot === null) throw new Error(`connection "${connection}" was never synced: run sync first`);
	return snapshot;
}

function notInSnapshot(name: string, connection: string): Error {
	return new Error(`${name} does not exist in the snapshot of "${connection}"; if it was created recently, run sync first`);
}
