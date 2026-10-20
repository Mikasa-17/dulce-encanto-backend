/**
 * Dulce Encanto · Sistema de gestión (cliente de la API REST) · Fase 3
 * Secciones: 1 Utilidades · 2 Cliente API, sesión y tema · 3 Lógica de negocio
 *            4 Renderizado · 5 Exportación PDF · 6 Eventos · 7 Arranque
 *
 * Los datos del negocio viven en PostgreSQL y se piden con fetch().
 * localStorage solo guarda la preferencia visual (tema claro/oscuro).
 * Las funciones de negocio son async y LANZAN un Error con el mensaje del backend;
 * los manejadores de eventos lo atrapan y lo muestran en el toast.
 */
(() => {
  'use strict';

  /* ===== 1. UTILIDADES ===== */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const money = n => '$' + Number(n || 0).toLocaleString('es-CO');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const pad = n => String(n).padStart(2, '0');
  const dayKey = d => { const x = new Date(d); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
  const fechaHora = f => new Date(f).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' });
  const hora = f => new Date(f).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
  const sum = (arr, f) => arr.reduce((t, x) => t + f(x), 0);
  const fallo = msg => { throw new Error(msg); };

  const EMOJIS = { tortas: '🎂', cupcakes: '🧁', galletas: '🍪', postres: '🍫', panes: '🥐', bebidas: '☕', helados: '🍨' };
  const emojiDe = cat => EMOJIS[norm(cat)] || '🍰';

  const ESTADOS = ['Pendiente', 'En preparación', 'Listo', 'Entregado', 'Cancelado'];
  const CERRADOS = ['Entregado', 'Cancelado'];

  /** Vistas permitidas por rol (RF-11). El backend vuelve a validar cada permiso. */
  const PERMISOS = {
    admin: ['dashboard', 'productos', 'inventario', 'ventas', 'pedidos', 'agenda', 'clientes', 'reportes', 'usuarios'],
    cajero: ['dashboard', 'productos', 'ventas', 'pedidos', 'agenda', 'clientes'],
    repostero: ['dashboard', 'productos', 'inventario', 'pedidos', 'agenda'],
    cliente: ['productos', 'pedidos']
  };

  /* ===== 2. CLIENTE API, SESIÓN Y TEMA ===== */
  // Si la página la sirve Express (puerto 3000) se usa el mismo origen; si no (Live Server, etc.) se apunta al API.
  const API = (window.DULCE_API || (location.port === '3000' ? '' : 'http://localhost:3000')) + '/api';
  // El token va en sessionStorage: sobrevive a F5 pero se borra al cerrar la pestaña.
  const TOKEN_KEY = 'dulceEncanto.token';
  let token = sessionStorage.getItem(TOKEN_KEY);

  /**
   * Petición a la API con JSON y token JWT.
   * Devuelve el JSON de respuesta o lanza Error con el mensaje que envió el backend.
   */
  async function api(ruta, metodo = 'GET', body) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;

    let res;
    try {
      res = await fetch(API + ruta, { method: metodo, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch {
      throw new Error('No hay conexión con el servidor. ¿Está encendido el backend?');
    }

    const data = res.status === 204 ? null : await res.json().catch(() => null);

    // Token vencido o inválido → cerrar sesión (excepto en el propio login)
    if (res.status === 401 && token && ruta !== '/auth/login') {
      cerrarSesion();
      throw new Error('Tu sesión expiró. Vuelve a ingresar.');
    }
    if (!res.ok) throw new Error(data?.error || `Error ${res.status} del servidor.`);
    return data;
  }

  /* ---------- Tema claro / oscuro (única preferencia en localStorage) ---------- */
  const TEMA_KEY = 'dulceEncanto.tema';
  const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  /** Cambia las variables CSS (vía data-tema) y ajusta los colores de Chart.js. */
  function aplicarTema(tema) {
    document.documentElement.dataset.tema = tema;
    try { localStorage.setItem(TEMA_KEY, tema); } catch { /* modo privado: solo no se recuerda */ }
    const oscuro = tema === 'oscuro', btn = $('#btn-tema');
    btn.innerHTML = `<span class="icono">${oscuro ? '☀️' : '🌙'}</span>`; // re-crea el span → re-anima el giro
    btn.setAttribute('aria-label', oscuro ? 'Activar modo claro' : 'Activar modo oscuro');
    if (typeof Chart !== 'undefined') {
      Chart.defaults.color = cssVar('--muted');
      Chart.defaults.borderColor = cssVar('--borde');
    }
  }

  /* ===== 3. ESTADO EN MEMORIA Y LÓGICA DE NEGOCIO ===== */
  let sesion = null, carrito = [], vista = 'dashboard', timer;
  let productos = [];
  let pedidoItems = [];        // productos que el cliente elige en el catálogo (memoria)
  let ultimoReporte = null;    // { periodo, datos } para exportar a PDF
  const charts = {};

  const prodPorId = id => productos.find(p => p.id === id);
  const bajo = x => x.stock <= x.stock_min;
  const totalCarrito = () => sum(carrito, i => i.precio * i.cant);

  const cargarProductos = async () => (productos = await api('/productos'));

  /** Crea o modifica un producto (RF-01). La validación definitiva la hace el backend. */
  async function guardarProducto({ id, nombre, precio, categoria, min }) {
    const body = { nombre: nombre.trim(), categoria: categoria.trim(), precio: +precio, stock_min: +min };
    if (!body.nombre || !body.categoria) fallo('Nombre y categoría son obligatorios.');
    if (!(body.precio > 0)) fallo('El precio debe ser mayor a 0.');
    return id ? api(`/productos/${id}`, 'PUT', body) : api('/productos', 'POST', body);
  }

  /** Entrada de stock de producto terminado (RF-14). */
  function entradaStock(id, cant) {
    cant = parseInt(cant, 10);
    if (!(cant > 0)) fallo('La cantidad debe ser mayor a 0.');
    return api(`/productos/${id}/entrada`, 'POST', { cantidad: cant });
  }

  /** Compra de insumos (materia prima). */
  function entradaInsumo(id, cant) {
    cant = Number(cant);
    if (!id) fallo('Selecciona un insumo.');
    if (!(cant > 0)) fallo('La cantidad debe ser mayor a 0.');
    return api(`/insumos/${id}/entrada`, 'POST', { cantidad: cant });
  }

  /** Agrega al carrito (pre-validación local; el backend vuelve a verificar al cobrar). */
  function agregarCarrito(id, cant) {
    const p = prodPorId(id); cant = parseInt(cant, 10);
    if (!p || !(cant > 0)) fallo('Producto o cantidad inválidos.');
    const item = carrito.find(i => i.id === id);
    if ((item ? item.cant : 0) + cant > p.stock) fallo(`Stock insuficiente (disponible: ${p.stock}).`);
    if (item) item.cant += cant; else carrito.push({ id, nombre: p.nombre, precio: p.precio, cant });
  }

  /**
   * Registra la venta (RF-05, RF-06). El backend hace la transacción.
   * Si falla (p. ej. "Stock insuficiente"), el carrito se conserva para corregirlo.
   */
  async function registrarVenta(cliente, metodo_pago) {
    if (!carrito.length) fallo('El carrito está vacío.');
    const venta = await api('/ventas', 'POST', {
      cliente: cliente.trim(),
      metodo_pago,
      items: carrito.map(i => ({ producto_id: i.id, cantidad: i.cant }))
    });
    carrito = [];
    return venta;
  }

  /** Crea un pedido (RF-07). La fecha se envía en ISO (con zona horaria). */
  function crearPedido(cliente, fecha, detalle) {
    if (!fecha) fallo('La fecha de entrega es obligatoria.');
    const f = new Date(fecha);
    if (f <= new Date()) fallo('La fecha de entrega debe ser futura.');
    return api('/pedidos', 'POST', { cliente: cliente.trim(), fecha_entrega: f.toISOString(), detalle });
  }

  /** Catálogo del cliente: suma 1 unidad al pedido en preparación (sin pasar el stock). */
  function agregarAPedido(id) {
    const p = prodPorId(id);
    if (!p) fallo('Producto no encontrado.');
    const it = pedidoItems.find(i => i.id === id);
    if ((it ? it.cant : 0) + 1 > p.stock) fallo(`Solo hay ${p.stock} unidades de ${p.nombre}.`);
    if (it) it.cant++; else pedidoItems.push({ id, nombre: p.nombre, precio: p.precio, cant: 1 });
    actualizarContador();
    return p;
  }

  /** Une los productos elegidos y la nota en el campo "detalle" del pedido (máx. 120). */
  function detalleDePedido(nota) {
    const items = pedidoItems.map(i => `${i.cant}× ${i.nombre}`).join(', ');
    const detalle = [items, nota.trim()].filter(Boolean).join(' · ');
    if (sesion.rol === 'cliente' && !detalle) fallo('Añade productos desde el catálogo o escribe un detalle.');
    if (detalle.length > 120) fallo('El pedido es muy largo (máx. 120 caracteres). Quita productos o acorta la nota.');
    return detalle;
  }

  /** Enlace de WhatsApp con el mensaje pre-redactado del pedido. */
  const enlaceWhatsApp = p => 'https://wa.me/?text=' + encodeURIComponent(
    `Hola ${p.cliente} 👋, te escribimos de Dulce Encanto 🧁.\n` +
    `Tu pedido #${p.id} está en estado: *${p.estado}*.\n` +
    `Entrega programada para: ${fechaHora(p.fecha_entrega)}.` +
    (p.detalle ? `\nDetalle: ${p.detalle}` : '') +
    '\n¡Gracias por preferirnos!');

  const cambiarEstado = (id, estado) => api(`/pedidos/${id}/estado`, 'PATCH', { estado });

  /** Alta de usuarios (RF-11): la contraseña viaja al backend, que la guarda con bcrypt. */
  function crearUsuario(user, pass, rol) {
    user = user.trim();
    if (!user || pass.length < 8) fallo('Escribe un usuario y una contraseña de mínimo 8 caracteres.');
    return api('/usuarios', 'POST', { username: user, password: pass, rol });
  }

  function alternarUsuario(id) {
    if (id === sesion.id) fallo('No puedes desactivar tu propia cuenta.');
    return api(`/usuarios/${id}/estado`, 'PATCH');
  }

  /* ===== 4. RENDERIZADO ===== */
  const optsProductos = f => productos.map(p => `<option value="${p.id}">${esc(f(p))}</option>`).join('');

  /** Dibuja (o redibuja) un gráfico de Chart.js con los colores del tema activo. */
  function grafico(id, type, labels, data, label = 'Valor') {
    if (typeof Chart === 'undefined') return; // sin conexión al CDN
    charts[id]?.destroy();
    const acento = cssVar('--rosa-fuerte');
    charts[id] = new Chart($('#c-' + id), {
      type,
      data: { labels, datasets: [{ label, data, borderColor: acento, tension: .3, fill: type === 'line', borderRadius: 6,
        backgroundColor: type === 'line' ? 'rgba(217,138,150,.25)' : acento }] },
      options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
    });
  }

  const reciboHTML = v => `<h4>DULCE ENCANTO</h4>
    <p class="c">Factura electrónica (simulada)<br>${esc(v.folio)}</p><hr>
    <div class="ln"><span>Fecha</span><span>${fechaHora(v.fecha)}</span></div>
    <div class="ln"><span>Cliente</span><span>${esc(v.cliente)}</span></div>
    <div class="ln"><span>Atendió</span><span>${esc(v.cajero)}</span></div>
    <div class="ln"><span>Pago</span><span>${esc(v.metodo_pago)}</span></div><hr>
    ${v.items.map(i => `<div class="ln"><span>${i.cantidad}× ${esc(i.nombre)}</span><span>${money(i.precio * i.cantidad)}</span></div>`).join('')}
    <div class="ln total"><span>TOTAL</span><span>${money(v.total)}</span></div>
    <p class="c">¡Gracias por su compra!</p>`;

  /** Llena el datalist de clientes (solo para personal). */
  async function cargarNombresClientes() {
    if (sesion.rol === 'cliente') return;
    const nombres = await api('/clientes/nombres');
    $('#dl-clientes').innerHTML = nombres.map(c => `<option value="${esc(c)}">`).join('');
  }

  /** Pinta productos desde la caché: tabla para el personal, catálogo para el cliente. */
  function pintarProductos() {
    const q = norm($('#q').value);
    $('#sug').innerHTML = [...new Set(productos.flatMap(p => [p.nombre, p.categoria]))].map(s => `<option value="${esc(s)}">`).join('');
    const lista = productos.filter(p => norm(p.nombre + ' ' + p.categoria).includes(q));
    if (sesion.rol === 'cliente') return pintarCatalogo(lista);
    $('#t-prod').innerHTML = lista.map(p => `
      <tr><td>${p.id}</td><td>${esc(p.nombre)}</td><td>${esc(p.categoria)}</td><td>${money(p.precio)}</td>
      <td>${p.stock} ${bajo(p) ? '<span class="badge mal">Bajo</span>' : ''}</td>
      <td class="admin-only"><div class="acc">
        <button class="btn sec" data-a="editar" data-id="${p.id}">Editar</button>
        <button class="btn peligro" data-a="borrar" data-id="${p.id}">Eliminar</button></div></td></tr>`).join('')
      || '<tr><td colspan="6">Sin resultados</td></tr>';
  }

  /** Catálogo visual en tarjetas (CSS Grid) para el rol cliente. */
  function pintarCatalogo(lista) {
    $('#catalogo').innerHTML = lista.map((p, i) => {
      const enPedido = pedidoItems.find(x => x.id === p.id)?.cant || 0;
      const agotado = p.stock <= 0, lleno = !agotado && enPedido >= p.stock;
      const stockTxt = agotado ? 'Agotado por hoy' : bajo(p) ? `¡Últimas ${p.stock} unidades!` : `${p.stock} disponibles`;
      return `<article class="card producto-card ${agotado ? 'agotado' : ''}" style="--i:${i}">
        <div class="producto-img" aria-hidden="true"><span>${emojiDe(p.categoria)}</span></div>
        <div class="producto-info">
          <span class="chip">${esc(p.categoria)}</span>
          <h3>${esc(p.nombre)}</h3>
          <p class="precio">${money(p.precio)}</p>
          <p class="stock ${agotado ? 'cero' : bajo(p) ? 'bajo' : ''}">● ${stockTxt}</p>
          <button class="btn primary grande" type="button" data-a="add-pedido" data-id="${p.id}" ${agotado || lleno ? 'disabled' : ''}>
            ${agotado ? 'Agotado' : lleno ? 'Máximo disponible' : '🛒 Añadir al pedido'}</button>
          ${enPedido ? `<p class="en-pedido">✓ En tu pedido: ${enPedido}</p>` : ''}
        </div></article>`;
    }).join('') || '<div class="card vacio muted">No encontramos productos con esa búsqueda 🍰</div>';
  }

  /** Resumen del pedido del cliente dentro del formulario de Pedidos. */
  function pintarPedidoItems() {
    $('#pe-items').innerHTML = pedidoItems.length
      ? `<h3>🛒 Tu pedido</h3>${pedidoItems.map((i, ix) => `<div class="item item-nuevo"><span>${i.cant}× ${esc(i.nombre)}</span>
          <span>${money(i.precio * i.cant)} <button class="btn sec mini" type="button" data-a="quitar-pe" data-i="${ix}" aria-label="Quitar">×</button></span></div>`).join('')}
        <div class="ln total"><span>Total estimado</span><span>${money(sum(pedidoItems, i => i.precio * i.cant))}</span></div>`
      : '<p class="muted">Aún no has elegido productos. Ve a <b>🧁 Productos</b> y pulsa "Añadir al pedido".</p>';
  }

  /** Burbuja con el número de unidades en el botón "Pedidos" del menú. */
  function actualizarContador() {
    const n = sum(pedidoItems, i => i.cant), c = $('#cnt-pedido');
    c.hidden = !n || sesion?.rol !== 'cliente';
    c.textContent = n;
  }

  function pintarCarrito() {
    $('#carrito').innerHTML = carrito.map((i, ix) => `<div class="item item-nuevo"><span>${i.cant}× ${esc(i.nombre)}</span>
      <span>${money(i.precio * i.cant)} <button class="btn sec mini" type="button" data-a="quitar" data-i="${ix}" aria-label="Quitar">×</button></span></div>`).join('')
      || '<p class="muted">El carrito está vacío.</p>';
    $('#total').textContent = money(totalCarrito());
  }

  /** Un renderizador async por vista: pide datos a la API y escribe en el DOM. */
  const R = {
    async dashboard() {
      const r = await api('/ventas/resumen');
      const kpis = [
        ['Ventas de hoy', money(r.ventas_hoy)],
        ['Pedidos activos', r.pedidos_activos],
        ['Productos', r.productos],
        ['Stock crítico', r.stock_critico],
        ['Insumos críticos', r.insumos_criticos]
      ];
      $('#kpis').innerHTML = kpis.map(([t, v]) => `<div class="card kpi"><h3>${t}</h3><p>${v}</p></div>`).join('');
      grafico('sem', 'line', r.ultimos7.map(d => new Date(d.dia + 'T00:00').toLocaleDateString('es-CO', { weekday: 'short' })),
        r.ultimos7.map(d => d.total), 'Ventas $');
      grafico('top', 'bar', r.top.map(t => t.nombre), r.top.map(t => t.unidades), 'Unidades');
    },

    async productos() {
      await cargarProductos();
      pintarProductos();
    },

    async inventario() {
      const [, insumos] = await Promise.all([cargarProductos(), api('/insumos')]);
      $('#i-prod').innerHTML = optsProductos(p => `${p.nombre} (stock: ${p.stock})`);
      $('#ii-ins').innerHTML = insumos.map(i =>
        `<option value="${i.id}">${esc(i.nombre)} (${i.stock} ${esc(i.unidad)})</option>`).join('');
      $('#alertas').innerHTML = productos.filter(bajo).map(p =>
        `<div class="alerta">⚠️ <b>${esc(p.nombre)}</b>: stock ${p.stock} (mínimo ${p.stock_min})</div>`).join('')
        || '<p class="ok">✅ Ningún producto está en nivel crítico.</p>';
      $('#alertas-insumos').innerHTML = insumos.filter(bajo).map(i =>
        `<div class="alerta">⚠️ <b>${esc(i.nombre)}</b>: ${i.stock} ${esc(i.unidad)} (mínimo ${i.stock_min})</div>`).join('')
        || '<p class="ok">✅ Ningún insumo está en nivel crítico.</p>';
    },

    async ventas() {
      await Promise.all([cargarProductos(), cargarNombresClientes()]);
      $('#v-prod').innerHTML = optsProductos(p => `${p.nombre} · ${money(p.precio)} (${p.stock})`);
      pintarCarrito();
    },

    async pedidos() {
      const esCliente = sesion.rol === 'cliente', inp = $('#pe-cliente');
      inp.readOnly = esCliente; if (esCliente) inp.value = sesion.username;
      $('#pe-detalle').placeholder = esCliente ? 'Notas (ej. dedicatoria, sabor, color)' : 'Detalle (ej. torta de 20 porciones)';
      if (esCliente) pintarPedidoItems();
      const [lista] = await Promise.all([api('/pedidos'), cargarNombresClientes()]);
      $('#t-ped').innerHTML = lista.map(p => {
        const cerrado = CERRADOS.includes(p.estado);
        return `<tr><td>#${p.id}</td><td>${esc(p.cliente)}</td><td>${fechaHora(p.fecha_entrega)}</td><td>${esc(p.detalle || '—')}</td>
        <td>${esCliente || cerrado ? `<span class="badge ${p.estado === 'Entregado' ? 'bien' : p.estado === 'Cancelado' ? 'mal' : ''}">${p.estado}</span>`
          : `<select data-a="estado" data-id="${p.id}">${ESTADOS.map(e => `<option ${e === p.estado ? 'selected' : ''}>${e}</option>`).join('')}</select>`}</td>
        <td class="solo-personal"><a class="btn wa" href="${esc(enlaceWhatsApp(p))}" target="_blank" rel="noopener noreferrer"
          title="Abre WhatsApp con el mensaje listo">💬 Avisar por WhatsApp</a></td></tr>`;
      }).join('') || '<tr><td colspan="6">Aún no hay pedidos.</td></tr>';
    },

    async agenda() {
      const lista = await api('/pedidos?activos=1');
      const porDia = {};
      lista.forEach(p => (porDia[dayKey(p.fecha_entrega)] ||= []).push(p));
      $('#lista-agenda').innerHTML = Object.entries(porDia).map(([d, ps]) => `<div class="card">
        <h3>${new Date(d + 'T00:00').toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' })}</h3>
        ${ps.map(p => `<div class="item"><span>${hora(p.fecha_entrega)} · #${p.id} ${esc(p.cliente)} — ${esc(p.detalle || 'Sin detalle')}</span>
        <span class="badge">${p.estado}</span></div>`).join('')}</div>`).join('')
        || '<div class="card muted">No hay entregas programadas.</div>';
    },

    async clientes() {
      const lista = await api('/clientes');
      $('#lista-clientes').innerHTML = lista.map(c => `<details class="card">
        <summary><b>${esc(c.nombre)}</b> · ${c.num_compras} compras · ${money(c.total_compras)}</summary>
        ${c.compras.map(v => `<div class="item"><span>${esc(v.folio)} · ${new Date(v.fecha).toLocaleDateString('es-CO')} · ${esc(v.metodo_pago)}</span><span>${money(v.total)}</span></div>`).join('')
          || '<p class="muted">Sin compras todavía.</p>'}</details>`).join('')
        || '<div class="card muted">Los clientes se registran al vender o crear un pedido.</div>';
    },

    async reportes() {
      const periodo = $('#periodo').value;
      const datos = await api(`/ventas/reporte?periodo=${encodeURIComponent(periodo)}`);
      ultimoReporte = { periodo, datos };
      grafico('rep', 'bar', datos.map(d => d.periodo), datos.map(d => d.total), 'Ventas $');
      $('#t-rep').innerHTML = datos.map(d => `<tr><td>${esc(d.periodo)}</td><td>${d.ventas}</td><td>${money(d.total)}</td>
        <td>${money(d.efectivo)}</td><td>${money(d.tarjeta)}</td><td>${money(d.transferencia)}</td></tr>`).join('')
        || '<tr><td colspan="6">Aún no hay ventas.</td></tr>';
    },

    async usuarios() {
      const lista = await api('/usuarios');
      $('#t-usr').innerHTML = lista.map(u => `<tr><td>${esc(u.username)}</td><td>${u.rol}</td>
        <td><span class="badge ${u.activo ? 'bien' : 'mal'}">${u.activo ? 'Activo' : 'Inactivo'}</span></td>
        <td><button class="btn sec" data-a="toggle-u" data-id="${u.id}" ${u.id === sesion.id ? 'disabled' : ''}>${u.activo ? 'Desactivar' : 'Activar'}</button></td></tr>`).join('');
    }
  };

  /* ===== 5. EXPORTACIÓN A PDF REAL (html2pdf.js) ===== */
  /** Dibuja el gráfico fuera de pantalla con colores claros fijos y lo devuelve como PNG (independiente del tema). */
  function graficoImagen(labels, data) {
    if (typeof Chart === 'undefined' || !labels.length) return '';
    const cv = document.createElement('canvas');
    cv.width = 1000; cv.height = 420;
    cv.style.cssText = 'position:fixed;left:-10000px;top:0;width:1000px;height:420px';
    document.body.appendChild(cv);
    const eje = { ticks: { color: '#5b3a29' }, grid: { color: '#ecdcd2' } };
    const ch = new Chart(cv, {
      type: 'bar',
      data: { labels, datasets: [{ data, backgroundColor: '#d98a96', borderRadius: 6 }] },
      options: { responsive: false, animation: false, devicePixelRatio: 2,
        plugins: { legend: { display: false } }, scales: { x: eje, y: { ...eje, beginAtZero: true } } }
    });
    const url = cv.toDataURL('image/png');
    ch.destroy(); cv.remove();
    return url;
  }

  /** Arma el documento del reporte (encabezado, KPIs, gráfico y tabla) y lo descarga como .pdf */
  async function exportarPDF() {
    if (typeof html2pdf === 'undefined') fallo('No se pudo cargar html2pdf.js. Revisa tu conexión a internet.');
    if (!ultimoReporte?.datos.length) fallo('No hay ventas para exportar en este periodo.');

    const { periodo, datos } = ultimoReporte;
    const nombre = $('#periodo').selectedOptions[0].text;
    const tot = k => sum(datos, d => Number(d[k]) || 0);
    const img = graficoImagen(datos.map(d => d.periodo), datos.map(d => d.total));

    const doc = document.createElement('div');
    doc.className = 'pdf-doc';
    doc.innerHTML = `
      <div class="pdf-cab">
        <div class="logo">Dulce <span style="color:#d98a96">Encanto</span></div>
        <div><h2>Reporte de ${esc(nombre.toLowerCase())}</h2>
          <p>Generado el ${fechaHora(new Date())} · por ${esc(sesion.username)}</p></div>
      </div>
      <div class="pdf-kpis">
        <div><b>${money(tot('total'))}</b><span>Ventas totales</span></div>
        <div><b>${tot('ventas')}</b><span>Número de ventas</span></div>
        <div><b>${money(tot('ventas') ? Math.round(tot('total') / tot('ventas')) : 0)}</b><span>Ticket promedio</span></div>
      </div>
      ${img ? `<img src="${img}" alt="Gráfico de ventas">` : ''}
      <table>
        <thead><tr><th>Periodo</th><th>Ventas</th><th>Total</th><th>Efectivo</th><th>Tarjeta</th><th>Transferencia</th></tr></thead>
        <tbody>${datos.map(d => `<tr><td>${esc(d.periodo)}</td><td>${d.ventas}</td><td>${money(d.total)}</td>
          <td>${money(d.efectivo)}</td><td>${money(d.tarjeta)}</td><td>${money(d.transferencia)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td>TOTAL</td><td>${tot('ventas')}</td><td>${money(tot('total'))}</td>
          <td>${money(tot('efectivo'))}</td><td>${money(tot('tarjeta'))}</td><td>${money(tot('transferencia'))}</td></tr></tfoot>
      </table>
      <p class="pdf-pie">Dulce Encanto · Sistema de gestión para repostería</p>`;

    toast('Generando PDF…');
    await html2pdf().set({
      margin: [10, 10, 12, 10],
      filename: `reporte-ventas-${periodo}-${dayKey(new Date())}.pdf`,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      pagebreak: { mode: ['css', 'legacy'], avoid: ['tr', 'img', '.pdf-kpis'] }
    }).from(doc).save();
    toast('📄 PDF descargado.');
  }

  /* ===== Navegación, toast y sesión ===== */
  /** Recarga la vista actual desde la API; cualquier error va al toast. */
  async function refrescar() {
    if (!sesion) return;
    try { await R[vista](); }
    catch (e) { if (sesion) toast(e.message, true); }
  }

  /** Cambia de vista respetando los permisos del rol (la animación fade-in la pone el CSS). */
  function ir(v) {
    if (!PERMISOS[sesion.rol].includes(v)) return;
    vista = v;
    $$('.vista').forEach(s => s.classList.toggle('activa', s.id === 'v-' + v));
    $$('#menu button').forEach(b => b.classList.toggle('activo', b.dataset.v === v));
    const b = $(`#menu [data-v="${v}"]`), t = $('#titulo');
    // Solo el texto del botón (sin la burbuja del contador)
    t.textContent = [...b.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join('').trim();
    t.style.animation = 'none'; void t.offsetWidth; t.style.animation = ''; // re-anima el título
    return refrescar();
  }

  function toast(msg, error = false) {
    const t = $('#toast');
    t.textContent = msg; t.className = 'show' + (error ? ' error' : '');
    clearTimeout(timer); timer = setTimeout(() => { t.className = ''; }, error ? 5000 : 3200);
  }

  function iniciarSesion(u) {
    sesion = u; document.body.dataset.rol = u.rol;
    $('#login').hidden = true; $('#app').hidden = false;
    $('#quien').innerHTML = `<b>${esc(u.username)}</b> · ${u.rol}`;
    $$('#menu button').forEach(b => { b.hidden = !PERMISOS[u.rol].includes(b.dataset.v); });
    actualizarContador();
    return ir(PERMISOS[u.rol][0]);
  }

  function cerrarSesion() {
    token = null; sessionStorage.removeItem(TOKEN_KEY);
    sesion = null; carrito = []; productos = []; pedidoItems = []; ultimoReporte = null;
    $('#cnt-pedido').hidden = true;
    Object.values(charts).forEach(c => c.destroy());
    delete document.body.dataset.rol;
    $('#app').hidden = true; $('#login').hidden = false; $('#form-login').reset();
  }

  /* ===== 6. EVENTOS (delegación) ===== */
  /** Manejadores de formularios (async), indexados por id del <form>. */
  const FORMS = {
    async 'form-login'(d) {
      const r = await api('/auth/login', 'POST', { username: d.user.trim(), password: d.pass });
      token = r.token; sessionStorage.setItem(TOKEN_KEY, token);
      await iniciarSesion(r.usuario);
    },
    async 'f-producto'(d, f) {
      await guardarProducto({ id: +d.pid || 0, nombre: d.nombre, precio: d.precio, categoria: d.categoria, min: d.min });
      f.reset(); f.pid.value = ''; $('#btn-prod').textContent = 'Agregar producto';
      toast('Producto guardado.'); await refrescar();
    },
    async 'f-entrada'(d, f) {
      await entradaStock(+d.pid, d.cant);
      f.reset(); toast('Entrada de stock registrada.'); await refrescar();
    },
    async 'f-entrada-insumo'(d, f) {
      await entradaInsumo(+d.iid, d.cant);
      f.reset(); toast('Compra de insumo registrada.'); await refrescar();
    },
    async 'f-carrito'(d) {
      agregarCarrito(+d.pid, d.cant);
      pintarCarrito();
    },
    async 'f-venta'(d, f) {
      try {
        const venta = await registrarVenta(d.cliente || '', d.metodo_pago);
        $('#recibo').innerHTML = reciboHTML(venta);
        f.reset(); toast(`Venta ${venta.folio} registrada.`);
      } finally {
        await refrescar(); // refresca el stock real, haya salido bien o no
      }
    },
    async 'f-pedido'(d, f) {
      const p = await crearPedido(d.cliente || sesion.username, d.fecha, detalleDePedido(d.detalle || ''));
      pedidoItems = []; actualizarContador();
      f.reset(); toast(`Pedido #${p.id} confirmado para ${fechaHora(p.fecha_entrega)}.`); await refrescar();
    },
    async 'f-usuario'(d, f) {
      await crearUsuario(d.user, d.pass, d.rol);
      f.reset(); toast('Usuario creado.'); await refrescar();
    }
  };

  /** Acciones de botones (async), indexadas por data-a. */
  const ACCIONES = {
    editar(el) {
      const p = prodPorId(+el.dataset.id), f = $('#f-producto');
      if (!p) return;
      f.pid.value = p.id; f.nombre.value = p.nombre; f.precio.value = p.precio; f.categoria.value = p.categoria; f.min.value = p.stock_min;
      $('#btn-prod').textContent = 'Guardar cambios';
      f.nombre.focus(); window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    async borrar(el) {
      if (!confirm('¿Eliminar este producto? Las ventas ya registradas se conservan.')) return;
      await api(`/productos/${+el.dataset.id}`, 'DELETE');
      toast('Producto eliminado.'); await refrescar();
    },
    quitar(el) { carrito.splice(+el.dataset.i, 1); pintarCarrito(); },
    'add-pedido'(el) {
      const p = agregarAPedido(+el.dataset.id);
      pintarProductos();
      toast(`🛒 ${p.nombre} añadido. Confirma la fecha en "Pedidos".`);
    },
    'quitar-pe'(el) {
      pedidoItems.splice(+el.dataset.i, 1);
      pintarPedidoItems(); actualizarContador();
    },
    async 'toggle-u'(el) {
      await alternarUsuario(+el.dataset.id);
      await refrescar();
    },
    async pdf(el) {
      el.disabled = true;
      try { await exportarPDF(); } finally { el.disabled = false; }
    },
    tema() {
      aplicarTema(document.documentElement.dataset.tema === 'oscuro' ? 'claro' : 'oscuro');
      if (sesion && ['dashboard', 'reportes'].includes(vista)) refrescar(); // redibuja gráficos con los nuevos colores
    },
    logout() { cerrarSesion(); }
  };

  // Envío de formularios: bloquea los botones mientras responde la API (evita ventas dobles)
  document.addEventListener('submit', async e => {
    const f = e.target, h = FORMS[f.id];
    if (!h) return;
    e.preventDefault();
    if (f.dataset.ocupado) return;
    f.dataset.ocupado = '1';
    const botones = $$('button', f);
    botones.forEach(b => { b.disabled = true; });
    try { await h(Object.fromEntries(new FormData(f)), f); }
    catch (err) { toast(err.message, true); }
    finally { delete f.dataset.ocupado; botones.forEach(b => { b.disabled = false; }); }
  });

  document.addEventListener('click', async e => {
    const el = e.target.closest('[data-a]');
    if (!el || !ACCIONES[el.dataset.a] || el.tagName === 'SELECT') return;
    try { await ACCIONES[el.dataset.a](el); }
    catch (err) { toast(err.message, true); }
  });

  document.addEventListener('change', async e => {
    if (e.target.dataset.a === 'estado') {
      try { await cambiarEstado(+e.target.dataset.id, e.target.value); toast('Estado actualizado.'); }
      catch (err) { toast(err.message, true); }
      await refrescar(); // muestra el estado real (y regenera el enlace de WhatsApp)
    }
    if (e.target.id === 'periodo') refrescar();
  });

  $('#menu').addEventListener('click', e => { const b = e.target.closest('button'); if (b) ir(b.dataset.v); });
  $('#q').addEventListener('input', () => { if (sesion) pintarProductos(); });

  /* ===== 7. ARRANQUE ===== */
  aplicarTema(document.documentElement.dataset.tema === 'oscuro' ? 'oscuro' : 'claro');

  // Si hay un token de esta pestaña, se valida con el backend y se restaura la sesión.
  (async () => {
    if (!token) return;
    try { await iniciarSesion(await api('/auth/me')); }
    catch { cerrarSesion(); }
  })();
})();
