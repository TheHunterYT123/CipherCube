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
  await handleEmailVerification();
  await handlePaymentReturn();
}

/* ---- Verificación de correo (enlace ?verify=token) ---- */
async function handleEmailVerification(){
  const params = new URLSearchParams(window.location.search);
  const token = params.get('verify');
  if (!token) return;
  const clean = () => window.history.replaceState({}, '', window.location.pathname);
  try{
    await auth.verifyEmail(token);
    showToast('¡Correo verificado! Gracias.');
    if (isLoggedIn()) await refreshSession();
  } catch(e){
    showError(e.message || 'No se pudo verificar el correo.');
  } finally {
    clean();
  }
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
      if (mode === 'register'){
        const user = await auth.register({ email, password, displayName });
        applyUser(user);
        showToast('Cuenta creada. Te enviamos un correo para verificar tu cuenta.');
      } else {
        const res = await auth.login({ email, password });
        if (res.twoFactorRequired){
          const user = await completeTwoFactor(res.challengeToken, hint);
          if (!user) return; // cancelado
          applyUser(user);
          showToast('Sesión iniciada.');
        } else {
          applyUser(res.user);
          showToast('Sesión iniciada.');
        }
      }
      document.getElementById('authPassword').value = '';
    } catch(e){
      hint.textContent = e.message || 'No se pudo completar la operación.';
    } finally {
      submitBtn.disabled = false; submitBtn.textContent = prev;
    }
  });

  initPaymentSheet();
}

/* ---- Reto de segundo factor en el login ----
   Muestra un modal pidiendo el código TOTP (o un código de recuperación) y
   completa el login. Devuelve el usuario, o null si se cancela. */
function completeTwoFactor(challengeToken, hintEl){
  return new Promise(resolve => {
    const backdrop = document.createElement('div');
    backdrop.className = 'info-sheet-backdrop show';
    backdrop.innerHTML = `
      <div class="info-sheet" role="dialog" aria-modal="true">
        <div class="is-handle"></div>
        <div class="is-title">Verificación en dos pasos</div>
        <div class="hint" data-role="msg" style="margin-bottom:10px;">Escribe el código de 6 dígitos de tu app autenticadora.</div>
        <div class="field"><input type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="20"
               data-role="code" placeholder="123456" style="text-align:center;letter-spacing:4px;font-size:18px"></div>
        <button class="btn btn-primary" data-act="verify" style="margin-top:12px;">Verificar</button>
        <button class="btn btn-secondary" data-act="recovery" style="margin-top:8px;">Usar código de recuperación</button>
        <button class="btn btn-secondary" data-act="close" style="margin-top:8px;">Cancelar</button>
      </div>`;
    document.body.appendChild(backdrop);
    const codeInput = backdrop.querySelector('[data-role="code"]');
    const msg = backdrop.querySelector('[data-role="msg"]');
    const verifyBtn = backdrop.querySelector('[data-act="verify"]');
    let useRecovery = false;
    setTimeout(() => codeInput.focus(), 50);

    const close = (result) => { backdrop.remove(); resolve(result); };

    backdrop.querySelector('[data-act="close"]').addEventListener('click', () => close(null));
    backdrop.addEventListener('click', e => { if (e.target === backdrop) close(null); });
    backdrop.querySelector('[data-act="recovery"]').addEventListener('click', () => {
      useRecovery = !useRecovery;
      msg.textContent = useRecovery
        ? 'Escribe uno de tus códigos de recuperación.'
        : 'Escribe el código de 6 dígitos de tu app autenticadora.';
      codeInput.placeholder = useRecovery ? 'xxxx-xxxx' : '123456';
      codeInput.value = ''; codeInput.focus();
    });

    async function submit(){
      const value = codeInput.value.trim();
      if (!value){ msg.textContent = 'Escribe el código.'; return; }
      verifyBtn.disabled = true; const prev = verifyBtn.textContent;
      verifyBtn.innerHTML = '<span class="spinner"></span> Verificando…';
      try{
        const payload = useRecovery
          ? { challengeToken, recoveryCode: value }
          : { challengeToken, code: value };
        const user = await auth.twoFactor(payload);
        close(user);
      } catch(e){
        msg.textContent = e.message || 'Código incorrecto.';
        verifyBtn.disabled = false; verifyBtn.textContent = prev;
        codeInput.select();
      }
    }
    verifyBtn.addEventListener('click', submit);
    codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  });
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
