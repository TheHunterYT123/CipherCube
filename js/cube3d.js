'use strict';
/* =========================================================
   CUBE3D — render y lectura de "baldosas" de cara para escaneo 3D.

   IMPORTANTE: esto NO cambia el formato del payload ni la criptografía.
   Una baldosa v2 contiene exactamente las MISMAS celdas de color que la
   cara correspondiente de la lámina plana (mismo pipeline
   payload→Reed-Solomon→colores). Lo único que se añade es un marco con
   marcas de orientación e identidad ALREDEDOR de la rejilla de datos, en
   una zona reservada que no toca ninguna celda de color.

   Al escanear las 6 caras, se reensambla el MISMO array de color-indices
   que produciría la lámina y se descifra con las funciones congeladas
   (colorIndicesToPayload → rsDecodeRawToPayload → tryDecryptPayload).
   ========================================================= */
import {
  PALETTE, FACE_ORDER, FACE_LABELS, SHARE_GRID, TIERS,
  capacityBytesForGrid, colorIndicesToPayload, rsDecodeRawToPayload,
  nearestPaletteIndex, computeHomography, applyHomography,
  rsDecodeBlock, effectiveCapacityForGrid, RS_N, RS_K, RS_PARITY, RS_PARITY_HIGH,
} from './crypto.js';
import { classifyCellsAdaptive } from './colorcluster.js';

/** Variantes de paridad a probar para un grid dado al descifrar (no se sabe de
 * antemano si el cubo se generó con "alta corrección"): el nivel Pro admite la
 * variante normal y la de alta corrección; el resto solo la normal.
 * IMPORTANTE: se prueba primero la paridad ALTA. Los generadores Reed-Solomon
 * usados aquí son anidados (el de grado 16 incluye como factor al de grado 8),
 * así que un bloque codificado con paridad 16 también pasa, por construcción,
 * la verificación de paridad 8 — probar paridad 8 primero interpretaría mal
 * (en silencio, sin error) cualquier cubo de alta corrección. Un bloque
 * genuino de paridad 8 no satisface la verificación de paridad 16 por
 * casualidad, así que el orden inverso no tiene ese problema. */
function parityCandidatesForGrid(grid){
  return grid === TIERS.pro.grid ? [RS_PARITY_HIGH, RS_PARITY] : [RS_PARITY];
}

/* ---- Geometría normalizada de la baldosa (0..1 en ambos ejes) ---- */
const F = 0.07;            // grosor del marco negro exterior
const B = 0.10;            // banda de los finders (entre marco y datos)
const G = 0.03;            // separación entre finders y rejilla de datos
const DI = F + B + G;      // inset de la región de datos
const FINDER = 0.075;      // medio-lado aprox. de cada finder cuadrado
// Centros canónicos de los 4 finders, en orden [TL, TR, BR, BL].
const FINDER_CENTERS = [
  [F + B / 2, F + B / 2],          // TL
  [1 - F - B / 2, F + B / 2],      // TR
  [1 - F - B / 2, 1 - F - B / 2],  // BR  (vacío en orientación canónica)
  [F + B / 2, 1 - F - B / 2],      // BL
];
// En canónico: TL, TR, BL son negros; BR es blanco (el "vacío" marca rotación).
const CANONICAL_DARK = [true, true, false, true]; // por índice [TL,TR,BR,BL]
// 3 bits de identidad de cara (0..5), en la banda superior entre TL y TR.
const ID_BIT_X = [0.42, 0.50, 0.58];
const ID_BIT_Y = F + B / 2;

export const FACE_COUNT = 6;

function tilePxForGrid(grid){
  // Apunta a ~8px por celda de datos; la región de datos ocupa (1-2*DI) del lado.
  const dataSpan = 1 - 2 * DI;
  return Math.max(360, Math.ceil((grid * 8) / dataSpan));
}

/** Extrae las grid*grid celdas de color de una cara concreta del array completo. */
export function faceSliceFromColorIndices(colorIndices, grid, faceIndex){
  const per = grid * grid;
  return colorIndices.slice(faceIndex * per, (faceIndex + 1) * per);
}

