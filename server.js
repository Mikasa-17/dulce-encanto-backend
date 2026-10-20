// =====================================================================
//  Dulce Encanto · Servidor Express
// =====================================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');

if (!process.env.JWT_SECRET) {
  console.error('❌ Falta JWT_SECRET en el archivo .env');
  process.exit(1);
}

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// ---------- CORS: solo los orígenes declarados en .env
const origenes = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    // origin vacío = Postman, curl o el propio servidor (mismo origen)
    if (!origin || origenes.includes(origin)) return cb(null, true);
    cb(new Error('Origen no permitido por CORS: ' + origin));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '100kb' }));

// ---------- Frontend estático (opcional): coloca v2SGBD.html, SGBD.css y SGBD.js en /public
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Rutas de la API
app.use('/api/auth', require('./routes/auth'));
app.use('/api/usuarios', require('./routes/usuarios'));
app.use('/api/productos', require('./routes/productos'));
app.use('/api/insumos', require('./routes/insumos'));
app.use('/api/recetas', require('./routes/recetas'));
app.use('/api/ventas', require('./routes/ventas'));
app.use('/api/pedidos', require('./routes/pedidos'));
app.use('/api/clientes', require('./routes/clientes'));

// Salud del servicio + prueba de conexión a la BD
app.get('/api/health', async (_req, res) => {
  try {
    const { rows } = await db.query('SELECT NOW() AS hora, current_database() AS bd');
    res.json({ ok: true, ...rows[0] });
  } catch (e) {
    res.status(503).json({ ok: false, error: 'Base de datos no disponible' });
  }
});

// 404 para rutas /api desconocidas
app.use('/api', (_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

// Manejador central de errores
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'El cuerpo de la petición no es JSON válido.' });
  if (!err.status) console.error(err); // los errores de validación (4xx) no ensucian la consola
  if (err.message?.startsWith('Origen no permitido')) return res.status(403).json({ error: err.message });
  if (err.code === '23505') return res.status(409).json({ error: 'El registro ya existe.' });          // unique_violation
  if (err.code === '23503') return res.status(409).json({ error: 'Registro relacionado inexistente o en uso.' }); // foreign_key
  if (err.code === '23514') return res.status(409).json({ error: 'Operación rechazada: dejaría un stock negativo o un dato inválido.' });
  if (err.code === '22P02') return res.status(400).json({ error: 'Formato de dato inválido.' });
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Error interno del servidor' });
});

// ---------- Arranque: verifica la BD antes de escuchar
(async () => {
  try {
    const { rows } = await db.query('SELECT current_database() AS bd, version()');
    console.log(`✅ Conectado a PostgreSQL · BD: ${rows[0].bd}`);
    app.listen(PORT, () => console.log(`🚀 API escuchando en http://localhost:${PORT}`));
  } catch (e) {
    console.error('❌ No se pudo conectar a PostgreSQL:', e.message);
    console.error('   Revisa PGHOST, PGPORT, PGDATABASE, PGUSER y PGPASSWORD en .env');
    process.exit(1);
  }
})();

// Cierre ordenado
process.on('SIGINT', async () => { await db.pool.end(); process.exit(0); });
