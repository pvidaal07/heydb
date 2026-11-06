-- A small "legacy" server with the cases heydb must handle. Loaded by the
-- MySQL/MariaDB containers in tests/integration/compose.yaml on first start.
-- It must stay valid on MySQL 8.0 and MariaDB 10.6+.

CREATE DATABASE shop CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE crm CHARACTER SET latin1 COLLATE latin1_swedish_ci;
CREATE DATABASE secret;

-- Customers live in another database: shop.orders points here (cross-database FK).
CREATE TABLE crm.customers (
	id INT UNSIGNED NOT NULL AUTO_INCREMENT,
	email VARCHAR(255) NOT NULL COMMENT 'Login email',
	name VARCHAR(100) NULL,
	status TINYINT NOT NULL DEFAULT 1 COMMENT '1=active 2=blocked 3=deleted',
	created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (id),
	UNIQUE KEY uq_email (email)
) ENGINE=InnoDB COMMENT='CRM customers';

CREATE TABLE shop.orders (
	id INT UNSIGNED NOT NULL AUTO_INCREMENT,
	customer_id INT UNSIGNED NOT NULL,
	total DECIMAL(10,2) NOT NULL DEFAULT 0.00,
	status ENUM('draft','paid','cancelled') NOT NULL DEFAULT 'draft',
	notes TEXT NULL,
	PRIMARY KEY (id),
	KEY idx_customer (customer_id),
	FULLTEXT KEY ft_notes (notes),
	CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES crm.customers (id)
		ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB COMMENT='Customer orders';

-- Primary key order (line_no, order_id) differs from column order, and a
-- stored generated column.
CREATE TABLE shop.order_lines (
	order_id INT UNSIGNED NOT NULL,
	line_no SMALLINT UNSIGNED NOT NULL,
	product_code VARCHAR(20) NOT NULL,
	quantity INT NOT NULL DEFAULT 1,
	unit_price DECIMAL(10,2) NOT NULL,
	line_total DECIMAL(12,2) AS (quantity * unit_price) STORED,
	PRIMARY KEY (line_no, order_id),
	KEY idx_order (order_id),
	CONSTRAINT fk_lines_order FOREIGN KEY (order_id) REFERENCES shop.orders (id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Composite foreign key with SET NULL, and a virtual generated column.
CREATE TABLE shop.shipments (
	id INT UNSIGNED NOT NULL AUTO_INCREMENT,
	line_no SMALLINT UNSIGNED NULL,
	order_id INT UNSIGNED NULL,
	shipped_at DATETIME NULL,
	shipped_day DATE AS (DATE(shipped_at)) VIRTUAL,
	PRIMARY KEY (id),
	KEY idx_line (line_no, order_id),
	CONSTRAINT fk_shipments_line FOREIGN KEY (line_no, order_id) REFERENCES shop.order_lines (line_no, order_id)
		ON DELETE SET NULL
) ENGINE=InnoDB;

-- The typical legacy table: MyISAM (cannot have foreign keys), latin1,
-- abbreviated Spanish names, and the "foreign key" only lives in the name.
CREATE TABLE shop.legacy_invoices (
	id_factura INT NOT NULL AUTO_INCREMENT,
	cod_cliente INT NOT NULL,
	imp_total DECIMAL(10,2) DEFAULT NULL,
	fec_alta DATE DEFAULT NULL,
	PRIMARY KEY (id_factura),
	KEY idx_cliente (cod_cliente)
) ENGINE=MyISAM DEFAULT CHARSET=latin1 COMMENT='Facturas antiguas (sin FKs)';

-- A table whose name contains a dot.
CREATE TABLE shop.`v1.old_orders` (
	id INT NOT NULL,
	PRIMARY KEY (id)
) ENGINE=InnoDB;

CREATE VIEW shop.paid_orders AS
	SELECT id, customer_id, total FROM shop.orders WHERE status = 'paid';

-- The reader has SELECT but not SHOW VIEW on crm: it sees this view, not its SQL.
CREATE VIEW crm.active_customers AS SELECT id, email FROM crm.customers WHERE status = 1;

CREATE TRIGGER shop.trg_orders_bi BEFORE INSERT ON shop.orders
	FOR EACH ROW SET NEW.total = GREATEST(NEW.total, 0);

CREATE PROCEDURE shop.close_order(IN p_id INT)
	UPDATE shop.orders SET status = 'cancelled' WHERE id = p_id;

CREATE FUNCTION shop.order_count() RETURNS INT READS SQL DATA
	RETURN (SELECT COUNT(*) FROM shop.orders);

CREATE TABLE secret.api_keys (
	id INT NOT NULL,
	PRIMARY KEY (id)
) ENGINE=InnoDB;

INSERT INTO crm.customers (email, name) VALUES ('ana@example.com', 'Ana'), ('luis@example.com', 'Luis');
INSERT INTO shop.orders (customer_id, total, status) VALUES (1, 10.50, 'paid'), (2, 99.00, 'draft');

-- A read-only user like the one heydb recommends: it sees shop and crm, not secret.
CREATE USER 'heydb_reader'@'%' IDENTIFIED BY 'reader-pass';
GRANT SELECT, SHOW VIEW ON shop.* TO 'heydb_reader'@'%';
GRANT SELECT ON crm.* TO 'heydb_reader'@'%';