/* ---- Render de una baldosa v2 ---- */
export function drawFaceTileV2(canvas, faceCells, grid, faceIndex){
  const px = tilePxForGrid(grid);
  canvas.width = px; canvas.height = px;
  const ctx = canvas.getContext('2d');
  const N = v => v * px; // normalizado → píxeles

  // Fondo blanco + marco negro grueso.
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = '#0A0A0A';
  ctx.fillRect(0, 0, px, N(F));
  ctx.fillRect(0, px - N(F), px, N(F));
  ctx.fillRect(0, 0, N(F), px);
  ctx.fillRect(px - N(F), 0, N(F), px);

  // Finders: TL, TR, BL negros; BR vacío.
  const half = N(FINDER) / 2;
  FINDER_CENTERS.forEach(([cx, cy], i) => {
    if (!CANONICAL_DARK[i]) return;
    ctx.fillStyle = '#0A0A0A';
    ctx.fillRect(N(cx) - half, N(cy) - half, N(FINDER), N(FINDER));
  });

  // Identidad de cara (3 bits, MSB primero).
  for (let b = 0; b < 3; b++){
    const bit = (faceIndex >> (2 - b)) & 1;
    ctx.fillStyle = bit ? '#0A0A0A' : '#ffffff';
    const s = N(FINDER) * 0.7;
    ctx.fillRect(N(ID_BIT_X[b]) - s / 2, N(ID_BIT_Y) - s / 2, s, s);
  }
  // Marca de borde alrededor de los bits para que se distingan del blanco del fondo.
  ctx.strokeStyle = '#0A0A0A'; ctx.lineWidth = 1;
  for (let b = 0; b < 3; b++){
    const s = N(FINDER) * 0.7;
    ctx.strokeRect(N(ID_BIT_X[b]) - s / 2, N(ID_BIT_Y) - s / 2, s, s);
  }

  // Rejilla de datos (idéntica a la cara de la lámina).
  const dataSpan = 1 - 2 * DI;
  const cellN = dataSpan / grid;
  let idx = 0;
  for (let r = 0; r < grid; r++){
    for (let c = 0; c < grid; c++){
      const colorIdx = faceCells[idx++] || 0;
      ctx.fillStyle = PALETTE[colorIdx];
      ctx.fillRect(
        N(DI + c * cellN), N(DI + r * cellN),
        Math.ceil(N(cellN)) + 1, Math.ceil(N(cellN)) + 1
      );
    }
  }
  // Etiqueta legible para humanos (fuera de la zona de datos, no afecta la lectura).
  ctx.fillStyle = '#0A0A0A'; ctx.font = `600 ${Math.round(px*0.03)}px monospace`;
  ctx.textAlign = 'center';
  ctx.fillText(FACE_LABELS[FACE_ORDER[faceIndex]], px / 2, px - N(F) / 2 + Math.round(px*0.01));
  ctx.textAlign = 'left';
  return px;
}

/** Disposición de la hoja imprimible de 6 caras (2 columnas × 3 filas). */
export function sheetLayout(grid){
  const tile = tilePxForGrid(grid);
  const pad = Math.round(tile * 0.12);
  const cols = 2, rows = 3;
  return { tile, pad, cols, rows, width: pad + cols * (tile + pad), height: pad + rows * (tile + pad) };
}

/** Renderiza las 6 baldosas (en FACE_ORDER) a partir del array completo de colores. */
export function renderAllFaceTilesV2(colorIndices, grid){
  const tiles = [];
  for (let f = 0; f < FACE_COUNT; f++){
    const cells = faceSliceFromColorIndices(colorIndices, grid, f);
    const canvas = document.createElement('canvas');
    drawFaceTileV2(canvas, cells, grid, f);
    tiles.push(canvas);
  }
  return tiles;
}

/* ---- Lectura de una baldosa desde una imagen/cuadro ----
   `corners`: las 4 esquinas de la baldosa en el espacio de la imagen, en
   orden [TL, TR, BR, BL] (las del cuadro guía). `sample(nx,ny)` mapea un
   punto normalizado canónico al espacio de la imagen vía homografía. */
function makeSampler(ctxData, w, h, corners){
  const canonical = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const H = computeHomography(canonical, corners);
  const one = (nx, ny) => {
    let [px, py] = applyHomography(H, nx, ny);
    px = Math.max(0, Math.min(w - 1, Math.round(px)));
    py = Math.max(0, Math.min(h - 1, Math.round(py)));
    const i = (py * w + px) * 4;
    return [ctxData[i], ctxData[i + 1], ctxData[i + 2]];
  };
  // Muestreo promediado sobre una pequeña vecindad normalizada (3×3). Es clave
  // para la cámara: un solo píxel es muy sensible al desenfoque y al ruido, así
  // que promediar estabiliza tanto la detección de marcas como la lectura.
  one.avg = (nx, ny, halfN) => {
    if (!halfN) return one(nx, ny);
    let r = 0, g = 0, b = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++){
      const p = one(nx + dx * halfN, ny + dy * halfN);
      r += p[0]; g += p[1]; b += p[2]; n++;
    }
    return [r / n, g / n, b / n];
  };
  return one;
}
function rotPoint(nx, ny, k){
  // Rota (nx,ny) en pasos de 90° alrededor del centro (0.5,0.5). k horario.
  let x = nx - 0.5, y = ny - 0.5;
  for (let i = 0; i < k; i++){ const nxr = -y, nyr = x; x = nxr; y = nyr; }
  return [x + 0.5, y + 0.5];
}
function luma(rgb){ return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]; }
function isDark(rgb){ return luma(rgb) < 110; }

