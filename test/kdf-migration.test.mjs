// Prueba de migración PBKDF2 -> Argon2id con compatibilidad retroactiva.
// Ejecutar con: node test/kdf-migration.test.mjs
//
// El WASM real de argon2-browser es poco fiable bajo Node (problemas de
// resolución de rutas de Emscripten ajenos a nuestro código). Por eso aquí
// se sustituye window.argon2 por una versión determinística (SHA-256, NO es
// Argon2id real) SOLO para probar la integración: empaquetado de bits,
// selección de KDF, fallback y el caso de error explícito. El cómputo real
// de Argon2id se verifica por separado en el navegador real.
import assert from 'node:assert/strict';

globalThis.window = globalThis;
let scriptShouldLoad = true;
globalThis.document = {
  createElement(){
    const el = {};
    queueMicrotask(() => {
      if (scriptShouldLoad) { if (el.onload) el.onload(); }
      else { if (el.onerror) el.onerror(new Error('fake network error')); }
    });
    return el;
  },
  head: { appendChild(){} },
};
globalThis.window.argon2 = {
  ArgonType: { Argon2d: 0, Argon2i: 1, Argon2id: 2 },
  async hash({ pass, salt }){
    const enc = new TextEncoder();
    const saltBytes = salt instanceof Uint8Array ? salt : enc.encode(String(salt));
    const data = new Uint8Array([...enc.encode(String(pass)), ...saltBytes]);
    const buf = await crypto.subtle.digest('SHA-256', data);
    return { hash: new Uint8Array(buf), hashHex: Buffer.from(buf).toString('hex') };
  },
};

const crypto_ = await import('../js/crypto.js');
const loader = await import('../js/argon2-loader.js');

let passed = 0, failed = 0;
async function test(name, fn){
  try{ await fn(); console.log(`OK   ${name}`); passed++; }
  catch(e){ console.error(`FAIL ${name}\n     ${e.message}`); failed++; }
}

// ---- 1. v1 / PBKDF2: Argon2 nunca se cargó en este proceso todavía ----
await test('buildPayload sin Argon2 disponible genera v1 (PBKDF2) y nunca lanza error', async () => {
  assert.equal(loader.isArgon2Available(), false);
  const built = await crypto_.buildPayload({ secretText: 'secreto-v1', realPass: 'frase-real-123', hiddenEnabled: false, tier: 'mini' });
  assert.equal(built.kdf, 'pbkdf2');
});

await test('round-trip v1 (PBKDF2): generar y descifrar con la frase correcta', async () => {
  const built = await crypto_.buildPayload({ secretText: 'secreto-v1', realPass: 'frase-real-123', hiddenEnabled: false, tier: 'mini' });
  const result = await crypto_.tryDecryptPayload(built.payload, 'frase-real-123');
  assert.equal(result.text, 'secreto-v1');
  assert.equal(result.kdf, 'pbkdf2');
});

await test('compatibilidad retroactiva: un cubo "antiguo" (byte de flags sin bit de KDF) se lee como PBKDF2', async () => {
  // Construye un payload a mano como lo haría el código anterior a esta migración,
  // donde payload[3] solo podía ser 0 o 1 (nunca tenía el bit de KDF).
  const built = await crypto_.buildPayload({ secretText: 'secreto-legacy', realPass: 'frase-legacy-1', hiddenEnabled: true, decoyPass: 'frase-senuelo-1', decoyText: 'señuelo', tier: 'mini' });
  // Por las dudas, fuerza el byte de flags al estilo legacy estricto (solo 0 o 1).
  built.payload[3] = built.payload[3] & 0x01;
  const real = await crypto_.tryDecryptPayload(built.payload, 'frase-legacy-1');
  assert.equal(real.text, 'secreto-legacy');
  assert.equal(real.kdf, 'pbkdf2');
  const decoy = await crypto_.tryDecryptPayload(built.payload, 'frase-senuelo-1');
  assert.equal(decoy.text, 'señuelo');
});

