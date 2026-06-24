'use strict';
/* =========================================================
   PROFILE ROUTES — ver/editar perfil y cambiar contraseña.
   ========================================================= */
import { Router } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { parse, updateProfileSchema, changePasswordSchema } from '../utils/validate.js';
import { findById, updateProfile, updatePassword, publicView } from '../services/user.service.js';
import { effectivePlan, revokeAllForUser } from '../services/token.service.js';
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
  res.json({ ok: true });
}));

export default router;
