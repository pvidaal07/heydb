// A Pi extension giving the model a schema-only MySQL server, for the
// real-agent benchmark's database strategies. Configured by the runner through
// the environment, never by the model:
//   HEYDB_BENCH_DB        {"host","port","user","password","databases":[…]}, a read-only user
//   HEYDB_BENCH_DB_TOOLS  "sql" (direct SQL) or "mcp" (a generic database MCP server)
//
// - sql: one read-only statement (SELECT, SHOW, DESCRIBE), printed as
//   `mysql --batch` prints it, at most 200 rows.
// - mcp: list_tables (names only; the databases when there are several and
//   none is given) and describe_table (DESCRIBE: field, type, null, key,
//   default, extra), what typical database MCP servers return.
import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import mysql, { type Connection, type FieldPacket, type RowDataPacket } from "mysql2/promise";

import { quoteName } from "./ddl.ts";
import { batchText, checkReadOnly } from "./sql.ts";

export const MAX_ROWS = 200;

interface Target {
	readonly host: string;
	readonly port: number;
	readonly user: string;
	readonly password: string;
	readonly databases: readonly string[];
}

type Result = AgentToolResult<Record<string, never>>;

const ok = (text: string): Result => ({ content: [{ type: "text", text }], details: {} });
const failed = (text: string): Result => ({ content: [{ type: "text", text }], details: {}, isError: true });

export default function dbExtension(pi: ExtensionAPI): void {
	const raw = process.env.HEYDB_BENCH_DB;
	if (raw === undefined || raw === "") return;
	const target = JSON.parse(raw) as Target;
	let connection: Promise<Connection> | undefined;
	const connect = () => (connection ??= mysql.createConnection({ host: target.host, port: target.port, user: target.user, password: target.password, multipleStatements: false }));
	const query = async (sql: string): Promise<{ rows: RowDataPacket[]; columns: string[] }> => {
		const [rows, fields] = await (await connect()).query<RowDataPacket[]>({ sql, timeout: 60_000 });
		return { rows: Array.isArray(rows) ? rows : [], columns: ((fields ?? []) as FieldPacket[]).map((field) => field.name) };
	};
	pi.on("session_shutdown", async () => {
		if (connection !== undefined) await (await connection).end().catch(() => undefined);
	});
	const guarded = async (work: () => Promise<string>): Promise<Result> => {
		try {
			return ok(await work());
		} catch (error) {
			return failed(error instanceof Error ? error.message : String(error));
		}
	};

	if (process.env.HEYDB_BENCH_DB_TOOLS === "sql") {
		pi.registerTool(sqlTool(query, guarded));
	} else if (process.env.HEYDB_BENCH_DB_TOOLS === "mcp") {
		const [list, describe] = mcpTools(target, query, guarded);
		pi.registerTool(list);
		pi.registerTool(describe);
	}
}

type Query = (sql: string) => Promise<{ rows: RowDataPacket[]; columns: string[] }>;
type Guarded = (work: () => Promise<string>) => Promise<Result>;

const SQL_PARAMETERS = {
	type: "object",
	properties: { query: { type: "string", description: "One SELECT, SHOW or DESCRIBE statement." } },
	required: ["query"],
	additionalProperties: false,
} as const;

function sqlTool(query: Query, guarded: Guarded): ToolDefinition<typeof SQL_PARAMETERS, Record<string, never>> {
	return {
		name: "sql",
		label: "sql",
		description: `Run one read-only SQL statement (SELECT, SHOW or DESCRIBE) on the project's MySQL server. Rows come back tab-separated, as mysql --batch prints them, at most ${MAX_ROWS}.`,
		parameters: SQL_PARAMETERS,
		executionMode: "sequential",
		async execute(_id, params) {
			const refused = checkReadOnly(params.query);
			if (refused !== null) return failed(`Refused: ${refused}.`);
			return guarded(async () => {
				const { rows, columns } = await query(params.query);
				return batchText(columns, rows, MAX_ROWS);
			});
		},
	};
}

const LIST_PARAMETERS = {
	type: "object",
	properties: { database: { type: "string", description: "Database name; omit to list the databases." } },
	additionalProperties: false,
} as const;

const DESCRIBE_PARAMETERS = {
	type: "object",
	properties: {
		table: { type: "string", description: 'Table name, or "database.table".' },
		database: { type: "string", description: "Database of the table, when the name does not say it." },
	},
	required: ["table"],
	additionalProperties: false,
} as const;

function mcpTools(target: Target, query: Query, guarded: Guarded): [ToolDefinition<typeof LIST_PARAMETERS, Record<string, never>>, ToolDefinition<typeof DESCRIBE_PARAMETERS, Record<string, never>>] {
	const only = target.databases.length === 1 ? target.databases[0] : undefined;
	const list: ToolDefinition<typeof LIST_PARAMETERS, Record<string, never>> = {
		name: "list_tables",
		label: "list_tables",
		description: "List the tables of a database. Without a database, lists the databases.",
		parameters: LIST_PARAMETERS,
		executionMode: "sequential",
		async execute(_id, params) {
			return guarded(async () => {
				const database = params.database ?? only;
				if (database === undefined) return target.databases.join("\n");
				const { rows } = await query(`SHOW TABLES FROM ${quoteName(database)}`);
				return rows.map((row) => String(Object.values(row)[0])).join("\n");
			});
		},
	};
	const describe: ToolDefinition<typeof DESCRIBE_PARAMETERS, Record<string, never>> = {
		name: "describe_table",
		label: "describe_table",
		description: "Describe a table: its columns with type, null, key, default and extra.",
		parameters: DESCRIBE_PARAMETERS,
		executionMode: "sequential",
		async execute(_id, params) {
			return guarded(async () => {
				const dot = params.table.indexOf(".");
				const database = dot > 0 ? params.table.slice(0, dot) : (params.database ?? only);
				const table = dot > 0 ? params.table.slice(dot + 1) : params.table;
				if (database === undefined) throw new Error('Several databases: pass database, or table as "database.table".');
				const { rows, columns } = await query(`DESCRIBE ${quoteName(database)}.${quoteName(table)}`);
				return batchText(columns, rows, Number.MAX_SAFE_INTEGER);
			});
		},
	};
	return [list, describe];
}
