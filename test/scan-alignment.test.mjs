// Prueba de extremo a extremo de la GEOMETRÍA real de escaneo (lo que NINGUNA
// prueba anterior cubría): simula una "foto" donde la cara del cubo NO llena
// exactamente el recuadro guía —como pasa siempre a mano— con un poco de
// escala, rotación y desplazamiento, y la hace pasar por el pipeline REAL:
// detectTile → refineTileCorners → warpToCanonical → sampleFaceCells. Mide el
// error de celda resultante para encontrar el punto real de quiebre, en vez de
// asumirlo. Sin esto, scan-roundtrip/scan-decode solo prueban baldosas ya
// perfectamente encuadradas y no detectan el bug real reportado por cámara.
//
// Ejecutar: node test/scan-alignment.test.mjs
import assert from 'node:assert/strict';

globalThis.window = globalThis;
globalThis.document = { createElement(){ return {}; }, head:{ appendChild(){} } };

const crypto_ = await import('../js/crypto.js');
const cube = await import('../js/cube3d.js');
const {
  PALETTE, TIERS, buildPayload, rsEncodePayloadToRaw, payloadToColorIndices,
  computeHomography, applyHomography,
} = crypto_;
const { detectTile, refineTileCorners, warpToCanonical, sampleFaceCells, faceSliceFromColorIndices, FACE_COUNT } = cube;

// --- Geometría de baldosa (idéntica a drawFaceTileV2; no exportada) ---
const F = 0.07, B = 0.10, G = 0.03, DI = F + B + G, FINDER = 0.075;
const FINDER_CENTERS = [[F + B / 2, F + B / 2], [1 - F - B / 2, F + B / 2], [1 - F - B / 2, 1 - F - B / 2], [F + B / 2, 1 - F - B / 2]];
const CANONICAL_DARK = [true, true, false, true];
const ID_BIT_X = [0.42, 0.50, 0.58], ID_BIT_Y = F + B / 2;
const BLACK = [10, 10, 10], WHITE = [255, 255, 255];
const hexToRgb = h => { const v = h.replace('#', ''); return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)]; };

/** Color de la baldosa en el punto normalizado (nx,ny) de [0,1]^2. Réplica
 * pura (sin canvas) de drawFaceTileV2, para poder "estampar" la baldosa a
 * cualquier resolución/posición dentro de una foto sintética. */
function tileColorAt(nx, ny, cells, grid, faceIndex){
  if (nx < F || nx > 1 - F || ny < F || ny > 1 - F) return BLACK;
  for (let i = 0; i < 4; i++){
    if (!CANONICAL_DARK[i]) continue;
    const [cx, cy] = FINDER_CENTERS[i];
    if (Math.abs(nx - cx) < FINDER / 2 && Math.abs(ny - cy) < FINDER / 2) return BLACK;
  }
  for (let b = 0; b < 3; b++){
    const bit = (faceIndex >> (2 - b)) & 1;
    if (!bit) continue;
    const s = FINDER * 0.7 / 2;
    if (Math.abs(nx - ID_BIT_X[b]) < s && Math.abs(ny - ID_BIT_Y) < s) return BLACK;
  }
  if (nx >= DI && nx <= 1 - DI && ny >= DI && ny <= 1 - DI){
    const span = 1 - 2 * DI, cellN = span / grid;
    const c = Math.min(grid - 1, Math.floor((nx - DI) / cellN));
    const r = Math.min(grid - 1, Math.floor((ny - DI) / cellN));
    return hexToRgb(PALETTE[cells[r * grid + c]]);
  }
  return WHITE;
}

const SAMPLE_SIZE = 720, GUIDE_INSET = 0.09;
function guideCorners(){
  const m = Math.round(SAMPLE_SIZE * GUIDE_INSET), e = SAMPLE_SIZE - m;
  return [[m, m], [e, m], [e, e], [m, e]];
}

