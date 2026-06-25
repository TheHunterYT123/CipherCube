'use strict';
/* =========================================================
   USER SERVICE — operaciones de cuenta sobre la tabla users.
   ========================================================= */
import { randomUUID } from 'node:crypto';
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { hashPassword } from '../utils/password.js';

function normalizeEmail(email){ return email.trim().toLowerCase(); }

const PUBLIC_FIELDS = 'id, email, display_name, plan, plan_expires_at, email_verified, is_admin, last_login_at, created_at';

export async function findByEmail(email){
  const { rows } = await query(`SELECT * FROM users WHERE email_normalized=?`, [normalizeEmail(email)]);
  return rows[0] || null;
}

export async function findById(id){
  const { rows } = await query(`SELECT * FROM users WHERE id=?`, [id]);
  return rows[0] || null;
}

export async function createUser({ email, password, displayName }){
  const passwordHash = await hashPassword(password);
  const norm = normalizeEmail(email);
  const id = randomUUID();
  // Bootstrap de administradores: los correos listados en config se marcan admin
  // al registrarse. El acceso real al panel se valida siempre contra esta columna.
  const isAdmin = config.adminEmails.includes(norm) ? 1 : 0;
  try{
    const { rows } = await query(
      `INSERT INTO users (id, email, email_normalized, password_hash, display_name, is_admin)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING ${PUBLIC_FIELDS}`,
      [id, email.trim(), norm, passwordHash, displayName || null, isAdmin]
    );
    return rows[0];
  } catch(e){
    // Unicidad: Postgres usa el código 23505; better-sqlite3, SQLITE_CONSTRAINT_UNIQUE.
    if (e.code === '23505' || String(e.code || '').startsWith('SQLITE_CONSTRAINT')){
      const err = new Error('Ya existe una cuenta con ese correo.');
      err.status = 409;
      throw err;
    }
    throw e;
  }
}

export async function updateProfile(userId, { displayName }){
  // Los parámetros se enlazan por posición: primero el de SET, luego el del WHERE.
  const { rows } = await query(
    `UPDATE users SET display_name=COALESCE(?, display_name), updated_at=datetime('now')
     WHERE id=? RETURNING ${PUBLIC_FIELDS}`,
    [displayName ?? null, userId]
  );
  return rows[0];
}

export async function updatePassword(userId, newHash){
  await query(`UPDATE users SET password_hash=?, updated_at=datetime('now') WHERE id=?`, [newHash, userId]);
}

/** Marca el momento del último inicio de sesión (para el panel de administración). */
export async function recordLogin(userId){
  await query(`UPDATE users SET last_login_at=CURRENT_TIMESTAMP WHERE id=?`, [userId]);
}

/** Marca el correo del usuario como verificado. */
export async function markEmailVerified(userId){
  await query(`UPDATE users SET email_verified=1, updated_at=CURRENT_TIMESTAMP WHERE id=?`, [userId]);
}

/* ---- 2FA (TOTP) ---- */

/** Guarda el secreto TOTP dejando el 2FA aún DESACTIVADO (pendiente de confirmar). */
export async function setTotpSecret(userId, secret){
  await query(`UPDATE users SET totp_secret=?, totp_enabled=0, updated_at=CURRENT_TIMESTAMP WHERE id=?`, [secret, userId]);
}

/** Activa el 2FA una vez el usuario confirma un código válido. */
export async function enableTotp(userId){
  await query(`UPDATE users SET totp_enabled=1, updated_at=CURRENT_TIMESTAMP WHERE id=?`, [userId]);
}

/** Desactiva el 2FA y borra el secreto. */
export async function disableTotp(userId){
  await query(`UPDATE users SET totp_secret=NULL, totp_enabled=0, updated_at=CURRENT_TIMESTAMP WHERE id=?`, [userId]);
}

/** Concede un plan al usuario (lo usan los webhooks tras un pago confirmado). */
export async function grantPlan(userId, planKey, { durationDays } = {}){
  const expires = durationDays ? new Date(Date.now() + durationDays * 86400_000).toISOString() : null;
  const { rows } = await query(
    `UPDATE users SET plan=?, plan_expires_at=?, updated_at=datetime('now')
     WHERE id=? RETURNING ${PUBLIC_FIELDS}`,
    [planKey, expires, userId]
  );
  return rows[0];
}

/** Devuelve solo los campos públicos de un registro de usuario completo. */
export function publicView(u){
  return {
    id: u.id, email: u.email, displayName: u.display_name,
    plan: u.plan, planExpiresAt: u.plan_expires_at,
    emailVerified: !!u.email_verified, isAdmin: !!u.is_admin,
    twoFactorEnabled: !!u.totp_enabled,
    lastLoginAt: u.last_login_at, createdAt: u.created_at,
  };
}