/**
 * Intenta leer una baldosa dadas las 4 esquinas en la imagen.
 * Devuelve { ok, faceIndex, rotation, cells } o { ok:false, reason }.
 * `data` es el Uint8ClampedArray RGBA del frame; w,h sus dimensiones.
 */
export function readFaceTile(data, w, h, corners, grid){
  const sample = makeSampler(data, w, h, corners);
  const MARK = 0.012; // radio normalizado para promediar marcas (finders/marco/id)
  // Prueba las 4 rotaciones; la correcta reproduce el patrón canónico de finders.
  for (let k = 0; k < 4; k++){
    const pattern = FINDER_CENTERS.map(([cx, cy]) => {
      const [rx, ry] = rotPoint(cx, cy, k);
      return isDark(sample.avg(rx, ry, MARK));
    });
    const matches = pattern.every((d, i) => d === CANONICAL_DARK[i]);
    if (!matches) continue;
    // Verifica marco oscuro en los puntos medios de los lados.
    const frameDark = [[0.5, F / 2], [0.5, 1 - F / 2], [F / 2, 0.5], [1 - F / 2, 0.5]]
      .every(([fx, fy]) => { const [rx, ry] = rotPoint(fx, fy, k); return isDark(sample.avg(rx, ry, MARK)); });
    if (!frameDark) continue;
    // Lee identidad de cara (3 bits) en orientación canónica.
    let faceIndex = 0;
    for (let b = 0; b < 3; b++){
      const [rx, ry] = rotPoint(ID_BIT_X[b], ID_BIT_Y, k);
      faceIndex = (faceIndex << 1) | (isDark(sample.avg(rx, ry, MARK)) ? 1 : 0);
    }
    if (faceIndex < 0 || faceIndex >= FACE_COUNT) continue;
    // Lee la rejilla de datos en orientación canónica.
    const dataSpan = 1 - 2 * DI;
    const cellN = dataSpan / grid;
    const cells = new Array(grid * grid);
    let idx = 0;
    for (let r = 0; r < grid; r++){
      for (let c = 0; c < grid; c++){
        const cx = DI + (c + 0.5) * cellN;
        const cy = DI + (r + 0.5) * cellN;
        const [rx, ry] = rotPoint(cx, cy, k);
        cells[idx++] = nearestPaletteIndex(sample(rx, ry));
      }
    }
    return { ok: true, faceIndex, rotation: k, cells };
  }
  return { ok: false, reason: 'no-tile' };
}

/* ---- API para escaneo en vivo: detección barata + warp + multi-capacidad ---- */

/** Detecta solo orientación e identidad (sin muestrear toda la rejilla). Barato
 * para correr cada frame de la cámara. Devuelve {ok, faceIndex, rotation}. */
export function detectTile(data, w, h, corners){
  const sample = makeSampler(data, w, h, corners);
  const MARK = 0.012; // radio normalizado para promediar marcas (estabiliza con cámara)
  for (let k = 0; k < 4; k++){
    const pattern = FINDER_CENTERS.map(([cx, cy]) => { const [rx, ry] = rotPoint(cx, cy, k); return isDark(sample.avg(rx, ry, MARK)); });
    if (!pattern.every((d, i) => d === CANONICAL_DARK[i])) continue;
    const frameDark = [[0.5, F / 2], [0.5, 1 - F / 2], [F / 2, 0.5], [1 - F / 2, 0.5]]
      .every(([fx, fy]) => { const [rx, ry] = rotPoint(fx, fy, k); return isDark(sample.avg(rx, ry, MARK)); });
    if (!frameDark) continue;
    let faceIndex = 0;
    for (let b = 0; b < 3; b++){ const [rx, ry] = rotPoint(ID_BIT_X[b], ID_BIT_Y, k); faceIndex = (faceIndex << 1) | (isDark(sample.avg(rx, ry, MARK)) ? 1 : 0); }
    if (faceIndex < 0 || faceIndex >= FACE_COUNT) continue;
    return { ok: true, faceIndex, rotation: k };
  }
  return { ok: false };
}

/** Endereza la baldosa a un cuadrado canónico (sin rotación) para muestrear
 * después a cualquier capacidad. Devuelve { data, size }. */
