// =====================================================================
//  /api/ventas · Registro transaccional de ventas — RF-05, RF-06, RF-10
// =====================================================================
const router = require('express').Router();
const db = require('../db');
const { verificarToken, permitir } = require('../middleware/auth');
const { httpError, ruta, idValido, numero } = require('../utils/http');
const { clientePorNombre } = require('../utils/clientes');

const METODOS = ['Efectivo', 'Tarjeta', 'Transferencia'];
const MAX_LINEAS = 50;
const TZ = () => process.env.APP_TZ || 'America/Bogota';
const r3 = n => Math.round(n * 1000) / 1000;

router.use(verificarToken);

/**
 * POST /api/ventas
 * Body: { items: [{ producto_id, cantidad }], cliente?: "Nombre", metodo_pago: "Efectivo|Tarjeta|Transferencia" }
 *
 * Todo ocurre en UNA transacción:
 *  1. Bloquea (FOR UPDATE) los productos y verifica su stock.
 *  2. Cruza las recetas, bloquea los insumos y verifica que alcancen.
 *  3. Descuenta productos e insumos.
 *  4. Crea la venta y su detalle (el precio sale de la BD, nunca del navegador).
 * Cualquier fallo → ROLLBACK: no se descuenta nada.
 */
router.post('/', permitir('admin', 'cajero'), ruta(async (req, res) => {
  const { items, metodo_pago } = req.body;
  const nombreCliente = String(req.body.cliente || '').trim().slice(0, 80);

  // ---------- Validación previa (sin tocar la BD)
  if (!METODOS.includes(metodo_pago))
    throw httpError(400, 'Método de pago inválido (Efectivo, Tarjeta o Transferencia).');
  if (!Array.isArray(items) || !items.length) throw httpError(400, 'El carrito está vacío.');
  if (items.length > MAX_LINEAS) throw httpError(400, `Máximo ${MAX_LINEAS} productos por venta.`);

  const pedido = new Map(); // producto_id -> cantidad (une líneas repetidas)
  for (const it of items) {
    const id = idValido(it.producto_id, 'Producto');
    const cant = numero(it.cantidad, 'Cantidad', { estricto: true, entero: true });
    pedido.set(id, (pedido.get(id) || 0) + cant);
  }
  // Orden por id → los bloqueos siempre se toman en el mismo orden (evita deadlocks)
  const ids = [...pedido.keys()].sort((a, b) => a - b);
  const cants = ids.map(id => pedido.get(id));

  const venta = await db.transaccion(async c => {
    // ---------- 1. Productos: bloquear y verificar stock
    const { rows: prods } = await c.query(
      `SELECT id, nombre, precio, stock FROM productos
       WHERE id = ANY($1::int[]) AND activo ORDER BY id FOR UPDATE`, [ids]);
    if (prods.length !== ids.length) throw httpError(404, 'Uno o más productos no existen o fueron eliminados.');

    const sinStock = prods.filter(p => p.stock < pedido.get(p.id));
    if (sinStock.length)
      throw httpError(409, 'Stock insuficiente: ' + sinStock
        .map(p => `${p.nombre} (disponible: ${p.stock}, solicitado: ${pedido.get(p.id)})`).join('; '));

    // ---------- 2. Insumos: bloquear y calcular lo requerido según las recetas
    await c.query(
      `SELECT id FROM insumos
       WHERE id IN (SELECT insumo_id FROM recetas WHERE producto_id = ANY($1::int[]))
       ORDER BY id FOR UPDATE`, [ids]);

    const { rows: insumos } = await c.query(
      `SELECT i.id, i.nombre, i.unidad, i.stock, i.activo, SUM(r.cantidad * q.cant) AS requerido
       FROM recetas r
       JOIN unnest($1::int[], $2::int[]) AS q(pid, cant) ON q.pid = r.producto_id
       JOIN insumos i ON i.id = r.insumo_id
       GROUP BY i.id ORDER BY i.id`, [ids, cants]);

    const faltantes = insumos.filter(i => !i.activo || i.stock < i.requerido);
    if (faltantes.length)
      throw httpError(409, 'Insumos insuficientes: ' + faltantes.map(i => i.activo
        ? `${i.nombre} (faltan ${r3(i.requerido - i.stock)} ${i.unidad})`
        : `${i.nombre} (inactivo)`).join('; '));

    // ---------- 3. Descontar inventarios (el CHECK stock >= 0 de la tabla es la última barrera)
    await c.query(
      `UPDATE productos p SET stock = p.stock - q.cant
       FROM unnest($1::int[], $2::int[]) AS q(pid, cant) WHERE p.id = q.pid`, [ids, cants]);

    if (insumos.length)
      await c.query(
        `UPDATE insumos i SET stock = i.stock - q.req
         FROM unnest($1::int[], $2::numeric[]) AS q(iid, req) WHERE i.id = q.iid`,
        [insumos.map(i => i.id), insumos.map(i => i.requerido)]);

    // ---------- 4. Cliente (registro automático, RF-09) + cabecera + detalle
    const conCliente = nombreCliente && nombreCliente.toLowerCase() !== 'mostrador';
    const clienteId = conCliente ? await clientePorNombre(c, nombreCliente) : null;

    const { rows: [v] } = await c.query(
      `INSERT INTO ventas (usuario_id, cliente_id, metodo_pago) VALUES ($1, $2, $3)
       RETURNING id, folio, fecha`, [req.usuario.id, clienteId, metodo_pago]);

    await c.query(
      `INSERT INTO detalle_ventas (venta_id, producto_id, cantidad, precio_unitario)
       SELECT $1, p.id, q.cant, p.precio
       FROM unnest($2::int[], $3::int[]) AS q(pid, cant) JOIN productos p ON p.id = q.pid`,
      [v.id, ids, cants]);

    // El trigger trg_detalle_total ya calculó el total
    const { rows: [t] } = await c.query('SELECT total FROM ventas WHERE id = $1', [v.id]);

    return {
      id: v.id, folio: v.folio, fecha: v.fecha, total: t.total, metodo_pago,
      cajero: req.usuario.username,
      cliente: conCliente ? nombreCliente : 'Mostrador',
      items: prods.map(p => ({ producto_id: p.id, nombre: p.nombre, precio: p.precio, cantidad: pedido.get(p.id) })),
      insumos_descontados: insumos.map(i => ({ nombre: i.nombre, cantidad: r3(i.requerido), unidad: i.unidad }))
    };
  });

  res.status(201).json(venta);
}));

