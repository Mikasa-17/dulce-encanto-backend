// =====================================================================
//  /api/productos · CRUD con borrado lógico — RF-01, RF-02, RF-13, RF-14
// =====================================================================
const router = require('express').Router();
const db = require('../db');
const { verificarToken, permitir } = require('../middleware/auth');
const { httpError, ruta, idValido, numero, texto } = require('../utils/http');

const CAMPOS = 'id, nombre, categoria, precio, stock, stock_min, (stock <= stock_min) AS critico';

router.use(verificarToken);

function leerProducto(b) {
  return {
    nombre: texto(b.nombre, 'Nombre', 60),
    categoria: texto(b.categoria, 'Categoría', 30),
    precio: numero(b.precio, 'Precio', { estricto: true }),
    stock_min: numero(b.stock_min ?? 3, 'Stock mínimo', { entero: true })
  };
}
const nombreDuplicado = e => {
  if (e.code === '23505') throw httpError(409, 'Ya existe un producto con ese nombre.');
  throw e;
};

/** GET /api/productos?q=texto&criticos=1 · Lista productos activos (todos los roles) */
router.get('/', ruta(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const { rows } = await db.query(
    `SELECT ${CAMPOS} FROM productos
     WHERE activo
       AND ($1 = '' OR (nombre || ' ' || categoria) ILIKE '%' || $1 || '%')
       AND ($2 = false OR stock <= stock_min)
     ORDER BY nombre`, [q, req.query.criticos === '1']);
  res.json(rows);
}));

/** GET /api/productos/:id · Incluye su receta */
router.get('/:id', ruta(async (req, res) => {
  const id = idValido(req.params.id);
  const { rows } = await db.query(
    `SELECT ${CAMPOS},
       COALESCE((SELECT json_agg(json_build_object('insumo_id', i.id, 'nombre', i.nombre,
                                 'unidad', i.unidad, 'cantidad', r.cantidad) ORDER BY i.nombre)
                 FROM recetas r JOIN insumos i ON i.id = r.insumo_id
                 WHERE r.producto_id = p.id), '[]') AS receta
     FROM productos p WHERE id = $1 AND activo`, [id]);
  if (!rows[0]) throw httpError(404, 'Producto no encontrado.');
  res.json(rows[0]);
}));

/** POST /api/productos  { nombre, categoria, precio, stock_min } · Nace con stock 0 */
router.post('/', permitir('admin'), ruta(async (req, res) => {
  const p = leerProducto(req.body);
  const { rows } = await db.query(
    `INSERT INTO productos (nombre, categoria, precio, stock_min) VALUES ($1, $2, $3, $4)
     RETURNING ${CAMPOS}`, [p.nombre, p.categoria, p.precio, p.stock_min]).catch(nombreDuplicado);
  res.status(201).json(rows[0]);
}));

/** PUT /api/productos/:id · No modifica el stock (eso va por /entrada o por ventas) */
router.put('/:id', permitir('admin'), ruta(async (req, res) => {
  const id = idValido(req.params.id);
  const p = leerProducto(req.body);
  const { rows } = await db.query(
    `UPDATE productos SET nombre = $1, categoria = $2, precio = $3, stock_min = $4
     WHERE id = $5 AND activo RETURNING ${CAMPOS}`,
    [p.nombre, p.categoria, p.precio, p.stock_min, id]).catch(nombreDuplicado);
  if (!rows[0]) throw httpError(404, 'Producto no encontrado.');
  res.json(rows[0]);
}));

/** DELETE /api/productos/:id · Borrado lógico: las ventas históricas se conservan */
router.delete('/:id', permitir('admin'), ruta(async (req, res) => {
  const id = idValido(req.params.id);
  const { rowCount } = await db.query('UPDATE productos SET activo = false WHERE id = $1 AND activo', [id]);
  if (!rowCount) throw httpError(404, 'Producto no encontrado.');
  res.json({ mensaje: 'Producto eliminado.' });
}));

/** POST /api/productos/:id/entrada  { cantidad } · Entrada de stock (RF-14) */
router.post('/:id/entrada', permitir('admin', 'repostero'), ruta(async (req, res) => {
  const id = idValido(req.params.id);
  const cantidad = numero(req.body.cantidad, 'Cantidad', { estricto: true, entero: true });
  const { rows } = await db.query(
    `UPDATE productos SET stock = stock + $1 WHERE id = $2 AND activo RETURNING ${CAMPOS}`, [cantidad, id]);
  if (!rows[0]) throw httpError(404, 'Producto no encontrado.');
  res.json(rows[0]);
}));

module.exports = router;
