// Direct SQL as a capable agent writes it, simulated over the snapshot with
// what `mysql --batch` prints. Per query, one call with two statements: the
// tables whose name or comment is LIKE '%word%' for any of the query's words,
// and the same over columns; then the columns of the chosen tables. LIKE
// ignores case and accents, as the usual _ci collations do. Rows come in the
// order the snapshot keeps the tables, standing for the order a server
// returns them in (it promises none without ORDER BY). Each statement has
// LIMIT 100, as a careful agent writes. The time is the simulation's on this
// machine: a real server adds a network round trip per call.
import { normalizeText } from "../../lib/search.ts";
import { columnsDump, type Located, tablesList } from "../measure.ts";
import { MAX_LINES, type BenchContext, type Output, type Strategy, grepWords, searchThenRead } from "./shared.ts";

/**
 * SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_COMMENT FROM information_schema.tables
 *   WHERE table_name LIKE '%w%' OR table_comment LIKE '%w%' … LIMIT 100;
 * SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, COLUMN_COMMENT FROM information_schema.columns
 *   WHERE column_name LIKE '%w%' OR column_comment LIKE '%w%' … LIMIT 100;
 * An empty result prints nothing, not even its header.
 */
export function likeSearch(tables: readonly Located[], words: readonly string[]): { text: string; named: string[] } {
	const wanted = words.map(normalizeText);
	const like = (...texts: string[]) => texts.some((text) => wanted.some((word) => normalizeText(text).includes(word)));
	const tableRows = tables.filter((entry) => like(entry.table.name, entry.table.comment)).slice(0, MAX_LINES);
	const columnRows = tables
		.flatMap((entry) => entry.table.columns.filter((column) => like(column.name, column.comment)).map((column) => ({ entry, column })))
		.slice(0, MAX_LINES);
	const parts: string[] = [];
	if (tableRows.length > 0) {
		parts.push(["TABLE_SCHEMA\tTABLE_NAME\tTABLE_COMMENT", ...tableRows.map((entry) => `${entry.schema}\t${entry.table.name}\t${entry.table.comment}`)].join("\n"));
	}
	if (columnRows.length > 0) {
		parts.push(
			[
				"TABLE_SCHEMA\tTABLE_NAME\tCOLUMN_NAME\tCOLUMN_COMMENT",
				...columnRows.map(({ entry, column }) => `${entry.schema}\t${entry.table.name}\t${column.name}\t${column.comment}`),
			].join("\n"),
		);
	}
	const named = [...new Set([...tableRows, ...columnRows.map((row) => row.entry)].map((entry) => entry.table.name))];
	return { text: parts.join("\n"), named };
}

export function dbSmart(ctx: BenchContext): Strategy {
	return {
		id: "db-smart",
		label: "SQL: LIKE on names and comments, then columns",
		simulated: true,
		run: (question) =>
			searchThenRead(ctx, question, {
				lookup: ctx.lookup,
				search: (query): Output => ({ tool: "sql like", args: query, ...likeSearch(ctx.tables, grepWords(query)) }),
				// It lists the tables of the right database, as generous as the guided baseline.
				fallback: (targets) => ({
					calls: [() => ({ tool: "sql tables", args: targets[0]!.schema, text: tablesList(ctx.tables, targets[0]!.schema) })],
					definitions: false,
				}),
				read: (targets) => [() => ({ tool: "sql columns", args: targets.map((target) => target.table.name).join(", "), text: columnsDump(targets, false) })],
			}),
	};
}