export function warpToCanonical(data, w, h, corners, rotation, outSize = 600){
  const sample = makeSampler(data, w, h, corners);
  const out = new Uint8ClampedArray(outSize * outSize * 4);
  for (let oy = 0; oy < outSize; oy++){
    for (let ox = 0; ox < outSize; ox++){
      const [rx, ry] = rotPoint(ox / outSize, oy / outSize, rotation);
      const rgb = sample(rx, ry);
      const di = (oy * outSize + ox) * 4;
      out[di] = rgb[0]; out[di + 1] = rgb[1]; out[di + 2] = rgb[2]; out[di + 3] = 255;
    }
  }
  return { data: out, size: outSize };
}

/* ---- Afinado de esquinas reales de la baldosa (clave para la cámara) ----
   La detección es tolerante (marcas grandes y promediadas), así que valida la
   cara aunque no llene exacto el recuadro guía; pero entonces la rejilla de datos
   se muestrea corrida y la lectura sale basura. Aquí localizamos los BORDES
   reales del marco negro (transición papel-blanco → marco-negro, el rasgo de
   mayor contraste de la baldosa), ajustamos una recta a cada arista y obtenemos
   las 4 esquinas por intersección. Maneja escala, desplazamiento y giro residual. */

function lumaAt(data, w, x, y){ const i = ((y | 0) * w + (x | 0)) * 4; return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; }

/** Camina desde (x0,y0) en pasos (dx,dy) y devuelve el punto donde empieza la
 * primera racha oscura de al menos `minRun` (el borde exterior del marco). */
function scanFrameEdge(data, w, h, x0, y0, dx, dy, steps, thr, minRun){
  let runStart = -1, run = 0;
  for (let s = 0; s < steps; s++){
    const x = x0 + dx * s, y = y0 + dy * s;
    if (x < 0 || x >= w || y < 0 || y >= h){ runStart = -1; run = 0; continue; }
    if (lumaAt(data, w, x, y) < thr){ if (runStart < 0) runStart = s; if (++run >= minRun) return [x0 + dx * runStart, y0 + dy * runStart]; }
    else { runStart = -1; run = 0; }
  }
  return null;
}

/** Mínimos cuadrados. mode 'xy': x=a*y+b (aristas verticales); 'yx': y=a*x+b. */
function fitLine(points, mode){
  const u = points.map(p => mode === 'xy' ? p[1] : p[0]);
  const v = points.map(p => mode === 'xy' ? p[0] : p[1]);
  const n = u.length; let su = 0, sv = 0, suu = 0, suv = 0;
  for (let i = 0; i < n; i++){ su += u[i]; sv += v[i]; suu += u[i] * u[i]; suv += u[i] * v[i]; }
  const den = n * suu - su * su;
  if (Math.abs(den) < 1e-6) return null;
  const a = (n * suv - su * sv) / den;
  return [a, (sv - a * su) / n]; // v = a*u + b
}

/** Intersección de una arista vertical (x=aL*y+bL) con una horizontal (y=aT*x+bT). */
function intersect(vert, horz){
  const [aL, bL] = vert, [aT, bT] = horz;
  const denom = 1 - aL * aT;
  if (Math.abs(denom) < 1e-6) return null;
  const x = (aL * bT + bL) / denom;
  return [x, aT * x + bT];
}

/** Afina las 4 esquinas de la baldosa por detección de bordes del marco. Devuelve
 * las esquinas originales si algo no cuadra (nunca empeora la captura). */
