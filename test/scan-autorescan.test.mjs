// Regresión del arreglo "que el escaneo SÍ descifre": el diagnóstico real del
// usuario mostró que solo UNA cara sale dañada (reflejo localizado) y tumba todo el
// descifrado (RS exige todos los bloques limpios). Este test prueba, sobre la cadena
// REAL (detectTile → refineTileCorners → warpToCanonical → faceScanQuality / decode):
//
//   1) faceScanQuality: la COMPUERTA de reflejo rechaza una cara con brillo especular
//      y NO rechaza caras limpias (mini y Pro, para no penalizar Pro por su grid fino).
//   2) decodeCanonicalFaces({phases:['identity']}): la ruta rápida de auto-verificación
//      descifra un cubo limpio; con el fallback 'permute' sigue recuperando un cubo con
//      caras mal etiquetadas (no romper lo que ya funcionaba).
//   3) Bucle guiado: 5 caras limpias + 1 con reflejo → la reconstrucción rápida FALLA y
//      diagnoseCanonicalFaces culpa a esa cara; al reemplazarla por una recaptura limpia
//      → reconstrucción OK. Es exactamente el "2/32 en la cara 1 → re-pide cara 1 → 0/32".
//
// Ejecutar: node test/scan-autorescan.test.mjs
import assert from 'node:assert/strict';
globalThis.window = globalThis;
globalThis.document = { createElement(){ return {}; }, head:{ appendChild(){} } };

const crypto_ = await import('../js/crypto.js');
const cube = await import('../js/cube3d.js');
const { PALETTE, TIERS, buildPayload, rsEncodePayloadToRaw, payloadToColorIndices, computeHomography, applyHomography } = crypto_;
const {
  detectTile, refineTileCorners, warpToCanonical, readCanonicalFaceId, faceScanQuality,
  decodeCanonicalFaces, diagnoseCanonicalFaces, faceSliceFromColorIndices, FACE_COUNT,
} = cube;

// --- Geometría de baldosa (copiada de cube3d.js; no exportada) ---
const F = 0.07, B = 0.10, G = 0.03, DI = F + B + G, FINDER = 0.075;
const FINDER_CENTERS = [[F + B / 2, F + B / 2], [1 - F - B / 2, F + B / 2], [1 - F - B / 2, 1 - F - B / 2], [F + B / 2, 1 - F - B / 2]];
const CANONICAL_DARK = [true, true, false, true];
const ID_BIT_X = [0.42, 0.50, 0.58], ID_BIT_Y = F + B / 2;
const BLACK = [10, 10, 10], WHITE = [255, 255, 255];
const hexToRgb = h => { const v = h.replace('#', ''); return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)]; };

