'use strict';
/* =========================================================
   TOKEN SERVICE — emisión y verificación de JWT.

   - Access token (corto, 15 min): lo lleva el frontend en Authorization.
     Incluye el plan vigente firmado por el servidor → el cliente NO puede
     falsificar un plan superior editando localStorage.
   - Refresh token (largo): guardado HASHEADO en la BD para poder revocarlo.
   ========================================================= */
import jwt from 'jsonwebtoken';
import crypto, { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { query } from '../db/pool.js';

/** Plan efectivo de un usuario: si expiró, cuenta como 'free'. */
export function effectivePlan(user){
  if (user.plan === 'free' || !user.plan) return 'free';
  if (user.plan_expires_at && new Date(user.plan_expires_at).getTime() < Date.now()) return 'free';
  return user.plan;
}

export function signAccessToken(user){
  const plan = effectivePlan(user);
  return jwt.sign(
    { sub: user.id, plan, planExpiresAt: user.plan_expires_at || null, email: user.email },
    config.jwt.accessSecret,
    { expiresIn: config.jwt.accessTtl }
  );
}

export function verifyAccessToken(token){
  return jwt.verify(token, config.jwt.accessSecret);
}

/* ---- Desafío de segundo factor ----
   Token corto que prueba que el paso de contraseña pasó, pero la sesión NO se
   emite hasta validar el código TOTP. Marcado con scope para que no sirva como
   access token. */
export function signTwoFactorChallenge(user){
  return jwt.sign(
    { sub: user.id, scope: '2fa' },
    config.jwt.accessSecret,
    { expiresIn: 300 } // 5 minutos para introducir el código
  );
}

export function verifyTwoFactorChallenge(token){
  const payload = jwt.verify(token, config.jwt.accessSecret);
  if (payload.scope !== '2fa') throw new Error('Token de desafío inválido.');
  return payload;
}

function sha256(s){ return crypto.createHash('sha256').update(s).digest('hex'); }

/** Crea un refresh token, guarda su hash y devuelve el token en claro (al cliente). */
export async function issueRefreshToken(userId, meta = {}){
  const id = randomUUID();
  const raw = crypto.randomBytes(48).toString('hex');
  const tokenHash = sha256(raw);
  const expiresAt = new Date(Date.now() + config.jwt.refreshTtlDays * 86400_000).toISOString();
  await query(
    `INSERT INTO refresh_sessions (id, user_id, token_hash, user_agent, ip, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, userId, tokenHash, meta.userAgent || null, meta.ip || null, expiresAt]
  );
  return { raw, expiresAt: new Date(expiresAt) };
}

/** Valida un refresh token (existe, no revocado, no expirado) y devuelve el user_id. */
export async function consumeRefreshToken(raw){
  const tokenHash = sha256(raw);
  const { rows } = await query(
    `SELECT id, user_id, expires_at, revoked_at FROM refresh_sessions WHERE token_hash=?`,
    [tokenHash]
  );
  const sess = rows[0];
  if (!sess) return null;
  if (sess.revoked_at) return null;
  if (new Date(sess.expires_at).getTime() < Date.now()) return null;
  return { sessionId: sess.id, userId: sess.user_id };
}

export async function revokeRefreshToken(raw){
  const tokenHash = sha256(raw);
  await query(`UPDATE refresh_sessions SET revoked_at=datetime('now') WHERE token_hash=? AND revoked_at IS NULL`, [tokenHash]);
}

export async function revokeAllForUser(userId){
  await query(`UPDATE refresh_sessions SET revoked_at=datetime('now') WHERE user_id=? AND revoked_at IS NULL`, [userId]);
}
