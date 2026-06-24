'use strict';
/* =========================================================
   RATE LIMIT — frena fuerza bruta en auth y abuso general.
   ========================================================= */
import rateLimit from 'express-rate-limit';

// Límite estricto para login/registro (anti fuerza bruta).
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' },
});

// Límite general para el resto de la API.
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Baja el ritmo un momento.' },
});
