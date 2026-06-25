'use strict';
/* =========================================================
   EMAIL SERVICE — envío de correos transaccionales (verificación).
   Usa SMTP si está configurado (nodemailer). En desarrollo, sin SMTP,
   imprime el enlace en consola para poder probar el flujo sin proveedor.
   ========================================================= */
import nodemailer from 'nodemailer';
import { config, smtpConfigured } from '../config.js';

let _transport = null;
function transport(){
  if (_transport) return _transport;
  _transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  });
  return _transport;
}

/** Envía (o registra, en dev) el correo de verificación con su enlace. */
export async function sendVerificationEmail(user, rawToken){
  const link = `${config.frontendUrl}/?verify=${encodeURIComponent(rawToken)}`;

  if (!smtpConfigured()){
    // Sin SMTP: no se puede enviar de verdad. En dev mostramos el enlace.
    if (!config.isProd){
      console.log(`\n[email] (DEV) Verifica ${user.email} aquí:\n  ${link}\n`);
    } else {
      console.error(`[email] SMTP no configurado: no se pudo enviar verificación a ${user.email}.`);
    }
    return { sent: false, link };
  }

  await transport().sendMail({
    from: config.smtp.from,
    to: user.email,
    subject: 'Verifica tu cuenta de CipherCube',
    text: `Bienvenido a CipherCube.\n\nVerifica tu correo abriendo este enlace:\n${link}\n\nSi no creaste esta cuenta, ignora este mensaje.`,
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto">
        <h2>Bienvenido a CipherCube 🔐</h2>
        <p>Confirma tu correo para activar tu cuenta:</p>
        <p><a href="${link}" style="display:inline-block;padding:12px 20px;background:#0072B2;color:#fff;border-radius:8px;text-decoration:none">Verificar mi correo</a></p>
        <p style="color:#666;font-size:13px">O copia este enlace: <br>${link}</p>
        <p style="color:#999;font-size:12px">Si no creaste esta cuenta, ignora este mensaje.</p>
      </div>`,
  });
  return { sent: true, link };
}
