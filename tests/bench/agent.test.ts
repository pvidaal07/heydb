import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, describe, test } from "node:test";

import dbExtension from "../../bench/agent/db-extension.ts";
import { schemaDdl } from "../../bench/agent/ddl.ts";
import { parseEvents } from "../../bench/agent/events.ts";
import { judge, tablesLine } from "../../bench/agent/judge.ts";
import { INSTRUCTIONS, piArgs } from "../../bench/agent/pi.ts";
import { type RunRecord, compareTokens, renderReport, summarize } from "../../bench/agent/report.ts";
import { batchText, checkReadOnly } from "../../bench/agent/sql.ts";
import { prepareWorkspace } from "../../bench/agent/workspace.ts";
import type { Question } from "../../bench/measure.ts";
import { writeSyntheticCode } from "../../bench/synthetic-code.ts";
import { saveConfig } from "../../lib/config/store.ts";
import { saveSnapshot } from "../../lib/store/snapshots.ts";
import { initProject } from "../../lib/usecases/init.ts";
import { column, customersTable, ordersTable, snapshot } from "../fixtures/snapshot.ts";

const scratch: string[] = [];
after(() => {
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	scratch.push(dir);
	return dir;
}

const usage = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({
	input,
	output,
	cacheRead,
	cacheWrite,
	totalTokens: input + output + cacheRead + cacheWrite,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

// What `pi -p --mode json` prints for a run with one tool call: a session
// header, the user message, an assistant turn calling heydb_search, the tool's
// execution, and a final assistant turn (docs/json.md, docs/message-types.md).
const SAMPLE = [
	{ type: "session", version: 3, id: "s1", timestamp: "2026-11-09T15:00:00.000Z", cwd: "/tmp/ws" },
	{ type: "agent_start" },
	{ type: "turn_start" },
	{ type: "message_end", message: { role: "user", content: [{ type: "text", text: "Dónde están los clientes" }], timestamp: 1 } },
	{ type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } },
	{ type: "message_update", usage: usage(0, 0, 0, 0), assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "c1", toolName: "heydb_search" } },
	{
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "c1", name: "heydb_search", arguments: { query: "clientes" } }],
			provider: "claude-bridge",
			model: "claude-haiku-5-5",
			usage: usage(10, 40, 0, 3000),
			stopReason: "toolUse",
			timestamp: 2,
		},
	},
	{ type: "tool_execution_start", toolCallId: "c1", toolName: "heydb_search", args: { query: "clientes" } },
	{ type: "tool_execution_end", toolCallId: "c1", toolName: "heydb_search", result: { content: [{ type: "text", text: "cli — clientes" }] }, isError: false, durationMs: 12 },
	{ type: "turn_end", message: { role: "assistant" }, toolResults: [] },
	{ type: "turn_start" },
	{
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "the cli table" },
				{ type: "text", text: "Customers live in `cli`.\nTABLES: cli" },
			],
			provider: "claude-bridge",
			model: "claude-haiku-5-5",
			usage: usage(20, 15, 3000, 100),
			stopReason: "stop",
			timestamp: 3,
		},
	},
	{ type: "agent_end", messages: [], willRetry: false },
	{ type: "agent_settled", aborted: false },
]
	.map((event) => JSON.stringify(event))
	.join("\n");