export function refineTileCorners(data, w, h, corners, rotation){
  const square = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const H = computeHomography(square, corners);
  const tileSpan = Math.hypot(corners[1][0] - corners[0][0], corners[1][1] - corners[0][1]);
  if (!tileSpan) return corners;
  // Umbral oscuro relativo a la exposición (mitad del blanco de la banda).
  const whiteSamples = [[F + B / 2, 0.5], [1 - F - B / 2, 0.5]].map(([nx, ny]) => {
    const [rx, ry] = rotPoint(nx, ny, rotation);
    const [px, py] = applyHomography(H, rx, ry);
    return lumaAt(data, w, Math.max(0, Math.min(w - 1, Math.round(px))), Math.max(0, Math.min(h - 1, Math.round(py))));
  });
  const thr = Math.max(...whiteSamples, 60) * 0.55;
  const margin = tileSpan * 0.14;            // arranca fuera del guide (papel blanco)
  const steps = Math.round(tileSpan * 0.4);  // alcance del barrido hacia el centro
  const minRun = Math.max(4, Math.round(F * tileSpan * 0.45)); // ~mitad del grosor del marco
  const fracs = [0.28, 0.4, 0.5, 0.6, 0.72]; // posiciones de barrido (evita las esquinas)
  // Caja aproximada del guide (ejes de la imagen).
  const xL0 = corners[0][0], xR0 = corners[1][0], yT0 = corners[0][1], yB0 = corners[3][1];
  const lerp = (a, b, t) => a + (b - a) * t;

  const leftPts = [], rightPts = [], topPts = [], botPts = [];
  for (const t of fracs){
    const y = lerp(yT0, yB0, t), x = lerp(xL0, xR0, t);
    const pL = scanFrameEdge(data, w, h, xL0 - margin, y, 1, 0, steps, thr, minRun);
    const pR = scanFrameEdge(data, w, h, xR0 + margin, y, -1, 0, steps, thr, minRun);
    const pT = scanFrameEdge(data, w, h, x, yT0 - margin, 0, 1, steps, thr, minRun);
    const pB = scanFrameEdge(data, w, h, x, yB0 + margin, 0, -1, steps, thr, minRun);
    if (pL) leftPts.push(pL); if (pR) rightPts.push(pR); if (pT) topPts.push(pT); if (pB) botPts.push(pB);
  }
  if (leftPts.length < 3 || rightPts.length < 3 || topPts.length < 3 || botPts.length < 3) return corners;
  const left = fitLine(leftPts, 'xy'), right = fitLine(rightPts, 'xy');
  const top = fitLine(topPts, 'yx'), bot = fitLine(botPts, 'yx');
  if (!left || !right || !top || !bot) return corners;
  const refined = [intersect(left, top), intersect(right, top), intersect(right, bot), intersect(left, bot)];
  for (const c of refined){ if (!c) return corners; const [x, y] = c; if (x < -w || x > 2 * w || y < -h || y > 2 * h) return corners; }
  // Cordura: el área afinada debe parecerse a la del guide (no colapsada ni gigante).
  const refSpan = Math.hypot(refined[1][0] - refined[0][0], refined[1][1] - refined[0][1]);
  if (refSpan < tileSpan * 0.5 || refSpan > tileSpan * 1.6) return corners;
  // Zona muerta estrecha: salta solo correcciones a nivel de ruido (~0.8px de la
  // detección de bordes) en caras ya bien encuadradas, pero permite corregir
  // perspectiva/desalineación real (varios px). Ajustada al muestreo de 720px,
  // donde el afinado es lo bastante preciso para que perspectivas leves del grid
  // Pro (las que más sufren) se corrijan en vez de bloquearse.
  let maxShift = 0;
  for (let i = 0; i < 4; i++) maxShift = Math.max(maxShift, Math.hypot(refined[i][0] - corners[i][0], refined[i][1] - corners[i][1]));
  if (maxShift < tileSpan * 0.003) return corners;
  return refined;
}

/** Promedia el RGB sobre una caja centrada (en coordenadas normalizadas) del lienzo canónico. */
function avgCanonRegion(data, size, cx, cy, halfN){
  const x0 = Math.max(0, Math.floor((cx - halfN) * size));
  const x1 = Math.min(size - 1, Math.ceil((cx + halfN) * size));
  const y0 = Math.max(0, Math.floor((cy - halfN) * size));
  const y1 = Math.min(size - 1, Math.ceil((cy + halfN) * size));
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++){
    const i = (y * size + x) * 4; r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
  }
  return n ? [r / n, g / n, b / n] : [0, 0, 0];
}

/** Mediana por canal de una lista de muestras RGB. Rechaza puntos atípicos
 * (p. ej. una banda blanca manchada de tinta o un finder mal recortado) sin
 * dejar que arrastren el promedio, cosa que sí hacía la media aritmética. */
