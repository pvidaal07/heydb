import { statSync } from "node:fs";
import { dirname, join } from "node:path";

/** Directory that marks a heydb project, like .git marks a git repository. */
export const HEYDB_DIR = ".heydb";

/**
 * Walks up from `start` until it finds a directory containing `.heydb/`.
 * Returns that directory, or null when no ancestor is a heydb project.
 * This is how git finds its repository, so heydb works from any subfolder.
 */
export function findProjectRoot(start: string): string | null {
	let current = start;
	while (true) {
		if (isDirectory(join(current, HEYDB_DIR))) return current;
		const parent = dirname(current);
		if (parent === current) return null; // reached the filesystem root
		current = parent;
	}
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false; // does not exist or cannot be read
	}
}
