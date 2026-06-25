'use strict';
/* =========================================================
   CONFIG — carga y valida variables de entorno.
   Falla rápido en producción si falta algo crítico.
   ========================================================= */
import dotenv from 'dotenv';
dotenv.config();

const isProd = process.env.NODE_ENV === 'production';

function req(name, fallback){
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === ''){
    if (isProd) throw new Error(`Falta la variable de entorno obligatoria: ${name}`);
    return fallback;
  }
  return v;
}

function list(name, fallback){
  return req(name, fallback).split(',').map(s => s.trim()).filter(Boolean);
}

export const config = {
  isProd,
  port: parseInt(req('PORT', '4000'), 10),
  corsOrigins: list('CORS_ORIGINS', 'http://localhost:8643'),
  frontendUrl: req('FRONTEND_URL', 'http://localhost:8643'),
  publicBackendUrl: req('PUBLIC_BACKEND_URL', 'http://localhost:4000'),

  // Correos que se promueven a administrador al registrarse (en minúsculas).
  // El acceso al panel se valida SIEMPRE contra users.is_admin en la BD.
  adminEmails: list('ADMIN_EMAILS', 'thehunter9856@gmail.com').map(s => s.toLowerCase()),

  db: {
    connectionString: process.env.DATABASE_URL || undefined,
    host: process.env.PGHOST,
    port: process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : undefined,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
  },

  jwt: {
    accessSecret: req('JWT_ACCESS_SECRET', 'dev_access_secret_change_me'),
    refreshSecret: req('JWT_REFRESH_SECRET', 'dev_refresh_secret_change_me'),
    accessTtl: parseInt(req('ACCESS_TOKEN_TTL', '900'), 10),          // segundos
    refreshTtlDays: parseInt(req('REFRESH_TOKEN_TTL_DAYS', '30'), 10),
  },

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    prices: { plus: process.env.STRIPE_PRICE_PLUS || '', boveda: process.env.STRIPE_PRICE_BOVEDA || '' },
  },
  paypal: {
    clientId: process.env.PAYPAL_CLIENT_ID || '',
    clientSecret: process.env.PAYPAL_CLIENT_SECRET || '',
    env: process.env.PAYPAL_ENV || 'sandbox',
  },
  mercadopago: {
    accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN || '',
  },

  prices: {
    usd: { plus: process.env.PRICE_PLUS_USD || '4.99', boveda: process.env.PRICE_BOVEDA_USD || '9.99' },
    mxn: { plus: process.env.PRICE_PLUS_MXN || '99', boveda: process.env.PRICE_BOVEDA_MXN || '199' },
  },

  // Correo saliente (verificación de cuenta). Si no hay SMTP, en desarrollo el
  // enlace se imprime en consola; en producción el envío fallará (queda en log).
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : 587,
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'CipherCube <no-reply@ciphercube.app>',
  },
  // Si es true, el login exige correo verificado.
  requireEmailVerification: process.env.REQUIRE_EMAIL_VERIFICATION === 'true',
};

/** ¿Hay un servidor SMTP configurado para enviar correos de verdad? */
export function smtpConfigured(){
  return !!(config.smtp.host && config.smtp.user && config.smtp.pass);
}

/** ¿Está configurado un proveedor de pago concreto? Sirve para no exponer
 * métodos de pago a medio configurar en el frontend. */
export function providerConfigured(name){
  if (name === 'stripe') return !!config.stripe.secretKey;
  if (name === 'paypal') return !!(config.paypal.clientId && config.paypal.clientSecret);
  if (name === 'mercadopago') return !!config.mercadopago.accessToken;
  return false;
}
