// Regresión del FALLO REAL de escaneo con cámara (diagnosticado 2026-06-29):
// refineTileCorners localizaba el marco buscando "la primera racha oscura desde
// fuera", lo que asumía un FONDO CLARO (papel). Al escanear desde una PANTALLA (o
// sobre mesa/sombra oscura), el fondo oscuro se fundía con el marco negro, la
// baldosa se inflaba a ~1.22× su tamaño real y la rejilla de datos quedaba
// descuadrada → TODOS los bloques Reed-Solomon ilegibles ("N de N").
//
// Por qué ningún test lo cazó antes: TODAS las "fotos" sintéticas (scan-alignment,
// etc.) pintaban un fondo gris CLARO (232) alrededor de la baldosa, así que la
// etapa rota nunca se ejercitaba. Este test pasa la cadena REAL de captura sobre
// fondo OSCURO (como una pantalla) y exige que el cubo se DESCIFRE de verdad.
//
// Ejecutar: node test/scan-darkbg.test.mjs
import assert from 'node:assert/strict';
globalThis.window = globalThis;
globalThis.document = { createElement(){ return {}; }, head:{ appendChild(){} } };

const crypto_ = await import('../js/crypto.js');
const cube = await import('../js/cube3d.js');
const { PALETTE, TIERS, buildPayload, rsEncodePayloadToRaw, payloadToColorIndices, computeHomography, applyHomography } = crypto_;
const { detectTile, refineTileCorners, warpToCanonical, sampleFaceCells, readCanonicalFaceId, decodeCanonicalFaces, faceSliceFromColorIndices, FACE_COUNT } = cube;

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

/** "Foto" SAMPLE_SIZE² con la baldosa encuadrada (escala/giro/corrimiento) sobre
 * un fondo de brillo `bg` (clave de este test: bg bajo = pantalla/oscuro). */
function makePhoto(cells, grid, faceIndex, { scale = 1, rotDeg = 0, dxFrac = 0, dyFrac = 0, bg = 232, noiseStd = 0, seed = 1 } = {}){
  const W = SAMPLE_SIZE, H = SAMPLE_SIZE;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++){ data[i * 4] = bg; data[i * 4 + 1] = bg; data[i * 4 + 2] = bg; data[i * 4 + 3] = 255; }
  const guide = guideCorners(); const gs = guide[1][0] - guide[0][0];
  const cx = (guide[0][0] + guide[2][0]) / 2 + dxFrac * gs, cy = (guide[0][1] + guide[2][1]) / 2 + dyFrac * gs;
  const span = gs * scale, half = span / 2, th = rotDeg * Math.PI / 180, cos = Math.cos(th), sin = Math.sin(th);
  const rot = (x, y) => [cx + x * cos - y * sin, cy + x * sin + y * cos];
  const rng = makeRng(seed * 7919 + 17);
  const photoCorners = [rot(-half, -half), rot(half, -half), rot(half, half), rot(-half, half)];
  const Hm = computeHomography([[0, 0], [1, 0], [1, 1], [0, 1]], photoCorners), N = 760;
  for (let iy = 0; iy <= N; iy++) for (let ix = 0; ix <= N; ix++){
    const nx = ix / N, ny = iy / N, [px, py] = applyHomography(Hm, nx, ny), x = Math.round(px), y = Math.round(py);
    if (x < 0 || x >= W || y < 0 || y >= H) continue;
    let [r, g, b] = tileColorAt(nx, ny, cells, grid, faceIndex);
    if (noiseStd){ const n = () => (rng() + rng() + rng() + rng() - 2) * noiseStd; r += n(); g += n(); b += n(); }
    const di = (y * W + x) * 4; data[di] = Math.max(0, Math.min(255, r)); data[di + 1] = Math.max(0, Math.min(255, g)); data[di + 2] = Math.max(0, Math.min(255, b)); data[di + 3] = 255;
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
  // Igual que la app: la cara se relee de la canónica enderezada (robusto al giro).
  const idInfo = readCanonicalFaceId(canon);
  return { ok: true, faceIndex: idInfo.ok ? idInfo.faceIndex : det.faceIndex, canon };
}
function cellErr(cells, grid, faceIndex, params){
  const cap = captureFace(cells, grid, faceIndex, params);
  if (!cap.ok || cap.faceIndex !== faceIndex) return 100;
  const read = sampleFaceCells(cap.canon, grid);
  let bad = 0; for (let i = 0; i < cells.length; i++) if (read[i] !== cells[i]) bad++;
  return 100 * bad / cells.length;
}

let passed = 0, failed = 0;
function test(name, fn){ try{ fn(); console.log(`OK   ${name}`); passed++; } catch(e){ console.error(`FAIL ${name}\n     ${e.message}`); failed++; } }

const grid = TIERS.mini.grid;
const built = await buildPayload({ secretText: 'PRUEBA123', realPass: 'clave12', hiddenEnabled: false, tier: 'mini' });
const indices = payloadToColorIndices(rsEncodePayloadToRaw(built.payload, grid, built.parity));
const faceCells = f => faceSliceFromColorIndices(indices, grid, f);

// Encuadres realistas a mano (≈ lo que se ve en un escaneo desde pantalla).
const FRAMINGS = [
  { label: 'lleno', scale: 1.0 },
  { label: '95%', scale: 0.95 },
  { label: '92% +giro2', scale: 0.92, rotDeg: 2 },
  { label: '97% +giro1 +ruido', scale: 0.97, rotDeg: 1, noiseStd: 8 },
];

// El núcleo de la regresión: misma geometría, fondo CLARO vs OSCURO.
for (const fr of FRAMINGS){
  test(`fondo OSCURO (pantalla) lee bien — ${fr.label}`, () => {
    const e = cellErr(faceCells(0), grid, 0, { ...fr, bg: 20 });
    assert.ok(e < 2, `error ${e.toFixed(1)}% sobre fondo oscuro (antes del arreglo: ~85%)`);
  });
}
test('fondo CLARO (papel) sigue leyendo bien — control', () => {
  const e = cellErr(faceCells(0), grid, 0, { scale: 0.97, rotDeg: 1, bg: 232 });
  assert.ok(e < 2, `error ${e.toFixed(1)}% sobre fondo claro`);
});

// Extremo a extremo: 6 caras escaneadas desde "pantalla" (fondo oscuro) y
// DESCIFRADAS de verdad por Reed-Solomon. Es la prueba que importa.
test('cubo completo escaneado desde pantalla (fondo oscuro) se DESCIFRA', () => {
  const canonByFace = {};
  for (let f = 0; f < FACE_COUNT; f++){
    // pequeña variación por cara, como al girar el cubo a mano
    const params = { scale: 0.93 + 0.02 * (f % 3), rotDeg: (f % 2 ? 1.5 : -1.5), dxFrac: 0.01 * (f % 2 ? 1 : -1), bg: 18, noiseStd: 6, seed: f + 1 };
    const cap = captureFace(faceCells(f), grid, f, params);
    assert.ok(cap.ok, `cara ${f} no detectada`);
    assert.equal(cap.faceIndex, f, `cara ${f} detectada como ${cap.faceIndex}`);
    canonByFace[cap.faceIndex] = cap.canon;
  }
  const { payload } = decodeCanonicalFaces(canonByFace, TIERS);
  assert.equal(Buffer.from(payload).toString('hex'), Buffer.from(built.payload).toString('hex'), 'el payload descifrado no coincide');
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
if (failed > 0) process.exitCode = 1;
