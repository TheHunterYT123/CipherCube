// Helper compartido (NO es test): decodificador PNG mínimo y utilidades para
// leer las imágenes de diagnóstico de la app (layout de buildDiagnosticDataURL
// en js/camera-live.js — mantener las constantes en sincronía con ese archivo).
// Lo usan test/analyze-diagnostic.mjs y test/scan-screen-moire.test.mjs.
import { inflateSync } from 'node:zlib';

/** PNG 8 bits, RGB/RGBA, sin entrelazado → { data: Uint8ClampedArray RGBA, width, height } */
export function decodePng(buf){
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error('No es un PNG.');
  let pos = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length){
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR'){
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0){
    throw new Error(`PNG no soportado (bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}). ` +
      '¿La imagen fue RECOMPRIMIDA (p. ej. enviada como foto)? Envíala como archivo.');
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = new Uint8ClampedArray(w * h * 4);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < h; y++){
    const filter = raw[p++];
    for (let x = 0; x < stride; x++){
      const rb = raw[p + x];
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v;
      switch (filter){
        case 0: v = rb; break;
        case 1: v = rb + a; break;
        case 2: v = rb + b; break;
        case 3: v = rb + ((a + b) >> 1); break;
        case 4: {
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          v = rb + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c));
          break;
        }
        default: throw new Error(`Filtro PNG desconocido: ${filter}`);
      }
      cur[x] = v & 0xff;
    }
    p += stride;
    for (let x = 0; x < w; x++){
      const s = x * bpp, d = (y * w + x) * 4;
      out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2];
      out[d + 3] = bpp === 4 ? cur[s + 3] : 255;
    }
    prev.set(cur);
  }
  return { data: out, width: w, height: h };
}

// Layout de buildDiagnosticDataURL (js/camera-live.js) — mantener en sincronía.
export const DIAG = (() => {
  const TILE = 240, PAD = 12, COLS = 3, ROWS = 2, HEAD = 64, FOOT = 22, RAW = 600, LABEL = 20;
  const RAW_Y0 = HEAD + ROWS * (TILE + PAD + FOOT) + LABEL;
  return {
    TILE, PAD, COLS, ROWS, HEAD, FOOT, RAW, LABEL, RAW_Y0,
    WIDTH: PAD + COLS * (RAW + PAD),
    HEIGHT: RAW_Y0 + ROWS * (RAW + PAD),
  };
})();

/** Recorta un cuadrado del PNG decodificado como baldosa canónica { data, size }. */
export function sliceTile(img, x0, y0, size){
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++){
    const src = ((y0 + y) * img.width + x0) * 4;
    data.set(img.data.subarray(src, src + size * 4), y * size * 4);
  }
  return { data, size };
}

/** Las 6 caras a resolución completa de una imagen de diagnóstico v24+. */
export function diagnosticFaces(img, faceCount = 6){
  if (img.width !== DIAG.WIDTH || img.height !== DIAG.HEIGHT){
    throw new Error(`Dimensiones inesperadas ${img.width}×${img.height} (esperaba ${DIAG.WIDTH}×${DIAG.HEIGHT}). ` +
      'Imagen reescalada/recomprimida o generada con una app anterior a "escáner v24".');
  }
  const out = {};
  for (let f = 0; f < faceCount; f++){
    const col = f % DIAG.COLS, row = (f / DIAG.COLS) | 0;
    out[f] = sliceTile(img, DIAG.PAD + col * (DIAG.RAW + DIAG.PAD), DIAG.RAW_Y0 + row * (DIAG.RAW + DIAG.PAD), DIAG.RAW);
  }
  return out;
}
