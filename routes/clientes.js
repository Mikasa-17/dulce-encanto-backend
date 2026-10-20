// =====================================================================
//  /api/clientes · Historial de clientes — RF-09
// =====================================================================
const router = require('express').Router();
const db = require('../db');
const { verificarToken, permitir } = require('../middleware/auth');
const { ruta } = require('../utils/http');

router.use(verificarToken);

/** GET /api/clientes/nombres · Para autocompletar (datalist) */
router.get('/nombres', permitir('admin', 'cajero', 'repostero'), ruta(async (_req, res) => {
  const { rows } = await db.query('SELECT nombre FROM clientes ORDER BY nombre');
  res.json(rows.map(r => r.nombre));
}));

/** GET /api/clientes · Clientes con su historial de compras */
router.get('/', permitir('admin', 'cajero'), ruta(async (_req, res) => {
  const { rows } = await db.query(
    `SELECT c.id, c.nombre, c.telefono, c.email,
            COUNT(v.id)                 AS num_compras,
            COALESCE(SUM(v.total), 0)   AS total_compras,
            COALESCE(json_agg(json_build_object('folio', v.folio, 'fecha', v.fecha,
                     'total', v.total, 'metodo_pago', v.metodo_pago) ORDER BY v.fecha DESC)
                     FILTER (WHERE v.id IS NOT NULL), '[]') AS compras
     FROM clientes c LEFT JOIN ventas v ON v.cliente_id = c.id
     GROUP BY c.id ORDER BY c.nombre`);
  res.json(rows);
}));

module.exports = router;
