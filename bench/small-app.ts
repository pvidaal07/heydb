// A synthetic small app, the other end from legacy-erp.ts: one database of a
// personal or small-team project, the shape a modern framework leaves (clear
// English names, InnoDB, declared foreign keys, created_at / updated_at, a few
// comments, status values kept as varchar with the valid values in a comment),
// a small code tree and the questions its developers ask. Generic and
// deterministic, like the ERP: two runs compare tools, not data.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { sortSnapshot } from "../lib/model/order.ts";
import type { Column, ForeignKey, Index, Snapshot, Table } from "../lib/model/snapshot.ts";
import type { Question } from "./measure.ts";

const DATABASE = "shop";

/** [name, type, options]: nullable, a default, a comment. */
type ColumnSpec = readonly [name: string, type: string, options?: { readonly null?: boolean; readonly default?: string; readonly comment?: string }];

interface TableSpec {
	readonly name: string;
	readonly comment?: string;
	readonly rows: number;
	readonly columns: readonly ColumnSpec[];
	/** Foreign keys as [column, referenced table]; they reference its id. */
	readonly references?: readonly (readonly [column: string, table: string, onDelete?: ForeignKey["onDelete"]])[];
	readonly unique?: readonly string[];
	/** Without the id and the timestamps every table gets. */
	readonly bare?: boolean;
}

const TABLES: readonly TableSpec[] = [
	{
		name: "users",
		comment: "Staff accounts for the admin panel",
		rows: 12,
		columns: [
			["email", "varchar(255)"],
			["password_hash", "varchar(255)"],
			["name", "varchar(120)"],
			["role", "varchar(20)", { default: "'editor'", comment: "admin, editor or support" }],
			["last_login_at", "timestamp", { null: true }],
		],
		unique: ["email"],
	},
	{
		name: "sessions",
		rows: 340,
		columns: [
			["user_id", "bigint unsigned"],
			["token", "char(64)"],
			["ip_address", "varchar(45)", { null: true }],
			["user_agent", "varchar(255)", { null: true }],
			["expires_at", "timestamp"],
		],
		references: [["user_id", "users", "CASCADE"]],
		unique: ["token"],
	},
	{
		name: "customers",
		rows: 8_400,
		columns: [
			["email", "varchar(255)"],
			["password_hash", "varchar(255)"],
			["first_name", "varchar(80)"],
			["last_name", "varchar(80)"],
			["phone", "varchar(30)", { null: true }],
			["marketing_opt_in", "tinyint(1)", { default: "0" }],
		],
		unique: ["email"],
	},
	{
		name: "addresses",
		rows: 9_900,
		columns: [
			["customer_id", "bigint unsigned"],
			["type", "varchar(10)", { comment: "billing or shipping" }],
			["line1", "varchar(160)"],
			["line2", "varchar(160)", { null: true }],
			["city", "varchar(80)"],
			["postal_code", "varchar(20)"],
			["country", "char(2)"],
		],
		references: [["customer_id", "customers", "CASCADE"]],
	},
	{
		name: "categories",
		rows: 40,
		columns: [
			["parent_id", "bigint unsigned", { null: true }],
			["name", "varchar(80)"],
			["slug", "varchar(80)"],
		],
		references: [["parent_id", "categories", "SET NULL"]],
		unique: ["slug"],
	},
	{
		name: "products",
		rows: 1_200,
		columns: [
			["category_id", "bigint unsigned"],
			["sku", "varchar(40)"],
			["name", "varchar(160)"],
			["description", "text", { null: true }],
			["price", "decimal(10,2)"],
			["stock", "int", { default: "0" }],
			["active", "tinyint(1)", { default: "1" }],
		],
		references: [["category_id", "categories"]],
		unique: ["sku"],
	},
	{
		name: "product_images",
		rows: 3_600,
		columns: [
			["product_id", "bigint unsigned"],
			["url", "varchar(255)"],
			["alt_text", "varchar(160)", { null: true }],
			["position", "smallint", { default: "0" }],
		],
		references: [["product_id", "products", "CASCADE"]],
	},
	{
		name: "coupons",
		comment: "Discount codes customers enter at checkout",
		rows: 85,
		columns: [
			["code", "varchar(40)"],
			["percent_off", "decimal(5,2)", { null: true }],
			["amount_off", "decimal(10,2)", { null: true }],
			["max_uses", "int", { null: true }],
			["used_count", "int", { default: "0" }],
			["expires_at", "timestamp", { null: true }],
		],
		unique: ["code"],
	},
	{
		name: "orders",
		rows: 21_000,
		columns: [
			["customer_id", "bigint unsigned"],
			["shipping_address_id", "bigint unsigned"],
			["billing_address_id", "bigint unsigned"],
			["coupon_id", "bigint unsigned", { null: true }],
			["number", "varchar(20)"],
			["status", "varchar(20)", { default: "'pending'", comment: "pending, paid, shipped, delivered or cancelled" }],
			["subtotal", "decimal(10,2)"],
			["discount", "decimal(10,2)", { default: "0.00" }],
			["total", "decimal(10,2)"],
			["placed_at", "timestamp", { null: true }],
		],
		references: [
			["customer_id", "customers"],
			["shipping_address_id", "addresses"],
			["billing_address_id", "addresses"],
			["coupon_id", "coupons", "SET NULL"],
		],
		unique: ["number"],
	},
	{
		name: "order_items",
		rows: 54_000,
		columns: [
			["order_id", "bigint unsigned"],
			["product_id", "bigint unsigned"],
			["quantity", "int"],
			["unit_price", "decimal(10,2)"],
		],
		references: [
			["order_id", "orders", "CASCADE"],
			["product_id", "products"],
		],
	},
	{
		name: "payments",
		rows: 21_500,
		columns: [
			["order_id", "bigint unsigned"],
			["provider", "varchar(20)"],
			["provider_ref", "varchar(80)"],
			["amount", "decimal(10,2)"],
			["status", "varchar(20)", { comment: "pending, captured, refunded or failed" }],
			["paid_at", "timestamp", { null: true }],
		],
		references: [["order_id", "orders"]],
	},
	{
		name: "shipments",
		rows: 19_800,
		columns: [
			["order_id", "bigint unsigned"],
			["carrier", "varchar(40)"],
			["tracking_number", "varchar(60)", { null: true }],
			["shipped_at", "timestamp", { null: true }],
			["delivered_at", "timestamp", { null: true }],
		],
		references: [["order_id", "orders"]],
	},
	{
		name: "reviews",
		rows: 4_700,
		columns: [
			["product_id", "bigint unsigned"],
			["customer_id", "bigint unsigned"],
			["rating", "tinyint"],
			["title", "varchar(120)", { null: true }],
			["body", "text", { null: true }],
			["approved", "tinyint(1)", { default: "0" }],
		],
		references: [
			["product_id", "products", "CASCADE"],
			["customer_id", "customers", "CASCADE"],
		],
	},
	{
		name: "audit_log",
		comment: "Who changed what in the admin panel",
		rows: 61_000,
		columns: [
			["user_id", "bigint unsigned", { null: true }],
			["entity", "varchar(40)"],
			["entity_id", "bigint unsigned"],
			["action", "varchar(20)"],
			["changes", "json", { null: true }],
		],
		references: [["user_id", "users", "SET NULL"]],
	},
	{
		name: "settings",
		rows: 30,
		bare: true,
		columns: [
			["key", "varchar(80)"],
			["value", "text", { null: true }],
			["updated_at", "timestamp", { default: "CURRENT_TIMESTAMP" }],
		],
	},
];

