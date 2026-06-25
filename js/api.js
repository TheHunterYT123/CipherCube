'use strict';
/* =========================================================
   API — cliente del backend de CipherCube (cuentas, perfil, planes, pagos).

   Configura la URL del backend con:
     window.CIPHERCUBE_API_BASE = 'https://api.tudominio.com'
   (ponlo en index.html antes de cargar app.js). Por defecto usa localhost.

   Los tokens se guardan en localStorage. El access token (corto) se manda en
   cada petición; si caduca, se renueva solo con el refresh token una vez.
   ========================================================= */
const API_BASE = (typeof window !== 'undefined' && window.CIPHERCUBE_API_BASE) || 'http://localhost:4000';

const ACCESS_KEY = 'cc-access';
const REFRESH_KEY = 'cc-refresh';

export function getAccessToken(){ return localStorage.getItem(ACCESS_KEY); }
export function getRefreshToken(){ return localStorage.getItem(REFRESH_KEY); }
export function isLoggedIn(){ return !!getRefreshToken(); }

function setTokens({ accessToken, refreshToken }){
  if (accessToken) localStorage.setItem(ACCESS_KEY, accessToken);
  if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
}
export function clearTokens(){
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

/** ¿Está configurado/alcanzable el backend? Cachea el resultado. */
let _backendUp = null;
export async function backendAvailable(){
  if (_backendUp !== null) return _backendUp;
  try{
    const res = await fetch(`${API_BASE}/health`, { method: 'GET' });
    _backendUp = res.ok;
  } catch(_){ _backendUp = false; }
  return _backendUp;
}

async function rawRequest(path, { method = 'GET', body, auth = false } = {}){
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth){
    const t = getAccessToken();
    if (t) headers['Authorization'] = `Bearer ${t}`;
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try{ data = await res.json(); } catch(_){ /* sin cuerpo */ }
  return { res, data };
}

async function tryRefresh(){
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;
  const { res, data } = await rawRequest('/api/auth/refresh', { method: 'POST', body: { refreshToken } });
  if (res.ok && data?.accessToken){ setTokens({ accessToken: data.accessToken }); return true; }
  clearTokens();
  return false;
}

/** Petición con auto-refresh del access token ante un 401. */
async function request(path, opts = {}){
  let { res, data } = await rawRequest(path, opts);
  if (res.status === 401 && opts.auth && await tryRefresh()){
    ({ res, data } = await rawRequest(path, opts));
  }
  if (!res.ok){
    const err = new Error(data?.error || `Error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ---- Auth ---- */
export const auth = {
  async register({ email, password, displayName }){
    const data = await request('/api/auth/register', { method: 'POST', body: { email, password, displayName } });
    setTokens(data);
    return data.user;
  },
  async login({ email, password }){
    const data = await request('/api/auth/login', { method: 'POST', body: { email, password } });
    // Puede devolver { twoFactorRequired, challengeToken } en vez de una sesión.
    if (data.twoFactorRequired) return data;
    setTokens(data);
    return { user: data.user };
  },
  async me(){
    const data = await request('/api/auth/me', { auth: true });
    return data.user;
  },
  async logout(){
    const refreshToken = getRefreshToken();
    try{ if (refreshToken) await rawRequest('/api/auth/logout', { method: 'POST', body: { refreshToken } }); }
    finally{ clearTokens(); }
  },
  /** Completa el login con el segundo factor. Guarda los tokens y devuelve el user. */
  async twoFactor({ challengeToken, code, recoveryCode }){
    const data = await request('/api/auth/2fa', { method: 'POST', body: { challengeToken, code, recoveryCode } });
    setTokens(data);
    return data.user;
  },
  verifyEmail(token){ return request('/api/auth/verify-email', { method: 'POST', body: { token } }); },
  resendVerification(){ return request('/api/auth/resend-verification', { method: 'POST', auth: true }); },
};

/* ---- 2FA (gestión desde el perfil) ---- */
export const twoFactor = {
  status(){ return request('/api/profile/2fa', { auth: true }); },
  setup(){ return request('/api/profile/2fa/setup', { method: 'POST', auth: true }); },
  enable(code){ return request('/api/profile/2fa/enable', { method: 'POST', auth: true, body: { code } }); },
  disable(password){ return request('/api/profile/2fa/disable', { method: 'POST', auth: true, body: { password } }); },
};

/* ---- Perfil ---- */
export const profile = {
  get(){ return request('/api/profile', { auth: true }).then(d => d.user); },
  update(fields){ return request('/api/profile', { method: 'PATCH', auth: true, body: fields }).then(d => d.user); },
  changePassword(currentPassword, newPassword){
    return request('/api/profile/change-password', { method: 'POST', auth: true, body: { currentPassword, newPassword } });
  },
};

/* ---- Planes y pagos ---- */
export const plans = {
  list(){ return request('/api/plans'); },
};
export const payments = {
  checkout({ plan, provider, currency }){
    return request('/api/payments/checkout', { method: 'POST', auth: true, body: { plan, provider, currency } });
  },
  paypalCapture(orderId){
    return request('/api/payments/paypal/capture', { method: 'POST', auth: true, body: { orderId } });
  },
};

/* ---- Panel de administración (requiere cuenta admin) ---- */
export const admin = {
  overview(){ return request('/api/admin/overview', { auth: true }); },
  users(){ return request('/api/admin/users', { auth: true }); },
  purchases(){ return request('/api/admin/purchases', { auth: true }); },
  attempts(){ return request('/api/admin/attempts', { auth: true }); },
  logs(){ return request('/api/admin/logs', { auth: true }); },
  stats(){ return request('/api/admin/stats', { auth: true }); },
  settings(){ return request('/api/admin/settings', { auth: true }); },
};