// ---- 2. v2 marcado pero Argon2 NO disponible en este dispositivo: error claro, no adivinar ----
await test('cubo v2 sin Argon2id disponible: lanza el error claro, no intenta PBKDF2 ni falla en silencio', async () => {
  assert.equal(loader.isArgon2Available(), false);
  const built = await crypto_.buildPayload({ secretText: 'x', realPass: 'frase-real-123', hiddenEnabled: false, tier: 'mini' });
  // Simula un cubo v2 marcando el bit de Argon2id a mano (en este proceso Argon2 sigue sin cargar).
  built.payload[3] = built.payload[3] | 0x02;
  await assert.rejects(
    () => crypto_.tryDecryptPayload(built.payload, 'frase-real-123'),
    (err) => {
      assert.equal(err.message, 'Este cubo requiere Argon2id, no disponible en este navegador.');
      return true;
    }
  );
});

// ---- 3. Cargar Argon2id (simulado) y probar v2 de verdad ----
await test('loadArgon2() deja isArgon2Available()=true tras el hash de prueba', async () => {
  const ok = await loader.loadArgon2();
  assert.equal(ok, true);
  assert.equal(loader.isArgon2Available(), true);
});

await test('buildPayload con Argon2 disponible genera v2 y usa deriveKeyV2Argon2id', async () => {
  const built = await crypto_.buildPayload({ secretText: 'secreto-v2', realPass: 'frase-real-456', hiddenEnabled: false, tier: 'mini' });
  assert.equal(built.kdf, 'argon2id');
  assert.equal((built.payload[3] & 0x02) !== 0, true);
});

await test('round-trip v2 (Argon2id): generar y descifrar con la frase correcta', async () => {
  const built = await crypto_.buildPayload({ secretText: 'secreto-v2', realPass: 'frase-real-456', hiddenEnabled: false, tier: 'mini' });
  const result = await crypto_.tryDecryptPayload(built.payload, 'frase-real-456');
  assert.equal(result.text, 'secreto-v2');
  assert.equal(result.kdf, 'argon2id');
});

await test('round-trip v2 con volumen oculto: real y señuelo descifran correctamente, ambos bits coexisten', async () => {
  const built = await crypto_.buildPayload({
    secretText: 'secreto-oculto-v2', realPass: 'frase-real-789',
    hiddenEnabled: true, decoyPass: 'frase-senuelo-789', decoyText: 'contenido señuelo v2',
    tier: 'estandar',
  });
  assert.equal(built.payload[3], 0x03); // hidden(0x01) | argon2id(0x02)
  const real = await crypto_.tryDecryptPayload(built.payload, 'frase-real-789');
  assert.equal(real.text, 'secreto-oculto-v2');
  assert.equal(real.slot, 'oculto');
  assert.equal(real.kdf, 'argon2id');
  const decoy = await crypto_.tryDecryptPayload(built.payload, 'frase-senuelo-789');
  assert.equal(decoy.text, 'contenido señuelo v2');
  assert.equal(decoy.slot, 'decoy');
});

await test('v2 con frase incorrecta: error genérico de frase, no el error de "Argon2 no disponible"', async () => {
  const built = await crypto_.buildPayload({ secretText: 'secreto-v2b', realPass: 'frase-correcta-000', hiddenEnabled: false, tier: 'mini' });
  await assert.rejects(
    () => crypto_.tryDecryptPayload(built.payload, 'frase-incorrecta-999'),
    (err) => {
      assert.equal(err.message, 'Frase incorrecta, o el cubo está dañado más allá de lo recuperable.');
      return true;
    }
  );
});

await test('un cubo v1 (PBKDF2) se sigue leyendo igual aunque este dispositivo ya tenga Argon2 disponible', async () => {
  assert.equal(loader.isArgon2Available(), true);
  // Reconstruye un v1 a mano (Argon2 disponible no debe afectar la lectura de un cubo marcado como v1).
  const built = await crypto_.buildPayload({ secretText: 'secreto-v1-otra-vez', realPass: 'frase-v1-2', hiddenEnabled: false, tier: 'mini' });
  built.payload[3] = built.payload[3] & ~0x02; // fuerza el bit de KDF a PBKDF2 aunque Argon2 esté disponible
  // Como el payload se cifró realmente con Argon2id (built.kdf era argon2id), forzar el bit a PBKDF2
  // debe hacer que el descifrado FALLE (la clave no coincide) — confirma que el bit decide el KDF de verdad.
  await assert.rejects(() => crypto_.tryDecryptPayload(built.payload, 'frase-v1-2'));
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
if (failed > 0) process.exitCode = 1;
