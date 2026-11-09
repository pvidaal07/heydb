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
	 * stores the relationship (crm.clientes.cod_erp → erp's gcl.cod). Absent
	 * means that connection, so files written before this field stay valid.
	 */
	readonly connection?: string;
	/** Canonical table name: database.schema.table. */
	readonly table: string;
	readonly columns: readonly string[];
}
