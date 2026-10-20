// Helpers de validación y manejo de errores HTTP

/** Error con código HTTP: el manejador central de server.js devuelve su mensaje al cliente. */
const httpError = (status, message) => Object.assign(new Error(message), { status });

/** Envuelve handlers async para que cualquier error llegue a next() (sin try/catch repetidos). */
const ruta = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Entero positivo (IDs de la URL o del body). */
function idValido(v, campo = 'ID') {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, `${campo} inválido.`);
  return n;
}

/** Número con reglas: min (inclusive), estricto (> min), entero. */
function numero(v, campo, { min = 0, estricto = false, entero = false } = {}) {
  const n = Number(v);
  const malo = v === '' || v === null || v === undefined || !Number.isFinite(n)
    || (entero && !Number.isInteger(n)) || (estricto ? n <= min : n < min);
  if (malo) throw httpError(400, `${campo} inválido${estricto ? ` (debe ser mayor a ${min})` : ''}.`);
  return n;
}

/** Texto obligatorio con longitud máxima. */
function texto(v, campo, max) {
  const s = String(v ?? '').trim();
  if (!s) throw httpError(400, `${campo} es obligatorio.`);
  if (s.length > max) throw httpError(400, `${campo}: máximo ${max} caracteres.`);
  return s;
}

module.exports = { httpError, ruta, idValido, numero, texto };