/** GET /api/ventas?limite=50 · Últimas ventas con su detalle */
router.get('/', permitir('admin', 'cajero'), ruta(async (req, res) => {
  const limite = Math.min(Number(req.query.limite) || 50, 500);
  const { rows } = await db.query(
    `SELECT v.id, v.folio, v.fecha, v.total, v.metodo_pago, u.username AS cajero,
            COALESCE(c.nombre, 'Mostrador') AS cliente,
            json_agg(json_build_object('nombre', p.nombre, 'cantidad', d.cantidad,
                     'precio', d.precio_unitario) ORDER BY d.id) AS items
     FROM ventas v
     JOIN usuarios u ON u.id = v.usuario_id
     LEFT JOIN clientes c ON c.id = v.cliente_id
     JOIN detalle_ventas d ON d.venta_id = v.id
     JOIN productos p ON p.id = d.producto_id
     GROUP BY v.id, u.username, c.nombre
     ORDER BY v.fecha DESC LIMIT $1`, [limite]);
  res.json(rows);
}));

/** GET /api/ventas/resumen · KPIs y gráficos del dashboard */
router.get('/resumen', permitir('admin', 'cajero', 'repostero'), ruta(async (_req, res) => {
  const tz = TZ();
  const [kpis, dias, top] = await Promise.all([
    db.query(
      `SELECT
         (SELECT COALESCE(SUM(total), 0) FROM ventas
           WHERE (fecha AT TIME ZONE $1)::date = (NOW() AT TIME ZONE $1)::date)        AS ventas_hoy,
         (SELECT COUNT(*) FROM pedidos WHERE estado NOT IN ('Entregado', 'Cancelado')) AS pedidos_activos,
         (SELECT COUNT(*) FROM productos WHERE activo)                                AS productos,
         (SELECT COUNT(*) FROM v_stock_critico)                                       AS stock_critico,
         (SELECT COUNT(*) FROM v_insumos_criticos)                                    AS insumos_criticos`, [tz]),
    db.query(
      `SELECT to_char(d, 'YYYY-MM-DD') AS dia, COALESCE(SUM(v.total), 0) AS total
       FROM generate_series((NOW() AT TIME ZONE $1)::date - 6, (NOW() AT TIME ZONE $1)::date, interval '1 day') AS d
       LEFT JOIN ventas v ON (v.fecha AT TIME ZONE $1)::date = d::date
       GROUP BY d ORDER BY d`, [tz]),
    db.query(
      `SELECT p.nombre, SUM(d.cantidad) AS unidades
       FROM detalle_ventas d JOIN productos p ON p.id = d.producto_id
       GROUP BY p.nombre ORDER BY unidades DESC LIMIT 5`)
  ]);
  res.json({ ...kpis.rows[0], ultimos7: dias.rows, top: top.rows });
}));

/** GET /api/ventas/reporte?periodo=dia|semana|mes · RF-10 */
const PERIODOS = {
  dia:    ['day',   'YYYY-MM-DD', ''],
  semana: ['week',  'YYYY-MM-DD', 'Semana del '], // las semanas inician el lunes
  mes:    ['month', 'YYYY-MM',    '']
};
router.get('/reporte', permitir('admin'), ruta(async (req, res) => {
  const p = PERIODOS[req.query.periodo] || PERIODOS.dia;
  const { rows } = await db.query(
    `SELECT $3::text || to_char(date_trunc($1::text, fecha AT TIME ZONE $4), $2::text) AS periodo,
            COUNT(*)                                             AS ventas,
            SUM(total)                                           AS total,
            SUM(total) FILTER (WHERE metodo_pago = 'Efectivo')      AS efectivo,
            SUM(total) FILTER (WHERE metodo_pago = 'Tarjeta')       AS tarjeta,
            SUM(total) FILTER (WHERE metodo_pago = 'Transferencia') AS transferencia
     FROM ventas GROUP BY 1 ORDER BY 1`, [...p, TZ()]);
  res.json(rows);
}));

module.exports = router;
