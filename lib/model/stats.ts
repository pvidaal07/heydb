import { createHash } from "node:crypto";

import type { Knowledge } from "../knowledge/types.ts";
import { formatName } from "./names.ts";
import { incomingCounts } from "./references.ts";
import type { Snapshot, Table } from "./snapshot.ts";

// What a schema looks like at a glance, before reading any table: how much of
// it is commented (how far comments can be trusted as documentation), how its
// tables are named, and which tables the rest points to (its core).

const TOP_PREFIXES = 5;
const TOP_TABLES = 10;

export interface PrefixCount {
	readonly prefix: string;
	readonly count: number;
}

export interface MainTable {
	/** Canonical name. */
	readonly name: string;
	readonly table: Table;
	/** Declared, implicit and name-pattern references from other tables. */
	readonly incoming: number;
}

export interface SchemaStats {
	readonly database: string;
	readonly schema: string;
	/** Tables only; views are counted apart and left out of every other number. */
	readonly tables: number;
	readonly views: number;
	readonly tablesWithComment: number;
	readonly columns: number;
	readonly columnsWithComment: number;
	/** Prefixes shared by two tables or more, most used first. */
	readonly prefixes: readonly PrefixCount[];
	/** The most referenced tables, most first; only tables with references. */
	readonly mainTables: readonly MainTable[];
	/**
	 * Equal for schemas with the same tables and views, by name, each with the
	 * same columns (name and type): one database per company. Comments, rows,
	 * keys and indexes are left out, as search does for identical copies.
	 */
	readonly structure: string;
}

/** One entry per schema, in snapshot order (one per database in MySQL and MariaDB). */
export function schemaStats(snapshot: Snapshot, knowledge: Knowledge, counts = incomingCounts(snapshot, knowledge)): SchemaStats[] {
	return snapshot.databases.flatMap((database) =>
		database.schemas.map((schema): SchemaStats => {
			const tables = schema.tables.filter((table) => table.kind === "table");
			const columns = tables.flatMap((table) => table.columns);

			const prefixes = new Map<string, number>();
			for (const table of tables) {
				const prefix = tablePrefix(table.name);
				if (prefix !== null) prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
			}

			const mainTables = tables
				.map((table) => {
					const name = formatName({ database: database.name, schema: schema.name, table: table.name });
					return { name, table, incoming: counts.get(name) ?? 0 };
				})
				.filter((item) => item.incoming > 0)
				.sort((a, b) => b.incoming - a.incoming || compareText(a.name, b.name))
				.slice(0, TOP_TABLES);

			return {
				database: database.name,
				schema: schema.name,
				tables: tables.length,
				views: schema.tables.length - tables.length,
				tablesWithComment: tables.filter((table) => table.comment.trim() !== "").length,
				columns: columns.length,
				columnsWithComment: columns.filter((column) => column.comment.trim() !== "").length,
				prefixes: [...prefixes]
					.filter(([, count]) => count >= 2)
					.map(([prefix, count]) => ({ prefix, count }))
					.sort((a, b) => b.count - a.count || compareText(a.prefix, b.prefix))
					.slice(0, TOP_PREFIXES),
				mainTables,
				structure: structureKey(schema.tables, database.name, schema.name),
			};
		}),
	);
}

// The schema name counts only where it is not the database (PostgreSQL), so
// app1.public and app2.public can match while app.public and app.sales cannot.
function structureKey(tables: readonly Table[], database: string, schema: string): string {
	const hash = createHash("sha256").update(schema === database ? "" : schema);
	for (const table of [...tables].sort((a, b) => compareText(a.name, b.name))) {
		hash.update(`\u0000${table.kind}\u0001${table.name}`);
		for (const column of table.columns) hash.update(`\u0002${column.name}\u0001${column.type}`);
	}
	return hash.digest("hex");
}

/**
 * The family a table name belongs to: the start of the name up to the first
 * "_" ("sii_fac" → "sii_") or digit ("log2020" → "log0-9"), lowercased. null
 * when there is no such start ("cus", "_tmp", "2020_log").
 */
export function tablePrefix(name: string): string | null {
	const match = /^([^_0-9]+)([_0-9])/.exec(name);
	if (match === null) return null;
	const start = (match[1] as string).toLowerCase();
	return match[2] === "_" ? `${start}_` : `${start}0-9`;
}

// Plain code-unit comparison: the same order on every machine and locale.
function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
