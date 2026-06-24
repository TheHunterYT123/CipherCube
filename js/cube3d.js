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
  PALETTE, FACE_ORDER, FACE_LABELS, SHARE_GRID,
  capacityBytesForGrid, colorIndicesToPayload, rsDecodeRawToPayload,
  nearestPaletteIndex, computeHomography, applyHomography,
} from './crypto.js';

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
export function sampleFaceCells(canon, grid){
  const { data, size } = canon;
  const dataSpan = 1 - 2 * DI;
  const cellN = dataSpan / grid;
  const half = cellN * 0.3;
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
      cells[idx++] = nearestPaletteIndex(rgb);
    }
  }
  return cells;
}

/** Dadas las 6 caras enderezadas (objeto {faceIndex: canon}), prueba cada
 * capacidad de `tiers` hasta que Reed-Solomon valide. Reutiliza el pipeline
 * congelado. Devuelve { payload, totalCorrected, grid, tier }. */
export function decodeCanonicalFaces(canonByFace, tiers){
  for (const tierKey of Object.keys(tiers)){
    const grid = tiers[tierKey].grid;
    try{
      const facesByIndex = {};
      for (let f = 0; f < FACE_COUNT; f++) facesByIndex[f] = sampleFaceCells(canonByFace[f], grid);
      const { payload, totalCorrected } = facesToPayload(facesByIndex, grid);
      return { payload, totalCorrected, grid, tier: tierKey };
    } catch(_){ /* prueba la siguiente capacidad */ }
  }
  throw new Error('No se pudo reconstruir el cubo con ninguna capacidad. Reescanea las caras con buena luz.');
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
  return facesToPayload(facesByIndex, grid); // { payload, totalCorrected }
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
export function facesToPayload(facesByIndex, grid){
  const indices = assembleFaces(facesByIndex, grid);
  const rawBytes = colorIndicesToPayload(indices, capacityBytesForGrid(grid));
  return rsDecodeRawToPayload(rawBytes, grid); // { payload, totalCorrected }
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