/** Construye una "foto" SAMPLE_SIZE×SAMPLE_SIZE donde la baldosa real ocupa una
 * región más chica/rotada/corrida que el recuadro guía (lo normal a mano:
 * `scale`=fracción del lado de la guía que ocupa el cubo real, `rotDeg`=giro
 * residual en grados, `dxFrac`/`dyFrac`=desplazamiento del centro como fracción
 * del lado de la guía). Estampa la baldosa por mapeo directo (forward) vía
 * homografía real (computeHomography/applyHomography), con suficiente densidad
 * de muestreo para no dejar huecos. */
/** PRNG determinista (sin dependencias) para ruido reproducible. */
function makeRng(seed){ let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

function makePhoto(cells, grid, faceIndex, {
  scale = 1, rotDeg = 0, dxFrac = 0, dyFrac = 0,
  cornerJitterFrac = 0,     // jitter INDEPENDIENTE por esquina (perspectiva real, no solo similitud)
  lightGradient = 0,        // 0..1: cuánto más oscuro queda el lado derecho/inferior vs izq/superior
  topBottomBias = 0,        // 0..1: cuánto más oscuro queda ARRIBA vs ABAJO (asimetría vertical, no diagonal)
  noiseStd = 0,             // ruido gaussiano-ish por canal (simula sensor de cámara)
  blurPx = 0,               // radio de desenfoque por caja (simula foto fuera de foco)
  seed = 1,
} = {}){
  const W = SAMPLE_SIZE, H = SAMPLE_SIZE;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++){ data[i * 4] = 232; data[i * 4 + 1] = 232; data[i * 4 + 2] = 232; data[i * 4 + 3] = 255; }
  const guide = guideCorners();
  const guideSpan = guide[1][0] - guide[0][0];
  const cx = (guide[0][0] + guide[2][0]) / 2 + dxFrac * guideSpan;
  const cy = (guide[0][1] + guide[2][1]) / 2 + dyFrac * guideSpan;
  const span = guideSpan * scale, half = span / 2;
  const th = rotDeg * Math.PI / 180, cos = Math.cos(th), sin = Math.sin(th);
  const rot = (x, y) => [cx + x * cos - y * sin, cy + x * sin + y * cos];
  const rng = makeRng(seed * 7919 + 17);
  const jitter = () => (rng() - 0.5) * 2 * cornerJitterFrac * guideSpan;
  const photoCorners = [rot(-half, -half), rot(half, -half), rot(half, half), rot(-half, half)]
    .map(([x, y]) => [x + jitter(), y + jitter()]);
  const Hm = computeHomography([[0, 0], [1, 0], [1, 1], [0, 1]], photoCorners);
  const N = 760; // densidad de estampado: > resolución destino, sin huecos
  for (let iy = 0; iy <= N; iy++){
    const ny = iy / N;
    for (let ix = 0; ix <= N; ix++){
      const nx = ix / N;
      const [px, py] = applyHomography(Hm, nx, ny);
      const x = Math.round(px), y = Math.round(py);
      if (x < 0 || x >= W || y < 0 || y >= H) continue;
      let [r, g, b] = tileColorAt(nx, ny, cells, grid, faceIndex);
      if (lightGradient){
        const f = 1 - lightGradient * ((nx + ny) / 2); // oscurece hacia abajo-derecha
        r *= f; g *= f; b *= f;
      }
      if (topBottomBias){
        const f = 1 - topBottomBias * ny; // oscurece hacia abajo (sombra de la mano/teléfono)
        r *= f; g *= f; b *= f;
      }
      if (noiseStd){
        const n = () => (rng() + rng() + rng() + rng() - 2) * noiseStd; // ~gaussiana
        r += n(); g += n(); b += n();
      }
      const di = (y * W + x) * 4;
      data[di] = Math.max(0, Math.min(255, r)); data[di + 1] = Math.max(0, Math.min(255, g)); data[di + 2] = Math.max(0, Math.min(255, b)); data[di + 3] = 255;
    }
  }
  return blurPx ? boxBlur(data, W, H, blurPx) : data;
}