describe("parseEvents", () => {
	test("sums usage over the assistant messages, counts tool calls by name and keeps the final text", () => {
		const run = parseEvents(`${SAMPLE}\n`);
		assert.deepEqual(run.usage, { input: 30, output: 55, cacheRead: 3000, cacheWrite: 3100, total: 6185 });
		assert.equal(run.turns, 2);
		assert.deepEqual(run.toolCalls, { heydb_search: 1 });
		assert.equal(run.toolErrors, 0);
		assert.equal(run.finalText, "Customers live in `cli`.\nTABLES: cli");
		assert.equal(run.stopReason, "stop");
		assert.equal(run.firstContext, 3010);
		assert.equal(run.settled, true);
		assert.deepEqual(run.errors, []);
	});

	test("reports a provider error, a failed tool and an unparsable line, and accepts CRLF", () => {
		const lines = [
			JSON.stringify({ type: "tool_execution_end", toolCallId: "c1", toolName: "sql", result: {}, isError: true }),
			"not json",
			JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], usage: usage(5, 0, 0, 0), stopReason: "error", errorMessage: "401 unauthorized" } }),
		];
		const run = parseEvents(lines.join("\r\n"));
		assert.deepEqual(run.toolCalls, { sql: 1 });
		assert.equal(run.toolErrors, 1);
		assert.equal(run.settled, false);
		assert.deepEqual(run.errors, ["unparsable event line 2", "401 unauthorized"]);
		assert.equal(run.usage.total, 5);
	});

	test("splits only on LF: a Unicode line separator inside a string is not a record boundary", () => {
		const text = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "a b\nTABLES: x" }], usage: usage(1, 1, 0, 0), stopReason: "stop" } });
		assert.equal(parseEvents(text).finalText, "a b\nTABLES: x");
	});
});

describe("piArgs", () => {
	test("loads nothing but the named extensions, allows only the strategy's tools, and appends the same instructions", () => {
		const args = piArgs({ model: "p/m", thinking: "low", extensions: ["/bridge.ts", "/probe.ts"], tools: ["find", "grep", "read"], prompt: "-Dónde están los clientes" });
		for (const flag of ["-p", "--no-session", "--no-extensions", "--no-skills", "--no-context-files", "--no-mcp", "--no-prompt-templates", "--no-themes"]) assert.ok(args.includes(flag), flag);
		assert.deepEqual(args.slice(args.indexOf("--mode"), args.indexOf("--mode") + 2), ["--mode", "json"]);
		assert.deepEqual(args.filter((_, index) => args[index - 1] === "-e"), ["/bridge.ts", "/probe.ts"]);
		assert.equal(args[args.indexOf("--tools") + 1], "find,grep,read");
		assert.equal(args[args.indexOf("--thinking") + 1], "low");
		assert.equal(args[args.indexOf("--append-system-prompt") + 1], INSTRUCTIONS);
		assert.match(INSTRUCTIONS, /^TABLES: table1, table2$/m);
		// The question goes after "--", so one starting with "-" is never read as an option.
		assert.deepEqual(args.slice(-2), ["--", "-Dónde están los clientes"]);
	});
});

describe("tablesLine and judge", () => {
	test("reads the last TABLES line, whatever the case, spaces, quotes, markdown and database prefixes", () => {
		assert.deepEqual(tablesLine("I think\nTABLES: fac_cab, fac_ven"), ["fac_cab", "fac_ven"]);
		assert.deepEqual(tablesLine("tables:   emp_001.fac_cab ,`Fac_Ven`,  \"cli\".\"cli_dir\"."), ["fac_cab", "fac_ven", "cli_dir"]);
		assert.deepEqual(tablesLine("**TABLES:** `cli`"), ["cli"]);
		assert.deepEqual(tablesLine("TABLES: a\nmore thoughts\nTABLES: b, b"), ["b"]);
		assert.deepEqual(tablesLine("TABLES: none"), []);
		assert.deepEqual(tablesLine("TABLES:"), []);
	});

	test("a reply without the line has no answer", () => {
		assert.equal(tablesLine("The tables are fac_cab and fac_ven."), null);
		assert.equal(tablesLine(""), null);
	});

	test("correct when every expected table is named; partial credit counts the expected ones named", () => {
		assert.deepEqual(judge(["fac_cab", "fac_ven", "cli"], ["fac_cab", "emp_001.fac_ven"]), { correct: true, hits: 2, expected: 2, extra: 1 });
		assert.deepEqual(judge(["fac_ven"], ["fac_cab", "fac_ven"]), { correct: false, hits: 1, expected: 2, extra: 0 });
		assert.deepEqual(judge(["FAC_CAB"], ["fac_cab"]), { correct: true, hits: 1, expected: 1, extra: 0 });
		assert.deepEqual(judge(null, ["fac_cab"]), { correct: false, hits: 0, expected: 1, extra: 0 });
	});
});