export function smallAppSnapshot(): Snapshot {
	return sortSnapshot({
		formatVersion: 1,
		engine: { kind: "mysql", version: "8.0.36" },
		capturedAt: "2026-11-09T10:00:00.000Z",
		databases: [{ name: DATABASE, schemas: [{ name: DATABASE, tables: TABLES.map(table), routines: [] }] }],
		warnings: [],
	});
}

function table(spec: TableSpec): Table {
	const specs: ColumnSpec[] =
		spec.bare === true
			? [...spec.columns]
			: [
					["id", "bigint unsigned"],
					...spec.columns,
					["created_at", "timestamp", { default: "CURRENT_TIMESTAMP" }],
					["updated_at", "timestamp", { default: "CURRENT_TIMESTAMP" }],
				];
	const columns: Column[] = specs.map(([name, type, options = {}], index) => ({
		name,
		position: index + 1,
		type,
		nullable: options.null === true,
		default: options.default ?? null,
		comment: options.comment ?? "",
		autoIncrement: spec.bare !== true && index === 0,
		generated: null,
		collation: /char|text/.test(type) ? "utf8mb4_0900_ai_ci" : null,
	}));
	const references = spec.references ?? [];
	const indexes: Index[] = [
		...(spec.unique ?? []).map((column) => ({ name: `${spec.name}_${column}_unique`, columns: [column], unique: true, method: "BTREE" })),
		...references.map(([column]) => ({ name: `${spec.name}_${column}_foreign`, columns: [column], unique: false, method: "BTREE" })),
	];
	const foreignKeys: ForeignKey[] = references.map(([column, target, onDelete = "RESTRICT"]) => ({
		name: `${spec.name}_${column}_foreign`,
		columns: [column],
		references: { database: DATABASE, schema: DATABASE, table: target, columns: ["id"] },
		onDelete,
		onUpdate: "RESTRICT",
	}));
	return {
		name: spec.name,
		kind: "table",
		comment: spec.comment ?? "",
		storageEngine: "InnoDB",
		rowEstimate: spec.rows,
		columns,
		primaryKey: [spec.bare === true ? "key" : "id"],
		indexes,
		foreignKeys,
		triggers: [],
		viewDefinition: null,
	};
}

