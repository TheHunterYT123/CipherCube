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
};

/** ¿Está configurado un proveedor de pago concreto? Sirve para no exponer
 * métodos de pago a medio configurar en el frontend. */
export function providerConfigured(name){
  if (name === 'stripe') return !!config.stripe.secretKey;
  if (name === 'paypal') return !!(config.paypal.clientId && config.paypal.clientSecret);
  if (name === 'mercadopago') return !!config.mercadopago.accessToken;
  return false;
}
