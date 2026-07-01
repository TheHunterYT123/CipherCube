// Regresión con DATOS REALES: el diagnóstico del usuario (2026-07-01) escaneando
// el cubo desde una PANTALLA con moiré fuerte del pixelado del monitor.
//
// Con los modos de color previos ('mean'/'median'/'cluster', caja del 22% de
// celda) este escaneo dejaba 8/32 bloques irrecuperables (caras 3 y 6): el moiré
// mete ruido de color disperso que ni la caja chica promedia, ni los borrones
// alcanzan (>6 bytes/bloque), ni el re-clustering por cara arregla. MEDIDO: la
// caja ANCHA (30% de celda, media) baja el daño a 1/32 y la rejilla
// micro-desplazada ±8% de celda esquiva la fase del moiré → 0/32 (descifra).
// Eso es exactamente lo que implementan los modos 'cw*' de decodeCanonicalFaces.
//
// El fixture test/fixtures/pantalla-moire-v24.png es la imagen de diagnóstico
// real generada por la app en el teléfono del usuario (contenido: cifrado).
//
// Ejecutar: node test/scan-screen-moire.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
globalThis.window = globalThis;
globalThis.document = { createElement(){ return {}; }, head:{ appendChild(){} } };

import { decodePng, diagnosticFaces } from './pnglite.mjs';
const { TIERS, MAGIC } = await import('../js/crypto.js');
const { decodeCanonicalFaces, readCanonicalFaceId, FACE_COUNT } = await import('../js/cube3d.js');

let passed = 0, failed = 0;
async function test(name, fn){
  try{ await fn(); console.log(`OK   ${name}`); passed++; }
  catch(e){ console.error(`FAIL ${name}\n     ${e.message}`); failed++; }
}

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pantalla-moire-v24.png');
const img = decodePng(readFileSync(fixture));
const canonByFace = diagnosticFaces(img, FACE_COUNT);

await test('las 6 caras del fixture se identifican (control de layout)', () => {
  for (let f = 0; f < FACE_COUNT; f++){
    const id = readCanonicalFaceId(canonByFace[f]);
    assert.equal(id.ok, true, `cara ${f + 1} ilegible`);
    assert.equal(id.faceIndex, f, `cara ${f + 1} con identidad equivocada`);
  }
});

await test('el escaneo REAL desde pantalla con moiré RECONSTRUYE (fase identity, la de auto-verificación)', () => {
  const t0 = Date.now();
  const r = decodeCanonicalFaces(canonByFace, TIERS, { phases: ['identity'] });
  const ms = Date.now() - t0;
  assert.equal(r.grid, 24);
  assert.equal(r.payload[0], MAGIC[0]);
  assert.equal(r.payload[1], MAGIC[1]);
  assert.equal(r.payload[2], MAGIC[2]);
  console.log(`     (tier=${r.tier} paridad=${r.parity} corregidos=${r.totalCorrected} en ${ms} ms)`);
});

await test('el decode COMPLETO (con permutación) también reconstruye', () => {
  const r = decodeCanonicalFaces(canonByFace, TIERS);
  assert.equal(r.grid, 24);
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
if (failed) process.exit(1);
