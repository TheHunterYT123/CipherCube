'use strict';
/* =========================================================
   ADMIN ROUTES — API del panel de administración (/api/admin/*).
   Protegidas por requireAuth + requireAdmin: solo cuentas con is_admin=1.
   Son de SOLO LECTURA (el panel observa el negocio; no muta datos de usuario).
   ========================================================= */
import { Router } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';
import * as admin from '../services/admin.service.js';

const router = Router();

// Todo el panel exige sesión válida Y rol admin verificado en BD.
router.use(requireAuth, requireAdmin);

router.get('/overview', asyncHandler(async (req, res) => res.json(await admin.overview())));
router.get('/users', asyncHandler(async (req, res) => res.json(await admin.listUsers())));
router.get('/purchases', asyncHandler(async (req, res) => res.json(await admin.listPurchases())));
router.get('/attempts', asyncHandler(async (req, res) => res.json(await admin.listAttempts())));
router.get('/logs', asyncHandler(async (req, res) => res.json(await admin.listLogs())));
router.get('/stats', asyncHandler(async (req, res) => res.json(await admin.stats())));
router.get('/settings', asyncHandler(async (req, res) => res.json(await admin.settings())));

export default router;