function medianRgb(samples){
  const ch = c => { const v = samples.map(s => s[c]).sort((a, b) => a - b); const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
  return [ch(0), ch(1), ch(2)];
}

/** Blanco de referencia: muestrea las bandas IZQUIERDA y DERECHA (que nunca
 * llevan finders ni bits de identidad y son las menos propensas a recortes) en
 * varias alturas, más el punto inferior. Toma la mediana para que un punto
 * contaminado (banda inferior repasada con tinta) no tuerza la referencia. */
function canonWhiteRef(data, size){
  const lx = F + B / 2, rx = 1 - F - B / 2;
  const pts = [
    [lx, 0.35], [lx, 0.5], [lx, 0.65],
    [rx, 0.35], [rx, 0.5], [rx, 0.65],
    [0.5, 1 - F - B / 2],
  ];
  return medianRgb(pts.map(([nx, ny]) => avgCanonRegion(data, size, nx, ny, 0.012)));
}

/** Negro de referencia tomado del marco y los finders (zonas garantizadas
 * oscuras). Se evita el borde inferior por si fue recortado/repasado. Mediana
 * por robustez. */
function canonBlackRef(data, size){
  const pts = [
    [0.5, F / 2], [F / 2, 0.5], [1 - F / 2, 0.5],   // marco: arriba, izquierda, derecha
    [F + B / 2, F + B / 2], [1 - F - B / 2, F + B / 2], // finders TL y TR
  ];
  return medianRgb(pts.map(([nx, ny]) => avgCanonRegion(data, size, nx, ny, 0.012)));
}

// Valor de negro de la paleta de marcas (#0A0A0A). La calibración mapea el negro
// captado a este valor para que en hojas pixel-perfect la corrección sea identidad.
const BLACK_TARGET = 10;

/** Muestrea las grid*grid celdas de datos de una baldosa ya enderezada.
 * Promedia la zona central de cada celda y aplica una calibración afín por canal
 * de 2 puntos (negro del marco → 10, blanco de la banda → 255). Esto neutraliza
 * tinte de luz, exposición y el negro elevado de la cámara mucho mejor que solo
 * ganancia de blanco; en hojas exportadas pixel-perfect (negro≈10, blanco≈255) la
 * transformación es la identidad, así que ese camino no cambia. */
export function sampleFaceCellsRGB(canon, grid){
  const { data, size } = canon;
  const dataSpan = 1 - 2 * DI;
  const cellN = dataSpan / grid;
  const half = cellN * 0.22;
  const white = canonWhiteRef(data, size);
  const black = canonBlackRef(data, size);
  // Solo calibrar si las referencias son sanas: blanco claro y separado del negro.
  const span = [white[0] - black[0], white[1] - black[1], white[2] - black[2]];
  const calibrate = white[0] > 120 && white[1] > 120 && white[2] > 120 &&
    span[0] > 40 && span[1] > 40 && span[2] > 40;
  const cells = new Array(grid * grid);
  let idx = 0;
  for (let r = 0; r < grid; r++){
    for (let c = 0; c < grid; c++){
      const nx = DI + (c + 0.5) * cellN, ny = DI + (r + 0.5) * cellN;
      let rgb = avgCanonRegion(data, size, nx, ny, half);
      if (calibrate){
        rgb = rgb.map((v, ch) => {
          const out = BLACK_TARGET + (v - black[ch]) / span[ch] * (255 - BLACK_TARGET);
          return Math.max(0, Math.min(255, out));
        });
      }
      cells[idx++] = rgb;
    }
  }
  return cells;
}
/** Lectura "congelada" por celda: el RGB calibrado clasificado contra la paleta
 * teórica fija. Rápida y exacta para hojas pixel-perfect; es el primer intento. */
export function sampleFaceCells(canon, grid){
  return sampleFaceCellsRGB(canon, grid).map(nearestPaletteIndex);
}

/** SOLO DIAGNÓSTICO. Devuelve, para cada celda de datos en orden de lectura, la
 * caja normalizada (0..1 sobre el lienzo canónico) donde el lector toma su color.
 * Sirve para dibujar encima de la cara enderezada y ver si la rejilla cae
 * centrada en cada cuadro de color (alineación) o corrida (la lectura sale
 * basura). DI, dataSpan y el 0.22 deben coincidir con sampleFaceCellsRGB. */
export function dataSampleBoxes(grid){
  const dataSpan = 1 - 2 * DI;
  const cellN = dataSpan / grid;
  const half = cellN * 0.22;
  const boxes = [];
  for (let r = 0; r < grid; r++){
    for (let c = 0; c < grid; c++){
      const nx = DI + (c + 0.5) * cellN, ny = DI + (r + 0.5) * cellN;
      boxes.push({ cx: nx, cy: ny, x: nx - half, y: ny - half, w: 2 * half, h: 2 * half });
    }
  }
  return boxes;
}

/** Clasifica las 6 caras por color ADAPTATIVO (clustering global): muestrea el
 * RGB calibrado de cada celda de todas las caras y deja que colorcluster mapee
 * los colores como los ve la cámara. Devuelve {faceIndex: cells}. */
function clusterClassifyFaces(canonByFace, grid){
  const facesRgb = [];
  for (let f = 0; f < FACE_COUNT; f++) facesRgb.push(sampleFaceCellsRGB(canonByFace[f], grid));
  const labels = classifyCellsAdaptive(facesRgb);
  const facesByIndex = {};
  for (let f = 0; f < FACE_COUNT; f++) facesByIndex[f] = labels[f];
  return facesByIndex;
}

/** Dadas las 6 caras enderezadas (objeto {faceIndex: canon}), prueba cada
 * capacidad de `tiers` hasta que Reed-Solomon valide. Devuelve
 * { payload, totalCorrected, grid, tier }.
 *
 * Dos pasadas: primero el lector "congelado" (paleta fija) — rápido y exacto
 * para hojas pixel-perfect. Si NINGUNA capacidad valida con él, se reintenta con
 * la clasificación ADAPTATIVA por clustering, que tolera la curva de tono no
 * lineal de cámaras/pantallas (gamma, tinte, saturación) que descoloca un color
 * entero de la paleta. El resultado siempre lo valida Reed-Solomon, así que el
 * clustering nunca produce un falso positivo: si su lectura no cuadra, no valida
 * y se descarta. */
export function decodeCanonicalFaces(canonByFace, tiers){
  for (const adaptive of [false, true]){
    for (const tierKey of Object.keys(tiers)){
      const grid = tiers[tierKey].grid;
      let facesByIndex;
      try{
        if (adaptive){
          facesByIndex = clusterClassifyFaces(canonByFace, grid);
        } else {
          facesByIndex = {};
          for (let f = 0; f < FACE_COUNT; f++) facesByIndex[f] = sampleFaceCells(canonByFace[f], grid);
        }
      } catch(_){ continue; }
      // El muestreo no depende de la paridad usada al crear el cubo, así que se
      // reutiliza facesByIndex y solo se reintenta el reparto datos/paridad.
      for (const parity of parityCandidatesForGrid(grid)){
        try{
          const { payload, totalCorrected } = facesToPayload(facesByIndex, grid, parity);
          return { payload, totalCorrected, grid, tier: tierKey, parity };
        } catch(_){ /* prueba la siguiente paridad o capacidad */ }
      }
    }
  }
  throw new Error('No se pudo reconstruir el cubo con ninguna capacidad. Reescanea las caras con buena luz.');
}

/** A qué cara pertenece (mayormente) un bloque Reed-Solomon. Cada bloque son
 * RS_N bytes contiguos del flujo de colores; tomo el byte central, lo convierto
 * a celda (3 bits/celda) y de ahí a cara (grid*grid celdas por cara). */
function blockFaceIndex(blockIdx, grid){
  const per = grid * grid;
  const midByte = blockIdx * RS_N + Math.floor(RS_N / 2);
  const midCell = Math.floor((midByte * 8) / 3);
  return Math.max(0, Math.min(FACE_COUNT - 1, Math.floor(midCell / per)));
}

/** Diagnóstico cuando el descifrado falla: prueba cada capacidad SIN lanzar y
 * cuenta, por cara, cuántos bloques RS quedan irrecuperables. Devuelve el reporte
 * de la capacidad con menos bloques dañados (la más probable), o null si ni
 * siquiera se pudo muestrear. No cambia el pipeline de descifrado. */
export function diagnoseCanonicalFaces(canonByFace, tiers){
  let best = null;
  for (const adaptive of [false, true]){
  for (const tierKey of Object.keys(tiers)){
    const grid = tiers[tierKey].grid;
    let raw;
    try{
      let facesByIndex;
      if (adaptive){
        facesByIndex = clusterClassifyFaces(canonByFace, grid);
      } else {
        facesByIndex = {};
        for (let f = 0; f < FACE_COUNT; f++) facesByIndex[f] = sampleFaceCells(canonByFace[f], grid);
      }
      const indices = assembleFaces(facesByIndex, grid);
      raw = colorIndicesToPayload(indices, capacityBytesForGrid(grid));
    } catch(_){ continue; }
    for (const parity of parityCandidatesForGrid(grid)){
      const { numBlocks, k } = effectiveCapacityForGrid(grid, parity);
      const perFaceFailed = new Array(FACE_COUNT).fill(0);
      const perFaceTotal = new Array(FACE_COUNT).fill(0);
      let failedBlocks = 0;
      for (let i = 0; i < numBlocks; i++){
        const block = raw.slice(i * RS_N, (i + 1) * RS_N);
        const res = rsDecodeBlock(block, k, parity);
        const face = blockFaceIndex(i, grid);
        perFaceTotal[face]++;
        if (!res.success){ failedBlocks++; perFaceFailed[face]++; }
      }
      const report = { tier: tierKey, grid, parity, numBlocks, failedBlocks, perFaceFailed, perFaceTotal };
      if (!best || report.failedBlocks < best.failedBlocks) best = report;
    }
  }
  }
  return best;
}

/** ¿Las dimensiones de la imagen corresponden a una hoja 3D exportada? Devuelve la capacidad o null. */
export function detectSheetTier(img, tiers){
  const tol = 4;
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  for (const k of Object.keys(tiers)){
    const L = sheetLayout(tiers[k].grid);
    if (Math.abs(w - L.width) <= tol && Math.abs(h - L.height) <= tol) return k;
  }
  return null;
}

/** Decodifica una hoja 3D exportada (PNG exacto) leyendo las 6 baldosas por su posición conocida. */
export function decodeSheetImage(img, grid){
  const L = sheetLayout(grid);
  const off = document.createElement('canvas'); off.width = L.width; off.height = L.height;
  const ctx = off.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, L.width, L.height);
  const full = ctx.getImageData(0, 0, L.width, L.height);
  const facesByIndex = {};
  for (let i = 0; i < FACE_COUNT; i++){
    const cx = L.pad + (i % L.cols) * (L.tile + L.pad);
    const cy = L.pad + Math.floor(i / L.cols) * (L.tile + L.pad);
    const corners = [[cx, cy], [cx + L.tile - 1, cy], [cx + L.tile - 1, cy + L.tile - 1], [cx, cy + L.tile - 1]];
    const det = detectTile(full.data, L.width, L.height, corners);
    if (!det.ok) throw new Error('No se reconoció una de las caras en la hoja 3D.');
    const canon = warpToCanonical(full.data, L.width, L.height, corners, det.rotation);
    facesByIndex[det.faceIndex] = sampleFaceCells(canon, grid);
  }
  for (const parity of parityCandidatesForGrid(grid)){
    try{ return facesToPayload(facesByIndex, grid, parity); } catch(_){ /* prueba la siguiente paridad */ }
  }
  throw new Error('No se pudo reconstruir el cubo con ninguna capacidad. Revisa la imagen.');
}

