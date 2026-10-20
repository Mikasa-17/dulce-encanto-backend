// Crea los usuarios demo con contraseñas hasheadas (bcrypt). Uso: npm run seed
require('dotenv').config();
const bcrypt = require('bcrypt');
const db = require('./db');

const DEMO = [
  ['admin', 'Admin2026!', 'admin'],
  ['cajero', 'Cajero2026!', 'cajero'],
  ['repostero', 'Repostero2026!', 'repostero'],
  ['cliente', 'Cliente2026!', 'cliente']
];

(async () => {
  try {
    for (const [user, pass, rol] of DEMO) {
      const hash = await bcrypt.hash(pass, Number(process.env.BCRYPT_ROUNDS) || 12);
      await db.query(
        `INSERT INTO usuarios (username, password_hash, rol) VALUES ($1, $2, $3)
         ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, rol = EXCLUDED.rol`,
        [user, hash, rol]);
      console.log(`✔ ${user} (${rol})`);
    }
    // Enlaza el usuario "cliente" con un registro en clientes
    await db.query(
      `INSERT INTO clientes (nombre, usuario_id)
       SELECT 'cliente', id FROM usuarios WHERE username = 'cliente'
       ON CONFLICT DO NOTHING`);
    console.log('✅ Usuarios demo creados. Cambia estas contraseñas en producción.');
  } catch (e) {
    console.error('❌', e.message);
    process.exitCode = 1;
  } finally {
    await db.pool.end();
  }
})();
