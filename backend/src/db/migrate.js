'use strict';
/* =========================================================
   MIGRATE — aplica el esquema y siembra los planes base.
   Funciona con SQLite (schema.sql) o PostgreSQL (schema.pg.sql) según el
   driver activo. Uso:  npm run migrate
   ========================================================= */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { query, exec, getDriver, closePool } from './pool.js';
import { config } from '../config.js';
import { seedPlans } from './seedPlans.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Añade una columna solo si no existe (idempotente), en cualquier driver. */
async function ensureColumn(table, column, definition){
  if (getDriver() === 'pg'){
    // PostgreSQL soporta ADD COLUMN IF NOT EXISTS directamente.
    await exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${definition}`);
    return;
  }
  const { rows } = await query(`PRAGMA table_info(${table})`);
  if (rows.some(c => c.name === column)) return;
  await exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`[migrate] Columna añadida: ${table}.${column}`);
}

async function main(){
  const schemaFile = getDriver() === 'pg' ? 'schema.pg.sql' : 'schema.sql';
  const sql = readFileSync(join(__dirname, schemaFile), 'utf8');
  console.log(`[migrate] Aplicando esquema (${getDriver()}: ${schemaFile})…`);
  await exec(sql);

  // Migraciones para BD ya existentes (las columnas nuevas no las añade CREATE TABLE IF NOT EXISTS).
  await ensureColumn('users', 'is_admin', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('users', 'last_login_at', getDriver() === 'pg' ? 'TIMESTAMPTZ' : 'TEXT');
  await ensureColumn('users', 'totp_secret', 'TEXT');
  await ensureColumn('users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');

  console.log('[migrate] Esquema aplicado.');
  await seedPlans();
  console.log('[migrate] Planes sembrados.');

  // Promueve a administrador los correos configurados (si ya tienen cuenta).
  for (const email of config.adminEmails){
    const r = await query(`UPDATE users SET is_admin=1 WHERE email_normalized=?`, [email]);
    if (r.rowCount) console.log(`[migrate] Admin concedido a ${email}`);
  }

  console.log('[migrate] Listo.');
}

main()
  .then(async () => { await closePool(); process.exit(0); })
  .catch(async err => { console.error('[migrate] Error:', err.message); await closePool(); process.exit(1); });
