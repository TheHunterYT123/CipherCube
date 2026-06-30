// ¿La regresión "ya no descifra" la causó el combinado multi-frame?
// Hipótesis: combinar varios cuadros enderezados de forma INDEPENDIENTE emborrona
// la rejilla de datos cuando hay jitter de mano + desenfoque de movimiento, porque
// cada refineTileCorners cae un poco distinto y los bordes de celda no quedan
// registrados entre cuadros. Este test compara, sobre una cara LIMPIA (sin reflejo):
//   - error de 1 solo cuadro (lo que hacía la versión que SÍ funcionaba)
//   - error del combinado de varios cuadros con jitter+desenfoque realistas
// Si el combinado es mucho peor, queda probado el mecanismo de la regresión.
//
// Ejecutar: node test/scan-multiframe-registration.test.mjs
import assert from 'node:assert/strict';
globalThis.window = globalThis;
globalThis.document = { createElement(){ return {}; }, head:{ appendChild(){} } };

const crypto_ = await import('../js/crypto.js');
const cube = await import('../js/cube3d.js');
const { PALETTE, TIERS, buildPayload, rsEncodePayloadToRaw, payloadToColorIndices, computeHomography, applyHomography } = crypto_;
const { detectTile, refineTileCorners, warpToCanonical, sampleFaceCells, combineCanonicalFrames, faceSliceFromColorIndices } = cube;

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
function boxBlur(data, w, h, radius){
  if (!radius) return data;
  const out = new Uint8ClampedArray(data.length), tmp = new Float32Array(data.length), norm = 2 * radius + 1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++){ let r=0,g=0,b=0; for (let dx=-radius; dx<=radius; dx++){ const xx=Math.max(0,Math.min(w-1,x+dx)), i=(y*w+xx)*4; r+=data[i]; g+=data[i+1]; b+=data[i+2]; } const o=(y*w+x)*4; tmp[o]=r/norm; tmp[o+1]=g/norm; tmp[o+2]=b/norm; }
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++){ let r=0,g=0,b=0; for (let dy=-radius; dy<=radius; dy++){ const yy=Math.max(0,Math.min(h-1,y+dy)), o=(yy*w+x)*4; r+=tmp[o]; g+=tmp[o+1]; b+=tmp[o+2]; } const di=(y*w+x)*4; out[di]=r/norm; out[di+1]=g/norm; out[di+2]=b/norm; out[di+3]=255; }
  return out;
}
function makePhoto(cells, grid, faceIndex, { scale=1, rotDeg=0, dxFrac=0, dyFrac=0, bg=232, noiseStd=0, blurPx=0, seed=1 } = {}){
  const W = SAMPLE_SIZE, H = SAMPLE_SIZE;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++){ data[i*4]=bg; data[i*4+1]=bg; data[i*4+2]=bg; data[i*4+3]=255; }
  const guide = guideCorners(), gs = guide[1][0]-guide[0][0];
  const cx = (guide[0][0]+guide[2][0])/2 + dxFrac*gs, cy = (guide[0][1]+guide[2][1])/2 + dyFrac*gs;
  const span = gs*scale, half = span/2, th = rotDeg*Math.PI/180, cos=Math.cos(th), sin=Math.sin(th);
  const rot = (x,y) => [cx + x*cos - y*sin, cy + x*sin + y*cos];
  const rng = makeRng(seed*7919+17);
  const photoCorners = [rot(-half,-half), rot(half,-half), rot(half,half), rot(-half,half)];
  const Hm = computeHomography([[0,0],[1,0],[1,1],[0,1]], photoCorners), N = 900;
  for (let iy=0; iy<=N; iy++) for (let ix=0; ix<=N; ix++){
    const nx=ix/N, ny=iy/N, [px,py]=applyHomography(Hm,nx,ny), x=Math.round(px), y=Math.round(py);
    if (x<0||x>=W||y<0||y>=H) continue;
    let [r,g,b] = tileColorAt(nx,ny,cells,grid,faceIndex);
    if (noiseStd){ const n=()=>(rng()+rng()+rng()+rng()-2)*noiseStd; r+=n(); g+=n(); b+=n(); }
    const di=(y*W+x)*4; data[di]=Math.max(0,Math.min(255,r)); data[di+1]=Math.max(0,Math.min(255,g)); data[di+2]=Math.max(0,Math.min(255,b)); data[di+3]=255;
  }
  return blurPx ? boxBlur(data, W, H, blurPx) : data;
}
function warpOne(cells, grid, faceIndex, params){
  const guide = guideCorners();
  const data = makePhoto(cells, grid, faceIndex, params);
  const det = detectTile(data, SAMPLE_SIZE, SAMPLE_SIZE, guide);
  if (!det.ok) return null;
  const refined = refineTileCorners(data, SAMPLE_SIZE, SAMPLE_SIZE, guide, det.rotation);
  return warpToCanonical(data, SAMPLE_SIZE, SAMPLE_SIZE, refined, det.rotation);
}
function errOf(canon, cells, grid){ const read = sampleFaceCells(canon, grid); let bad=0; for (let i=0;i<cells.length;i++) if (read[i]!==cells[i]) bad++; return 100*bad/cells.length; }

let passed = 0, failed = 0;
function test(name, fn){ try{ fn(); console.log(`OK   ${name}`); passed++; } catch(e){ console.error(`FAIL ${name}\n     ${e.message}`); failed++; } }

const grid = TIERS.mini.grid;
const built = await buildPayload({ secretText: 'REGISTRO', realPass: 'clave12', hiddenEnabled: false, tier: 'mini' });
const indices = payloadToColorIndices(rsEncodePayloadToRaw(built.payload, grid, built.parity));
const cells = faceSliceFromColorIndices(indices, grid, 0);

// Cuadros con jitter de mano + desenfoque de movimiento REALISTAS (sin reflejo).
function frameParams(k){
  return { scale: 0.95 + 0.02 * Math.sin(k*1.3), rotDeg: 1.2*Math.sin(k*0.8), dxFrac: 0.02*Math.sin(k*1.7), dyFrac: 0.02*Math.cos(k*1.1), blurPx: (k % 3 === 0 ? 2 : 1), noiseStd: 7, seed: k+5 };
}

console.log('\n--- LIMPIO (sin reflejo): 1 cuadro vs combinado multi-frame ---');
const canons = [];
for (let k = 0; k < 6; k++){ const c = warpOne(cells, grid, 0, frameParams(k)); if (c) canons.push(c); }
const single = canons.length ? errOf(canons[canons.length - 1], cells, grid) : 100;
const combo = canons.length ? errOf(combineCanonicalFrames(canons), cells, grid) : 100;
console.log(`1 cuadro (último): ${single.toFixed(1)}%`);
console.log(`combinado de ${canons.length}: ${combo.toFixed(1)}%`);

test('un solo cuadro limpio lee bien (<3%)', () => {
  assert.ok(single < 3, `1 cuadro dio ${single.toFixed(1)}%`);
});
test('DIAGNÓSTICO: el combinado NO debería ser mucho peor que 1 cuadro', () => {
  // Si esto FALLA, el combinado multi-frame es la causa de la regresión.
  assert.ok(combo <= single + 3, `combinado ${combo.toFixed(1)}% >> 1 cuadro ${single.toFixed(1)}% → el blend emborrona la rejilla`);
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
if (failed > 0) process.exitCode = 1;
