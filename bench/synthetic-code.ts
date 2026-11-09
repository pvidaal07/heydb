// A tiny code and docs tree for the synthetic legacy ERP (legacy-erp.ts), so
// the code-grep strategy has something to search: a few SQL scripts, PHP
// classes and Markdown notes naming the generic tables with the Spanish
// business words a team writes. Generic and deterministic, like the schema.
// It also holds what a grep must skip: a dependency under node_modules and a
// binary file.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FILES: Readonly<Record<string, string>> = {
	"sql/informes_facturacion.sql": `-- Informe de facturas pendientes de cobro por cliente
SELECT c.ser, c.num_fac, c.cod_cli, c.tot, v.fec_ven, v.imp
FROM fac_cab c
JOIN fac_ven v ON v.ser = c.ser AND v.num_fac = c.num_fac
WHERE v.cob = 0
ORDER BY v.fec_ven;

-- Líneas de factura con su artículo
SELECT l.num_fac, l.cod_art, l.can, l.pre FROM fac_lin l;
`,
	"sql/contabilidad.sql": `-- Asientos de un ejercicio con sus apuntes
SELECT a.num_asi, a.fec, a.con, p.cod_cta, p.deb, p.hab
FROM cta_asi a
JOIN cta_apu p ON p.eje = a.eje AND p.num_asi = a.num_asi
WHERE a.eje = :ejercicio;
`,
	"app/Clientes.php": `<?php
// Mantenimiento de clientes: ficha, direcciones y contactos.
class Clientes
{
    public function ficha(int $codigo): array
    {
        return $this->db->row('SELECT * FROM cli WHERE cod_cli = ?', [$codigo]);
    }

    // Dirección de envío (tip = 'E') o fiscal (tip = 'F')
    public function direcciones(int $codigo): array
    {
        return $this->db->rows('SELECT * FROM cli_dir WHERE cod_cli = ?', [$codigo]);
    }

    public function contactos(int $codigo): array
    {
        return $this->db->rows('SELECT nom, tel, mail FROM cli_con WHERE cod_cli = ?', [$codigo]);
    }
}
`,
	"app/Albaranes.php": `<?php
// Albaranes de venta: cabecera y líneas
class Albaranes
{
    public function lineas(string $serie, int $numero): array
    {
        return $this->db->rows('SELECT * FROM alb_lin WHERE ser = ? AND num_alb = ? ORDER BY lin', [$serie, $numero]);
    }

    public function pendientesDeFacturar(): array
    {
        return $this->db->rows('SELECT * FROM alb_cab WHERE fac = 0');
    }
}
`,
	"app/Pedidos.php": `<?php
// Pedidos de clientes; est = 'P' pendiente de servir
class Pedidos
{
    public function pendientes(int $cliente): array
    {
        return $this->db->rows("SELECT * FROM ped_cab WHERE cod_cli = ? AND est = 'P'", [$cliente]);
    }
}
`,
	"app/Almacen.php": `<?php
// Existencias por almacén y movimientos de almacén
class Almacen
{
    public function existencias(string $articulo): array
    {
        return $this->db->rows('SELECT cod_alm, can, can_res FROM art_sto WHERE cod_art = ?', [$articulo]);
    }

    public function movimientos(string $articulo): array
    {
        return $this->db->rows('SELECT * FROM alm_mov WHERE cod_art = ? ORDER BY fec', [$articulo]);
    }
}
`,
	"app/Tarifas.php": `<?php
// Precio de venta de un artículo según la tarifa del cliente
class Tarifas
{
    public function precio(int $tarifa, string $articulo): ?float
    {
        return $this->db->value('SELECT pre FROM art_tar WHERE cod_tar = ? AND cod_art = ?', [$tarifa, $articulo]);
    }
}
`,
	"app/Remesas.php": `<?php
// Remesas de recibos al banco
class Remesas
{
    public function crear(int $banco): int
    {
        return $this->db->insert('cob_rem', ['cod_ban' => $banco, 'fec' => date('Y-m-d')]);
    }
}
`,
	"docs/nominas.md": `# Nóminas

Cada mes se genera una nómina por empleado en \`emp_nom\` (bruto y neto).
Los empleados están en \`emp\`.
`,
	"docs/README.md": `# ERP

Módulos: clientes, artículos, almacén, pedidos, albaranes, facturación,
cobros, contabilidad y nóminas. Cada empresa tiene su propia base de datos.
`,
	"node_modules/informes/index.js": "// Una dependencia: no es código del proyecto.\nmodule.exports = { facturas: 'fac_cab', clientes: 'cli' };\n",
};

/** Writes the tree under `dir` (created if missing). */
export function writeSyntheticCode(dir: string): void {
	for (const [path, content] of Object.entries(FILES)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), content);
	}
	// A binary file that mentions a table: grep must skip it.
	writeFileSync(join(dir, "docs", "logo.png"), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]), Buffer.from("fac_cab clientes")]));
}
