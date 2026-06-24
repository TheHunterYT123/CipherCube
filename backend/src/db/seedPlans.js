'use strict';
/* =========================================================
   SEED PLANS — catálogo de planes de CipherCube.
   Las "features" deben coincidir con las que el frontend evalúa
   (ver js/plans.js / js/entitlements.js).
   ========================================================= */
import { pool } from './pool.js';

export const PLAN_CATALOG = [
  {
    key: 'free', name: 'Básico', sort_order: 0,
    description: 'Cifrado AES-256 con cubos Mini. Gratis para siempre.',
    features: ['mini_tier'],
  },
  {
    key: 'plus', name: 'Plus', sort_order: 1,
    description: 'Cubos Estándar y Pro, y volumen oculto.',
    features: ['mini_tier', 'standard_tier', 'pro_tier', 'hidden_volume'],
  },
  {
    key: 'boveda', name: 'Bóveda', sort_order: 2,
    description: 'Todo lo de Plus más Shamir Secret Sharing (repartir la frase en N partes).',
    features: ['mini_tier', 'standard_tier', 'pro_tier', 'hidden_volume', 'shamir'],
  },
];

export async function seedPlans(){
  for (const p of PLAN_CATALOG){
    await pool.query(
      `INSERT INTO plans (key, name, description, features, active, sort_order)
       VALUES ($1,$2,$3,$4,TRUE,$5)
       ON CONFLICT (key) DO UPDATE SET
         name=EXCLUDED.name, description=EXCLUDED.description,
         features=EXCLUDED.features, sort_order=EXCLUDED.sort_order, active=TRUE`,
      [p.key, p.name, p.description, JSON.stringify(p.features), p.sort_order]
    );
  }
}

// Permite ejecutarlo suelto: node src/db/seedPlans.js
if (import.meta.url === `file://${process.argv[1]}`){
  seedPlans().then(() => { console.log('[seed] Planes sembrados.'); return pool.end(); })
    .catch(e => { console.error(e); process.exit(1); });
}
