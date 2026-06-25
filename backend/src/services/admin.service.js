'use strict';
/* =========================================================
   ADMIN SERVICE — agregados reales para el panel de administración.
   Devuelve exactamente la forma que consume `js/admin.js` (AdminAPI),
   pero calculada desde la base de datos en vez de datos de ejemplo.

   Nota de honestidad: el cifrado de CipherCube ocurre en el navegador, así
   que el servidor NO conoce el nº de "cubos" ni el país del usuario. Esos
   campos se devuelven neutros (0 / '—') en lugar de inventarlos.
   ========================================================= */
import { query } from '../db/pool.js';
import { config, providerConfigured } from '../config.js';

const DAY_MS = 86400_000;
const ACTIVE_WINDOW_DAYS = 25;

/** Normaliza un timestamp a epoch ms. Acepta epoch (number), Date (PostgreSQL)
 *  o texto SQLite ('YYYY-MM-DD HH:MM:SS' en UTC). */
function toMs(ts){
  if (ts == null) return null;
  if (typeof ts === 'number') return ts;
  if (ts instanceof Date) return ts.getTime();
  const s = String(ts);
  const norm = s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
  const ms = Date.parse(norm);
  return Number.isNaN(ms) ? null : ms;
}

const LOG_ICON = {
  register: '🆕', login: '🔓', login_failed: '⚠️', logout: '🚪',
  password_changed: '🔑', profile_updated: '✏️', checkout_started: '🛒',
  payment_succeeded: '💳', payment_failed: '❌', plan_granted: '⭐',
  rate_limited: '🚧', admin_access: '🛡️', server_error: '🔥',
};
function iconFor(type){ return LOG_ICON[type] || '📝'; }

function nameFromEmail(email){ return (email || '').split('@')[0] || 'usuario'; }

/* ---------- Colecciones ---------- */

export async function listUsers(){
  const { rows } = await query(
    `SELECT id, email, display_name, plan, plan_expires_at, last_login_at, created_at, is_admin
     FROM users ORDER BY created_at DESC`
  );
  const now = Date.now();
  return rows.map(u => {
    const lastLogin = toMs(u.last_login_at);
    const active = lastLogin != null && (now - lastLogin) < ACTIVE_WINDOW_DAYS * DAY_MS;
    return {
      id: u.id,
      name: u.display_name || nameFromEmail(u.email),
      email: u.email,
      plan: u.plan || 'free',
      createdAt: toMs(u.created_at),
      lastLogin,
      status: active ? 'active' : 'inactive',
      isAdmin: !!u.is_admin,
      country: '—', flag: '🌐',
      cubes: 0, // el conteo de cubos vive en el cliente (cifrado local).
    };
  });
}

export async function listPurchases(){
  const { rows } = await query(
    `SELECT p.id, p.user_id, u.email AS user_email, p.plan_key, p.amount,
            p.currency, p.provider, p.status, p.created_at
     FROM payments p LEFT JOIN users u ON u.id = p.user_id
     ORDER BY p.created_at DESC`
  );
  return rows.map(p => ({
    id: p.id, userId: p.user_id, userEmail: p.user_email || '—',
    plan: p.plan_key, amount: p.amount, currency: (p.currency || 'usd').toUpperCase(),
    provider: p.provider, status: p.status, createdAt: toMs(p.created_at),
  }));
}

export async function listAttempts(){
  const { rows } = await query(
    `SELECT id, user_id, user_email, plan_key, provider, currency, outcome, created_at
     FROM checkout_attempts ORDER BY created_at DESC`
  );
  return rows.map(a => ({
    id: a.id, userId: a.user_id, userEmail: a.user_email || '—',
    plan: a.plan_key, provider: a.provider, currency: a.currency,
    outcome: a.outcome, createdAt: toMs(a.created_at),
  }));
}

export async function listLogs(limit = 200){
  const { rows } = await query(
    `SELECT id, type, severity, message, user_email, created_at
     FROM audit_logs ORDER BY created_at DESC LIMIT ?`,
    [limit]
  );
  return rows.map(l => ({
    id: l.id, type: l.type, severity: l.severity, icon: iconFor(l.type),
    message: l.message, userEmail: l.user_email, createdAt: toMs(l.created_at),
  }));
}

