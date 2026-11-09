// One folder per strategy, prepared once before the runs, holding that
// strategy's material and nothing else: a copy, never the measured project
// itself. Pi runs in it, so the model's built-in file tools see only it.
//
// - heydb: a heydb project with the connection's config, snapshot and notes;
//   the heydb extension with its read-only tools.
// - heydb-notes: the same, plus one note per expected table with the
//   question as asked (bench --learn's notes, the upper bound of what notes buy).
// - schema-doc: SCHEMA.md as schema-to-markdown tools write it; read, grep, find.
// - orm-schema: a Prisma-like schema.prisma; read, grep, find.
// - code: a copy of the code folder without node_modules, .git, .heydb, .env
//   files, files over 2 MB and symbolic links (as code-grep skips them); read, grep, find.
// - db, db-mcp: an empty folder; the tools reach a schema-only MySQL server
//   through bench/agent/db-extension.ts.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { saveProjectKnowledge, loadProjectKnowledge, projectKnowledgePath } from "../../lib/store/knowledge.ts";
import { openSnapshot } from "../../lib/usecases/project.ts";
import { type Question, copyProject, measure, noteAnswers } from "../measure.ts";
import { MAX_FILE_BYTES } from "../strategies/code-grep.ts";
import { prismaSchema } from "../strategies/orm-schema.ts";
import { schemaMarkdown } from "../strategies/schema-doc.ts";

export const STRATEGIES = ["heydb", "heydb-notes", "schema-doc", "orm-schema", "code", "db", "db-mcp"] as const;
export type StrategyId = (typeof STRATEGIES)[number];

export interface Source {
	/** The measured heydb project: only read. */
	readonly root: string;
	readonly connection?: string;
	readonly codeDir?: string;
	/** The questions of the run, for heydb-notes' notes. */
	readonly questions: readonly Question[];
	/** This repository, for the extensions. */
	readonly repo: string;
}

export interface Workspace {
	readonly strategy: StrategyId;
	readonly dir: string;
	/** Pi's --tools allowlist, sorted. */
	readonly tools: readonly string[];
	/** Extensions loaded with -e besides the provider's and the probe. */
	readonly extensions: readonly string[];
	/** Notes added (heydb-notes). */
	readonly notes?: number;
}

const FILE_TOOLS = ["find", "grep", "read"];
const SKIPPED_FOLDERS: ReadonlySet<string> = new Set(["node_modules", ".git", ".heydb"]);

export async function prepareWorkspace(strategy: StrategyId, source: Source, dir: string): Promise<Workspace> {
	if (strategy === "code" && source.codeDir === undefined) throw new Error("the code strategy needs --code <dir>");
	if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`workspace ${dir} is not empty`);
	mkdirSync(dir, { recursive: true });
	const heydbExtension = join(source.repo, "extensions", "heydb.ts");
	const dbExtension = join(source.repo, "bench", "agent", "db-extension.ts");
	switch (strategy) {
		case "heydb":
		case "heydb-notes": {
			const name = copyProject(source.root, dir, source.connection);
			if (existsSync(projectKnowledgePath(source.root))) saveProjectKnowledge(dir, loadProjectKnowledge(source.root));
			const tools = ["heydb_overview", "heydb_search", "heydb_table"];
			if (strategy === "heydb") return { strategy, dir, tools, extensions: [heydbExtension] };
			const notes = noteAnswers(dir, name, source.questions, await measure(dir, source.questions, name));
			return { strategy, dir, tools, extensions: [heydbExtension], notes };
		}
		case "schema-doc":
			writeFileSync(join(dir, "SCHEMA.md"), schemaMarkdown(openSnapshot(source.root, source.connection).snapshot));
			return { strategy, dir, tools: FILE_TOOLS, extensions: [] };
		case "orm-schema":
			writeFileSync(join(dir, "schema.prisma"), prismaSchema(openSnapshot(source.root, source.connection).snapshot));
			return { strategy, dir, tools: FILE_TOOLS, extensions: [] };
		case "code":
			cpSync(source.codeDir!, dir, { recursive: true, filter: (path) => path === source.codeDir || keepInCode(path) });
			return { strategy, dir, tools: FILE_TOOLS, extensions: [] };
		case "db":
			return { strategy, dir, tools: ["sql"], extensions: [dbExtension] };
		case "db-mcp":
			return { strategy, dir, tools: ["describe_table", "list_tables"], extensions: [dbExtension] };
	}
}

function keepInCode(path: string): boolean {
	const name = basename(path);
	const info = lstatSync(path);
	if (info.isSymbolicLink()) return false;
	if (info.isDirectory()) return !SKIPPED_FOLDERS.has(name);
	return info.isFile() && !name.startsWith(".env") && info.size <= MAX_FILE_BYTES;
}
