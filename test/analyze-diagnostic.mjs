// HERRAMIENTA (no es test): analiza fuera del teléfono una imagen de diagnóstico
// generada por la app (escáner v24+). La imagen incluye abajo las 6 caras
// enderezadas a RESOLUCIÓN COMPLETA y sin nada dibujado encima; este script las
// relee y re-ejecuta el decodificador REAL (decodeCanonicalFaces) sobre ellas,
// con lo que reproduce exactamente lo que vio el teléfono y dice la causa:
// identidad de cara, reflejo, color o bloques Reed-Solomon dañados.
//
//   node test/analyze-diagnostic.mjs ruta/al/ciphercube-diagnostico.png
//
// IMPORTANTE: el PNG debe llegar SIN recomprimir (enviado como archivo). El layout
// de abajo DEBE coincidir con buildDiagnosticDataURL en js/camera-live.js.
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
globalThis.window = globalThis;
globalThis.document = { createElement(){ return {}; }, head:{ appendChild(){} } };

const { TIERS, PALETTE } = await import('../js/crypto.js');
const {
  readCanonicalFaceId, faceScanQuality, decodeCanonicalFaces, diagnoseCanonicalFaces,
  sampleFaceCellsRGB, FACE_COUNT,
} = await import('../js/cube3d.js');

// --- Layout de buildDiagnosticDataURL (js/camera-live.js) — mantener en sincronía ---
const TILE = 240, PAD = 12, COLS = 3, ROWS = 2, HEAD = 64, FOOT = 22, RAW = 600, LABEL = 20;
const RAW_Y0 = HEAD + ROWS * (TILE + PAD + FOOT) + LABEL;
const EXPECTED_W = PAD + COLS * (RAW + PAD);
const EXPECTED_H = RAW_Y0 + ROWS * (RAW + PAD);

// --- Decodificador PNG mínimo (8 bits, RGB/RGBA, sin entrelazado) ---
function decodePng(buf){
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

function sliceTile(img, x0, y0, size){
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++){
    const src = ((y0 + y) * img.width + x0) * 4;
    data.set(img.data.subarray(src, src + size * 4), y * size * 4);
  }
  return { data, size };
}

const hexToRgb = hx => { const v = hx.replace('#', ''); return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)]; };
const PALETTE_RGB = PALETTE.map(hexToRgb);
function nearestDist(rgb){
  let best = Infinity;
  for (const p of PALETTE_RGB){
    const d = (rgb[0] - p[0]) ** 2 + (rgb[1] - p[1]) ** 2 + (rgb[2] - p[2]) ** 2;
    if (d < best) best = d;
  }
  return best;
}

const file = process.argv[2];
if (!file){ console.error('Uso: node test/analyze-diagnostic.mjs ciphercube-diagnostico.png'); process.exit(2); }
const img = decodePng(readFileSync(file));
console.log(`PNG ${img.width}×${img.height}`);
if (img.width !== EXPECTED_W || img.height !== EXPECTED_H){
  console.error(`✗ Dimensiones inesperadas (esperaba ${EXPECTED_W}×${EXPECTED_H}). O la imagen fue REESCALADA/recomprimida ` +
    'al enviarla, o se generó con una versión vieja de la app (se necesita "escáner v24" o superior, visible bajo el botón Descifrar).');
  process.exit(2);
}

const canonByFace = {};
console.log('\n— Por cara (identidad + reflejo + salud de color) —');
for (let f = 0; f < FACE_COUNT; f++){
  const col = f % COLS, row = (f / COLS) | 0;
  const canon = sliceTile(img, PAD + col * (RAW + PAD), RAW_Y0 + row * (RAW + PAD), RAW);
  canonByFace[f] = canon;
  const id = readCanonicalFaceId(canon);
  const q = faceScanQuality(canon);
  // Salud de color con el grid del tier más probable (se refina abajo con diagnose).
  const cells = sampleFaceCellsRGB(canon, TIERS.mini.grid);
  const dists = cells.map(nearestDist).sort((a, b) => a - b);
  const p50 = dists[(dists.length / 2) | 0], p95 = dists[(dists.length * 0.95) | 0];
  const far = dists.filter(d => d > 2500).length;
  console.log(`cara ${f + 1}: id=${id.ok ? id.faceIndex + 1 : 'ILEGIBLE'} · reflejo=${(q.glareFrac * 100).toFixed(2)}%${q.ok ? '' : ' ⚠SUPERA UMBRAL'} · dist² paleta p50=${p50 | 0} p95=${p95 | 0} · celdas lejos de todo color=${far}/${dists.length}`);
}

console.log('\n— Diagnóstico Reed-Solomon (bloques irrecuperables por cara) —');
const rep = diagnoseCanonicalFaces(canonByFace, TIERS);
if (rep){
  console.log(`capacidad ${rep.tier} (grid ${rep.grid}, paridad ${rep.parity}) · bloques mal: ${rep.failedBlocks}/${rep.numBlocks}`);
  console.log('por cara: ' + rep.perFaceFailed.map((n, f) => `c${f + 1}=${n}/${rep.perFaceTotal[f]}`).join(' · '));
} else console.log('ni siquiera se pudo muestrear (¿imagen rota?)');

console.log('\n— Decode completo (la cadena real, con permutación y borrones) —');
try{
  const t0 = Date.now();
  const r = decodeCanonicalFaces(canonByFace, TIERS);
  console.log(`✓ RECONSTRUYE: tier=${r.tier} paridad=${r.parity} bytesCorregidos=${r.totalCorrected} (${Date.now() - t0} ms)`);
  console.log('El escaneo está BIEN. Si aún así "no descifra", el problema es la FRASE (o el cubo escaneado no es el que se cree).');
} catch(e){
  console.log(`✗ NO reconstruye: ${e.message}`);
  console.log('El fallo ES de escaneo: mira arriba qué cara concentra los bloques dañados y su causa (reflejo/color/identidad).');
}
