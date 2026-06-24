'use strict';
/* =========================================================
   AUTH (frontend) — sesión, formularios de login/registro, perfil,
   y flujo de compra de planes con redirección al proveedor de pago.

   La fuente de verdad del plan es el backend: `appState.plan` se llena
   desde la sesión del servidor (token firmado), no desde valores que el
   usuario pueda editar a mano.
   ========================================================= */
import {
  auth, profile, plans as plansApi, payments,
  isLoggedIn, backendAvailable, clearTokens,
} from './api.js';
import { appState } from './storage.js';
import { showToast, showError, showScreen } from './ui.js';

let currentUser = null;
let onChange = () => {};
let cachedProviders = null;

export function getCurrentUser(){ return currentUser; }
export function setOnAuthChange(fn){ onChange = fn; }

function applyUser(user){
  currentUser = user;
  appState.plan = user ? (user.plan || 'free') : 'free';
  appState.userName = user ? (user.displayName || user.email) : null;
  onChange();
}

/* ---- Arranque: restaura sesión y procesa retorno de pago ---- */
export async function initAuth(){
  if (!(await backendAvailable())){
    applyUser(null);
    return;
  }
  if (isLoggedIn()){
    try{ applyUser(await auth.me()); }
    catch(_){ clearTokens(); applyUser(null); }
  } else {
    applyUser(null);
  }
  await handlePaymentReturn();
}

async function refreshSession(){
  try{ applyUser(await auth.me()); } catch(_){ /* sesión caída */ }
}

/* ---- Formularios de login / registro ---- */
export function initAuthUI(){
  const seg = document.querySelectorAll('.seg-auth');
  const nameField = document.getElementById('authNameField');
  const submitBtn = document.getElementById('authSubmitBtn');
  const hint = document.getElementById('authHint');
  let mode = 'login';

  function setMode(m){
    mode = m;
    seg.forEach(b => b.classList.toggle('active', b.dataset.mode === m));
    nameField.style.display = m === 'register' ? 'block' : 'none';
    submitBtn.textContent = m === 'register' ? 'Crear cuenta' : 'Iniciar sesión';
    hint.textContent = '';
  }
  seg.forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
  setMode('login');

  submitBtn.addEventListener('click', async () => {
    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    const displayName = document.getElementById('authName').value.trim();
    hint.textContent = '';
    if (!email || !password){ hint.textContent = 'Escribe tu correo y contraseña.'; return; }
    if (!(await backendAvailable())){
      hint.textContent = 'El servidor de cuentas no está disponible. Inténtalo más tarde.';
      return;
    }
    submitBtn.disabled = true;
    const prev = submitBtn.textContent;
    submitBtn.innerHTML = '<span class="spinner"></span> Procesando…';
    try{
      const user = mode === 'register'
        ? await auth.register({ email, password, displayName })
        : await auth.login({ email, password });
      applyUser(user);
      showToast(mode === 'register' ? 'Cuenta creada. ¡Bienvenido!' : 'Sesión iniciada.');
      document.getElementById('authPassword').value = '';
    } catch(e){
      hint.textContent = e.message || 'No se pudo completar la operación.';
    } finally {
      submitBtn.disabled = false; submitBtn.textContent = prev;
    }
  });

  initPaymentSheet();
}

export async function logout(){
  await auth.logout();
  applyUser(null);
  showToast('Sesión cerrada.');
}

export async function changePassword(currentPassword, newPassword){
  await profile.changePassword(currentPassword, newPassword);
  showToast('Contraseña actualizada. Vuelve a iniciar sesión.');
  // Cambiar la contraseña revoca las sesiones; forzamos re-login.
  clearTokens();
  applyUser(null);
}

/* ---- Compra de planes ---- */
let pendingPlan = null;
let selectedCurrency = 'usd';

export async function beginPurchase(planKey){
  if (!isLoggedIn()){
    showError('Inicia sesión o crea una cuenta para comprar un plan.');
    showScreen('perfil');
    return;
  }
  if (!(await backendAvailable())){
    showError('El servidor de pagos no está disponible ahora mismo.');
    return;
  }
  pendingPlan = planKey;
  await openPaymentSheet(planKey);
}

