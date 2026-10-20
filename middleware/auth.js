// Middlewares de autenticación (JWT) y autorización por rol
const jwt = require('jsonwebtoken');

/** Exige un token válido en el header: Authorization: Bearer <token> */
function verificarToken(req, res, next) {
  const [tipo, token] = (req.headers.authorization || '').split(' ');
  if (tipo !== 'Bearer' || !token) return res.status(401).json({ error: 'Token requerido.' });
  try {
    req.usuario = jwt.verify(token, process.env.JWT_SECRET); // { id, username, rol }
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado.' });
  }
}

/** Restringe la ruta a ciertos roles. Uso: permitir('admin') */
const permitir = (...roles) => (req, res, next) =>
  roles.includes(req.usuario?.rol) ? next() : res.status(403).json({ error: 'No tienes permisos para esta acción.' });

module.exports = { verificarToken, permitir };
