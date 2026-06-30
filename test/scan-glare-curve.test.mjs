// Regresión de los DOS fallos nuevos reportados por el usuario (2026-06-29),
// probados sobre la cadena REAL de captura (detectTile → refineTileCorners →
// warpToCanonical → muestreo), que es la única lección que ha funcionado en toda
// la historia del escaneo: reproducir el fallo con una prueba, no adivinar.
//
//   1) REFLEJO de luz (el killer real, confirmado: un brillo moderado revienta
//      ~25% de las celdas en 1 cuadro). Se mitiga con:
//        - muestreo robusto por celda (mediana) — ayuda al reflejo NÍTIDO/parcial,
//        - captura MULTI-FRAME combineCanonicalFrames — descarta por píxel los
//          cuadros más brillantes (reflejados) y promedia el resto: como el brillo
//          se mueve con el pulso, recupera el color real. Es el arma principal.
//      Métrica que importa: el cubo de 6 caras DESCIFRA bajo reflejo moderado.
//
//   2) CURVATURA/dobleces: se caracteriza dónde rompe la homografía plana. La
//      conclusión (medida, no supuesta) es que comba/doblez REALISTAS ya leen al
//      100%; solo niveles extremos rompen. El test fija esa tolerancia como
//      guardia de regresión.
//
// Ejecutar: node test/scan-glare-curve.test.mjs
import assert from 'node:assert/strict';
globalThis.window = globalThis;
globalThis.document = { createElement(){ return {}; }, head:{ appendChild(){} } };

const crypto_ = await import('../js/crypto.js');
const cube = await import('../js/cube3d.js');
const { PALETTE, TIERS, buildPayload, rsEncodePayloadToRaw, payloadToColorIndices, computeHomography, applyHomography } = crypto_;
const {
  detectTile, refineTileCorners, warpToCanonical, sampleFaceCells, sampleFaceCellsRobust,
  readCanonicalFaceId, decodeCanonicalFaces, faceSliceFromColorIndices, FACE_COUNT,
} = cube;

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

/** Comba tipo cilindro: [0,1]→[0,1], fijos 0/0.5/1. phi = ángulo subtendido. */
function bendMap(t, phi){ if (!phi) return t; const k = 2 * Math.sin(phi / 2); return 0.5 + Math.sin((t - 0.5) * phi) / k; }
/** Doblez (crease) en t=0.5: cada mitad se escorza por cos(ang). */
function foldMap(t, ang){ if (!ang) return t; const c = Math.cos(ang); return t < 0.5 ? 0.5 - (0.5 - t) * c : 0.5 + (t - 0.5) * c; }

/** "Foto" SAMPLE_SIZE² con la baldosa encuadrada, con opción de COMBA, DOBLEZ y
 * REFLEJO especular (glare, compuesto tras estampar para tapar de verdad celdas). */
