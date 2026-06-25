'use strict';
/* =========================================================
   TOTP SERVICE — segundo factor por aplicación autenticadora (RFC 6238).
   - Secreto base32 por usuario (otplib).
   - Tolerancia de ±1 ventana (±30 s) para deriva de reloj.
   - Códigos de recuperación de un solo uso, guardados HASHEADOS.
   ========================================================= */
import { authenticator } from 'otplib';
import crypto, { randomUUID } from 'node:crypto';
import { query } from '../db/pool.js';

// Acepta el código del intervalo actual y el anterior/siguiente (deriva de reloj).
authenticator.options = { window: 1 };

const ISSUER = 'CipherCube';

export function generateSecret(){ return authenticator.generateSecret(); }

/** URI otpauth:// para el QR de la app autenticadora. */
export function otpauthUrl(email, secret){
  return authenticator.keyuri(email, ISSUER, secret);
}

/** ¿Es válido el código TOTP de 6 dígitos para este secreto? */
export function verifyToken(secret, token){
  if (!secret || !token) return false;
  try{ return authenticator.verify({ token: String(token).replace(/\s/g, ''), secret }); }
  catch(_){ return false; }
}

function sha256(s){ return crypto.createHash('sha256').update(s).digest('hex'); }
function normalizeCode(c){ return String(c || '').replace(/[\s-]/g, '').toLowerCase(); }

/** Genera N códigos de recuperación, guarda sus hashes y devuelve los códigos en claro (una sola vez). */
export async function generateRecoveryCodes(userId, count = 10){
  await query(`DELETE FROM totp_recovery_codes WHERE user_id=?`, [userId]);
  const plain = [];
  for (let i = 0; i < count; i++){
    // Formato legible: xxxx-xxxx (hex).
    const raw = crypto.randomBytes(4).toString('hex') + '-' + crypto.randomBytes(4).toString('hex');
    plain.push(raw);
    await query(
      `INSERT INTO totp_recovery_codes (id, user_id, code_hash) VALUES (?, ?, ?)`,
      [randomUUID(), userId, sha256(normalizeCode(raw))]
    );
  }
  return plain;
}

/** Consume un código de recuperación si es válido y no se ha usado. Devuelve true si se consumió. */
export async function consumeRecoveryCode(userId, code){
  const hash = sha256(normalizeCode(code));
  const { rows } = await query(
    `SELECT id FROM totp_recovery_codes WHERE user_id=? AND code_hash=? AND used_at IS NULL`,
    [userId, hash]
  );
  if (!rows.length) return false;
  await query(`UPDATE totp_recovery_codes SET used_at=CURRENT_TIMESTAMP WHERE id=?`, [rows[0].id]);
  return true;
}

export async function deleteRecoveryCodes(userId){
  await query(`DELETE FROM totp_recovery_codes WHERE user_id=?`, [userId]);
}

/** Nº de códigos de recuperación sin usar (para mostrarlo en el perfil). */
export async function countRecoveryCodes(userId){
  const { rows } = await query(
    `SELECT COUNT(*) AS n FROM totp_recovery_codes WHERE user_id=? AND used_at IS NULL`, [userId]
  );
  return Number(rows[0]?.n || 0);
}
