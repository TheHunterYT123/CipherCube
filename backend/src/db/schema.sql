-- =========================================================
-- CipherCube — esquema de base de datos
-- Idempotente: se puede correr varias veces sin romper nada.
-- =========================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---- Usuarios ----
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT NOT NULL UNIQUE,
  email_normalized TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  display_name    TEXT,
  plan            TEXT NOT NULL DEFAULT 'free',     -- free | plus | boveda
  plan_expires_at TIMESTAMPTZ,                       -- NULL = sin expiración / no aplica
  email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- Sesiones de refresh (permiten revocar) ----
CREATE TABLE IF NOT EXISTS refresh_sessions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash     TEXT NOT NULL,            -- hash SHA-256 del refresh token
  user_agent     TEXT,
  ip             TEXT,
  expires_at     TIMESTAMPTZ NOT NULL,
  revoked_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_token ON refresh_sessions(token_hash);

-- ---- Catálogo de planes ----
CREATE TABLE IF NOT EXISTS plans (
  key          TEXT PRIMARY KEY,          -- free | plus | boveda
  name         TEXT NOT NULL,
  description  TEXT,
  features     JSONB NOT NULL DEFAULT '[]',
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order   INTEGER NOT NULL DEFAULT 0
);

-- ---- Pagos / órdenes ----
CREATE TABLE IF NOT EXISTS payments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL,         -- stripe | paypal | mercadopago
  provider_ref     TEXT NOT NULL,         -- id de sesión/orden en el proveedor
  plan_key         TEXT NOT NULL REFERENCES plans(key),
  amount           NUMERIC(12,2),
  currency         TEXT,
  status           TEXT NOT NULL DEFAULT 'pending', -- pending | paid | failed | refunded
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_ref)
);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);

-- ---- Eventos de webhook procesados (idempotencia anti-doble-credito) ----
CREATE TABLE IF NOT EXISTS webhook_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider     TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);
