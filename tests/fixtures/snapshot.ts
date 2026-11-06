// Builders for small, valid snapshots. Each test overrides only what it cares about.
import type { Column, Snapshot, Table } from "../../lib/model/snapshot.ts";

export function column(name: string, position: number, overrides: Partial<Column> = {}): Column {
	return {
		name,
		position,
		type: "int",
		nullable: false,
		default: null,
		comment: "",
		autoIncrement: false,
		generated: null,
		collation: null,
		...overrides,
	};
}

export function ordersTable(overrides: Partial<Table> = {}): Table {
	return {
		name: "orders",
		kind: "table",
		comment: "",
		storageEngine: "InnoDB",
		rowEstimate: 1200,
		columns: [
			column("id", 1, { autoIncrement: true }),
			column("customer_id", 2),
			column("total", 3, { type: "decimal(10,2)" }),
		],
		primaryKey: ["id"],
		indexes: [{ name: "idx_customer", columns: ["customer_id"], unique: false, method: "BTREE" }],
		foreignKeys: [
			{
				name: "fk_orders_customer",
				columns: ["customer_id"],
				references: { database: "shop", schema: "shop", table: "customers", columns: ["id"] },
				onDelete: "RESTRICT",
				onUpdate: "CASCADE",
			},
		],
		triggers: [],
		viewDefinition: null,
		...overrides,
	};
}

export function customersTable(): Table {
	return {
		...ordersTable(),
		name: "customers",
		columns: [column("id", 1), column("email", 2, { type: "varchar(255)" })],
		indexes: [],
		foreignKeys: [],
	};
}

export function snapshot(tables: Table[], overrides: Partial<Snapshot> = {}): Snapshot {
	return {
		formatVersion: 1,
		engine: { kind: "mysql", version: "8.0.36" },
		capturedAt: "2026-11-03T10:00:00.000Z",
		databases: [{ name: "shop", schemas: [{ name: "shop", tables, routines: [] }] }],
		warnings: [],
		...overrides,
	};
}