function record(strategy: string, question: string, total: number, overrides: Partial<RunRecord> = {}): RunRecord {
	return {
		strategy,
		question,
		repeat: 1,
		model: "m",
		usage: { input: total / 2, output: total / 4, cacheRead: total / 4, cacheWrite: 0, total },
		toolCalls: { grep: 1 },
		toolErrors: 0,
		turns: 2,
		ms: 1000,
		tablesLine: "TABLES: x",
		named: ["x"],
		correct: true,
		hits: 1,
		expected: 1,
		extra: 0,
		firstContext: 100,
		error: null,
		probe: null,
		...overrides,
	};
}

describe("report math", () => {
	test("% fewer tokens only over the questions both strategies answered, averaging repeats", () => {
		const records = [
			record("heydb", "q1", 100),
			record("heydb", "q1", 300, { repeat: 2 }),
			record("heydb", "q2", 100),
			record("heydb", "q3", 999_999),
			record("code", "q1", 1000),
			record("code", "q2", 600),
		];
		// q3 has no code run: left out. heydb: q1 mean 200 + q2 100 = 300; code: 1000 + 600 = 1600.
		const comparison = compareTokens(records, "heydb", "code");
		assert.deepEqual(comparison, { questions: 2, a: 300, b: 1600, percent: (1 - 300 / 1600) * 100 });
		assert.equal(compareTokens(records, "heydb", "db"), null);
	});

	test("summarize totals tokens, calls, time and accuracy per strategy, with repeat spread", () => {
		const records = [
			record("heydb", "q1", 100, { toolCalls: { heydb_search: 2, heydb_table: 1 } }),
			record("heydb", "q2", 300, { correct: false, hits: 1, expected: 2, named: ["x"] }),
			record("heydb", "q1", 200, { repeat: 2 }),
			record("heydb", "q2", 400, { repeat: 2, error: "timeout after 300 s", correct: false, hits: 0, named: null, tablesLine: null }),
		];
		const [summary] = summarize(records);
		assert.equal(summary?.strategy, "heydb");
		assert.equal(summary?.runs, 4);
		assert.equal(summary?.tokens.total, 1000);
		assert.equal(summary?.toolCalls, 6);
		assert.equal(summary?.correct, 2);
		assert.equal(summary?.hits, 3);
		assert.equal(summary?.expected, 5);
		assert.equal(summary?.errors, 1);
		assert.deepEqual(summary?.perRepeat, { mean: 500, min: 400, max: 600 });
	});

	test("the report states the comparison and never divides by an empty strategy", () => {
		const text = renderReport([record("heydb", "q1", 100), record("schema-doc", "q1", 400), record("db", "q2", 50)], { model: "m", thinking: "low", timeoutSeconds: 300, questions: 2 });
		assert.match(text, /\| heydb vs schema-doc \| 1 \| ≈100 \| ≈400 \| 75% fewer \|/);
		assert.doesNotMatch(text, /heydb vs db \|/);
		assert.doesNotMatch(text, /NaN|Infinity/);
	});
});