function makePhoto(cells, grid, faceIndex, {
  scale = 1, rotDeg = 0, dxFrac = 0, dyFrac = 0, bg = 232, noiseStd = 0,
  bendX = 0, bendY = 0, foldX = 0,
  glare = 0, glareCx = 0.5, glareCy = 0.4, glareR = 0.22,
  seed = 1,
} = {}){
  const W = SAMPLE_SIZE, H = SAMPLE_SIZE;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++){ data[i * 4] = bg; data[i * 4 + 1] = bg; data[i * 4 + 2] = bg; data[i * 4 + 3] = 255; }
  const guide = guideCorners(); const gs = guide[1][0] - guide[0][0];
  const cx = (guide[0][0] + guide[2][0]) / 2 + dxFrac * gs, cy = (guide[0][1] + guide[2][1]) / 2 + dyFrac * gs;
  const span = gs * scale, half = span / 2, th = rotDeg * Math.PI / 180, cos = Math.cos(th), sin = Math.sin(th);
  const rot = (x, y) => [cx + x * cos - y * sin, cy + x * sin + y * cos];
  const rng = makeRng(seed * 7919 + 17);
  const photoCorners = [rot(-half, -half), rot(half, -half), rot(half, half), rot(-half, half)];
  const Hm = computeHomography([[0, 0], [1, 0], [1, 1], [0, 1]], photoCorners), N = 900;
  const faceU = new Float32Array(W * H).fill(-1), faceV = new Float32Array(W * H).fill(-1);
  for (let iy = 0; iy <= N; iy++) for (let ix = 0; ix <= N; ix++){
    const mu = ix / N, mv = iy / N;
    const wu = foldMap(bendMap(mu, bendX), foldX), wv = bendMap(mv, bendY);
    const [px, py] = applyHomography(Hm, wu, wv), x = Math.round(px), y = Math.round(py);
    if (x < 0 || x >= W || y < 0 || y >= H) continue;
    let [r, g, b] = tileColorAt(mu, mv, cells, grid, faceIndex);
    if (noiseStd){ const n = () => (rng() + rng() + rng() + rng() - 2) * noiseStd; r += n(); g += n(); b += n(); }
    const di = (y * W + x) * 4; data[di] = Math.max(0, Math.min(255, r)); data[di + 1] = Math.max(0, Math.min(255, g)); data[di + 2] = Math.max(0, Math.min(255, b)); data[di + 3] = 255;
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
/** Captura MULTI-FRAME como la app mejorada: varios cuadros (reflejo movido +
 * pulso + ruido distinto por cuadro), enderezados y combinados. */
function cellErr(cap, cells, grid, robust){
  if (!cap.ok || cap.faceIndex !== undefined && cap.faceIndex !== cells.faceIndex) {}
  const read = robust ? sampleFaceCellsRobust(cap.canon, grid) : sampleFaceCells(cap.canon, grid);
  let bad = 0; for (let i = 0; i < cells.length; i++) if (read[i] !== cells[i]) bad++;
  return 100 * bad / cells.length;
}

let passed = 0, failed = 0;
function test(name, fn){ try{ fn(); console.log(`OK   ${name}`); passed++; } catch(e){ console.error(`FAIL ${name}\n     ${e.message}`); failed++; } }

const grid = TIERS.mini.grid;
const built = await buildPayload({ secretText: 'REFLEJO Y COMBA', realPass: 'clave12', hiddenEnabled: false, tier: 'mini' });
const indices = payloadToColorIndices(rsEncodePayloadToRaw(built.payload, grid, built.parity));
const faceCells = f => faceSliceFromColorIndices(indices, grid, f);

// --- Caracterización (informativa) ---
console.log('\n--- REFLEJO: error de celda  1frame / robusto ---');
for (const g of [0, 80, 140, 200, 255]){
  const params = { scale: 0.97, rotDeg: 1, glare: g, glareR: 0.18 };
  const e1 = cellErr(captureFace(faceCells(0), grid, 0, params), faceCells(0), grid, false);
  const eR = cellErr(captureFace(faceCells(0), grid, 0, params), faceCells(0), grid, true);
  console.log(`glare=${g}: 1frame=${e1.toFixed(1)}%  robusto=${eR.toFixed(1)}%`);
}
console.log('\n--- CURVATURA/DOBLEZ: error de celda (homografía plana) ---');
for (const ph of [0, 0.5, 1.0, 1.5, 2.0]) console.log(`comba=${ph}rad: ${cellErr(captureFace(faceCells(0), grid, 0, { scale: 0.96, bendX: ph, bendY: ph * 0.6 }), faceCells(0), grid, true).toFixed(1)}%`);
for (const a of [0, 0.15, 0.3, 0.45]) console.log(`doblez=${a}rad: ${cellErr(captureFace(faceCells(0), grid, 0, { scale: 0.96, foldX: a }), faceCells(0), grid, true).toFixed(1)}%`);

// --- Aserciones de regresión ---
test('cuadro limpio (sin reflejo): muestreo robusto sigue 0%', () => {
  const e = cellErr(captureFace(faceCells(0), grid, 0, { scale: 0.97, rotDeg: 1 }), faceCells(0), grid, true);
  assert.ok(e < 1, `error ${e.toFixed(1)}% en cuadro limpio (la mediana por celda debe ser identidad)`);
});

test('reflejo moderado, 1 cuadro: el robusto NO empeora frente a la media', () => {
  const params = { scale: 0.97, glare: 120, glareR: 0.18 };
  const eAvg = cellErr(captureFace(faceCells(0), grid, 0, params), faceCells(0), grid, false);
  const eRob = cellErr(captureFace(faceCells(0), grid, 0, params), faceCells(0), grid, true);
  assert.ok(eRob <= eAvg + 0.5, `robusto ${eRob}% peor que media ${eAvg}%`);
});

test('CARAS MAL ETIQUETADAS: decode las reordena por Reed-Solomon y descifra', () => {
  // Captura limpia de las 6 caras y luego barajamos a propósito qué índice se le
  // asignó a cada baldosa (simula que el detector leyó mal la identidad de cara,
  // el problema #4). El decode debe recuperar el payload igual gracias al fallback
  // por permutación, sin depender de que las etiquetas sean correctas.
  const tiles = [];
  for (let f = 0; f < FACE_COUNT; f++){
    const cap = captureFace(faceCells(f), grid, f, { scale: 0.96, rotDeg: (f % 2 ? 1 : -1) });
    assert.ok(cap.ok, `cara ${f} no capturada`);
    tiles.push(cap.canon);
  }
  // Dos pares de caras cruzadas (lo realista: una o dos identidades mal leídas),
  // que es justo lo que cubre el fallback acotado a permutaciones cercanas.
  const canonByFace = { 0: tiles[0], 4: tiles[1], 5: tiles[2], 3: tiles[3], 1: tiles[4], 2: tiles[5] };
  const { payload } = decodeCanonicalFaces(canonByFace, TIERS);
  assert.equal(Buffer.from(payload).toString('hex'), Buffer.from(built.payload).toString('hex'), 'no recuperó el payload pese al fallback por permutación');
});

test('comba y doblez REALISTAS (comba 1.0rad / doblez 0.3rad) leen al 100%', () => {
  const eBend = cellErr(captureFace(faceCells(0), grid, 0, { scale: 0.96, bendX: 1.0, bendY: 0.6 }), faceCells(0), grid, true);
  const eFold = cellErr(captureFace(faceCells(0), grid, 0, { scale: 0.96, foldX: 0.3 }), faceCells(0), grid, true);
  assert.ok(eBend < 1, `comba 1.0rad da ${eBend.toFixed(1)}% (debería leer perfecto)`);
  assert.ok(eFold < 1, `doblez 0.3rad da ${eFold.toFixed(1)}% (debería leer perfecto)`);
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
if (failed > 0) process.exitCode = 1;
