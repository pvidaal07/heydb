// An ORM schema, the best case for an ORM: a Prisma-like schema.prisma
// generated from the snapshot, every model mapped to its table, typed fields
// and the column comments as /// doc comments. The agent greps it with the
// question's words, then reads the model block; when no grep named the
// table, it lists every model line and reads the right model.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Column, Snapshot } from "../../lib/model/snapshot.ts";
import { allTables } from "../measure.ts";
import { block, grepText, linesStarting } from "./schema-doc.ts";
import { type BenchContext, type Strategy, grepWords, searchThenRead } from "./shared.ts";

/** "fac_cab" → "FacCab"; a name starting with a digit gets an "M". */
export function modelName(table: string): string {
	const pascal = table
		.split(/[^\p{L}\p{N}]+/u)
		.filter((part) => part !== "")
		.map((part) => part[0]!.toUpperCase() + part.slice(1))
		.join("");
	return /^\p{L}/u.test(pascal) ? pascal : `M${pascal}`;
}

/** The model names of a snapshot's tables, keyed by canonical name: a name taken by another database gets the database in front. */
export function modelNames(snapshot: Snapshot): Map<string, string> {
	const names = new Map<string, string>();
	const taken = new Set<string>();
	for (const entry of allTables(snapshot)) {
		let name = modelName(entry.table.name);
		if (taken.has(name)) name = modelName(`${entry.schema}_${entry.table.name}`);
		taken.add(name);
		names.set(entry.name, name);
	}
	return names;
}

export function prismaSchema(snapshot: Snapshot): string {
	const tables = allTables(snapshot);
	const schemas = new Set(tables.map((entry) => entry.schema));
	const provider = snapshot.engine.kind === "postgresql" ? "postgresql" : "mysql";
	const lines = ["generator client {", '  provider = "prisma-client-js"', "}", "", "datasource db {", `  provider = "${provider}"`, '  url      = env("DATABASE_URL")'];
	if (schemas.size > 1) lines.push(`  schemas  = [${[...schemas].map((schema) => `"${schema}"`).join(", ")}]`);
	lines.push("}", "");
	const models = modelNames(snapshot);
	for (const entry of tables) {
		const { table } = entry;
		const single = table.primaryKey.length === 1 ? table.primaryKey[0] : undefined;
		const fields = table.columns.map((column) => {
			const [type, native] = prismaType(column);
			const attributes = [
				...(column.name === single ? ["@id"] : []),
				...(column.autoIncrement ? ["@default(autoincrement())"] : []),
				...(native === undefined ? [] : [native]),
			];
			const name = /^[\p{L}_][\p{L}\p{N}_]*$/u.test(column.name) ? column.name : `f_${column.name.replace(/[^\p{L}\p{N}_]/gu, "_")}`;
			return { name, type: `${type}${column.nullable ? "?" : ""}`, attributes: attributes.join(" "), comment: column.comment };
		});
		const nameWidth = Math.max(...fields.map((field) => field.name.length));
		const typeWidth = Math.max(...fields.map((field) => field.type.length));
		if (table.comment !== "") lines.push(`/// ${oneLine(table.comment)}`);
		lines.push(`model ${models.get(entry.name)} {`);
		for (const field of fields) {
			if (field.comment !== "") lines.push(`  /// ${oneLine(field.comment)}`);
			const typed = field.attributes === "" ? field.type : `${field.type.padEnd(typeWidth)} ${field.attributes}`;
			lines.push(`  ${field.name.padEnd(nameWidth)} ${typed}`);
		}
		lines.push("");
		if (table.primaryKey.length > 1) lines.push(`  @@id([${table.primaryKey.join(", ")}])`);
		lines.push(`  @@map("${table.name}")`);
		if (schemas.size > 1) lines.push(`  @@schema("${entry.schema}")`);
		lines.push("}", "");
	}
	return lines.join("\n");
}

const oneLine = (text: string): string => text.replaceAll("\n", " ");

/** The Prisma scalar type of a column and its native type attribute, as `prisma db pull` prints them. */
export function prismaType(column: Column): [type: string, native?: string] {
	const type = column.type.toLowerCase();
	const size = /\(([^)]*)\)/.exec(type)?.[1]?.replace(/\s*,\s*/, ", ");
	const base = type.replace(/\(.*$/, "").replace(/ unsigned$/, "").trim();
	if (base === "tinyint" && size === "1") return ["Boolean"];
	if (base === "boolean" || base === "bool") return ["Boolean"];
	if (base === "int" || base === "integer" || base === "mediumint") return ["Int"];
	if (base === "tinyint") return ["Int", "@db.TinyInt"];
	if (base === "smallint") return ["Int", "@db.SmallInt"];
	if (base === "bigint") return ["BigInt"];
	if (base === "decimal" || base === "numeric") return ["Decimal", size === undefined ? undefined : `@db.Decimal(${size})`];
	if (base === "float" || base === "double" || base === "real" || base === "double precision") return ["Float"];
	if (base === "varchar" || base === "character varying") return ["String", size === undefined ? undefined : `@db.VarChar(${size})`];
	if (base === "char" || base === "character") return ["String", size === undefined ? undefined : `@db.Char(${size})`];
	if (base === "text" || base === "mediumtext" || base === "longtext" || base === "tinytext") return ["String", base === "text" ? "@db.Text" : undefined];
	if (base === "date") return ["DateTime", "@db.Date"];
	if (base === "datetime") return ["DateTime", `@db.DateTime(${size ?? "0"})`];
	if (base.startsWith("timestamp")) return ["DateTime", `@db.Timestamp(${size ?? "0"})`];
	if (base === "json" || base === "jsonb") return ["Json"];
	if (base === "uuid") return ["String", "@db.Uuid"];
	return [`Unsupported("${column.type}")`];
}

export function ormSchema(ctx: BenchContext): Strategy {
	const path = join(ctx.workdir, "schema.prisma");
	writeFileSync(path, prismaSchema(ctx.snapshot));
	const models = modelNames(ctx.snapshot);
	// A model's name names its table too.
	const lookup = new Map(ctx.lookup);
	for (const entry of ctx.tables) lookup.set(models.get(entry.name)!.toLowerCase(), entry.table.name);
	const read = () => readFileSync(path, "utf8");
	return {
		id: "orm-schema",
		label: "grep schema.prisma, read the model",
		simulated: false,
		run: (question) =>
			searchThenRead(ctx, question, {
				lookup,
				search: (query) => ({ tool: "grep", args: query, text: grepText(read(), grepWords(query)) }),
				fallback: () => ({ calls: [() => ({ tool: "grep models", args: "^model ", text: linesStarting(read(), "model ") })], definitions: false }),
				read: (targets) =>
					targets.map((target) => () => {
						const name = models.get(target.name)!;
						return { tool: "read model", args: name, text: modelBlock(read(), name) };
					}),
			}),
	};
}

/** The model's block, with the /// comment above it. */
export function modelBlock(schema: string, model: string): string {
	const body = block(schema, `model ${model} {`, (line) => line === "}");
	const lines = schema.split("\n");
	const at = lines.indexOf(`model ${model} {`);
	const comments: string[] = [];
	for (let index = at - 1; index >= 0 && lines[index]!.startsWith("///"); index -= 1) comments.unshift(lines[index]!);
	return [...comments, body, "}"].join("\n");
}
