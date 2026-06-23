'use strict';
/* =========================================================
   PLANES — gating de capacidades premium.
   ========================================================= */
import { appState } from './storage.js';

export function planAllows(feature){
  if (feature==='standard_tier') return appState.plan==='plus' || appState.plan==='boveda';
  if (feature==='pro_tier') return appState.plan==='plus' || appState.plan==='boveda';
  if (feature==='hidden_volume') return appState.plan==='plus' || appState.plan==='boveda';
  if (feature==='shamir') return appState.plan==='boveda';
  return true;
}
export function planLabel(p){ return {free:'Básico',plus:'Plus',boveda:'Bóveda'}[p] || p; }

export const PLAN_REQUIREMENT_LABEL = {
  standard_tier: 'Plus',
  pro_tier: 'Plus',
  hidden_volume: 'Plus',
  shamir: 'Bóveda',
};
