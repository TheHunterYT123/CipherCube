'use strict';
/* =========================================================
   AUTH ROUTES — registro, login, refresh, logout, sesión actual.
   Estrategia de tokens: access (JWT corto, en Authorization) +
   refresh (token opaco, devuelto al cliente y revocable en BD).
   ========================================================= */
import { Router } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { authLimiter } from '../middleware/rateLimit.js';
import { parse, registerSchema, loginSchema } from '../utils/validate.js';
import { createUser, findByEmail, findById, publicView } from '../services/user.service.js';
import { verifyPassword } from '../utils/password.js';
import {
  signAccessToken, issueRefreshToken, consumeRefreshToken,
  revokeRefreshToken, effectivePlan,
} from '../services/token.service.js';
import { config } from '../config.js';

const router = Router();

function sessionMeta(req){
  return { userAgent: (req.headers['user-agent'] || '').slice(0, 300), ip: req.ip };
}

async function issueSession(req, user){
  const accessToken = signAccessToken(user);
  const { raw: refreshToken } = await issueRefreshToken(user.id, sessionMeta(req));
  return {
    accessToken, refreshToken,
    accessTokenExpiresIn: config.jwt.accessTtl,
    user: { ...publicView(user), plan: effectivePlan(user) },
  };
}

// ---- Registro ----
router.post('/register', authLimiter, asyncHandler(async (req, res) => {
  const data = parse(registerSchema, req.body);
  const user = await createUser(data);
  const session = await issueSession(req, user);
  res.status(201).json(session);
}));

// ---- Login ----
router.post('/login', authLimiter, asyncHandler(async (req, res) => {
  const data = parse(loginSchema, req.body);
  const user = await findByEmail(data.email);
  // Mensaje genérico para no revelar si el correo existe.
  const invalid = () => res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
  if (!user) return invalid();
  const ok = await verifyPassword(data.password, user.password_hash);
  if (!ok) return invalid();
  const session = await issueSession(req, user);
  res.json(session);
}));

// ---- Refrescar access token ----
router.post('/refresh', asyncHandler(async (req, res) => {
  const refreshToken = req.body?.refreshToken;
  if (!refreshToken) return res.status(401).json({ error: 'Falta el refresh token.' });
  const session = await consumeRefreshToken(refreshToken);
  if (!session) return res.status(401).json({ error: 'Sesión inválida o expirada. Inicia sesión de nuevo.' });
  const user = await findById(session.userId);
  if (!user) return res.status(401).json({ error: 'Cuenta no encontrada.' });
  res.json({
    accessToken: signAccessToken(user),
    accessTokenExpiresIn: config.jwt.accessTtl,
    user: { ...publicView(user), plan: effectivePlan(user) },
  });
}));

// ---- Logout (revoca el refresh token) ----
router.post('/logout', asyncHandler(async (req, res) => {
  const refreshToken = req.body?.refreshToken;
  if (refreshToken) await revokeRefreshToken(refreshToken);
  res.json({ ok: true });
}));

// ---- Sesión actual ----
router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const user = await findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'Cuenta no encontrada.' });
  res.json({ user: { ...publicView(user), plan: effectivePlan(user) } });
}));

export default router;
