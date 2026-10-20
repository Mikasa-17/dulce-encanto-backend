// =====================================================================
//  /api/pedidos · Pedidos por encargo — RF-07, RF-08, RF-15
// =====================================================================
const router = require('express').Router();
const db = require('../db');
const { verificarToken, permitir } = require('../middleware/auth');
const { httpError, ruta, idValido, texto } = require('../utils/http');
const { clientePorNombre, clienteDeUsuario } = require('../utils/clientes');

const ESTADOS = ['Pendiente', 'En preparación', 'Listo', 'Entregado', 'Cancelado'];

router.use(verificarToken);

/** GET /api/pedidos?activos=1 · El rol cliente solo ve sus propios pedidos */
router.get('/', ruta(async (req, res) => {
  const filtros = [], params = [];
  if (req.usuario.rol === 'cliente') {
    params.push(req.usuario.id);
    filtros.push(`c.usuario_id = $${params.length}`);
  }
  if (req.query.activos === '1') filtros.push(`p.estado NOT IN ('Entregado', 'Cancelado')`);

  const { rows } = await db.query(
    `SELECT p.id, c.nombre AS cliente, p.fecha_entrega, p.detalle, p.estado, p.creado_en
     FROM pedidos p JOIN clientes c ON c.id = p.cliente_id
     ${filtros.length ? 'WHERE ' + filtros.join(' AND ') : ''}
     ORDER BY p.fecha_entrega`, params);
  res.json(rows);
}));

/** POST /api/pedidos  { cliente, fecha_entrega (ISO), detalle? } */
router.post('/', ruta(async (req, res) => {
  const fecha = new Date(req.body.fecha_entrega);
  if (Number.isNaN(fecha.getTime())) throw httpError(400, 'Fecha de entrega inválida.');
  if (fecha <= new Date()) throw httpError(400, 'La fecha de entrega debe ser futura.');
  const detalle = String(req.body.detalle || '').trim();
  if (detalle.length > 120) throw httpError(400, 'Detalle: máximo 120 caracteres.');

  const pedido = await db.transaccion(async c => {
    // Un cliente siempre pide a su nombre; el personal puede pedir para cualquiera
    const cliente = req.usuario.rol === 'cliente'
      ? await clienteDeUsuario(c, req.usuario)
      : { id: await clientePorNombre(c, texto(req.body.cliente, 'Cliente', 80)), nombre: String(req.body.cliente).trim() };

    const { rows } = await c.query(
      `INSERT INTO pedidos (cliente_id, usuario_id, fecha_entrega, detalle)
       VALUES ($1, $2, $3, $4) RETURNING id, fecha_entrega, detalle, estado`,
      [cliente.id, req.usuario.id, fecha, detalle || null]);
    return { ...rows[0], cliente: cliente.nombre };
  });

  res.status(201).json(pedido);
}));

/** PATCH /api/pedidos/:id/estado  { estado } · Un pedido Entregado o Cancelado ya no cambia */
router.patch('/:id/estado', permitir('admin', 'cajero', 'repostero'), ruta(async (req, res) => {
  const id = idValido(req.params.id);
  const { estado } = req.body;
  if (!ESTADOS.includes(estado)) throw httpError(400, `Estado inválido (${ESTADOS.join(', ')}).`);

  const { rows } = await db.query(
    `UPDATE pedidos SET estado = $1
     WHERE id = $2 AND estado NOT IN ('Entregado', 'Cancelado')
     RETURNING id, estado, actualizado_en`, [estado, id]);

  if (!rows[0]) {
    const existe = await db.query('SELECT estado FROM pedidos WHERE id = $1', [id]);
    if (!existe.rows[0]) throw httpError(404, 'Pedido no encontrado.');
    throw httpError(409, `El pedido ya está ${existe.rows[0].estado.toLowerCase()} y no se puede modificar.`);
  }
  res.json(rows[0]);
}));

module.exports = router;
