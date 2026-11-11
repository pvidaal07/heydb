import { formatName } from "../../model/names.ts";
import { sortSnapshot } from "../../model/order.ts";
import type {
	Column,
	Database,
	ForeignKey,
	Index,
	ReferentialAction,
	Routine,
	Snapshot,
	Table,
	Trigger,
	Warning,
} from "../../model/snapshot.ts";

// Pure translation from MySQL/MariaDB catalog rows to a Snapshot. It never
// talks to a server: introspect.ts runs the queries and hands the rows here,
// so every rule below is tested with hand-written rows and no database.
//
// Row field names match the aliases used in introspect.ts queries.

export interface MysqlCatalog {
	/** Result of SELECT VERSION(), e.g. "8.0.36" or "10.6.18-MariaDB". */
	readonly version: string;
	readonly capturedAt: string;
	/** Databases the caller asked for; null means "every visible database". */
	readonly requestedDatabases: readonly string[] | null;
	/** Databases actually captured (visible and requested). */
	readonly databases: readonly string[];
	readonly tables: readonly TableRow[];
	readonly columns: readonly ColumnRow[];
	readonly indexColumns: readonly IndexColumnRow[];
	readonly foreignKeyColumns: readonly ForeignKeyColumnRow[];
	readonly triggers: readonly TriggerRow[];
	readonly routines: readonly RoutineRow[];
	readonly views: readonly ViewRow[];
	/** The current user's own privileges, global (databaseName null) or per database. */
	readonly privileges: readonly PrivilegeRow[];
}

export interface TableRow {
	readonly databaseName: string;
	readonly tableName: string;
	/** "BASE TABLE", "VIEW", or MariaDB's "SYSTEM VERSIONED". */
	readonly tableType: string;
	readonly storageEngine: string | null;
	readonly tableRows: number | string | null;
	readonly tableComment: string | null;
}

export interface ColumnRow {
	readonly databaseName: string;
	readonly tableName: string;
	readonly columnName: string;
	readonly position: number;
	readonly columnType: string;
	readonly isNullable: string;
	readonly columnDefault: string | null;
	readonly columnComment: string | null;
	readonly extra: string | null;
	readonly collation: string | null;
	readonly generationExpression: string | null;
}

export interface IndexColumnRow {
	readonly databaseName: string;
	readonly tableName: string;
	readonly indexName: string;
	readonly sequence: number;
	/** null for a functional index part (MySQL 8.0.13+). */
	readonly columnName: string | null;
	readonly nonUnique: number | string;
	readonly indexType: string;
}

export interface ForeignKeyColumnRow {
	readonly databaseName: string;
	readonly tableName: string;
	readonly constraintName: string;
	readonly position: number;
	readonly columnName: string;
	readonly referencedDatabase: string;
	readonly referencedTable: string;
	readonly referencedColumn: string;
	readonly updateRule: string;
	readonly deleteRule: string;
}

/** A KEY_COLUMN_USAGE row of a foreign key, before its rules are attached. */
export type ForeignKeyKeyColumnRow = Omit<ForeignKeyColumnRow, "updateRule" | "deleteRule">;

/** A REFERENTIAL_CONSTRAINTS row: the ON UPDATE / ON DELETE rules of one foreign key. */
export interface ForeignKeyRuleRow {
	readonly databaseName: string;
	readonly tableName: string;
	readonly constraintName: string;
	readonly updateRule: string;
	readonly deleteRule: string;
}

export interface TriggerRow {
	readonly databaseName: string;
	readonly tableName: string;
	readonly triggerName: string;
	readonly timing: string;
	readonly event: string;
}

export interface RoutineRow {
	readonly databaseName: string;
	readonly routineName: string;
	readonly routineType: string;
}

export interface ViewRow {
	readonly databaseName: string;
	readonly tableName: string;
	/** Empty (or null) when the user lacks SHOW VIEW on the view. */
	readonly viewDefinition: string | null;
}

export interface PrivilegeRow {
	readonly databaseName: string | null;
	readonly privilege: string;
}

