'use strict';
/* =========================================================
   PAYMENTS ROUTES — inicio de compra (checkout) y captura de PayPal.
   Requieren sesión: se cobra al usuario autenticado, y el plan a conceder
   se ata a su id en el servidor (el cliente no puede pedir un plan ajeno).
   ========================================================= */
import { Router } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { parse, checkoutSchema } from '../utils/validate.js';
import { findById } from '../services/user.service.js';
import { priceFor } from '../services/plan.service.js';
import * as stripe from '../services/payments/stripe.js';
import * as paypal from '../services/payments/paypal.js';
import * as mercadopago from '../services/payments/mercadopago.js';
import { applyGrant } from '../services/payments/grant.js';
import { recordAttempt } from '../services/attempt.service.js';
import { logEvent } from '../services/audit.service.js';

const router = Router();

// ---- Inicia una compra: devuelve la URL a la que redirigir ----
router.post('/checkout', requireAuth, asyncHandler(async (req, res) => {
  const { plan, provider, currency } = parse(checkoutSchema, req.body);
  const user = await findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'Cuenta no encontrada.' });

  // Deja constancia del intento (embudo de conversión del panel).
  await recordAttempt({ userId: user.id, userEmail: user.email, plan, provider, currency });
  await logEvent('checkout_started', `Checkout iniciado (${user.email}) · ${plan}/${provider}`, {
    userId: user.id, userEmail: user.email, ip: req.ip,
  });

  const prices = priceFor(plan);
  const amount = prices ? prices[currency] : null;

  if (provider === 'stripe'){
    const { url } = await stripe.createCheckout(user, plan);
    return res.json({ url, provider });
  }
  if (provider === 'paypal'){
    if (!amount) return res.status(400).json({ error: 'No hay precio configurado para ese plan/moneda.' });
    const { id, url } = await paypal.createOrder(user, plan, amount, currency);
    return res.json({ url, orderId: id, provider });
  }
  if (provider === 'mercadopago'){
    if (!amount) return res.status(400).json({ error: 'No hay precio configurado para ese plan/moneda.' });
    const { url } = await mercadopago.createPreference(user, plan, amount, currency);
    return res.json({ url, provider });
  }
  return res.status(400).json({ error: 'Proveedor de pago no soportado.' });
}));

// ---- Captura de PayPal tras la aprobación del usuario ----
router.post('/paypal/capture', requireAuth, asyncHandler(async (req, res) => {
  const orderId = req.body?.orderId;
  if (!orderId) return res.status(400).json({ error: 'Falta el orderId.' });
  const grant = await paypal.captureOrder(orderId);
  if (!grant) return res.status(402).json({ error: 'El pago de PayPal no se completó.' });
  // Seguridad: la orden debe pertenecer al usuario autenticado.
  if (grant.userId !== req.user.id) return res.status(403).json({ error: 'Esta orden no es de tu cuenta.' });
  await applyGrant('paypal', grant);
  res.json({ ok: true, plan: grant.plan });
}));

export default router;
