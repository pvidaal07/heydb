// Shared helpers for knowledge tests. Not a test file: the runner only picks *.test.ts.
import type { KnowledgeOptions } from "../../lib/knowledge/operations.ts";
import type { Annotation, Knowledge, Relationship } from "../../lib/knowledge/types.ts";

/** A clock and id generator that always produce the same sequence, so results are exact. */
export function fixedClock(): Required<KnowledgeOptions> {
	let tick = 0;
	let id = 0;
	return {
		now: () => new Date(Date.UTC(2026, 10, 6, 10, 0, tick++)).toISOString(),
		newId: () => `id-${String(++id).padStart(3, "0")}`,
	};
}

export function annotation(id: string, target: string, overrides: Partial<Annotation> = {}): Annotation {
	return {
		id,
		target,
		text: `note ${id}`,
		author: "ana",
		createdAt: "2026-11-06T10:00:00.000Z",
		updatedAt: "2026-11-06T10:00:00.000Z",
		...overrides,
	};
}

export function relationship(id: string, from: string, fromColumns: string[], to: string, toColumns: string[]): Relationship {
	return {
		id,
		from: { table: from, columns: fromColumns },
		to: { table: to, columns: toColumns },
		note: "",
		author: "ana",
		createdAt: "2026-11-06T10:00:00.000Z",
	};
}

export function knowledge(annotations: Annotation[] = [], relationships: Relationship[] = []): Knowledge {
	return { formatVersion: 1, annotations, relationships };
}
