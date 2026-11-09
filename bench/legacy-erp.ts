// A synthetic legacy ERP, generic on purpose: the shape real ones have (one
// database per company, abbreviated Spanish names, few comments, no foreign
// keys, a few huge tables, backup and temporary copies) without any real
// product's names. Deterministic: the same options always build the same
// schema, so two runs of the benchmark compare tools, not data.
import type { Column, Snapshot, Table } from "../lib/model/snapshot.ts";
import type { Question } from "./measure.ts";

export interface LegacyErpOptions {
	/** Company databases, emp_001 … emp_NNN, all with the same structure. */
	readonly companies?: number;
	/** Filler tables per company (temporary, log, backup, auxiliary). */
	readonly fillerTables?: number;
}

interface Module {
	readonly table: string;
	/** Table comment; most legacy tables have none. */
	readonly comment?: string;
	/** Business columns, besides the key and the audit columns. */
	readonly columns: readonly ColumnSpec[];
	/** Extra numbered columns, for the wide tables legacy systems grow. */
	readonly wide?: number;
	readonly rows: number;
}

type ColumnSpec = readonly [name: string, type: string, comment?: string];

const MODULES: readonly Module[] = [
	{
		table: "cli",
		rows: 48_000,
		columns: [
			["cod_cli", "int(11)"],
			["nom_cli", "varchar(80)", "Nombre o razón social"],
			["nif", "varchar(15)"],
			["fec_alt", "date"],
			["fec_baj", "date", "Fecha de baja"],
			["cod_for_pag", "int(11)"],
			["cod_tar", "int(11)"],
			["rie_max", "decimal(12,2)", "Riesgo máximo concedido"],
			["obs", "text"],
		],
		wide: 40,
	},
	{
		table: "cli_dir",
		rows: 61_000,
		columns: [
			["cod_cli", "int(11)", "Cliente"],
			["num_dir", "smallint(6)"],
			["dir", "varchar(120)"],
			["pob", "varchar(60)"],
			["cp", "varchar(10)"],
			["cod_pro", "char(2)"],
			["tip", "char(1)", "E=envío F=fiscal"],
		],
	},
	{
		table: "cli_con",
		rows: 30_000,
		columns: [
			["cod_cli", "int(11)", "Cliente"],
			["nom", "varchar(60)"],
			["tel", "varchar(20)"],
			["mail", "varchar(120)"],
		],
	},
	{
		table: "pro",
		rows: 3_100,
		columns: [
			["cod_pro", "int(11)"],
			["nom_pro", "varchar(80)"],
			["nif", "varchar(15)"],
			["cod_for_pag", "int(11)"],
		],
		wide: 20,
	},
	{
		table: "art",
		comment: "Artículos",
		rows: 120_000,
		columns: [
			["cod_art", "varchar(20)"],
			["des_art", "varchar(120)"],
			["cod_fam", "int(11)", "Familia"],
			["pvp", "decimal(12,4)"],
			["cos", "decimal(12,4)", "Coste medio"],
			["iva", "decimal(5,2)"],
			["bloq", "tinyint(1)"],
		],
		wide: 300,
	},
	{ table: "art_fam", rows: 340, columns: [["cod_fam", "int(11)"], ["des_fam", "varchar(60)"]] },
	{
		table: "art_tar",
		rows: 410_000,
		columns: [
			["cod_tar", "int(11)", "Tarifa"],
			["cod_art", "varchar(20)", "Artículo"],
			["pre", "decimal(12,4)"],
			["dto", "decimal(5,2)"],
		],
	},
	{
		table: "art_sto",
		rows: 380_000,
		columns: [
			["cod_art", "varchar(20)", "Artículo"],
			["cod_alm", "int(11)", "Almacén"],
			["can", "decimal(12,3)"],
			["can_res", "decimal(12,3)", "Reservado"],
		],
	},
	{ table: "alm", rows: 12, columns: [["cod_alm", "int(11)"], ["des_alm", "varchar(60)"]] },
	{
		table: "alm_mov",
		rows: 2_900_000,
		columns: [
			["cod_alm", "int(11)", "Almacén"],
			["cod_art", "varchar(20)", "Artículo"],
			["fec", "date"],
			["can", "decimal(12,3)"],
			["tip_doc", "char(2)"],
			["num_doc", "int(11)"],
		],
	},
	{
		table: "ped_cab",
		rows: 210_000,
		columns: [
			["ser", "char(2)"],
			["num_ped", "int(11)"],
			["cod_cli", "int(11)", "Cliente"],
			["fec", "date"],
			["est", "char(1)", "P=pendiente S=servido A=anulado"],
		],
		wide: 30,
	},
	{
		table: "ped_lin",
		rows: 1_400_000,
		columns: [
			["ser", "char(2)"],
			["num_ped", "int(11)"],
			["lin", "smallint(6)"],
			["cod_art", "varchar(20)", "Artículo"],
			["can", "decimal(12,3)"],
			["pre", "decimal(12,4)"],
		],
	},
	{
		table: "alb_cab",
		rows: 190_000,
		columns: [
			["ser", "char(2)"],
			["num_alb", "int(11)"],
			["cod_cli", "int(11)", "Cliente"],
			["fec", "date"],
			["fac", "tinyint(1)", "Facturado"],
		],
		wide: 30,
	},
	{
		table: "alb_lin",
		rows: 1_300_000,
		columns: [
			["ser", "char(2)"],
			["num_alb", "int(11)"],
			["lin", "smallint(6)"],
			["cod_art", "varchar(20)", "Artículo"],
			["can", "decimal(12,3)"],
		],
	},
	{
		table: "fac_cab",
		rows: 175_000,
		columns: [
			["ser", "char(2)"],
			["num_fac", "int(11)"],
			["cod_cli", "int(11)", "Cliente"],
			["fec", "date"],
			["bas", "decimal(12,2)"],
			["cuo_iva", "decimal(12,2)"],
			["tot", "decimal(12,2)"],
		],
		wide: 40,
	},
	{
		table: "fac_lin",
		rows: 1_200_000,
		columns: [
			["ser", "char(2)"],
			["num_fac", "int(11)"],
			["lin", "smallint(6)"],
			["cod_art", "varchar(20)", "Artículo"],
			["can", "decimal(12,3)"],
			["pre", "decimal(12,4)"],
		],
	},
	{
		table: "fac_ven",
		rows: 260_000,
		columns: [
			["ser", "char(2)"],
			["num_fac", "int(11)"],
			["fec_ven", "date", "Vencimiento"],
			["imp", "decimal(12,2)"],
			["cob", "tinyint(1)", "Cobrado"],
		],
	},
	{
		table: "cob_rem",
		rows: 4_200,
		columns: [
			["num_rem", "int(11)"],
			["cod_ban", "int(11)", "Banco"],
			["fec", "date"],
			["tot", "decimal(12,2)"],
		],
	},
	{ table: "ban", rows: 9, columns: [["cod_ban", "int(11)"], ["nom_ban", "varchar(60)"], ["iban", "varchar(34)"]] },
	{
		table: "emp",
		rows: 230,
		columns: [
			["cod_emp", "int(11)"],
			["nom_emp", "varchar(80)"],
			["fec_alt", "date"],
			["fec_baj", "date"],
		],
	},
	{
		table: "emp_nom",
		rows: 41_000,
		columns: [
			["cod_emp", "int(11)", "Empleado"],
			["eje", "smallint(6)"],
			["mes", "tinyint(4)"],
			["bru", "decimal(12,2)"],
			["net", "decimal(12,2)"],
		],
	},
	{
		table: "cta",
		rows: 6_500,
		columns: [
			["cod_cta", "varchar(12)"],
			["des_cta", "varchar(80)"],
		],
	},
	{
		table: "cta_asi",
		rows: 520_000,
		columns: [
			["eje", "smallint(6)", "Ejercicio"],
			["num_asi", "int(11)"],
			["fec", "date"],
			["con", "varchar(120)", "Concepto"],
		],
	},
	{
		table: "cta_apu",
		rows: 2_100_000,
		columns: [
			["eje", "smallint(6)", "Ejercicio"],
			["num_asi", "int(11)"],
			["cod_cta", "varchar(12)", "Cuenta"],
			["deb", "decimal(12,2)"],
			["hab", "decimal(12,2)"],
		],
	},
];

