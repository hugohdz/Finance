/**
 * Finance – Backend en Google Apps Script sobre Google Sheets.
 *
 * Despliegue:
 *  1. Crea una Google Sheet nueva y abre Extensiones > Apps Script.
 *  2. Pega este archivo (Code.gs) y appsscript.json.
 *  3. Ejecuta setup() una vez (crea hojas y catálogos base).
 *  4. Ejecuta crearAdminInicial() después de editar usuario/contraseña dentro de esa función
 *     (y luego borra la contraseña del código).
 *  5. Implementar > Nueva implementación > Aplicación web
 *       Ejecutar como: Yo   |   Quién tiene acceso: Cualquier usuario
 *  6. Copia la URL /exec en js/config.js del sitio.
 */

const SESSION_HOURS = 8;

const SCHEMA = {
  Usuarios:      ['usuario', 'hash', 'salt', 'rol', 'responsable', 'activo'],
  Tarjetas:      ['id', 'nombre', 'tipo', 'activo'],
  Responsables:  ['id', 'nombre', 'activo'],
  Categorias:    ['id', 'nombre', 'activo'],
  Movimientos:   ['id', 'periodo', 'tarjeta', 'fecha', 'descripcion', 'monto', 'tipo', 'categoria',
                  'msi_actual', 'msi_total', 'ref_id', 'notas', 'creado_por', 'actualizado'],
  Asignaciones:  ['id', 'movimiento_id', 'responsable', 'monto', 'concepto'],
  Limites:       ['periodo', 'tarjeta', 'monto'],
  EstadosCuenta: ['periodo', 'tarjeta', 'total', 'notas'],
};

const ADMIN_ONLY = ['saveMovimiento', 'deleteMovimiento', 'importMovimientos', 'saveCatalogo',
                    'saveLimite', 'saveEstado', 'saveUsuario', 'listUsuarios'];

/* ============================ HTTP ============================ */

function doGet() {
  return json_({ ok: true, app: 'Finance API' });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Petición inválida' });
  }
  try {
    const action = req.action;
    if (action === 'login') return json_({ ok: true, data: login_(req.usuario, req.password) });

    const session = getSession_(req.token);
    if (!session) return json_({ ok: false, error: 'SESSION', message: 'Sesión expirada' });
    if (ADMIN_ONLY.indexOf(action) >= 0 && session.rol !== 'admin') {
      return json_({ ok: false, error: 'No autorizado' });
    }
    const handler = HANDLERS[action];
    if (!handler) return json_({ ok: false, error: 'Acción desconocida: ' + action });

    const isWrite = /^(save|delete|import|cambiar|logout)/.test(action);
    let data;
    if (isWrite) {
      const lock = LockService.getScriptLock();
      lock.waitLock(20000);
      try { data = handler(req, session); } finally { lock.releaseLock(); }
    } else {
      data = handler(req, session);
    }
    return json_({ ok: true, data: data });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ============================ Auth ============================ */

function hash_(password, salt) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + password,
                                        Utilities.Charset.UTF_8);
  let out = bytes;
  // estiramiento simple de clave
  for (let i = 0; i < 500; i++) {
    out = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
                                  Utilities.base64Encode(out) + salt);
  }
  return Utilities.base64Encode(out);
}

function login_(usuario, password) {
  usuario = String(usuario || '').trim().toLowerCase();
  const cache = CacheService.getScriptCache();
  const failKey = 'fail_' + usuario;
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= 5) throw new Error('Demasiados intentos. Espera 10 minutos.');

  const u = readTable_('Usuarios').find(r => String(r.usuario).toLowerCase() === usuario);
  if (!u || !truthy_(u.activo) || hash_(String(password || ''), u.salt) !== u.hash) {
    cache.put(failKey, String(fails + 1), 600);
    throw new Error('Usuario o contraseña incorrectos');
  }
  cache.remove(failKey);
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  const session = { usuario: u.usuario, rol: u.rol, responsable: u.responsable };
  cache.put('s_' + token, JSON.stringify(session), SESSION_HOURS * 3600);
  return Object.assign({ token: token }, session);
}

function getSession_(token) {
  if (!token) return null;
  const raw = CacheService.getScriptCache().get('s_' + token);
  return raw ? JSON.parse(raw) : null;
}

