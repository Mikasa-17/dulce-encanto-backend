-- =====================================================================
--  Dulce Encanto · Script de base de datos (PostgreSQL 14+)
--  Ejecutar en pgAdmin 4 > Query Tool, conectado a la BD "dulce_encanto".
--  (Crear primero la BD: CREATE DATABASE dulce_encanto ENCODING 'UTF8';)
-- =====================================================================

BEGIN;

-- Limpieza (permite re-ejecutar el script en desarrollo)
DROP VIEW  IF EXISTS v_stock_critico, v_insumos_criticos;
DROP TABLE IF EXISTS detalle_ventas, ventas, pedidos, recetas, insumos,
                     productos, clientes, usuarios CASCADE;
DROP SEQUENCE IF EXISTS seq_folio_venta;
DROP TYPE IF EXISTS rol_usuario, estado_pedido, metodo_pago;

-- ---------- Tipos enumerados (equivalen a PERMISOS y ESTADOS del frontend)
CREATE TYPE rol_usuario   AS ENUM ('admin', 'cajero', 'repostero', 'cliente');
CREATE TYPE estado_pedido AS ENUM ('Pendiente', 'En preparación', 'Listo', 'Entregado', 'Cancelado');
CREATE TYPE metodo_pago   AS ENUM ('Efectivo', 'Tarjeta', 'Transferencia');

-- ---------- Función genérica para mantener actualizado_en
CREATE OR REPLACE FUNCTION fn_set_actualizado_en() RETURNS TRIGGER AS $$
BEGIN
  NEW.actualizado_en := NOW();
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

-- =====================================================================
-- 1. USUARIOS  (contraseña SOLO como hash bcrypt, nunca texto plano)
-- =====================================================================
CREATE TABLE usuarios (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username        VARCHAR(30)  NOT NULL,
  password_hash   VARCHAR(100) NOT NULL,              -- bcrypt: 60 caracteres
  rol             rol_usuario  NOT NULL DEFAULT 'cliente',
  activo          BOOLEAN      NOT NULL DEFAULT TRUE,
  ultimo_login    TIMESTAMPTZ,
  creado_en       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  actualizado_en  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_usuarios_username UNIQUE (username),
  CONSTRAINT ck_usuarios_username CHECK (length(trim(username)) >= 3),
  CONSTRAINT ck_usuarios_hash     CHECK (password_hash LIKE '$2%')   -- obliga formato bcrypt
);
CREATE TRIGGER trg_usuarios_upd BEFORE UPDATE ON usuarios
  FOR EACH ROW EXECUTE FUNCTION fn_set_actualizado_en();

