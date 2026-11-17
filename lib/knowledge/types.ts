// Knowledge is what people and agents learn about a database that its
// structure does not say: what a column really means, which columns join two
// tables when there is no foreign key. It lives in
// .heydb/knowledge/<connection>.json and is committed, like the snapshot.
//
// Every entry is anchored to a canonical name (database.schema.table.column),
// never to a bare table name, so "clientes" in two databases never share notes.
// Timestamps are ISO 8601 strings; ids come from crypto.randomUUID.
//
// Notes about the whole project, above any database ("the ERP uses one
// database per client"), live in .heydb/knowledge/_project.json with the same
// shape: only annotations, all with the target PROJECT_TARGET. The leading
// underscore can never be a connection name, which must start with a letter
// or digit.

/** The target of every note in the project file. Not a canonical name: those have 2 to 4 segments. */
export const PROJECT_TARGET = "project";

export interface Knowledge {
	/** Bumped only when the shape of this file changes incompatibly. */
	readonly formatVersion: 1;
	readonly annotations: readonly Annotation[];
	readonly relationships: readonly Relationship[];
	/**
	 * Absent when there are none, in memory and in the file, so a file without
	 * flows stays exactly as it was before flows existed. Never in the project file.
	 */
	readonly flows?: readonly Flow[];
}

/**
 * The database contract of one process ("issue an invoice"): where it starts
 * in the code and which tables and columns it writes and reads. Fields, not
 * free text, so every table can be checked against the snapshot and the flow
 * found from any table it touches. Written in the team's language.
 */
export interface Flow {
	readonly id: string;
	/** The business words people use for it; unique, ignoring case and accents, with the synonyms of every flow. */
	readonly name: string;
	readonly synonyms: readonly string[];
	/** Where it starts: "file:function". */
	readonly entry: string;
	readonly writes: readonly FlowWrite[];
	/** Canonical table names read directly, not through helper routines. */
	readonly reads: readonly string[];
	/** Absent when the flow has a single stage. */
	readonly stages?: readonly FlowStage[];
	/** What could not be followed (a database function without code); absent when nothing. */
	readonly open?: string;
	/** The files it was read from. */
	readonly sources: readonly string[];
	readonly author: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	/** 1 when created; each save that replaces it adds 1. History is git. */
	readonly revision: number;
}

export interface FlowWrite {
	/** Canonical table name: database.schema.table. */
	readonly table: string;
	/** Columns written; empty when not known or the whole row (a delete). */
	readonly columns: readonly string[];
}

export interface FlowStage {
	readonly name: string;
	readonly writes: readonly FlowWrite[];
	readonly reads: readonly string[];
}

export interface Annotation {
	readonly id: string;
	/**
	 * Canonical name of what the note is about: "db.schema" for the whole
	 * database, "db.schema.table" for a table, "db.schema.table.column" for a
	 * column; PROJECT_TARGET in the project file.
	 */
	readonly target: string;
	readonly text: string;
	readonly author: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}

/**
 * An implicit foreign key: the database does not enforce it, but the data
 * follows it (typical in legacy schemas and MyISAM tables). Column lists allow
 * composite keys; both sides have the same length, matched by position.
 */
export interface Relationship {
	readonly id: string;
	readonly from: RelationshipSide;
	readonly to: RelationshipSide;
	readonly note: string;
	readonly author: string;
	readonly createdAt: string;
}

export interface RelationshipSide {
	/**
	 * The connection the table belongs to when it is not the one whose file
	 * stores the relationship (crm.clientes.cod_erp → erp's cus.cod). Absent
	 * means that connection, so files written before this field stay valid.
	 */
	readonly connection?: string;
	/** Canonical table name: database.schema.table. */
	readonly table: string;
	readonly columns: readonly string[];
}