function truthy_(v) {
  return v === true || String(v).toLowerCase() === 'true' || String(v) === '1' || String(v).toLowerCase() === 'si';
}

/* ============================ Tablas ============================ */

function sheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, SCHEMA[name].length).setValues([SCHEMA[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
    // columnas de texto que Sheets intentaría convertir (periodo, fecha)
    SCHEMA[name].forEach((h, i) => {
      if (h === 'periodo' || h === 'fecha') sh.getRange(1, i + 1, sh.getMaxRows(), 1).setNumberFormat('@');
    });
  }
  return sh;
}

function readTable_(name) {
  const sh = sheet_(name);
  const values = sh.getDataRange().getValues();
  const headers = values.shift();
  return values
    .filter(r => r.some(c => c !== '' && c !== null))
    .map(r => {
      const o = {};
      headers.forEach((h, i) => {
        let v = r[i];
        if (v instanceof Date) {
          // Sheets convierte "2026-11" en fecha; lo regresamos a texto.
          v = Utilities.formatDate(v, Session.getScriptTimeZone(), h === 'periodo' ? 'yyyy-MM' : 'yyyy-MM-dd');
        }
        o[h] = v;
      });
      return o;
    });
}

function writeTable_(name, rows) {
  const sh = sheet_(name);
  const headers = SCHEMA[name];
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, sh.getLastColumn()).clearContent();
  if (!rows.length) return;
  const data = rows.map(o => headers.map(h => (o[h] === undefined || o[h] === null) ? '' : o[h]));
  sh.getRange(2, 1, data.length, headers.length).setValues(data);
}

function appendRows_(name, rows) {
  if (!rows.length) return;
  const sh = sheet_(name);
  const headers = SCHEMA[name];
  const data = rows.map(o => headers.map(h => (o[h] === undefined || o[h] === null) ? '' : o[h]));
  sh.getRange(sh.getLastRow() + 1, 1, data.length, headers.length).setValues(data);
}

function round2_(n) { return Math.round(Number(n || 0) * 100) / 100; }

/* ============================ Handlers ============================ */

