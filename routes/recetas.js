// =====================================================================
//  /api/recetas · Relación producto–insumo (cuánto insumo lleva 1 unidad)
// =====================================================================
const router = require('express').Router();
const db = require('../db');
const { verificarToken, permitir } = require('../middleware/auth');
const { httpError, ruta, idValido, numero } = require('../utils/http');

router.use(verificarToken, permitir('admin', 'repostero'));

const leerReceta = (q, productoId) => q.query(
  `SELECT r.insumo_id, i.nombre, i.unidad, r.cantidad, i.costo_unitario,
          (r.cantidad * i.costo_unitario) AS costo
   FROM recetas r JOIN insumos i ON i.id = r.insumo_id
   WHERE r.producto_id = $1 ORDER BY i.nombre`, [productoId]);

/** GET /api/recetas · Todas las recetas agrupadas por producto */
router.get('/', ruta(async (_req, res) => {
  const { rows } = await db.query(
    `SELECT p.id AS producto_id, p.nombre AS producto,
            json_agg(json_build_object('insumo_id', i.id, 'nombre', i.nombre,
                     'unidad', i.unidad, 'cantidad', r.cantidad) ORDER BY i.nombre) AS insumos
     FROM recetas r JOIN productos p ON p.id = r.producto_id JOIN insumos i ON i.id = r.insumo_id
     WHERE p.activo GROUP BY p.id ORDER BY p.nombre`);
  res.json(rows);
}));

/** GET /api/recetas/:productoId · Receta + costo de producción por unidad */
router.get('/:productoId', ruta(async (req, res) => {
  const id = idValido(req.params.productoId, 'Producto');
  const { rows } = await leerReceta(db, id);
  res.json({ producto_id: id, insumos: rows, costo_unitario: rows.reduce((t, r) => t + r.costo, 0) });
}));

/**
 * PUT /api/recetas/:productoId  { insumos: [{ insumo_id, cantidad }] }
 * Reemplaza la receta completa en una transacción (todo o nada).
 */
router.put('/:productoId', permitir('admin'), ruta(async (req, res) => {
  const productoId = idValido(req.params.productoId, 'Producto');
  const lista = req.body.insumos;
  if (!Array.isArray(lista)) throw httpError(400, 'Envía "insumos" como arreglo.');

  const ids = [], cants = [];
  for (const it of lista) {
    const iid = idValido(it.insumo_id, 'Insumo');
    if (ids.includes(iid)) throw httpError(400, 'Un insumo aparece repetido en la receta.');
    ids.push(iid);
    cants.push(numero(it.cantidad, 'Cantidad', { estricto: true }));
  }

  const receta = await db.transaccion(async c => {
    const p = await c.query('SELECT id FROM productos WHERE id = $1 AND activo FOR UPDATE', [productoId]);
    if (!p.rows[0]) throw httpError(404, 'Producto no encontrado.');
    if (ids.length) {
      const ok = await c.query('SELECT COUNT(*) AS n FROM insumos WHERE id = ANY($1::int[]) AND activo', [ids]);
      if (ok.rows[0].n !== ids.length) throw httpError(404, 'Algún insumo no existe o está inactivo.');
    }
    await c.query('DELETE FROM recetas WHERE producto_id = $1', [productoId]);
    if (ids.length)
      await c.query(
        `INSERT INTO recetas (producto_id, insumo_id, cantidad)
         SELECT $1, q.iid, q.cant FROM unnest($2::int[], $3::numeric[]) AS q(iid, cant)`,
        [productoId, ids, cants]);
    return (await leerReceta(c, productoId)).rows;
  });
  res.json({ producto_id: productoId, insumos: receta });
}));

/** DELETE /api/recetas/:productoId/:insumoId · Quita un insumo de la receta */
router.delete('/:productoId/:insumoId', permitir('admin'), ruta(async (req, res) => {
  const { rowCount } = await db.query(
    'DELETE FROM recetas WHERE producto_id = $1 AND insumo_id = $2',
    [idValido(req.params.productoId, 'Producto'), idValido(req.params.insumoId, 'Insumo')]);
  if (!rowCount) throw httpError(404, 'Ese insumo no está en la receta.');
  res.json({ mensaje: 'Insumo quitado de la receta.' });
}));

module.exports = router;
