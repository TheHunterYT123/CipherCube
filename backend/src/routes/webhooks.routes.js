'use strict';
/* =========================================================
   WEBHOOKS — notificaciones servidor-a-servidor de los proveedores.
   Se montan ANTES de express.json() porque Stripe necesita el cuerpo crudo
   para verificar la firma. La concesión de plan ocurre aquí (fuente de verdad).
   ========================================================= */
import { Router } from 'express';
import express from 'express';
import { asyncHandler } from '../middleware/error.js';
import * as stripe from '../services/payments/stripe.js';
import * as mercadopago from '../services/payments/mercadopago.js';
import { applyGrant } from '../services/payments/grant.js';

const router = Router();

// ---- Stripe (requiere cuerpo crudo para la firma) ----
router.post('/stripe', express.raw({ type: 'application/json' }), asyncHandler(async (req, res) => {
  const signature = req.headers['stripe-signature'];
  let event;
  try{
    event = stripe.constructEvent(req.body, signature);
  } catch(err){
    return res.status(400).json({ error: `Firma de webhook inválida: ${err.message}` });
  }
  const grant = stripe.extractGrant(event);
  if (grant) await applyGrant('stripe', grant);
  res.json({ received: true });
}));

// ---- MercadoPago (notificación por payment id) ----
router.post('/mercadopago', express.json(), asyncHandler(async (req, res) => {
  // MP avisa con ?type=payment&data.id=... o en el cuerpo { type, data:{id} }.
  const type = req.query.type || req.query.topic || req.body?.type;
  const paymentId = req.query['data.id'] || req.body?.data?.id || req.query.id;
  if (type === 'payment' && paymentId){
    const grant = await mercadopago.fetchPaymentGrant(paymentId);
    if (grant) await applyGrant('mercadopago', grant);
  }
  // Siempre 200 para que MP no reintente indefinidamente.
  res.sendStatus(200);
}));

export default router;
