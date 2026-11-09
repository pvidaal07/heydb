// The answer of a run is the last line of the reply starting with "TABLES:",
// a comma-separated list of table names. Names compare bare and ignoring case:
// "emp_001.fac_cab", "`FAC_CAB`" and "fac_cab" are the same answer, as in the
// questions file any database's copy of a table answers.

/** The table names of the last TABLES line, deduplicated, bare and lowercase; null when the reply has none. */
export function tablesLine(text: string): string[] | null {
	let found: string | null = null;
	for (const line of text.split(/\r?\n/)) {
		const match = /^[\s>*_`#-]*TABLES[*_`]*\s*:[*_`]*\s*(.*)$/i.exec(line);
		if (match !== null) found = match[1] ?? "";
	}
	if (found === null) return null;
	const names = found
		.split(",")
		.map(bareName)
		.filter((name) => name !== "" && name !== "none");
	return [...new Set(names)];
}

/** "`emp_001`.`fac_cab`." → "fac_cab". */
export function bareName(text: string): string {
	const clean = text.trim().replace(/^[*_`"'[\s]+|[*_`"'\].;\s]+$/g, "");
	const last = clean.split(".").at(-1) ?? clean;
	return last.replace(/[`"'[\]*]/g, "").trim().toLowerCase();
}

export interface Verdict {
	/** Every expected table named. */
	readonly correct: boolean;
	/** Expected tables named. */
	readonly hits: number;
	readonly expected: number;
	/** Tables named that were not expected. */
	readonly extra: number;
}

export function judge(named: readonly string[] | null, expect: readonly string[]): Verdict {
	const wanted = [...new Set(expect.map(bareName))];
	const said = new Set((named ?? []).map(bareName));
	const hits = wanted.filter((name) => said.has(name)).length;
	return { correct: named !== null && hits === wanted.length, hits, expected: wanted.length, extra: [...said].filter((name) => !wanted.includes(name)).length };
}