const HANDLERS = {
  logout: function (req) {
    CacheService.getScriptCache().remove('s_' + req.token);
    return true;
  },

  bootstrap: function (req, s) {
    const movs = readTable_('Movimientos');
    const periodos = {};
    movs.forEach(m => { periodos[m.periodo] = true; });
    return {
      session: s,
      tarjetas: readTable_('Tarjetas'),
      responsables: readTable_('Responsables'),
      categorias: readTable_('Categorias'),
      limites: readTable_('Limites'),
      periodos: Object.keys(periodos).sort().reverse(),
    };
  },

  /** Movimientos + asignaciones + estados de cuenta de un periodo. */
  getPeriodo: function (req, s) {
    const periodo = String(req.periodo);
    let movs = readTable_('Movimientos').filter(m => String(m.periodo) === periodo);
    const ids = {};
    movs.forEach(m => { ids[m.id] = true; });
    let asig = readTable_('Asignaciones').filter(a => ids[a.movimiento_id]);
    let estados = readTable_('EstadosCuenta').filter(e => String(e.periodo) === periodo);

    if (s.rol !== 'admin') {
      asig = asig.filter(a => a.responsable === s.responsable);
      const mine = {};
      asig.forEach(a => { mine[a.movimiento_id] = true; });
      movs = movs.filter(m => mine[m.id]);
      estados = [];
    }
    return { periodo: periodo, movimientos: movs, asignaciones: asig, estados: estados };
  },

  /** Totales por periodo del responsable (o de todos si es admin). */
  historial: function (req, s) {
    const movs = readTable_('Movimientos');
    const byId = {};
    movs.forEach(m => { byId[m.id] = m; });
    const out = {};
    readTable_('Asignaciones').forEach(a => {
      const m = byId[a.movimiento_id];
      if (!m) return;
      if (s.rol !== 'admin' && a.responsable !== s.responsable) return;
      const sign = m.tipo === 'devolucion' ? -1 : 1;
      const key = m.periodo + '|' + a.responsable;
      out[key] = round2_((out[key] || 0) + sign * Number(a.monto));
    });
    return Object.keys(out).map(k => {
      const p = k.split('|');
      return { periodo: p[0], responsable: p[1], total: out[k] };
    });
  },

  saveMovimiento: function (req, s) {
    const m = req.movimiento;
    validateMov_(m);
    const asig = (req.asignaciones || []).filter(a => a.responsable && Number(a.monto) !== 0);
    const movs = readTable_('Movimientos');
    const now = new Date().toISOString();
    m.monto = round2_(m.monto);
    m.creado_por = s.usuario;
    m.actualizado = now;
    if (m.id) {
      const idx = movs.findIndex(x => x.id === m.id);
      if (idx < 0) throw new Error('Movimiento no encontrado');
      movs[idx] = Object.assign(movs[idx], m);
    } else {
      m.id = Utilities.getUuid();
      movs.push(m);
    }
    writeTable_('Movimientos', movs);

    const all = readTable_('Asignaciones').filter(a => a.movimiento_id !== m.id);
    asig.forEach(a => all.push({
      id: Utilities.getUuid(), movimiento_id: m.id, responsable: a.responsable,
      monto: round2_(a.monto), concepto: a.concepto || '',
    }));
    writeTable_('Asignaciones', all);
    return { id: m.id };
  },

  deleteMovimiento: function (req) {
    const id = req.id;
    writeTable_('Movimientos', readTable_('Movimientos').filter(m => m.id !== id));
    writeTable_('Asignaciones', readTable_('Asignaciones').filter(a => a.movimiento_id !== id));
    return true;
  },

  /** Alta masiva: items = [{movimiento:{...}, asignaciones:[...]}] */
  importMovimientos: function (req, s) {
    const now = new Date().toISOString();
    const movs = [], asig = [];
    (req.items || []).forEach(it => {
      const m = it.movimiento;
      validateMov_(m);
      m.id = Utilities.getUuid();
      m.monto = round2_(m.monto);
      m.creado_por = s.usuario;
      m.actualizado = now;
      movs.push(m);
      (it.asignaciones || []).forEach(a => {
        if (!a.responsable || !Number(a.monto)) return;
        asig.push({ id: Utilities.getUuid(), movimiento_id: m.id, responsable: a.responsable,
                    monto: round2_(a.monto), concepto: a.concepto || '' });
      });
    });
    appendRows_('Movimientos', movs);
    appendRows_('Asignaciones', asig);
    return { insertados: movs.length };
  },

  /** tipo: Tarjetas | Responsables | Categorias */
  saveCatalogo: function (req) {
    const tipo = req.tipo;
    if (['Tarjetas', 'Responsables', 'Categorias'].indexOf(tipo) < 0) throw new Error('Catálogo inválido');
    const item = req.item;
    if (!item.nombre) throw new Error('Nombre requerido');
    const rows = readTable_(tipo);
    if (item.id) {
      const idx = rows.findIndex(r => r.id === item.id);
      if (idx < 0) throw new Error('No encontrado');
      rows[idx] = Object.assign(rows[idx], item);
    } else {
      if (rows.some(r => String(r.nombre).toLowerCase() === String(item.nombre).toLowerCase())) {
        throw new Error('Ya existe: ' + item.nombre);
      }
      item.id = Utilities.getUuid().slice(0, 8);
      if (item.activo === undefined) item.activo = true;
      rows.push(item);
    }
    writeTable_(tipo, rows);
    return item;
  },

  /** periodo '*' = límite por defecto; tarjeta '*' = todas las tarjetas. monto vacío = eliminar. */
  saveLimite: function (req) {
    const periodo = String(req.periodo || '*');
    const tarjeta = String(req.tarjeta || '*');
    const rows = readTable_('Limites').filter(l => !(String(l.periodo) === periodo && String(l.tarjeta) === tarjeta));
    if (req.monto !== '' && req.monto !== null && req.monto !== undefined) {
      rows.push({ periodo: periodo, tarjeta: tarjeta, monto: round2_(req.monto) });
    }
    writeTable_('Limites', rows);
    return rows;
  },

  /** Total del estado de cuenta (para el cuadre). */
  saveEstado: function (req) {
    const rows = readTable_('EstadosCuenta')
      .filter(e => !(String(e.periodo) === String(req.periodo) && e.tarjeta === req.tarjeta));
    if (req.total !== '' && req.total !== null && req.total !== undefined) {
      rows.push({ periodo: String(req.periodo), tarjeta: req.tarjeta, total: round2_(req.total), notas: req.notas || '' });
    }
    writeTable_('EstadosCuenta', rows);
    return true;
  },

  listUsuarios: function () {
    return readTable_('Usuarios').map(u => ({ usuario: u.usuario, rol: u.rol, responsable: u.responsable, activo: u.activo }));
  },

  saveUsuario: function (req) {
    const u = req.user;
    const usuario = String(u.usuario || '').trim().toLowerCase();
    if (!usuario) throw new Error('Usuario requerido');
    if (['admin', 'responsable'].indexOf(u.rol) < 0) throw new Error('Rol inválido');
    if (u.rol === 'responsable' && !u.responsable) throw new Error('Asigna un responsable');
    const rows = readTable_('Usuarios');
    let row = rows.find(r => String(r.usuario).toLowerCase() === usuario);
    if (!row) {
      if (!u.password) throw new Error('Contraseña requerida para usuario nuevo');
      row = { usuario: usuario };
      rows.push(row);
    }
    row.rol = u.rol;
    row.responsable = u.responsable || '';
    row.activo = u.activo === undefined ? true : !!u.activo;
    if (u.password) {
      if (String(u.password).length < 6) throw new Error('La contraseña debe tener al menos 6 caracteres');
      row.salt = Utilities.getUuid();
      row.hash = hash_(u.password, row.salt);
    }
    writeTable_('Usuarios', rows);
    return true;
  },

  cambiarPassword: function (req, s) {
    if (String(req.nueva || '').length < 6) throw new Error('La contraseña debe tener al menos 6 caracteres');
    const rows = readTable_('Usuarios');
    const row = rows.find(r => r.usuario === s.usuario);
    if (!row || hash_(String(req.actual || ''), row.salt) !== row.hash) throw new Error('Contraseña actual incorrecta');
    row.salt = Utilities.getUuid();
    row.hash = hash_(req.nueva, row.salt);
    writeTable_('Usuarios', rows);
    return true;
  },
};