function tileColorAt(nx, ny, cells, grid, faceIndex){
  if (nx < F || nx > 1 - F || ny < F || ny > 1 - F) return BLACK;
  for (let i = 0; i < 4; i++){ if (!CANONICAL_DARK[i]) continue; const [cx, cy] = FINDER_CENTERS[i]; if (Math.abs(nx - cx) < FINDER / 2 && Math.abs(ny - cy) < FINDER / 2) return BLACK; }
  for (let b = 0; b < 3; b++){ const bit = (faceIndex >> (2 - b)) & 1; if (!bit) continue; const s = FINDER * 0.7 / 2; if (Math.abs(nx - ID_BIT_X[b]) < s && Math.abs(ny - ID_BIT_Y) < s) return BLACK; }
  if (nx >= DI && nx <= 1 - DI && ny >= DI && ny <= 1 - DI){ const span = 1 - 2 * DI, cellN = span / grid; const c = Math.min(grid - 1, Math.floor((nx - DI) / cellN)); const r = Math.min(grid - 1, Math.floor((ny - DI) / cellN)); return hexToRgb(PALETTE[cells[r * grid + c]]); }
  return WHITE;
}
const SAMPLE_SIZE = 720, GUIDE_INSET = 0.09;
function guideCorners(){ const m = Math.round(SAMPLE_SIZE * GUIDE_INSET), e = SAMPLE_SIZE - m; return [[m, m], [e, m], [e, e], [m, e]]; }
function makeRng(seed){ let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

/** "Foto" SAMPLE_SIZE² con la baldosa encuadrada + opción de REFLEJO especular
 * (glare), compuesto tras estampar para tapar de verdad las celdas. */
function makePhoto(cells, grid, faceIndex, {
  scale = 0.97, rotDeg = 0, bg = 232, glare = 0, glareCx = 0.5, glareCy = 0.5, glareR = 0.2, seed = 1,
} = {}){
  const W = SAMPLE_SIZE, H = SAMPLE_SIZE;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++){ data[i * 4] = bg; data[i * 4 + 1] = bg; data[i * 4 + 2] = bg; data[i * 4 + 3] = 255; }
  const guide = guideCorners(); const gs = guide[1][0] - guide[0][0];
  const cx = (guide[0][0] + guide[2][0]) / 2, cy = (guide[0][1] + guide[2][1]) / 2;
  const span = gs * scale, half = span / 2, th = rotDeg * Math.PI / 180, cos = Math.cos(th), sin = Math.sin(th);
  const rot = (x, y) => [cx + x * cos - y * sin, cy + x * sin + y * cos];
  const photoCorners = [rot(-half, -half), rot(half, -half), rot(half, half), rot(-half, half)];
  const Hm = computeHomography([[0, 0], [1, 0], [1, 1], [0, 1]], photoCorners), N = 900;
  const faceU = new Float32Array(W * H).fill(-1), faceV = new Float32Array(W * H).fill(-1);
  for (let iy = 0; iy <= N; iy++) for (let ix = 0; ix <= N; ix++){
    const mu = ix / N, mv = iy / N;
    const [px, py] = applyHomography(Hm, mu, mv), x = Math.round(px), y = Math.round(py);
    if (x < 0 || x >= W || y < 0 || y >= H) continue;
    const [r, g, b] = tileColorAt(mu, mv, cells, grid, faceIndex);
    const di = (y * W + x) * 4; data[di] = r; data[di + 1] = g; data[di + 2] = b; data[di + 3] = 255;
    faceU[y * W + x] = mu; faceV[y * W + x] = mv;
  }
  if (glare){
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++){
      const u = faceU[y * W + x]; if (u < 0) continue;
      const v = faceV[y * W + x];
      const d2 = (u - glareCx) ** 2 + (v - glareCy) ** 2;
      const add = glare * Math.exp(-d2 / (2 * glareR * glareR));
      if (add < 1) continue;
      const di = (y * W + x) * 4;
      data[di] = Math.min(255, data[di] + add); data[di + 1] = Math.min(255, data[di + 1] + add); data[di + 2] = Math.min(255, data[di + 2] + add);
    }
  }
  return data;
}

function captureFace(cells, grid, faceIndex, params){
  const guide = guideCorners();
  const data = makePhoto(cells, grid, faceIndex, params);
  const det = detectTile(data, SAMPLE_SIZE, SAMPLE_SIZE, guide);
  if (!det.ok) return { ok: false };
  const refined = refineTileCorners(data, SAMPLE_SIZE, SAMPLE_SIZE, guide, det.rotation);
  const canon = warpToCanonical(data, SAMPLE_SIZE, SAMPLE_SIZE, refined, det.rotation);
  const idInfo = readCanonicalFaceId(canon);
  return { ok: true, faceIndex: idInfo.ok ? idInfo.faceIndex : det.faceIndex, canon };
}

let passed = 0, failed = 0;
function test(name, fn){ try{ fn(); console.log(`OK   ${name}`); passed++; } catch(e){ console.error(`FAIL ${name}\n     ${e.message}`); failed++; } }

// --- Cubo de prueba (mini) ---
const grid = TIERS.mini.grid;
const built = await buildPayload({ secretText: 'RE-ESCANEO AUTO', realPass: 'clave-larga-1', hiddenEnabled: false, tier: 'mini' });
const indices = payloadToColorIndices(rsEncodePayloadToRaw(built.payload, grid, built.parity));
const faceCells = f => faceSliceFromColorIndices(indices, grid, f);
const cleanCanon = f => { const cap = captureFace(faceCells(f), grid, f, { scale: 0.97, rotDeg: f % 2 ? 1 : -1 }); assert.ok(cap.ok, `cara ${f} no capturada`); return cap.canon; };

// Cubo Pro (grid fino) para confirmar que la compuerta de reflejo no da falsos
// positivos por el tamaño de celda.
const gridPro = TIERS.pro.grid;
const builtPro = await buildPayload({ secretText: 'PRO LIMPIA', realPass: 'clave-larga-2', hiddenEnabled: false, tier: 'pro' });
const indicesPro = payloadToColorIndices(rsEncodePayloadToRaw(builtPro.payload, gridPro, builtPro.parity));
const faceCellsPro = f => faceSliceFromColorIndices(indicesPro, gridPro, f);