/** Reensambla las 6 caras (objeto {faceIndex: cells}) en el array completo. */
export function assembleFaces(facesByIndex, grid){
  const per = grid * grid;
  const indices = new Array(FACE_COUNT * per);
  for (let f = 0; f < FACE_COUNT; f++){
    const cells = facesByIndex[f];
    if (!cells) throw new Error(`Falta la cara ${f + 1} de ${FACE_COUNT}.`);
    for (let i = 0; i < per; i++) indices[f * per + i] = cells[i];
  }
  return indices;
}

/** Convierte las 6 caras capturadas en payload, reutilizando el pipeline congelado. */
export function facesToPayload(facesByIndex, grid, parity = RS_PARITY){
  const indices = assembleFaces(facesByIndex, grid);
  const rawBytes = colorIndicesToPayload(indices, capacityBytesForGrid(grid));
  return rsDecodeRawToPayload(rawBytes, grid, parity); // { payload, totalCorrected }
}

/* ---- Partes Shamir como cubos escaneables ----
   Una parte usa SHARE_GRID y NO lleva Reed-Solomon: el ensamblado va directo
   de colores a bytes de la parte (igual que la lectura de lámina de parte). */
export function shareSheetLayout(){ return sheetLayout(SHARE_GRID); }

function shareCanonToPayload(canonByFace){
  const facesByIndex = {};
  for (let f = 0; f < FACE_COUNT; f++) facesByIndex[f] = sampleFaceCells(canonByFace[f], SHARE_GRID);
  const indices = assembleFaces(facesByIndex, SHARE_GRID);
  return colorIndicesToPayload(indices, capacityBytesForGrid(SHARE_GRID));
}

