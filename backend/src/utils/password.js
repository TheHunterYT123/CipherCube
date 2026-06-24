'use strict';
/* =========================================================
   PASSWORD — hash y verificación con bcryptjs (sin dependencias nativas,
   compila sin problemas en cualquier VPS).
   ========================================================= */
import bcrypt from 'bcryptjs';

const ROUNDS = 12;

export async function hashPassword(plain){
  return bcrypt.hash(plain, ROUNDS);
}
export async function verifyPassword(plain, hash){
  return bcrypt.compare(plain, hash);
}
