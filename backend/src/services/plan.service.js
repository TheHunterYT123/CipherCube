'use strict';
/* =========================================================
   PLAN SERVICE — catálogo de planes y resolución de precios.
   ========================================================= */
import { query } from '../db/pool.js';
import { config } from '../config.js';

export async function listPlans(){
  const { rows } = await query(
    `SELECT key, name, description, features, sort_order FROM plans WHERE active=TRUE ORDER BY sort_order`
  );
  return rows.map(r => ({
    key: r.key, name: r.name, description: r.description,
    features: r.features, prices: priceFor(r.key),
  }));
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
