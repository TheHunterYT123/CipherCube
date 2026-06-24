'use strict';
/* =========================================================
   MIGRATE — aplica schema.sql y siembra los planes base.
   Uso:  npm run migrate
   ========================================================= */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from './pool.js';
import { seedPlans } from './seedPlans.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main(){
  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  console.log('[migrate] Aplicando esquema…');
  await pool.query(sql);
  console.log('[migrate] Esquema aplicado.');
  await seedPlans();
  console.log('[migrate] Planes sembrados.');
  await pool.end();
  console.log('[migrate] Listo.');
}

main().catch(err => {
  console.error('[migrate] Error:', err.message);
  process.exit(1);
});