/** Desenfoque por caja (separable) — simula una foto a mano fuera de foco, lo
 * más distinto de mis renders sintéticos de bordes perfectamente nítidos. Un
 * borde difuso rompe un detector de borde por UMBRAL DURO de forma muy distinta
 * a ruido de alta frecuencia. */
function boxBlur(data, w, h, radius){
  if (!radius) return data;
  const out = new Uint8ClampedArray(data.length);
  const tmp = new Float32Array(data.length);
  const norm = 2 * radius + 1;
  for (let y = 0; y < h; y++){
    for (let x = 0; x < w; x++){
      let r = 0, g = 0, b = 0;
      for (let dx = -radius; dx <= radius; dx++){
        const xx = Math.max(0, Math.min(w - 1, x + dx));
        const i = (y * w + xx) * 4;
        r += data[i]; g += data[i + 1]; b += data[i + 2];
      }
      const o = (y * w + x) * 4;
      tmp[o] = r / norm; tmp[o + 1] = g / norm; tmp[o + 2] = b / norm;
    }
  }
  for (let x = 0; x < w; x++){
    for (let y = 0; y < h; y++){
      let r = 0, g = 0, b = 0;
      for (let dy = -radius; dy <= radius; dy++){
        const yy = Math.max(0, Math.min(h - 1, y + dy));
        const o = (yy * w + x) * 4;
        r += tmp[o]; g += tmp[o + 1]; b += tmp[o + 2];
      }
      const di = (y * w + x) * 4;
      out[di] = r / norm; out[di + 1] = g / norm; out[di + 2] = b / norm; out[di + 3] = 255;
    }
  }
  return out;
}

/** Corre el pipeline REAL de captura sobre una foto sintética y devuelve el
 * % de celdas de datos mal leídas frente a `cells` (verdad de terreno). */
function runPipeline(data, cells, grid, faceIndex){
  const guide = guideCorners();
  const det = detectTile(data, SAMPLE_SIZE, SAMPLE_SIZE, guide);
  if (!det.ok) return { detected: false, errPct: 100 };
  if (det.faceIndex !== faceIndex) return { detected: true, wrongFace: true, errPct: 100 };
  const refined = refineTileCorners(data, SAMPLE_SIZE, SAMPLE_SIZE, guide, det.rotation);
  const moved = Math.hypot(refined[0][0] - guide[0][0], refined[0][1] - guide[0][1]) > 0.5;
  const canon = warpToCanonical(data, SAMPLE_SIZE, SAMPLE_SIZE, refined, det.rotation);
  const read = sampleFaceCells(canon, grid);
  let bad = 0;
  for (let i = 0; i < cells.length; i++) if (read[i] !== cells[i]) bad++;
  // También mide qué pasaría SIN afinado (solo guía) para aislar el aporte de refineTileCorners.
  const canonNoRefine = warpToCanonical(data, SAMPLE_SIZE, SAMPLE_SIZE, guide, det.rotation);
  const readNoRefine = sampleFaceCells(canonNoRefine, grid);
  let badNoRefine = 0;
  for (let i = 0; i < cells.length; i++) if (readNoRefine[i] !== cells[i]) badNoRefine++;
  return { detected: true, refined: moved, errPct: +(100 * bad / cells.length).toFixed(1), errPctNoRefine: +(100 * badNoRefine / cells.length).toFixed(1) };
}

let passed = 0, failed = 0;
async function test(name, fn){ try{ await fn(); console.log(`OK   ${name}`); passed++; } catch(e){ console.error(`FAIL ${name}\n     ${e.stack || e.message}`); failed++; } }

const grid = TIERS.mini.grid;
const built = await buildPayload({ secretText: 'x', realPass: 'y', hiddenEnabled: false, tier: 'mini' });
const raw = rsEncodePayloadToRaw(built.payload, grid, built.parity);
const indices = payloadToColorIndices(raw);
const faceIndex = 0;
const cells = faceSliceFromColorIndices(indices, grid, faceIndex);