describe("checkReadOnly", () => {
	test("accepts SELECT, SHOW, DESCRIBE and DESC, with one trailing semicolon and comments", () => {
		for (const sql of [
			"SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_COMMENT LIKE '%cliente%'",
			"  show tables from emp_001;",
			"DESCRIBE emp_001.cli",
			"desc cli",
			"-- tables\nSELECT 1",
			"SELECT 'DROP TABLE x; DELETE' AS a",
			"(SELECT 1)",
		]) {
			assert.equal(checkReadOnly(sql), null, sql);
		}
	});

	test("rejects writes, settings, multi-statements, INTO and executable comments", () => {
		for (const sql of [
			"INSERT INTO cli VALUES (1)",
			"UPDATE cli SET nom_cli = 'x'",
			"DELETE FROM cli",
			"DROP TABLE cli",
			"ALTER TABLE cli ADD x int",
			"CREATE TABLE x (a int)",
			"SET @a = 1",
			"SELECT 1; DROP TABLE cli",
			"SELECT 1;;",
			"SELECT * FROM cli INTO OUTFILE '/tmp/x'",
			"SELECT 1 /*!50000 , (DELETE FROM cli) */",
			"WITH x AS (SELECT 1) UPDATE cli SET a = 1",
			"",
		]) {
			assert.notEqual(checkReadOnly(sql), null, sql);
		}
	});

	test("batchText prints mysql --batch text: header, tabs, NULL, escapes, a cap with what is left", () => {
		const rows = [
			{ a: 1, b: null },
			{ a: 2, b: "x\ty\nz\\" },
			{ a: 3, b: "w" },
		];
		assert.equal(batchText(["a", "b"], rows, 10), "a\tb\n1\tNULL\n2\tx\\ty\\nz\\\\\n3\tw");
		assert.equal(batchText(["a", "b"], rows, 2), "a\tb\n1\tNULL\n2\tx\\ty\\nz\\\\\n… 1 more rows");
		assert.equal(batchText(["a"], [], 10), "Empty set");
	});
});

describe("db extension", () => {
	type Tool = { name: string; execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean }> };
	function register(mode: string): Map<string, Tool> {
		const tools = new Map<string, Tool>();
		const pi = { registerTool: (tool: Tool) => tools.set(tool.name, tool), on: () => undefined };
		const saved = { db: process.env.HEYDB_BENCH_DB, mode: process.env.HEYDB_BENCH_DB_TOOLS };
		process.env.HEYDB_BENCH_DB = JSON.stringify({ host: "127.0.0.1", port: 1, user: "u", password: "p", databases: ["shop"] });
		process.env.HEYDB_BENCH_DB_TOOLS = mode;
		try {
			dbExtension(pi as unknown as Parameters<typeof dbExtension>[0]);
		} finally {
			for (const [key, value] of [["HEYDB_BENCH_DB", saved.db], ["HEYDB_BENCH_DB_TOOLS", saved.mode]] as const) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
		return tools;
	}

	test("each mode registers only its own tools", () => {
		assert.deepEqual([...register("sql").keys()], ["sql"]);
		assert.deepEqual([...register("mcp").keys()].sort(), ["describe_table", "list_tables"]);
	});

	test("sql refuses a write before reaching any server", async () => {
		const result = await register("sql").get("sql")!.execute("id", { query: "DROP TABLE shop.orders" });
		assert.equal(result.isError, true);
		assert.equal(result.content[0]?.text, "Refused: only SELECT, SHOW and DESCRIBE are allowed.");
	});
});

