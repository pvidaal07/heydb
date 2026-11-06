import type { Knowledge } from "./knowledge/types.ts";
import { formatDatabaseName, formatName, parseName } from "./model/names.ts";
import type { Snapshot, Table } from "./model/snapshot.ts";

// Search over the stored snapshot and knowledge; it never touches the server.
//
// Matching ignores case and accents on both sides: Spanish legacy schemas mix
// "facturacion" and "facturación", "año" and "ano", and nobody remembers which
// one a table used. Text is decomposed (NFD: "ó" becomes "o" plus a combining
// accent), the combining marks are dropped, and the rest is lowercased.
//
// Ranking, best first: exact name, name prefix, name contains, then any other
// text (comments, view definitions, notes). Inside one rank: databases,
// tables, views, columns, relationships, then by name. Each object appears
// once, with its best match; every note that matches is its own result.

export type SearchObject = "database" | "table" | "view" | "column" | "relationship";
export type SearchMatch = "name" | "comment" | "definition" | "annotation" | "relationship";

export interface SearchResult {
	/** Canonical name; for a relationship, "from(columns) → to(columns)". */
	readonly target: string;
	readonly object: SearchObject;
	readonly matchedIn: SearchMatch;
	/** At most SNIPPET_LENGTH characters of the matched text, around the match. */
	readonly snippet: string;
}

export interface SearchResults {
	/** The best `limit` results. */
	readonly results: readonly SearchResult[];
	/** How many matched in total, so callers can say "showing 20 of 87". */
	readonly total: number;
}

export const SNIPPET_LENGTH = 120;

const OBJECT_ORDER: readonly SearchObject[] = ["database", "table", "view", "column", "relationship"];
const MATCH_ORDER: readonly SearchMatch[] = ["name", "comment", "definition", "annotation", "relationship"];
const OTHER_TEXT = 3; // rank of any match that is not in the name

/** Lowercase and without accents: "Facturación" becomes "facturacion". */
export function normalizeText(text: string): string {
	return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export function searchSchema(
	snapshot: Snapshot,
	knowledge: Knowledge,
	query: string,
	{ limit = 20 }: { readonly limit?: number } = {},
): SearchResults {
	const needle = normalizeText(collapse(query));
	if (needle === "") throw new Error("search query must not be empty");

	const found: Ranked[] = [];
	// An object's candidate texts in order of preference; only the best match is kept.
	const object = (target: string, kind: SearchObject, name: string, texts: [SearchMatch, string][]) => {
		const rank = nameRank(name, needle);
		if (rank !== null) {
			found.push({ rank, result: { target, object: kind, matchedIn: "name", snippet: name } });
			return;
		}
		for (const [matchedIn, text] of texts) {
			const snippet = snippetAround(text, needle);
			if (snippet !== null) {
				found.push({ rank: OTHER_TEXT, result: { target, object: kind, matchedIn, snippet } });
				return;
			}
		}
	};

	const kinds = new Map<string, Table["kind"]>();
	for (const database of snapshot.databases) {
		object(formatDatabaseName(database.name), "database", database.name, []);
		for (const schema of database.schemas) {
			for (const table of schema.tables) {
				const ref = { database: database.name, schema: schema.name, table: table.name };
				const tableName = formatName(ref);
				kinds.set(tableName, table.kind);
				object(tableName, table.kind, table.name, [
					["comment", table.comment],
					["definition", table.viewDefinition ?? ""],
				]);
				for (const column of table.columns) {
					object(formatName({ ...ref, column: column.name }), "column", column.name, [["comment", column.comment]]);
				}
			}
		}
	}

	for (const annotation of knowledge.annotations) {
		const snippet = snippetAround(annotation.text, needle);
		if (snippet === null) continue;
		const ref = parseName(annotation.target);
		const kind: SearchObject =
			ref.table === undefined ? "database" : ref.column !== undefined ? "column" : (kinds.get(annotation.target) ?? "table");
		found.push({ rank: OTHER_TEXT, result: { target: annotation.target, object: kind, matchedIn: "annotation", snippet } });
	}

	for (const relationship of knowledge.relationships) {
		const snippet = snippetAround(relationship.note, needle);
		if (snippet === null) continue;
		const side = ({ table, columns }: { table: string; columns: readonly string[] }) => `${table}(${columns.join(", ")})`;
		const target = `${side(relationship.from)} → ${side(relationship.to)}`;
		found.push({ rank: OTHER_TEXT, result: { target, object: "relationship", matchedIn: "relationship", snippet } });
	}

	found.sort(compareRanked);
	return { results: found.slice(0, Math.max(0, limit)).map((item) => item.result), total: found.length };
}

interface Ranked {
	readonly rank: number;
	readonly result: SearchResult;
}

function nameRank(name: string, needle: string): number | null {
	const normalized = normalizeText(name);
	if (normalized === needle) return 0;
	if (normalized.startsWith(needle)) return 1;
	if (normalized.includes(needle)) return 2;
	return null;
}

/**
 * The part of `text` around the first match, at most SNIPPET_LENGTH
 * characters including the "…" that mark cut ends; null when nothing matches.
 * Matching happens on the normalized text, but the snippet is cut from the
 * original, so accents are shown as written.
 */
function snippetAround(raw: string, needle: string): string | null {
	const text = collapse(raw);
	// normalized[i] came from text[origin[i]]: removing accents changes lengths.
	let normalized = "";
	const origin: number[] = [];
	let index = 0;
	for (const character of text) {
		const part = normalizeText(character);
		normalized += part;
		for (let unit = 0; unit < part.length; unit++) origin.push(index);
		index += character.length;
	}
	origin.push(text.length);

	const at = normalized.indexOf(needle);
	if (at === -1) return null;
	if (text.length <= SNIPPET_LENGTH) return text;

	const matchStart = origin[at] as number;
	const room = SNIPPET_LENGTH - 2; // two characters kept for the "…" at each end
	const start = Math.max(0, Math.min(matchStart - 40, text.length - room));
	const end = Math.min(text.length, start + room);
	return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/** Line breaks and runs of spaces become one space: a snippet is one line. */
function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function compareRanked(a: Ranked, b: Ranked): number {
	return (
		a.rank - b.rank ||
		OBJECT_ORDER.indexOf(a.result.object) - OBJECT_ORDER.indexOf(b.result.object) ||
		compareText(a.result.target, b.result.target) ||
		MATCH_ORDER.indexOf(a.result.matchedIn) - MATCH_ORDER.indexOf(b.result.matchedIn) ||
		compareText(a.result.snippet, b.result.snippet)
	);
}

// Plain code-unit comparison: the same order on every machine and locale.
function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
