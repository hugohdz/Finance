/* Backend simulado (modo demo) – solo se usa si js/config.js no tiene API_URL.
   Replica las acciones de apps-script/Code.gs guardando en localStorage. */
(function () {
  'use strict';
  const KEY = 'finance_demo_db';
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const r2 = n => Math.round(Number(n || 0) * 100) / 100;

  function seed() {
    const cat = n => ({ id: uid(), nombre: n, activo: true });
    return {
      Usuarios: [
        { usuario: 'admin', password: 'admin123', rol: 'admin', responsable: 'Persona A', activo: true },
        { usuario: 'consulta', password: 'consulta123', rol: 'responsable', responsable: 'Persona B', activo: true },
      ],
      Tarjetas: [{ id: uid(), nombre: 'Crédito', tipo: 'credito', activo: true, dia_corte: 13 }, { id: uid(), nombre: 'Débito', tipo: 'debito', activo: true }],
      Responsables: ['Persona A', 'Persona B', 'Persona C'].map(cat),
      Categorias: ['Gasolina', 'Casa', 'Comida', 'Streaming', 'Entretenimiento', 'Servicios', 'Telefonía', 'Salud', 'Ropa',
        'Tecnología', 'Viajes', 'Gimnasio', 'Comisiones e intereses', 'Otros'].map(cat),
      Movimientos: [], Asignaciones: [], Limites: [{ periodo: '*', tarjeta: '*', monto: 30000 }], EstadosCuenta: [], Devolventes: [],
      sessions: {},
    };
  }
  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || seed(); } catch (e) { return seed(); }
  }
  function save(db) { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* ignore */ } }

  const H = {
    login(db, req) {
      const u = db.Usuarios.find(x => x.usuario === String(req.usuario || '').toLowerCase().trim());
      if (!u || u.password !== req.password || !u.activo) throw new Error('Usuario o contraseña incorrectos');
      const token = uid();
      db.sessions[token] = { usuario: u.usuario, rol: u.rol, responsable: u.responsable };
      return Object.assign({ token }, db.sessions[token]);
    },
    logout(db, req) { delete db.sessions[req.token]; return true; },
    bootstrap(db, req, s) {
      return { session: s, tarjetas: db.Tarjetas, responsables: db.Responsables, categorias: db.Categorias, limites: db.Limites,
        devolventes: (db.Devolventes || []).filter(d => s.rol === 'admin' || d.responsable === s.responsable),
        periodos: Array.from(new Set(db.Movimientos.map(m => m.periodo))).sort().reverse() };
    },
    getPeriodo(db, req, s) {
      let movs = db.Movimientos.filter(m => m.periodo === req.periodo);
      const ids = new Set(movs.map(m => m.id));
      let asig = db.Asignaciones.filter(a => ids.has(a.movimiento_id));
      let estados = db.EstadosCuenta.filter(e => e.periodo === req.periodo);
      if (s.rol !== 'admin') {
        asig = asig.filter(a => a.responsable === s.responsable);
        const mine = new Set(asig.map(a => a.movimiento_id));
        movs = movs.filter(m => mine.has(m.id));
        estados = [];
      }
      return { periodo: req.periodo, movimientos: movs, asignaciones: asig, estados };
    },
    historial(db, req, s) {
      const byId = {}; db.Movimientos.forEach(m => { byId[m.id] = m; });
      const out = {};
      db.Asignaciones.forEach(a => {
        const m = byId[a.movimiento_id];
        if (!m || (s.rol !== 'admin' && a.responsable !== s.responsable)) return;
        const k = m.periodo + '|' + a.responsable;
        out[k] = r2((out[k] || 0) + (m.tipo === 'devolucion' ? -1 : 1) * a.monto);
      });
      return Object.keys(out).map(k => ({ periodo: k.split('|')[0], responsable: k.split('|')[1], total: out[k] }));
    },
    saveMovimiento(db, req, s) {
      corte(db, req.movimiento);
      const m = Object.assign({}, req.movimiento, { monto: r2(req.movimiento.monto), creado_por: s.usuario, actualizado: new Date().toISOString() });
      if (m.id) { const i = db.Movimientos.findIndex(x => x.id === m.id); db.Movimientos[i] = Object.assign(db.Movimientos[i], m); }
      else { m.id = uid(); db.Movimientos.push(m); }
      db.Asignaciones = db.Asignaciones.filter(a => a.movimiento_id !== m.id)
        .concat((req.asignaciones || []).map(a => ({ id: uid(), movimiento_id: m.id, responsable: a.responsable, monto: r2(a.monto), concepto: a.concepto || '' })));
      return { id: m.id };
    },
    deleteMovimiento(db, req) {
      db.Movimientos = db.Movimientos.filter(m => m.id !== req.id);
      db.Asignaciones = db.Asignaciones.filter(a => a.movimiento_id !== req.id);
      return true;
    },
    importMovimientos(db, req, s) {
      (req.items || []).forEach(it => H.saveMovimiento(db, { movimiento: Object.assign({}, it.movimiento, { id: '' }), asignaciones: it.asignaciones }, s));
      return { insertados: (req.items || []).length };
    },
    saveCatalogo(db, req) {
      const rows = db[req.tipo]; const it = req.item;
      if (it.id) Object.assign(rows.find(r => r.id === it.id), it);
      else { if (rows.some(r => r.nombre.toLowerCase() === it.nombre.toLowerCase())) throw new Error('Ya existe: ' + it.nombre); it.id = uid(); rows.push(it); }
      return it;
    },
    saveLimite(db, req) {
      db.Limites = db.Limites.filter(l => !(l.periodo === req.periodo && l.tarjeta === req.tarjeta));
      if (req.monto !== '' && req.monto !== null) db.Limites.push({ periodo: req.periodo, tarjeta: req.tarjeta, monto: r2(req.monto) });
      return db.Limites;
    },
    saveEstado(db, req) {
      db.EstadosCuenta = db.EstadosCuenta.filter(e => !(e.periodo === req.periodo && e.tarjeta === req.tarjeta));
      if (req.total !== '') db.EstadosCuenta.push({ periodo: req.periodo, tarjeta: req.tarjeta, total: r2(req.total) });
      return true;
    },
    saveDevolvente(db, req) {
      db.Devolventes = db.Devolventes || [];
      const d = Object.assign({}, req.devolvente);
      if (!d.tarjeta || !d.descripcion || !d.responsable) throw new Error('Tarjeta, descripción y responsable son requeridos');
      if (d.id) Object.assign(db.Devolventes.find(x => x.id === d.id), d);
      else { d.id = uid(); d.activo = true; db.Devolventes.push(d); }
      return d;
    },
    deleteDevolvente(db, req) { db.Devolventes = (db.Devolventes || []).filter(d => d.id !== req.id); return true; },
    listUsuarios(db) { return db.Usuarios.map(u => ({ usuario: u.usuario, rol: u.rol, responsable: u.responsable, activo: u.activo })); },
    saveUsuario(db, req) {
      const u = req.user; const name = u.usuario.toLowerCase().trim();
      let row = db.Usuarios.find(x => x.usuario === name);
      if (!row) { if (!u.password) throw new Error('Contraseña requerida'); row = { usuario: name }; db.Usuarios.push(row); }
      Object.assign(row, { rol: u.rol, responsable: u.responsable, activo: u.activo });
      if (u.password) row.password = u.password;
      return true;
    },
    cambiarPassword(db, req, s) {
      const row = db.Usuarios.find(x => x.usuario === s.usuario);
      if (row.password !== req.actual) throw new Error('Contraseña actual incorrecta');
      row.password = req.nueva; return true;
    },
  };

  function corte(db, m) {
    if (m.tipo !== 'cargo') return;
    const t = db.Tarjetas.find(x => x.nombre === m.tarjeta);
    if (!t || t.tipo !== 'credito' || !Number(t.dia_corte) || Number(m.msi_actual) > 1) return;
    const [y, mo, d] = String(m.fecha).split('-').map(Number);
    let yy = y, mm = mo + (d > Number(t.dia_corte) ? 1 : 0);
    if (mm > 12) { mm = 1; yy++; }
    const esperado = yy + '-' + String(mm).padStart(2, '0');
    const sig = mm === 12 ? (yy + 1) + '-01' : yy + '-' + String(mm + 1).padStart(2, '0');
    if (esperado !== m.periodo && sig !== m.periodo) throw new Error('"' + m.descripcion + '" (' + m.fecha + ') corresponde al corte ' + esperado + ' (día de corte ' + t.dia_corte + ').');
  }

  window.FinanceMock = {
    async call(req) {
      await new Promise(r => setTimeout(r, 80));
      const db = load();
      try {
        if (req.action === 'login') { const d = H.login(db, req); save(db); return { ok: true, data: d }; }
        const s = db.sessions[req.token];
        if (!s) return { ok: false, error: 'SESSION' };
        const data = H[req.action](db, req, s);
        save(db);
        return { ok: true, data: JSON.parse(JSON.stringify(data)) };
      } catch (e) { return { ok: false, error: e.message }; }
    },
  };
})();