const REFERENTIAL_ACTIONS: readonly ReferentialAction[] = ["CASCADE", "SET NULL", "SET DEFAULT", "RESTRICT", "NO ACTION"];

// INFORMATION_SCHEMA only lists the triggers and routines the user is allowed
// to see. Without these privileges the lists come back empty with no error,
// so heydb warns instead of presenting an incomplete picture as complete.
const TRIGGER_PRIVILEGES = { global: ["TRIGGER"], database: ["TRIGGER"] };
const ROUTINE_PRIVILEGES = {
	global: ["SHOW_ROUTINE", "EXECUTE", "ALTER ROUTINE", "CREATE ROUTINE"],
	// SHOW_ROUTINE (MySQL 8.0.20+) can only be granted globally.
	database: ["EXECUTE", "ALTER ROUTINE", "CREATE ROUTINE"],
};

export function buildSnapshot(catalog: MysqlCatalog): Snapshot {
	const isMariaDb = catalog.version.toLowerCase().includes("mariadb");
	const captured = new Set(catalog.databases);
	const inCapturedDatabase = (row: { databaseName: string }) => captured.has(row.databaseName);

	// Group every kind of row by its table once, so building each table is a lookup.
	const columnsByTable = groupBy(catalog.columns.filter(inCapturedDatabase), tableKey);
	const indexesByTable = groupBy(catalog.indexColumns.filter(inCapturedDatabase), tableKey);
	const foreignKeysByTable = groupBy(catalog.foreignKeyColumns.filter(inCapturedDatabase), tableKey);
	const triggersByTable = groupBy(catalog.triggers.filter(inCapturedDatabase), tableKey);
	const tablesByDatabase = groupBy(catalog.tables.filter(inCapturedDatabase), (row) => row.databaseName);
	const routinesByDatabase = groupBy(catalog.routines.filter(inCapturedDatabase), (row) => row.databaseName);
	const definitionsByView = new Map(catalog.views.map((row) => [tableKey(row), row.viewDefinition]));

	const databases: Database[] = [...captured].sort().map((name) => ({
		name,
		schemas: [
			{
				name,
				tables: (tablesByDatabase.get(name) ?? []).map((row) => {
					const key = tableKey(row);
					return buildTable(
						row,
						columnsByTable.get(key) ?? [],
						indexesByTable.get(key) ?? [],
						foreignKeysByTable.get(key) ?? [],
						triggersByTable.get(key) ?? [],
						definitionsByView.get(key) ?? null,
						isMariaDb,
					);
				}),
				routines: (routinesByDatabase.get(name) ?? []).map(buildRoutine),
			},
		],
	}));

	// Return the canonical order so every consumer sees the same snapshot,
	// whatever order the server returned the rows in.
	return sortSnapshot({
		formatVersion: 1,
		engine: { kind: isMariaDb ? "mariadb" : "mysql", version: catalog.version },
		capturedAt: catalog.capturedAt,
		databases,
		warnings: [
			...missingDatabaseWarnings(catalog.requestedDatabases, captured),
			...hiddenObjectWarnings([...captured], catalog.privileges),
			...hiddenViewDefinitionWarnings(databases),
		],
	});
}

/**
 * Attaches to each foreign key column the rules of its constraint, matched by
 * database, table and constraint name. The engine reads KEY_COLUMN_USAGE and
 * REFERENTIAL_CONSTRAINTS with two queries because joining them in SQL makes
 * MariaDB open every table on the server. A column whose constraint has no
 * rules row is dropped, exactly as the former inner join did.
 */
export function attachForeignKeyRules(
	columns: readonly ForeignKeyKeyColumnRow[],
	rules: readonly ForeignKeyRuleRow[],
): ForeignKeyColumnRow[] {
	const constraintKey = (row: { databaseName: string; tableName: string; constraintName: string }) =>
		`${tableKey(row)}\u0000${row.constraintName}`;
	const rulesByConstraint = new Map(rules.map((row) => [constraintKey(row), row]));
	return columns.flatMap((column) => {
		const rule = rulesByConstraint.get(constraintKey(column));
		return rule === undefined ? [] : [{ ...column, updateRule: rule.updateRule, deleteRule: rule.deleteRule }];
	});
}

