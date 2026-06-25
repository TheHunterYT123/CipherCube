'use strict';
/* =========================================================
   DB POOL — driver dual: PostgreSQL (producción) o SQLite (desarrollo).

   - Se usa PostgreSQL si hay DATABASE_URL o PGHOST (y DB_DRIVER!='sqlite').
   - En otro caso, SQLite (better-sqlite3), pensado para desarrollo local.

   La API `query(text, params)` es ASÍNCRONA en ambos y devuelve
   `{ rows, rowCount }`. Escribe el SQL con marcadores `?` (estilo SQLite);
   para PostgreSQL se traducen a `$1, $2, …` automáticamente. Mantén el SQL en
   el subconjunto portable (CURRENT_TIMESTAMP, ON CONFLICT, RETURNING) — ya
   válido en SQLite 3.35+ y en PostgreSQL.
   ========================================================= */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '../../ciphercube.db');

const usePg = !!(config.db.connectionString || config.db.host) && process.env.DB_DRIVER !== 'sqlite';

let driver, _sqlite = null, _pg = null;

if (usePg){
  const pg = (await import('pg')).default;
  _pg = new pg.Pool({
    connectionString: config.db.connectionString,
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    ssl: config.db.ssl,
  });
  driver = 'pg';
} else {
  const Database = (await import('better-sqlite3')).default;
  _sqlite = new Database(dbPath);
  _sqlite.pragma('journal_mode = WAL');
  _sqlite.pragma('foreign_keys = ON');
  driver = 'sqlite';
}

export function getDriver(){ return driver; }

/** Traduce los marcadores `?` a `$1, $2, …` para PostgreSQL. */
function toPgPlaceholders(text){
  let i = 0;
  return text.replace(/\?/g, () => `$${++i}`);
}

/**
 * Ejecuta una consulta parametrizada. Async en ambos drivers.
 * @returns {Promise<{rows: object[], rowCount: number}>}
 */
export async function query(text, params = []){
  try{
    if (driver === 'pg'){
      const res = await _pg.query(toPgPlaceholders(text), params);
      return { rows: res.rows, rowCount: res.rowCount };
    }
    const stmt = _sqlite.prepare(text);
    const upper = text.trim().toUpperCase();
    const returnsRows = upper.startsWith('SELECT') || upper.startsWith('WITH')
      || upper.startsWith('PRAGMA') || /\bRETURNING\b/i.test(text);
    if (returnsRows){
      const rows = stmt.all(...params);
      return { rows, rowCount: rows.length };
    }
    const info = stmt.run(...params);
    return { rows: [], rowCount: info.changes };
  } catch(e){
    console.error('[db] Query error:', e.message);
    throw e;
  }
}

/** Ejecuta SQL crudo de varias sentencias (para aplicar el esquema). */
export async function exec(sql){
  if (driver === 'pg'){ await _pg.query(sql); }
  else { _sqlite.exec(sql); }
}

/** Cierra la conexión (lo usan los scripts CLI para terminar). */
export async function closePool(){
  if (driver === 'pg') await _pg.end();
  else _sqlite.close();
}

// Acceso de bajo nivel a SQLite (solo para utilidades que lo necesiten en dev).
export const sqlite = _sqlite;
