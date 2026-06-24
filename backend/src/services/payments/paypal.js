'use strict';
/* =========================================================
   PAYPAL — órdenes (create + capture) con el SDK oficial.
   Flujo: el frontend crea la orden, redirige a PayPal para aprobar,
   regresa con el token y el backend captura el pago.
   Doc: https://developer.paypal.com/docs/api/orders/v2/
   ========================================================= */
import paypal from '@paypal/checkout-server-sdk';
import { config, providerConfigured } from '../../config.js';

function httpErr(status, msg){ const e = new Error(msg); e.status = status; return e; }

let _client = null;
function client(){
  if (!providerConfigured('paypal')) throw httpErr(503, 'PayPal no está configurado en el servidor.');
  if (!_client){
    const Env = config.paypal.env === 'live' ? paypal.core.LiveEnvironment : paypal.core.SandboxEnvironment;
    _client = new paypal.core.PayPalHttpClient(new Env(config.paypal.clientId, config.paypal.clientSecret));
  }
  return _client;
}

/** Crea una orden de pago. Devuelve { id, url } (url = enlace de aprobación). */
export async function createOrder(user, plan, amount, currency){
  const request = new paypal.orders.OrdersCreateRequest();
  request.prefer('return=representation');
  request.requestBody({
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: `${user.id}:${plan}`,
      description: `CipherCube — plan ${plan}`,
      custom_id: `${user.id}|${plan}`,
      amount: { currency_code: currency.toUpperCase(), value: String(amount) },
    }],
    application_context: {
      brand_name: 'CipherCube',
      user_action: 'PAY_NOW',
      return_url: `${config.frontendUrl}/?pago=ok&proveedor=paypal`,
      cancel_url: `${config.frontendUrl}/?pago=cancelado`,
    },
  });
  const res = await client().execute(request);
  const approve = (res.result.links || []).find(l => l.rel === 'approve');
  return { id: res.result.id, url: approve ? approve.href : null };
}

/** Captura una orden aprobada. Devuelve datos de concesión si quedó COMPLETED. */
export async function captureOrder(orderId){
  const request = new paypal.orders.OrdersCaptureRequest(orderId);
  request.requestBody({});
  const res = await client().execute(request);
  const result = res.result;
  if (result.status !== 'COMPLETED') return null;
  const unit = result.purchase_units?.[0];
  const custom = unit?.custom_id || unit?.payments?.captures?.[0]?.custom_id || '';
  const [userId, plan] = custom.split('|');
  const cap = unit?.payments?.captures?.[0];
  return {
    eventId: orderId,
    userId, plan,
    providerRef: orderId,
    amount: cap?.amount?.value || null,
    currency: cap?.amount?.currency_code || null,
  };
}