function buildTable(
	row: TableRow,
	columnRows: readonly ColumnRow[],
	indexRows: readonly IndexColumnRow[],
	foreignKeyRows: readonly ForeignKeyColumnRow[],
	triggerRows: readonly TriggerRow[],
	viewDefinition: string | null,
	isMariaDb: boolean,
): Table {
	const isView = row.tableType === "VIEW";
	const primaryKeyRows = indexRows.filter((r) => r.indexName === "PRIMARY");
	return {
		name: row.tableName,
		kind: isView ? "view" : "table",
		// MySQL reports the comment "VIEW" for every view: it is not a real comment.
		comment: isView ? "" : (row.tableComment ?? ""),
		storageEngine: row.storageEngine,
		rowEstimate: isView || row.tableRows === null ? null : Number(row.tableRows),
		columns: [...columnRows].sort((a, b) => a.position - b.position).map((c) => buildColumn(c, isMariaDb)),
		primaryKey: [...primaryKeyRows].sort((a, b) => a.sequence - b.sequence).map(indexPartName),
		indexes: buildIndexes(indexRows.filter((r) => r.indexName !== "PRIMARY")),
		foreignKeys: buildForeignKeys(foreignKeyRows),
		triggers: buildTriggers(triggerRows),
		// An empty definition is not an empty SELECT: the server hid it.
		viewDefinition: isView && viewDefinition ? viewDefinition : null,
	};
}

function buildColumn(row: ColumnRow, isMariaDb: boolean): Column {
	const extra = (row.extra ?? "").toUpperCase();
	const generatedKind = /\b(VIRTUAL|STORED|PERSISTENT) GENERATED\b/.exec(extra)?.[1];
	return {
		name: row.columnName,
		position: row.position,
		type: row.columnType,
		nullable: row.isNullable === "YES",
		// MariaDB 10.2.7+ reports "no default" as the text NULL; MySQL uses a real NULL.
		default: isMariaDb && row.columnDefault === "NULL" ? null : row.columnDefault,
		comment: row.columnComment ?? "",
		autoIncrement: extra.includes("AUTO_INCREMENT"),
		generated:
			generatedKind === undefined
				? null
				: { expression: row.generationExpression ?? "", stored: generatedKind !== "VIRTUAL" },
		collation: row.collation,
	};
}

function buildIndexes(rows: readonly IndexColumnRow[]): Index[] {
	return [...groupBy(rows, (r) => r.indexName)].map(([name, parts]) => {
		const sorted = [...parts].sort((a, b) => a.sequence - b.sequence);
		const first = sorted[0]!; // groupBy never creates empty groups
		return {
			name,
			columns: sorted.map(indexPartName),
			unique: Number(first.nonUnique) === 0,
			method: first.indexType,
		};
	});
}

function indexPartName(row: IndexColumnRow): string {
	return row.columnName ?? "(expression)";
}

function buildForeignKeys(rows: readonly ForeignKeyColumnRow[]): ForeignKey[] {
	return [...groupBy(rows, (r) => r.constraintName)].map(([name, parts]) => {
		const sorted = [...parts].sort((a, b) => a.position - b.position);
		const first = sorted[0]!;
		const where = `${first.databaseName}.${first.tableName}.${name}`;
		return {
			name,
			columns: sorted.map((r) => r.columnName),
			references: {
				database: first.referencedDatabase,
				schema: first.referencedDatabase,
				table: first.referencedTable,
				columns: sorted.map((r) => r.referencedColumn),
			},
			onDelete: referentialAction(first.deleteRule, where),
			onUpdate: referentialAction(first.updateRule, where),
		};
	});
}