const scenarios = [
  ['cubo llena la guía exacto', { scale: 1, rotDeg: 0 }],
  ['99% escala', { scale: 0.99 }],
  ['97% escala', { scale: 0.97 }],
  ['95% escala', { scale: 0.95 }],
  ['93% escala', { scale: 0.93 }],
  ['91% escala', { scale: 0.91 }],
  ['90% escala', { scale: 0.90 }],
  ['100% + giro 1°', { scale: 1, rotDeg: 1 }],
  ['100% + giro 2°', { scale: 1, rotDeg: 2 }],
  ['100% + giro 3°', { scale: 1, rotDeg: 3 }],
  ['97% + giro 1°', { scale: 0.97, rotDeg: 1 }],
  ['97% + giro 2°', { scale: 0.97, rotDeg: 2 }],
  ['95% + giro 1°', { scale: 0.95, rotDeg: 1 }],
  ['90% + giro 3°', { scale: 0.90, rotDeg: 3 }],
  ['85% + giro 5° + corrido', { scale: 0.85, rotDeg: 5, dxFrac: 0.04, dyFrac: -0.03 }],
  ['80% + giro 6°', { scale: 0.80, rotDeg: 6 }],
  ['70% (mano muy floja)', { scale: 0.70 }],
  ['100% + luz despareja fuerte', { scale: 1, lightGradient: 0.5 }],
  ['98% + luz despareja fuerte', { scale: 0.98, lightGradient: 0.5 }],
  ['98% + ruido de sensor', { scale: 0.98, noiseStd: 18 }],
  ['98% + jitter de esquina (perspectiva real) 1.5%', { scale: 0.98, cornerJitterFrac: 0.015 }],
  ['98% + jitter de esquina 3%', { scale: 0.98, cornerJitterFrac: 0.03 }],
  ['98% + jitter 1.5% + luz despareja + ruido (foto real típica)', { scale: 0.98, cornerJitterFrac: 0.015, lightGradient: 0.4, noiseStd: 12 }],
  ['98% + desenfoque leve (1px)', { scale: 0.98, blurPx: 1 }],
  ['98% + desenfoque medio (2px)', { scale: 0.98, blurPx: 2 }],
  ['98% + desenfoque fuerte (3px)', { scale: 0.98, blurPx: 3 }],
  ['98% + desenfoque 2px + sombra arriba (mano/teléfono)', { scale: 0.98, blurPx: 2, topBottomBias: 0.5 }],
  ['97% + giro 1° + desenfoque 2px + sombra (foto real típica)', { scale: 0.97, rotDeg: 1, blurPx: 2, topBottomBias: 0.5, noiseStd: 8 }],
  ['96% + giro 1.5° + desenfoque 3px + sombra fuerte', { scale: 0.96, rotDeg: 1.5, blurPx: 3, topBottomBias: 0.65, noiseStd: 10 }],
];

console.log('\n--- Barrido de error de celda por escenario de encuadre (mini, grid 24) ---');
for (const [label, params] of scenarios){
  const data = makePhoto(cells, grid, faceIndex, params);
  const r = runPipeline(data, cells, grid, faceIndex);
  console.log(`${label}: ${JSON.stringify(r)}`);
}

await test('cubo llenando la guía exacto: 0% de error', async () => {
  const data = makePhoto(cells, grid, faceIndex, { scale: 1, rotDeg: 0 });
  const r = runPipeline(data, cells, grid, faceIndex);
  assert.equal(r.detected, true);
  assert.ok(r.errPct < 1, `error ${r.errPct}% inesperado con encuadre perfecto`);
});

await test('cubo al 90% de la guía + 3° de giro: error tolerable (<5%)', async () => {
  const data = makePhoto(cells, grid, faceIndex, { scale: 0.90, rotDeg: 3 });
  const r = runPipeline(data, cells, grid, faceIndex);
  assert.ok(r.detected, 'no se detectó la cara');
  assert.ok(r.errPct < 5, `error ${r.errPct}% — demasiado alto para un encuadre realista`);
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
if (failed > 0) process.exitCode = 1;
