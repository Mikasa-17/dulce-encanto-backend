// =====================================================================
//  /api/insumos · Materia prima (harina, huevos, azúcar...)
// =====================================================================
const router = require('express').Router();
const db = require('../db');
const { verificarToken, permitir } = require('../middleware/auth');
const { httpError, ruta, idValido, numero, texto } = require('../utils/http');

const UNIDADES = ['g', 'kg', 'ml', 'l', 'und'];
const CAMPOS = 'id, nombre, unidad, stock, stock_min, costo_unitario, (stock <= stock_min) AS critico';

router.use(verificarToken, permitir('admin', 'repostero'));

function leerInsumo(b) {
  const unidad = String(b.unidad || '').trim();
  if (!UNIDADES.includes(unidad)) throw httpError(400, `Unidad inválida (${UNIDADES.join(', ')}).`);
  return {
    nombre: texto(b.nombre, 'Nombre', 60),
    unidad,
    stock_min: numero(b.stock_min ?? 0, 'Stock mínimo'),
    costo_unitario: numero(b.costo_unitario ?? 0, 'Costo unitario')
  };
}
const nombreDuplicado = e => {
  if (e.code === '23505') throw httpError(409, 'Ya existe un insumo con ese nombre.');
  throw e;
};

/** GET /api/insumos?criticos=1 */
router.get('/', ruta(async (req, res) => {
  const { rows } = await db.query(
    `SELECT ${CAMPOS} FROM insumos WHERE activo AND ($1 = false OR stock <= stock_min) ORDER BY nombre`,
    [req.query.criticos === '1']);
  res.json(rows);
}));

/** POST /api/insumos  { nombre, unidad, stock?, stock_min, costo_unitario } */
router.post('/', permitir('admin'), ruta(async (req, res) => {
  const i = leerInsumo(req.body);
  const stock = numero(req.body.stock ?? 0, 'Stock inicial');
  const { rows } = await db.query(
    `INSERT INTO insumos (nombre, unidad, stock, stock_min, costo_unitario)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${CAMPOS}`,
    [i.nombre, i.unidad, stock, i.stock_min, i.costo_unitario]).catch(nombreDuplicado);
  res.status(201).json(rows[0]);
}));

/** PUT /api/insumos/:id · No toca el stock */
router.put('/:id', permitir('admin'), ruta(async (req, res) => {
  const id = idValido(req.params.id);
  const i = leerInsumo(req.body);
  const { rows } = await db.query(
    `UPDATE insumos SET nombre = $1, unidad = $2, stock_min = $3, costo_unitario = $4
     WHERE id = $5 AND activo RETURNING ${CAMPOS}`,
    [i.nombre, i.unidad, i.stock_min, i.costo_unitario, id]).catch(nombreDuplicado);
  if (!rows[0]) throw httpError(404, 'Insumo no encontrado.');
  res.json(rows[0]);
}));

/** DELETE /api/insumos/:id · Lógico; bloqueado si alguna receta lo usa */
router.delete('/:id', permitir('admin'), ruta(async (req, res) => {
  const id = idValido(req.params.id);
  const { rows: usos } = await db.query(
    `SELECT p.nombre FROM recetas r JOIN productos p ON p.id = r.producto_id
     WHERE r.insumo_id = $1 AND p.activo ORDER BY p.nombre`, [id]);
  if (usos.length)
    throw httpError(409, `No se puede eliminar: se usa en la receta de ${usos.map(u => u.nombre).join(', ')}.`);
  const { rowCount } = await db.query('UPDATE insumos SET activo = false WHERE id = $1 AND activo', [id]);
  if (!rowCount) throw httpError(404, 'Insumo no encontrado.');
  res.json({ mensaje: 'Insumo eliminado.' });
}));

/** POST /api/insumos/:id/entrada  { cantidad, costo_unitario? } · Compra de materia prima */
router.post('/:id/entrada', ruta(async (req, res) => {
  const id = idValido(req.params.id);
  const cantidad = numero(req.body.cantidad, 'Cantidad', { estricto: true });
  const costo = req.body.costo_unitario === undefined || req.body.costo_unitario === ''
    ? null : numero(req.body.costo_unitario, 'Costo unitario');
  const { rows } = await db.query(
    `UPDATE insumos SET stock = stock + $1, costo_unitario = COALESCE($2, costo_unitario)
     WHERE id = $3 AND activo RETURNING ${CAMPOS}`, [cantidad, costo, id]);
  if (!rows[0]) throw httpError(404, 'Insumo no encontrado.');
  res.json(rows[0]);
}));

module.exports = router;