const FILLER_PREFIXES = ["tmp", "aux", "log", "cfg", "bak", "int"] as const;
/** Fillers left by a CREATE TABLE … LIKE of their module table: same columns, no comment. The rest have columns of their own. */
const COPY_PREFIXES: ReadonlySet<string> = new Set(["tmp", "aux", "bak"]);

const AUDIT_COLUMNS: readonly ColumnSpec[] = [
	["usu_alt", "varchar(20)"],
	["fec_alt_reg", "datetime"],
	["usu_mod", "varchar(20)"],
	["fec_mod", "datetime"],
];

export function legacyErpSnapshot({ companies = 10, fillerTables = 220 }: LegacyErpOptions = {}): Snapshot {
	const databases = Array.from({ length: companies }, (_, index) => {
		const name = `emp_${String(index + 1).padStart(3, "0")}`;
		return { name, schemas: [{ name, tables: companyTables(fillerTables), routines: [] }] };
	});
	return {
		formatVersion: 1,
		engine: { kind: "mysql", version: "5.7.42" },
		capturedAt: "2026-11-09T10:00:00.000Z",
		databases,
		warnings: [],
	};
}

function companyTables(fillerTables: number): Table[] {
	const modules = MODULES.map(moduleTable);
	// Yearly copies of the big documents, as legacy systems keep them.
	const copies = ["fac_cab", "fac_lin", "alb_cab", "alb_lin"].flatMap((name) =>
		[2019, 2020, 2021].map((year) => ({ ...modules.find((table) => table.name === name)!, name: `${name}_${year}`, comment: "" })),
	);
	const filler = Array.from({ length: fillerTables }, (_, index) => fillerTable(index));
	return [...modules, ...copies, ...filler].sort((a, b) => a.name.localeCompare(b.name));
}

