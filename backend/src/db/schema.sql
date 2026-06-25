-- =========================================================
-- CipherCube — esquema SQLite (desarrollo)
-- =========================================================

-- ---- Usuarios ----
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  email_normalized TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  display_name    TEXT,
  plan            TEXT NOT NULL DEFAULT 'free',
  plan_expires_at TEXT,
  email_verified  INTEGER NOT NULL DEFAULT 0,
  is_admin        INTEGER NOT NULL DEFAULT 0,
  totp_secret     TEXT,
  totp_enabled    INTEGER NOT NULL DEFAULT 0,
  last_login_at   TEXT,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---- Códigos de recuperación de 2FA (hasheados, de un solo uso) ----
CREATE TABLE IF NOT EXISTS totp_recovery_codes (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_recovery_user ON totp_recovery_codes(user_id);

-- ---- Tokens de verificación de correo (hasheados, de un solo uso) ----
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_emailverify_token ON email_verification_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_emailverify_user ON email_verification_tokens(user_id);

-- ---- Sesiones de refresh ----
CREATE TABLE IF NOT EXISTS refresh_sessions (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash     TEXT NOT NULL,
  user_agent     TEXT,
  ip             TEXT,
  expires_at     TEXT NOT NULL,
  revoked_at     TEXT,
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_token ON refresh_sessions(token_hash);

-- ---- Catálogo de planes ----
CREATE TABLE IF NOT EXISTS plans (
  key          TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  features     TEXT NOT NULL DEFAULT '[]',
  active       INTEGER NOT NULL DEFAULT 1,
  sort_order   INTEGER NOT NULL DEFAULT 0
);

-- ---- Pagos / órdenes ----
CREATE TABLE IF NOT EXISTS payments (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL,
  provider_ref     TEXT NOT NULL,
  plan_key         TEXT NOT NULL REFERENCES plans(key),
  amount           REAL,
  currency         TEXT,
  status           TEXT NOT NULL DEFAULT 'pending',
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (provider, provider_ref)
);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);

-- ---- Eventos de webhook (idempotencia) ----
CREATE TABLE IF NOT EXISTS webhook_events (
  id           TEXT PRIMARY KEY,
  provider     TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  received_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (provider, event_id)
);

-- ---- Intentos de compra (clics en "comprar" / inicios de checkout) ----
CREATE TABLE IF NOT EXISTS checkout_attempts (
  id           TEXT PRIMARY KEY,
  user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  user_email   TEXT,
  plan_key     TEXT NOT NULL,
  provider     TEXT NOT NULL,
  currency     TEXT,
  outcome      TEXT NOT NULL DEFAULT 'started', -- started | completed | abandoned
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_attempts_user ON checkout_attempts(user_id);
CREATE INDEX IF NOT EXISTS idx_attempts_created ON checkout_attempts(created_at);

-- ---- Auditoría / logs de eventos del sistema ----
CREATE TABLE IF NOT EXISTS audit_logs (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,                 -- register | login | login_failed | ...
  severity     TEXT NOT NULL DEFAULT 'info',  -- info | warn | error
  message      TEXT NOT NULL,
  user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  user_email   TEXT,
  ip           TEXT,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_logs(type);
CREATE INDEX IF NOT EXISTS idx_audit_severity ON audit_logs(severity);
