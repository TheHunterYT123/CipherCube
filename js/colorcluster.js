'use strict';
/* =========================================================
   COLORCLUSTER — clasificación de color ADAPTATIVA para el escaneo con cámara.

   Por qué existe: el lector "congelado" compara cada celda con la paleta teórica
   fija (nearestPaletteIndex). Una cámara o una pantalla aplican una curva de tono
   NO lineal (gamma) + saturación + tinte que un calibrado de 2 puntos
   (negro→10, blanco→255) NO corrige. Esa no linealidad puede empujar un color
   entero de la paleta al otro lado de la frontera con su vecino, volviéndolo
   100% ilegible (~1/8 de las celdas) y haciendo que Reed-Solomon pierda casi
   todos los bloques. Es la causa de "N de N bloques ilegibles" incluso
   escaneando desde una pantalla, donde no hay error de impresión ni reflejos.

   Cómo lo arregla, SIN cambiar el formato (sirve para cubos ya impresos):
   en vez de comparar contra la paleta teórica, agrupamos las celdas OBSERVADAS
   (todas las caras juntas) en 8 grupos con k-means++ y asignamos cada grupo a un
   índice de paleta por su ESTRUCTURA: la permutación cuyo mejor ajuste afín
   paleta→grupos deja menor residual. Como comparamos observado-contra-observado,
   cualquier transformación de color consistente (gamma, tinte, saturación) se
   cancela. La clasificación final mapea cada celda a su grupo más cercano.

   Este módulo NO decide solo: el llamador valida el resultado con Reed-Solomon,
   así que un agrupamiento dudoso simplemente "no valida" y se descarta — nunca
   produce un descifrado falso.
   ========================================================= */
import { PALETTE, hexToRgb } from './crypto.js';

const PAL_RGB = PALETTE.map(hexToRgb);
const PAL_X = PAL_RGB.map(p => [p[0], p[1], p[2], 1]); // paleta homogénea (8×4)

/* ---- Álgebra mínima para el etiquetado por ajuste afín ---- */
function invert4(M){
  const A = M.map((row, i) => [...row, ...[0,1,2,3].map(j => i === j ? 1 : 0)]);
  for (let col = 0; col < 4; col++){
    let piv = col;
    for (let r = col + 1; r < 4; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    const d = A[col][col];
    if (Math.abs(d) < 1e-12) return null;
    for (let c = 0; c < 8; c++) A[col][c] /= d;
    for (let r = 0; r < 4; r++){ if (r === col) continue; const f = A[r][col]; for (let c = 0; c < 8; c++) A[r][c] -= f * A[col][c]; }
  }
  return A.map(r => r.slice(4));
}
// Pseudoinversa de la paleta: PINV = (Xᵀ·X)⁻¹·Xᵀ  (4×8). Constante; se precalcula.
const PAL_PINV = (function(){
  const XtX = [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]];
  for (const r of PAL_X) for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) XtX[i][j] += r[i] * r[j];
  const inv = invert4(XtX);
  const pinv = [[0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0]];
  for (let i = 0; i < 4; i++) for (let s = 0; s < 8; s++){ let v = 0; for (let j = 0; j < 4; j++) v += inv[i][j] * PAL_X[s][j]; pinv[i][s] = v; }
  return pinv;
})();

/** Residual del mejor afín paleta→Y, donde Y[i] es el centroide asignado al
 * color de paleta i. El ajuste afín se resuelve por canal con la pseudoinversa
 * precalculada. La permutación correcta deja un residual claramente menor. */
function affineResidual(Y){
  let res = 0;
  for (let ch = 0; ch < 3; ch++){
    const co = [0,0,0,0];
    for (let i = 0; i < 4; i++){ let v = 0; for (let s = 0; s < 8; s++) v += PAL_PINV[i][s] * Y[s][ch]; co[i] = v; }
    for (let s = 0; s < 8; s++){
      const pred = co[0]*PAL_X[s][0] + co[1]*PAL_X[s][1] + co[2]*PAL_X[s][2] + co[3];
      const e = pred - Y[s][ch]; res += e * e;
    }
  }
  return res;
}
/** Asigna cada uno de los 8 centroides a un índice de paleta. Devuelve
 * map[clusterIdx] = paletteIdx, eligiendo la permutación de menor residual afín.
 * Si algo degenera, cae a la asignación voraz por cercanía (nunca lanza). */
