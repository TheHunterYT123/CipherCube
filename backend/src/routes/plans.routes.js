'use strict';
/* =========================================================
   PLANS ROUTES — catálogo público de planes y métodos de pago activos.
   ========================================================= */
import { Router } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { listPlans } from '../services/plan.service.js';
import { providerConfigured } from '../config.js';

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  const plans = await listPlans();
  const providers = ['stripe', 'paypal', 'mercadopago'].filter(providerConfigured);
  res.json({ plans, providers });
}));

export default router;
