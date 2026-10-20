// Resolución de clientes (equivale a registrarCliente() del frontend original — RF-09)
const { httpError } = require('./http');

/** Devuelve el id del cliente con ese nombre; si no existe lo crea. q = pool o client de transacción. */
async function clientePorNombre(q, nombre) {
  const { rows } = await q.query(
    `INSERT INTO clientes (nombre) VALUES ($1)
     ON CONFLICT (nombre) DO UPDATE SET nombre = EXCLUDED.nombre
     RETURNING id`, [nombre]);
  return rows[0].id;
}

/** Cliente vinculado a un usuario con rol "cliente" (lo crea y enlaza la primera vez). */
async function clienteDeUsuario(q, usuario) {
  const existente = await q.query('SELECT id, nombre FROM clientes WHERE usuario_id = $1', [usuario.id]);
  if (existente.rows[0]) return existente.rows[0];

  const { rows } = await q.query(
    `INSERT INTO clientes (nombre, usuario_id) VALUES ($1, $2)
     ON CONFLICT (nombre) DO UPDATE SET usuario_id = COALESCE(clientes.usuario_id, EXCLUDED.usuario_id)
     RETURNING id, nombre, usuario_id`, [usuario.username, usuario.id]);
  if (rows[0].usuario_id !== usuario.id)
    throw httpError(409, 'Tu nombre de cliente ya pertenece a otra cuenta. Contacta al administrador.');
  return rows[0];
}

module.exports = { clientePorNombre, clienteDeUsuario };
