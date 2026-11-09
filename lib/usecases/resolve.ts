import { displayNameOf, formatName, parseSegments } from "../model/names.ts";
import type { Column, Snapshot, Table } from "../model/snapshot.ts";

// Agents and people rarely type canonical names. They write "orders",
// "shop.orders" (how MySQL names a table) or the full "shop.shop.orders".
// These functions turn what they typed into exactly one object, or explain
// why they cannot.
//
// Error messages stay small whatever the size of the schema: at most 10
// candidates for an ambiguous name and 5 suggestions for an unknown one.
// They name objects by display name ("shop.orders"), which is shorter and
// typed back exactly like the canonical one.
// heydb v1 listed every table when one was not found (bug #7): with 3,000
// tables, each typo cost the agent thousands of tokens.

const MAX_CANDIDATES = 10;
const MAX_SUGGESTIONS = 5;

export interface ResolvedTable {
	/** Canonical name: database.schema.table. */
	readonly name: string;
	readonly database: string;
	readonly schema: string;
	readonly table: Table;
}

export interface ResolvedColumn {
	/** Canonical name: database.schema.table.column. */
	readonly name: string;
	readonly table: ResolvedTable;
	readonly column: Column;
}

// Every addressable object once, with its segments from database to itself.
interface Entry<T> {
	readonly name: string;
	readonly segments: readonly string[];
	readonly value: T;
}

/** Accepts "table", "database.table" (or "schema.table") and "database.schema.table". */
export function resolveTable(snapshot: Snapshot, input: string): ResolvedTable {
	const segments = parseSegments(input);
	if (segments.length > 3) {
		throw new Error(`expected a table name (table, database.table or database.schema.table): got "${input}"`);
	}
	return pickOne(tableEntries(snapshot), segments, input, "table").value;
}

/** Accepts "column", "table.column", "database.table.column" and the canonical name. */
export function resolveColumn(snapshot: Snapshot, input: string): ResolvedColumn {
	const segments = parseSegments(input);
	if (segments.length > 4) {
		throw new Error(`expected a column name (column, table.column … database.schema.table.column): got "${input}"`);
	}
	const columns = tableEntries(snapshot).flatMap(({ segments: tableSegments, value: table }) =>
		table.table.columns.map((column): Entry<ResolvedColumn> => {
			const name = formatName({ database: table.database, schema: table.schema, table: table.table.name, column: column.name });
			return { name, segments: [...tableSegments, column.name], value: { name, table, column } };
		}),
	);
	return pickOne(columns, segments, input, "column").value;
}

function tableEntries(snapshot: Snapshot): Entry<ResolvedTable>[] {
	const entries: Entry<ResolvedTable>[] = [];
	for (const database of snapshot.databases) {
		for (const schema of database.schemas) {
			for (const table of schema.tables) {
				const name = formatName({ database: database.name, schema: schema.name, table: table.name });
				entries.push({
					name,
					segments: [database.name, schema.name, table.name],
					value: { name, database: database.name, schema: schema.name, table },
				});
			}
		}
	}
	return entries;
}

// Exact spelling first; only when nothing matches exactly is case ignored,
// so "Orders" and "orders" in the same database stay distinguishable.
function pickOne<T>(entries: readonly Entry<T>[], input: readonly string[], text: string, kind: string): Entry<T> {
	let matches = entries.filter((entry) => matchesTail(entry.segments, input, same));
	if (matches.length === 0) matches = entries.filter((entry) => matchesTail(entry.segments, input, sameIgnoringCase));

	const [first] = matches;
	if (first !== undefined && matches.length === 1) return first;
	if (matches.length > 1) throw ambiguous(text, kind, matches.map((entry) => entry.name).sort(compareText).map(displayNameOf));
	throw notFound(text, kind, suggestions(entries, input));
}

/**
 * Whether what was typed names this object. `segments` is [database, schema,
 * table] or [database, schema, table, column]. The typed text ends with the
 * object part ("orders", "orders.total", or just "total" for a column), and
 * may start with a prefix: one segment is the database or the schema
 * ("shop.orders": in MySQL both are "shop"; in PostgreSQL it would be
 * "public.orders"), two are both, in order.
 */
function matchesTail(
	segments: readonly string[],
	input: readonly string[],
	equal: (a: string, b: string) => boolean,
): boolean {
	const objectDepth = segments.length - 2; // 1 for a table, 2 for a column
	const prefixLength = Math.max(0, input.length - objectDepth);
	const typedObject = input.slice(prefixLength);
	const object = segments.slice(segments.length - typedObject.length);
	if (!typedObject.every((part, index) => equal(part, object[index] as string))) return false;

	const [database, schema] = segments as [string, string];
	const [first, second] = input;
	if (prefixLength === 0) return true;
	if (prefixLength === 1) return equal(first as string, database) || equal(first as string, schema);
	return prefixLength === 2 && equal(first as string, database) && equal(second as string, schema);
}

function same(a: string, b: string): boolean {
	return a === b;
}

function sameIgnoringCase(a: string, b: string): boolean {
	return a.toLowerCase() === b.toLowerCase();
}

/**
 * Up to 5 names close to what was typed. The last segment is compared, so a
 * wrong database or table prefix still finds "orders"; close means a small
 * edit distance (a typo) or one name containing the other.
 */
function suggestions<T>(entries: readonly Entry<T>[], input: readonly string[]): string[] {
	const typed = (input[input.length - 1] ?? "").toLowerCase();
	const limit = Math.min(3, Math.max(1, Math.floor(typed.length / 4)));
	const scored: { name: string; distance: number }[] = [];
	for (const entry of entries) {
		const candidate = (entry.segments[entry.segments.length - 1] ?? "").toLowerCase();
		const distance = editDistance(typed, candidate, limit);
		const contains = typed.length >= 3 && (candidate.includes(typed) || typed.includes(candidate));
		if (distance <= limit || contains) scored.push({ name: entry.name, distance });
	}
	return scored
		.sort((a, b) => a.distance - b.distance || compareText(a.name, b.name))
		.slice(0, MAX_SUGGESTIONS)
		.map((item) => displayNameOf(item.name));
}

/**
 * Levenshtein distance: how many single-character insertions, deletions or
 * substitutions turn `a` into `b`. Stops early and returns limit + 1 once the
 * answer is known to exceed `limit`, so 3,000 tables cost almost nothing.
 */
function editDistance(a: string, b: string, limit: number): number {
	if (Math.abs(a.length - b.length) > limit) return limit + 1;
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		let best = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			const value = Math.min((previous[j] as number) + 1, (current[j - 1] as number) + 1, (previous[j - 1] as number) + cost);
			current.push(value);
			best = Math.min(best, value);
		}
		if (best > limit) return limit + 1;
		previous = current;
	}
	return previous[b.length] as number;
}

function ambiguous(text: string, kind: string, names: readonly string[]): Error {
	const shown = names.slice(0, MAX_CANDIDATES).map((name) => `- ${name}`);
	const more = names.length > MAX_CANDIDATES ? [`… and ${names.length - MAX_CANDIDATES} more`] : [];
	return new Error([`"${text}" matches ${names.length} ${kind}s; use the full name:`, ...shown, ...more].join("\n"));
}

function notFound(text: string, kind: string, similar: readonly string[]): Error {
	const hint = similar.length === 0 ? "" : `. Did you mean: ${similar.join(", ")}?`;
	return new Error(`no ${kind} matches "${text}"${hint}`);
}

// Plain code-unit comparison, like the rest of heydb: never locale-dependent.
function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
