'use strict';
/* =========================================================
   STRIPE — checkout y verificación de webhook.
   Doc: https://stripe.com/docs/payments/checkout
   ========================================================= */
import Stripe from 'stripe';
import { config, providerConfigured } from '../../config.js';

let _stripe = null;
function client(){
  if (!providerConfigured('stripe')) throw httpErr(503, 'Stripe no está configurado en el servidor.');
  if (!_stripe) _stripe = new Stripe(config.stripe.secretKey);
  return _stripe;
}
function httpErr(status, msg){ const e = new Error(msg); e.status = status; return e; }

/** Crea una Checkout Session de pago único para un plan. Devuelve { url, ref }. */
export async function createCheckout(user, plan){
  const priceId = config.stripe.prices[plan];
  if (!priceId) throw httpErr(503, `No hay precio de Stripe configurado para el plan ${plan}.`);
  const session = await client().checkout.sessions.create({
    mode: 'payment',
    line_items: [{ price: priceId, quantity: 1 }],
    customer_email: user.email,
    client_reference_id: user.id,
    metadata: { userId: user.id, plan },
    success_url: `${config.frontendUrl}/?pago=ok&proveedor=stripe`,
    cancel_url: `${config.frontendUrl}/?pago=cancelado`,
  });
  return { url: session.url, ref: session.id };
}

/** Verifica la firma del webhook y devuelve el evento de Stripe. */
export function constructEvent(rawBody, signature){
  return client().webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
}

/** Traduce un evento `checkout.session.completed` a datos de concesión de plan. */
export function extractGrant(event){
  if (event.type !== 'checkout.session.completed') return null;
  const s = event.data.object;
  if (s.payment_status !== 'paid') return null;
  return {
    eventId: event.id,
    userId: s.metadata?.userId || s.client_reference_id,
    plan: s.metadata?.plan,
    providerRef: s.id,
    amount: s.amount_total != null ? (s.amount_total / 100).toFixed(2) : null,
    currency: (s.currency || '').toUpperCase(),
  };
}
