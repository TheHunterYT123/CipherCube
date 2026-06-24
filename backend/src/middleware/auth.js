'use strict';
/* =========================================================
   AUTH MIDDLEWARE — exige un access token válido en Authorization.
   ========================================================= */
import { verifyAccessToken } from '../services/token.service.js';

export function requireAuth(req, res, next){
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token){
    return res.status(401).json({ error: 'No autenticado.' });
  }
  try{
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub, plan: payload.plan, email: payload.email };
    next();
  } catch(_){
    return res.status(401).json({ error: 'Sesión inválida o expirada.' });
  }
}
