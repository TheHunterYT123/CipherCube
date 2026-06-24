'use strict';
/* =========================================================
   MERCADOPAGO — preferencia de pago (Checkout Pro) + consulta de pago.
   Flujo: el backend crea una preferencia, el frontend redirige a
   init_point; MercadoPago notifica por webhook al confirmarse.
   Doc: https://www.mercadopago.com.mx/developers/es/docs/checkout-pro
   ========================================================= */
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
import { config, providerConfigured } from '../../config.js';

function httpErr(status, msg){ const e = new Error(msg); e.status = status; return e; }

let _mp = null;
function mp(){
  if (!providerConfigured('mercadopago')) throw httpErr(503, 'MercadoPago no está configurado en el servidor.');
  if (!_mp) _mp = new MercadoPagoConfig({ accessToken: config.mercadopago.accessToken });
  return _mp;
}

/** Crea una preferencia de pago. Devuelve { id, url }. */
export async function createPreference(user, plan, amount, currency){
  const pref = new Preference(mp());
  const res = await pref.create({
    body: {
      items: [{
        id: `ciphercube-${plan}`,
        title: `CipherCube — plan ${plan}`,
        quantity: 1,
        unit_price: Number(amount),
        currency_id: currency.toUpperCase(),
      }],
      payer: { email: user.email },
      external_reference: `${user.id}|${plan}`,
      metadata: { user_id: user.id, plan },
      back_urls: {
        success: `${config.frontendUrl}/?pago=ok&proveedor=mercadopago`,
        failure: `${config.frontendUrl}/?pago=cancelado`,
        pending: `${config.frontendUrl}/?pago=pendiente`,
      },
      auto_return: 'approved',
      notification_url: `${config.publicBackendUrl}/api/payments/webhook/mercadopago`,
    },
  });
  return { id: res.id, url: res.init_point };
}

/** Consulta un pago por id y, si está aprobado, devuelve datos de concesión. */
export async function fetchPaymentGrant(paymentId){
  const payment = new Payment(mp());
  const p = await payment.get({ id: paymentId });
  if (p.status !== 'approved') return null;
  const ref = p.external_reference || (p.metadata ? `${p.metadata.user_id}|${p.metadata.plan}` : '');
  const [userId, plan] = String(ref).split('|');
  return {
    eventId: String(paymentId),
    userId, plan,
    providerRef: String(paymentId),
    amount: p.transaction_amount != null ? String(p.transaction_amount) : null,
    currency: p.currency_id || null,
  };
}
