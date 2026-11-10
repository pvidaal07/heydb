// The schema of a MySQL or MariaDB snapshot as DDL, to load into a throwaway
// server for the database strategies: the structure only, never a row. Each
// table keeps its column types, primary key, indexes, comments and storage
// engine as captured; foreign keys come after every table, as declared (a
// MyISAM table accepts and ignores them, as on the real server). Each table
// has a plainer fallback (no defaults, generated expressions or secondary
// indexes) for what the server rejects; what fails both is skipped and counted.
import type { Column, Snapshot, Table } from "../../lib/model/snapshot.ts";

export interface DdlStatement {
	readonly kind: "database" | "table" | "view" | "foreign-key";
	/** database, database.table, or database.table.constraint. */
	readonly target: string;
	readonly sql: string;
	/** A simpler statement to try when `sql` fails. */
	readonly fallback?: string;
}

export interface DdlPlan {
	readonly databases: readonly string[];
	readonly statements: readonly DdlStatement[];
	/** Objects left out before reaching the server. */
	readonly skipped: readonly { readonly target: string; readonly reason: string }[];
}

export const quoteName = (name: string): string => `\`${name.replaceAll("`", "``")}\``;
export const quoteText = (text: string): string => `'${text.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

export function schemaDdl(snapshot: Snapshot): DdlPlan {
	if (snapshot.engine.kind === "postgresql") throw new Error("the database strategies load the schema into MySQL: they need a MySQL or MariaDB snapshot");
	const statements: DdlStatement[] = [];
	const views: DdlStatement[] = [];
	const keys: DdlStatement[] = [];
	const skipped: { target: string; reason: string }[] = [];
	const databases: string[] = [];
	for (const database of snapshot.databases) {
		databases.push(database.name);
		statements.push({ kind: "database", target: database.name, sql: `CREATE DATABASE ${quoteName(database.name)}` });
		for (const schema of database.schemas) {
			for (const table of schema.tables) {
				const name = `${quoteName(database.name)}.${quoteName(table.name)}`;
				const target = `${database.name}.${table.name}`;
				if (table.kind === "view") {
					if (table.viewDefinition === null) skipped.push({ target, reason: "view definition not captured" });
					else views.push({ kind: "view", target, sql: `CREATE VIEW ${name} AS ${table.viewDefinition}` });
					continue;
				}
				statements.push({ kind: "table", target, sql: createTable(name, table, true), fallback: createTable(name, table, false) });
				for (const key of table.foreignKeys) {
					const references = `${quoteName(key.references.database)}.${quoteName(key.references.table)}`;
					keys.push({
						kind: "foreign-key",
						target: `${target}.${key.name}`,
						sql: `ALTER TABLE ${name} ADD CONSTRAINT ${quoteName(key.name)} FOREIGN KEY (${names(key.columns)}) REFERENCES ${references} (${names(key.references.columns)}) ON DELETE ${key.onDelete} ON UPDATE ${key.onUpdate}`,
					});
				}
			}
		}
	}
	return { databases, statements: [...statements, ...views, ...keys], skipped };
}

const names = (columns: readonly string[]): string => columns.map(quoteName).join(", ");

function createTable(name: string, table: Table, full: boolean): string {
	const lines = table.columns.map((column) => `  ${columnDefinition(column, full)}`);
	if (table.primaryKey.length > 0) lines.push(`  PRIMARY KEY (${names(table.primaryKey)})`);
	if (full) {
		for (const index of table.indexes) {
			if (index.name === "PRIMARY") continue;
			const kind = index.method === "FULLTEXT" ? "FULLTEXT KEY" : index.method === "SPATIAL" ? "SPATIAL KEY" : index.unique ? "UNIQUE KEY" : "KEY";
			lines.push(`  ${kind} ${quoteName(index.name)} (${names(index.columns)})`);
		}
	}
	const options = [...(table.storageEngine === null ? [] : [`ENGINE=${table.storageEngine}`]), ...(table.comment === "" ? [] : [`COMMENT=${quoteText(table.comment)}`])];
	return `CREATE TABLE ${name} (\n${lines.join(",\n")}\n)${options.length === 0 ? "" : ` ${options.join(" ")}`}`;
}

function columnDefinition(column: Column, full: boolean): string {
	const parts = [quoteName(column.name), column.type];
	if (full && column.generated !== null) parts.push(`AS (${column.generated.expression}) ${column.generated.stored ? "STORED" : "VIRTUAL"}`);
	parts.push(column.nullable ? "NULL" : "NOT NULL");
	if (full && column.default !== null && column.generated === null) parts.push(`DEFAULT ${defaultValue(column.default)}`);
	if (column.autoIncrement) parts.push("AUTO_INCREMENT");
	if (column.comment !== "") parts.push(`COMMENT ${quoteText(column.comment)}`);
	return parts.join(" ");
}

/**
 * A default as information_schema prints it, back to SQL: numbers, NULL,
 * CURRENT_TIMESTAMP and expressions as they are, values already quoted (as
 * MariaDB prints them) as they are, any other text quoted.
 */
function defaultValue(value: string): string {
	if (/^-?\d+(\.\d+)?$/.test(value)) return value;
	if (/^(null|current_timestamp(\(\d*\))?|now\(\d*\)|localtimestamp|localtime)$/i.test(value)) return value;
	if (/^['(]/.test(value) || /^b'[01]*'$/i.test(value)) return value;
	return quoteText(value);
}
