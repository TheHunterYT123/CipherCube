'use strict';
/* =========================================================
   GRANT — aplica una concesión de plan tras un pago confirmado.
   Idempotente: registra el evento del proveedor y, si ya se procesó,
   no vuelve a conceder (evita doble crédito por reintentos de webhook).
   ========================================================= */
import { query } from '../../db/pool.js';
import { grantPlan } from '../user.service.js';
import { isPaidPlan } from '../plan.service.js';

/**
 * @param {string} provider  'stripe' | 'paypal' | 'mercadopago'
 * @param {object} grant     { eventId, userId, plan, providerRef, amount, currency }
 * @returns {boolean} true si concedió ahora, false si ya estaba procesado o inválido.
 */
export async function applyGrant(provider, grant){
  if (!grant || !grant.userId || !isPaidPlan(grant.plan)) return false;

  // Idempotencia por evento.
  const ins = await query(
    `INSERT INTO webhook_events (provider, event_id) VALUES ($1,$2)
     ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`,
    [provider, grant.eventId]
  );
  if (ins.rowCount === 0) return false; // ya procesado

  // Registra el pago (idempotente por provider+ref).
  await query(
    `INSERT INTO payments (user_id, provider, provider_ref, plan_key, amount, currency, status)
     VALUES ($1,$2,$3,$4,$5,$6,'paid')
     ON CONFLICT (provider, provider_ref)
       DO UPDATE SET status='paid', updated_at=now()`,
    [grant.userId, provider, grant.providerRef, grant.plan, grant.amount, grant.currency]
  );

  // Concede el plan. Compra única → sin expiración (durationDays undefined → NULL).
  await grantPlan(grant.userId, grant.plan, {});
  return true;
}
