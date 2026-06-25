'use strict';
/* =========================================================
   ADMIN — panel de administración (solo frontend, datos de ejemplo).

   TODO está detrás de `AdminAPI`: hoy devuelve datos mock; mañana cada
   método se cambia por un fetch a `/api/admin/*` y el resto del panel
   sigue igual. Así el frontend ya queda "cableado" para el backend.

   Acceso: botón en Perfil (solo para correos admin) o `#admin` en la URL.
   El control de acceso REAL se hará en el servidor cuando exista el backend.
   ========================================================= */
import { showToast } from './ui.js';
import { admin as adminApi } from './api.js';

/* Correos con acceso al panel: PISTA visual para el frontend (mostrar/ocultar
   el botón). El control de acceso REAL lo hace el backend con users.is_admin;
   estas rutas devuelven 403 a cualquier cuenta no-admin. */
export const ADMIN_EMAILS = ['thehunter9856@gmail.com'];

/* ---------- Utilidades de formato ---------- */
function fmtMoney(n, cur = 'USD'){
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency: cur, maximumFractionDigits: 2 }).format(n);
}
function fmtNum(n){ return new Intl.NumberFormat('es-MX').format(n); }
function fmtDate(d){ return new Date(d).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' }); }
function fmtDateTime(d){ return new Date(d).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
function timeAgo(d){
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return 'hace un momento';
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  return `hace ${Math.floor(s / 86400)} d`;
}
function esc(s){ return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* ---------- Etiquetas ---------- */
const PROVIDER_LABEL = { stripe: 'Stripe', paypal: 'PayPal', mercadopago: 'MercadoPago' };

/* ---------- Capa de datos (backend real: /api/admin/*) ----------
   Las colecciones (users/purchases/attempts/logs) se cachean en memoria para
   que el drawer de usuario pueda cruzarlas sin repetir peticiones. El botón
   "Actualizar" limpia la caché. Los agregados (overview/stats/settings) se
   piden siempre frescos. El backend exige sesión admin (responde 403 si no). */
let _coll = {};
export function clearAdminCache(){ _coll = {}; }
async function getColl(name){
  if (!_coll[name]) _coll[name] = await adminApi[name]();
  return _coll[name];
}

export const AdminAPI = {
  overview(){ return adminApi.overview(); },
  users(){ return getColl('users'); },
  purchases(){ return getColl('purchases'); },
  attempts(){ return getColl('attempts'); },
  logs(){ return getColl('logs'); },
  stats(){ return adminApi.stats(); },
  settings(){ return adminApi.settings(); },
};

/* ---------- Componentes de gráfico (SVG) ---------- */
function lineChart(series, { height = 120, money = false } = {}){
  const w = 320, h = height, pad = 6;
  const vals = series.map(s => s.value);
  const max = Math.max(1, ...vals);
  const stepX = (w - pad * 2) / Math.max(1, series.length - 1);
  const y = v => h - pad - (v / max) * (h - pad * 2);
  const pts = series.map((s, i) => [pad + i * stepX, y(s.value)]);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const area = `${line} L ${pts[pts.length - 1][0].toFixed(1)} ${h - pad} L ${pad} ${h - pad} Z`;
  const grid = [0.25, 0.5, 0.75, 1].map(f => `<line class="grid-line" x1="${pad}" y1="${(h - pad - f * (h - pad * 2)).toFixed(1)}" x2="${w - pad}" y2="${(h - pad - f * (h - pad * 2)).toFixed(1)}"/>`).join('');
  const total = vals.reduce((a, b) => a + b, 0);
  const totalLabel = money ? fmtMoney(total) : fmtNum(total);
  return `<svg class="chart-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Serie: ${totalLabel}">${grid}<path class="area" d="${area}"/><path class="line" d="${line}"/></svg>`;
}
function barChart(series, { height = 120 } = {}){
  const w = 320, h = height, pad = 6;
  const vals = series.map(s => s.value);
  const max = Math.max(1, ...vals);
  const n = series.length;
  const bw = (w - pad * 2) / n * 0.62;
  const gap = (w - pad * 2) / n;
  const bars = series.map((s, i) => {
    const bh = (s.value / max) * (h - pad * 2);
    const x = pad + i * gap + (gap - bw) / 2;
    return `<rect class="bar" x="${x.toFixed(1)}" y="${(h - pad - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="1.5"/>`;
  }).join('');
  return `<svg class="chart-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${bars}</svg>`;
}
const PLAN_COLOR = { free: '#8E8E93', plus: '#0072B2', boveda: '#CC79A7' };
function donutChart(dist){
  const entries = Object.entries(dist);
  const total = entries.reduce((s, [, v]) => s + v, 0) || 1;
  const r = 52, c = 64, sw = 22, circ = 2 * Math.PI * r;
  let offset = 0;
  const segs = entries.map(([k, v]) => {
    const frac = v / total;
    const seg = `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${PLAN_COLOR[k]}" stroke-width="${sw}" stroke-dasharray="${(frac * circ).toFixed(2)} ${circ.toFixed(2)}" stroke-dashoffset="${(-offset * circ).toFixed(2)}" transform="rotate(-90 ${c} ${c})"/>`;
    offset += frac;
    return seg;
  }).join('');
  const legend = entries.map(([k, v]) => `<div class="dl-row"><span class="dl-swatch" style="background:${PLAN_COLOR[k]}"></span><span>${planLabel(k)}</span><span class="dl-val">${v} · ${Math.round(v / total * 100)}%</span></div>`).join('');
  return `<div class="donut-wrap"><svg width="128" height="128" viewBox="0 0 128 128">${segs}<text x="64" y="60" text-anchor="middle" font-size="20" font-weight="800" fill="var(--color-text)">${total}</text><text x="64" y="78" text-anchor="middle" font-size="10" fill="var(--color-text-secondary)">usuarios</text></svg><div class="donut-legend">${legend}</div></div>`;
}

/* ---------- Helpers de badges ---------- */
function planLabel(p){ return { free: 'Básico', plus: 'Plus', boveda: 'Bóveda' }[p] || p; }
function planBadge(p){ return `<span class="badge-pill bp-${p}">${planLabel(p)}</span>`; }
function statusBadge(s){
  const label = { paid: 'Pagado', refunded: 'Reembolsado', active: 'Activo', inactive: 'Inactivo', abandoned: 'Abandonado', started: 'Iniciado', completed: 'Completado', failed: 'Fallido', pending: 'Pendiente' }[s] || s;
  return `<span class="badge-pill bp-${s}">${label}</span>`;
}
function sevBadge(s){ return `<span class="badge-pill bp-${s}">${({ info: 'info', warn: 'aviso', error: 'error' }[s] || s)}</span>`; }

/* ---------- Estado del panel ---------- */
let mounted = false;
let currentTab = 'overview';
const filters = { users: { q: '', plan: 'all' }, purchases: { q: '', provider: 'all' }, attempts: { outcome: 'all' }, logs: { q: '', sev: 'all' } };

const TABS = [
  ['overview', 'Resumen', '<path d="M3 13h8V3H3zM13 21h8v-6h-8zM13 11h8V3h-8zM3 21h8v-6H3z"/>'],
  ['users', 'Usuarios', '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20c0-3 2.5-5 5.5-5s5.5 2 5.5 5"/><path d="M16 4.5a3 3 0 0 1 0 7"/><path d="M20.5 20c0-2.4-1.4-4.2-3.5-4.8"/>'],
  ['purchases', 'Compras', '<path d="M6 8h12l-1 12H7z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>'],
  ['attempts', 'Intentos', '<path d="M3 3h2l2.4 12.4a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.6L21 8H6"/><circle cx="10" cy="20" r="1"/><circle cx="18" cy="20" r="1"/>'],
  ['logs', 'Logs', '<path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h8M8 16h5"/>'],
  ['stats', 'Estadísticas', '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'],
  ['settings', 'Ajustes', '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/>'],
];

/* ---------- Render de cada sección ---------- */
async function renderOverview(el){
  const o = await AdminAPI.overview();
  const kpi = (label, value, trend, dir) => `<div class="kpi-card"><div class="k-label">${label}</div><div class="k-value">${value}</div>${trend ? `<div class="k-trend ${dir}">${dir === 'up' ? '▲' : dir === 'down' ? '▼' : '■'} ${trend}</div>` : ''}</div>`;
  el.innerHTML = `
    <div class="admin-section-head"><div><h2>Resumen</h2><div class="ash-sub">Vista general de tu negocio</div></div></div>
    <div class="kpi-grid">
      ${kpi('Usuarios totales', fmtNum(o.totalUsers), `${o.newUsers30} nuevos (30 d)`, 'up')}
      ${kpi('Ingresos totales', fmtMoney(o.revenue), `${fmtMoney(o.revenue30)} (30 d)`, 'up')}
      ${kpi('Usuarios activos', fmtNum(o.activeUsers), `${Math.round(o.activeUsers / o.totalUsers * 100)}% del total`, 'flat')}
      ${kpi('Conversión', `${(o.conversion * 100).toFixed(1)}%`, 'clic → compra', 'flat')}
    </div>
    <div class="chart-grid">
      <div class="chart-card"><div class="cc-title">Ingresos · últimos 30 días</div><div class="cc-sub">Total ${fmtMoney(o.revenueSeries.reduce((s, x) => s + x.value, 0))}</div>${lineChart(o.revenueSeries, { money: true })}</div>
      <div class="chart-card"><div class="cc-title">Registros · últimos 30 días</div><div class="cc-sub">${fmtNum(o.signupSeries.reduce((s, x) => s + x.value, 0))} nuevos usuarios</div>${barChart(o.signupSeries)}</div>
      <div class="chart-card"><div class="cc-title">Distribución de planes</div><div class="cc-sub">Usuarios por plan</div>${donutChart(o.planDistribution)}</div>
    </div>
    <div class="admin-section-head"><div><h2 style="font-size:16px">Actividad reciente</h2></div></div>
    <div class="activity-list">${o.recent.map(l => `
      <div class="activity-row"><div class="activity-ic">${l.icon}</div>
        <div class="activity-main"><div class="am-title">${esc(l.message)}</div><div class="am-sub">${sevBadge(l.severity)} · ${l.type}</div></div>
        <div class="activity-time">${timeAgo(l.createdAt)}</div></div>`).join('')}</div>`;
}

function tableShell(toolbar, tableHtml, footText){
  return `${toolbar}<div class="admin-table-wrap"><div class="admin-table-scroll">${tableHtml}</div>${footText ? `<div class="admin-table-foot">${footText}</div>` : ''}</div>`;
}

async function renderUsers(el){
  const all = await AdminAPI.users();
  const draw = () => {
    const f = filters.users;
    const rows = all.filter(u =>
      (f.plan === 'all' || u.plan === f.plan) &&
      (!f.q || u.email.toLowerCase().includes(f.q) || u.name.toLowerCase().includes(f.q)));
    const body = rows.length ? rows.map(u => `
      <tr class="clickable" data-user="${u.id}">
        <td class="cell-strong">${u.flag} ${esc(u.name)}</td>
        <td class="cell-mono">${esc(u.email)}</td>
        <td>${planBadge(u.plan)}</td>
        <td>${statusBadge(u.status)}</td>
        <td>${fmtDate(u.createdAt)}</td>
        <td>${timeAgo(u.lastLogin)}</td>
        <td>${u.cubes}</td>
      </tr>`).join('') : `<tr><td colspan="7"><div class="admin-empty">Sin resultados.</div></td></tr>`;
    const table = `<table class="admin-table"><thead><tr><th>Nombre</th><th>Correo</th><th>Plan</th><th>Estado</th><th>Registro</th><th>Último acceso</th><th>Cubos</th></tr></thead><tbody>${body}</tbody></table>`;
    el.querySelector('.admin-table-host').innerHTML = tableShell('', table, `${rows.length} de ${all.length} usuarios`);
    el.querySelectorAll('tr[data-user]').forEach(tr => tr.addEventListener('click', () => openUserDrawer(tr.dataset.user)));
  };
  el.innerHTML = `
    <div class="admin-section-head"><div><h2>Usuarios</h2><div class="ash-sub">${all.length} cuentas registradas</div></div></div>
    <div class="admin-toolbar">
      <div class="admin-search"><input type="text" id="usrSearch" placeholder="Buscar por nombre o correo…"></div>
      <select class="admin-filter" id="usrPlan"><option value="all">Todos los planes</option><option value="free">Básico</option><option value="plus">Plus</option><option value="boveda">Bóveda</option></select>
    </div>
    <div class="admin-table-host"></div>`;
  el.querySelector('#usrSearch').addEventListener('input', e => { filters.users.q = e.target.value.trim().toLowerCase(); draw(); });
  el.querySelector('#usrPlan').addEventListener('change', e => { filters.users.plan = e.target.value; draw(); });
  draw();
}

async function renderPurchases(el){
  const all = await AdminAPI.purchases();
  const draw = () => {
    const f = filters.purchases;
    const rows = all.filter(p =>
      (f.provider === 'all' || p.provider === f.provider) &&
      (!f.q || p.userEmail.toLowerCase().includes(f.q)));
    const total = rows.filter(p => p.status === 'paid').reduce((s, p) => s + p.amount, 0);
    const body = rows.length ? rows.map(p => `
      <tr><td class="cell-mono">${esc(p.id)}</td><td class="cell-mono">${esc(p.userEmail)}</td>
        <td>${planBadge(p.plan)}</td><td class="cell-strong">${fmtMoney(p.amount, p.currency)}</td>
        <td>${PROVIDER_LABEL[p.provider]}</td><td>${statusBadge(p.status)}</td><td>${fmtDateTime(p.createdAt)}</td></tr>`).join('')
      : `<tr><td colspan="7"><div class="admin-empty">Sin compras.</div></td></tr>`;
    const table = `<table class="admin-table"><thead><tr><th>ID</th><th>Cliente</th><th>Plan</th><th>Monto</th><th>Proveedor</th><th>Estado</th><th>Fecha</th></tr></thead><tbody>${body}</tbody></table>`;
    el.querySelector('.admin-table-host').innerHTML = tableShell('', table, `${rows.length} compras · recaudado ${fmtMoney(total)}`);
  };
  el.innerHTML = `
    <div class="admin-section-head"><div><h2>Compras</h2><div class="ash-sub">Pagos procesados</div></div></div>
    <div class="admin-toolbar">
      <div class="admin-search"><input type="text" id="buySearch" placeholder="Buscar por correo…"></div>
      <select class="admin-filter" id="buyProv"><option value="all">Todos los proveedores</option><option value="stripe">Stripe</option><option value="paypal">PayPal</option><option value="mercadopago">MercadoPago</option></select>
    </div>
    <div class="admin-table-host"></div>`;
  el.querySelector('#buySearch').addEventListener('input', e => { filters.purchases.q = e.target.value.trim().toLowerCase(); draw(); });
  el.querySelector('#buyProv').addEventListener('change', e => { filters.purchases.provider = e.target.value; draw(); });
  draw();
}

async function renderAttempts(el){
  const all = await AdminAPI.attempts();
  const completed = all.filter(a => a.outcome === 'completed').length;
  const abandoned = all.filter(a => a.outcome === 'abandoned').length;
  const draw = () => {
    const f = filters.attempts;
    const rows = all.filter(a => f.outcome === 'all' || a.outcome === f.outcome);
    const body = rows.length ? rows.map(a => `
      <tr><td class="cell-mono">${esc(a.userEmail)}</td><td>${planBadge(a.plan)}</td>
        <td>${PROVIDER_LABEL[a.provider]}</td><td>${statusBadge(a.outcome)}</td><td>${fmtDateTime(a.createdAt)}</td></tr>`).join('')
      : `<tr><td colspan="5"><div class="admin-empty">Sin intentos.</div></td></tr>`;
    const table = `<table class="admin-table"><thead><tr><th>Cliente</th><th>Plan</th><th>Proveedor</th><th>Resultado</th><th>Fecha</th></tr></thead><tbody>${body}</tbody></table>`;
    el.querySelector('.admin-table-host').innerHTML = tableShell('', table, `${rows.length} de ${all.length} intentos`);
  };
  const abandonRate = all.length ? Math.round(abandoned / all.length * 100) : 0;
  el.innerHTML = `
    <div class="admin-section-head"><div><h2>Intentos de compra</h2><div class="ash-sub">Quién pulsó “comprar” y qué pasó</div></div></div>
    <div class="kpi-grid">
      <div class="kpi-card"><div class="k-label">Clics en comprar</div><div class="k-value">${all.length}</div></div>
      <div class="kpi-card"><div class="k-label">Completaron</div><div class="k-value">${completed}</div><div class="k-trend up">▲ ${all.length ? Math.round(completed / all.length * 100) : 0}%</div></div>
      <div class="kpi-card"><div class="k-label">Abandonaron</div><div class="k-value">${abandoned}</div><div class="k-trend down">▼ ${abandonRate}%</div></div>
    </div>
    <div class="admin-toolbar">
      <select class="admin-filter" id="atOutcome"><option value="all">Todos los resultados</option><option value="completed">Completado</option><option value="abandoned">Abandonado</option><option value="started">Iniciado</option></select>
    </div>
    <div class="admin-table-host"></div>`;
  el.querySelector('#atOutcome').addEventListener('change', e => { filters.attempts.outcome = e.target.value; draw(); });
  draw();
}

async function renderLogs(el){
  const all = await AdminAPI.logs();
  const draw = () => {
    const f = filters.logs;
    const rows = all.filter(l =>
      (f.sev === 'all' || l.severity === f.sev) &&
      (!f.q || l.message.toLowerCase().includes(f.q) || l.type.includes(f.q)));
    const body = rows.length ? rows.map(l => `
      <tr><td>${l.icon}</td><td class="cell-mono">${l.type}</td><td>${esc(l.message)}</td><td>${sevBadge(l.severity)}</td><td>${fmtDateTime(l.createdAt)}</td></tr>`).join('')
      : `<tr><td colspan="5"><div class="admin-empty">Sin eventos.</div></td></tr>`;
    const table = `<table class="admin-table"><thead><tr><th></th><th>Tipo</th><th>Mensaje</th><th>Nivel</th><th>Fecha</th></tr></thead><tbody>${body}</tbody></table>`;
    el.querySelector('.admin-table-host').innerHTML = tableShell('', table, `${rows.length} de ${all.length} eventos`);
  };
  el.innerHTML = `
    <div class="admin-section-head"><div><h2>Logs de actividad</h2><div class="ash-sub">Eventos del sistema en tiempo real</div></div></div>
    <div class="admin-toolbar">
      <div class="admin-search"><input type="text" id="logSearch" placeholder="Buscar evento…"></div>
      <select class="admin-filter" id="logSev"><option value="all">Todos los niveles</option><option value="info">Info</option><option value="warn">Aviso</option><option value="error">Error</option></select>
    </div>
    <div class="admin-table-host"></div>`;
  el.querySelector('#logSearch').addEventListener('input', e => { filters.logs.q = e.target.value.trim().toLowerCase(); draw(); });
  el.querySelector('#logSev').addEventListener('change', e => { filters.logs.sev = e.target.value; draw(); });
  draw();
}

async function renderStats(el){
  const s = await AdminAPI.stats();
  const maxFunnel = s.funnel[0].value || 1;
  const funnel = s.funnel.map(f => {
    const pct = Math.round(f.value / maxFunnel * 100);
    return `<div class="funnel-row"><div class="f-label">${f.label}</div><div class="funnel-bar-track"><div class="funnel-bar-fill" style="width:${Math.max(pct, 8)}%">${fmtNum(f.value)}</div></div><div class="f-pct">${pct}%</div></div>`;
  }).join('');
  const provTotal = Object.values(s.byProvider).reduce((a, b) => a + b, 0) || 1;
  const provRows = Object.entries(s.byProvider).map(([k, v]) => `<div class="drawer-kv"><span class="dk-label">${PROVIDER_LABEL[k]}</span><span class="dk-val">${fmtMoney(v)} · ${Math.round(v / provTotal * 100)}%</span></div>`).join('');
  const planTotal = Object.values(s.byPlan).reduce((a, b) => a + b, 0) || 1;
  const planRows = Object.entries(s.byPlan).map(([k, v]) => `<div class="drawer-kv"><span class="dk-label">${planLabel(k)}</span><span class="dk-val">${fmtMoney(v)} · ${Math.round(v / planTotal * 100)}%</span></div>`).join('');
  const countryRows = s.topCountries.map(([c, n]) => `<div class="drawer-kv"><span class="dk-label">${c}</span><span class="dk-val">${n} usuarios</span></div>`).join('');
  el.innerHTML = `
    <div class="admin-section-head"><div><h2>Estadísticas</h2><div class="ash-sub">Embudo de conversión y desglose de ingresos</div></div></div>
    <div class="kpi-grid">
      <div class="kpi-card"><div class="k-label">ARPU</div><div class="k-value">${fmtMoney(s.arpu)}</div><div class="k-trend flat">ingreso medio / comprador</div></div>
      <div class="kpi-card"><div class="k-label">Tasa de reembolso</div><div class="k-value">${(s.refundRate * 100).toFixed(1)}%</div></div>
      <div class="kpi-card"><div class="k-label">Conversión global</div><div class="k-value">${Math.round(s.funnel[3].value / s.funnel[0].value * 100)}%</div><div class="k-trend flat">visita → compra</div></div>
    </div>
    <div class="chart-card" style="margin-bottom:14px"><div class="cc-title">Embudo de conversión</div><div class="cc-sub">De la visita a la compra</div><div class="funnel">${funnel}</div></div>
    <div class="chart-grid">
      <div class="chart-card"><div class="cc-title">Ingresos por proveedor</div><div class="cc-sub" style="margin-bottom:4px"></div>${provRows}</div>
      <div class="chart-card"><div class="cc-title">Ingresos por plan</div><div class="cc-sub" style="margin-bottom:4px"></div>${planRows}</div>
      <div class="chart-card"><div class="cc-title">Top países</div><div class="cc-sub" style="margin-bottom:4px"></div>${countryRows}</div>
    </div>`;
}

async function renderSettings(el){
  const s = await AdminAPI.settings();
  const provRows = s.providers.map(p => `<div class="drawer-kv"><span class="dk-label">${p.label}</span><span class="dk-val">${p.configured ? statusBadge('active') : statusBadge('inactive')}</span></div>`).join('');
  const priceRows = s.prices.map(p => `<div class="drawer-kv"><span class="dk-label">${p.plan}</span><span class="dk-val">${fmtMoney(p.usd, 'USD')} · ${fmtMoney(p.mxn, 'MXN')}</span></div>`).join('');
  const adminList = (s.adminEmails && s.adminEmails.length ? s.adminEmails : ADMIN_EMAILS);
  el.innerHTML = `
    <div class="admin-section-head"><div><h2>Ajustes</h2><div class="ash-sub">Configuración del sistema (lectura)</div></div></div>
    <div class="chart-grid">
      <div class="chart-card"><div class="cc-title">Proveedores de pago</div><div class="cc-sub">Estado según el backend</div>${provRows}</div>
      <div class="chart-card"><div class="cc-title">Precios de planes</div><div class="cc-sub">Configurados en el servidor</div>${priceRows}</div>
    </div>
    <div class="chart-card"><div class="cc-title">Acceso de administrador</div><div class="cc-sub">Cuentas con <code>is_admin</code> en el servidor</div>${adminList.map(e => `<div class="drawer-kv"><span class="dk-label">${esc(e)}</span><span class="dk-val">${statusBadge('active')}</span></div>`).join('')}</div>`;
}

const RENDERERS = { overview: renderOverview, users: renderUsers, purchases: renderPurchases, attempts: renderAttempts, logs: renderLogs, stats: renderStats, settings: renderSettings };

/* ---------- Drawer de usuario ---------- */
async function openUserDrawer(userId){
  const [users, allPurchases, allAttempts] = await Promise.all([
    getColl('users'), getColl('purchases'), getColl('attempts'),
  ]);
  const u = users.find(x => x.id === userId);
  if (!u) return;
  const purchases = allPurchases.filter(p => p.userId === userId);
  const attempts = allAttempts.filter(a => a.userId === userId);
  const body = document.getElementById('adminDrawerBody');
  const spent = purchases.filter(p => p.status === 'paid').reduce((s, p) => s + p.amount, 0);
  body.innerHTML = `
    <div class="drawer-avatar">${esc(u.name.trim()[0] || '?')}</div>
    <div style="font-size:17px;font-weight:800">${esc(u.name)}</div>
    <div class="cell-mono" style="margin-bottom:14px">${esc(u.email)}</div>
    <div class="drawer-kv"><span class="dk-label">Plan</span><span class="dk-val">${planBadge(u.plan)}</span></div>
    <div class="drawer-kv"><span class="dk-label">Estado</span><span class="dk-val">${statusBadge(u.status)}</span></div>
    <div class="drawer-kv"><span class="dk-label">País</span><span class="dk-val">${u.flag} ${u.country}</span></div>
    <div class="drawer-kv"><span class="dk-label">Registro</span><span class="dk-val">${fmtDate(u.createdAt)}</span></div>
    <div class="drawer-kv"><span class="dk-label">Último acceso</span><span class="dk-val">${timeAgo(u.lastLogin)}</span></div>
    <div class="drawer-kv"><span class="dk-label">Cubos creados</span><span class="dk-val">${u.cubes}</span></div>
    <div class="drawer-kv"><span class="dk-label">Total gastado</span><span class="dk-val">${fmtMoney(spent)}</span></div>
    <div class="drawer-subhead">Compras (${purchases.length})</div>
    ${purchases.length ? purchases.map(p => `<div class="drawer-kv"><span class="dk-label">${planLabel(p.plan)} · ${PROVIDER_LABEL[p.provider]}</span><span class="dk-val">${fmtMoney(p.amount)} ${statusBadge(p.status)}</span></div>`).join('') : '<div class="ash-sub">Sin compras.</div>'}
    <div class="drawer-subhead">Intentos de compra (${attempts.length})</div>
    ${attempts.length ? attempts.map(a => `<div class="drawer-kv"><span class="dk-label">${planLabel(a.plan)} · ${PROVIDER_LABEL[a.provider]}</span><span class="dk-val">${statusBadge(a.outcome)}</span></div>`).join('') : '<div class="ash-sub">Sin intentos.</div>'}`;
  document.getElementById('adminDrawerTitle').textContent = 'Detalle de usuario';
  document.getElementById('adminDrawerBackdrop').classList.add('show');
  document.getElementById('adminDrawer').classList.add('show');
}
function closeUserDrawer(){
  document.getElementById('adminDrawerBackdrop').classList.remove('show');
  document.getElementById('adminDrawer').classList.remove('show');
}

/* ---------- Navegación de tabs ---------- */
async function selectTab(tab){
  currentTab = tab;
  document.querySelectorAll('.admin-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  const content = document.getElementById('adminContentInner');
  content.innerHTML = '<div class="admin-empty">Cargando…</div>';
  try{ await RENDERERS[tab](content); }
  catch(e){ content.innerHTML = `<div class="admin-empty">Error al cargar: ${esc(e.message)}</div>`; }
  document.getElementById('adminContent').scrollTop = 0;
}

/* ---------- Apertura / cierre ---------- */
export function openAdmin(){
  document.getElementById('adminPanel').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  if (window.location.hash !== '#admin') history.replaceState(null, '', '#admin');
  selectTab(currentTab);
}
export function closeAdmin(){
  document.getElementById('adminPanel').classList.add('hidden');
  document.body.style.overflow = '';
  if (window.location.hash === '#admin') history.replaceState(null, '', window.location.pathname);
}

/* ---------- Inicialización ---------- */
export function initAdmin(){
  if (mounted) return;
  mounted = true;
  // Construye los tabs.
  const tabsWrap = document.getElementById('adminTabs');
  tabsWrap.innerHTML = TABS.map(([key, label, icon]) =>
    `<button class="admin-tab${key === 'overview' ? ' active' : ''}" data-tab="${key}"><svg viewBox="0 0 24 24">${icon}</svg>${label}</button>`).join('');
  tabsWrap.querySelectorAll('.admin-tab').forEach(t => t.addEventListener('click', () => selectTab(t.dataset.tab)));

  document.getElementById('adminCloseBtn').addEventListener('click', closeAdmin);
  document.getElementById('adminRefreshBtn').addEventListener('click', () => { clearAdminCache(); selectTab(currentTab); showToast('Datos actualizados.'); });
  document.getElementById('adminDrawerClose').addEventListener('click', closeUserDrawer);
  document.getElementById('adminDrawerBackdrop').addEventListener('click', closeUserDrawer);

  // Abrir con #admin en la URL.
  if (window.location.hash === '#admin') openAdmin();
  window.addEventListener('hashchange', () => {
    if (window.location.hash === '#admin') openAdmin();
  });
}

/** ¿El correo dado tiene acceso al panel? (provisional; el backend manda). */
export function isAdminEmail(email){
  return !!email && ADMIN_EMAILS.includes(String(email).toLowerCase());
}
