'use strict';
/* =========================================================
   PROFILE ROUTES — ver/editar perfil y cambiar contraseña.
   ========================================================= */
import { Router } from 'express';
import QRCode from 'qrcode';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { parse, updateProfileSchema, changePasswordSchema } from '../utils/validate.js';
import {
  findById, updateProfile, updatePassword, publicView,
  setTotpSecret, enableTotp, disableTotp,
} from '../services/user.service.js';
import { effectivePlan, revokeAllForUser } from '../services/token.service.js';
import {
  generateSecret, otpauthUrl, verifyToken as verifyTotp,
  generateRecoveryCodes, deleteRecoveryCodes, countRecoveryCodes,
} from '../services/totp.service.js';
import { logEvent } from '../services/audit.service.js';
import { verifyPassword, hashPassword } from '../utils/password.js';

const router = Router();

router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const user = await findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'Cuenta no encontrada.' });
  res.json({ user: { ...publicView(user), plan: effectivePlan(user) } });
}));

router.patch('/', requireAuth, asyncHandler(async (req, res) => {
  const data = parse(updateProfileSchema, req.body);
  const user = await updateProfile(req.user.id, data);
  res.json({ user: { ...publicView(user), plan: effectivePlan(user) } });
}));

router.post('/change-password', requireAuth, asyncHandler(async (req, res) => {
  const data = parse(changePasswordSchema, req.body);
  const user = await findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'Cuenta no encontrada.' });
  const ok = await verifyPassword(data.currentPassword, user.password_hash);
  if (!ok) return res.status(400).json({ error: 'La contraseña actual no es correcta.' });
  await updatePassword(user.id, await hashPassword(data.newPassword));
  // Por seguridad, cierra todas las demás sesiones al cambiar la contraseña.
  await revokeAllForUser(user.id);
  await logEvent('password_changed', `Cambio de contraseña: ${user.email}`, { userId: user.id, userEmail: user.email, ip: req.ip });
  res.json({ ok: true });
}));

/* ---- 2FA (TOTP) ---- */

// Estado del 2FA (activado + códigos de recuperación restantes).
router.get('/2fa', requireAuth, asyncHandler(async (req, res) => {
  const user = await findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'Cuenta no encontrada.' });
  res.json({ enabled: !!user.totp_enabled, recoveryCodesLeft: await countRecoveryCodes(user.id) });
}));

// Paso 1: genera un secreto y devuelve el QR para escanear (aún NO activa el 2FA).
router.post('/2fa/setup', requireAuth, asyncHandler(async (req, res) => {
  const user = await findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'Cuenta no encontrada.' });
  const secret = generateSecret();
  await setTotpSecret(user.id, secret);
  const otpauth = otpauthUrl(user.email, secret);
  const qrDataUrl = await QRCode.toDataURL(otpauth);
  res.json({ secret, otpauthUrl: otpauth, qrDataUrl });
}));

// Paso 2: confirma con un código del autenticador y activa el 2FA.
// Devuelve los códigos de recuperación UNA SOLA VEZ.
router.post('/2fa/enable', requireAuth, asyncHandler(async (req, res) => {
  const code = String(req.body?.code || '').trim();
  if (!code) return res.status(400).json({ error: 'Escribe el código de 6 dígitos.' });
  const user = await findById(req.user.id);
  if (!user || !user.totp_secret) return res.status(400).json({ error: 'Primero genera un código QR.' });
  if (user.totp_enabled) return res.status(400).json({ error: 'El 2FA ya está activado.' });
  if (!verifyTotp(user.totp_secret, code)) return res.status(400).json({ error: 'Código incorrecto. Inténtalo de nuevo.' });

  await enableTotp(user.id);
  const recoveryCodes = await generateRecoveryCodes(user.id);
  await logEvent('password_changed', `2FA activado: ${user.email}`, { severity: 'info', userId: user.id, userEmail: user.email, ip: req.ip });
  res.json({ ok: true, recoveryCodes });
}));

// Desactiva el 2FA (exige contraseña para evitar abuso de una sesión robada).
router.post('/2fa/disable', requireAuth, asyncHandler(async (req, res) => {
  const password = String(req.body?.password || '');
  if (!password) return res.status(400).json({ error: 'Confirma tu contraseña para desactivar el 2FA.' });
  const user = await findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'Cuenta no encontrada.' });
  if (!(await verifyPassword(password, user.password_hash))) {
    return res.status(400).json({ error: 'La contraseña no es correcta.' });
  }
  await disableTotp(user.id);
  await deleteRecoveryCodes(user.id);
  await logEvent('password_changed', `2FA desactivado: ${user.email}`, { severity: 'warn', userId: user.id, userEmail: user.email, ip: req.ip });
  res.json({ ok: true });
}));

export default router;