function moduleTable(module: Module): Table {
	const specs: ColumnSpec[] = [["id", "int(11)"], ...module.columns];
	for (let index = 1; index <= (module.wide ?? 0); index += 1) {
		specs.push([`${module.table.replace(/_.*/, "")}_c${index}`, index % 3 === 0 ? "decimal(12,4)" : "varchar(30)", index % 25 === 0 ? `Campo libre ${index}` : undefined]);
	}
	specs.push(...AUDIT_COLUMNS);
	return table(module.table, module.comment ?? "", module.rows, specs);
}

// Each module gets fillers of every kind in turn: tmp_cli_0, tmp_cli_dir_1, …,
// then aux_cli_24, and so on.
function fillerTable(index: number): Table {
	const module = MODULES[index % MODULES.length]!;
	const prefix = FILLER_PREFIXES[Math.floor(index / MODULES.length) % FILLER_PREFIXES.length]!;
	const base = module.table;
	if (COPY_PREFIXES.has(prefix)) return { ...moduleTable(module), name: `${prefix}_${base}_${index}`, comment: "", rowEstimate: index * 37 };
	const specs: ColumnSpec[] = [
		["id", "int(11)"],
		...Array.from({ length: 6 + (index % 9) }, (_, column): ColumnSpec => [`c${column + 1}`, "varchar(60)"]),
	];
	return table(`${prefix}_${base}_${index}`, "", index * 37, specs);
}

function table(name: string, comment: string, rows: number, specs: readonly ColumnSpec[]): Table {
	const columns: Column[] = specs.map(([columnName, type, columnComment = ""], index) => ({
		name: columnName,
		position: index + 1,
		type,
		nullable: index > 1,
		default: null,
		comment: columnComment,
		autoIncrement: index === 0,
		generated: null,
		collation: type.startsWith("varchar") || type.startsWith("char") || type === "text" ? "latin1_spanish_ci" : null,
	}));
	return {
		name,
		kind: "table",
		comment,
		storageEngine: "MyISAM",
		rowEstimate: rows,
		columns,
		primaryKey: ["id"],
		indexes: [],
		foreignKeys: [],
		triggers: [],
		viewDefinition: null,
	};
}

/**
 * What people ask an agent about such a schema, with the searches a model
 * would try, in order, and the tables that answer it. Bare table names: in a
 * database per company any company's copy answers.
 */
export const LEGACY_ERP_QUESTIONS: readonly Question[] = [
	{ id: "unpaid-invoices", ask: "Qué facturas tiene pendientes de cobro un cliente", queries: ["facturas pendientes de cobro", "vencimiento"], expect: ["fac_cab", "fac_ven"] },
	{ id: "delivery-lines", ask: "Dónde se guardan las líneas de un albarán", queries: ["lineas albaran", "albaran"], expect: ["alb_lin"] },
	{ id: "stock", ask: "Stock de un artículo por almacén", queries: ["stock articulo almacen", "almacen"], expect: ["art_sto"] },
	{ id: "payroll", ask: "Nóminas de un empleado", queries: ["nominas empleado", "empleado"], expect: ["emp_nom"] },
	{ id: "shipping-address", ask: "Dirección de envío de un cliente", queries: ["direccion de envio", "envio"], expect: ["cli_dir"] },
	{ id: "journal", ask: "Asientos contables de un ejercicio", queries: ["asiento contable", "ejercicio"], expect: ["cta_asi"] },
	{ id: "price-list", ask: "Precio de un artículo según la tarifa del cliente", queries: ["tarifa precio articulo", "tarifa"], expect: ["art_tar"] },
	{ id: "customer-orders", ask: "Pedidos pendientes de servir de un cliente", queries: ["pedidos pendientes cliente", "pendiente"], expect: ["ped_cab"] },
	{ id: "bank-remittance", ask: "Remesas de cobro enviadas al banco", queries: ["remesa banco", "banco"], expect: ["cob_rem"] },
	{ id: "customer-en", ask: "Customer invoices and their total", queries: ["customer invoice", "invoice"], expect: ["fac_cab"] },
];
