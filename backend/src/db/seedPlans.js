'use strict';
/* =========================================================
   SEED PLANS — catálogo de planes de CipherCube.
   Las "features" deben coincidir con las que el frontend evalúa
   (ver js/plans.js / js/entitlements.js).
   ========================================================= */
import { query, closePool } from './pool.js';

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
    try{
      await query(
        `INSERT INTO plans (key, name, description, features, active, sort_order)
         VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT (key) DO NOTHING`,
        [p.key, p.name, p.description, JSON.stringify(p.features), p.sort_order]
      );
    } catch(e){
      console.error('[seed] Error:', e.message);
    }
  }
}

// Permite ejecutarlo suelto: node src/db/seedPlans.js
if (import.meta.url === `file://${process.argv[1]}`){
  seedPlans().then(async () => { console.log('[seed] Planes sembrados.'); await closePool(); process.exit(0); })
    .catch(async e => { console.error(e); await closePool(); process.exit(1); });
}
