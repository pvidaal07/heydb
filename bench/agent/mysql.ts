// A throwaway MySQL server in docker for the database strategies: started on
// a free local port with its data in tmpfs, loaded with the snapshot's schema
// (no rows), given a read-only user, and removed afterwards (--rm, then stop).
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

import mysql, { type Connection } from "mysql2/promise";

import { type DdlPlan, quoteText } from "./ddl.ts";

const run = promisify(execFile);

export interface MysqlServer {
	readonly container: string;
	readonly host: string;
	readonly port: number;
	readonly rootPassword: string;
	stop(): Promise<void>;
}

/** null when docker answers; otherwise why it cannot be used. */
export async function dockerProblem(): Promise<string | null> {
	try {
		await run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 20_000 });
		return null;
	} catch (error) {
		return `docker is not available (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`;
	}
}

export async function startMysql(image: string, readyTimeoutMs = 180_000): Promise<MysqlServer> {
	const container = `heydb-agent-bench-${randomBytes(4).toString("hex")}`;
	const rootPassword = randomBytes(12).toString("hex");
	await run("docker", ["run", "-d", "--rm", "--name", container, "-e", `MYSQL_ROOT_PASSWORD=${rootPassword}`, "-p", "127.0.0.1::3306", "--tmpfs", "/var/lib/mysql", image, "--performance-schema=OFF"], { timeout: 120_000 });
	const stop = async () => {
		await run("docker", ["stop", container], { timeout: 60_000 }).catch(() => run("docker", ["rm", "-f", container]).catch(() => undefined));
	};
	try {
		const { stdout } = await run("docker", ["port", container, "3306/tcp"]);
		const port = Number(/:(\d+)\s*$/m.exec(stdout)?.[1]);
		if (!Number.isInteger(port)) throw new Error(`no port published for ${container}: ${stdout}`);
		const server = { container, host: "127.0.0.1", port, rootPassword, stop };
		const deadline = Date.now() + readyTimeoutMs;
		for (;;) {
			try {
				const connection = await rootConnection(server);
				await connection.query("SELECT 1");
				await connection.end();
				return server;
			} catch (error) {
				if (Date.now() > deadline) throw new Error(`MySQL in ${container} not ready after ${readyTimeoutMs / 1000} s: ${error instanceof Error ? error.message : error}`);
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
		}
	} catch (error) {
		await stop();
		throw error;
	}
}

function rootConnection(server: Pick<MysqlServer, "host" | "port" | "rootPassword">): Promise<Connection> {
	return mysql.createConnection({ host: server.host, port: server.port, user: "root", password: server.rootPassword, multipleStatements: false, connectTimeout: 5000 });
}

export interface LoadStats {
	readonly databases: number;
	readonly tables: number;
	/** Tables created only with their fallback (no defaults, generated expressions or secondary indexes). */
	readonly simplified: number;
	readonly views: number;
	readonly foreignKeys: number;
	readonly skipped: readonly { readonly target: string; readonly reason: string }[];
}

/**
 * Runs the plan, one statement at a time, as root, with the legacy-friendly
 * session the captured server most likely had (no strict mode, foreign key
 * checks off). A statement that fails tries its fallback; what fails both is
 * skipped and counted.
 */
export async function loadSchema(server: MysqlServer, plan: DdlPlan, progress?: (done: number, total: number) => void): Promise<LoadStats> {
	const connection = await rootConnection(server);
	try {
		await connection.query("SET SESSION sql_mode = ''");
		await connection.query("SET SESSION foreign_key_checks = 0");
		const skipped = [...plan.skipped];
		const created = { database: 0, table: 0, view: 0, "foreign-key": 0 };
		let simplified = 0;
		for (const [index, statement] of plan.statements.entries()) {
			try {
				await connection.query(statement.sql);
				created[statement.kind] += 1;
			} catch (error) {
				if (statement.fallback !== undefined) {
					try {
						await connection.query(statement.fallback);
						created[statement.kind] += 1;
						simplified += 1;
						continue;
					} catch {
						// fall through: report the first error
					}
				}
				skipped.push({ target: statement.target, reason: error instanceof Error ? error.message : String(error) });
			}
			if (progress !== undefined && (index + 1) % 500 === 0) progress(index + 1, plan.statements.length);
		}
		return { databases: created.database, tables: created.table, simplified, views: created.view, foreignKeys: created["foreign-key"], skipped };
	} finally {
		await connection.end();
	}
}

/** A user that can read the benchmark databases' structure and nothing else: SELECT and SHOW VIEW on them. */
export async function createReader(server: MysqlServer, databases: readonly string[]): Promise<{ user: string; password: string }> {
	const user = "heydb_bench";
	const password = randomBytes(12).toString("hex");
	const connection = await rootConnection(server);
	try {
		await connection.query(`CREATE USER ${quoteText(user)}@'%' IDENTIFIED BY ${quoteText(password)}`);
		// "_" and "%" are wildcards in a GRANT's database name: escaped, each grant names one database.
		for (const database of databases) {
			const pattern = database.replaceAll("`", "``").replace(/[_%]/g, "\\$&");
			await connection.query(`GRANT SELECT, SHOW VIEW ON \`${pattern}\`.* TO ${quoteText(user)}@'%'`);
		}
		return { user, password };
	} finally {
		await connection.end();
	}
}
