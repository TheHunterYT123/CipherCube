'use strict';
/* =========================================================
   STORAGE — estado compartido de la app + persistencia local.
   Solo se guarda metadata (tema, historial de tier/fecha/oculto).
   Nunca se guarda la frase maestra ni el contenido del secreto.
   ========================================================= */
const THEME_KEY = 'ciphercube-theme';
const HISTORY_KEY = 'ciphercube-history';

function systemPrefersDark(){
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}
export function loadTheme(){
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return systemPrefersDark() ? 'dark' : 'light';
}
export function saveTheme(theme){
  localStorage.setItem(THEME_KEY, theme);
}

export function loadHistory(){
  try{
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(item => ({ ...item, ts: new Date(item.ts) }));
  } catch(_){
    return [];
  }
}
export function saveHistory(myCubes){
  const serializable = myCubes.map(c => ({ tier: c.tier, hidden: c.hidden, ts: c.ts.toISOString() }));
  localStorage.setItem(HISTORY_KEY, JSON.stringify(serializable));
}
export function clearHistory(){
  localStorage.removeItem(HISTORY_KEY);
}

export const appState = {
  userName: null,
  plan: 'free',
  myCubes: loadHistory(),
  myOrders: [],
  theme: loadTheme(),
};

export function addCubeToHistory(entry){
  appState.myCubes.push(entry);
  saveHistory(appState.myCubes);
}
export function resetHistory(){
  appState.myCubes = [];
  clearHistory();
}
