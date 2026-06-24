'use strict';
/* =========================================================
   VALIDATE — esquemas de entrada con zod + helper de validación.
   ========================================================= */
import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string({ required_error: 'Escribe tu correo' }).trim().toLowerCase().email('Correo inválido').max(254),
  password: z.string({ required_error: 'Escribe una contraseña' }).min(8, 'La contraseña debe tener al menos 8 caracteres').max(200),
  displayName: z.string().trim().min(1).max(80).optional(),
});

export const loginSchema = z.object({
  email: z.string({ required_error: 'Escribe tu correo' }).trim().toLowerCase().email('Correo inválido').max(254),
  password: z.string({ required_error: 'Escribe tu contraseña' }).min(1, 'Escribe tu contraseña').max(200),
});

export const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(8, 'La nueva contraseña debe tener al menos 8 caracteres').max(200),
});

export const checkoutSchema = z.object({
  plan: z.enum(['plus', 'boveda']),
  provider: z.enum(['stripe', 'paypal', 'mercadopago']),
  currency: z.enum(['usd', 'mxn']).optional().default('usd'),
});

/** Valida `data` contra un esquema; lanza un error 400 legible si falla. */
export function parse(schema, data){
  const result = schema.safeParse(data);
  if (!result.success){
    const msg = result.error.issues.map(i => i.message).join('. ');
    const err = new Error(msg || 'Datos inválidos');
    err.status = 400;
    throw err;
  }
  return result.data;
}
