// A Snapshot is an immutable picture of a database server's structure at one
// moment: which databases, schemas, tables and columns exist and how they are
// keyed and related. It never contains row data.
//
// Conventions used by every type in this file:
// - `readonly` everywhere: a snapshot is a fact about the past, never edited.
// - `null` (not an optional field) when a value was checked and is absent, so
//   "no default" and "we forgot to read the default" never look the same.
// - Names are kept exactly as the engine reports them (case included).

export type EngineKind = "mysql" | "mariadb" | "postgresql";

export interface Snapshot {
	/** Bumped only when the shape of this file changes incompatibly. */
	readonly formatVersion: 1;
	readonly engine: EngineInfo;
	/** ISO 8601 timestamp of the capture. */
	readonly capturedAt: string;
	readonly databases: readonly Database[];
	/** What could not be read (missing privileges, unsupported features). */
	readonly warnings: readonly Warning[];
}

export interface EngineInfo {
	readonly kind: EngineKind;
	/** Version string as reported by the server, e.g. "8.0.36" or "10.11.6-MariaDB". */
	readonly version: string;
}

export interface Database {
	readonly name: string;
	/** MySQL and MariaDB have exactly one schema per database, named like the database. */
	readonly schemas: readonly Schema[];
}

export interface Schema {
	readonly name: string;
	readonly tables: readonly Table[];
	readonly routines: readonly Routine[];
}

export type TableKind = "table" | "view";

export interface Table {
	readonly name: string;
	readonly kind: TableKind;
	readonly comment: string;
	/** Storage engine (InnoDB, MyISAM…); null where the concept does not exist (PostgreSQL). */
	readonly storageEngine: string | null;
	/** Approximate number of rows reported by the engine statistics; null when unknown. */
	readonly rowEstimate: number | null;
	readonly columns: readonly Column[];
	/** Primary key column names in key order (not table order). Empty when there is none. */
	readonly primaryKey: readonly string[];
	readonly indexes: readonly Index[];
	readonly foreignKeys: readonly ForeignKey[];
	readonly triggers: readonly Trigger[];
	/**
	 * The SELECT of a view as the engine prints it. null for tables, and null for a
	 * view whose definition the user may not see (a warning says so).
	 */
	readonly viewDefinition: string | null;
}

export interface Column {
	readonly name: string;
	/** 1-based position in the table definition. */
	readonly position: number;
	/** Full type as the engine prints it, e.g. "bigint unsigned" or "varchar(255)". */
	readonly type: string;
	readonly nullable: boolean;
	/** Default expression as text; null when the column has no default. */
	readonly default: string | null;
	readonly comment: string;
	readonly autoIncrement: boolean;
	readonly generated: GeneratedColumn | null;
	readonly collation: string | null;
}

export interface GeneratedColumn {
	readonly expression: string;
	/** true for STORED, false for VIRTUAL. */
	readonly stored: boolean;
}

export interface Index {
	readonly name: string;
	/** Column names in index order. */
	readonly columns: readonly string[];
	readonly unique: boolean;
	/** BTREE, HASH, FULLTEXT, GIN… as reported by the engine. */
	readonly method: string;
}

export type ReferentialAction = "CASCADE" | "SET NULL" | "SET DEFAULT" | "RESTRICT" | "NO ACTION";

export interface ForeignKey {
	readonly name: string;
	/** Local columns, in the same order as `references.columns`. */
	readonly columns: readonly string[];
	readonly references: {
		readonly database: string;
		readonly schema: string;
		readonly table: string;
		readonly columns: readonly string[];
	};
	readonly onDelete: ReferentialAction;
	readonly onUpdate: ReferentialAction;
}

export interface Routine {
	readonly name: string;
	readonly kind: "procedure" | "function";
}

export interface Trigger {
	readonly name: string;
	readonly timing: "BEFORE" | "AFTER" | "INSTEAD OF";
	readonly events: readonly ("INSERT" | "UPDATE" | "DELETE" | "TRUNCATE")[];
}

export interface Warning {
	/** Stable machine-readable code, e.g. "routines_hidden". */
	readonly code: string;
	readonly message: string;
	/** Canonical name of the affected object, when there is one. */
	readonly target?: string;
}
