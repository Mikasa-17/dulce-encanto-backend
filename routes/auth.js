// =====================================================================
//  /api/auth · Login con bcrypt + JWT
// =====================================================================
const router = require('express').Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { verificarToken } = require('../middleware/auth');

// Hash ficticio: se compara aunque el usuario no exista para que el tiempo
// de respuesta sea igual y no se pueda adivinar qué usuarios existen.
const HASH_FICTICIO = bcrypt.hashSync('usuario-inexistente', Number(process.env.BCRYPT_ROUNDS) || 12);

// Freno simple contra fuerza bruta: 5 intentos fallidos por usuario+IP cada 15 min
const intentos = new Map();
const VENTANA_MS = 15 * 60 * 1000, MAX_INTENTOS = 5;

/** POST /api/auth/login  { username, password } */
router.post('/login', async (req, res, next) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!username || !password) return res.status(400).json({ error: 'Usuario y contraseña son obligatorios.' });

    const clave = `${req.ip}|${username.toLowerCase()}`;
    const reg = intentos.get(clave);
    if (reg && reg.n >= MAX_INTENTOS && Date.now() - reg.t < VENTANA_MS)
      return res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos.' });

    const { rows } = await db.query(
      'SELECT id, username, password_hash, rol, activo FROM usuarios WHERE username = $1', [username]);
    const u = rows[0];

    const valido = await bcrypt.compare(password, u ? u.password_hash : HASH_FICTICIO);
    if (!u || !valido || !u.activo) {
      intentos.set(clave, { n: (reg && Date.now() - reg.t < VENTANA_MS ? reg.n : 0) + 1, t: Date.now() });
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' }); // mismo mensaje del frontend
    }

    intentos.delete(clave);
    await db.query('UPDATE usuarios SET ultimo_login = NOW() WHERE id = $1', [u.id]);

    const token = jwt.sign({ id: u.id, username: u.username, rol: u.rol }, process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' });

    res.json({ token, usuario: { id: u.id, username: u.username, rol: u.rol } }); // nunca se devuelve el hash
  } catch (e) { next(e); }
});

/** GET /api/auth/me · Devuelve el usuario del token (para restaurar la sesión al recargar) */
router.get('/me', verificarToken, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT id, username, rol, activo FROM usuarios WHERE id = $1', [req.usuario.id]);
    if (!rows[0] || !rows[0].activo) return res.status(401).json({ error: 'Sesión no válida.' });
    res.json(rows[0]);
  } catch (e) { next(e); }
});

/** PATCH /api/auth/password  { actual, nueva } · Cambio de contraseña propia */
router.patch('/password', verificarToken, async (req, res, next) => {
  try {
    const { actual = '', nueva = '' } = req.body;
    if (String(nueva).length < 8) return res.status(400).json({ error: 'La nueva contraseña debe tener mínimo 8 caracteres.' });

    const { rows } = await db.query('SELECT password_hash FROM usuarios WHERE id = $1', [req.usuario.id]);
    if (!rows[0] || !(await bcrypt.compare(String(actual), rows[0].password_hash)))
      return res.status(401).json({ error: 'La contraseña actual no es correcta.' });

    const hash = await bcrypt.hash(String(nueva), Number(process.env.BCRYPT_ROUNDS) || 12);
    await db.query('UPDATE usuarios SET password_hash = $1 WHERE id = $2', [hash, req.usuario.id]);
    res.json({ mensaje: 'Contraseña actualizada.' });
  } catch (e) { next(e); }
});

module.exports = router;