function referentialAction(rule: string, where: string): ReferentialAction {
	const action = REFERENTIAL_ACTIONS.find((candidate) => candidate === rule.toUpperCase());
	if (action === undefined) throw new Error(`unknown foreign key rule "${rule}" on ${where}`);
	return action;
}

function buildTriggers(rows: readonly TriggerRow[]): Trigger[] {
	// MySQL and MariaDB triggers fire on exactly one event each.
	return rows.map((row) => ({
		name: row.triggerName,
		timing: row.timing.toUpperCase() === "AFTER" ? "AFTER" : "BEFORE",
		events: [row.event.toUpperCase() as Trigger["events"][number]],
	}));
}

function buildRoutine(row: RoutineRow): Routine {
	return { name: row.routineName, kind: row.routineType.toUpperCase() === "FUNCTION" ? "function" : "procedure" };
}

function missingDatabaseWarnings(requested: readonly string[] | null, captured: ReadonlySet<string>): Warning[] {
	return [...new Set(requested ?? [])]
		.filter((name) => !captured.has(name))
		.map((name) => ({
			code: "database_not_visible",
			message: `database "${name}" does not exist or the user has no privileges on it`,
			target: name,
		}));
}

function hiddenObjectWarnings(databases: readonly string[], privileges: readonly PrivilegeRow[]): Warning[] {
	const has = (database: string, allowed: { global: string[]; database: string[] }) =>
		privileges.some((p) => {
			const privilege = p.privilege.toUpperCase();
			if (p.databaseName === null) return allowed.global.includes(privilege);
			return allowed.database.includes(privilege) && grantMatches(p.databaseName, database);
		});

	const warnings: Warning[] = [];
	for (const database of databases) {
		if (!has(database, TRIGGER_PRIVILEGES)) {
			warnings.push({
				code: "triggers_hidden",
				message: `triggers in "${database}" are only listed with the TRIGGER privilege; the list may be incomplete`,
				target: database,
			});
		}
		if (!has(database, ROUTINE_PRIVILEGES)) {
			warnings.push({
				code: "routines_hidden",
				message: `routines in "${database}" are only listed with the SHOW_ROUTINE, EXECUTE, ALTER ROUTINE or CREATE ROUTINE privilege; the list may be incomplete`,
				target: database,
			});
		}
	}
	return warnings;
}

// Without SHOW VIEW on a view, INFORMATION_SCHEMA.VIEWS still lists it but with
// an empty definition, so the warning is per view and needs no privilege check.
function hiddenViewDefinitionWarnings(databases: readonly Database[]): Warning[] {
	return databases.flatMap((database) =>
		database.schemas.flatMap((schema) =>
			schema.tables
				.filter((table) => table.kind === "view" && table.viewDefinition === null)
				.map((view) => ({
					code: "view_definition_hidden",
					message: `definition of view "${database.name}.${view.name}" is only visible with the SHOW VIEW privilege`,
					target: formatName({ database: database.name, schema: schema.name, table: view.name }),
				})),
		),
	);
}

// Database-level grants may use LIKE wildcards: "_" is any character, "%" any
// sequence, and a backslash makes the next character literal. The grant
// shop\_% covers "shop_es" but not "shopXes".
function grantMatches(pattern: string, database: string): boolean {
	let regex = "^";
	for (let index = 0; index < pattern.length; index += 1) {
		const char = pattern[index]!;
		if (char === "\\" && index + 1 < pattern.length) {
			index += 1;
			regex += escapeRegExp(pattern[index]!);
		} else if (char === "_") regex += ".";
		else if (char === "%") regex += ".*";
		else regex += escapeRegExp(char);
	}
	return new RegExp(`${regex}$`, "s").test(database);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tableKey(row: { databaseName: string; tableName: string }): string {
	// \u0000 cannot appear in identifiers, so the key is unambiguous.
	return `${row.databaseName}\u0000${row.tableName}`;
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const key = keyOf(item);
		const group = groups.get(key);
		if (group === undefined) groups.set(key, [item]);
		else group.push(item);
	}
	return groups;
}
