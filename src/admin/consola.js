(function () {
  const $ = (id) => document.getElementById(id);
  const JWT_KEY = 'donaji.consola.jwt';
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fecha = (s) => s ? new Date(s).toLocaleString('es-MX') : '—';

  let jwt = null;
  try { jwt = localStorage.getItem(JWT_KEY); } catch (e) { /* */ }
  let cfg = { supabaseUrl: '', supabaseAnonKey: '' };
  let supa = null;

  function toast(txt, err) {
    const m = $('msg');
    m.textContent = txt; m.style.background = err ? '#b91c1c' : '#0f172a'; m.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { m.hidden = true; }, err ? 6000 : 3500);
  }

  async function api(method, path, body) {
    const res = await fetch('/api' + path, {
      method,
      headers: { authorization: 'Bearer ' + jwt, 'content-type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) { salir('La sesión expiró.'); throw new Error('sesión'); }
    let j = {};
    try { j = await res.json(); } catch (e) { /* 204 u otro */ }
    if (!res.ok) throw new Error(j.mensaje || j.error || ('error ' + res.status));
    return j;
  }

  // ---- widget de modo de propagación ---------------------------------
  function modoHtml(id, opts) {
    const soloDif = opts && opts.soloDiferido; // tarifa: nunca inmediato
    return '<label>Cuándo<select id="' + id + '-modo">'
      + '<option value="ventana">Ventana nocturna (03:00)</option>'
      + (soloDif ? '' : '<option value="inmediato">Inmediato</option>')
      + '<option value="programado">Programado</option>'
      + '</select></label>'
      + '<label id="' + id + '-fecha-w" hidden>Fecha<input type="datetime-local" id="' + id + '-fecha" /></label>'
      + (soloDif ? '' : '<label id="' + id + '-conf-w" hidden style="align-self:center"><input type="checkbox" id="' + id + '-conf" /> confirmo cambio inmediato</label>');
  }
  function modoBind(id) {
    const sel = $(id + '-modo');
    if (!sel) return;
    sel.onchange = () => {
      const v = sel.value;
      if ($(id + '-fecha-w')) $(id + '-fecha-w').hidden = v !== 'programado';
      if ($(id + '-conf-w')) $(id + '-conf-w').hidden = v !== 'inmediato';
    };
  }
  function modoLee(id) {
    const v = ($(id + '-modo') || {}).value || 'ventana';
    const o = { modo: v };
    if (v === 'inmediato') o.confirmarInmediato = !!($(id + '-conf') || {}).checked;
    if (v === 'programado') {
      const f = ($(id + '-fecha') || {}).value;
      if (f) o.fechaProgramada = new Date(f).toISOString();
    }
    return o;
  }

  function tabla(cols, filas, vacio) {
    if (!filas.length) return '<p class="aviso">' + (vacio || 'Sin datos.') + '</p>';
    const th = cols.map((c) => '<th>' + c.t + '</th>').join('');
    const tr = filas.map((f) => '<tr>' + cols.map((c) => '<td>' + c.v(f) + '</td>').join('') + '</tr>').join('');
    return '<div class="scroll"><table><thead><tr>' + th + '</tr></thead><tbody>' + tr + '</tbody></table></div>';
  }

  // ================= SUCURSALES =====================================
  const Sucursales = {
    titulo: 'Sucursales',
    async cargar() {
      const lista = await api('GET', '/sucursales');
      window.__sucs = lista; // lo usan los selects de usuarios
      $('panel').innerHTML =
        '<details class="alta"><summary>+ Nueva sucursal</summary>'
        + '<form class="alta" id="suc-alta">'
        + '<label>Nombre<input id="suc-nombre" required></label>'
        + '<label>Dirección completa<input id="suc-dir" required></label>'
        + '<label>Teléfono<input id="suc-tel" required></label>'
        + '<label>Zona horaria<input id="suc-zona" value="America/Mexico_City"></label>'
        + '<label>Código (opcional)<input id="suc-cod" maxlength="1" placeholder="auto"></label>'
        + modoHtml('suc')
        + '<div class="full"><button class="btn" type="submit">Crear</button></div>'
        + '</form></details>'
        + tabla([
          { t: 'Cód.', v: (s) => '<strong>' + esc(s.codigo) + '</strong>' },
          { t: 'Nombre', v: (s) => esc(s.nombre) },
          { t: 'Zona', v: (s) => '<span class="nota">' + esc(s.zonaHoraria) + '</span>' },
          { t: 'Vigencia', v: (s) => '<span class="nota">' + fecha(s.effectiveFrom) + (s.effectiveUntil ? ' → ' + fecha(s.effectiveUntil) : '') + '</span>' },
          { t: 'Estado', v: (s) => s.activo ? '<span class="chip ok">activa</span>' : '<span class="chip baja">baja</span>' },
          { t: 'HOTP', v: (s) => s.tieneHotp ? 'sí' : '<span class="error">falta</span>' },
          { t: '', v: (s) => accionesSuc(s) },
        ], lista, 'Sin sucursales.');
      modoBind('suc');
      $('suc-alta').onsubmit = async (e) => {
        e.preventDefault();
        try {
          const r = await api('POST', '/sucursales', Object.assign({
            nombre: $('suc-nombre').value, direccionCompleta: $('suc-dir').value,
            telefonoPrincipal: $('suc-tel').value, zonaHoraria: $('suc-zona').value,
            codigo: $('suc-cod').value || undefined,
          }, modoLee('suc')));
          toast('Sucursal ' + r.codigo + ' creada.');
          this.cargar();
        } catch (err) { toast(err.message, true); }
      };
      wire();
    },
  };
  function accionesSuc(s) {
    return '<button class="btn link" data-a="suc-edit" data-id="' + s.id + '">editar</button>'
      + (s.activo ? '<button class="btn link rojo" data-a="suc-baja" data-id="' + s.id + '">baja</button>' : '')
      + '<button class="btn link" data-a="suc-hotp" data-id="' + s.id + '">regenerar HOTP</button>';
  }

  // ================= USUARIOS =======================================
  const Usuarios = {
    titulo: 'Usuarios y accesos',
    async cargar() {
      const [lista, sucs] = await Promise.all([
        api('GET', '/usuarios'),
        window.__sucs ? Promise.resolve(window.__sucs) : api('GET', '/sucursales'),
      ]);
      window.__sucs = sucs;
      const checks = sucs.filter((s) => s.activo).map((s) =>
        '<label style="font-weight:400"><input type="checkbox" class="usr-suc" value="' + s.id + '"> ' + esc(s.codigo) + ' ' + esc(s.nombre) + '</label>'
      ).join('');
      $('panel').innerHTML =
        '<details class="alta"><summary>+ Nuevo usuario</summary>'
        + '<form class="alta" id="usr-alta">'
        + '<label>Nombre<input id="usr-nombre" required></label>'
        + '<label>Correo<input type="email" id="usr-email" required></label>'
        + '<label>Rol<select id="usr-rol"><option>vendedor</option><option>gerente</option><option>administrador</option></select></label>'
        + '<label>Teléfono<input id="usr-tel"></label>'
        + '<div class="full"><span class="nota">Sucursales</span><br>' + (checks || '<span class="nota">no hay sucursales activas</span>') + '</div>'
        + modoHtml('usr')
        + '<div class="full"><button class="btn" type="submit">Crear</button></div>'
        + '</form></details>'
        + tabla([
          { t: 'Nombre', v: (u) => esc(u.nombre) + '<br><span class="nota">' + esc(u.email) + '</span>' },
          { t: 'Rol', v: (u) => esc(u.rol) },
          { t: 'Sucursales', v: (u) => (u.sucursales || []).map((s) => '<span class="chip' + (s.activa ? '' : ' baja') + '">' + esc(s.codigo) + '</span>').join('') || '<span class="nota">—</span>' },
          { t: 'Credencial', v: (u) => !u.tieneCredencial ? '<span class="error">falta</span>' : u.debeCambiarPassword ? '<span class="chip">temporal</span>' : 'ok' },
          { t: 'Estado', v: (u) => u.activo ? '<span class="chip ok">alta</span>' : '<span class="chip baja">baja</span>' },
          { t: '', v: (u) => accionesUsr(u) },
        ], lista, 'Sin usuarios.');
      modoBind('usr');
      $('usr-alta').onsubmit = async (e) => {
        e.preventDefault();
        try {
          const sucursalIds = [...document.querySelectorAll('.usr-suc:checked')].map((c) => c.value);
          const r = await api('POST', '/usuarios', Object.assign({
            nombre: $('usr-nombre').value, email: $('usr-email').value,
            rol: $('usr-rol').value, telefono: $('usr-tel').value || undefined,
            sucursalIds,
          }, modoLee('usr')));
          toast('Usuario creado. Contraseña temporal: ' + r.passwordTemporal);
          this.cargar();
        } catch (err) { toast(err.message, true); }
      };
      wire();
    },
  };
  function accionesUsr(u) {
    return '<button class="btn link" data-a="usr-edit" data-id="' + u.id + '">editar</button>'
      + (u.activo ? '<button class="btn link rojo" data-a="usr-baja" data-id="' + u.id + '">baja</button>' : '')
      + '<button class="btn link" data-a="usr-suc" data-id="' + u.id + '">sucursales</button>'
      + '<button class="btn link" data-a="usr-pass" data-id="' + u.id + '">contraseña</button>'
      + '<button class="btn link" data-a="usr-revocar" data-id="' + u.id + '">código revocación</button>';
  }

  // ================= IMPRESORAS =====================================
  const Impresoras = {
    titulo: 'Impresoras',
    async cargar() {
      const [lista, sucs] = await Promise.all([
        api('GET', '/impresoras'),
        window.__sucs ? Promise.resolve(window.__sucs) : api('GET', '/sucursales'),
      ]);
      window.__sucs = sucs;
      const opSuc = sucs.filter((s) => s.activo).map((s) => '<option value="' + s.id + '">' + esc(s.codigo) + ' ' + esc(s.nombre) + '</option>').join('');
      $('panel').innerHTML =
        '<p class="nota">Una impresora por sucursal. Los cambios son inmediatos: la IP es hardware presente, no una política.</p>'
        + '<details class="alta"><summary>+ Configurar impresora</summary>'
        + '<form class="alta" id="imp-alta">'
        + '<label>Sucursal<select id="imp-suc">' + opSuc + '</select></label>'
        + '<label>Nombre<input id="imp-nombre" value="Enduro" required></label>'
        + '<label>Transporte<select id="imp-transp"><option value="tcp">TCP (red)</option><option value="usb">USB (cola Windows)</option></select></label>'
        + '<label id="imp-ip-w">IP<input id="imp-ip" placeholder="192.168.1.110"></label>'
        + '<label id="imp-puerto-w">Puerto<input id="imp-puerto" type="number" value="9100"></label>'
        + '<label id="imp-cola-w" hidden>Cola USB<input id="imp-cola" placeholder="XP-80"></label>'
        + '<label>Columnas<input id="imp-cols" type="number" value="48"></label>'
        + '<label>Code page<input id="imp-cp" value="CP858"></label>'
        + '<label style="align-self:center"><input type="checkbox" id="imp-def" checked> predeterminada</label>'
        + '<div class="full"><button class="btn" type="submit">Guardar</button></div>'
        + '</form></details>'
        + tabla([
          { t: 'Sucursal', v: (i) => esc(i.sucursal_nombre) },
          { t: 'Nombre', v: (i) => esc(i.nombre) },
          { t: 'Transporte', v: (i) => i.transporte === 'tcp' ? esc(i.ip) + ':' + i.puerto : 'USB · ' + esc(i.usb_nombre_cola) },
          { t: 'Ancho', v: (i) => i.ancho_cols + ' col' },
          { t: 'Code page', v: (i) => esc(i.code_page) },
          { t: 'QR nativo', v: (i) => i.soporta_qr_nativo ? 'sí' : 'raster' },
          { t: '', v: (i) => i.es_predeterminada ? '<span class="chip ok">predet.</span>' : '' },
        ], lista, 'Ninguna sucursal tiene impresora configurada.');
      const t = $('imp-transp');
      const sync = () => { $('imp-ip-w').hidden = t.value !== 'tcp'; $('imp-puerto-w').hidden = t.value !== 'tcp'; $('imp-cola-w').hidden = t.value !== 'usb'; };
      t.onchange = sync; sync();
      $('imp-alta').onsubmit = async (e) => {
        e.preventDefault();
        try {
          await api('POST', '/impresoras', {
            sucursalId: $('imp-suc').value, nombre: $('imp-nombre').value, transporte: t.value,
            ip: $('imp-ip').value || undefined, puerto: Number($('imp-puerto').value) || undefined,
            usbNombreCola: $('imp-cola').value || undefined,
            anchoCols: Number($('imp-cols').value) || undefined, codePage: $('imp-cp').value || undefined,
            esPredeterminada: $('imp-def').checked,
          });
          toast('Impresora guardada.'); this.cargar();
        } catch (err) { toast(err.message, true); }
      };
      wire();
    },
  };

  // ================= TICKET =========================================
  const Ticket = {
    titulo: 'Ticket',
    async cargar() {
      const v = await api('GET', '/ticket');
      $('panel').innerHTML =
        '<p class="nota">Datos del pie del boleto. Cada guardado publica una versión nueva (versionado por fecha).</p>'
        + '<form class="alta" id="tk-alta">'
        + campo('tk-leyenda', 'Leyenda de pie', v.leyenda_pie)
        + campo('tk-tel', 'Teléfono de atención', v.telefono_atencion)
        + campo('tk-prov', 'Créditos del proveedor', v.credenciales_proveedor)
        + campo('tk-logo', 'URL del logo', v.logo_url)
        + campo('tk-hmac', 'Secreto HMAC del QR', v.hmac_qr_secreto)
        + modoHtml('tk')
        + '<div class="full"><button class="btn" type="submit">Publicar versión</button>'
        + (v.effective_from ? ' <span class="nota">vigente desde ' + fecha(v.effective_from) + '</span>' : ' <span class="nota">sin configuración previa</span>') + '</div>'
        + '</form>';
      modoBind('tk');
      $('tk-alta').onsubmit = async (e) => {
        e.preventDefault();
        try {
          await api('POST', '/ticket', Object.assign({
            leyendaPie: $('tk-leyenda').value, telefonoAtencion: $('tk-tel').value,
            credencialesProveedor: $('tk-prov').value, logoUrl: $('tk-logo').value || null,
            hmacQrSecreto: $('tk-hmac').value || null,
          }, modoLee('tk')));
          toast('Ticket publicado.'); this.cargar();
        } catch (err) { toast(err.message, true); }
      };
    },
  };
  function campo(id, label, valor) {
    return '<label class="full">' + label + '<input id="' + id + '" value="' + esc(valor || '') + '"></label>';
  }

  // ================= TARIFAS ========================================
  const Tarifas = {
    titulo: 'Tarifas',
    async cargar() {
      const [rutas, lista] = await Promise.all([api('GET', '/rutas'), api('GET', '/tarifas')]);
      window.__rutas = rutas;
      const opR = rutas.map((r) => '<option value="' + r.id + '">' + esc(r.nombre) + '</option>').join('');
      $('panel').innerHTML =
        '<p class="nota">Un precio por tramo. Nunca inmediato (§3.4): entra por la ventana nocturna o programado. El precio nuevo cierra el anterior del mismo tramo.</p>'
        + '<details class="alta"><summary>+ Nueva tarifa</summary>'
        + '<form class="alta" id="tf-alta">'
        + '<label>Ruta<select id="tf-ruta">' + opR + '</select></label>'
        + '<label>Desde<select id="tf-org"></select></label>'
        + '<label>Hasta<select id="tf-dst"></select></label>'
        + '<label>Importe<input id="tf-imp" type="number" step="0.01" min="0" required></label>'
        + modoHtml('tf', { soloDiferido: true })
        + '<div class="full"><button class="btn" type="submit">Crear</button></div>'
        + '</form></details>'
        + tabla([
          { t: 'Ruta', v: (t) => esc(t.ruta_nombre) },
          { t: 'Tramo', v: (t) => t.parada_origen_orden + ' → ' + t.parada_destino_orden },
          { t: 'Importe', v: (t) => Number(t.importe).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' }) },
          { t: 'Vigencia', v: (t) => '<span class="nota">' + fecha(t.effective_from) + (t.effective_until ? ' → ' + fecha(t.effective_until) : '') + '</span>' },
          { t: 'Estado', v: (t) => t.activo && !t.effective_until ? '<span class="chip ok">vigente</span>' : '<span class="chip baja">cerrada</span>' },
          { t: '', v: (t) => t.activo && !t.effective_until ? '<button class="btn link rojo" data-a="tf-baja" data-id="' + t.id + '">retirar</button>' : '' },
        ], lista, 'Sin tarifas.');
      modoBind('tf');
      const rSel = $('tf-ruta');
      const pobla = () => {
        const r = rutas.find((x) => x.id === rSel.value) || { paradas: [] };
        const ops = (r.paradas || []).map((p) => '<option value="' + p.orden + '">' + p.orden + ' · ' + esc(p.sucursal) + '</option>').join('');
        $('tf-org').innerHTML = ops; $('tf-dst').innerHTML = ops;
        if ($('tf-dst').options.length > 1) $('tf-dst').selectedIndex = $('tf-dst').options.length - 1;
      };
      rSel.onchange = pobla; pobla();
      $('tf-alta').onsubmit = async (e) => {
        e.preventDefault();
        try {
          await api('POST', '/tarifas', Object.assign({
            rutaId: rSel.value, paradaOrigenOrden: Number($('tf-org').value),
            paradaDestinoOrden: Number($('tf-dst').value), importe: Number($('tf-imp').value),
          }, modoLee('tf')));
          toast('Tarifa creada.'); this.cargar();
        } catch (err) { toast(err.message, true); }
      };
      wire();
    },
  };

  // ---- acciones de fila (prompt/confirm; formularios completos vendrán después)
  async function accion(a, id) {
    try {
      if (a === 'suc-baja') {
        if (!confirm('¿Dar de baja esta sucursal?')) return;
        await api('POST', '/sucursales/' + id + '/baja', { modo: 'inmediato', confirmarInmediato: true });
        toast('Sucursal dada de baja.'); return SECCION.cargar();
      }
      if (a === 'suc-hotp') {
        if (!confirm('Regenerar la semilla HOTP invalida los códigos viejos. ¿Continuar?')) return;
        await api('POST', '/sucursales/' + id + '/regenerar-hotp');
        toast('Semilla HOTP regenerada.'); return SECCION.cargar();
      }
      if (a === 'suc-edit') {
        const s = (window.__sucs || []).find((x) => x.id === id) || {};
        const nombre = prompt('Nombre', s.nombre); if (nombre === null) return;
        const tel = prompt('Teléfono', s.telefonoPrincipal); if (tel === null) return;
        await api('PATCH', '/sucursales/' + id, { nombre, telefonoPrincipal: tel, modo: 'inmediato', confirmarInmediato: true });
        toast('Sucursal actualizada.'); return SECCION.cargar();
      }
      if (a === 'usr-baja') {
        if (!confirm('¿Dar de baja este usuario? (inmediato)')) return;
        await api('POST', '/usuarios/' + id + '/baja', {});
        toast('Usuario dado de baja.'); return SECCION.cargar();
      }
      if (a === 'usr-edit') {
        const nombre = prompt('Nombre'); if (nombre === null) return;
        const rol = prompt('Rol (vendedor / gerente / administrador)'); if (rol === null) return;
        await api('PATCH', '/usuarios/' + id, { nombre, rol, modo: 'inmediato', confirmarInmediato: true });
        toast('Usuario actualizado.'); return SECCION.cargar();
      }
      if (a === 'usr-suc') {
        const sucs = window.__sucs || [];
        const cod = prompt('Código de sucursal a asignar/quitar:\n' + sucs.filter((s) => s.activa !== false).map((s) => s.codigo + ' ' + s.nombre).join('\n'));
        if (!cod) return;
        const s = sucs.find((x) => x.codigo === cod.trim().toUpperCase());
        if (!s) { toast('No encontré esa sucursal.', true); return; }
        const quitar = confirm('Aceptar = ASIGNAR a ' + s.nombre + '. Cancelar = QUITAR.');
        if (quitar) await api('POST', '/usuarios/' + id + '/sucursales', { sucursalId: s.id, modo: 'inmediato', confirmarInmediato: true });
        else await api('DELETE', '/usuarios/' + id + '/sucursales/' + s.id, {});
        toast('Asignación actualizada.'); return SECCION.cargar();
      }
      if (a === 'usr-pass') {
        if (!confirm('¿Generar una contraseña temporal nueva? La actual dejará de valer.')) return;
        const r = await api('POST', '/usuarios/' + id + '/restablecer-password', {});
        toast('Nueva contraseña temporal: ' + r.passwordTemporal);
        return;
      }
      if (a === 'usr-revocar') {
        const sucs = window.__sucs || [];
        const cod = prompt('Sucursal donde revocar (código):\n' + sucs.map((s) => s.codigo + ' ' + s.nombre).join('\n'));
        if (!cod) return;
        const s = sucs.find((x) => x.codigo === cod.trim().toUpperCase());
        if (!s) { toast('No encontré esa sucursal.', true); return; }
        const r = await api('POST', '/usuarios/' + id + '/codigo-revocacion', { sucursalId: s.id });
        window.prompt('Dicta este código por teléfono al gerente de ' + s.nombre + ':', r.codigo);
      }
      if (a === 'tf-baja') {
        if (!confirm('¿Retirar el precio de este tramo? Entra por la ventana nocturna.')) return;
        await api('POST', '/tarifas/' + id + '/baja', { modo: 'ventana' });
        toast('Tarifa retirada (a partir de la próxima ventana).'); return SECCION.cargar();
      }
    } catch (err) { if (err.message !== 'sesión') toast(err.message, true); }
  }
  function wire() {
    document.querySelectorAll('[data-a]').forEach((b) => {
      b.onclick = () => accion(b.dataset.a, b.dataset.id);
    });
  }

  // ---- shell -------------------------------------------------------
  const SECCIONES = [Sucursales, Usuarios, Impresoras, Ticket, Tarifas];
  let SECCION = SECCIONES[0];

  function pintarTabs() {
    $('tabs').innerHTML = SECCIONES.map((s, i) =>
      '<button data-i="' + i + '" class="' + (s === SECCION ? 'activo' : '') + '">' + s.titulo + '</button>'
    ).join('');
    $('tabs').querySelectorAll('button').forEach((b) => b.onclick = () => {
      SECCION = SECCIONES[+b.dataset.i]; pintarTabs(); recargar();
    });
  }
  async function recargar() {
    $('panel').innerHTML = '<p class="aviso">Cargando…</p>';
    try { await SECCION.cargar(); }
    catch (e) { if (e.message !== 'sesión') $('panel').innerHTML = '<p class="aviso error">' + esc(e.message) + '</p>'; }
  }

  function salir(txt) {
    try { localStorage.removeItem(JWT_KEY); } catch (e) { /* */ }
    jwt = null;
    $('app').hidden = true; $('login').hidden = false;
    if (txt) { $('login-error').textContent = txt; $('login-error').hidden = false; }
  }

  async function entrar() {
    try {
      const yo = await api('GET', '/yo');
      $('quien').textContent = yo.email + (yo.viaListaDeArranque ? ' · arranque' : '');
    } catch (e) { return; }
    $('login').hidden = true; $('app').hidden = false;
    pintarTabs(); recargar();
  }

  async function initLogin() {
    try { cfg = await (await fetch('/config')).json(); } catch (e) { /* */ }
    if (cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase) {
      supa = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
      $('f-supa').hidden = false;
      $('f-supa').onsubmit = async (ev) => {
        ev.preventDefault();
        $('login-error').hidden = true;
        const { data, error } = await supa.auth.signInWithPassword({ email: $('s-email').value, password: $('s-pass').value });
        if (error || !data.session) { $('login-error').textContent = 'No se pudo entrar.'; $('login-error').hidden = false; return; }
        jwt = data.session.access_token;
        try { localStorage.setItem(JWT_KEY, jwt); } catch (e) { /* */ }
        entrar();
      };
    } else {
      $('f-token').hidden = false;
      $('f-token').onsubmit = (ev) => {
        ev.preventDefault();
        jwt = $('t-token').value.trim();
        try { localStorage.setItem(JWT_KEY, jwt); } catch (e) { /* */ }
        entrar();
      };
    }
  }

  $('salir').onclick = () => salir();

  if (jwt) entrar();
  initLogin();
})();
