// What /heydb:learn-code would send the agent, without any model: the tables
// it lists, in order, the code and docs given as evidence for each, and the
// size of the message in tokens.
//
//   node bench/learn-code.ts --project ../app [--connection erp] [--code ../legacy-app] [--message] [--json]
//
// The project (its connection's config, snapshot and notes) and the code
// folder (the project's folder unless --code names another) are copied to a
// temporary folder first and scanned there: the folders measured are only
// read. The copy skips .git, node_modules, .heydb and .env files. The output
// names real tables: keep it out of this repository.
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { learnMessage } from "../extensions/commands.ts";
import { loadKnowledge } from "../lib/store/knowledge.ts";
import { loadSnapshot } from "../lib/store/snapshots.ts";
import { type SchemaUsage, findSchemaUsage } from "../lib/usecases/code-scan.ts";
import { openProjectRoot } from "../lib/usecases/project.ts";
import { copyProject, tokens } from "./measure.ts";

export interface LearnCodeOptions {
	readonly connection?: string;
	/** Another folder holding the code, as /heydb:learn-code [connection] [path] reads it. */
	readonly code?: string;
}

export interface LearnCodePreview {
	readonly connection: string;
	readonly usage: SchemaUsage;
	/** The message the agent would receive, word for word. */
	readonly message: string;
	/** Its size: characters / 4. */
	readonly tokens: number;
}

/** Never copied: history, dependencies, heydb's own files (secrets included) and environment files. */
const NOT_COPIED = new Set([".git", "node_modules", ".heydb"]);

export async function previewLearnCode(projectDir: string, options: LearnCodeOptions = {}): Promise<LearnCodePreview> {
	const codeSource = realpathSync(options.code ?? openProjectRoot(projectDir));
	const scratch = mkdtempSync(join(tmpdir(), "heydb-bench-learn-code-"));
	try {
		const project = join(scratch, "project");
		const code = join(scratch, "code");
		mkdirSync(project);
		const connection = copyProject(projectDir, project, options.connection);
		cpSync(codeSource, code, {
			recursive: true,
			filter: (path) => !NOT_COPIED.has(basename(path)) && !basename(path).startsWith(".env"),
		});
		const snapshot = loadSnapshot(project, connection);
		if (snapshot === null) throw new Error(`connection "${connection}" has no stored snapshot`);
		const usage = await findSchemaUsage(code, snapshot, { knowledge: loadKnowledge(project, connection) });
		const folder = options.code === undefined ? undefined : { root: codeSource, typed: options.code };
		const message = learnMessage(connection, usage, folder);
		return { connection, usage, message, tokens: tokens(message.length) };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

export function renderPreview({ connection, usage, tokens: size }: LearnCodePreview): string {
	const header =
		`learn-code ${connection}: ${usage.filesScanned} code files and ${usage.docsScanned} docs read, ` +
		`${usage.tablesMatched} tables used or defined, ${usage.matches.length} listed, message ≈${size} tokens` +
		(usage.truncated ? " (a scan limit stopped it: more code may use these tables)" : "");
	const rows = usage.matches.map(
		(match, index) =>
			`| ${index + 1} | ${match.table} | ${match.described} | ${match.cryptic ? "yes" : "no"} | ${match.referenced} | ${match.hits} | ` +
			`${match.files.join(", ")} | ${match.docs.join(", ")} |`,
	);
	return [
		header,
		"",
		"| # | table | described by | cryptic | referenced | uses | code | docs |",
		"|---|---|---|---|---|---|---|---|",
		...rows,
	].join("\n");
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			project: { type: "string" },
			connection: { type: "string" },
			code: { type: "string" },
			message: { type: "boolean", default: false },
			json: { type: "boolean", default: false },
		},
	});
	if (values.project === undefined) throw new Error("usage: node bench/learn-code.ts --project <dir> [--connection name] [--code <dir>] [--message] [--json]");
	const preview = await previewLearnCode(resolve(values.project), {
		...(values.connection === undefined ? {} : { connection: values.connection }),
		...(values.code === undefined ? {} : { code: resolve(values.code) }),
	});
	if (values.json) console.log(JSON.stringify(preview, null, "\t"));
	else console.log(values.message ? `${renderPreview(preview)}\n\n${preview.message}` : renderPreview(preview));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
