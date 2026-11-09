// A generic database MCP server: no search, only `list_databases` (when there
// is more than one), `list_tables` (every table of a database, names only)
// and `describe_table`. The agent picks from names alone, so an expected
// table counts as found only by the name-pick rule (namePick). Simulated over
// the snapshot: the time is local, a real server adds a round trip per call.
import type { Located, Step } from "../measure.ts";
import { columnKey } from "./schema-doc.ts";
import { type Answer, type BenchContext, type Strategy, bare, located, namePick, rankIn, timed } from "./shared.ts";

/** DESCRIBE as such servers return it, tab-separated: Field, Type, Null, Key, Default, Extra. */
export function describeTable(entry: Located): string {
	const rows = entry.table.columns.map((column) =>
		[column.name, column.type, column.nullable ? "YES" : "NO", columnKey(entry.table, column.name), column.default ?? "NULL", column.autoIncrement ? "auto_increment" : ""].join("\t"),
	);
	return ["Field\tType\tNull\tKey\tDefault\tExtra", ...rows].join("\n");
}

export function dbMcp(ctx: BenchContext): Strategy {
	const schemas = [...new Set(ctx.tables.map((entry) => entry.schema))];
	return {
		id: "db-mcp",
		label: "DB MCP server: list_tables, describe_table",
		simulated: true,
		run: async (question): Promise<Answer> => {
			const steps: Step[] = [];
			const targets = located(ctx, question);
			const schema = targets[0]!.schema;
			if (schemas.length > 1) await timed(steps, () => ({ tool: "list_databases", args: "", text: schemas.join("\n") }));
			const listed = ctx.tables.filter((entry) => entry.schema === schema);
			await timed(steps, () => ({ tool: "list_tables", args: schema, text: listed.map((entry) => entry.table.name).join("\n") }));
			const candidates = listed.filter((entry) => namePick(entry.table.name, "", question.queries)).map((entry) => entry.table.name);
			for (const target of targets) await timed(steps, () => ({ tool: "describe_table", args: target.table.name, text: describeTable(target) }));
			return {
				steps,
				seen: question.expect.filter((expected) => candidates.includes(bare(expected))).length,
				firstRanks: question.expect.map((expected) => rankIn(candidates, bare(expected))),
			};
		},
	};
}
