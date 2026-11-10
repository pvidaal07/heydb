// Runs Pi once, non-interactive, printing JSON events, with nothing loaded but
// what the run names: no discovered extensions, skills, context files, MCP
// servers, prompt templates or themes, and only the listed tools. A run that
// outlives its timeout is killed with its whole process group (the provider
// may run a child process of its own).
import { spawn } from "node:child_process";

/** The same for every strategy: only the tools differ. */
export const INSTRUCTIONS = [
	"You are helping a developer find where data lives in a database.",
	"Use only the tools available to you to find which database tables hold the data that answers the user's question; do not guess.",
	"Do not change anything.",
	"When you are done, end your reply with exactly one line:",
	"TABLES: table1, table2",
	"listing the bare table names (no database prefix), only the tables needed to answer the question.",
].join("\n");

export interface PiRun {
	readonly model: string;
	readonly thinking: string;
	/** Extension files, loaded in this order. */
	readonly extensions: readonly string[];
	/** Pi's --tools allowlist. */
	readonly tools: readonly string[];
	readonly prompt: string;
}

export function piArgs(run: PiRun): string[] {
	return [
		"-p",
		"--no-session",
		"--mode",
		"json",
		"--no-extensions",
		"--no-skills",
		"--no-context-files",
		"--no-mcp",
		"--no-prompt-templates",
		"--no-themes",
		"--no-approve",
		...run.extensions.flatMap((extension) => ["-e", extension]),
		"--tools",
		run.tools.join(","),
		"--model",
		run.model,
		"--thinking",
		run.thinking,
		"--append-system-prompt",
		INSTRUCTIONS,
		"--",
		run.prompt,
	];
}

export interface Spawned {
	readonly stdout: string;
	readonly stderr: string;
	readonly code: number | null;
	readonly timedOut: boolean;
	readonly ms: number;
}

export function runProcess(command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<Spawned> {
	return new Promise((resolve, reject) => {
		const start = performance.now();
		const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
		let timedOut = false;
		const kill = (signal: NodeJS.Signals) => {
			try {
				if (child.pid !== undefined) process.kill(-child.pid, signal);
			} catch {
				// already gone
			}
		};
		let hard: NodeJS.Timeout | undefined;
		const timer = setTimeout(() => {
			timedOut = true;
			kill("SIGTERM");
			hard = setTimeout(() => kill("SIGKILL"), 5000);
		}, options.timeoutMs);
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		let done = false;
		let exited: number | undefined;
		const finish = (code: number | null) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			if (hard !== undefined) clearTimeout(hard);
			resolve({ stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), code, timedOut, ms: (exited ?? performance.now()) - start });
		};
		child.on("close", finish);
		// A leftover grandchild can hold the pipes open after Pi exits: give the
		// output two seconds, then end the group.
		child.on("exit", (code) => {
			exited = performance.now();
			setTimeout(() => {
				kill("SIGKILL");
				finish(code);
			}, 2000).unref();
		});
	});
}
