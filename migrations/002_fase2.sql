-- =====================================================================
--  Migración Fase 2 · ejecutar en pgAdmin (Query Tool sobre dulce_encanto)
--  SOLO si ya corriste el db.sql de la Fase 1. Es idempotente (se puede repetir).
-- =====================================================================
BEGIN;

-- 1. Método de pago en ventas
DO $$ BEGIN
  CREATE TYPE metodo_pago AS ENUM ('Efectivo', 'Tarjeta', 'Transferencia');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE ventas ADD COLUMN IF NOT EXISTS metodo_pago metodo_pago NOT NULL DEFAULT 'Efectivo';
CREATE INDEX IF NOT EXISTS ix_ventas_metodo ON ventas (metodo_pago);

-- 2. Borrado lógico: el nombre solo debe ser único entre registros ACTIVOS
--    (así puedes volver a crear "Brownie" después de eliminarlo)
DROP INDEX IF EXISTS uq_productos_nombre;
CREATE UNIQUE INDEX uq_productos_nombre ON productos (lower(nombre)) WHERE activo;

DROP INDEX IF EXISTS uq_insumos_nombre;
CREATE UNIQUE INDEX uq_insumos_nombre ON insumos (lower(nombre)) WHERE activo;

COMMIT;
