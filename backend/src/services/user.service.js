'use strict';
/* =========================================================
   USER SERVICE — operaciones de cuenta sobre la tabla users.
   ========================================================= */
import { query } from '../db/pool.js';
import { hashPassword } from '../utils/password.js';

function normalizeEmail(email){ return email.trim().toLowerCase(); }

const PUBLIC_FIELDS = 'id, email, display_name, plan, plan_expires_at, email_verified, created_at';

export async function findByEmail(email){
  const { rows } = await query(`SELECT * FROM users WHERE email_normalized=$1`, [normalizeEmail(email)]);
  return rows[0] || null;
}

export async function findById(id){
  const { rows } = await query(`SELECT * FROM users WHERE id=$1`, [id]);
  return rows[0] || null;
}

export async function createUser({ email, password, displayName }){
  const passwordHash = await hashPassword(password);
  const norm = normalizeEmail(email);
  try{
    const { rows } = await query(
      `INSERT INTO users (email, email_normalized, password_hash, display_name)
       VALUES ($1,$2,$3,$4)
       RETURNING ${PUBLIC_FIELDS}`,
      [email.trim(), norm, passwordHash, displayName || null]
    );
    return rows[0];
  } catch(e){
    if (e.code === '23505'){ // unique_violation
      const err = new Error('Ya existe una cuenta con ese correo.');
      err.status = 409;
      throw err;
    }
    throw e;
  }
}

export async function updateProfile(userId, { displayName }){
  const { rows } = await query(
    `UPDATE users SET display_name=COALESCE($2, display_name), updated_at=now()
     WHERE id=$1 RETURNING ${PUBLIC_FIELDS}`,
    [userId, displayName ?? null]
  );
  return rows[0];
}

export async function updatePassword(userId, newHash){
  await query(`UPDATE users SET password_hash=$2, updated_at=now() WHERE id=$1`, [userId, newHash]);
}

/** Concede un plan al usuario (lo usan los webhooks tras un pago confirmado). */
export async function grantPlan(userId, planKey, { durationDays } = {}){
  const expires = durationDays ? new Date(Date.now() + durationDays * 86400_000) : null;
  const { rows } = await query(
    `UPDATE users SET plan=$2, plan_expires_at=$3, updated_at=now()
     WHERE id=$1 RETURNING ${PUBLIC_FIELDS}`,
    [userId, planKey, expires]
  );
  return rows[0];
}

/** Devuelve solo los campos públicos de un registro de usuario completo. */
export function publicView(u){
  return {
    id: u.id, email: u.email, displayName: u.display_name,
    plan: u.plan, planExpiresAt: u.plan_expires_at,
    emailVerified: u.email_verified, createdAt: u.created_at,
  };
}