// Caracterización informativa de glareFrac vs. intensidad de reflejo.
console.log('\n--- glareFrac por intensidad de reflejo (cara 0) ---');
for (const g of [0, 60, 120, 200]){
  const cap = captureFace(faceCells(0), grid, 0, { scale: 0.97, glare: g, glareR: 0.2 });
  const q = cap.ok ? faceScanQuality(cap.canon) : { glareFrac: NaN, ok: false };
  console.log(`glare=${g}: glareFrac=${(q.glareFrac * 100).toFixed(2)}%  ok=${q.ok}`);
}

test('compuerta: cara LIMPIA pasa (mini)', () => {
  for (let f = 0; f < FACE_COUNT; f++){ assert.ok(faceScanQuality(cleanCanon(f)).ok, `cara ${f} limpia rechazada por error`); }
});

test('compuerta: cara LIMPIA Pro (grid 60) NO se rechaza por su grid fino', () => {
  const cap = captureFace(faceCellsPro(0), gridPro, 0, { scale: 0.97 });
  assert.ok(cap.ok, 'cara Pro no capturada');
  assert.ok(faceScanQuality(cap.canon).ok, 'cara Pro limpia rechazada por error (falso positivo por grid fino)');
});

test('compuerta: cara con REFLEJO se rechaza', () => {
  const cap = captureFace(faceCells(0), grid, 0, { scale: 0.97, glare: 200, glareR: 0.2 });
  assert.ok(cap.ok, 'la cara con reflejo debería detectarse (marco intacto)');
  assert.ok(!faceScanQuality(cap.canon).ok, 'la compuerta NO rechazó una cara con reflejo fuerte');
});

test('ruta rápida: decode {phases:[identity]} descifra un cubo limpio', () => {
  const canonByFace = {}; for (let f = 0; f < FACE_COUNT; f++) canonByFace[f] = cleanCanon(f);
  const { payload } = decodeCanonicalFaces(canonByFace, TIERS, { phases: ['identity'] });
  assert.equal(Buffer.from(payload).toString('hex'), Buffer.from(built.payload).toString('hex'), 'la ruta rápida no recuperó el payload');
});

test('fallback intacto: caras mal etiquetadas siguen descifrando (con permute)', () => {
  const tiles = []; for (let f = 0; f < FACE_COUNT; f++) tiles.push(cleanCanon(f));
  const canonByFace = { 0: tiles[0], 4: tiles[1], 5: tiles[2], 3: tiles[3], 1: tiles[4], 2: tiles[5] };
  const { payload } = decodeCanonicalFaces(canonByFace, TIERS);
  assert.equal(Buffer.from(payload).toString('hex'), Buffer.from(built.payload).toString('hex'), 'el fallback por permutación dejó de funcionar');
});

test('bucle guiado: 1 cara con reflejo → falla y diagnose la culpa → recapturada → OK', () => {
  const bad = 2;
  const canonByFace = {};
  for (let f = 0; f < FACE_COUNT; f++) canonByFace[f] = cleanCanon(f);
  // Reemplaza la cara `bad` por una versión con reflejo fuerte (marco intacto → se
  // detecta y warpea, pero sus celdas de datos quedan reventadas).
  const capBad = captureFace(faceCells(bad), grid, bad, { scale: 0.97, glare: 220, glareR: 0.22 });
  assert.ok(capBad.ok, 'la cara dañada debería detectarse');
  canonByFace[bad] = capBad.canon;

  // La reconstrucción rápida (sin frase) debe FALLAR con esa cara dañada.
  assert.throws(() => decodeCanonicalFaces(canonByFace, TIERS, { phases: ['identity'] }),
    /No se pudo reconstruir/, 'debería fallar la reconstrucción con una cara reventada');

  // diagnose debe señalar precisamente esa cara como la peor.
  const rep = diagnoseCanonicalFaces(canonByFace, TIERS);
  assert.ok(rep, 'sin reporte de diagnóstico');
  let worst = -1, worstN = -1;
  for (let f = 0; f < FACE_COUNT; f++){ if (rep.perFaceFailed[f] > worstN){ worstN = rep.perFaceFailed[f]; worst = f; } }
  assert.equal(worst, bad, `diagnose culpó a la cara ${worst + 1}, no a la dañada ${bad + 1}`);

  // Recaptura limpia de esa cara → reconstrucción OK (cierre del bucle).
  canonByFace[bad] = cleanCanon(bad);
  const { payload } = decodeCanonicalFaces(canonByFace, TIERS, { phases: ['identity'] });
  assert.equal(Buffer.from(payload).toString('hex'), Buffer.from(built.payload).toString('hex'), 'tras recapturar la cara, no descifró');
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
if (failed > 0) process.exitCode = 1;