describe("schemaDdl", () => {
	test("writes CREATE DATABASE, CREATE TABLE with types, keys, comments and engine, then foreign keys", () => {
		const customers = { ...customersTable(), comment: "Clientes de la 'tienda'", storageEngine: "MyISAM" };
		const orders = {
			...ordersTable(),
			columns: [
				column("id", 1, { autoIncrement: true }),
				column("customer_id", 2, { comment: "Cliente" }),
				column("total", 3, { type: "decimal(10,2)", nullable: true, default: "0.00" }),
				column("status", 4, { type: "varchar(10)", default: "new" }),
				column("created", 5, { type: "datetime", default: "CURRENT_TIMESTAMP" }),
			],
			indexes: [
				{ name: "idx_customer", columns: ["customer_id"], unique: false, method: "BTREE" },
				{ name: "uq_status", columns: ["status", "created"], unique: true, method: "BTREE" },
			],
		};
		const plan = schemaDdl(snapshot([customers, orders]));
		assert.deepEqual(plan.databases, ["shop"]);
		assert.deepEqual(
			plan.statements.map((statement) => [statement.kind, statement.target]),
			[
				["database", "shop"],
				["table", "shop.customers"],
				["table", "shop.orders"],
				["foreign-key", "shop.orders.fk_orders_customer"],
			],
		);
		assert.equal(plan.statements[0]?.sql, "CREATE DATABASE `shop`");
		assert.equal(
			plan.statements[1]?.sql,
			"CREATE TABLE `shop`.`customers` (\n  `id` int NOT NULL,\n  `email` varchar(255) NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=MyISAM COMMENT='Clientes de la \\'tienda\\''",
		);
		assert.equal(
			plan.statements[2]?.sql,
			[
				"CREATE TABLE `shop`.`orders` (",
				"  `id` int NOT NULL AUTO_INCREMENT,",
				"  `customer_id` int NOT NULL COMMENT 'Cliente',",
				"  `total` decimal(10,2) NULL DEFAULT 0.00,",
				"  `status` varchar(10) NOT NULL DEFAULT 'new',",
				"  `created` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,",
				"  PRIMARY KEY (`id`),",
				"  KEY `idx_customer` (`customer_id`),",
				"  UNIQUE KEY `uq_status` (`status`, `created`)",
				") ENGINE=InnoDB",
			].join("\n"),
		);
		assert.equal(
			plan.statements[3]?.sql,
			"ALTER TABLE `shop`.`orders` ADD CONSTRAINT `fk_orders_customer` FOREIGN KEY (`customer_id`) REFERENCES `shop`.`customers` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE",
		);
		// The fallback keeps names, types, keys and comments, without defaults or secondary indexes.
		assert.equal(
			plan.statements[2]?.fallback,
			[
				"CREATE TABLE `shop`.`orders` (",
				"  `id` int NOT NULL AUTO_INCREMENT,",
				"  `customer_id` int NOT NULL COMMENT 'Cliente',",
				"  `total` decimal(10,2) NULL,",
				"  `status` varchar(10) NOT NULL,",
				"  `created` datetime NOT NULL,",
				"  PRIMARY KEY (`id`)",
				") ENGINE=InnoDB",
			].join("\n"),
		);
	});

	test("views come after the tables; a view whose definition is hidden is skipped and counted", () => {
		const view = { ...customersTable(), name: "active", kind: "view" as const, storageEngine: null, primaryKey: [], viewDefinition: "select `id` from `shop`.`customers`" };
		const hidden = { ...view, name: "secret", viewDefinition: null };
		const plan = schemaDdl(snapshot([view, hidden, customersTable()]));
		assert.deepEqual(
			plan.statements.map((statement) => statement.target),
			["shop", "shop.customers", "shop.active"],
		);
		assert.equal(plan.statements[2]?.sql, "CREATE VIEW `shop`.`active` AS select `id` from `shop`.`customers`");
		assert.deepEqual(plan.skipped, [{ target: "shop.secret", reason: "view definition not captured" }]);
	});

	test("a PostgreSQL snapshot has no MySQL DDL", () => {
		assert.throws(() => schemaDdl(snapshot([ordersTable()], { engine: { kind: "postgresql", version: "16" } })), /MySQL or MariaDB/);
	});
});

