'use strict';
/* =========================================================
   PLAN SERVICE — catálogo de planes y resolución de precios.
   ========================================================= */
import { query } from '../db/pool.js';
import { config } from '../config.js';

export async function listPlans(){
  const { rows } = await query(
    `SELECT key, name, description, features, sort_order FROM plans WHERE active=1 ORDER BY sort_order`
  );
  return rows.map(r => ({
    key: r.key, name: r.name, description: r.description,
    features: parseFeatures(r.features), prices: priceFor(r.key),
  }));
}

/** features se guarda como texto JSON en SQLite; devuélvelo siempre como array. */
function parseFeatures(raw){
  if (Array.isArray(raw)) return raw;
  try{ return JSON.parse(raw || '[]'); }
  catch(_){ return []; }
}

/** Precio del plan por moneda (los planes de pago tienen precio; free no). */
export function priceFor(planKey){
  if (planKey === 'free') return null;
  return {
    usd: config.prices.usd[planKey] || null,
    mxn: config.prices.mxn[planKey] || null,
  };
}

export function isPaidPlan(planKey){ return planKey === 'plus' || planKey === 'boveda'; }
