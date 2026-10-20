// =====================================================================
//  /api/usuarios · Gestión de usuarios (solo admin) — RF-11
// =====================================================================
const router = require('express').Router();
const bcrypt = require('bcrypt');
const db = require('../db');
const { verificarToken, permitir } = require('../middleware/auth');

const ROLES = ['admin', 'cajero', 'repostero', 'cliente'];
const ROUNDS = () => Number(process.env.BCRYPT_ROUNDS) || 12;
const CAMPOS = 'id, username, rol, activo, ultimo_login, creado_en'; // jamás password_hash

router.use(verificarToken, permitir('admin'));

/** GET /api/usuarios */
router.get('/', async (_req, res, next) => {
  try {
    const { rows } = await db.query(`SELECT ${CAMPOS} FROM usuarios ORDER BY id`);
    res.json(rows);
  } catch (e) { next(e); }
});

/** POST /api/usuarios  { username, password, rol } */
router.post('/', async (req, res, next) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const rol = req.body.rol;

    if (!/^[a-zA-Z0-9._-]{3,30}$/.test(username))
      return res.status(400).json({ error: 'Usuario: 3 a 30 caracteres (letras, números, . _ -).' });
    if (password.length < 8) return res.status(400).json({ error: 'La contraseña debe tener mínimo 8 caracteres.' });
    if (!ROLES.includes(rol)) return res.status(400).json({ error: 'Rol inválido.' });

    const hash = await bcrypt.hash(password, ROUNDS());
    const { rows } = await db.query(
      `INSERT INTO usuarios (username, password_hash, rol) VALUES ($1, $2, $3) RETURNING ${CAMPOS}`,
      [username, hash, rol]);
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Ese usuario ya existe.' });
    next(e);
  }
});

/** PATCH /api/usuarios/:id/estado · Activa / desactiva (equivale a alternarUsuario) */
router.patch('/:id/estado', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (id === req.usuario.id) return res.status(400).json({ error: 'No puedes desactivar tu propia cuenta.' });
    const { rows } = await db.query(
      `UPDATE usuarios SET activo = NOT activo WHERE id = $1 RETURNING ${CAMPOS}`, [id]);
    if (!rows[0]) return res.status(404).json({ error: 'Usuario no encontrado.' });
    res.json(rows[0]);
  } catch (e) { next(e); }
});

/** PATCH /api/usuarios/:id/rol  { rol } */
router.patch('/:id/rol', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!ROLES.includes(req.body.rol)) return res.status(400).json({ error: 'Rol inválido.' });
    if (id === req.usuario.id) return res.status(400).json({ error: 'No puedes cambiar tu propio rol.' });
    const { rows } = await db.query(
      `UPDATE usuarios SET rol = $1 WHERE id = $2 RETURNING ${CAMPOS}`, [req.body.rol, id]);
    if (!rows[0]) return res.status(404).json({ error: 'Usuario no encontrado.' });
    res.json(rows[0]);
  } catch (e) { next(e); }
});

/** PATCH /api/usuarios/:id/password  { password } · Restablecer contraseña (admin) */
router.patch('/:id/password', async (req, res, next) => {
  try {
    const password = String(req.body.password || '');
    if (password.length < 8) return res.status(400).json({ error: 'La contraseña debe tener mínimo 8 caracteres.' });
    const hash = await bcrypt.hash(password, ROUNDS());
    const { rowCount } = await db.query('UPDATE usuarios SET password_hash = $1 WHERE id = $2', [hash, Number(req.params.id)]);
    if (!rowCount) return res.status(404).json({ error: 'Usuario no encontrado.' });
    res.json({ mensaje: 'Contraseña restablecida.' });
  } catch (e) { next(e); }
});

module.exports = router;
