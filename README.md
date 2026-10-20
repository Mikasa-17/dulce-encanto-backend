# Dulce Encanto · API (Node.js + Express + PostgreSQL)

## Instalación
1. pgAdmin 4 → crear BD `dulce_encanto` → Query Tool → ejecutar `db.sql`
   (si ya tenías la BD de la Fase 1: ejecuta solo `migrations/002_fase2.sql`).
2. `cp .env.example .env` y completar credenciales.
3. `npm install` → `npm run seed` → `npm run dev`
4. Abrir http://localhost:3000/v2SGBD.html

## Endpoints (todos requieren `Authorization: Bearer <token>` salvo login)
| Método | Ruta | Roles |
|---|---|---|
| POST | /api/auth/login · GET /api/auth/me · PATCH /api/auth/password | todos |
| GET/POST · PATCH /:id/estado · /:id/rol · /:id/password | /api/usuarios | admin |
| GET | /api/productos, /api/productos/:id | todos |
| POST · PUT /:id · DELETE /:id (lógico) | /api/productos | admin |
| POST | /api/productos/:id/entrada | admin, repostero |
| GET · POST /:id/entrada | /api/insumos | admin, repostero |
| POST · PUT /:id · DELETE /:id | /api/insumos | admin |
| GET /, GET /:productoId | /api/recetas | admin, repostero |
| PUT /:productoId · DELETE /:productoId/:insumoId | /api/recetas | admin |
| POST /, GET / | /api/ventas | admin, cajero |
| GET /resumen | /api/ventas | admin, cajero, repostero |
| GET /reporte?periodo=dia\|semana\|mes | /api/ventas | admin |
| GET / (?activos=1) · POST / | /api/pedidos | todos (cliente ve solo los suyos) |
| PATCH /:id/estado | /api/pedidos | admin, cajero, repostero |
| GET /nombres · GET / | /api/clientes | personal · admin, cajero |

### Ejemplo de venta
```json
POST /api/ventas
{ "cliente": "Ana", "metodo_pago": "Tarjeta",
  "items": [{ "producto_id": 1, "cantidad": 2 }, { "producto_id": 5, "cantidad": 3 }] }
```
Respuestas de error: `409 { "error": "Stock insuficiente: ..." }` o `409 { "error": "Insumos insuficientes: ..." }` (ROLLBACK completo).