/** Every file under a folder with a hash of its content and its mtime, to prove nothing was written. */
function fingerprint(root: string): Map<string, string> {
	const files = new Map<string, string>();
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else files.set(relative(root, path), `${statSync(path).mtimeMs}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
		}
	};
	walk(root);
	return files;
}

describe("prepareWorkspace", () => {
	const questions: Question[] = [{ id: "customers", ask: "Dónde están los clientes", queries: ["clientes"], expect: ["customers"] }];

	function source(): { root: string; code: string } {
		const root = temp("heydb-agent-src-");
		initProject(root);
		const erp = { engine: "mysql" as const, host: "127.0.0.1", port: 3306, user: "bench", password: "env:HEYDB_BENCH_PASSWORD", databases: null };
		saveConfig(root, { formatVersion: 1, defaultConnection: "erp", connections: { erp } });
		saveSnapshot(root, "erp", snapshot([{ ...customersTable(), comment: "Clientes" }, ordersTable()]));
		writeFileSync(join(root, ".heydb", ".env"), "HEYDB_BENCH_PASSWORD=secret\n");
		const code = join(root, "src");
		writeSyntheticCode(code);
		writeFileSync(join(code, ".env"), "DB_PASSWORD=secret\n");
		mkdirSync(join(code, ".heydb"));
		writeFileSync(join(code, ".heydb", "config.json"), "{}");
		return { root, code };
	}

	test("each strategy gets only its own material, and the source project is never written", async () => {
		const { root, code } = source();
		const before = fingerprint(root);
		const into = temp("heydb-agent-ws-");
		const repo = join(import.meta.dirname, "..", "..");
		const ws = async (id: Parameters<typeof prepareWorkspace>[0]) =>
			prepareWorkspace(id, { root, connection: "erp", codeDir: code, questions, repo }, join(into, id));

		const heydb = await ws("heydb");
		assert.deepEqual(heydb.tools, ["heydb_overview", "heydb_search", "heydb_table"]);
		assert.deepEqual(heydb.extensions, [join(repo, "extensions", "heydb.ts")]);
		assert.deepEqual(readdirSync(heydb.dir), [".heydb"]);
		assert.ok(existsSync(join(heydb.dir, ".heydb", "snapshots", "erp.json.gz")));
		assert.ok(existsSync(join(heydb.dir, ".heydb", "config.json")));
		assert.equal(existsSync(join(heydb.dir, ".heydb", ".env")), false, "secrets are not copied");

		const notes = await ws("heydb-notes");
		const knowledge = readFileSync(join(notes.dir, ".heydb", "knowledge", "erp.json"), "utf8");
		assert.match(knowledge, /Dónde están los clientes/);
		assert.equal(notes.notes, 1);

		const doc = await ws("schema-doc");
		assert.deepEqual(readdirSync(doc.dir), ["SCHEMA.md"]);
		assert.deepEqual(doc.tools, ["find", "grep", "read"]);
		assert.match(readFileSync(join(doc.dir, "SCHEMA.md"), "utf8"), /## shop\.customers|## customers/);

		const orm = await ws("orm-schema");
		assert.deepEqual(readdirSync(orm.dir), ["schema.prisma"]);
		assert.match(readFileSync(join(orm.dir, "schema.prisma"), "utf8"), /@@map\("customers"\)/);

		const tree = await ws("code");
		assert.deepEqual(tree.tools, ["find", "grep", "read"]);
		assert.ok(existsSync(join(tree.dir, "app", "Clientes.php")));
		assert.equal(existsSync(join(tree.dir, ".env")), false, "secrets are not copied");
		assert.equal(existsSync(join(tree.dir, ".heydb")), false, "heydb's notes are not code");
		assert.equal(existsSync(join(tree.dir, "node_modules")), false);

		const sql = await ws("db");
		assert.deepEqual(sql.tools, ["sql"]);
		assert.deepEqual(readdirSync(sql.dir), []);
		const mcp = await ws("db-mcp");
		assert.deepEqual(mcp.tools, ["describe_table", "list_tables"]);
		assert.deepEqual(mcp.extensions, [join(repo, "bench", "agent", "db-extension.ts")]);

		assert.deepEqual(fingerprint(root), before);
	});

	test("the code strategy needs a code folder", async () => {
		const { root } = source();
		await assert.rejects(prepareWorkspace("code", { root, connection: "erp", questions, repo: "/x" }, join(temp("heydb-agent-ws-"), "code")), /--code/);
	});
});
