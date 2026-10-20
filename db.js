// Pool de conexiones a PostgreSQL + helper de transacciones
const { Pool, types } = require('pg');

// pg devuelve NUMERIC y BIGINT como texto; los convertimos a número para la API
types.setTypeParser(1700, v => (v === null ? null : parseFloat(v))); // NUMERIC
types.setTypeParser(20, v => (v === null ? null : parseInt(v, 10)));  // BIGINT (COUNT, SUM de enteros)

const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // Usamos la URL completa de Render
  ssl: { rejectUnauthorized: false },         // Mantenemos SSL por seguridad
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on('error', err => console.error('❌ Error inesperado en el pool de PostgreSQL:', err.message));

/**
 * Ejecuta fn(client) dentro de BEGIN/COMMIT usando UNA sola conexión.
 * Si fn lanza un error (de validación o de la BD) se hace ROLLBACK y se relanza.
 */
async function transaccion(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const resultado = await fn(client);
    await client.query('COMMIT');
    return resultado;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params), // siempre parametrizadas ($1, $2...)
  transaccion
};