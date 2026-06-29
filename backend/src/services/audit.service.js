'use strict';
/* =========================================================
   AUDIT SERVICE — registro de eventos del sistema para auditoría.
   Alimenta la pestaña "Logs" del panel y deja rastro de quién hizo qué
   y cuándo (registros, inicios de sesión, pagos, cambios de plan, etc.).

   Diseño: nunca debe tumbar la petición principal. Si el log falla, se
   traga el error (se reporta por consola) y la operación de negocio sigue.
   ========================================================= */
import { randomUUID } from 'node:crypto';
import { query } from '../db/pool.js';

/** Severidad por defecto según el tipo de evento. */
const SEVERITY = {
  register: 'info',
  login: 'info',
  login_failed: 'warn',
  logout: 'info',
  password_changed: 'info',
  profile_updated: 'info',
  checkout_started: 'info',
  payment_succeeded: 'info',
  payment_failed: 'error',
  plan_granted: 'info',
  rate_limited: 'warn',
  admin_access: 'warn',
  server_error: 'error',
};

/**
 * Registra un evento de auditoría. No lanza: el logging nunca debe romper
 * la petición de negocio.
 * @param {string} type   identificador del evento (ver SEVERITY)
 * @param {string} message texto legible
 * @param {object} [opts] { severity, userId, userEmail, ip }
 */
export async function logEvent(type, message, opts = {}){
  try{
    const severity = opts.severity || SEVERITY[type] || 'info';
    await query(
      `INSERT INTO audit_logs (id, type, severity, message, user_id, user_email, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), type, severity, String(message).slice(0, 500),
       opts.userId || null, opts.userEmail || null, (opts.ip || '').slice(0, 64) || null]
    );
  } catch(e){
    console.error('[audit] No se pudo registrar el evento:', e.message);
  }
}
