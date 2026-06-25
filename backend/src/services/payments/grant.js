'use strict';
/* =========================================================
   GRANT — aplica una concesión de plan tras un pago confirmado.
   Idempotente: registra el evento del proveedor y, si ya se procesó,
   no vuelve a conceder (evita doble crédito por reintentos de webhook).
   ========================================================= */
import { randomUUID } from 'node:crypto';
import { query } from '../../db/pool.js';
import { grantPlan, findById } from '../user.service.js';
import { isPaidPlan } from '../plan.service.js';
import { markAttemptCompleted } from '../attempt.service.js';
import { logEvent } from '../audit.service.js';

/**
 * @param {string} provider  'stripe' | 'paypal' | 'mercadopago'
 * @param {object} grant     { eventId, userId, plan, providerRef, amount, currency }
 * @returns {boolean} true si concedió ahora, false si ya estaba procesado o inválido.
 */
export async function applyGrant(provider, grant){
  if (!grant || !grant.userId || !isPaidPlan(grant.plan)) return false;

  // Idempotencia por evento.
  const eventId = randomUUID();
  const { rows: eventRows } = await query(
    `SELECT id FROM webhook_events WHERE provider=? AND event_id=?`,
    [provider, grant.eventId]
  );
  if (eventRows.length > 0) return false; // ya procesado

  await query(
    `INSERT INTO webhook_events (id, provider, event_id) VALUES (?, ?, ?)`,
    [eventId, provider, grant.eventId]
  );

  // Registra el pago (idempotente por provider+ref).
  const paymentId = randomUUID();
  const { rows: existingPayments } = await query(
    `SELECT id FROM payments WHERE provider=? AND provider_ref=?`,
    [provider, grant.providerRef]
  );
  const now = new Date().toISOString();
  if (existingPayments.length > 0){
    await query(
      `UPDATE payments SET status=?, updated_at=? WHERE provider=? AND provider_ref=?`,
      ['paid', now, provider, grant.providerRef]
    );
  } else {
    await query(
      `INSERT INTO payments (id, user_id, provider, provider_ref, plan_key, amount, currency, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [paymentId, grant.userId, provider, grant.providerRef, grant.plan, grant.amount, grant.currency, 'paid', now, now]
    );
  }

  // Concede el plan. Compra única → sin expiración (durationDays undefined → NULL).
  await grantPlan(grant.userId, grant.plan, {});

  // Cierra el embudo y deja rastro en auditoría.
  await markAttemptCompleted({ userId: grant.userId, plan: grant.plan, provider });
  const user = await findById(grant.userId);
  const email = user?.email || grant.userId;
  await logEvent('payment_succeeded', `Pago confirmado de ${email} · ${grant.plan} (${provider})`, {
    userId: grant.userId, userEmail: user?.email,
  });
  await logEvent('plan_granted', `Plan ${grant.plan} concedido a ${email}`, {
    userId: grant.userId, userEmail: user?.email,
  });
  return true;
}
