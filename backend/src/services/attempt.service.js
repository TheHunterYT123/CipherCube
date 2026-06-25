'use strict';
/* =========================================================
   ATTEMPT SERVICE — registro de intentos de compra para el panel.
   Un "intento" se crea al iniciar el checkout (outcome='started') y se marca
   'completed' cuando el pago se concede. Lo que nunca completa queda 'started'
   (un dev podría marcarlo 'abandoned' con un job, pero no lo inventamos aquí).

   Como la auditoría, nunca debe tumbar la petición principal.
   ========================================================= */
import { randomUUID } from 'node:crypto';
import { query } from '../db/pool.js';

/** Crea un intento al iniciar el checkout. Devuelve el id (o null si falla). */
export async function recordAttempt({ userId, userEmail, plan, provider, currency }){
  try{
    const id = randomUUID();
    await query(
      `INSERT INTO checkout_attempts (id, user_id, user_email, plan_key, provider, currency, outcome)
       VALUES (?, ?, ?, ?, ?, ?, 'started')`,
      [id, userId || null, userEmail || null, plan, provider, currency || null]
    );
    return id;
  } catch(e){
    console.error('[attempt] No se pudo registrar el intento:', e.message);
    return null;
  }
}

/** Marca como 'completed' el intento 'started' más reciente que encaje. */
export async function markAttemptCompleted({ userId, plan, provider }){
  try{
    await query(
      `UPDATE checkout_attempts SET outcome='completed'
       WHERE id = (
         SELECT id FROM checkout_attempts
         WHERE user_id=? AND plan_key=? AND provider=? AND outcome='started'
         ORDER BY created_at DESC LIMIT 1
       )`,
      [userId, plan, provider]
    );
  } catch(e){
    console.error('[attempt] No se pudo completar el intento:', e.message);
  }
}
