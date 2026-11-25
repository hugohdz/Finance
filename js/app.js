/* Finance – Control de gastos de tarjetas (frontend estático para GitHub Pages) */
(function () {
  'use strict';

  const CFG = window.FINANCE_CONFIG || {};
  const PARAMS = new URLSearchParams(location.search);
  const DEMO = PARAMS.has('demo');
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  };
  // La URL del backend NO va en el repositorio: se toma de js/config.local.js (local),
  // o se captura una vez en la pantalla de acceso y se guarda en este navegador.
  const validApi = u => /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(String(u || '').trim());
  function apiUrl() { return (CFG.API_URL || '').trim() || store.get('finance_api') || ''; }
  const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto',
                 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

  const S = {
    session: null,
    cat: { tarjetas: [], responsables: [], categorias: [], limites: [], periodos: [] },
    periodo: null,
    tarjeta: '*',
    data: { movimientos: [], asignaciones: [], estados: [] },
    tab: null,
    movFilter: { q: '', cat: '', resp: '', pendientes: false },
    respFocus: '',
    misCat: '',
    fromResumen: false,
    importRows: null,
    importMeta: null,
  };

  /* ============================ Utilidades ============================ */

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = s => String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const r2 = n => Math.round(Number(n || 0) * 100) / 100;
  const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
  const fmt = n => money.format(r2(n));
  const net = m => (m.tipo === 'devolucion' ? -1 : 1) * Number(m.monto);
  const isActive = x => x.activo === true || String(x.activo).toLowerCase() === 'true' || x.activo === '';
  const isAdmin = () => S.session && S.session.rol === 'admin';

  function periodLabel(p) {
    if (!p || p === '*') return 'Todos los periodos';
    const [y, m] = String(p).split('-');
    return MESES[Number(m) - 1] + ' ' + y;
  }
  function shiftPeriod(p, delta) {
    let [y, m] = p.split('-').map(Number);
    m += delta;
    while (m < 1) { m += 12; y--; }
    while (m > 12) { m -= 12; y++; }
    return y + '-' + String(m).padStart(2, '0');
  }
  function currentPeriod() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }
  function fmtDate(s) {
    if (!s) return '';
    const p = String(s).slice(0, 10).split('-');
    return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : s;
  }
  function parseMSI(desc) {
    const m = /\((\d{1,3}):(\d{1,3})\)/.exec(desc || '');
    return m ? { actual: Number(m[1]), total: Number(m[2]) } : null;
  }

  function toast(msg, ms) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('show'), ms || 2600);
  }
  // Loader con contador (varias peticiones a la vez) y retraso corto para evitar parpadeos
  let loadingN = 0, loadingT = null;
  function loading(on, inmediato) {
    loadingN = Math.max(0, loadingN + (on ? 1 : -1));
    clearTimeout(loadingT);
    const show = () => { placeLoader(); $('#loading').hidden = false; };
    if (loadingN > 0) { if (inmediato) show(); else loadingT = setTimeout(show, 120); }
    else $('#loading').hidden = true;
  }
  // Un <dialog> modal se pinta por encima de todo: si hay uno abierto, el loader vive dentro de él
  function placeLoader() {
    const el = $('#loading'), d = $('#modal');
    const host = d && d.open ? d : document.body;
    if (el.parentNode !== host) host.appendChild(el);
  }
  /** Ejecuta el guardado de un formulario una sola vez: bloquea botones y muestra el loader hasta terminar. */
  async function guardando(form, fn) {
    if (form.dataset.busy) return;
    form.dataset.busy = '1';
    const btns = $$('button, input[type=submit]', form);
    const prev = btns.map(b => b.disabled);
    btns.forEach(b => { b.disabled = true; });
    loading(true, true);
    try { await fn(); }
    finally {
      loading(false);
      delete form.dataset.busy;
      btns.forEach((b, i) => { b.disabled = prev[i]; });
    }
  }

  /* ============================ API ============================ */

  async function api(action, payload, opts) {
    const body = Object.assign({ action: action, token: S.session && S.session.token }, payload || {});
    if (!(opts && opts.silent)) loading(true);
    try {
      let res;
      if (DEMO) {
        res = await window.FinanceMock.call(body);
      } else {
        const r = await fetch(apiUrl(), {
          method: 'POST',
          // text/plain evita el preflight CORS con Apps Script
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(body),
        });
        res = await r.json();
      }
      if (!res.ok) {
        if (res.error === 'SESSION') { logout(true); throw new Error('Tu sesión expiró, vuelve a entrar.'); }
        throw new Error(res.error || 'Error');
      }
      return res.data;
    } finally {
      if (!(opts && opts.silent)) loading(false);
    }
  }

  /* ============================ Datos derivados ============================ */

  function asigOf(movId) { return S.data.asignaciones.filter(a => a.movimiento_id === movId); }
  function asignado(m) { return r2(asigOf(m.id).reduce((s, a) => s + Number(a.monto), 0)); }
  function pendiente(m) { return r2(Number(m.monto) - asignado(m)); }
  function tarjetaTipo(nombre) {
    const t = S.cat.tarjetas.find(x => x.nombre === nombre);
    if (!t) return '';
    return /^d[eé]bito$/i.test(String(t.tipo).trim()) ? 'debito' : /^cr[eé]dito$/i.test(String(t.tipo).trim()) ? 'credito' : t.tipo;
  }
  function movsFiltradas() {
    return S.data.movimientos
      .filter(m => S.tarjeta === '*' || m.tarjeta === S.tarjeta)
      .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
  }
  function limiteActual() { return limiteFor(S.tarjeta); }
  function sumBy(items, keyFn, valFn) {
    const out = {};
    items.forEach(i => { const k = keyFn(i) || '(Sin asignar)'; out[k] = r2((out[k] || 0) + valFn(i)); });
    return out;
  }
  function totalesPorResponsable(movs) {
    const ids = {};
    movs.forEach(m => { ids[m.id] = m; });
    const out = {};
    S.data.asignaciones.forEach(a => {
      const m = ids[a.movimiento_id];
      if (!m) return;
      const sign = m.tipo === 'devolucion' ? -1 : 1;
      out[a.responsable] = r2((out[a.responsable] || 0) + sign * Number(a.monto));
    });
    return out;
  }
  function limiteStatus(total, limite) {
    if (!limite) return { cls: 'neutral', text: 'Sin límite definido', pct: 0 };
    const pct = total / limite * 100;
    if (pct > 100) return { cls: 'bad', text: '✕ Límite excedido por ' + fmt(total - limite), pct: pct };
    if (pct >= 80) return { cls: 'warn', text: '! Cerca del límite · quedan ' + fmt(limite - total), pct: pct };
    return { cls: 'good', text: '✓ Dentro del límite · quedan ' + fmt(limite - total), pct: pct };
  }

  /* ============================ Sesión ============================ */

  function saveSession() {
    try { localStorage.setItem('finance_session', JSON.stringify(S.session)); } catch (e) { /* ignore */ }
  }
  function loadSession() {
    try { return JSON.parse(localStorage.getItem('finance_session') || 'null'); } catch (e) { return null; }
  }
  function logout(silent) {
    if (!silent && S.session) api('logout', {}, { silent: true }).catch(() => {});
    S.session = null;
    try { localStorage.removeItem('finance_session'); } catch (e) { /* ignore */ }
    $('#app-view').hidden = true;
    $('#login-view').hidden = false;
  }

  async function onLogin(ev) {
    ev.preventDefault();
    const f = ev.target;
    $('#login-error').textContent = '';
    if (!DEMO && !(CFG.API_URL || '').trim()) {
      const u = f.api.value.trim();
      if (!validApi(u)) { $('#login-error').textContent = 'Captura la URL del servidor (https://script.google.com/macros/s/…/exec)'; $('#api-field').hidden = false; return; }
      store.set('finance_api', u);
    }
    try {
      S.session = await api('login', { usuario: f.usuario.value, password: f.password.value });
      saveSession();
      f.password.value = '';
      await startApp();
    } catch (e) {
      $('#login-error').textContent = e.message;
    }
  }

  async function startApp() {
    const boot = await api('bootstrap');
    S.cat = boot;
    S.cat.devolventes = boot.devolventes || [];
    S.session = Object.assign(S.session, boot.session);
    $('#login-view').hidden = true;
    $('#app-view').hidden = false;
    $('#user-name').textContent = S.session.usuario + (isAdmin() ? ' · admin' : ' · ' + S.session.responsable);
    $('#user-avatar').textContent = String(S.session.responsable || S.session.usuario).charAt(0).toUpperCase();
    if (!S.periodo) S.periodo = boot.periodos[0] || currentPeriod();
    renderPeriodoFilter();
    renderTarjetaFilter();
    renderTabs();
    await loadPeriodo();
  }

  /** Dropdown de periodo: meses con movimientos cargados (+ el actual y el seleccionado). */
  function renderPeriodoFilter() {
    const sel = $('#f-periodo');
    const cargados = S.cat.periodos || [];
    const lista = Array.from(new Set(cargados.concat([currentPeriod(), S.periodo]))).filter(Boolean).sort().reverse();
    const porAnio = {};
    lista.forEach(p => { (porAnio[p.slice(0, 4)] = porAnio[p.slice(0, 4)] || []).push(p); });
    sel.innerHTML = Object.keys(porAnio).sort().reverse().map(y => `<optgroup label="${y}">${porAnio[y].map(p =>
      `<option value="${p}">${periodLabel(p)}${cargados.indexOf(p) < 0 ? ' · sin movimientos' : ''}</option>`).join('')}</optgroup>`).join('')
      + '<option value="__otro">Otro mes…</option>';
    sel.value = S.periodo;
  }

  function renderTarjetaFilter() {
    const sel = $('#f-tarjeta');
    sel.innerHTML = '<option value="*">Todas</option>' + S.cat.tarjetas.filter(isActive)
      .map(t => `<option value="${esc(t.nombre)}">${esc(t.nombre)} (${t.tipo === 'credito' ? 'crédito' : 'débito'})</option>`).join('');
    sel.value = S.tarjeta;
    if (sel.value !== S.tarjeta) { S.tarjeta = '*'; sel.value = '*'; }
  }

  async function loadPeriodo() {
    S.data = await api('getPeriodo', { periodo: S.periodo });
    injectDevolventes();
    render();
  }

  async function refreshCatalogs() {
    const boot = await api('bootstrap', {}, { silent: true });
    S.cat = boot;
    S.cat.devolventes = boot.devolventes || [];
    renderPeriodoFilter();
    renderTarjetaFilter();
  }

  /* ============================ Tabs ============================ */

  const ICONS = {
    resumen: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
    movimientos: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
    responsables: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    cuadre: '<path d="M12 3v18"/><path d="M7 21h10"/><path d="M3 7h18"/><path d="m6 7-3 8a3 3 0 0 0 6 0Z"/><path d="m18 7-3 8a3 3 0 0 0 6 0Z"/>',
    importar: '<path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M5 21h14"/>',
    config: '<path d="M4 6h10"/><path d="M18 6h2"/><circle cx="16" cy="6" r="2"/><path d="M4 12h4"/><path d="M12 12h8"/><circle cx="10" cy="12" r="2"/><path d="M4 18h12"/><path d="M20 18h0"/><circle cx="18" cy="18" r="2"/>',
    mis: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
  };
  const icon = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k] || ''}</svg>`;

  const TABS_ADMIN = [
    ['resumen', 'Resumen'], ['movimientos', 'Movimientos'], ['responsables', 'Por responsable'],
    ['cuadre', 'Cuadre'], ['importar', 'Importar Excel'], ['config', 'Configuración'],
  ];
  const TABS_RESP = [['mis', 'Mis cargos'], ['config', 'Mi cuenta']];

  /** Conteo de la barra lateral: [texto, clase] */
  function tabCount(key) {
    const movs = movsFiltradas();
    const alerts = S.alerts || [];
    if (key === 'resumen') {
      const lim = alerts.find(a => a.tipo === 'limite' && a.level === 'bad');
      return lim ? ['!', 'bad'] : ['', ''];
    }
    if (key === 'movimientos') {
      const pend = movs.filter(m => pendiente(m) !== 0).length;
      return [movs.length || '', pend ? 'bad' : ''];
    }
    if (key === 'mis') return [movs.length || '', ''];
    if (key === 'responsables') return [Object.keys(totalesPorResponsable(movs)).length || '', ''];
    if (key === 'cuadre') {
      const bad = alerts.filter(a => a.tipo === 'cuadre' && a.level === 'bad').length;
      return bad ? ['!' + bad, 'bad'] : (movs.length ? ['✓', 'good'] : ['', '']);
    }
    return ['', ''];
  }

  function renderTabs() {
    const tabs = isAdmin() ? TABS_ADMIN : TABS_RESP;
    if (!S.tab || !tabs.some(t => t[0] === S.tab)) S.tab = tabs[0][0];
    $('#tabs').innerHTML = tabs.map(t =>
      `<button data-tab="${t[0]}" title="${t[1]}" ${t[0] === S.tab ? 'aria-current="page"' : ''}>${icon(t[0])}<span class="label">${t[1]}</span>${(c => `<span class="count ${c[1]}">${c[0]}</span>`)(tabCount(t[0]))}</button>`).join('');
    const movs = movsFiltradas();
    const total = isAdmin() ? r2(movs.reduce((s, m) => s + net(m), 0)) : (totalesPorResponsable(movs)[S.session.responsable] || 0);
    const st = isAdmin() ? limiteStatus(total, limiteActual()) : { cls: '' };
    $('#sidebar-foot').innerHTML = `<span>${periodoTitulo()}</span><b class="${st.cls === 'bad' ? 'diff-bad' : ''}">${fmt(total)}</b><span>${isAdmin() ? (st.cls === 'bad' ? 'gasto neto · límite rebasado' : 'gasto neto') : 'a pagar'}</span>`;
  }

  function render() {
    const banner = isAdmin() && S.tab !== 'config' && S.tab !== 'importar' ? alertBanner() : '';
    if (!banner) S.alerts = revisarAlertas();
    renderTabs();
    const main = $('#main');
    const fn = VIEWS[S.tab];
    main.innerHTML = '';
    fn(main);
    if (banner) {
      const head = main.querySelector('.page-head');
      const box = document.createElement('div');
      box.innerHTML = banner;
      head ? head.after(box.firstElementChild) : main.prepend(box.firstElementChild);
    }
  }

  function go(tab) {
    S.tab = tab;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function pageHead(eyebrow, title, meta, extra) {
    return `<div class="page-head"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1></div>
      <div class="crumbs">${extra || ''}${meta ? `<span class="meta">${meta}</span>` : ''}</div></div>`;
  }
  function periodoTitulo() { return periodLabel(S.periodo) + (S.tarjeta !== '*' ? ' · ' + esc(S.tarjeta) : ''); }

  /* ============================ Fecha de corte ============================ */

  function tarjetaInfo(nombre) { return S.cat.tarjetas.find(t => t.nombre === nombre) || {}; }
  function diaCorte(nombre) {
    const t = tarjetaInfo(nombre);
    return t.tipo === 'credito' && Number(t.dia_corte) ? Number(t.dia_corte) : null;
  }
  /** Mes de corte al que pertenece una fecha (después del día de corte pasa al mes siguiente). */
  function periodoDeCorte(fecha, dia) {
    const [y, m, d] = String(fecha).slice(0, 10).split('-').map(Number);
    const p = y + '-' + String(m).padStart(2, '0');
    return d > dia ? shiftPeriod(p, 1) : p;
  }
  function fechaCorte(periodo, dia) {
    const [y, m] = periodo.split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    return periodo + '-' + String(Math.min(dia, last)).padStart(2, '0');
  }
  /** Rango de fechas del periodo de una tarjeta con corte: [inicio, fin]. */
  function rangoCorte(periodo, dia) {
    const fin = fechaCorte(periodo, dia);
    const prev = fechaCorte(shiftPeriod(periodo, -1), dia);
    const d = new Date(prev + 'T12:00:00'); d.setDate(d.getDate() + 1);
    return [d.toISOString().slice(0, 10), fin];
  }
  /** ¿El periodo de este cargo lo determina su fecha? (crédito con corte, cargo, no es mensualidad MSI > 1) */
  function periodoPorFecha(m) {
    return m.tipo === 'cargo' && diaCorte(m.tarjeta) && !(Number(m.msi_actual) > 1);
  }
  function hoyISO() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function corteMeta(tarjeta) {
    const dia = diaCorte(tarjeta);
    if (!dia) return '';
    const [ini, fin] = rangoCorte(S.periodo, dia);
    const cerrado = hoyISO() > fin;
    return `<span class="tag" title="Cargos del ${fmtDate(ini)} al ${fmtDate(fin)}">Corte ${fmtDate(fin)}</span>` +
      (cerrado ? ' <span class="tag info" title="Después del corte solo se registran devoluciones en este periodo">Cerrado · solo devoluciones</span>' : '');
  }

  /* ============================ Devolventes diferidos ============================ */

  function monthsBetween(a, b) {
    const [y1, m1] = String(a).split('-').map(Number);
    const [y2, m2] = String(b).split('-').map(Number);
    return (y2 - y1) * 12 + (m2 - m1);
  }
  /** Mensualidad i (0-based) del calendario del devolvente; la última ajusta centavos para cerrar exacto. */
  function devCuota(d, i) {
    const meses = Number(d.meses), total = Number(d.monto_total), mensual = Number(d.monto_mensual);
    if (i < 0 || i >= meses) return 0;
    const previo = r2(mensual * i);
    if (previo >= total) return 0;
    let monto = Math.min(mensual, r2(total - previo));
    if (i === meses - 1) {
      const resto = r2(total - previo);
      if (Math.abs(resto - mensual) < 1) monto = resto;
    }
    return r2(monto);
  }
  function devLlegada(d) { return d.periodo_llegada && monthsBetween(d.periodo_inicio, d.periodo_llegada) > 0 ? d.periodo_llegada : d.periodo_inicio; }
  /** Monto que un devolvente aplica en un periodo (o null). En el mes de llegada se aplican también los meses atrasados. */
  function devAplicado(d, periodo) {
    if (!isActive(d)) return null;
    const meses = Number(d.meses);
    const k = monthsBetween(d.periodo_inicio, periodo);
    const kL = Math.min(monthsBetween(d.periodo_inicio, devLlegada(d)), meses - 1);
    if (k < kL || k >= meses) return null;
    if (k === kL && kL > 0) {
      let monto = 0;
      for (let i = 0; i <= kL; i++) monto += devCuota(d, i);
      return monto ? { k: '1–' + (kL + 1), monto: r2(monto), atrasados: kL } : null;
    }
    const monto = devCuota(d, k);
    return monto ? { k: String(k + 1), monto: monto } : null;
  }
  function devSaldo(d, periodo) {
    let aplicado = 0;
    const n = Math.min(Number(d.meses), Math.max(0, monthsBetween(d.periodo_inicio, periodo) + 1));
    for (let i = 0; i < n; i++) {
      const a = devAplicado(d, shiftPeriod(d.periodo_inicio, i));
      if (a) aplicado += a.monto;
    }
    return { aplicado: r2(aplicado), saldo: r2(Number(d.monto_total) - aplicado) };
  }
  function devFin(d) { return shiftPeriod(d.periodo_inicio, Number(d.meses) - 1); }

  /** Agrega al periodo cargado los ajustes de devolventes como movimientos virtuales. */
  function injectDevolventes() {
    S.data.movimientos = S.data.movimientos.filter(m => !m.virtual);
    S.data.asignaciones = S.data.asignaciones.filter(a => !a.virtual);
    (S.cat.devolventes || []).forEach(d => {
      const a = devAplicado(d, S.periodo);
      if (!a) return;
      const id = 'dv_' + d.id;
      const sal = devSaldo(d, S.periodo);
      S.data.movimientos.push({
        id: id, virtual: true, devolvente_id: d.id, periodo: S.periodo, tarjeta: d.tarjeta,
        fecha: fechaCorte(S.periodo, diaCorte(d.tarjeta) || 28), tipo: 'devolucion', categoria: d.categoria || '',
        descripcion: 'Devolvente aplicado · ' + d.descripcion + ' (' + a.k + '/' + d.meses + ')', monto: a.monto,
        notas: 'Saldo restante ' + fmt(sal.saldo), msi_actual: '', msi_total: '',
      });
      S.data.asignaciones.push({ id: id, virtual: true, movimiento_id: id, responsable: d.responsable, monto: a.monto,
        concepto: (/^devolvente/i.test(d.descripcion) ? '' : 'Devolvente ') + d.descripcion + ' (' + a.k + '/' + d.meses + ')' });
    });
  }

  function devolventesTable(tarjeta) {
    const list = (S.cat.devolventes || []).filter(d => d.tarjeta === tarjeta);
    return `<div class="card-head" style="margin-top:18px;padding-top:14px;border-top:1px solid var(--line)">
        <h3>Devolventes · los paga el banco (saldo a favor aplicado mes con mes)</h3>
        <button class="btn small" data-act="dev-new" data-tarjeta="${esc(tarjeta)}">+ Devolvente</button></div>
      ${list.length ? `<table><thead><tr><th>Descripción</th><th>Se descuenta a</th><th>Calendario</th><th class="num">Total</th><th class="num">Este mes</th><th class="num">Saldo</th><th></th></tr></thead><tbody>
      ${list.map(d => {
        const a = devAplicado(d, S.periodo);
        const sal = devSaldo(d, S.periodo);
        return `<tr><td class="desc">${esc(d.descripcion)}<small>${fmt(d.monto_mensual)} mensual${d.notas ? ' · ' + esc(d.notas) : ''}</small></td>
          <td>${esc(d.responsable)}</td>
          <td>${periodLabel(d.periodo_inicio)} – ${periodLabel(devFin(d))}${devLlegada(d) !== d.periodo_inicio ? `<small class="muted" style="display:block">llegó en ${periodLabel(devLlegada(d))}</small>` : ''}</td>
          <td class="num">${fmt(d.monto_total)}</td>
          <td class="num neg">${a ? '−' + fmt(a.monto) + ` <span class="muted">(${a.k}/${d.meses})</span>` : '<span class="muted">—</span>'}</td>
          <td class="num">${fmt(sal.saldo)}</td>
          <td class="num"><button class="btn small ghost" data-act="dev-edit" data-id="${d.id}">Editar</button></td></tr>`;
      }).join('')}</tbody></table>`
      : '<p class="muted" style="font-size:12px">Registra aquí devoluciones que se reparten en varios meses (p. ej. una devolución sobre una compra a MSI). Cada mes se descuenta automáticamente al responsable y al cuadre.</p>'}`;
  }

  function devolventeModal(d, tarjetaDefault) {
    const isNew = !d;
    d = d ? Object.assign({}, d) : { tarjeta: tarjetaDefault || (S.cat.tarjetas.find(t => t.tipo === 'credito') || {}).nombre, periodo_inicio: S.periodo, meses: '', monto_total: '', monto_mensual: '', responsable: '', categoria: '', descripcion: '', notas: '' };
    const msiMovs = S.data.movimientos.filter(m => !m.virtual && m.tipo === 'cargo' && Number(m.msi_total) > 1);
    openModal(`<div><div class="eyebrow">Saldo a favor diferido</div><h2 style="margin-top:6px">${isNew ? 'Nuevo' : 'Editar'} devolvente</h2></div>
      <p class="muted" style="font-size:12px">Una devolución recibida en una sola exhibición que se descuenta mes con mes a quien paga la compra. No es un movimiento del estado de cuenta: en el cuadre se resta para obtener lo que aportan los responsables.</p>
      <form id="form-dev" class="form-grid">
        ${isNew && msiMovs.length ? `<label class="span-2">Vincular a una compra a MSI de ${periodLabel(S.periodo)} (opcional)
          <select name="vinculo"><option value="">—</option>${msiMovs.map(m => `<option value="${m.id}">${esc(m.descripcion)} · ${fmt(m.monto)} · ${m.msi_actual}/${m.msi_total}</option>`).join('')}</select></label>` : ''}
        <label class="span-2">Descripción <input name="descripcion" required value="${esc(d.descripcion)}" placeholder="Ej. Devolución OLED TV"></label>
        <label>Tarjeta <select name="tarjeta">${S.cat.tarjetas.map(t => `<option ${t.nombre === d.tarjeta ? 'selected' : ''}>${esc(t.nombre)}</option>`).join('')}</select></label>
        <label>Responsable (a quien se le descuenta) <select name="responsable" required><option value="">—</option>${S.cat.responsables.map(r => `<option ${r.nombre === d.responsable ? 'selected' : ''}>${esc(r.nombre)}</option>`).join('')}</select></label>
        <label>Categoría <select name="categoria"><option value="">—</option>${S.cat.categorias.map(c => `<option ${c.nombre === d.categoria ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('')}</select></label>
        <label>Monto total del devolvente <input type="number" step="0.01" min="0.01" name="monto_total" required value="${esc(d.monto_total)}"></label>
        <label>Primer mes del calendario (mensualidad 1) <input type="month" name="periodo_inicio" required value="${esc(d.periodo_inicio)}"></label>
        <label>Mes en que llegó el devolvente <input type="month" name="periodo_llegada" value="${esc(d.periodo_llegada || d.periodo_inicio)}"><span class="muted">Si llegó después, ese mes se aplican de golpe los meses atrasados</span></label>
        <label>Número de meses <input type="number" min="1" step="1" name="meses" required value="${esc(d.meses)}"></label>
        <label>Descuento mensual <input type="number" step="0.01" min="0.01" name="monto_mensual" required value="${esc(d.monto_mensual)}"></label>
        <label class="span-2">Notas <input name="notas" value="${esc(d.notas)}"></label>
        <p class="span-2 status-line" id="dev-preview"></p>
        <label class="inline span-2"><input type="checkbox" name="activo" ${isNew || isActive(d) ? 'checked' : ''}> Activo</label>
        <div class="actions span-2">
          ${isNew ? '' : '<button type="button" class="btn danger" id="dev-del">Eliminar</button>'}
          <button type="button" class="btn" data-act="close">Cancelar</button><button class="btn primary">Guardar</button></div>
      </form>`);
    const f = $('#form-dev');
    let mensualManual = !isNew;
    const preview = () => {
      const tot = r2(f.monto_total.value), n = Number(f.meses.value), men = r2(f.monto_mensual.value);
      if (!tot || !n || !men || !f.periodo_inicio.value) { $('#dev-preview').innerHTML = ''; return; }
      const fake = { monto_total: tot, meses: n, monto_mensual: men, periodo_inicio: f.periodo_inicio.value, periodo_llegada: f.periodo_llegada.value, activo: true };
      const sal = devSaldo(fake, devFin(fake));
      const first = devAplicado(fake, devLlegada(fake));
      $('#dev-preview').innerHTML = `<span class="badge ${Math.abs(sal.saldo) < 0.01 ? 'good' : 'warn'}">${first && first.atrasados ? `${periodLabel(devLlegada(fake))}: ${fmt(first.monto)} (mensualidades ${first.k}) · después ` : ''}${fmt(men)} por mes hasta ${periodLabel(devFin(fake))} · total ${fmt(sal.aplicado)}${Math.abs(sal.saldo) >= 0.01 ? ' · quedan ' + fmt(sal.saldo) + ' sin aplicar' : ' ✓'}</span>`;
    };
    const autoMensual = () => { if (!mensualManual && Number(f.meses.value) && Number(f.monto_total.value)) f.monto_mensual.value = r2(Number(f.monto_total.value) / Number(f.meses.value)); preview(); };
    f.monto_total.oninput = autoMensual; f.meses.oninput = autoMensual;
    f.monto_mensual.oninput = () => { mensualManual = true; preview(); };
    f.periodo_inicio.oninput = preview;
    f.periodo_llegada.oninput = preview;
    if (f.vinculo) f.vinculo.onchange = () => {
      const m = S.data.movimientos.find(x => x.id === f.vinculo.value);
      if (!m) return;
      const a = asigOf(m.id).sort((x, y) => y.monto - x.monto)[0];
      f.descripcion.value = 'Devolvente ' + m.descripcion.replace(/\(\d{1,3}:\d{1,3}\)/, '').trim();
      f.tarjeta.value = m.tarjeta;
      if (a) f.responsable.value = a.responsable;
      if (m.categoria) f.categoria.value = m.categoria;
      // calendario completo de la compra: mensualidad 1 = periodo actual − (actual − 1); llegó este mes
      f.periodo_inicio.value = shiftPeriod(S.periodo, -(Number(m.msi_actual) - 1));
      f.periodo_llegada.value = S.periodo;
      f.meses.value = Number(m.msi_total);
      autoMensual();
    };
    preview();
    if (!isNew) $('#dev-del').onclick = async () => {
      if (!confirm('¿Eliminar el devolvente "' + d.descripcion + '"? Se quitarán sus ajustes de todos los periodos.')) return;
      try { await api('deleteDevolvente', { id: d.id }); closeModal(); await refreshCatalogs(); await loadPeriodo(); toast('Devolvente eliminado'); }
      catch (e) { toast(e.message); }
    };
    f.addEventListener('submit', async ev => {
      ev.preventDefault();
      const dev = { id: d.id, descripcion: f.descripcion.value.trim(), tarjeta: f.tarjeta.value, responsable: f.responsable.value,
        categoria: f.categoria.value, monto_total: r2(f.monto_total.value), periodo_inicio: f.periodo_inicio.value,
        periodo_llegada: f.periodo_llegada.value && f.periodo_llegada.value > f.periodo_inicio.value ? f.periodo_llegada.value : '',
        meses: Number(f.meses.value), monto_mensual: r2(f.monto_mensual.value), notas: f.notas.value, activo: f.activo.checked };
      guardando(f, async () => {
        try { await api('saveDevolvente', { devolvente: dev }); closeModal(); await refreshCatalogs(); await loadPeriodo(); toast('Devolvente guardado'); }
        catch (e) { toast(e.message); }
      });
    });
  }

  /* ============================ Alertas ============================ */

  /** Límite aplicable a una tarjeta ('*' = todas) en el periodo cargado. */
  function limiteFor(tarjeta) {
    const L = S.cat.limites;
    const find = (p, c) => L.find(l => String(l.periodo) === p && String(l.tarjeta) === c && !l.responsable);
    const hit = find(S.periodo, tarjeta) || find('*', tarjeta);
    return hit ? Number(hit.monto) : null;
  }
  /** Límite mensual de un responsable (suma de todas sus tarjetas). */
  function limiteResp(resp) {
    const L = S.cat.limites;
    const find = p => L.find(l => String(l.periodo) === p && String(l.responsable || '') === resp);
    const hit = find(S.periodo) || find('*');
    return hit ? Number(hit.monto) : null;
  }
  /** Totales de un responsable en el periodo, en todas las tarjetas: crédito, débito, devoluciones. */
  function respTotales(n) {
    const ids = {};
    S.data.movimientos.forEach(m => { ids[m.id] = m; });
    const t = { credito: 0, debito: 0, devs: 0, nCred: 0, nDeb: 0, devItems: [] };
    S.data.asignaciones.filter(a => a.responsable === n && ids[a.movimiento_id]).forEach(a => {
      const m = ids[a.movimiento_id], v = Number(a.monto);
      if (m.tipo === 'devolucion') { t.devs += v; t.devItems.push({ a: a, m: m }); }
      else if (tarjetaTipo(m.tarjeta) === 'debito') { t.debito += v; t.nDeb++; }
      else { t.credito += v; t.nCred++; }
    });
    t.credito = r2(t.credito); t.debito = r2(t.debito); t.devs = r2(t.devs);
    t.total = r2(t.credito + t.debito - t.devs);
    return t;
  }

  /** Revisa límite, gastos sin asignar y cuadre de TODO el periodo cargado. */
  function revisarAlertas() {
    if (!isAdmin()) return [];
    const out = [];
    const all = S.data.movimientos;
    const neto = movs => r2(movs.reduce((s, m) => s + net(m), 0));

    [['*', all]].concat(S.cat.tarjetas.map(t => [t.nombre, all.filter(m => m.tarjeta === t.nombre)])).forEach(([t, movs]) => {
      const lim = limiteFor(t);
      if (!lim) return;
      const total = neto(movs);
      const st = limiteStatus(total, lim);
      const nombre = t === '*' ? 'el límite mensual' : 'el límite de ' + esc(t);
      if (st.cls === 'bad') out.push({ level: 'bad', tipo: 'limite', act: 'alert-go', tab: 'resumen', tarjeta: t,
        text: `Se rebasó ${nombre} (${fmt(lim)}) por <b>${fmt(total - lim)}</b>. Gasto actual ${fmt(total)}.` });
      else if (st.cls === 'warn') out.push({ level: 'warn', tipo: 'limite', act: 'alert-go', tab: 'resumen', tarjeta: t,
        text: `Vas al ${st.pct.toFixed(0)}% ${t === '*' ? 'del límite mensual' : 'del límite de ' + esc(t)}: quedan <b>${fmt(lim - total)}</b>.` });
    });

    S.cat.responsables.forEach(r => {
      const lim = limiteResp(r.nombre);
      if (!lim) return;
      const total = respTotales(r.nombre).total;
      if (total > lim) out.push({ level: 'bad', tipo: 'limite-resp', act: 'alert-go', tab: 'responsables', resp: r.nombre,
        text: `${esc(r.nombre)} rebasó su límite (${fmt(lim)}) por <b>${fmt(total - lim)}</b>. Gastó ${fmt(total)}.` });
    });

    S.cat.tarjetas.forEach(t => {
      const movs = all.filter(m => m.tarjeta === t.nombre);
      if (!movs.length) return;
      const pend = movs.filter(m => pendiente(m) !== 0);
      const falta = r2(pend.reduce((s, m) => s + pendiente(m), 0));
      if (t.tipo === 'credito') {
        const c = cuadreData(t.nombre);
        if (pend.length) out.push({ level: 'bad', tipo: 'cuadre', act: 'alert-go', tab: 'cuadre', tarjeta: t.nombre,
          text: `Cuadre de ${esc(t.nombre)} incorrecto: faltan <b>${fmt(falta)}</b> por asignar a responsables (${pend.length} movimiento${pend.length > 1 ? 's' : ''}).` });
        if (c.difEstado !== null && Math.abs(c.difEstado) >= 0.01) {
          const porDev = c.devs && Math.abs(c.difEstado - c.devs) < 0.01;
          out.push({ level: porDev ? 'warn' : 'bad', tipo: 'cuadre', act: 'alert-go', tab: 'cuadre', tarjeta: t.nombre,
            text: porDev ? `Cuadre de ${esc(t.nombre)}: la diferencia de ${fmt(c.difEstado)} con el estado de cuenta corresponde a devoluciones aún no reflejadas.`
                         : `Cuadre de ${esc(t.nombre)} incorrecto: el estado de cuenta difiere de los movimientos por <b>${fmt(c.difEstado)}</b>.` });
        }
      } else if (pend.length) {
        out.push({ level: 'bad', tipo: 'pendiente', act: 'alert-pend', tarjeta: t.nombre,
          text: `${esc(t.nombre)}: ${pend.length} gasto${pend.length > 1 ? 's' : ''} sin asignar por <b>${fmt(falta)}</b>.` });
      }
    });
    return out;
  }

  const ALERT_ICON = { bad: '✕', warn: '!' };

  function alertList(alerts, withButtons) {
    return `<div class="alert-list" role="alert">${alerts.map((a, i) => `<div class="alert-item ${a.level}">
      <span class="alert-icon" aria-hidden="true">${ALERT_ICON[a.level]}</span><span class="alert-text">${a.text}</span>
      ${withButtons ? `<button type="button" class="btn small" data-act="${a.act}" data-i="${i}">Ver ›</button>` : ''}</div>`).join('')}</div>`;
  }

  /** Franja de alertas que se muestra arriba de las vistas del administrador. */
  function alertBanner() {
    const alerts = revisarAlertas();
    S.alerts = alerts;
    return alerts.length ? alertList(alerts, true) : '';
  }

  function goAlert(a) {
    if (!a) return;
    closeModal();
    if (a.act === 'alert-pend') {
      S.tarjeta = a.tarjeta; $('#f-tarjeta').value = a.tarjeta;
      S.movFilter = { q: '', cat: '', resp: '', pendientes: true };
      go('movimientos');
      return;
    }
    if (a.tarjeta && a.tarjeta !== '*' && a.tab === 'cuadre') { S.tarjeta = a.tarjeta; $('#f-tarjeta').value = a.tarjeta; }
    if (a.tipo === 'limite') { S.tarjeta = a.tarjeta; $('#f-tarjeta').value = a.tarjeta; }
    if (a.tipo === 'limite-resp') { S.respFocus = a.resp; S.tarjeta = '*'; $('#f-tarjeta').value = '*'; }
    go(a.tab);
  }

  /** Aviso después de guardar / importar gastos. */
  function avisoTrasGuardar(origen) {
    const alerts = revisarAlertas();
    S.alerts = alerts;
    if (!alerts.length) return;
    const limite = alerts.find(a => a.tipo === 'limite' && a.level === 'bad');
    const titulo = limite ? 'Se rebasó el límite de gasto' : alerts.some(a => a.level === 'bad') ? 'Revisa estos pendientes' : 'Atención';
    openModal(`<div><div class="eyebrow" style="color:var(--${alerts.some(a => a.level === 'bad') ? 'bad' : 'warn'})">${origen} · ${periodLabel(S.periodo)}</div>
      <h2 style="margin-top:6px">${titulo}</h2></div>
      ${alertList(alerts, true)}
      <div class="actions"><button class="btn primary" data-act="close">Entendido</button></div>`);
  }

  /* ============================ Vistas ============================ */

  const VIEWS = {};

  /** Barras horizontales; con opts.kind cada fila es un botón que lleva al detalle. */
  function barList(obj, opts) {
    opts = opts || {};
    const entries = Object.entries(obj).filter(e => e[1] !== 0).sort((a, b) => b[1] - a[1]);
    if (!entries.length) return '<div class="empty">Sin datos</div>';
    const max = Math.max.apply(null, entries.map(e => Math.abs(e[1])));
    return '<div class="bars">' + entries.map(([k, v]) => {
      const w = max ? Math.max(1, Math.abs(v) / max * 100) : 0;
      const pct = opts.total ? ' · ' + (v / opts.total * 100).toFixed(1) + '%' : '';
      const tag = opts.kind ? 'button' : 'div';
      const attrs = opts.kind ? ` type="button" data-act="drill" data-kind="${opts.kind}" data-key="${esc(k)}"` : '';
      return `<${tag} class="bar-row${k === '(Sin asignar)' ? ' pending' : ''}"${attrs} title="${esc(k)}: ${fmt(v)}${pct}${opts.kind ? ' · clic para ver el detalle' : ''}">
        <span class="name">${esc(k)}</span>
        <span class="track"><span class="fill" style="width:${w}%"></span></span>
        <span class="num">${fmt(v)}</span>
        <span class="go" aria-hidden="true">${opts.kind ? '›' : ''}</span></${tag}>`;
    }).join('') + '</div>';
  }

  /** Navegación desde las barras del resumen al detalle. */
  function drill(kind, key) {
    if (kind === 'cat' && S.tab === 'mis') {
      S.misCat = key === '(Sin categoría)' ? '__none' : key;
      render();
      return;
    }
    S.fromResumen = true;
    if (kind === 'cat') {
      S.movFilter = { q: '', cat: key === '(Sin categoría)' ? '__none' : key, resp: '', pendientes: false };
      go('movimientos');
    } else if (kind === 'resp') {
      if (key === '(Sin asignar)') { S.movFilter = { q: '', cat: '', resp: '', pendientes: true }; go('movimientos'); return; }
      S.respFocus = key;
      go('responsables');
    } else if (kind === 'tarjeta') {
      S.tarjeta = key;
      $('#f-tarjeta').value = key;
      S.movFilter = { q: '', cat: '', resp: '', pendientes: false };
      go('movimientos');
    }
  }
  function backBtn() { return S.fromResumen ? '<button class="btn small" data-act="back">‹ Volver al resumen</button>' : ''; }

  function statCard(label, value, sub, extra, state) {
    return `<div class="card stat${state ? ' alert-' + state : ''}"><div class="label">${label}</div><div class="value">${value}</div>
      ${sub ? `<div class="sub">${sub}</div>` : ''}${extra || ''}</div>`;
  }

  function limiteCard(total) {
    const lim = limiteActual();
    const st = limiteStatus(total, lim);
    const color = st.cls === 'bad' ? 'var(--meter-bad)' : st.cls === 'warn' ? 'var(--meter-warn)' : 'var(--meter-good)';
    const meter = lim ? `<div class="meter" role="meter" aria-valuenow="${st.pct.toFixed(0)}" aria-valuemin="0" aria-valuemax="100">
        <span style="width:${Math.min(100, st.pct)}%;background:${color}"></span></div>` : '';
    return statCard('Límite mensual' + (S.tarjeta === '*' ? '' : ' · ' + esc(S.tarjeta)),
      lim ? fmt(lim) : '—',
      `<span class="badge ${st.cls}">${st.text}</span>` + (lim ? `<span>${st.pct.toFixed(0)}% usado</span>` : ''),
      meter, st.cls === 'bad' || st.cls === 'warn' ? st.cls : '');
  }

  VIEWS.resumen = function (el) {
    const movs = movsFiltradas();
    const cargos = r2(movs.filter(m => m.tipo !== 'devolucion').reduce((s, m) => s + Number(m.monto), 0));
    const devs = r2(movs.filter(m => m.tipo === 'devolucion').reduce((s, m) => s + Number(m.monto), 0));
    const total = r2(cargos - devs);
    const sinAsignar = r2(movs.reduce((s, m) => s + pendiente(m), 0));
    const porCat = sumBy(movs, m => m.categoria || '(Sin categoría)', net);
    const porResp = totalesPorResponsable(movs);
    if (sinAsignar) porResp['(Sin asignar)'] = sinAsignar;
    const porTarjeta = sumBy(movs, m => m.tarjeta, net);

    el.innerHTML = `
      ${pageHead('Resumen del periodo', periodoTitulo(), movs.length + ' movimientos · clic en una barra para ver el detalle')}
      <div class="grid cols-5">
        ${statCard('Gasto neto del periodo', fmt(total), movs.length + ' movimientos')}
        ${limiteCard(total)}
        ${statCard('Devoluciones', fmt(devs), 'Cargos brutos ' + fmt(cargos))}
        ${statCard('Sin asignar', fmt(sinAsignar), sinAsignar ? `<span class="badge bad">✕ ${movs.filter(m => pendiente(m) !== 0).length} por asignar</span>` : '<span class="badge good">✓ Todo asignado</span>', '', sinAsignar ? 'bad' : '')}
        ${(() => {
          const cu = (S.alerts || []).filter(a => a.tipo === 'cuadre');
          const bad = cu.filter(a => a.level === 'bad').length;
          const credit = movs.some(m => tarjetaTipo(m.tarjeta) === 'credito');
          if (!credit) return '';
          return statCard('Cuadre', bad ? 'Incorrecto' : cu.length ? 'Con nota' : 'Correcto',
            bad ? `<span class="badge bad">✕ ${bad} problema${bad > 1 ? 's' : ''}</span><button class="btn small ghost" data-tab="cuadre">Ver cuadre ›</button>`
                : cu.length ? '<span class="badge warn">! Devoluciones pendientes de reflejar</span>' : '<span class="badge good">✓ Responsables = tarjeta</span>',
            '', bad ? 'bad' : cu.length ? 'warn' : '');
        })()}
      </div>
      <div class="grid cols-2">
        <div class="card"><div class="card-head"><h3>Gasto por categoría</h3><span class="meta">${Object.keys(porCat).length} categorías</span></div>${barList(porCat, { total: total, kind: 'cat' })}</div>
        <div class="card"><div class="card-head"><h3>A pagar por responsable</h3><span class="meta">${Object.keys(porResp).length} responsables</span></div>${barList(porResp, { total: total, kind: 'resp' })}</div>
      </div>
      ${S.tarjeta === '*' ? `<div class="card"><div class="card-head"><h3>Gasto por tarjeta</h3></div>${barList(porTarjeta, { total: total, kind: 'tarjeta' })}</div>` : ''}
      <div class="card panel" id="historial-card"><h3>Historial por periodo</h3><div class="muted">Cargando…</div></div>`;
    renderHistorial($('#historial-card'));
  };

  async function renderHistorial(card) {
    try {
      const rows = await api('historial', {}, { silent: true });
      // ajustes de devolventes (no están en la hoja de asignaciones)
      const ps = Array.from(new Set(rows.map(r => r.periodo).concat([S.periodo])));
      (S.cat.devolventes || []).forEach(d => ps.forEach(p => {
        const a = devAplicado(d, p);
        if (!a) return;
        let row = rows.find(x => x.periodo === p && x.responsable === d.responsable);
        if (!row) { row = { periodo: p, responsable: d.responsable, total: 0 }; rows.push(row); }
        row.total = r2(row.total - a.monto);
      }));
      const periodos = Array.from(new Set(rows.map(r => r.periodo))).sort().reverse().slice(0, 13);
      const resps = Array.from(new Set(rows.map(r => r.responsable))).sort();
      if (!periodos.length) { card.innerHTML = '<h3>Historial por periodo</h3><div class="empty">Sin datos</div>'; return; }
      const val = (p, r) => (rows.find(x => x.periodo === p && x.responsable === r) || {}).total || 0;
      card.innerHTML = `<div class="card-head"><h3>Historial por periodo</h3><span class="meta">${periodos.length} periodos</span></div><div class="table-wrap"><table>
        <thead><tr><th>Periodo</th>${resps.map(r => `<th class="num">${esc(r)}</th>`).join('')}${resps.length > 1 ? '<th class="num">Total</th>' : ''}</tr></thead>
        <tbody>${periodos.map(p => {
          const tot = resps.reduce((s, r) => s + val(p, r), 0);
          return `<tr><td>${periodLabel(p)}</td>${resps.map(r => `<td class="num">${fmt(val(p, r))}</td>`).join('')}${resps.length > 1 ? `<td class="num"><b>${fmt(tot)}</b></td>` : ''}</tr>`;
        }).join('')}</tbody></table></div>`;
    } catch (e) {
      card.innerHTML = '<h3>Historial por periodo</h3><div class="error">' + esc(e.message) + '</div>';
    }
  }

  VIEWS.movimientos = function (el) {
    const f = S.movFilter;
    let movs = movsFiltradas();
    if (f.q) { const q = f.q.toLowerCase(); movs = movs.filter(m => (m.descripcion + ' ' + m.notas).toLowerCase().includes(q)); }
    if (f.cat) movs = movs.filter(m => f.cat === '__none' ? !m.categoria : m.categoria === f.cat);
    if (f.resp) movs = movs.filter(m => asigOf(m.id).some(a => a.responsable === f.resp));
    if (f.pendientes) movs = movs.filter(m => pendiente(m) !== 0);
    const total = r2(movs.reduce((s, m) => s + net(m), 0));

    const pills = [];
    if (f.cat) pills.push(['cat', 'Categoría: ' + (f.cat === '__none' ? '(Sin categoría)' : f.cat)]);
    if (f.resp) pills.push(['resp', 'Responsable: ' + f.resp]);
    if (f.pendientes) pills.push(['pendientes', 'Solo sin asignar']);
    if (f.q) pills.push(['q', 'Búsqueda: ' + f.q]);
    const titulo = f.cat ? (f.cat === '__none' ? 'Sin categoría' : esc(f.cat)) : f.resp ? esc(f.resp) : f.pendientes ? 'Sin asignar' : 'Movimientos';

    el.innerHTML = `
      ${pageHead('Movimientos · ' + periodoTitulo(), titulo, movs.length + ' movimientos · ' + fmt(total), backBtn() + (S.tarjeta !== '*' ? corteMeta(S.tarjeta) : ''))}
      ${pills.length ? `<div class="crumbs">${pills.map(([k, t]) => `<span class="filter-pill">${esc(t)}<button type="button" data-act="clear-filter" data-k="${k}" aria-label="Quitar filtro">✕</button></span>`).join('')}
        ${pills.length > 1 ? '<button class="btn small ghost" data-act="clear-filter" data-k="*">Limpiar filtros</button>' : ''}</div>` : ''}
      <div class="toolbar">
        <div class="left">
          <input type="search" id="mf-q" placeholder="Buscar…" value="${esc(f.q)}">
          <select id="mf-cat"><option value="">Todas las categorías</option><option value="__none" ${f.cat === '__none' ? 'selected' : ''}>(Sin categoría)</option>${S.cat.categorias.map(c => `<option ${c.nombre === f.cat ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('')}</select>
          <select id="mf-resp"><option value="">Todos los responsables</option>${S.cat.responsables.map(r => `<option ${r.nombre === f.resp ? 'selected' : ''}>${esc(r.nombre)}</option>`).join('')}</select>
          <label class="inline"><input type="checkbox" id="mf-pend" ${f.pendientes ? 'checked' : ''}> Solo sin asignar</label>
        </div>
        <div class="right">
          <button class="btn" data-act="new-dev">+ Devolución</button>
          <button class="btn primary" data-act="new-mov">+ Nuevo gasto</button>
        </div>
      </div>
      <div class="card table-wrap">
        ${movs.length ? `<table>
          <thead><tr><th>Fecha</th><th>Descripción</th><th>Categoría</th>${S.tarjeta === '*' ? '<th>Tarjeta</th>' : ''}<th>Responsables</th><th class="num">Monto</th><th></th></tr></thead>
          <tbody>${movs.map(m => {
            const pend = pendiente(m);
            const msi = m.msi_total ? `MSI ${m.msi_actual}/${m.msi_total}` : '';
            return `<tr class="${pend ? 'row-bad' : ''}">
              <td>${fmtDate(m.fecha)}</td>
              <td class="desc">${esc(m.descripcion)}<small>${[m.virtual ? 'Ajuste automático' : m.tipo === 'devolucion' ? 'Devolución' : '', msi, esc(m.notas)].filter(Boolean).join(' · ')}</small></td>
              <td>${m.categoria ? `<span class="tag">${esc(m.categoria)}</span>` : '<span class="muted">—</span>'}</td>
              ${S.tarjeta === '*' ? `<td>${esc(m.tarjeta)}</td>` : ''}
              <td><div class="chips">${asigOf(m.id).map(a => `<span class="chip" title="${esc(a.concepto)}">${esc(a.responsable)} ${fmt(a.monto)}</span>`).join('')}
                ${pend ? `<span class="badge bad">✕ ${pend > 0 ? 'Falta' : 'Excede'} ${fmt(Math.abs(pend))}</span>` : ''}</div></td>
              <td class="num ${m.tipo === 'devolucion' ? 'neg' : ''}">${fmt(net(m))}</td>
              <td class="num">${m.virtual ? `<button class="btn small ghost" data-act="dev-edit" data-id="${m.devolvente_id}" title="Ajuste automático de un devolvente">Devolvente</button>`
                : `<button class="btn small ghost" data-act="edit" data-id="${m.id}">Editar</button><button class="btn small ghost danger" data-act="del" data-id="${m.id}" aria-label="Eliminar">✕</button>`}</td>
            </tr>`;
          }).join('')}</tbody>
          <tfoot><tr><td colspan="${S.tarjeta === '*' ? 5 : 4}">Total (${movs.length})</td><td class="num">${fmt(total)}</td><td></td></tr></tfoot>
        </table>` : `<div class="empty">${pills.length ? 'Ningún movimiento coincide con los filtros.' : 'No hay movimientos en este periodo. Agrega un gasto o importa el Excel del estado de cuenta.'}</div>`}
      </div>`;

    const rerender = () => { const pos = $('#mf-q').selectionStart; render(); const q = $('#mf-q'); q.focus(); q.setSelectionRange(pos, pos); };
    $('#mf-q').addEventListener('input', e => { f.q = e.target.value; rerender(); });
    $('#mf-cat').addEventListener('change', e => { f.cat = e.target.value; render(); });
    $('#mf-resp').addEventListener('change', e => { f.resp = e.target.value; render(); });
    $('#mf-pend').addEventListener('change', e => { f.pendientes = e.target.checked; render(); });
  };

  function respResumen(n, ids) {
    const items = S.data.asignaciones.filter(a => a.responsable === n && ids[a.movimiento_id]);
    const c = r2(items.filter(a => ids[a.movimiento_id].tipo !== 'devolucion').reduce((s, a) => s + Number(a.monto), 0));
    const d = r2(items.filter(a => ids[a.movimiento_id].tipo === 'devolucion').reduce((s, a) => s + Number(a.monto), 0));
    return { cargos: c, devs: d, total: r2(c - d), count: items.length };
  }

  VIEWS.responsables = function (el) {
    const movs = movsFiltradas();
    const ids = {};
    movs.forEach(m => { ids[m.id] = m; });
    const totals = totalesPorResponsable(movs);
    const sinAsignar = r2(movs.reduce((s, m) => s + pendiente(m), 0));
    const totalMovs = r2(movs.reduce((s, m) => s + net(m), 0));
    const names = S.cat.responsables.map(r => r.nombre).filter(n => totals[n] !== undefined);
    Object.keys(totals).forEach(n => { if (names.indexOf(n) < 0) names.push(n); });
    const focus = S.respFocus;
    const selector = `<select id="resp-sel" aria-label="Responsable"><option value="">Todos los responsables</option>${S.cat.responsables.map(r => `<option ${r.nombre === focus ? 'selected' : ''}>${esc(r.nombre)}</option>`).join('')}</select>`;

    if (focus) {
      const movIds = {};
      S.data.movimientos.forEach(m => { movIds[m.id] = 1; });
      const nCargos = S.data.asignaciones.filter(a => a.responsable === focus && movIds[a.movimiento_id]).length;
      el.innerHTML = `
        ${pageHead('Cargos del responsable · ' + periodLabel(S.periodo), esc(focus), nCargos + ' cargos · todas las tarjetas', backBtn() + selector)}
        ${respPanel(focus)}`;
    } else {
      el.innerHTML = `
        ${pageHead('Por responsable · ' + periodoTitulo(), 'Total a pagar', names.length + ' responsables · ' + fmt(totalMovs), backBtn() + selector)}
        <div class="card table-wrap">
          <table><thead><tr><th>Responsable</th><th class="num">Crédito</th><th class="num">Débito</th><th class="num">Devoluciones</th><th class="num">Total a pagar</th><th></th></tr></thead>
          <tbody>${names.map(n => {
            const rs = respResumen(n, ids);
            let deb = 0;
            S.data.asignaciones.forEach(a => {
              const m = a.responsable === n && ids[a.movimiento_id];
              if (m && m.tipo !== 'devolucion' && tarjetaTipo(m.tarjeta) === 'debito') deb += Number(a.monto);
            });
            deb = r2(deb);
            const lim = limiteResp(n);
            const over = lim && totals[n] > lim;
            return `<tr class="${over ? 'row-bad' : ''}"><td><span class="user-chip"><span class="avatar">${esc(n.charAt(0))}</span>${esc(n)}</span></td><td class="num">${fmt(r2(rs.cargos - deb))}</td><td class="num">${deb ? fmt(deb) : '<span class="muted">—</span>'}</td><td class="num neg">${rs.devs ? '−' + fmt(rs.devs) : ''}</td>
              <td class="num"><b>${fmt(totals[n])}</b>${over ? `<br><span class="badge bad">✕ Excede ${fmt(totals[n] - lim)}</span>` : ''}</td><td class="num"><button class="btn small" data-act="resp-focus" data-key="${esc(n)}">Ver cargos ›</button></td></tr>`;
          }).join('')}
          ${sinAsignar ? `<tr><td><span class="badge warn">! Sin asignar</span></td><td></td><td></td><td></td><td class="num">${fmt(sinAsignar)}</td><td class="num"><button class="btn small" data-act="drill" data-kind="resp" data-key="(Sin asignar)">Asignar ›</button></td></tr>` : ''}
          </tbody>
          <tfoot><tr><td>Total</td><td></td><td></td><td></td><td class="num">${fmt(totalMovs)}</td><td></td></tr></tfoot></table></div>
        <div class="grid cols-2">${names.map(n => detalleResponsable(n, ids)).join('')}</div>`;
    }
    $('#resp-sel').addEventListener('change', e => { S.respFocus = e.target.value; render(); });
  };

  /**
   * Vista de un responsable, en este orden: total gastado (crédito + débito) contra su límite,
   * crédito y débito, devoluciones, gasto por categoría y detalle de cargos. Incluye todas las tarjetas.
   */
  function respPanel(n, catFilter, mine) {
    const ids = {};
    S.data.movimientos.forEach(m => { ids[m.id] = m; });
    const t = respTotales(n);
    const lim = limiteResp(n);
    const st = limiteStatus(t.total, lim);
    const color = st.cls === 'bad' ? 'var(--meter-bad)' : st.cls === 'warn' ? 'var(--meter-warn)' : 'var(--meter-good)';
    const limTxt = !lim ? `<span class="badge neutral">Sin límite definido</span>${isAdmin() ? '<button class="btn small ghost" data-tab="config">Definir límite ›</button>' : ''}`
      : st.cls === 'bad' ? `<span>Límite ${fmt(lim)} · ${st.pct.toFixed(0)}% usado</span>`
      : `<span class="badge ${st.cls}">${st.text}</span><span>Límite ${fmt(lim)} · ${st.pct.toFixed(0)}% usado</span>`;
    const meter = lim ? `<div class="meter" role="meter" aria-valuenow="${st.pct.toFixed(0)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${Math.min(100, st.pct)}%;background:${color}"></span></div>` : '';
    const hero = `<div class="card stat resp-hero${st.cls === 'bad' ? ' alert-bad' : st.cls === 'warn' ? ' alert-warn' : ''}">
        <div class="label">Total gastado · crédito + débito${t.devs ? ' − devoluciones' : ''}</div>
        <div class="value">${fmt(t.total)}</div>
        ${st.cls === 'bad' ? `<div class="over">Excedido por <b>${fmt(t.total - lim)}</b></div>` : ''}
        <div class="sub">${limTxt}</div>${meter}</div>`;
    const devList = t.devItems.length ? `<ul class="mini-list">${t.devItems.map(x => `<li><span>${esc(x.a.concepto || x.m.descripcion)}</span><span class="num neg">−${fmt(x.a.monto)}</span></li>`).join('')}</ul>` : '';
    const porCat = {};
    S.data.asignaciones.filter(a => a.responsable === n && ids[a.movimiento_id]).forEach(a => {
      const m = ids[a.movimiento_id];
      const k = m.categoria || '(Sin categoría)';
      porCat[k] = r2((porCat[k] || 0) + (m.tipo === 'devolucion' ? -1 : 1) * Number(a.monto));
    });
    return `${hero}
      <div class="grid cols-3">
        ${statCard('Tarjeta de crédito', fmt(t.credito), t.nCred + ' cargo' + (t.nCred === 1 ? '' : 's'))}
        ${statCard('Tarjeta de débito', fmt(t.debito), t.nDeb ? t.nDeb + ' cargo' + (t.nDeb === 1 ? '' : 's') : 'Sin cargos')}
        ${statCard('Devoluciones', t.devs ? '−' + fmt(t.devs) : fmt(0), t.devs ? (mine ? 'A tu favor' : 'A su favor') + ' · ya descontadas del total' : 'Sin devoluciones', devList)}
      </div>
      <div class="card panel"><div class="card-head"><h3>Gasto por categoría</h3><span class="meta">${Object.keys(porCat).length} categorías${mine ? ' · clic para filtrar' : ''}</span></div>${barList(porCat, { total: t.total, kind: mine ? 'cat' : undefined })}</div>
      ${catFilter ? `<div class="crumbs"><span class="filter-pill">Categoría: ${esc(catFilter === '__none' ? '(Sin categoría)' : catFilter)}<button type="button" data-act="mis-cat" aria-label="Quitar filtro">✕</button></span></div>` : ''}
      ${detalleResponsable(n, ids, true, catFilter, true, 'credito')}
      ${detalleResponsable(n, ids, true, catFilter, true, 'debito')}
      ${S.tarjeta !== '*' ? '<p class="muted">Esta vista incluye todas las tarjetas del responsable (crédito y débito).</p>' : ''}`;
  }

  /** Tabla de cargos de un responsable. full = columnas completas (vista enfocada). */
  function detalleResponsable(n, ids, full, catFilter, conTarjeta, tipoTarjeta) {
    let items = S.data.asignaciones.filter(a => a.responsable === n && ids[a.movimiento_id])
      .map(a => ({ a: a, m: ids[a.movimiento_id] }))
      .sort((x, y) => String(y.m.fecha).localeCompare(String(x.m.fecha)));
    if (catFilter) items = items.filter(x => catFilter === '__none' ? !x.m.categoria : x.m.categoria === catFilter);
    if (tipoTarjeta) items = items.filter(x => (tarjetaTipo(x.m.tarjeta) === 'debito') === (tipoTarjeta === 'debito'));
    const sg = x => (x.m.tipo === 'devolucion' ? -1 : 1);
    const tot = r2(items.reduce((s, x) => s + sg(x) * Number(x.a.monto), 0));
    const titulo = tipoTarjeta === 'debito' ? 'Movimientos de tarjeta de débito' : tipoTarjeta ? 'Movimientos de tarjeta de crédito' : 'Detalle de cargos';
    if (full && tipoTarjeta && !items.length) {
      return `<div class="card"><div class="card-head"><h3>${titulo}</h3><span class="meta">0 · ${fmt(0)}</span></div><div class="empty">Sin movimientos ${tipoTarjeta === 'debito' ? 'de débito' : 'de crédito'} en ${periodLabel(S.periodo)}${catFilter ? ' para esta categoría' : ''}.</div></div>`;
    }
    const head = full
      ? `<div class="card-head"><h3>${titulo}</h3><span class="meta">${items.length} · ${fmt(tot)}</span></div>`
      : `<div class="card-head"><h3><button class="btn small ghost" style="padding-left:0" data-act="resp-focus" data-key="${esc(n)}">${esc(n)} ›</button></h3><span class="meta">${fmt(tot)}</span></div>`;
    return `<div class="card table-wrap">${head}<table>
      ${full ? `<thead><tr><th>Fecha</th><th>Concepto</th><th>Categoría</th>${conTarjeta ? '<th>Tarjeta</th>' : ''}<th class="num">Cargo total</th><th class="num">Le toca</th></tr></thead>` : ''}
      <tbody>${items.map(x => `
      <tr><td>${fmtDate(x.m.fecha)}</td>
      <td class="desc">${esc(x.a.concepto || x.m.descripcion)}<small>${full ? esc(x.m.descripcion) + (x.m.msi_total ? ' · MSI ' + x.m.msi_actual + '/' + x.m.msi_total : '') + (S.tarjeta === '*' && !conTarjeta ? ' · ' + esc(x.m.tarjeta) : '')
        : esc(x.m.categoria) + (x.m.msi_total ? ' · MSI ' + x.m.msi_actual + '/' + x.m.msi_total : '') + (S.tarjeta === '*' ? ' · ' + esc(x.m.tarjeta) : '')}</small></td>
      ${full ? `<td>${x.m.categoria ? `<span class="tag">${esc(x.m.categoria)}</span>` : ''}</td>${conTarjeta ? `<td><span class="tag">${tarjetaTipo(x.m.tarjeta) === 'debito' ? 'Débito' : 'Crédito'}</span> <small class="muted">${esc(x.m.tarjeta)}</small></td>` : ''}<td class="num muted">${fmt(sg(x) * x.m.monto)}</td>` : ''}
      <td class="num ${x.m.tipo === 'devolucion' ? 'neg' : ''}">${fmt(sg(x) * x.a.monto)}</td></tr>`).join('')}
      </tbody>${full ? `<tfoot><tr><td colspan="${conTarjeta ? 5 : 4}">${tipoTarjeta === 'debito' ? 'Total débito' : tipoTarjeta ? 'Total crédito' : 'Total a pagar'}</td><td class="num">${fmt(tot)}</td></tr></tfoot>` : ''}</table></div>`;
  }

  function cuadreData(tarjeta) {
    const movs = S.data.movimientos.filter(m => m.tarjeta === tarjeta);
    const cargos = r2(movs.filter(m => m.tipo !== 'devolucion').reduce((s, m) => s + Number(m.monto), 0));
    const devs = r2(movs.filter(m => m.tipo === 'devolucion' && !m.virtual).reduce((s, m) => s + Number(m.monto), 0));
    const dvMovs = movs.filter(m => m.virtual);
    const dvs = r2(dvMovs.reduce((s, m) => s + Number(m.monto), 0));
    const neto = r2(cargos - devs);          // lo que trae el estado de cuenta
    const aCubrir = r2(neto - dvs);          // lo que deben aportar los responsables
    const porResp = totalesPorResponsable(movs);
    const asignadoTot = r2(Object.values(porResp).reduce((s, v) => s + v, 0));
    const est = S.data.estados.find(e => e.tarjeta === tarjeta);
    const estado = est && est.total !== '' ? Number(est.total) : null;
    const pendientes = movs.filter(m => pendiente(m) !== 0);
    const porCat = sumBy(movs.filter(m => !m.virtual), m => m.categoria || '(Sin categoría)', net);
    return { movs, cargos, devs, dvs, dvMovs, neto, aCubrir, porResp, porCat, asignadoTot, estado, pendientes,
             difAsig: r2(aCubrir - asignadoTot), difEstado: estado === null ? null : r2(estado - neto) };
  }

  VIEWS.cuadre = function (el) {
    const conDatos = t => S.data.movimientos.some(m => m.tarjeta === t.nombre) || S.data.estados.some(e => e.tarjeta === t.nombre)
      || (S.cat.devolventes || []).some(d => d.tarjeta === t.nombre);
    const cards = S.cat.tarjetas.filter(t => t.tipo === 'credito' && (S.tarjeta === t.nombre || (S.tarjeta === '*' && conDatos(t))));
    const head = pageHead('Cuadre de tarjeta de crédito', periodoTitulo(), 'Responsables + banco = estado de cuenta por categoría');
    if (!cards.length) { el.innerHTML = head + '<div class="card empty">El cuadre aplica a tarjetas de crédito. Selecciona una tarjeta de crédito.</div>'; return; }
    el.innerHTML = head + cards.map(t => {
      const c = cuadreData(t.nombre);
      const okAsig = Math.abs(c.difAsig) < 0.01;
      const okEst = c.difEstado !== null && Math.abs(c.difEstado) < 0.01;
      const badge = (ok, txt) => `<span class="badge ${ok ? 'good' : 'bad'}">${ok ? '✓ ' : '✕ '}${txt}</span>`;
      const porDev = !okEst && c.estado !== null && c.devs && Math.abs(c.difEstado - c.devs) < 0.01;
      const state = !okAsig || (c.estado !== null && !okEst && !porDev) ? ' alert-bad' : porDev ? ' alert-warn' : '';
      return `<div class="card table-wrap${state}">
        <div class="toolbar" style="margin-bottom:8px"><div class="crumbs"><h2>${esc(t.nombre)}</h2>${corteMeta(t.nombre)}</div>
          <div class="crumbs">${badge(okAsig, okAsig ? 'Cuadrado' : 'Descuadre ' + fmt(c.difAsig))}
          ${c.estado === null ? '<span class="badge neutral">Captura el total del estado de cuenta</span>'
            : (!okEst && c.devs && Math.abs(c.difEstado - c.devs) < 0.01) ? `<span class="badge warn">! Diferencia ${fmt(c.difEstado)} = devoluciones aún no reflejadas en el estado de cuenta</span>`
            : badge(okEst, okEst ? 'Coincide con estado de cuenta' : 'Diferencia ' + fmt(c.difEstado))}</div></div>
        <div class="estado-row">
          <span>Total del estado de cuenta (banco)</span>
          <form class="inline-form" data-estado="${esc(t.nombre)}">
            <input type="number" step="0.01" name="total" value="${c.estado === null ? '' : c.estado}" placeholder="0.00" aria-label="Total del estado de cuenta">
            <button class="btn small">Guardar</button></form>
          <span class="num ${c.estado === null ? 'muted' : okEst ? 'diff-ok' : 'diff-bad'}">${c.estado === null ? 'sin capturar' : okEst ? '✓ coincide con los movimientos' : 'diferencia ' + fmt(c.difEstado)}</span>
        </div>
        <div class="cuadre-grid">
          <div class="cuadre-col">
            <div class="card-head"><h3>¿Quién lo paga?</h3><span class="meta">responsables + banco</span></div>
            <table><tbody>
              ${Object.entries(c.porResp).sort((x, y) => y[1] - x[1]).map(([n, v]) => `<tr><td><button class="link" data-act="drill" data-kind="resp" data-key="${esc(n)}">${esc(n)}</button></td><td class="num">${fmt(v)}</td></tr>`).join('')}
              ${c.dvMovs.length ? `<tr class="bank-row"><td>Banco · devolventes<small>${c.dvMovs.map(m => esc(m.descripcion.replace('Devolvente aplicado · ', ''))).join('<br>')}</small></td><td class="num">${fmt(c.dvs)}</td></tr>` : ''}
              ${c.difAsig > 0.009 ? `<tr class="row-bad"><td>(Sin asignar)</td><td class="num">${fmt(c.difAsig)}</td></tr>` : ''}
            </tbody>
            <tfoot><tr><td>Total</td><td class="num">${fmt(r2(c.asignadoTot + c.dvs + Math.max(0, c.difAsig)))}</td></tr></tfoot></table>
          </div>
          <div class="cuadre-col">
            <div class="card-head"><h3>Estado de cuenta por categoría</h3><span class="meta">${c.movs.filter(m => !m.virtual).length} movimientos</span></div>
            <table><tbody>
              ${Object.entries(c.porCat).sort((x, y) => y[1] - x[1]).map(([n, v]) => `<tr><td><button class="link" data-act="drill" data-kind="cat" data-key="${esc(n)}">${esc(n)}</button></td><td class="num ${v < 0 ? 'neg' : ''}">${fmt(v)}</td></tr>`).join('')}
            </tbody>
            <tfoot><tr><td>Total</td><td class="num">${fmt(c.neto)}</td></tr></tfoot></table>
          </div>
        </div>
        <div class="cuadre-result ${okAsig ? 'ok' : 'bad'}">
          ${okAsig ? `✓ Cuadrado: ambos lados suman ${fmt(c.neto)}` : `✕ Descuadre de ${fmt(Math.abs(c.difAsig))}: ${c.difAsig > 0 ? 'faltan movimientos por asignar a responsables' : 'lo asignado supera al estado de cuenta'}`}
        </div>
        ${devolventesTable(t.nombre)}
        ${c.pendientes.length ? `<div class="card-head" style="margin-top:18px;padding-top:14px;border-top:1px solid var(--line)"><h3>Movimientos con reparto incompleto</h3><span class="meta">${c.pendientes.length}</span></div><table><tbody>${c.pendientes.map(m => `
          <tr><td>${fmtDate(m.fecha)}</td><td class="desc">${esc(m.descripcion)}</td><td class="num">${fmt(m.monto)}</td>
          <td class="num"><span class="badge warn">Pendiente ${fmt(pendiente(m))}</span></td>
          <td class="num"><button class="btn small" data-act="edit" data-id="${m.id}">Asignar</button></td></tr>`).join('')}</tbody></table>` : ''}
      </div>`;
    }).join('');

    $$('form[data-estado]', el).forEach(f => f.addEventListener('submit', async ev => {
      ev.preventDefault();
      guardando(f, async () => {
        try {
          await api('saveEstado', { periodo: S.periodo, tarjeta: f.dataset.estado, total: f.total.value === '' ? '' : Number(f.total.value) });
          toast('Total del estado de cuenta guardado');
          await loadPeriodo();
        } catch (e) { toast(e.message); }
      });
    }));
  };

  /* ---------- Vista de responsable ---------- */

  VIEWS.mis = function (el) {
    const movs = movsFiltradas();
    const ids = {};
    movs.forEach(m => { ids[m.id] = m; });
    const me = S.session.responsable;
    const rs = respResumen(me, ids);
    el.innerHTML = `
      ${pageHead('Mis cargos · ' + periodLabel(S.periodo), 'Hola ' + esc(me), rs.count + ' cargos')}
      ${respPanel(me, S.misCat, true)}
      <div class="card panel" id="historial-card"><h3>Mi historial</h3><div class="muted">Cargando…</div></div>`;
    renderHistorial($('#historial-card'));
  };

  /* ---------- Configuración ---------- */

  VIEWS.config = function (el) {
    const pwd = `<div class="card"><h3>Cambiar mi contraseña</h3>
      <form id="form-pwd" class="form-grid">
        <label>Contraseña actual <input type="password" name="actual" required autocomplete="current-password"></label>
        <label>Nueva contraseña <input type="password" name="nueva" required minlength="6" autocomplete="new-password"></label>
        <div style="align-self:end"><button class="btn primary">Actualizar</button></div>
      </form></div>`;
    if (!isAdmin()) { el.innerHTML = pageHead('Mi cuenta', esc(S.session.usuario), esc(S.session.responsable)) + pwd; bindPwd(); return; }

    const catTable = (tipo, rows, extra) => `<div class="card table-wrap"><h3>${tipo}</h3>
      <table><tbody>${rows.map(r => `<tr>
        <td>${esc(r.nombre)}${extra ? ' <span class="muted">' + extra(r) + '</span>' : ''}</td>
        <td>${isActive(r) ? '<span class="badge good">Activo</span>' : '<span class="badge neutral">Inactivo</span>'}</td>
        <td class="num"><button class="btn small ghost" data-act="cat-edit" data-tipo="${tipo}" data-id="${r.id}">Editar</button></td></tr>`).join('')}</tbody></table>
      <div style="margin-top:.6rem"><button class="btn small" data-act="cat-new" data-tipo="${tipo}">+ Agregar</button></div></div>`;

    const limRows = S.cat.limites.slice().sort((a, b) => String(b.periodo).localeCompare(String(a.periodo)));
    el.innerHTML = `
      ${pageHead('Configuración', 'Catálogos y accesos', 'Límites · tarjetas · responsables · usuarios')}
      <div class="card table-wrap"><h3>Límites de gasto mensual</h3>
        <p class="muted">El límite de un periodo específico tiene prioridad sobre el límite general ("Todos los periodos"). "Todas" aplica al gasto conjunto de todas las tarjetas. El límite de un responsable se compara con lo que gastó en todas sus tarjetas (crédito + débito).</p>
        <table><thead><tr><th>Periodo</th><th>Aplica a</th><th class="num">Límite</th><th></th></tr></thead><tbody>
        ${limRows.map(l => `<tr><td>${periodLabel(String(l.periodo))}</td><td>${l.responsable ? 'Responsable · ' + esc(l.responsable) : l.tarjeta === '*' ? 'Todas las tarjetas' : 'Tarjeta · ' + esc(l.tarjeta)}</td><td class="num">${fmt(l.monto)}</td>
          <td class="num"><button class="btn small ghost danger" data-act="lim-del" data-p="${esc(l.periodo)}" data-t="${esc(l.tarjeta)}" data-r="${esc(l.responsable || '')}">✕</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">Sin límites</td></tr>'}
        </tbody></table>
        <form id="form-lim" class="form-grid" style="margin-top:.8rem">
          <label>Periodo <select name="periodo"><option value="*">Todos los periodos</option><option value="${S.periodo}">${periodLabel(S.periodo)}</option></select></label>
          <label>Responsable <select name="responsable"><option value="">— (límite de tarjeta)</option>${S.cat.responsables.map(r => `<option>${esc(r.nombre)}</option>`).join('')}</select></label>
          <label>Tarjeta <select name="tarjeta"><option value="*">Todas</option>${S.cat.tarjetas.map(t => `<option>${esc(t.nombre)}</option>`).join('')}</select></label>
          <label>Límite (MXN) <input type="number" step="0.01" min="0" name="monto" required></label>
          <div style="align-self:end"><button class="btn primary">Guardar límite</button></div>
        </form></div>
      <div class="grid cols-2">
        ${catTable('Tarjetas', S.cat.tarjetas, r => r.tipo === 'credito' ? 'crédito' + (Number(r.dia_corte) ? ' · corte día ' + r.dia_corte : ' · sin día de corte') : 'débito')}
        ${catTable('Responsables', S.cat.responsables)}
        ${catTable('Categorias', S.cat.categorias)}
        <div class="card table-wrap" id="users-card"><h3>Usuarios</h3><div class="muted">Cargando…</div></div>
      </div>
      ${pwd}`;
    bindPwd();

    $('#form-lim').responsable.addEventListener('change', e => {
      const t = $('#form-lim').tarjeta;
      t.disabled = !!e.target.value;
      if (e.target.value) t.value = '*';
    });
    $('#form-lim').addEventListener('submit', async ev => {
      ev.preventDefault();
      const f = ev.target;
      guardando(f, async () => {
        try {
          await api('saveLimite', { periodo: f.periodo.value, tarjeta: f.responsable.value ? '*' : f.tarjeta.value, responsable: f.responsable.value, monto: Number(f.monto.value) });
          await refreshCatalogs(); render(); toast('Límite guardado');
        } catch (e) { toast(e.message); }
      });
    });
    loadUsers();
  };

  function bindPwd() {
    $('#form-pwd').addEventListener('submit', async ev => {
      ev.preventDefault();
      const f = ev.target;
      guardando(f, async () => {
        try {
          await api('cambiarPassword', { actual: f.actual.value, nueva: f.nueva.value });
          f.reset(); toast('Contraseña actualizada');
        } catch (e) { toast(e.message); }
      });
    });
  }

  async function loadUsers() {
    const card = $('#users-card');
    try {
      const users = await api('listUsuarios', {}, { silent: true });
      S.users = users;
      card.innerHTML = `<h3>Usuarios</h3><table><tbody>${users.map(u => `<tr>
        <td>${esc(u.usuario)}</td><td>${u.rol === 'admin' ? 'Administrador' : 'Responsable'}${u.responsable ? ' · ' + esc(u.responsable) : ''}</td>
        <td>${isActive(u) ? '<span class="badge good">Activo</span>' : '<span class="badge neutral">Inactivo</span>'}</td>
        <td class="num"><button class="btn small ghost" data-act="user-edit" data-u="${esc(u.usuario)}">Editar</button></td></tr>`).join('')}</tbody></table>
        <div style="margin-top:.6rem"><button class="btn small" data-act="user-new">+ Agregar usuario</button></div>`;
    } catch (e) { card.innerHTML = '<h3>Usuarios</h3><div class="error">' + esc(e.message) + '</div>'; }
  }

  /* ============================ Modales ============================ */

  function openModal(html) {
    $('#modal-body').innerHTML = html;
    const d = $('#modal');
    if (!d.open) d.showModal();
  }
  function closeModal() { $('#modal').close(); placeLoader(); }

  function catalogModal(tipo, item) {
    item = item || { activo: true };
    openModal(`<h2>${item.id ? 'Editar' : 'Agregar'} · ${tipo}</h2>
      <form id="form-cat" class="form-grid">
        <label class="span-2">Nombre <input name="nombre" required value="${esc(item.nombre)}"></label>
        ${tipo === 'Tarjetas' ? `<label>Tipo <select name="tipo"><option value="credito" ${item.tipo === 'credito' ? 'selected' : ''}>Crédito</option><option value="debito" ${item.tipo === 'debito' ? 'selected' : ''}>Débito</option></select></label>
          <label>Día de corte (crédito) <input type="number" name="dia_corte" min="1" max="31" value="${esc(item.dia_corte)}" placeholder="Ej. 13"></label>` : ''}
        <label class="inline"><input type="checkbox" name="activo" ${isActive(item) ? 'checked' : ''}> Activo</label>
        ${item.id ? '<p class="muted span-2">Cambiar el nombre no actualiza los movimientos ya capturados.</p>' : ''}
        <div class="actions span-2"><button type="button" class="btn" data-act="close">Cancelar</button><button class="btn primary">Guardar</button></div>
      </form>`);
    $('#form-cat').addEventListener('submit', async ev => {
      ev.preventDefault();
      const f = ev.target;
      const it = { id: item.id, nombre: f.nombre.value.trim(), activo: f.activo.checked };
      if (f.tipo) it.tipo = f.tipo.value;
      if (f.dia_corte) it.dia_corte = f.tipo.value === 'credito' && f.dia_corte.value ? Number(f.dia_corte.value) : '';
      guardando(f, async () => {
        try { await api('saveCatalogo', { tipo: tipo, item: it }); closeModal(); await refreshCatalogs(); render(); toast('Guardado'); }
        catch (e) { toast(e.message); }
      });
    });
  }

  function userModal(u) {
    const isNew = !u;
    u = u || { rol: 'responsable', activo: true };
    openModal(`<h2>${isNew ? 'Agregar' : 'Editar'} usuario</h2>
      <form id="form-user" class="form-grid">
        <label>Usuario <input name="usuario" required value="${esc(u.usuario)}" ${isNew ? '' : 'readonly'} autocomplete="off"></label>
        <label>${isNew ? 'Contraseña' : 'Nueva contraseña (opcional)'} <input name="password" type="password" ${isNew ? 'required' : ''} minlength="6" autocomplete="new-password"></label>
        <label>Rol <select name="rol"><option value="responsable" ${u.rol === 'responsable' ? 'selected' : ''}>Responsable (solo consulta sus cargos)</option><option value="admin" ${u.rol === 'admin' ? 'selected' : ''}>Administrador</option></select></label>
        <label>Responsable <select name="responsable"><option value="">—</option>${S.cat.responsables.map(r => `<option ${r.nombre === u.responsable ? 'selected' : ''}>${esc(r.nombre)}</option>`).join('')}</select></label>
        <label class="inline"><input type="checkbox" name="activo" ${isActive(u) ? 'checked' : ''}> Activo</label>
        <div class="actions span-2"><button type="button" class="btn" data-act="close">Cancelar</button><button class="btn primary">Guardar</button></div>
      </form>`);
    $('#form-user').addEventListener('submit', async ev => {
      ev.preventDefault();
      const f = ev.target;
      guardando(f, async () => {
        try {
          await api('saveUsuario', { user: { usuario: f.usuario.value, password: f.password.value, rol: f.rol.value, responsable: f.responsable.value, activo: f.activo.checked } });
          closeModal(); loadUsers(); toast('Usuario guardado');
        } catch (e) { toast(e.message); }
      });
    });
  }

  /** Formulario de gasto / devolución con reparto entre responsables. */
  function movModal(m, tipoDefault) {
    const isNew = !m;
    m = m ? Object.assign({}, m) : {
      periodo: S.periodo, tarjeta: S.tarjeta !== '*' ? S.tarjeta : ((S.cat.tarjetas.find(isActive) || {}).nombre || ''),
      fecha: new Date().toISOString().slice(0, 10), tipo: tipoDefault || 'cargo', categoria: '', descripcion: '', monto: '', notas: '', ref_id: '',
    };
    let splits = isNew ? [] : asigOf(m.id).map(a => ({ responsable: a.responsable, monto: Number(a.monto), concepto: a.concepto }));
    if (!splits.length) splits.push({ responsable: '', monto: '', concepto: '' });
    const cargos = S.data.movimientos.filter(x => x.tipo !== 'devolucion');
    const respOpts = sel => '<option value="">Responsable…</option>' + S.cat.responsables.filter(r => isActive(r) || r.nombre === sel)
      .map(r => `<option ${r.nombre === sel ? 'selected' : ''}>${esc(r.nombre)}</option>`).join('');

    openModal(`<div><div class="eyebrow">${periodLabel(m.periodo)}</div><h2 style="margin-top:6px">${isNew ? 'Nuevo' : 'Editar'} ${m.tipo === 'devolucion' ? 'devolución' : 'gasto'}</h2></div>
      <form id="form-mov">
        <div class="form-grid">
          <label>Tipo <select name="tipo"><option value="cargo" ${m.tipo === 'cargo' ? 'selected' : ''}>Gasto / cargo</option><option value="devolucion" ${m.tipo === 'devolucion' ? 'selected' : ''}>Devolución / abono</option></select></label>
          <label>Periodo (mes de corte) <input type="month" name="periodo" required value="${esc(m.periodo)}"><span class="muted" id="periodo-hint"></span></label>
          <label>Tarjeta <select name="tarjeta" required>${S.cat.tarjetas.filter(t => isActive(t) || t.nombre === m.tarjeta).map(t => `<option ${t.nombre === m.tarjeta ? 'selected' : ''}>${esc(t.nombre)}</option>`).join('')}</select></label>
          <label>Fecha <input type="date" name="fecha" required value="${esc(String(m.fecha).slice(0, 10))}"></label>
          <label class="span-2">Descripción <input name="descripcion" required value="${esc(m.descripcion)}" placeholder="Ej. NETFLIX COM o LIVERPOOL (002:006)"></label>
          <label>Monto (MXN) <input type="number" name="monto" step="0.01" min="0.01" required value="${esc(m.monto)}"></label>
          <label>Categoría <select name="categoria"><option value="">—</option>${S.cat.categorias.filter(c => isActive(c) || c.nombre === m.categoria).map(c => `<option ${c.nombre === m.categoria ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('')}</select></label>
          <label>MSI (mes actual / total) <span style="display:flex;gap:.3rem"><input type="number" name="msi_actual" min="0" value="${esc(m.msi_actual)}" style="width:50%"><input type="number" name="msi_total" min="0" value="${esc(m.msi_total)}" style="width:50%"></span></label>
          <p id="dev-hint" class="span-2 muted" style="font-size:12px" ${m.tipo === 'devolucion' && isNew ? '' : 'hidden'}>¿Es un saldo a favor que se descuenta mes con mes (p. ej. sobre una compra a MSI)? <button type="button" class="btn small" data-act="dev-new">Registrar como devolvente</button></p>
          <label id="ref-wrap" class="span-2" ${m.tipo === 'devolucion' ? '' : 'hidden'}>Compra original (opcional)
            <select name="ref_id"><option value="">—</option>${cargos.map(c => `<option value="${c.id}" ${c.id === m.ref_id ? 'selected' : ''}>${fmtDate(c.fecha)} · ${esc(c.descripcion)} · ${fmt(c.monto)}</option>`).join('')}</select></label>
          <label class="span-2">Notas <input name="notas" value="${esc(m.notas)}"></label>
        </div>
        <div class="split-box" style="margin-top:16px">
        <div class="card-head" style="margin:0"><h3>¿Quién lo paga?</h3><span id="sp-status" class="status-line"></span></div>
        <div id="splits" style="display:flex;flex-direction:column;gap:6px"></div>
        <div class="toolbar">
          <div class="left">
            <button type="button" class="btn small" id="sp-add">+ Responsable</button>
            <button type="button" class="btn small" id="sp-equal">Partes iguales</button>
            <button type="button" class="btn small" id="sp-rest">Resto al último</button>
            <button type="button" class="btn small" id="sp-copy" ${m.tipo === 'devolucion' ? '' : 'hidden'}>Copiar reparto de la compra</button>
          </div>
        </div>
        </div>
        <div class="actions" style="margin-top:1rem">
          <button type="button" class="btn" data-act="close">Cancelar</button>
          <button class="btn primary">Guardar</button>
        </div>
      </form>`);

    const form = $('#form-mov');
    const montoVal = () => r2(form.monto.value);
    const drawSplits = () => {
      $('#splits').innerHTML = splits.map((s, i) => `<div class="split-row" data-i="${i}">
        <select data-k="responsable">${respOpts(s.responsable)}</select>
        <input type="number" step="0.01" data-k="monto" value="${s.monto === '' ? '' : s.monto}" placeholder="Monto">
        <input class="concepto" data-k="concepto" value="${esc(s.concepto)}" placeholder="Concepto (opcional)">
        <button type="button" class="btn small ghost danger" data-rm="${i}" aria-label="Quitar">✕</button></div>`).join('');
      status();
    };
    const status = () => {
      const tot = r2(splits.reduce((s, x) => s + Number(x.monto || 0), 0));
      const diff = r2(montoVal() - tot);
      $('#sp-status').innerHTML = diff === 0 && montoVal()
        ? `<span class="badge good">✓ Asignado ${fmt(tot)}</span>`
        : `<span class="badge ${diff > 0 ? 'warn' : 'bad'}">Asignado ${fmt(tot)} · ${diff > 0 ? 'faltan' : 'sobran'} ${fmt(Math.abs(diff))}</span>`;
    };
    $('#splits').addEventListener('input', e => {
      const row = e.target.closest('.split-row');
      if (!row) return;
      const s = splits[Number(row.dataset.i)];
      s[e.target.dataset.k] = e.target.dataset.k === 'monto' ? e.target.value : e.target.value;
      if (e.target.dataset.k === 'responsable' && splits.length === 1 && !s.monto) { s.monto = montoVal(); drawSplits(); return; }
      status();
    });
    $('#splits').addEventListener('click', e => {
      const rm = e.target.closest('[data-rm]');
      if (!rm) return;
      splits.splice(Number(rm.dataset.rm), 1);
      if (!splits.length) splits.push({ responsable: '', monto: '', concepto: '' });
      drawSplits();
    });
    $('#sp-add').onclick = () => { splits.push({ responsable: '', monto: '', concepto: '' }); drawSplits(); };
    $('#sp-equal').onclick = () => {
      const act = splits.filter(s => s.responsable);
      if (!act.length) { toast('Elige primero los responsables'); return; }
      const total = montoVal();
      const part = Math.floor(total / act.length * 100) / 100;
      act.forEach((s, i) => { s.monto = i === act.length - 1 ? r2(total - part * (act.length - 1)) : part; });
      drawSplits();
    };
    $('#sp-rest').onclick = () => {
      const last = splits[splits.length - 1];
      const others = r2(splits.slice(0, -1).reduce((s, x) => s + Number(x.monto || 0), 0));
      last.monto = r2(montoVal() - others);
      drawSplits();
    };
    $('#sp-copy').onclick = () => {
      const orig = S.data.movimientos.find(x => x.id === form.ref_id.value);
      if (!orig) { toast('Selecciona la compra original'); return; }
      splits = proportional(asigOf(orig.id), Number(orig.monto), montoVal());
      if (!splits.length) splits = [{ responsable: '', monto: '', concepto: '' }];
      drawSplits();
    };
    // Crédito con fecha de corte: el periodo de un cargo lo define su fecha
    const syncPeriodo = () => {
      const probe = { tipo: form.tipo.value, tarjeta: form.tarjeta.value, msi_actual: form.msi_actual.value };
      const dia = diaCorte(form.tarjeta.value);
      if (periodoPorFecha(probe) && form.fecha.value) {
        // el corte de su fecha, o el siguiente si el banco lo registró después del corte
        const corte = periodoDeCorte(form.fecha.value, dia), sig = shiftPeriod(corte, 1);
        if (form.periodo.value !== corte && form.periodo.value !== sig) form.periodo.value = corte;
        form.periodo.min = corte; form.periodo.max = sig;
        $('#periodo-hint').textContent = 'Corte día ' + dia + ': ' + periodLabel(corte) + ' (o ' + periodLabel(sig) + ' si el banco lo registró después)';
      } else {
        if (form.periodo.min) form.periodo.value = m.periodo || form.periodo.value; // deja de ser automático
        form.periodo.min = ''; form.periodo.max = '';
        $('#periodo-hint').textContent = dia && form.tipo.value === 'devolucion' ? 'Las devoluciones pueden ir en cualquier periodo' : dia ? 'Mensualidad MSI: periodo en que se cobra' : '';
      }
    };
    form.fecha.addEventListener('change', syncPeriodo);
    form.tarjeta.addEventListener('change', syncPeriodo);
    form.msi_actual.addEventListener('input', syncPeriodo);
    form.tipo.onchange = () => {
      $('#ref-wrap').hidden = form.tipo.value !== 'devolucion';
      $('#sp-copy').hidden = form.tipo.value !== 'devolucion';
      $('#dev-hint').hidden = !(form.tipo.value === 'devolucion' && isNew);
      syncPeriodo();
    };
    form.ref_id.onchange = () => {
      const orig = S.data.movimientos.find(x => x.id === form.ref_id.value);
      if (orig) {
        form.tarjeta.value = orig.tarjeta;
        if (!form.categoria.value) form.categoria.value = orig.categoria;
        if (!form.descripcion.value) form.descripcion.value = 'DEVOLUCIÓN ' + orig.descripcion;
      }
    };
    form.monto.oninput = status;
    form.descripcion.onblur = () => {
      const msi = parseMSI(form.descripcion.value);
      if (msi && !form.msi_total.value) { form.msi_actual.value = msi.actual; form.msi_total.value = msi.total; syncPeriodo(); }
      if (!form.categoria.value) {
        const g = guessCategoria(form.descripcion.value);
        if (g) form.categoria.value = g;
      }
    };
    drawSplits();
    syncPeriodo();

    form.addEventListener('submit', ev => {
      ev.preventDefault();
      if (form.dataset.busy) return;
      syncPeriodo();
      const asign = splits.filter(s => s.responsable && Number(s.monto));
      const tot = r2(asign.reduce((s, x) => s + Number(x.monto), 0));
      if (tot !== montoVal() && !confirm(`El reparto (${fmt(tot)}) no coincide con el monto (${fmt(montoVal())}). ¿Guardar de todos modos?`)) return;
      const mov = {
        id: m.id, periodo: form.periodo.value, tarjeta: form.tarjeta.value, fecha: form.fecha.value,
        descripcion: form.descripcion.value.trim(), monto: montoVal(), tipo: form.tipo.value, categoria: form.categoria.value,
        msi_actual: form.msi_actual.value, msi_total: form.msi_total.value,
        ref_id: form.tipo.value === 'devolucion' ? form.ref_id.value : '', notas: form.notas.value,
      };
      return guardando(form, async () => {
        let ok = false;
        try {
          await api('saveMovimiento', { movimiento: mov, asignaciones: asign.map(s => ({ responsable: s.responsable, monto: Number(s.monto), concepto: s.concepto })) });
          ok = true;
          closeModal(); toast('Guardado');
          const otroPeriodo = mov.periodo !== S.periodo;
          if (otroPeriodo) { S.periodo = mov.periodo; toast('Guardado en ' + periodLabel(mov.periodo)); }
          await refreshCatalogs();
          await loadPeriodo();
        } catch (e) { toast(e.message); }
        if (ok && mov.tipo === 'cargo') avisoTrasGuardar(isNew ? 'Nuevo gasto' : 'Gasto actualizado');
      });
    });
  }

  function proportional(asigs, origMonto, newMonto) {
    if (!asigs.length || !origMonto) return [];
    const out = asigs.map(a => ({ responsable: a.responsable, concepto: a.concepto || '', monto: r2(Number(a.monto) / origMonto * newMonto) }));
    const diff = r2(newMonto - out.reduce((s, x) => s + x.monto, 0));
    if (diff) out[out.length - 1].monto = r2(out[out.length - 1].monto + diff);
    return out;
  }

  /* ============================ Importar Excel ============================ */

  const CAT_RULES = [
    [/\bGAS\b|GASOLIN|PEMEX|OXXO GAS|SHELL|MOBIL|BP /, 'Gasolina'],
    [/NETFLIX|HBO|YOUTUBE|SPOTIFY|DISNEY|PARAMOUNT|MICROSOFT|XBOX|PRIME VIDEO|AMAZON PRIME|APPLE\.COM|VIX|CRUNCHYROLL|STAR\+/, 'Streaming'],
    [/CINEPOLIS|CINEMEX|TICKET|TAQUILLA|APP TICKETS|ETICKET|BOLETO/, 'Entretenimiento'],
    [/CFE|MEGACABLE|TOTALPLAY|IZZI|AGUA|NATURGY|GAS NATURAL/, 'Servicios'],
    [/TELEFONICA|TELCEL|MOVISTAR|AT&T|ATT /, 'Telefonía'],
    [/COMISION|IVA |INTERES|ANUALIDAD/, 'Comisiones e intereses'],
    [/AIRBNB|HOTEL|VIAJES|AEROMEXICO|VOLARIS|VIVA ?AEROBUS|BOOKING|EXPEDIA|HOT EL/, 'Viajes'],
    [/TOTAL PASS|SMART ?FIT|SPORTS WORLD|GYM/, 'Gimnasio'],
    [/OPTICA|FARMACIA|HOSPITAL|MEDIC|DOCTOR|LABORATORIO/, 'Salud'],
    [/SHEIN|ZARA|H&M|PULL|BERSHKA|C&A|SUBURBIA|NIKE|ADIDAS/, 'Ropa'],
    [/REST |RESTAURANT|TACOS|TORTAS|PIZZA|REBANADAS|STARBUCKS|RAPPI|UBER ?EATS|DIDI ?FOOD|KEEPCASH|BAR /, 'Comida'],
    [/COSTCO|SAMS|SAM'S|WAL ?MART|WALMART|SUPERCENTER|SORIANA|CHEDRAUI|LIVERPOOL|HOME ?DEPOT|BODEGA|LA COMER|HEB/, 'Casa'],
    [/MACSTORE|APPLE STORE|BEST BUY|STEREN|CYBERPUERTA/, 'Tecnología'],
  ];
  function guessCategoria(desc) {
    const d = String(desc || '').toUpperCase();
    const names = S.cat.categorias.map(c => c.nombre);
    for (const [re, cat] of CAT_RULES) if (re.test(d) && names.indexOf(cat) >= 0) return cat;
    return '';
  }
  function descKey(desc) {
    return String(desc || '').toUpperCase()
      .replace(/\(\d{1,3}:\d{1,3}\)/g, ' ')
      .split(/[^A-ZÁÉÍÓÚÑ0-9&+]+/)
      .filter(w => w && !/\d/.test(w))
      .slice(0, 2).join(' ');
  }
  function excelSerialToISO(v) {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(v).trim());
    return m ? m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0') : null;
  }
  function guessPeriodFromName(name) {
    const n = name.toLowerCase();
    const y = (/(20\d{2})/.exec(n) || [])[1];
    const mi = MESES.findIndex(m => n.indexOf(m.toLowerCase()) >= 0);
    return y && mi >= 0 ? y + '-' + String(mi + 1).padStart(2, '0') : null;
  }

  VIEWS.importar = function (el) {
    el.innerHTML = `${pageHead('Importar', 'Estado de cuenta en Excel', 'Formato: A1 = tarjeta · Fecha | Descripción | Monto')}<div class="card panel">
        <h3>Importar movimientos desde Excel</h3>
        <p class="muted">Sube el Excel del estado de cuenta (formato: celda A1 con el nombre de la tarjeta y filas con Fecha | Descripción | Monto).
        Los cargos negativos se toman como devoluciones. Se sugieren categoría y reparto con base en meses anteriores.</p>
        <input type="file" id="imp-file" accept=".xlsx,.xls,.csv">
      </div><div id="imp-preview"></div>`;
    $('#imp-file').addEventListener('change', onImportFile);
    if (S.importRows) drawImport();
  };

  async function onImportFile(ev) {
    const file = ev.target.files[0];
    if (!file) return;
    if (!window.XLSX) { toast('No se pudo cargar la librería de Excel'); return; }
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
    const cardName = typeof (rows[0] || [])[0] === 'string' ? rows[0][0].trim() : '';
    const items = [];
    rows.forEach(r => {
      const fecha = (typeof r[0] === 'number' || r[0] instanceof Date) ? excelSerialToISO(r[0]) : null;
      if (!fecha || typeof r[2] !== 'number' || !r[1]) return;
      items.push({ fecha: fecha, descripcion: String(r[1]).trim(), monto: r[2] });
    });
    if (!items.length) { toast('No se encontraron movimientos en el archivo'); return; }

    const periodo = guessPeriodFromName(file.name) || S.periodo;
    const tarjeta = (S.cat.tarjetas.find(t => t.nombre.toLowerCase() === cardName.toLowerCase()) || {}).nombre
      || (S.tarjeta !== '*' ? S.tarjeta : (S.cat.tarjetas[0] || {}).nombre);
    S.importMeta = { periodo: periodo, tarjeta: tarjeta, archivo: file.name, cardName: cardName };
    S.importRows = items.map(it => ({
      include: true, fecha: it.fecha, descripcion: it.descripcion, monto: Math.abs(r2(it.monto)),
      tipo: it.monto < 0 ? 'devolucion' : 'cargo', categoria: '', splits: [],
    }));
    await applySuggestions();
    drawImport();
  }

  async function applySuggestions() {
    const meta = S.importMeta;
    // historial: este periodo (duplicados) y 3 previos (sugerencias)
    const hist = [];
    const actual = await api('getPeriodo', { periodo: meta.periodo });
    for (let i = 1; i <= 3; i++) {
      try { hist.push(await api('getPeriodo', { periodo: shiftPeriod(meta.periodo, -i) }, { silent: true })); } catch (e) { /* ignore */ }
    }
    const byKey = {};
    [actual].concat(hist).forEach((d, age) => d.movimientos.forEach(m => {
      if (m.tipo === 'devolucion') return;
      const k = descKey(m.descripcion);
      if (!k) return;
      (byKey[k] = byKey[k] || []).push({ m: m, age: age, asig: d.asignaciones.filter(a => a.movimiento_id === m.id) });
    }));
    // Mejor candidato: mismo plan MSI (mes anterior), luego monto más parecido, luego el más reciente.
    const best = r => {
      const cands = byKey[descKey(r.descripcion)];
      if (!cands) return null;
      const msi = parseMSI(r.descripcion);
      const score = c => {
        let s = c.age * 10 + Math.abs(Number(c.m.monto) - r.monto) / Math.max(r.monto, 1) * 100;
        if (msi) s += (Number(c.m.msi_total) === msi.total && Number(c.m.msi_actual) === msi.actual - 1) ? -1000 : 500;
        return s;
      };
      return cands.slice().sort((a, b) => score(a) - score(b))[0];
    };
    const dupKey = m => [m.tarjeta, String(m.fecha).slice(0, 10), r2(m.monto), m.descripcion.trim().toUpperCase()].join('|');
    const existing = new Set(actual.movimientos.map(dupKey));

    const dia = diaCorte(meta.tarjeta);
    S.importRows.forEach(r => {
      r.duplicado = existing.has(dupKey({ tarjeta: meta.tarjeta, fecha: r.fecha, monto: r.monto, descripcion: r.descripcion }));
      const msiR = parseMSI(r.descripcion);
      const esperado = dia && r.tipo === 'cargo' && !(msiR && msiR.actual > 1) ? periodoDeCorte(r.fecha, dia) : null;
      // el corte siguiente es válido: el banco registró el cargo después de la fecha de compra
      r.tardio = !!esperado && shiftPeriod(esperado, 1) === meta.periodo;
      r.fueraCorte = esperado && esperado !== meta.periodo && !r.tardio ? esperado : null;
      if (r.duplicado || r.fueraCorte) r.include = false;
      const h = best(r);
      r.categoria = (h && h.m.categoria) || guessCategoria(r.descripcion);
      r.splits = h ? proportional(h.asig, Number(h.m.monto), r.monto) : [];
      r.sugerido = !!(h && r.splits.length);
    });
  }

  function drawImport() {
    const meta = S.importMeta;
    const rows = S.importRows;
    const sel = rows.filter(r => r.include);
    const tot = r2(sel.reduce((s, r) => s + (r.tipo === 'devolucion' ? -1 : 1) * r.monto, 0));
    $('#imp-preview').innerHTML = `<div class="card table-wrap">
      <div class="toolbar">
        <div class="left">
          <label>Periodo <input type="month" id="imp-periodo" value="${meta.periodo}"></label>
          <label>Tarjeta <select id="imp-tarjeta">${S.cat.tarjetas.map(t => `<option ${t.nombre === meta.tarjeta ? 'selected' : ''}>${esc(t.nombre)}</option>`).join('')}</select></label>
        </div>
        <div class="right">
          <select id="imp-bulk-resp"><option value="">Asignar seleccionados a…</option>${S.cat.responsables.filter(isActive).map(r => `<option>${esc(r.nombre)}</option>`).join('')}</select>
          <select id="imp-bulk-cat"><option value="">Categoría a seleccionados…</option>${S.cat.categorias.filter(isActive).map(c => `<option>${esc(c.nombre)}</option>`).join('')}</select>
        </div>
      </div>
      <p class="muted">${esc(meta.archivo)} · ${rows.length} filas · ${sel.length} seleccionadas · total ${fmt(tot)}${rows.some(r => r.duplicado) ? ' · <span class="badge warn">Algunas ya existen y se desmarcaron</span>' : ''}${rows.some(r => r.fueraCorte) ? ` · <span class="badge bad">${rows.filter(r => r.fueraCorte).length} cargos con fecha fuera del corte (día ${diaCorte(meta.tarjeta)}) se desmarcaron</span>` : ''}</p>
      <table><thead><tr><th><input type="checkbox" id="imp-all" ${sel.length === rows.length ? 'checked' : ''} aria-label="Seleccionar todo"></th><th>Fecha</th><th>Descripción</th><th>Categoría</th><th>Reparto</th><th class="num">Monto</th></tr></thead>
      <tbody>${rows.map((r, i) => `<tr data-i="${i}">
        <td><input type="checkbox" data-k="include" ${r.include ? 'checked' : ''}></td>
        <td>${fmtDate(r.fecha)}</td>
        <td class="desc">${esc(r.descripcion)}<small>${[r.tipo === 'devolucion' ? 'Devolución' : '', r.duplicado ? 'Ya existe' : '', r.fueraCorte ? '<span class="diff-bad">Fuera de corte: corresponde a ' + periodLabel(r.fueraCorte) + '</span>' : '', r.tardio ? 'Registrado por el banco después del corte' : '', r.sugerido ? 'Reparto sugerido por historial' : ''].filter(Boolean).join(' · ')}</small></td>
        <td><select data-k="categoria"><option value="">—</option>${S.cat.categorias.filter(isActive).map(c => `<option ${c.nombre === r.categoria ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('')}</select></td>
        <td><div class="chips">${r.splits.map(s => `<span class="chip">${esc(s.responsable)} ${fmt(s.monto)}</span>`).join('') || '<span class="muted">—</span>'}
          <select data-k="resp" aria-label="Asignar todo a"><option value="">${r.splits.length ? 'Cambiar…' : 'Asignar a…'}</option>${S.cat.responsables.filter(isActive).map(x => `<option>${esc(x.nombre)}</option>`).join('')}</select></div></td>
        <td class="num ${r.tipo === 'devolucion' ? 'neg' : ''}">${fmt((r.tipo === 'devolucion' ? -1 : 1) * r.monto)}</td></tr>`).join('')}</tbody></table>
      <div class="actions" style="margin-top:1rem">
        <button class="btn" id="imp-cancel">Cancelar</button>
        <button class="btn primary" id="imp-go" ${sel.length ? '' : 'disabled'}>Importar ${sel.length} movimientos</button>
      </div>
      <p class="muted">Tip: los repartos entre varias personas (ej. Netflix a medias) se ajustan después en Movimientos → Editar, y se sugerirán automáticamente el siguiente mes.</p>
    </div>`;

    const box = $('#imp-preview');
    box.querySelector('tbody').addEventListener('change', e => {
      const tr = e.target.closest('tr');
      const r = rows[Number(tr.dataset.i)];
      const k = e.target.dataset.k;
      if (k === 'include') {
        if (e.target.checked && r.fueraCorte) { toast('Ese cargo corresponde a ' + periodLabel(r.fueraCorte) + ' por su fecha de corte'); e.target.checked = false; return; }
        r.include = e.target.checked;
      }
      if (k === 'categoria') r.categoria = e.target.value;
      if (k === 'resp' && e.target.value) { r.splits = [{ responsable: e.target.value, monto: r.monto, concepto: '' }]; r.sugerido = false; }
      drawImport();
    });
    $('#imp-all').onchange = e => { rows.forEach(r => { r.include = e.target.checked && !r.fueraCorte; }); drawImport(); };
    $('#imp-periodo').onchange = async e => { meta.periodo = e.target.value; await applySuggestions(); drawImport(); };
    $('#imp-tarjeta').onchange = async e => { meta.tarjeta = e.target.value; await applySuggestions(); drawImport(); };
    $('#imp-bulk-resp').onchange = e => {
      rows.filter(r => r.include).forEach(r => { r.splits = [{ responsable: e.target.value, monto: r.monto, concepto: '' }]; r.sugerido = false; });
      drawImport();
    };
    $('#imp-bulk-cat').onchange = e => { rows.filter(r => r.include).forEach(r => { r.categoria = e.target.value; }); drawImport(); };
    $('#imp-cancel').onclick = () => { S.importRows = null; S.importMeta = null; render(); };
    $('#imp-go').onclick = async ev => {
      const btn = ev.currentTarget;
      if (btn.dataset.busy) return;
      btn.dataset.busy = '1'; btn.disabled = true; loading(true, true);
      try { await importar(); } finally { loading(false); delete btn.dataset.busy; btn.disabled = false; }
    };
    const importar = async () => {
      const items = rows.filter(r => r.include).map(r => {
        const msi = parseMSI(r.descripcion);
        return {
          movimiento: { periodo: meta.periodo, tarjeta: meta.tarjeta, fecha: r.fecha, descripcion: r.descripcion, monto: r.monto,
                        tipo: r.tipo, categoria: r.categoria, msi_actual: msi ? msi.actual : '', msi_total: msi ? msi.total : '', ref_id: '', notas: '' },
          asignaciones: r.splits,
        };
      });
      try {
        const res = await api('importMovimientos', { items: items });
        toast(res.insertados + ' movimientos importados');
        S.importRows = null;
        S.periodo = meta.periodo;
        S.tab = 'movimientos';
        await refreshCatalogs();
        await loadPeriodo();
        avisoTrasGuardar(res.insertados + ' movimientos importados');
      } catch (e) { toast(e.message); }
    };
  }

  /* ============================ Excel ============================ */

  function exportExcel() {
    if (!window.XLSX) { toast('No se pudo cargar la librería de Excel'); return; }
    const wb = XLSX.utils.book_new();
    const movs = movsFiltradas().slice().reverse();
    const ids = {};
    movs.forEach(m => { ids[m.id] = m; });
    const sign = m => (m.tipo === 'devolucion' ? -1 : 1);
    const addSheet = (name, aoa, widths) => {
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      if (widths) ws['!cols'] = widths.map(w => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, ws, name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
    };
    const detalle = n => S.data.asignaciones.filter(a => a.responsable === n && ids[a.movimiento_id])
      .map(a => { const m = ids[a.movimiento_id]; return [m.fecha, m.tarjeta, m.descripcion, a.concepto, m.categoria, m.tipo === 'devolucion' ? 'Devolución' : 'Cargo', r2(sign(m) * a.monto)]; });
    const titulo = periodLabel(S.periodo) + (S.tarjeta !== '*' ? ' · ' + S.tarjeta : '');

    if (isAdmin()) {
      const total = r2(movs.reduce((s, m) => s + net(m), 0));
      const lim = limiteActual();
      const porResp = totalesPorResponsable(movs);
      const sinAsig = r2(movs.reduce((s, m) => s + pendiente(m), 0));
      const porCat = sumBy(movs, m => m.categoria || '(Sin categoría)', net);
      const res = [['Resumen', titulo], [], ['Gasto neto', total], ['Límite', lim === null ? '' : lim],
        ['Disponible', lim === null ? '' : r2(lim - total)], ['% usado', lim ? r2(total / lim * 100) : ''], [],
        ['Responsable', 'Total a pagar']];
      Object.entries(porResp).forEach(([k, v]) => res.push([k, v]));
      if (sinAsig) res.push(['(Sin asignar)', sinAsig]);
      res.push([], ['Categoría', 'Total']);
      Object.entries(porCat).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => res.push([k, v]));
      addSheet('Resumen', res, [28, 16]);

      addSheet('Movimientos', [['Fecha', 'Tarjeta', 'Descripción', 'Categoría', 'Tipo', 'Monto', 'MSI', 'Reparto', 'Sin asignar', 'Notas']]
        .concat(movs.map(m => [m.fecha, m.tarjeta, m.descripcion, m.categoria, m.tipo === 'devolucion' ? 'Devolución' : 'Cargo', r2(net(m)),
          m.msi_total ? m.msi_actual + '/' + m.msi_total : '', asigOf(m.id).map(a => a.responsable + ' ' + r2(a.monto)).join(', '), pendiente(m) || '', m.notas])),
        [11, 10, 42, 18, 11, 12, 7, 40, 11, 20]);

      const det = [['Responsable', 'Fecha', 'Tarjeta', 'Descripción', 'Concepto', 'Categoría', 'Tipo', 'Monto']];
      Object.keys(porResp).forEach(n => detalle(n).forEach(r => det.push([n].concat(r))));
      addSheet('Por responsable', det, [14, 11, 10, 42, 24, 18, 11, 12]);

      S.cat.tarjetas.filter(t => t.tipo === 'credito' && (S.tarjeta === '*' || t.nombre === S.tarjeta)).forEach(t => {
        const c = cuadreData(t.nombre);
        if (!c.movs.length) return;
        const left = Object.entries(c.porResp).sort((x, y) => y[1] - x[1]);
        if (c.dvs) left.push(['Banco · devolventes', c.dvs]);
        if (c.difAsig > 0.009) left.push(['(Sin asignar)', c.difAsig]);
        const right = Object.entries(c.porCat).sort((x, y) => y[1] - x[1]);
        const aoa = [['Cuadre', t.nombre, periodLabel(S.periodo)], [],
          ['Total estado de cuenta (banco)', c.estado === null ? '' : c.estado, '', 'Total movimientos', c.neto], [],
          ['¿Quién lo paga?', 'Monto', '', 'Categoría (estado de cuenta)', 'Monto']];
        for (let i = 0; i < Math.max(left.length, right.length); i++) {
          aoa.push([(left[i] || [])[0] || '', (left[i] || [])[1] === undefined ? '' : left[i][1], '', (right[i] || [])[0] || '', (right[i] || [])[1] === undefined ? '' : right[i][1]]);
        }
        aoa.push(['Total', r2(left.reduce((x, e) => x + e[1], 0)), '', 'Total', c.neto], [],
          ['Estado', Math.abs(c.difAsig) < 0.01 ? 'CUADRADO' : 'DESCUADRE ' + c.difAsig]);
        c.dvMovs.forEach(m => aoa.push(['Devolvente', m.descripcion, '', '', Number(m.monto)]));
        addSheet('Cuadre ' + t.nombre, aoa, [30, 14, 3, 30, 14]);
      });

      Object.keys(porResp).forEach(n => {
        const rows = detalle(n);
        addSheet(n, [['Fecha', 'Tarjeta', 'Descripción', 'Concepto', 'Categoría', 'Tipo', 'Monto']].concat(rows)
          .concat([[], ['', '', '', '', '', 'Total a pagar', porResp[n]]]), [11, 10, 42, 24, 18, 11, 12]);
      });
    } else {
      const n = S.session.responsable;
      const rows = detalle(n);
      const tot = r2(rows.reduce((s, r) => s + r[6], 0));
      addSheet('Mis cargos', [['Responsable', n, titulo], [], ['Fecha', 'Tarjeta', 'Descripción', 'Concepto', 'Categoría', 'Tipo', 'Monto']]
        .concat(rows).concat([[], ['', '', '', '', '', 'Total a pagar', tot]]), [11, 10, 42, 24, 18, 11, 12]);
    }
    const who = isAdmin() ? '' : '_' + S.session.responsable;
    XLSX.writeFile(wb, `Finance_${S.periodo}${S.tarjeta !== '*' ? '_' + S.tarjeta : ''}${who}.xlsx`);
  }

  /* ============================ Eventos globales ============================ */

  document.addEventListener('click', async e => {
    const t = e.target.closest('[data-tab],[data-act]');
    if (!t) return;
    if (t.dataset.tab) {
      S.fromResumen = false;
      if (t.dataset.tab === 'responsables') S.respFocus = '';
      go(t.dataset.tab);
      return;
    }
    const act = t.dataset.act;
    if (act === 'close') closeModal();
    if (act === 'drill') drill(t.dataset.kind, t.dataset.key);
    if (act === 'alert-go' || act === 'alert-pend') goAlert((S.alerts || [])[Number(t.dataset.i)]);
    if (act === 'back') { S.fromResumen = false; S.respFocus = ''; S.movFilter = { q: '', cat: '', resp: '', pendientes: false }; go('resumen'); }
    if (act === 'clear-filter') {
      const k = t.dataset.k;
      if (k === '*') S.movFilter = { q: '', cat: '', resp: '', pendientes: false };
      else S.movFilter[k] = k === 'pendientes' ? false : '';
      render();
    }
    if (act === 'resp-focus') { S.respFocus = t.dataset.key || ''; render(); }
    if (act === 'mis-cat') { S.misCat = ''; render(); }
    if (act === 'new-mov') movModal(null, 'cargo');
    if (act === 'new-dev') movModal(null, 'devolucion');
    if (act === 'edit') movModal(S.data.movimientos.find(m => m.id === t.dataset.id));
    if (act === 'dev-new') devolventeModal(null, t.dataset.tarjeta);
    if (act === 'dev-edit') devolventeModal((S.cat.devolventes || []).find(d => d.id === t.dataset.id));
    if (act === 'del') {
      const m = S.data.movimientos.find(x => x.id === t.dataset.id);
      if (m && confirm(`¿Eliminar "${m.descripcion}" por ${fmt(m.monto)}?`)) {
        try { await api('deleteMovimiento', { id: m.id }); toast('Eliminado'); await loadPeriodo(); } catch (err) { toast(err.message); }
      }
    }
    if (act === 'cat-new') catalogModal(t.dataset.tipo);
    if (act === 'cat-edit') catalogModal(t.dataset.tipo, S.cat[t.dataset.tipo.toLowerCase()].find(x => x.id === t.dataset.id));
    if (act === 'lim-del') {
      try { await api('saveLimite', { periodo: t.dataset.p, tarjeta: t.dataset.t, responsable: t.dataset.r || '', monto: '' }); await refreshCatalogs(); render(); } catch (err) { toast(err.message); }
    }
    if (act === 'user-new') userModal(null);
    if (act === 'user-edit') userModal((S.users || []).find(u => u.usuario === t.dataset.u));
  });

  $('#login-form').addEventListener('submit', onLogin);
  $('#btn-logout').addEventListener('click', () => logout(false));
  $('#api-change').addEventListener('click', () => { $('#api-field').hidden = false; $('#api-change').hidden = true; $('#login-form').api.focus(); });

  /* Barra lateral contraíble (se recuerda en este navegador) */
  function setCollapsed(on) {
    $('.app').classList.toggle('collapsed', on);
    const b = $('#btn-collapse');
    b.setAttribute('aria-expanded', String(!on));
    b.title = on ? 'Expandir menú' : 'Contraer menú';
    store.set('finance_sidebar', on ? '1' : null);
  }
  function initSidebar() {
    setCollapsed(store.get('finance_sidebar') === '1');
    $('#btn-collapse').addEventListener('click', () => setCollapsed(!$('.app').classList.contains('collapsed')));
  }
  $('#btn-export').addEventListener('click', exportExcel);
  $('#f-periodo').addEventListener('change', e => {
    let p = e.target.value;
    if (p === '__otro') {
      const r = prompt('Mes a consultar o capturar (AAAA-MM):', shiftPeriod(S.periodo, 1));
      p = r && /^\d{4}-(0[1-9]|1[0-2])$/.test(r.trim()) ? r.trim() : '';
      if (r && !p) toast('Formato inválido, usa AAAA-MM (ej. 2026-12)');
    }
    if (!p) { e.target.value = S.periodo; return; }
    S.periodo = p;
    renderPeriodoFilter();
    loadPeriodo().catch(err => toast(err.message));
  });
  $('#f-tarjeta').addEventListener('change', e => { S.tarjeta = e.target.value; render(); });

  // Arranque
  (async function init() {
    initSidebar();
    if (DEMO) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.innerHTML = '<b>Modo demo</b>: datos de ejemplo guardados solo en este navegador. Usuario <code>admin</code> / <code>admin123</code> o <code>consulta</code> / <code>consulta123</code>.';
      $('#login-form').appendChild(p);
    } else if (!(CFG.API_URL || '').trim()) {
      // Sin config local: pedir (o permitir cambiar) la URL del servidor
      const saved = store.get('finance_api');
      $('#api-field').hidden = !!saved;
      $('#api-change').hidden = !saved;
      $('#login-form').api.value = saved || '';
    }
    S.session = loadSession();
    if (S.session && S.session.token) {
      try { await startApp(); return; } catch (e) { S.session = null; }
    }
    $('#login-view').hidden = false;
  })();
})();