async function loadProviders(){
  if (cachedProviders) return cachedProviders;
  try{ cachedProviders = (await plansApi.list()).providers || []; }
  catch(_){ cachedProviders = []; }
  return cachedProviders;
}

const PROVIDER_LABEL = { stripe: 'Tarjeta (Stripe)', paypal: 'PayPal', mercadopago: 'MercadoPago' };

function initPaymentSheet(){
  const backdrop = document.getElementById('paySheetBackdrop');
  if (!backdrop) return;
  document.getElementById('paySheetClose').addEventListener('click', () => closePaymentSheet());
  backdrop.addEventListener('click', e => { if (e.target === backdrop) closePaymentSheet(); });
  document.querySelectorAll('.seg-pay').forEach(b => b.addEventListener('click', () => {
    selectedCurrency = b.dataset.cur;
    document.querySelectorAll('.seg-pay').forEach(x => x.classList.toggle('active', x === b));
  }));
}

async function openPaymentSheet(planKey){
  const backdrop = document.getElementById('paySheetBackdrop');
  const wrap = document.getElementById('payProviders');
  const hint = document.getElementById('payHint');
  document.getElementById('paySheetTitle').textContent = `Comprar ${planKey === 'plus' ? 'Plus' : 'Bóveda'}`;
  hint.textContent = 'Cargando métodos de pago…';
  wrap.innerHTML = '';
  backdrop.classList.add('show');

  const providers = await loadProviders();
  if (!providers.length){
    hint.textContent = 'No hay métodos de pago configurados en el servidor todavía.';
    return;
  }
  hint.textContent = '';
  providers.forEach(prov => {
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.textContent = `Pagar con ${PROVIDER_LABEL[prov] || prov}`;
    btn.addEventListener('click', () => proceedCheckout(planKey, prov, btn));
    wrap.appendChild(btn);
  });
}

function closePaymentSheet(){
  document.getElementById('paySheetBackdrop')?.classList.remove('show');
}

async function proceedCheckout(planKey, provider, btn){
  const hint = document.getElementById('payHint');
  btn.disabled = true; const prev = btn.textContent;
  btn.innerHTML = '<span class="spinner"></span> Redirigiendo…';
  try{
    const data = await payments.checkout({ plan: planKey, provider, currency: selectedCurrency });
    if (data?.url){ window.location.href = data.url; return; }
    hint.textContent = 'El proveedor no devolvió una URL de pago.';
  } catch(e){
    hint.textContent = e.message || 'No se pudo iniciar el pago.';
  } finally {
    btn.disabled = false; btn.textContent = prev;
  }
}

/* ---- Retorno desde el proveedor de pago ---- */
async function handlePaymentReturn(){
  const params = new URLSearchParams(window.location.search);
  const pago = params.get('pago');
  if (!pago) return;
  const clean = () => window.history.replaceState({}, '', window.location.pathname);

  if (pago === 'cancelado'){ showToast('Pago cancelado.'); clean(); return; }
  if (pago === 'pendiente'){ showToast('Tu pago quedó pendiente de confirmación.'); clean(); return; }
  if (pago !== 'ok'){ clean(); return; }

  const proveedor = params.get('proveedor');
  if (proveedor === 'paypal'){
    const orderId = params.get('token');
    if (orderId){
      try{ await payments.paypalCapture(orderId); }
      catch(e){ showError('No se pudo confirmar el pago de PayPal: ' + e.message); }
    }
  }
  // Stripe/MercadoPago conceden por webhook; puede tardar un instante.
  await refreshUntilPlan(3);
  showToast('¡Pago recibido! Tu plan se actualizó.');
  clean();
}

async function refreshUntilPlan(tries){
  for (let i = 0; i < tries; i++){
    await refreshSession();
    if (currentUser && currentUser.plan && currentUser.plan !== 'free') return;
    await new Promise(r => setTimeout(r, 1500));
  }
}