-- =====================================================================
-- 2. CLIENTES  (opcionalmente enlazado a un usuario con rol 'cliente')
-- =====================================================================
CREATE TABLE clientes (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre      VARCHAR(80)  NOT NULL,
  telefono    VARCHAR(20),
  email       VARCHAR(120),
  direccion   VARCHAR(160),
  usuario_id  INTEGER UNIQUE REFERENCES usuarios(id) ON UPDATE CASCADE ON DELETE SET NULL,
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_clientes_nombre UNIQUE (nombre),
  CONSTRAINT ck_clientes_email  CHECK (email IS NULL OR email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

-- =====================================================================
-- 3. PRODUCTOS  (borrado lógico con "activo" para conservar ventas)
-- =====================================================================
CREATE TABLE productos (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre          VARCHAR(60)   NOT NULL,
  categoria       VARCHAR(30)   NOT NULL,
  precio          NUMERIC(12,2) NOT NULL CHECK (precio > 0),
  stock           INTEGER       NOT NULL DEFAULT 0 CHECK (stock >= 0),
  stock_min       INTEGER       NOT NULL DEFAULT 3 CHECK (stock_min >= 0),
  activo          BOOLEAN       NOT NULL DEFAULT TRUE,
  creado_en       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  actualizado_en  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
-- Nombre único sin distinguir mayúsculas (equivale a norm() del frontend)
CREATE UNIQUE INDEX uq_productos_nombre ON productos (lower(nombre)) WHERE activo;  -- único solo entre activos
CREATE INDEX ix_productos_categoria ON productos (categoria);
CREATE TRIGGER trg_productos_upd BEFORE UPDATE ON productos
  FOR EACH ROW EXECUTE FUNCTION fn_set_actualizado_en();

-- =====================================================================
-- 4. INSUMOS  (materia prima: harina, huevos, azúcar...)
-- =====================================================================
CREATE TABLE insumos (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre          VARCHAR(60)   NOT NULL,
  unidad          VARCHAR(15)   NOT NULL,             -- g, kg, ml, l, und
  stock           NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (stock >= 0),
  stock_min       NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (stock_min >= 0),
  costo_unitario  NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (costo_unitario >= 0),
  activo          BOOLEAN       NOT NULL DEFAULT TRUE,
  actualizado_en  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_insumos_unidad CHECK (unidad IN ('g','kg','ml','l','und'))
);
CREATE UNIQUE INDEX uq_insumos_nombre ON insumos (lower(nombre)) WHERE activo;
CREATE TRIGGER trg_insumos_upd BEFORE UPDATE ON insumos
  FOR EACH ROW EXECUTE FUNCTION fn_set_actualizado_en();

-- =====================================================================
-- 5. RECETAS  (relación N:M producto–insumo)
-- =====================================================================
CREATE TABLE recetas (
  producto_id  INTEGER       NOT NULL REFERENCES productos(id) ON UPDATE CASCADE ON DELETE CASCADE,
  insumo_id    INTEGER       NOT NULL REFERENCES insumos(id)   ON UPDATE CASCADE ON DELETE RESTRICT,
  cantidad     NUMERIC(12,3) NOT NULL CHECK (cantidad > 0),   -- por unidad de producto
  PRIMARY KEY (producto_id, insumo_id)
);
CREATE INDEX ix_recetas_insumo ON recetas (insumo_id);

-- =====================================================================
-- 6. VENTAS  (cabecera de factura)
-- =====================================================================
CREATE SEQUENCE seq_folio_venta START 1;

CREATE TABLE ventas (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  folio       VARCHAR(12)   NOT NULL UNIQUE
              DEFAULT 'FE-' || lpad(nextval('seq_folio_venta')::text, 6, '0'),
  fecha       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  usuario_id  INTEGER       NOT NULL REFERENCES usuarios(id) ON UPDATE CASCADE ON DELETE RESTRICT, -- cajero
  cliente_id  INTEGER                REFERENCES clientes(id) ON UPDATE CASCADE ON DELETE SET NULL,  -- NULL = Mostrador
  metodo_pago metodo_pago   NOT NULL DEFAULT 'Efectivo',
  total       NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (total >= 0)
);
CREATE INDEX ix_ventas_metodo  ON ventas (metodo_pago);
CREATE INDEX ix_ventas_fecha   ON ventas (fecha);
CREATE INDEX ix_ventas_cliente ON ventas (cliente_id);

-- =====================================================================
-- 7. DETALLE_VENTAS  (precio congelado al momento de la venta)
-- =====================================================================
CREATE TABLE detalle_ventas (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  venta_id         INTEGER       NOT NULL REFERENCES ventas(id)    ON UPDATE CASCADE ON DELETE CASCADE,
  producto_id      INTEGER       NOT NULL REFERENCES productos(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  cantidad         INTEGER       NOT NULL CHECK (cantidad > 0),
  precio_unitario  NUMERIC(12,2) NOT NULL CHECK (precio_unitario > 0),
  subtotal         NUMERIC(14,2) GENERATED ALWAYS AS (cantidad * precio_unitario) STORED,
  CONSTRAINT uq_detalle_venta_producto UNIQUE (venta_id, producto_id)
);
CREATE INDEX ix_detalle_producto ON detalle_ventas (producto_id);

-- Recalcula ventas.total cada vez que cambia el detalle
CREATE OR REPLACE FUNCTION fn_recalcular_total_venta() RETURNS TRIGGER AS $$
DECLARE v_id INTEGER := COALESCE(NEW.venta_id, OLD.venta_id);
BEGIN
  UPDATE ventas SET total = COALESCE((SELECT SUM(subtotal) FROM detalle_ventas WHERE venta_id = v_id), 0)
  WHERE id = v_id;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_detalle_total AFTER INSERT OR UPDATE OR DELETE ON detalle_ventas
  FOR EACH ROW EXECUTE FUNCTION fn_recalcular_total_venta();

-- =====================================================================
-- 8. PEDIDOS  (pedidos en línea / por encargo)
-- =====================================================================
CREATE TABLE pedidos (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cliente_id      INTEGER       NOT NULL REFERENCES clientes(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  usuario_id      INTEGER                REFERENCES usuarios(id) ON UPDATE CASCADE ON DELETE SET NULL, -- quién lo registró
  fecha_entrega   TIMESTAMPTZ   NOT NULL,
  detalle         VARCHAR(120),
  estado          estado_pedido NOT NULL DEFAULT 'Pendiente',
  creado_en       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  actualizado_en  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX ix_pedidos_entrega ON pedidos (fecha_entrega) WHERE estado <> 'Entregado';
CREATE INDEX ix_pedidos_cliente ON pedidos (cliente_id);
CREATE TRIGGER trg_pedidos_upd BEFORE UPDATE ON pedidos
  FOR EACH ROW EXECUTE FUNCTION fn_set_actualizado_en();

-- =====================================================================
-- 9. VISTAS de apoyo (alertas de stock, RF-04)
-- =====================================================================
CREATE VIEW v_stock_critico AS
  SELECT id, nombre, stock, stock_min FROM productos
  WHERE activo AND stock <= stock_min;

CREATE VIEW v_insumos_criticos AS
  SELECT id, nombre, unidad, stock, stock_min FROM insumos
  WHERE activo AND stock <= stock_min;

-- =====================================================================
-- 10. DATOS SEMILLA (mismos productos del frontend)
--     Los usuarios NO se insertan aquí: se crean con "npm run seed"
--     para que sus contraseñas queden hasheadas con bcrypt.
-- =====================================================================
INSERT INTO productos (nombre, precio, categoria, stock, stock_min) VALUES
  ('Torta de chocolate',         45000, 'Tortas',   8,  3),
  ('Cupcake de vainilla',         3500, 'Cupcakes', 20, 6),
  ('Cheesecake de frutos rojos', 55000, 'Tortas',   4,  2),
  ('Galletas decoradas',          2500, 'Galletas', 30, 10),
  ('Brownie',                     4000, 'Postres',  15, 5);

INSERT INTO insumos (nombre, unidad, stock, stock_min, costo_unitario) VALUES
  ('Harina de trigo', 'g',   10000, 2000, 4),
  ('Azúcar',          'g',    8000, 1500, 5),
  ('Huevos',          'und',   120,   30, 600),
  ('Mantequilla',     'g',    5000, 1000, 18),
  ('Cacao en polvo',  'g',    2000,  500, 30);

INSERT INTO recetas (producto_id, insumo_id, cantidad)
SELECT p.id, i.id, r.cant
FROM (VALUES
  ('Torta de chocolate',  'Harina de trigo', 300), ('Torta de chocolate',  'Azúcar', 250),
  ('Torta de chocolate',  'Huevos', 4),            ('Torta de chocolate',  'Cacao en polvo', 80),
  ('Cupcake de vainilla', 'Harina de trigo', 40),  ('Cupcake de vainilla', 'Huevos', 1),
  ('Brownie',             'Cacao en polvo', 25),   ('Brownie',             'Mantequilla', 30)
) AS r(prod, ins, cant)
JOIN productos p ON p.nombre = r.prod
JOIN insumos   i ON i.nombre = r.ins;

COMMIT;