/**
 * What a developer asks an agent about the app, with the searches a model
 * would try, in order: mostly English, a few in Spanish (where a model tries
 * the English words next), two about one column and one needing two tables.
 */
export const SMALL_APP_QUESTIONS: readonly Question[] = [
	{ id: "customer-orders", ask: "Which orders has a customer placed?", queries: ["customer orders", "orders"], expect: ["orders"] },
	{ id: "order-lines", ask: "What products were in an order, and at what price?", queries: ["order items price", "order items"], expect: ["order_items"] },
	{ id: "coupon-expiry", ask: "Where is the coupon's expiry date?", queries: ["coupon expiry date", "coupon expires"], expect: ["coupons"] },
	{ id: "tracking-number", ask: "Where do we keep the tracking number of a shipment?", queries: ["tracking number", "shipment"], expect: ["shipments"] },
	{ id: "refunds", ask: "Which payments were refunded?", queries: ["payments refunded", "payment status"], expect: ["payments"] },
	{ id: "order-address", ask: "Shipping address of an order", queries: ["order shipping address", "address"], expect: ["orders", "addresses"] },
	{ id: "product-rating", ask: "Average rating of a product", queries: ["product rating", "rating"], expect: ["reviews"] },
	{ id: "product-images", ask: "Dónde se guardan las imágenes de un producto", queries: ["imagenes producto", "product images"], expect: ["product_images"] },
	{ id: "admin-changes", ask: "Quién cambió el precio de un producto en el panel de administración", queries: ["cambios panel administracion", "admin changes"], expect: ["audit_log"] },
	{ id: "user-sessions", ask: "Sesiones abiertas de un usuario del panel", queries: ["sesiones usuario", "user sessions"], expect: ["sessions"] },
];

const FILES: Readonly<Record<string, string>> = {
	"README.md": `# Shop

A small online shop: catalog, cart, checkout and an admin panel.

## Database

MySQL 8, migrations in \`migrations/\`. Orders keep the shipping and billing
address they were placed with; payments and shipments hang off the order.
Discount codes live in \`coupons\`.
`,
	"src/models.ts": `// Entities mapped to the shop database.
@Entity("customers")
export class Customer {
  @PrimaryGeneratedColumn() id!: number;
  @Column() email!: string;
  @OneToMany(() => Order, (order) => order.customer) orders!: Order[];
}

@Entity("products")
export class Product {
  @PrimaryGeneratedColumn() id!: number;
  @Column() sku!: string;
  @Column("decimal") price!: string;
  @OneToMany(() => ProductImage, (image) => image.product) images!: ProductImage[];
}

@Entity("product_images")
export class ProductImage {
  @PrimaryGeneratedColumn() id!: number;
  @ManyToOne(() => Product) product!: Product;
  @Column() url!: string;
}

@Entity("orders")
export class Order {
  @PrimaryGeneratedColumn() id!: number;
  @ManyToOne(() => Customer) customer!: Customer;
  @Column() status!: "pending" | "paid" | "shipped" | "delivered" | "cancelled";
  @Column("decimal") total!: string;
}

@Entity("coupons")
export class Coupon {
  @PrimaryGeneratedColumn() id!: number;
  @Column() code!: string;
  @Column({ name: "expires_at", nullable: true }) expiresAt!: Date | null;
}
`,
	"src/repositories/orders.ts": `// Queries the ORM makes awkward.
export const recentOrders = \`
  SELECT o.id, o.number, o.total, o.status
  FROM orders o
  WHERE o.customer_id = ?
  ORDER BY o.placed_at DESC\`;

export const orderLines = \`
  SELECT i.quantity, i.unit_price, p.name
  FROM order_items i JOIN products p ON p.id = i.product_id
  WHERE i.order_id = ?\`;

// Refunds are payments whose status is 'refunded'.
export const refunds = \`SELECT * FROM payments WHERE status = 'refunded'\`;
`,
	"migrations/2024_01_10_create_shipments.sql": `CREATE TABLE shipments (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id BIGINT UNSIGNED NOT NULL,
  carrier VARCHAR(40) NOT NULL,
  tracking_number VARCHAR(60) NULL,
  FOREIGN KEY (order_id) REFERENCES orders (id)
);
`,
	"node_modules/orm/index.js": "// A dependency: not the project's code.\nmodule.exports = { tables: ['orders', 'customers'] };\n",
};

/** Writes the small app's code tree under `dir` (created if missing). */
export function writeSmallAppCode(dir: string): void {
	for (const [path, content] of Object.entries(FILES)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), content);
	}
}
