'use strict';
/* =========================================================
   ADMIN MIDDLEWARE — exige que el usuario autenticado sea administrador.

   Seguridad: NO confía en ningún flag del token (que vive 15 min y podría
   quedar desfasado si se revoca el admin). Verifica `is_admin` contra la BD
   en cada petición al panel. Úsalo SIEMPRE después de `requireAuth`.
   ========================================================= */
import { findById } from '../services/user.service.js';
import { logEvent } from '../services/audit.service.js';

export async function requireAdmin(req, res, next){
  try{
    const user = await findById(req.user?.id);
    if (!user || !user.is_admin){
      // Deja rastro de cualquier intento de acceso no autorizado al panel.
      await logEvent('admin_access', `Acceso al panel denegado para ${req.user?.email || 'desconocido'}`, {
        severity: 'warn', userId: req.user?.id, userEmail: req.user?.email, ip: req.ip,
      });
      return res.status(403).json({ error: 'No tienes permiso para acceder al panel de administración.' });
    }
    req.admin = user;
    next();
  } catch(e){
    next(e);
  }
}
