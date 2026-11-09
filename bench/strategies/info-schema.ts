// The two information_schema baselines the benchmark started with, as
// strategies. Simulated over the snapshot with `mysql --batch` output: the
// time is local, a real server adds a round trip per call.
//
// - guided: list the databases, list one database's tables with their
//   comments, then the columns of the expected tables. Optimistic: it reads
//   the right tables whatever it picked; "found" counts the picks the
//   name-pick rule allows (names and the listed comments).
// - columns of every table: one SELECT over information_schema.columns.
import { columnsDump, databasesList, type Step, tablesList } from "../measure.ts";
import { type Answer, type BenchContext, type Strategy, bare, located, namePick, rankIn, timed } from "./shared.ts";

export function infoSchemaGuided(ctx: BenchContext): Strategy {
	return {
		id: "info-schema-guided",
		label: "SQL: databases, tables, columns",
		simulated: true,
		run: async (question): Promise<Answer> => {
			const steps: Step[] = [];
			const targets = located(ctx, question);
			const schema = targets[0]!.schema;
			await timed(steps, () => ({ tool: "sql databases", args: "", text: databasesList(ctx.tables) }));
			await timed(steps, () => ({ tool: "sql tables", args: schema, text: tablesList(ctx.tables, schema) }));
			await timed(steps, () => ({ tool: "sql columns", args: targets.map((target) => target.table.name).join(", "), text: columnsDump(targets, false) }));
			const candidates = ctx.tables
				.filter((entry) => entry.schema === schema && namePick(entry.table.name, entry.table.comment, question.queries))
				.map((entry) => entry.table.name);
			return {
				steps,
				seen: question.expect.filter((expected) => candidates.includes(bare(expected))).length,
				firstRanks: question.expect.map((expected) => rankIn(candidates, bare(expected))),
			};
		},
	};
}

export function infoSchemaColumns(ctx: BenchContext): Strategy {
	return {
		id: "info-schema-columns",
		label: "SQL: columns of every table",
		simulated: true,
		run: async (question): Promise<Answer> => {
			const steps: Step[] = [];
			await timed(steps, () => ({ tool: "sql columns", args: "*", text: columnsDump(ctx.tables, true) }));
			return { steps, seen: question.expect.length, firstRanks: null };
		},
	};
}