/* ---------- Resumen ---------- */

export async function overview(){
  const users = await listUsers();
  const purchases = await listPurchases();
  const logs = await listLogs(8);

  const now = Date.now();
  const monthAgo = now - 30 * DAY_MS;
  const paid = purchases.filter(p => p.status === 'paid');
  const revenue = paid.reduce((s, p) => s + (p.amount || 0), 0);
  const revenue30 = paid.filter(p => p.createdAt >= monthAgo).reduce((s, p) => s + (p.amount || 0), 0);
  const newUsers30 = users.filter(u => u.createdAt >= monthAgo).length;

  const { rows: attemptRows } = await query(`SELECT user_id, outcome FROM checkout_attempts`);
  const buyers = new Set(paid.map(p => p.userId).filter(Boolean)).size;
  const clickers = new Set(attemptRows.map(a => a.user_id).filter(Boolean)).size;

  // Series de 30 días (ingresos y registros) por día.
  const buckets = Array.from({ length: 30 }, (_, i) => {
    const dayEnd = now - (29 - i) * DAY_MS;
    return { date: dayEnd, start: dayEnd - DAY_MS, end: dayEnd, rev: 0, sign: 0 };
  });
  for (const p of paid){
    const b = buckets.find(b => p.createdAt >= b.start && p.createdAt < b.end);
    if (b) b.rev += p.amount || 0;
  }
  for (const u of users){
    const b = buckets.find(b => u.createdAt >= b.start && u.createdAt < b.end);
    if (b) b.sign += 1;
  }

  return {
    totalUsers: users.length,
    activeUsers: users.filter(u => u.status === 'active').length,
    revenue, revenue30, newUsers30,
    conversion: clickers ? buyers / clickers : 0,
    planDistribution: {
      free: users.filter(u => u.plan === 'free').length,
      plus: users.filter(u => u.plan === 'plus').length,
      boveda: users.filter(u => u.plan === 'boveda').length,
    },
    revenueSeries: buckets.map(b => ({ date: b.date, value: b.rev })),
    signupSeries: buckets.map(b => ({ date: b.date, value: b.sign })),
    recent: logs,
  };
}

/* ---------- Estadísticas ---------- */

export async function stats(){
  const purchases = await listPurchases();
  const attempts = await listAttempts();
  const paid = purchases.filter(p => p.status === 'paid');

  const byProvider = { stripe: 0, paypal: 0, mercadopago: 0 };
  const byPlan = {};
  for (const p of paid){
    if (byProvider[p.provider] != null) byProvider[p.provider] += p.amount || 0;
    byPlan[p.plan] = (byPlan[p.plan] || 0) + (p.amount || 0);
  }

  const clicks = attempts.length;
  const started = attempts.filter(a => a.outcome !== 'abandoned').length;
  const completed = attempts.filter(a => a.outcome === 'completed').length;

  const payers = new Set(paid.map(p => p.userId).filter(Boolean)).size;
  const arpu = payers ? paid.reduce((s, p) => s + (p.amount || 0), 0) / payers : 0;
  const refundRate = purchases.length
    ? purchases.filter(p => p.status === 'refunded').length / purchases.length : 0;

  return {
    funnel: [
      { label: 'Clic en comprar', value: clicks },
      { label: 'Inició checkout', value: started },
      { label: 'Pago completado', value: completed },
      { label: 'Plan activo', value: paid.length },
    ],
    byProvider, byPlan, arpu, refundRate,
    topCountries: [], // sin geolocalización en el servidor.
  };
}

/* ---------- Ajustes ---------- */

export async function settings(){
  return {
    providers: [
      { key: 'stripe', label: 'Stripe', configured: providerConfigured('stripe') },
      { key: 'paypal', label: 'PayPal', configured: providerConfigured('paypal') },
      { key: 'mercadopago', label: 'MercadoPago', configured: providerConfigured('mercadopago') },
    ],
    prices: [
      { plan: 'Plus', usd: Number(config.prices.usd.plus), mxn: Number(config.prices.mxn.plus) },
      { plan: 'Bóveda', usd: Number(config.prices.usd.boveda), mxn: Number(config.prices.mxn.boveda) },
    ],
    adminEmails: config.adminEmails,
  };
}
