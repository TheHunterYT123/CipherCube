// Valida la decodificación Reed-Solomon por BORRONES (erasures) de forma aislada,
// porque la aritmética en GF(256) es delicada: si está mal, hay que cazarlo aquí y
// no en el escáner. Comprueba que corrige hasta `parity` borrones (el doble que la
// corrección ciega), que respeta posiciones de borrón cualesquiera y que NUNCA
// valida una corrección falsa.
//
// Ejecutar: node test/rs-erasure.test.mjs
import assert from 'node:assert/strict';
const c = await import('../js/crypto.js');
const { rsEncodeBlock, rsDecodeBlock, rsDecodeBlockErasures, rsDecodeRawToPayload, rsDecodeRawWithErasures,
  rsEncodePayloadToRaw, buildPayload, effectiveCapacityForGrid, TIERS, RS_K, RS_PARITY, RS_N } = c;

let passed = 0, failed = 0;
function test(name, fn){ try{ fn(); console.log(`OK   ${name}`); passed++; } catch(e){ console.error(`FAIL ${name}\n     ${e.message}`); failed++; } }
function rng(seed){ let s=seed>>>0; return ()=>{ s=(s*1664525+1013904223)>>>0; return s/4294967296; }; }

const k = RS_K, parity = RS_PARITY, n = RS_N; // 32, 8, 40

function makeCodeword(seed){
  const r = rng(seed);
  const data = new Uint8Array(k); for (let i=0;i<k;i++) data[i] = (r()*256)|0;
  return rsEncodeBlock(data, parity); // n bytes
}

test('sin errores: erasure decode devuelve el dato intacto', () => {
  const cw = makeCodeword(1);
  const res = rsDecodeBlockErasures(cw, k, parity, [3, 10, 20]);
  assert.ok(res.success); assert.deepEqual([...res.data], [...cw.slice(0, k)]);
});

test('corrige EXACTAMENTE parity (8) borrones, donde la ciega (4) ya no puede', () => {
  const r = rng(7);
  const cw = makeCodeword(2);
  const corrupt = new Uint8Array(cw);
  const positions = [0, 5, 9, 14, 19, 25, 31, 38]; // 8 posiciones (mezcla datos y paridad)
  for (const p of positions){ let e=0; while(e===0) e=(r()*256)|0; corrupt[p] ^= e; }
  // La corrección ciega NO puede con 8 errores (>4).
  assert.equal(rsDecodeBlock(corrupt, k, parity).success, false, 'la ciega no debería poder con 8');
  // Con las 8 posiciones marcadas como borrón, SÍ.
  const res = rsDecodeBlockErasures(corrupt, k, parity, positions);
  assert.ok(res.success, 'erasure debería corregir 8 borrones');
  assert.deepEqual([...res.data], [...cw.slice(0, k)], 'dato recuperado no coincide');
});

test('marcar de más (incluir bytes buenos como borrón) sigue recuperando', () => {
  const r = rng(11);
  const cw = makeCodeword(3);
  const corrupt = new Uint8Array(cw);
  const realBad = [4, 17, 30]; // solo 3 errores reales
  for (const p of realBad){ let e=0; while(e===0) e=(r()*256)|0; corrupt[p] ^= e; }
  // Marcamos 8 borrones: los 3 reales + 5 buenos. Debe recuperar igual (Y=0 en los buenos).
  const marks = [4, 17, 30, 1, 7, 12, 22, 35];
  const res = rsDecodeBlockErasures(corrupt, k, parity, marks);
  assert.ok(res.success);
  assert.deepEqual([...res.data], [...cw.slice(0, k)]);
});

test('NO valida si un error real queda FUERA de los borrones marcados', () => {
  const r = rng(13);
  const cw = makeCodeword(4);
  const corrupt = new Uint8Array(cw);
  const bad = [2, 8, 15, 21, 28]; // 5 errores
  for (const p of bad){ let e=0; while(e===0) e=(r()*256)|0; corrupt[p] ^= e; }
  // Marcamos solo 4 de los 5 → debe FALLAR (no inventa), porque queda 1 error sin marcar.
  const res = rsDecodeBlockErasures(corrupt, k, parity, [2, 8, 15, 21]);
  assert.equal(res.success, false, 'no debería validar con un error sin marcar');
});

test('más de parity borrones → falla sin reventar', () => {
  const cw = makeCodeword(5);
  const res = rsDecodeBlockErasures(cw.map((b,i)=> i<10 ? b^0x55 : b), k, parity, [0,1,2,3,4,5,6,7,8,9]);
  assert.equal(res.success, false);
});

// ---- Nivel raw (rsDecodeRawWithErasures): defecto LOCALIZADO en un cubo real ----
const grid = TIERS.mini.grid;
const built = await buildPayload({ secretText: 'BORRONES', realPass: 'clave12', hiddenEnabled: false, tier: 'mini' });
const trueRaw = rsEncodePayloadToRaw(built.payload, grid, built.parity);
const { numBlocks } = effectiveCapacityForGrid(grid, built.parity);

test('raw: defecto contiguo de 6 bytes en 1 bloque (rompe la ciega) se recupera por borrones', () => {
  const raw = new Uint8Array(trueRaw);
  // corrompe 6 bytes contiguos del bloque 1 (>4 → la ciega no puede; ≤ parity-2 → borrones sí)
  const base = 1 * RS_N + 10;
  for (let i = 0; i < 6; i++) raw[base + i] ^= 0x9 + i;
  // sin info de borrones (corrección ciega global) → falla
  let blind = false; try{ rsDecodeRawToPayload(raw, grid, built.parity); } catch(_){ blind = true; }
  assert.ok(blind, 'la ciega no debería poder con 6 errores en un bloque');
  // sospecha alta justo en esos bytes → borrones recuperan
  const sus = new Float64Array(raw.length); for (let i = 0; i < 6; i++) sus[base + i] = 100000;
  const { payload } = rsDecodeRawWithErasures(raw, grid, built.parity, sus);
  assert.equal(Buffer.from(payload).toString('hex'), Buffer.from(built.payload).toString('hex'));
});

test('raw: sin bytes sospechosos, un cubo limpio se decodifica igual (sin tocar nada)', () => {
  const sus = new Float64Array(trueRaw.length); // todo 0 = nada sospechoso
  const { payload } = rsDecodeRawWithErasures(new Uint8Array(trueRaw), grid, built.parity, sus);
  assert.equal(Buffer.from(payload).toString('hex'), Buffer.from(built.payload).toString('hex'));
});

test('raw: daño más allá de la capacidad (mitad de un bloque) NO se inventa un resultado', () => {
  const raw = new Uint8Array(trueRaw);
  const base = 2 * RS_N;
  for (let i = 0; i < 20; i++) raw[base + i] ^= 0x33; // 20 bytes destruidos: irrecuperable
  const sus = new Float64Array(raw.length); for (let i = 0; i < 20; i++) sus[base + i] = 100000;
  let threw = false; try{ rsDecodeRawWithErasures(raw, grid, built.parity, sus); } catch(_){ threw = true; }
  assert.ok(threw, 'no debería devolver un payload falso ante daño irrecuperable');
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
if (failed > 0) process.exitCode = 1;