function validateMov_(m) {
  if (!m) throw new Error('Movimiento requerido');
  if (!/^\d{4}-\d{2}$/.test(String(m.periodo))) throw new Error('Periodo inválido (YYYY-MM)');
  if (!m.tarjeta) throw new Error('Tarjeta requerida');
  if (!m.descripcion) throw new Error('Descripción requerida');
  if (!(Number(m.monto) > 0)) throw new Error('El monto debe ser mayor a 0');
  if (['cargo', 'devolucion'].indexOf(m.tipo) < 0) throw new Error('Tipo inválido');
}

/* ============================ Setup ============================ */

function setup() {
  Object.keys(SCHEMA).forEach(sheet_);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const def = ss.getSheetByName('Hoja 1') || ss.getSheetByName('Sheet1') || ss.getSheetByName('Hoja1');
  if (def && ss.getSheets().length > 1) ss.deleteSheet(def);

  if (!readTable_('Categorias').length) {
    writeTable_('Categorias', ['Gasolina', 'Casa', 'Comida', 'Streaming', 'Entretenimiento', 'Servicios',
      'Telefonía', 'Salud', 'Ropa', 'Tecnología', 'Viajes', 'Gimnasio', 'Comisiones e intereses', 'Otros']
      .map(n => ({ id: Utilities.getUuid().slice(0, 8), nombre: n, activo: true })));
  }
  // Los responsables se capturan en la app (Configuración) o directamente en la hoja "Responsables".
  if (!readTable_('Tarjetas').length) {
    writeTable_('Tarjetas', [
      { id: Utilities.getUuid().slice(0, 8), nombre: 'Crédito', tipo: 'credito', activo: true },
      { id: Utilities.getUuid().slice(0, 8), nombre: 'Débito', tipo: 'debito', activo: true },
    ]);
  }
}

/**
 * Edita usuario/contraseña, ejecuta UNA vez y luego borra la contraseña de aquí.
 */
function crearAdminInicial() {
  const USUARIO = 'admin';
  const PASSWORD = 'CAMBIA_ESTA_CONTRASEÑA';
  if (PASSWORD.indexOf('CAMBIA') === 0) throw new Error('Edita la contraseña antes de ejecutar');
  HANDLERS.saveUsuario({ user: { usuario: USUARIO, password: PASSWORD, rol: 'admin', responsable: '', activo: true } });
}
