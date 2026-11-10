// What the direct-SQL strategy lets a model run, and how it prints results:
// one read-only statement (SELECT, SHOW, DESCRIBE), printed as `mysql --batch`
// prints it. The server user has only SELECT and SHOW VIEW on the benchmark
// databases too, so this check is the first of two locks, not the only one.

const ALLOWED: ReadonlySet<string> = new Set(["select", "show", "describe", "desc"]);

/** null when `sql` is one read-only statement; otherwise why it is refused. */
export function checkReadOnly(sql: string): string | null {
	if (/\/\*[M]?!/i.test(sql)) return "executable comments (/*! … */) are not allowed";
	const code = withoutStringsAndComments(sql);
	if (code === null) return "unterminated string or comment";
	const semicolons = [...code.matchAll(/;/g)].map((match) => match.index ?? 0);
	if (semicolons.length > 1 || (semicolons.length === 1 && code.slice(semicolons[0]! + 1).trim() !== "")) return "only one statement per call";
	const statement = code.replace(/;\s*$/, "").trim();
	if (statement === "") return "empty statement";
	const first = /^[\s(]*([a-z]+)/i.exec(statement)?.[1]?.toLowerCase();
	if (first === undefined || !ALLOWED.has(first)) return "only SELECT, SHOW and DESCRIBE are allowed";
	if (/\binto\b/i.test(statement)) return "SELECT … INTO is not allowed";
	return null;
}

/** The statement with every string, quoted name and comment blanked; null when one never ends. */
function withoutStringsAndComments(sql: string): string | null {
	let out = "";
	let index = 0;
	while (index < sql.length) {
		const char = sql[index]!;
		const next = sql[index + 1];
		if (char === "'" || char === '"' || char === "`") {
			let end = index + 1;
			for (;;) {
				if (end >= sql.length) return null;
				if (sql[end] === "\\" && char !== "`") end += 2;
				else if (sql[end] === char && sql[end + 1] === char) end += 2;
				else if (sql[end] === char) break;
				else end += 1;
			}
			out += " ";
			index = end + 1;
		} else if (char === "#" || (char === "-" && next === "-" && (sql[index + 2] === undefined || /\s/.test(sql[index + 2]!)))) {
			const end = sql.indexOf("\n", index);
			out += " ";
			index = end < 0 ? sql.length : end;
		} else if (char === "/" && next === "*") {
			const end = sql.indexOf("*/", index + 2);
			if (end < 0) return null;
			out += " ";
			index = end + 2;
		} else {
			out += char;
			index += 1;
		}
	}
	return out;
}

/** A value as `mysql --batch` prints it: NULL, and tab, newline and backslash escaped. */
function batchValue(value: unknown): string {
	if (value === null || value === undefined) return "NULL";
	const text = value instanceof Date ? value.toISOString().replace("T", " ").replace(/\.000Z$|Z$/, "") : Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
	return text.replaceAll("\\", "\\\\").replaceAll("\t", "\\t").replaceAll("\n", "\\n");
}

/** Rows as `mysql --batch` prints them, at most `cap`, then a line saying how many were left out. */
export function batchText(columns: readonly string[], rows: readonly Record<string, unknown>[], cap: number): string {
	if (rows.length === 0) return "Empty set";
	const lines = [columns.join("\t"), ...rows.slice(0, cap).map((row) => columns.map((column) => batchValue(row[column])).join("\t"))];
	if (rows.length > cap) lines.push(`… ${rows.length - cap} more rows`);
	return lines.join("\n");
}
