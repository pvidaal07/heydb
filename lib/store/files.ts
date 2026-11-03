import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Writes the whole file or nothing. The content goes to a temporary file in
 * the same directory, is flushed to disk (fsync), and is then renamed over the
 * target. A rename within one directory is atomic, so if heydb crashes the
 * target is either the old file or the new one, never half of each. After a
 * power loss the rename itself may be lost (the old file remains): the
 * directory is not flushed, because Windows does not support that.
 */
export function writeFileAtomic(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		const fd = openSync(temporary, "w");
		try {
			writeSync(fd, content, null, "utf8");
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

/**
 * JSON with object keys sorted alphabetically, two-space indentation and a
 * final newline. The same data always produces the same bytes, whatever order
 * the code built the objects in, so git diffs only show real changes.
 * Array order is kept: sort arrays before calling this when their order is
 * not meaningful.
 */
export function stableJson(value: unknown): string {
	return `${JSON.stringify(value, sortKeys, 2)}\n`;
}

function sortKeys(_key: string, value: unknown): unknown {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) {
		sorted[key] = (value as Record<string, unknown>)[key];
	}
	return sorted;
}
