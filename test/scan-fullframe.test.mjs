// Regresión del CUBO FÍSICO (reportado 2026-06-30): en el cubo la cara impresa va
// pegada al borde y se llena el cuadro SIN dejar margen, así que la baldosa DESBORDA
// el recuadro guía. Antes detectTile solo probaba escalas ≤ guía (la cara entra más
// chica, como en papel con margen blanco), así que una cara que llenaba/desbordaba
// el cuadro NO se detectaba ("ni siquiera detecta la cara"). Con los factores de
// AGRANDADO (>1) en DETECT_SHRINKS ahora sí. Este test bloquea esa regresión:
// detección + enderezado + lectura a 0% para baldosas de hasta 1.2× la guía, con
// giro/desplazamiento y sobre fondo OSCURO (el cubo no tiene papel blanco afuera).
//
// Ejecutar: node test/scan-fullframe.test.mjs
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
/** `scale` = tamaño de la cara respecto a la guía; >1 = DESBORDA (cubo físico).
 * `bg` oscuro simula el cubo (sin papel blanco afuera, hay borde/sombra del cubo). */
function makePhoto(cells, grid, faceIndex, { scale = 1, rotDeg = 0, dxFrac = 0, dyFrac = 0, bg = 90 } = {}){
  const W = SAMPLE_SIZE, H = SAMPLE_SIZE;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++){ data[i * 4] = bg; data[i * 4 + 1] = bg; data[i * 4 + 2] = bg; data[i * 4 + 3] = 255; }
  const guide = guideCorners(), gs = guide[1][0] - guide[0][0];
  const cx = (guide[0][0] + guide[2][0]) / 2 + dxFrac * gs, cy = (guide[0][1] + guide[2][1]) / 2 + dyFrac * gs;
  const span = gs * scale, half = span / 2, th = rotDeg * Math.PI / 180, cos = Math.cos(th), sin = Math.sin(th);
  const rot = (x, y) => [cx + x * cos - y * sin, cy + x * sin + y * cos];
  const photoCorners = [rot(-half, -half), rot(half, -half), rot(half, half), rot(-half, half)];
  const Hm = computeHomography([[0, 0], [1, 0], [1, 1], [0, 1]], photoCorners), N = 1000;
  for (let iy = 0; iy <= N; iy++) for (let ix = 0; ix <= N; ix++){
    const nx = ix / N, ny = iy / N, [px, py] = applyHomography(Hm, nx, ny), x = Math.round(px), y = Math.round(py);
    if (x < 0 || x >= W || y < 0 || y >= H) continue;
    const [r, g, b] = tileColorAt(nx, ny, cells, grid, faceIndex);
    const di = (y * W + x) * 4; data[di] = r; data[di + 1] = g; data[di + 2] = b; data[di + 3] = 255;
  }
  return data;
}
function pipeline(cells, grid, faceIndex, params){
  const guide = guideCorners();
  const data = makePhoto(cells, grid, faceIndex, params);
  const det = detectTile(data, SAMPLE_SIZE, SAMPLE_SIZE, guide);
  if (!det.ok) return { detected: false, errPct: 100 };
  const refined = refineTileCorners(data, SAMPLE_SIZE, SAMPLE_SIZE, guide, det.rotation);
  const canon = warpToCanonical(data, SAMPLE_SIZE, SAMPLE_SIZE, refined, det.rotation);
  const read = sampleFaceCells(canon, grid);
  let bad = 0; for (let i = 0; i < cells.length; i++) if (read[i] !== cells[i]) bad++;
  return { detected: true, errPct: +(100 * bad / cells.length).toFixed(1), canon, faceIndex: (readCanonicalFaceId(canon).faceIndex ?? det.faceIndex) };
}

let passed = 0, failed = 0;
function test(name, fn){ try{ fn(); console.log(`OK   ${name}`); passed++; } catch(e){ console.error(`FAIL ${name}\n     ${e.message}`); failed++; } }

const grid = TIERS.mini.grid;
const built = await buildPayload({ secretText: 'CUBO FISICO', realPass: 'clave12', hiddenEnabled: false, tier: 'mini' });
const indices = payloadToColorIndices(rsEncodePayloadToRaw(built.payload, grid, built.parity));
const faceCells = f => faceSliceFromColorIndices(indices, grid, f);

console.log('\n--- Cara que DESBORDA la guía (cubo físico), fondo oscuro ---');
for (const sc of [1.0, 1.05, 1.1, 1.15, 1.2]){
  const r = pipeline(faceCells(0), grid, 0, { scale: sc, bg: 90 });
  console.log(`scale=${sc}: detecta=${r.detected} err=${r.detected ? r.errPct + '%' : 'n/d'}`);
}

test('cara llenando el cuadro (scale 1.1) se detecta y lee a 0%', () => {
  const r = pipeline(faceCells(0), grid, 0, { scale: 1.1, bg: 90 });
  assert.ok(r.detected, 'no detectó una cara que llena el cuadro (regresión del cubo físico)');
  assert.ok(r.errPct < 2, `error ${r.errPct}% en cara que llena el cuadro`);
});

test('cara desbordando 1.15 + giro + corrido sobre fondo oscuro: detecta y lee bien', () => {
  const r = pipeline(faceCells(0), grid, 0, { scale: 1.15, rotDeg: 2, dxFrac: 0.02, bg: 70 });
  assert.ok(r.detected, 'no detectó');
  assert.ok(r.errPct < 3, `error ${r.errPct}%`);
});

test('CUBO COMPLETO con las 6 caras DESBORDANDO la guía: DESCIFRA', () => {
  const canonByFace = {};
  for (let f = 0; f < FACE_COUNT; f++){
    const r = pipeline(faceCells(f), grid, f, { scale: 1.08 + 0.03 * (f % 3), rotDeg: (f % 2 ? 1.5 : -1.5), bg: 80 });
    assert.ok(r.detected, `cara ${f} no detectada (desbordando)`);
    assert.equal(r.faceIndex, f, `cara ${f} leída como ${r.faceIndex}`);
    canonByFace[r.faceIndex] = r.canon;
  }
  const { payload } = decodeCanonicalFaces(canonByFace, TIERS);
  assert.equal(Buffer.from(payload).toString('hex'), Buffer.from(built.payload).toString('hex'), 'no descifró el cubo que desborda la guía');
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
if (failed > 0) process.exitCode = 1;