function labelClusters(centroids){
  let best = null, bestRes = Infinity;
  const used = new Array(8).fill(false), perm = new Array(8); // perm[paletteIdx] = clusterIdx
  (function rec(i){
    if (i === 8){ const Y = perm.map(cl => centroids[cl]); const r = affineResidual(Y); if (r < bestRes){ bestRes = r; best = perm.slice(); } return; }
    for (let cl = 0; cl < 8; cl++) if (!used[cl]){ used[cl] = true; perm[i] = cl; rec(i + 1); used[cl] = false; }
  })(0);
  const map = new Array(8);
  if (best){ for (let pi = 0; pi < 8; pi++) map[best[pi]] = pi; return map; }
  // Fallback voraz: cada centroide al color de paleta más cercano disponible.
  const takenP = new Array(8).fill(false), takenC = new Array(8).fill(false);
  const pairs = [];
  for (let c = 0; c < 8; c++) for (let p = 0; p < 8; p++){ const d = (centroids[c][0]-PAL_RGB[p][0])**2+(centroids[c][1]-PAL_RGB[p][1])**2+(centroids[c][2]-PAL_RGB[p][2])**2; pairs.push([d,c,p]); }
  pairs.sort((a,b)=>a[0]-b[0]);
  for (const [,c,p] of pairs){ if (!takenC[c] && !takenP[p]){ map[c] = p; takenC[c] = true; takenP[p] = true; } }
  return map;
}

/* ---- k-means++ ---- */
function kmeanspp(points, k){
  const seeds = [points[(Math.random() * points.length) | 0].slice()];
  while (seeds.length < k){
    const d2 = points.map(p => { let bd = Infinity; for (const s of seeds){ const d = (s[0]-p[0])**2+(s[1]-p[1])**2+(s[2]-p[2])**2; if (d < bd) bd = d; } return bd; });
    let sum = 0; for (const d of d2) sum += d;
    let r = Math.random() * sum, i = 0; while (i < d2.length - 1 && r > d2[i]){ r -= d2[i]; i++; }
    seeds.push(points[i].slice());
  }
  return seeds;
}
function kmeans(points, seeds, iters){
  const cent = seeds.map(s => s.slice());
  const assign = new Array(points.length).fill(-1);
  for (let it = 0; it < iters; it++){
    let moved = false;
    for (let p = 0; p < points.length; p++){
      let best = 0, bd = Infinity;
      for (let i = 0; i < cent.length; i++){ const c = cent[i]; const d = (c[0]-points[p][0])**2+(c[1]-points[p][1])**2+(c[2]-points[p][2])**2; if (d < bd){ bd = d; best = i; } }
      if (assign[p] !== best){ assign[p] = best; moved = true; }
    }
    const sum = Array.from({ length: cent.length }, () => [0,0,0,0]);
    for (let p = 0; p < points.length; p++){ const a = assign[p]; sum[a][0]+=points[p][0]; sum[a][1]+=points[p][1]; sum[a][2]+=points[p][2]; sum[a][3]++; }
    for (let i = 0; i < cent.length; i++) if (sum[i][3]) cent[i] = [sum[i][0]/sum[i][3], sum[i][1]/sum[i][3], sum[i][2]/sum[i][3]];
    if (!moved && it > 0) break;
  }
  return cent;
}

const MAX_CLUSTER_POINTS = 2500; // submuestreo para acotar el coste del k-means
const KMEANS_RESTARTS = 5;
const KMEANS_ITERS = 30;

/**
 * Clasifica las celdas por clustering global + etiquetado estructural.
 * @param facesRgb array de caras; cada cara es un array de [r,g,b] ya calibrados.
 * @returns array de caras; cada cara es un array de índices de paleta (0..7).
 */
export function classifyCellsAdaptive(facesRgb){
  const all = [];
  for (const face of facesRgb) for (const rgb of face) all.push(rgb);
  if (all.length < 8) throw new Error('Muy pocas celdas para clasificar por color.');

  // Submuestreo uniforme solo para hallar los centroides (la clasificación usa todo).
  let sample = all;
  if (all.length > MAX_CLUSTER_POINTS){
    sample = [];
    const step = all.length / MAX_CLUSTER_POINTS;
    for (let i = 0; i < all.length; i += step) sample.push(all[Math.floor(i)]);
  }

  // Varios reinicios k-means++; nos quedamos con la menor inercia (evita mínimos
  // locales que fusionarían dos colores en un solo grupo).
  let bestCent = null, bestInertia = Infinity;
  for (let t = 0; t < KMEANS_RESTARTS; t++){
    const cent = kmeans(sample, kmeanspp(sample, 8), KMEANS_ITERS);
    let inertia = 0;
    for (const p of sample){ let bd = Infinity; for (const c of cent){ const d = (c[0]-p[0])**2+(c[1]-p[1])**2+(c[2]-p[2])**2; if (d < bd) bd = d; } inertia += bd; }
    if (inertia < bestInertia){ bestInertia = inertia; bestCent = cent; }
  }

  const map = labelClusters(bestCent);
  const out = [];
  for (const face of facesRgb){
    const arr = new Array(face.length);
    for (let i = 0; i < face.length; i++){
      const p = face[i]; let best = 0, bd = Infinity;
      for (let c = 0; c < 8; c++){ const ct = bestCent[c]; const d = (ct[0]-p[0])**2+(ct[1]-p[1])**2+(ct[2]-p[2])**2; if (d < bd){ bd = d; best = c; } }
      arr[i] = map[best];
    }
    out.push(arr);
  }
  return out;
}
