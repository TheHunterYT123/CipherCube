'use strict';
/* =========================================================
   GRANT ADMIN — concede o revoca el rol de administrador a una cuenta.
   Uso:
     node src/db/grantAdmin.js correo@dominio.com          (concede)
     node src/db/grantAdmin.js correo@dominio.com --revoke  (revoca)
   ========================================================= */
import { query, closePool } from './pool.js';

const email = (process.argv[2] || '').trim().toLowerCase();
const revoke = process.argv.includes('--revoke');

if (!email){
  console.error('Uso: node src/db/grantAdmin.js <correo> [--revoke]');
  process.exit(1);
}

const r = await query(`UPDATE users SET is_admin=? WHERE email_normalized=?`, [revoke ? 0 : 1, email]);
if (r.rowCount){
  console.log(`[admin] ${revoke ? 'Revocado' : 'Concedido'} admin a ${email}.`);
  await closePool();
} else {
  console.error(`[admin] No existe una cuenta con el correo ${email}. Regístrala primero.`);
  await closePool();
  process.exit(1);
}
