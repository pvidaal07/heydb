// Canonical names give every object one unambiguous address:
//
//   database.schema.table.column
//
// Three levels before the column are needed because PostgreSQL has
// database → schema → table. In MySQL and MariaDB the schema equals the
// database, so "shop.shop.orders" is the canonical name of table "orders".
//
// Real names may contain dots ("v1.old"), so a segment that contains a dot or a
// double quote, or is empty, is wrapped in double quotes, with inner quotes
// doubled — the same rule SQL uses for quoted identifiers.

export interface ObjectRef {
	readonly database: string;
	readonly schema: string;
	readonly table?: string;
	readonly column?: string;
}

const QUOTE = '"';

export function formatName(ref: ObjectRef): string {
	if (ref.column !== undefined && ref.table === undefined) {
		throw new Error(`column "${ref.column}" needs a table`);
	}
	const segments = [ref.database, ref.schema];
	if (ref.table !== undefined) segments.push(ref.table);
	if (ref.column !== undefined) segments.push(ref.column);
	return segments.map(formatSegment).join(".");
}

/**
 * Names a database on its own, with the quoting rule of every segment:
 * shop stays shop, v1.old becomes "v1.old". The first segment of every
 * canonical name inside that database is exactly this text.
 */
export function formatDatabaseName(database: string): string {
	return formatSegment(database);
}

function formatSegment(segment: string): string {
	const needsQuotes = segment === "" || segment.includes(".") || segment.includes(QUOTE);
	if (!needsQuotes) return segment;
	return QUOTE + segment.replaceAll(QUOTE, QUOTE + QUOTE) + QUOTE;
}

export function parseName(text: string): ObjectRef {
	const segments = parseSegments(text);
	if (segments.length < 2 || segments.length > 4) {
		throw new Error(`invalid name "${text}": expected 2 to 4 segments, got ${segments.length}`);
	}
	const [database, schema, table, column] = segments as [string, string, string?, string?];
	return {
		database,
		schema,
		...(table !== undefined && { table }),
		...(column !== undefined && { column }),
	};
}

/**
 * Splits a dotted name into its segments with the same quoting rules as
 * parseName, but accepts any number of them. People and agents write partial
 * names ("orders", "shop.orders"); this reads them without guessing what each
 * segment is.
 *
 * Reads one segment at a time. A segment is either quoted ("...") or plain
 * text up to the next dot. After each segment we must be at the end of the
 * text or at a dot that starts the next segment.
 */
export function parseSegments(text: string): string[] {
	const segments: string[] = [];
	let index = 0;

	while (true) {
		if (text[index] === QUOTE) {
			const quoted = readQuoted(text, index);
			segments.push(quoted.value);
			index = quoted.end;
		} else {
			const dot = text.indexOf(".", index);
			const end = dot === -1 ? text.length : dot;
			const plain = text.slice(index, end);
			if (plain === "") throw new Error(`invalid name "${text}": empty segment must be written as ""`);
			if (plain.includes(QUOTE)) throw new Error(`invalid name "${text}": quote inside unquoted segment "${plain}"`);
			segments.push(plain);
			index = end;
		}

		if (index === text.length) return segments;
		if (text[index] !== ".") {
			throw new Error(`invalid name "${text}": unexpected "${text[index]}" after closing quote`);
		}
		index += 1;
	}
}

// Starts at an opening quote; returns the unquoted value and the index after the closing quote.
function readQuoted(text: string, start: number): { value: string; end: number } {
	let value = "";
	let index = start + 1;
	while (index < text.length) {
		if (text[index] === QUOTE) {
			if (text[index + 1] === QUOTE) {
				value += QUOTE;
				index += 2;
				continue;
			}
			return { value, end: index + 1 };
		}
		value += text[index];
		index += 1;
	}
	throw new Error(`invalid name "${text}": unterminated quote`);
}
