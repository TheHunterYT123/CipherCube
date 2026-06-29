'use strict';
/* =========================================================
   UI — navegación, tema, toasts y overlay de bloqueo premium.
   Sin lógica criptográfica ni de negocio: solo presentación.
   ========================================================= */
import { appState, saveTheme } from './storage.js';

const SCREENS = ['inicio','crear','camara','tienda','perfil'];

export function showScreen(name){
  SCREENS.forEach(s => document.getElementById('screen-'+s).classList.toggle('hidden', s!==name));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.screen===name));
  document.querySelector('.tab-camera').classList.toggle('active', name==='camara');
  document.dispatchEvent(new CustomEvent('cc:screen-changed', { detail: { screen: name } }));
}
export function initNavigation(){
  document.querySelectorAll('.tab-btn, .tab-camera').forEach(btn =>
    btn.addEventListener('click', () => showScreen(btn.dataset.screen)));
}
export function onScreenChange(handler){
  document.addEventListener('cc:screen-changed', e => handler(e.detail.screen));
}

/* ---- Tema claro/oscuro ---- */
export function applyTheme(){
  document.documentElement.setAttribute('data-theme', appState.theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim());
  document.dispatchEvent(new CustomEvent('cc:theme-changed', { detail: { theme: appState.theme } }));
}
export function setTheme(theme){
  appState.theme = theme;
  saveTheme(theme);
  applyTheme();
}

/* ---- Toasts superiores ---- */
let toastContainer = null;
function ensureToastContainer(){
  if (toastContainer) return toastContainer;
  toastContainer = document.createElement('div');
  toastContainer.className = 'toast-stack';
  document.body.appendChild(toastContainer);
  return toastContainer;
}
export function showToast(message, type){
  const container = ensureToastContainer();
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' toast-error' : '');
  const icon = document.createElement('span');
  icon.className = 'toast-ic';
  icon.textContent = type === 'error' ? '⚠' : 'ℹ';
  const text = document.createElement('span');
  text.textContent = message;
  el.appendChild(icon);
  el.appendChild(text);
  container.appendChild(el);
  const remove = () => { el.classList.add('toast-leaving'); setTimeout(() => el.remove(), 200); };
  const timer = setTimeout(remove, 4200);
  el.addEventListener('click', () => { clearTimeout(timer); remove(); });
  return el;
}
export function showError(message){ return showToast(message, 'error'); }

/* ---- Overlay de bloqueo premium ----
   El control bloqueado se ve y se comporta como cualquier otro: no avisa
   de antemano que es premium. Solo al intentar usarlo (pointerdown, antes
   de que el click llegue a tocar el control real) aparece el overlay
   tapando justo esa zona, con la opción de actualizar plan. */
export function armLockZone(zoneEl, { isLocked, requirementLabel, onUpgrade }){
  let overlay = zoneEl.querySelector('.lock-overlay');
  if (!overlay){
    overlay = document.createElement('div');
    overlay.className = 'lock-overlay';
    const card = document.createElement('div');
    card.className = 'lock-overlay-card';
    const title = document.createElement('div');
    title.className = 'lo-title';
    title.innerHTML = '<svg class="lo-ic" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 1 1 8 0v4"/></svg>';
    title.append(`Plan ${requirementLabel} requerido`);
    const desc = document.createElement('div');
    desc.className = 'lo-desc';
    desc.textContent = 'Esta capacidad requiere una licencia superior.';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-primary btn-sm';
    btn.textContent = 'Actualizar plan';
    card.appendChild(title); card.appendChild(desc); card.appendChild(btn);
    overlay.appendChild(card);
    zoneEl.appendChild(overlay);

    let hideTimer = null;
    const hide = () => { zoneEl.classList.remove('is-locked-active'); clearTimeout(hideTimer); document.removeEventListener('pointerdown', onOutsidePointerDown, true); };
    const onOutsidePointerDown = (e) => { if (!zoneEl.contains(e.target)) hide(); };
    const show = () => {
      zoneEl.classList.add('is-locked-active'); clearTimeout(hideTimer); hideTimer = setTimeout(hide, 4500);
      document.addEventListener('pointerdown', onOutsidePointerDown, true);
    };
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) hide(); });
    btn.addEventListener('click', (e) => { e.stopPropagation(); hide(); onUpgrade && onUpgrade(); });
    zoneEl.addEventListener('pointerdown', (e) => {
      if (!isLocked() || overlay.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      show();
    }, { capture: true });
  }
}

/* ---- Sheet "Ver información" ---- */
export function openSheet(backdropEl){ backdropEl.classList.add('show'); }
export function closeSheet(backdropEl){ backdropEl.classList.remove('show'); }

/* ---- Animación de entrada escalonada al entrar en viewport ---- */
export function applyStagger(containerEl){
  const children = Array.from(containerEl.children);
  if (!('IntersectionObserver' in window)){
    children.forEach(child => child.classList.add('stagger-in'));
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      children.forEach(child => child.classList.add('stagger-in'));
      observer.disconnect();
    });
  }, { threshold: 0.15 });
  observer.observe(containerEl);
}
