'use strict';
/* =========================================================
   EMAIL VERIFICATION — emisión y consumo de tokens de verificación.
   El token viaja al usuario en claro (por correo); en la BD se guarda solo
   su hash SHA-256. De un solo uso y con caducidad.
   ========================================================= */
import crypto, { randomUUID } from 'node:crypto';
import { query } from '../db/pool.js';

const TTL_HOURS = 24;
function sha256(s){ return crypto.createHash('sha256').update(s).digest('hex'); }

/** Crea un token de verificación para el usuario y devuelve el valor en claro. */
export async function createVerificationToken(userId){
  // Invalida tokens anteriores no usados.
  await query(`DELETE FROM email_verification_tokens WHERE user_id=? AND used_at IS NULL`, [userId]);
  const raw = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + TTL_HOURS * 3600_000).toISOString();
  await query(
    `INSERT INTO email_verification_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)`,
    [randomUUID(), userId, sha256(raw), expiresAt]
  );
  return raw;
}

/** Valida y consume un token. Devuelve el userId si es válido, o null. */
export async function consumeVerificationToken(raw){
  if (!raw) return null;
  const { rows } = await query(
    `SELECT id, user_id, expires_at, used_at FROM email_verification_tokens WHERE token_hash=?`,
    [sha256(raw)]
  );
  const tok = rows[0];
  if (!tok || tok.used_at) return null;
  if (new Date(tok.expires_at).getTime() < Date.now()) return null;
  await query(`UPDATE email_verification_tokens SET used_at=CURRENT_TIMESTAMP WHERE id=?`, [tok.id]);
  return tok.user_id;
}