/** Caras canónicas escaneadas de una parte → bytes de payload de la parte. */
export function shareFacesToPayload(canonByFace){ return shareCanonToPayload(canonByFace); }

/** Hoja 3D exportada de una parte (PNG exacto) → bytes de payload de la parte. */
export function decodeShareSheetImage(img){
  const grid = SHARE_GRID;
  const L = sheetLayout(grid);
  const off = document.createElement('canvas'); off.width = L.width; off.height = L.height;
  const ctx = off.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, L.width, L.height);
  const full = ctx.getImageData(0, 0, L.width, L.height);
  const canonByFace = {};
  for (let i = 0; i < FACE_COUNT; i++){
    const cx = L.pad + (i % L.cols) * (L.tile + L.pad);
    const cy = L.pad + Math.floor(i / L.cols) * (L.tile + L.pad);
    const corners = [[cx, cy], [cx + L.tile - 1, cy], [cx + L.tile - 1, cy + L.tile - 1], [cx, cy + L.tile - 1]];
    const det = detectTile(full.data, L.width, L.height, corners);
    if (!det.ok) throw new Error('No se reconoció una de las caras de la parte 3D.');
    canonByFace[det.faceIndex] = warpToCanonical(full.data, L.width, L.height, corners, det.rotation);
  }
  return shareCanonToPayload(canonByFace);
}

/** ¿La imagen es una hoja 3D de parte (dimensiones de SHARE_GRID)? */
export function isShareSheet(img){
  const tol = 4;
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  const L = sheetLayout(SHARE_GRID);
  return Math.abs(w - L.width) <= tol && Math.abs(h - L.height) <= tol;
}
