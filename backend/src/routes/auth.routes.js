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
import { createUser, findByEmail, findById, publicView, recordLogin, markEmailVerified } from '../services/user.service.js';
import { logEvent } from '../services/audit.service.js';
import { createVerificationToken, consumeVerificationToken } from '../services/emailVerification.service.js';
import { sendVerificationEmail } from '../services/email.service.js';
import { verifyPassword } from '../utils/password.js';
import {
  signAccessToken, issueRefreshToken, consumeRefreshToken,
  revokeRefreshToken, effectivePlan,
  signTwoFactorChallenge, verifyTwoFactorChallenge,
} from '../services/token.service.js';
import { verifyToken as verifyTotp, consumeRecoveryCode } from '../services/totp.service.js';
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
  await recordLogin(user.id);
  await logEvent('register', `Nuevo registro: ${user.email}`, { userId: user.id, userEmail: user.email, ip: req.ip });
  // Envía el correo de verificación (no bloquea el registro si el envío falla).
  try{
    const token = await createVerificationToken(user.id);
    await sendVerificationEmail(user, token);
  } catch(e){ console.error('[register] No se pudo enviar verificación:', e.message); }
  const session = await issueSession(req, user);
  res.status(201).json(session);
}));

// ---- Login ----
router.post('/login', authLimiter, asyncHandler(async (req, res) => {
  const data = parse(loginSchema, req.body);
  const user = await findByEmail(data.email);
  // Mensaje genérico para no revelar si el correo existe.
  const invalid = async () => {
    await logEvent('login_failed', `Login fallido para ${data.email}`, { userEmail: data.email, ip: req.ip });
    return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
  };
  if (!user) return invalid();
  const ok = await verifyPassword(data.password, user.password_hash);
  if (!ok) return invalid();
  // Si se exige verificación de correo, bloquea hasta que esté verificado.
  if (config.requireEmailVerification && !user.email_verified){
    return res.status(403).json({ error: 'Verifica tu correo antes de iniciar sesión. Revisa tu bandeja de entrada.', emailUnverified: true });
  }
  // Si la cuenta tiene 2FA, no emitimos sesión todavía: pedimos el código.
  if (user.totp_enabled){
    const challengeToken = signTwoFactorChallenge(user);
    return res.json({ twoFactorRequired: true, challengeToken });
  }
  await recordLogin(user.id);
  await logEvent('login', `Inicio de sesión: ${user.email}`, { userId: user.id, userEmail: user.email, ip: req.ip });
  const session = await issueSession(req, user);
  res.json(session);
}));

// ---- Segundo factor: completa el login tras la contraseña ----
router.post('/2fa', authLimiter, asyncHandler(async (req, res) => {
  const { challengeToken, code, recoveryCode } = req.body || {};
  if (!challengeToken) return res.status(401).json({ error: 'Falta el desafío de verificación.' });
  let payload;
  try{ payload = verifyTwoFactorChallenge(challengeToken); }
  catch(_){ return res.status(401).json({ error: 'El desafío expiró. Inicia sesión de nuevo.' }); }
  const user = await findById(payload.sub);
  if (!user || !user.totp_enabled) return res.status(401).json({ error: 'Sesión inválida.' });

  let ok = false;
  if (code) ok = verifyTotp(user.totp_secret, code);
  if (!ok && recoveryCode) ok = await consumeRecoveryCode(user.id, recoveryCode);
  if (!ok){
    await logEvent('login_failed', `2FA inválido para ${user.email}`, { userId: user.id, userEmail: user.email, ip: req.ip });
    return res.status(401).json({ error: 'Código de verificación incorrecto.' });
  }
  await recordLogin(user.id);
  await logEvent('login', `Inicio de sesión (2FA): ${user.email}`, { userId: user.id, userEmail: user.email, ip: req.ip });
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

// ---- Verificar correo (con el token del enlace) ----
router.post('/verify-email', asyncHandler(async (req, res) => {
  const token = req.body?.token;
  if (!token) return res.status(400).json({ error: 'Falta el token de verificación.' });
  const userId = await consumeVerificationToken(token);
  if (!userId) return res.status(400).json({ error: 'El enlace de verificación es inválido o ha caducado.' });
  await markEmailVerified(userId);
  const user = await findById(userId);
  await logEvent('register', `Correo verificado: ${user?.email}`, { userId, userEmail: user?.email, ip: req.ip });
  res.json({ ok: true });
}));

// ---- Reenviar el correo de verificación (requiere sesión) ----
router.post('/resend-verification', requireAuth, authLimiter, asyncHandler(async (req, res) => {
  const user = await findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'Cuenta no encontrada.' });
  if (user.email_verified) return res.json({ ok: true, alreadyVerified: true });
  const token = await createVerificationToken(user.id);
  await sendVerificationEmail(user, token);
  res.json({ ok: true });
}));

// ---- Sesión actual ----
router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const user = await findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'Cuenta no encontrada.' });
  res.json({ user: { ...publicView(user), plan: effectivePlan(user) } });
}));

export default router;
