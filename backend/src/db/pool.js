'use strict';
/* =========================================================
   DB POOL — conexión PostgreSQL compartida.
   ========================================================= */
import pg from 'pg';
import { config } from '../config.js';

const poolConfig = config.db.connectionString
  ? { connectionString: config.db.connectionString, ssl: config.db.ssl }
  : {
      host: config.db.host, port: config.db.port, user: config.db.user,
      password: config.db.password, database: config.db.database, ssl: config.db.ssl,
    };

export const pool = new pg.Pool(poolConfig);

pool.on('error', err => {
  console.error('[db] Error inesperado en cliente inactivo:', err.message);
});

/** Helper de consulta parametrizada (siempre con placeholders, nunca concatenación). */
export function query(text, params){ return pool.query(text, params); }
