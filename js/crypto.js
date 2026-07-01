'use strict';
/* =========================================================
   CIPHERCUBE — núcleo criptográfico (probado: 29/29 pruebas)
   No modificar esta lógica: cualquier cambio rompe la compatibilidad
   con cubos ya generados.
   ========================================================= */
import { isArgon2Available, getArgon2 } from './argon2-loader.js';

export const PALETTE = ['#E69F00','#56B4E9','#009E73','#F0E442','#0072B2','#D55E00','#CC79A7','#1A1A1A'];
export const TIERS = { mini:{grid:24,label:'Mini'}, estandar:{grid:40,label:'Estándar'}, pro:{grid:60,label:'Pro'} };
export const HEADER_SIZE = 20;
export const MAGIC = new Uint8Array([0x43,0x43,0x31]);
export const RS_K = 32, RS_PARITY = 8, RS_N = 40;
// Variante opcional de "alta corrección" para el nivel Pro: dobla la paridad
// (8→16 de 40) a cambio de capacidad de secreto (32→24 de 40 por bloque).
// RS_N (tamaño físico de bloque) no cambia, así que el número de bloques por
// grid tampoco cambia: solo se reparten distinto entre datos y paridad.
export const RS_PARITY_HIGH = 16;

/* ---- Versión de KDF, empacada en bits libres del byte de flags (offset 3) ----
   Bit 0 = volumen oculto (igual que siempre). Bit 1 = KDF usado para las claves AES.
   Los cubos generados antes de este cambio siempre tienen el bit 1 en 0, así que
   se siguen leyendo como PBKDF2 automáticamente: el formato y HEADER_SIZE no cambian. */
const FLAG_HIDDEN = 0x01;
const FLAG_KDF_ARGON2ID = 0x02;
export const KDF_PBKDF2 = 'pbkdf2';
export const KDF_ARGON2ID = 'argon2id';

export function capacityBytesForGrid(grid){ return Math.floor((grid*grid*6*3)/8); }
export function effectiveCapacityForGrid(grid, parity = RS_PARITY){
  const raw = capacityBytesForGrid(grid);
  const k = RS_N - parity;
  const numBlocks = Math.floor(raw / RS_N);
  return { raw, numBlocks, usable: numBlocks*k, k, parity };
}
export function slotPlaintextLenForCapacity(usableCapacity){
  const overheadPerSlot = 12+2+16;
  const usable = usableCapacity - HEADER_SIZE;
  const perSlotTotal = Math.floor(usable/2);
  const plaintextLen = perSlotTotal - overheadPerSlot;
  if (plaintextLen < 32) throw new Error('Capacidad insuficiente para este nivel.');
  return plaintextLen;
}
export function randomBytes(n){ const b=new Uint8Array(n); crypto.getRandomValues(b); return b; }

export async function deriveKey(passphrase, salt, context){
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const fullSalt = new Uint8Array([...salt, ...enc.encode(context)]);
  return crypto.subtle.deriveKey({ name:'PBKDF2', salt: fullSalt, iterations: 600000, hash:'SHA-256' }, baseKey, { name:'AES-GCM', length:256 }, false, ['encrypt','decrypt']);
}
/** Igual idea que deriveKey, pero con Argon2id en vez de PBKDF2. Requiere que
 * argon2-loader.js ya haya cargado y probado la librería en este navegador. */
export async function deriveKeyV2Argon2id(passphrase, salt, context){
  if (!isArgon2Available()) throw new Error('Este cubo requiere Argon2id, no disponible en este navegador.');
  const argon2 = getArgon2();
  const enc = new TextEncoder();
  const fullSalt = new Uint8Array([...salt, ...enc.encode(context)]);
  const result = await argon2.hash({
    pass: passphrase,
    salt: fullSalt,
    type: argon2.ArgonType.Argon2id,
    time: 3,
    mem: 65536,
    hashLen: 32,
  });
  return crypto.subtle.importKey('raw', result.hash, 'AES-GCM', false, ['encrypt','decrypt']);
}
/** Cifra un slot de tamaño fijo con una clave AES-GCM ya derivada (por
 * cualquier KDF). */
async function encryptFixedSlotWithKey(plaintextStr, key, fixedLen){
  const enc = new TextEncoder();
  const rawBytes = enc.encode(plaintextStr);
  if (rawBytes.length > fixedLen - 2) throw new Error(`Secreto demasiado grande para esta capacidad (máx ${fixedLen-2} bytes, usado ${rawBytes.length}).`);
  const padded = new Uint8Array(fixedLen);
  padded[0]=(rawBytes.length>>8)&0xff; padded[1]=rawBytes.length&0xff;
  padded.set(rawBytes,2);
  if (fixedLen-2-rawBytes.length>0) padded.set(randomBytes(fixedLen-2-rawBytes.length), 2+rawBytes.length);
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt({name:'AES-GCM', iv}, key, padded);
  return { iv, ciphertext: new Uint8Array(ciphertext) };
}
async function decryptFixedSlotWithKey(iv, ciphertext, key){
  const plainBuf = await crypto.subtle.decrypt({name:'AES-GCM', iv}, key, ciphertext);
  const padded = new Uint8Array(plainBuf);
  const len = (padded[0]<<8)|padded[1];
  return new TextDecoder().decode(padded.slice(2,2+len));
}
export async function hmacOffset(passphrase, salt, rangeSize){
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(passphrase), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', keyMaterial, salt);
  return new DataView(sig).getUint32(0,false) % rangeSize;
}
export async function buildPayload(opts){
  const tierInfo = TIERS[opts.tier];
  if (!tierInfo) throw new Error('Nivel de capacidad inválido.');
  const parity = (opts.tier === 'pro' && opts.highEcc) ? RS_PARITY_HIGH : RS_PARITY;
  const usableCapacity = effectiveCapacityForGrid(tierInfo.grid, parity).usable;
  const slotLen = slotPlaintextLenForCapacity(usableCapacity);
  const salt = randomBytes(16);
  const payload = new Uint8Array(usableCapacity);
  payload.set(randomBytes(usableCapacity), 0);
  payload.set(MAGIC, 0);
  const useArgon2 = isArgon2Available();
  payload[3] = (opts.hiddenEnabled ? FLAG_HIDDEN : 0) | (useArgon2 ? FLAG_KDF_ARGON2ID : 0);
  payload.set(salt, 4);
  const usable = usableCapacity - HEADER_SIZE;
  const perSlotTotal = Math.floor(usable/2);
  const decoyOffset = HEADER_SIZE;
  let decoyPlaintext, decoyPass;
  if (opts.hiddenEnabled){ decoyPlaintext = opts.decoyText || '(sin contenido señuelo)'; decoyPass = opts.decoyPass; }
  else { decoyPlaintext = opts.secretText; decoyPass = opts.realPass; }
  const decoyContext = opts.hiddenEnabled ? 'decoy' : 'real';
  const decoyKey = useArgon2
    ? await deriveKeyV2Argon2id(decoyPass, salt, decoyContext)
    : await deriveKey(decoyPass, salt, decoyContext);
  const decoyEnc = await encryptFixedSlotWithKey(decoyPlaintext, decoyKey, slotLen);
  payload.set(decoyEnc.iv, decoyOffset);
  payload[decoyOffset+12]=(decoyEnc.ciphertext.length>>8)&0xff;
  payload[decoyOffset+13]=decoyEnc.ciphertext.length&0xff;
  payload.set(decoyEnc.ciphertext, decoyOffset+14);
  if (opts.hiddenEnabled){
    const hiddenRegionStart = HEADER_SIZE + perSlotTotal;
    const hiddenRegionSize = usableCapacity - hiddenRegionStart;
    const hiddenSlotTotal = 12+2+(slotLen+16);
    const maxOffsetWithinRegion = Math.max(1, hiddenRegionSize - hiddenSlotTotal);
    const rel = await hmacOffset(opts.realPass, salt, maxOffsetWithinRegion);
    const hiddenOffset = hiddenRegionStart + rel;
    const hiddenKey = useArgon2
      ? await deriveKeyV2Argon2id(opts.realPass, salt, 'real')
      : await deriveKey(opts.realPass, salt, 'real');
    const hiddenEnc = await encryptFixedSlotWithKey(opts.secretText, hiddenKey, slotLen);
    payload.set(hiddenEnc.iv, hiddenOffset);
    payload[hiddenOffset+12]=(hiddenEnc.ciphertext.length>>8)&0xff;
    payload[hiddenOffset+13]=hiddenEnc.ciphertext.length&0xff;
    payload.set(hiddenEnc.ciphertext, hiddenOffset+14);
  }
  return { payload, usableCapacity, slotLen, grid: tierInfo.grid, parity, kdf: useArgon2 ? KDF_ARGON2ID : KDF_PBKDF2 };
}
/* Variantes de la frase tal como la escriben los TECLADOS MÓVILES: mayúscula
   inicial automática, espacio final al aceptar una sugerencia, dobles espacios,
   comillas/apóstrofes "inteligentes" (curvos) y composición Unicode distinta
   (NFC/NFD en acentos y ñ). El cubo se crea normalmente en el PC (frase limpia)
   y se descifra en el teléfono (frase alterada sin que el usuario lo vea): la
   frase "no coincide" aunque el usuario escribió lo correcto. Se prueba SIEMPRE
   la frase exacta primero (retrocompatible) y luego las variantes des-alteradas. */
function phraseVariants(passphrase){
  const out = [];
  const push = v => { if (v && !out.includes(v)) out.push(v); };
  const straight = s => s.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');
  const bases = [passphrase, passphrase.trim(), passphrase.trim().replace(/\s+/g, ' ')];
  for (const b of bases){
    for (const q of [b, straight(b)]){
      const deCap = q && q[0] !== q[0].toLowerCase() ? q[0].toLowerCase() + q.slice(1) : q;
      for (const c of [q, deCap]){ push(c); push(c.normalize('NFC')); }
    }
  }
  return out;
}
/** Descifra probando la frase EXACTA y, si falla, variantes que deshacen las
 * alteraciones típicas del teclado móvil. Devuelve además `usedPhrase` y
 * `phraseAdjusted` para que la UI pueda avisar de que el teclado alteró la frase. */
export async function tryDecryptPayload(payload, passphrase){
  const variants = phraseVariants(passphrase);
  let lastErr = null;
  for (const variant of variants){
    try{
      const result = await tryDecryptPayloadExact(payload, variant);
      result.usedPhrase = variant;
      result.phraseAdjusted = variant !== passphrase;
      return result;
    } catch(e){
      lastErr = e;
      if (e && e.code === 'bad-format') throw e; // el formato no depende de la frase
    }
  }
  throw lastErr || new Error('Frase incorrecta.');
}
export async function tryDecryptPayloadExact(payload, passphrase){
  const magicOk = payload[0]===MAGIC[0] && payload[1]===MAGIC[1] && payload[2]===MAGIC[2];
  if (!magicOk){
    const err = new Error('El cubo no es legible: formato no reconocido.');
    err.code = 'bad-format';
    throw err;
  }
  const hiddenEnabled = (payload[3] & FLAG_HIDDEN) !== 0;
  const useArgon2 = (payload[3] & FLAG_KDF_ARGON2ID) !== 0;
  if (useArgon2 && !isArgon2Available()){
    throw new Error('Este cubo requiere Argon2id, no disponible en este navegador.');
  }
  const kdf = useArgon2 ? KDF_ARGON2ID : KDF_PBKDF2;
  const deriveFn = useArgon2 ? deriveKeyV2Argon2id : deriveKey;
  const salt = payload.slice(4,20);
  const usableCapacity = payload.length;
  const usable = usableCapacity - HEADER_SIZE;
  const perSlotTotal = Math.floor(usable/2);
  try{
    const off = HEADER_SIZE;
    const iv = payload.slice(off, off+12);
    const len = (payload[off+12]<<8)|payload[off+13];
    const ciphertext = payload.slice(off+14, off+14+len);
    const key = await deriveFn(passphrase, salt, hiddenEnabled?'decoy':'real');
    const text = await decryptFixedSlotWithKey(iv, ciphertext, key);
    return { text, slot: hiddenEnabled?'decoy':'unico', kdf };
  } catch(_){}
  if (hiddenEnabled){
    try{
      const hiddenRegionStart = HEADER_SIZE + perSlotTotal;
      const hiddenRegionSize = usableCapacity - hiddenRegionStart;
      const hiddenSlotTotal = 12+2+((perSlotTotal-12-2-16)+16);
      const maxOffsetWithinRegion = Math.max(1, hiddenRegionSize - hiddenSlotTotal);
      const rel = await hmacOffset(passphrase, salt, maxOffsetWithinRegion);
      const off = hiddenRegionStart + rel;
      const iv = payload.slice(off, off+12);
      const len = (payload[off+12]<<8)|payload[off+13];
      const ciphertext = payload.slice(off+14, off+14+len);
      const key = await deriveFn(passphrase, salt, 'real');
      const text = await decryptFixedSlotWithKey(iv, ciphertext, key);
      return { text, slot:'oculto', kdf };
    } catch(_){}
  }
  const err = new Error('Frase incorrecta, o el cubo está dañado más allá de lo recuperable.');
  err.code = 'bad-phrase';
  throw err;
}
export function payloadToColorIndices(payload){
  const bits=[]; for (const byte of payload){ for(let i=7;i>=0;i--) bits.push((byte>>i)&1); }
  const usableBits = bits.length - (bits.length%3);
  const indices=[]; for(let i=0;i<usableBits;i+=3) indices.push((bits[i]<<2)|(bits[i+1]<<1)|bits[i+2]);
  return indices;
}
export function colorIndicesToPayload(indices, byteLength){
  const bits=[]; for(const idx of indices){ bits.push((idx>>2)&1,(idx>>1)&1, idx&1); }
  const out = new Uint8Array(byteLength);
  for(let b=0;b<byteLength;b++){ let byte=0; for(let i=0;i<8;i++) byte=(byte<<1)|(bits[b*8+i]||0); out[b]=byte; }
  return out;
}
export function hexToRgb(hex){ const v=hex.replace('#',''); return [parseInt(v.slice(0,2),16),parseInt(v.slice(2,4),16),parseInt(v.slice(4,6),16)]; }
export function nearestPaletteIndex(rgb){
  let best=0, bestDist=Infinity;
  for(let i=0;i<PALETTE.length;i++){ const [r,g,bl]=hexToRgb(PALETTE[i]); const d=(r-rgb[0])**2+(g-rgb[1])**2+(bl-rgb[2])**2; if(d<bestDist){bestDist=d; best=i;} }
  return best;
}

/* =========================================================
   REED-SOLOMON — corrección real de errores físicos (probado: 8/8 pruebas)
   ========================================================= */
const RSEXP = new Uint8Array(256), RSLOG = new Uint8Array(256);
(function initRS(){ let x=1; for(let i=0;i<255;i++){ RSEXP[i]=x; RSLOG[x]=i; x=x<<1; if(x&0x100) x^=0x11D; } RSEXP[255]=RSEXP[0]; })();
export function rsMul(a,b){ if(a===0||b===0) return 0; return RSEXP[(RSLOG[a]+RSLOG[b])%255]; }
export function rsDiv(a,b){ if(a===0) return 0; if(b===0) throw new Error('División por cero'); return RSEXP[(RSLOG[a]-RSLOG[b]+255)%255]; }
export function rsPow(a,n){ if(n===0) return 1; if(a===0) return 0; return RSEXP[(RSLOG[a]*((n%255+255)%255))%255]; }
export function rsInv(a){ return rsDiv(1,a); }
export function computeGenerator(degree){
  const result = new Uint8Array(degree); result[degree-1]=1;
  let root=2;
  for(let i=0;i<degree;i++){
    for(let j=0;j<result.length;j++){ result[j]=rsMul(result[j],root); if(j+1<result.length) result[j]^=result[j+1]; }
    root = rsMul(root,2);
  }
  return result;
}
export function computeRemainder(data, divisor){
  let result = new Uint8Array(divisor.length);
  for (const b of data){
    const factor = b ^ result[0];
    const next = new Uint8Array(divisor.length);
    for (let i=0;i<divisor.length-1;i++) next[i]=result[i+1];
    for (let i=0;i<divisor.length;i++) next[i]^=rsMul(divisor[i],factor);
    result = next;
  }
  return result;
}
export function rsEncodeBlock(data, parity){
  const divisor = computeGenerator(parity);
  const remainder = computeRemainder(data, divisor);
  const out = new Uint8Array(data.length+parity);
  out.set(data,0); out.set(remainder, data.length);
  return out;
}
export function rsEvalPoly(coeffsMsbFirst, x){ let result=0; for(const c of coeffsMsbFirst) result=rsMul(result,x)^c; return result; }
export function rsSolveGF(M,v){
  const e=M.length; const A=M.map((row,i)=>[...row,v[i]]);
  for(let col=0;col<e;col++){
    let pivot=-1; for(let r=col;r<e;r++) if(A[r][col]!==0){pivot=r;break;}
    if(pivot===-1) return null;
    [A[col],A[pivot]]=[A[pivot],A[col]];
    const inv=rsInv(A[col][col]);
    for(let c=col;c<=e;c++) A[col][c]=rsMul(A[col][c],inv);
    for(let r=0;r<e;r++){ if(r===col) continue; const factor=A[r][col]; if(factor===0) continue; for(let c=col;c<=e;c++) A[r][c]^=rsMul(factor,A[col][c]); }
  }
  return A.map(row=>row[e]);
}
export function rsDecodeBlock(received, k, parity){
  const n = k+parity, t = Math.floor(parity/2);
  const syndromes = []; for(let j=1;j<=parity;j++) syndromes.push(rsEvalPoly(received, rsPow(2,j)));
  if (syndromes.every(s=>s===0)) return { data: received.slice(0,k), corrected:0, success:true };
  for (let e=t;e>=1;e--){
    const M=[]; for(let i=1;i<=e;i++){ const row=[]; for(let j=1;j<=e;j++) row.push(syndromes[i+e-j-1]); M.push(row); }
    const v=[]; for(let i=1;i<=e;i++) v.push(syndromes[i+e-1]);
    const lambda = rsSolveGF(M,v);
    if (!lambda) continue;
    const lambdaPoly = [...lambda.slice().reverse(), 1];
    const errorPositions = [];
    for (let l=0;l<n;l++){ const x=rsPow(2,-l); if (rsEvalPoly(lambdaPoly,x)===0) errorPositions.push(l); }
    if (errorPositions.length !== e) continue;
    const corrected = new Uint8Array(received);
    let allOk = true;
    for (const l of errorPositions){
      const xInv = rsPow(2,-l);
      const sLSB = syndromes.slice(0,parity);
      const lamLSB = [1, ...lambda];
      const omegaCoeffs = new Array(parity).fill(0);
      for (let i=0;i<sLSB.length;i++) for(let j=0;j<lamLSB.length;j++) if(i+j<parity) omegaCoeffs[i+j]^=rsMul(sLSB[i],lamLSB[j]);
      let omegaVal=0, xPow=1; for(let d=0;d<omegaCoeffs.length;d++){ omegaVal^=rsMul(omegaCoeffs[d],xPow); xPow=rsMul(xPow,xInv); }
      let lambdaDerivVal=0; xPow=1; for(let d=1;d<lamLSB.length;d+=2){ lambdaDerivVal^=rsMul(lamLSB[d],xPow); xPow=rsMul(xPow,rsMul(xInv,xInv)); }
      if (lambdaDerivVal===0){ allOk=false; break; }
      const magnitude = rsDiv(omegaVal, lambdaDerivVal);
      corrected[n-1-l] ^= magnitude;
    }
    if (!allOk) continue;
    const checkSynd=[]; for(let j=1;j<=parity;j++) checkSynd.push(rsEvalPoly(corrected, rsPow(2,j)));
    if (checkSynd.every(s=>s===0)) return { data: corrected.slice(0,k), corrected:e, success:true };
  }
  return { data: received.slice(0,k), corrected:-1, success:false };
}
/** Decodifica un bloque RS por BORRONES (erasures): se le dan posiciones de byte
 * SOSPECHOSAS (donde se cree que la lectura está mal). Asumiendo que todos los
 * errores caen en esas posiciones, corrige hasta `parity` borrones — el DOBLE que
 * la corrección ciega (parity/2 errores). Es justo lo que hace falta para un
 * reflejo localizado que revienta varias celdas juntas. Verifica los síndromes al
 * final, así que una marca equivocada simplemente no valida y se descarta: nunca
 * produce una corrección falsa. erasurePositions: índices 0..n-1 dentro del bloque
 * (0 = primer byte = recibido[0]). */
export function rsDecodeBlockErasures(received, k, parity, erasurePositions){
  const n = k + parity;
  const erp = [...new Set(erasurePositions)].filter(p => p >= 0 && p < n);
  const f = erp.length;
  const syndromes = []; for (let j=1;j<=parity;j++) syndromes.push(rsEvalPoly(received, rsPow(2,j)));
  if (syndromes.every(s=>s===0)) return { data: received.slice(0,k), corrected:0, success:true };
  if (f === 0 || f > parity) return { data: received.slice(0,k), corrected:-1, success:false };
  // Localizador de cada borrón: para el byte en índice `pos` (MSB-first), X = α^(n-1-pos).
  const X = erp.map(pos => rsPow(2, n-1-pos));
  // Sistema lineal (Vandermonde, invertible porque los X_i son distintos y ≠0):
  // para r=1..f, Σ_i Y_i·X_i^r = S_r. Se resuelven las magnitudes Y_i.
  const M = [], v = [];
  for (let r=1;r<=f;r++){ const row=[]; for (let i=0;i<f;i++) row.push(rsPow(X[i], r)); M.push(row); v.push(syndromes[r-1]); }
  const Y = rsSolveGF(M, v);
  if (!Y) return { data: received.slice(0,k), corrected:-1, success:false };
  const corrected = new Uint8Array(received);
  for (let i=0;i<f;i++) corrected[erp[i]] ^= Y[i];
  const check=[]; for (let j=1;j<=parity;j++) check.push(rsEvalPoly(corrected, rsPow(2,j)));
  if (check.every(s=>s===0)) return { data: corrected.slice(0,k), corrected:f, success:true };
  return { data: received.slice(0,k), corrected:-1, success:false };
}

/** Como rsDecodeRawToPayload, pero si un bloque falla la corrección ciega lo
 * reintenta por BORRONES con `byteSuspicion` (sospecha por byte del flujo raw;
 * 0 = no sospechoso, mayor = más probable que esté mal leído). Por bloque, marca
 * como borrón los bytes sospechosos en cantidad CRECIENTE hasta que Reed-Solomon
 * valide. Recupera defectos localizados (reflejo) que la corrección ciega no
 * alcanza, sin cambiar el formato.
 *
 * SEGURIDAD (clave para no inventar descifrados): las posiciones son ADIVINADAS,
 * así que se topan en `parity-2` borrones para dejar ≥2 síndromes de validación.
 * Con `parity` borrones exactos el sistema anula TODOS los síndromes por
 * construcción → la verificación sería vacía y "validaría" cualquier basura. Con 2
 * síndromes libres, una marca equivocada se delata (prob. de falso positivo
 * ~1/65536 por intento, y además solo se marcan bytes que superaron el umbral de
 * sospecha, que en una lectura limpia no marca nada). */
export function rsDecodeRawWithErasures(raw, grid, parity, byteSuspicion){
  const { raw:rawLen, numBlocks, usable, k } = effectiveCapacityForGrid(grid, parity);
  if (raw.length !== rawLen) throw new Error('La imagen no corresponde a esta capacidad seleccionada.');
  const maxMarks = Math.max(1, parity - 2);
  const payload = new Uint8Array(usable);
  let totalCorrected = 0;
  for (let i=0;i<numBlocks;i++){
    const block = raw.slice(i*RS_N, (i+1)*RS_N);
    let res = rsDecodeBlock(block, k, parity); // primero la corrección ciega probada
    if (!res.success){
      const cands = [];
      for (let p=0;p<RS_N;p++){ const s = byteSuspicion[i*RS_N+p] || 0; if (s > 0) cands.push([s, p]); }
      cands.sort((a,b)=>b[0]-a[0]); // más sospechosos primero
      const limit = Math.min(cands.length, maxMarks);
      for (let nMark=1; nMark<=limit && !res.success; nMark++){
        const er = rsDecodeBlockErasures(block, k, parity, cands.slice(0,nMark).map(o=>o[1]));
        if (er.success) res = er;
      }
    }
    if (!res.success) throw new Error(`El cubo está demasiado dañado para recuperarse (bloque ${i+1} de ${numBlocks} con más errores de los corregibles).`);
    if (res.corrected>0) totalCorrected += res.corrected;
    payload.set(res.data, i*k);
  }
  return { payload, totalCorrected };
}

export function rsEncodePayloadToRaw(payload, grid, parity = RS_PARITY){
  const {raw,numBlocks,usable,k} = effectiveCapacityForGrid(grid, parity);
  if (payload.length !== usable) throw new Error('Tamaño de payload inesperado para este grid.');
  const out = new Uint8Array(raw);
  out.set(randomBytes(raw), 0);
  for (let i=0;i<numBlocks;i++){
    const block = payload.slice(i*k, (i+1)*k);
    out.set(rsEncodeBlock(block, parity), i*RS_N);
  }
  return out;
}
export function rsDecodeRawToPayload(raw, grid, parity = RS_PARITY){
  const {raw:rawLen, numBlocks, usable, k} = effectiveCapacityForGrid(grid, parity);
  if (raw.length !== rawLen) throw new Error('La imagen no corresponde a esta capacidad seleccionada.');
  const payload = new Uint8Array(usable);
  let totalCorrected = 0;
  for (let i=0;i<numBlocks;i++){
    const block = raw.slice(i*RS_N, (i+1)*RS_N);
    const res = rsDecodeBlock(block, k, parity);
    if (!res.success) throw new Error(`El cubo está demasiado dañado para recuperarse (bloque ${i+1} de ${numBlocks} con más errores de los corregibles).`);
    if (res.corrected>0) totalCorrected += res.corrected;
    payload.set(res.data, i*k);
  }
  return { payload, totalCorrected };
}

/* =========================================================
   HOMOGRAFÍA — corrección de perspectiva (probado: 5/5 pruebas)
   ========================================================= */
export function solveLinear(A,b){
  const n=A.length; const M=A.map((row,i)=>[...row,b[i]]);
  for(let col=0;col<n;col++){
    let pivot=col; for(let r=col+1;r<n;r++) if(Math.abs(M[r][col])>Math.abs(M[pivot][col])) pivot=r;
    [M[col],M[pivot]]=[M[pivot],M[col]];
    if(Math.abs(M[col][col])<1e-9) throw new Error('Las 4 esquinas no forman un cuadrilátero válido.');
    for(let r=0;r<n;r++){ if(r===col) continue; const factor=M[r][col]/M[col][col]; for(let c=col;c<=n;c++) M[r][c]-=factor*M[col][c]; }
  }
  return M.map((row,i)=>row[n]/row[i]);
}
export function computeHomography(src,dst){
  const A=[],b=[];
  for(let i=0;i<4;i++){
    const [x,y]=src[i], [xp,yp]=dst[i];
    A.push([x,y,1,0,0,0,-x*xp,-y*xp]); b.push(xp);
    A.push([0,0,0,x,y,1,-x*yp,-y*yp]); b.push(yp);
  }
  return [...solveLinear(A,b), 1];
}
export function applyHomography(H,x,y){
  const [a,b,c,d,e,f,g,h,i]=H;
  const denom = g*x+h*y+i;
  return [(a*x+b*y+c)/denom, (d*x+e*y+f)/denom];
}

/* =========================================================
   DIBUJO / LECTURA DEL CUBO
   ========================================================= */
export const FACE_ORDER = ['top','left','front','right','back','bottom'];
export const FACE_SLOTS = { top:[1,0], left:[0,1], front:[1,1], right:[2,1], back:[3,1], bottom:[1,2] };
export const FACE_LABELS = { top:'ARRIBA', left:'IZQ', front:'FRENTE', right:'DER', back:'ATRÁS', bottom:'ABAJO' };
export const FACE_PX_TARGET = 200;

export function geometryForGrid(grid){
  const cellPx = Math.max(1, Math.floor(FACE_PX_TARGET/grid));
  const faceSize = cellPx*grid;
  const gap=7, margin=22, labelH=14;
  const width = margin*2 + 4*faceSize + 3*gap;
  const height = margin*2 + labelH*3 + 3*faceSize + 2*gap;
  return { cellPx, faceSize, gap, margin, labelH, width, height };
}
export function drawCubeNet(canvas, colorIndices, grid){
  const geo = geometryForGrid(grid);
  canvas.width=geo.width; canvas.height=geo.height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle='#ffffff'; ctx.fillRect(0,0,geo.width,geo.height);
  let idx=0;
  for (const face of FACE_ORDER){
    const [col,row]=FACE_SLOTS[face];
    const x=geo.margin+col*(geo.faceSize+geo.gap);
    const y=geo.margin+geo.labelH+row*(geo.faceSize+geo.gap+geo.labelH);
    ctx.fillStyle='#0A0A0A'; ctx.font='600 9px monospace'; ctx.fillText(FACE_LABELS[face], x, y-4);
    for(let r=0;r<grid;r++) for(let c=0;c<grid;c++){
      const colorIdx = colorIndices[idx++] || 0;
      ctx.fillStyle = PALETTE[colorIdx];
      ctx.fillRect(x+c*geo.cellPx, y+r*geo.cellPx, geo.cellPx, geo.cellPx);
    }
    ctx.strokeStyle='#0A0A0A'; ctx.lineWidth=1.3; ctx.strokeRect(x,y,geo.faceSize,geo.faceSize);
  }
  return geo;
}
/** Lectura directa (sin homografía) — usada para PNGs exactos y partes Shamir. */
export function readColorIndicesFromImage(img, grid){
  const geo = geometryForGrid(grid);
  const off = document.createElement('canvas'); off.width=geo.width; off.height=geo.height;
  const ctx = off.getContext('2d'); ctx.drawImage(img,0,0,geo.width,geo.height);
  const indices=[];
  for (const face of FACE_ORDER){
    const [col,row]=FACE_SLOTS[face];
    const x=geo.margin+col*(geo.faceSize+geo.gap);
    const y=geo.margin+geo.labelH+row*(geo.faceSize+geo.gap+geo.labelH);
    for(let r=0;r<grid;r++) for(let c=0;c<grid;c++){
      const px=Math.min(geo.width-1, Math.floor(x+c*geo.cellPx+geo.cellPx/2));
      const py=Math.min(geo.height-1, Math.floor(y+r*geo.cellPx+geo.cellPx/2));
      const data = ctx.getImageData(px,py,1,1).data;
      indices.push(nearestPaletteIndex([data[0],data[1],data[2]]));
    }
  }
  return indices;
}
export function detectTierFromImageDimensions(img){
  const tolerance = 2;
  for (const [tier, info] of Object.entries(TIERS)){
    const geo = geometryForGrid(info.grid);
    if (Math.abs(img.naturalWidth-geo.width)<=tolerance && Math.abs(img.naturalHeight-geo.height)<=tolerance) return tier;
  }
  return null;
}
/** Lectura vía homografía — usada para fotos reales con las 4 esquinas calibradas. */
export function readColorIndicesViaHomography(photoCtx, photoW, photoH, corners, grid){
  const geo = geometryForGrid(grid);
  const canonical = [[0,0],[geo.width,0],[geo.width,geo.height],[0,geo.height]];
  const H = computeHomography(canonical, corners);
  const indices=[];
  for (const face of FACE_ORDER){
    const [col,row]=FACE_SLOTS[face];
    const x=geo.margin+col*(geo.faceSize+geo.gap);
    const y=geo.margin+geo.labelH+row*(geo.faceSize+geo.gap+geo.labelH);
    for(let r=0;r<grid;r++) for(let c=0;c<grid;c++){
      const cx = x+c*geo.cellPx+geo.cellPx/2;
      const cy = y+r*geo.cellPx+geo.cellPx/2;
      let [px,py] = applyHomography(H, cx, cy);
      px = Math.max(0, Math.min(photoW-1, Math.round(px)));
      py = Math.max(0, Math.min(photoH-1, Math.round(py)));
      const data = photoCtx.getImageData(px,py,1,1).data;
      indices.push(nearestPaletteIndex([data[0],data[1],data[2]]));
    }
  }
  return indices;
}
export const SHARE_GRID = 12;
export function shareToPayload(index, valueBytes){
  const capacity = capacityBytesForGrid(SHARE_GRID);
  const payload = new Uint8Array(capacity);
  payload.set(randomBytes(capacity),0);
  payload[0]=index; payload[1]=(valueBytes.length>>8)&0xff; payload[2]=valueBytes.length&0xff;
  payload.set(valueBytes,3);
  return payload;
}
export function payloadToShare(payload){
  const index=payload[0]; const len=(payload[1]<<8)|payload[2];
  return { index, bytes: payload.slice(3,3+len) };
}

/* =========================================================
   SHAMIR — GF(256) (probado: 9/9 pruebas)
   ========================================================= */
export function gfMulSh(a,b){ return rsMul(a,b); }
export function gfDivSh(a,b){ return rsDiv(a,b); }
export function gfPowSh(a,n){ return rsPow(a,n); }
export function splitSecret(secretBytes,n,k){
  if(k>n) throw new Error('K no puede ser mayor que N.');
  if(n>254) throw new Error('Máximo 254 partes soportadas.');
  if(k<2) throw new Error('K debe ser al menos 2.');
  const shares=[]; for(let i=1;i<=n;i++) shares.push({index:i, bytes:new Uint8Array(secretBytes.length)});
  for(let byteIdx=0;byteIdx<secretBytes.length;byteIdx++){
    const coeffs=new Uint8Array(k); coeffs[0]=secretBytes[byteIdx];
    const rnd=new Uint8Array(k-1); crypto.getRandomValues(rnd);
    for(let j=1;j<k;j++) coeffs[j]=rnd[j-1];
    for(let s=0;s<n;s++){ const x=shares[s].index; let y=0; for(let j=0;j<k;j++) y^=gfMulSh(coeffs[j], gfPowSh(x,j)); shares[s].bytes[byteIdx]=y; }
  }
  return shares;
}
export function reconstructSecret(shares){
  if(shares.length<2) throw new Error('Se necesitan al menos 2 partes.');
  const len=shares[0].bytes.length; const out=new Uint8Array(len);
  for(let byteIdx=0;byteIdx<len;byteIdx++){
    let result=0;
    for(let i=0;i<shares.length;i++){
      const xi=shares[i].index, yi=shares[i].bytes[byteIdx];
      let numerator=1, denominator=1;
      for(let j=0;j<shares.length;j++){ if(i===j) continue; const xj=shares[j].index; numerator=gfMulSh(numerator,xj); denominator=gfMulSh(denominator, xi^xj); }
      result ^= gfMulSh(yi, gfDivSh(numerator,denominator));
    }
    out[byteIdx]=result;
  }
  return out;
}
export const SHAMIR_MAGIC = new Uint8Array([0x53,0x48,0x4D,0x31]);

/* =========================================================
   EMPAQUETADO DE ARCHIVOS ADJUNTOS — convención de formato
   usada dentro del texto cifrado. Crítico para compatibilidad:
   cubos generados con archivos adjuntos solo se desempaquetan
   correctamente si este prefijo/formato no cambia.
   ========================================================= */
export const FILE_PAYLOAD_PREFIX = 'CIPHERCUBE_FILES_V1:';
export function composeSecretPayload(secretText, files){
  if (!files.length) return secretText;
  return FILE_PAYLOAD_PREFIX + JSON.stringify({
    text: secretText,
    files: files.map(f => ({ name:f.name, type:f.type, size:f.size, data:f.data }))
  });
}
export function parseDecodedPayload(text){
  if (!text.startsWith(FILE_PAYLOAD_PREFIX)) return { text, files: [] };
  try{
    const parsed = JSON.parse(text.slice(FILE_PAYLOAD_PREFIX.length));
    return { text: parsed.text || '', files: Array.isArray(parsed.files) ? parsed.files : [] };
  } catch(_){
    return { text, files: [] };
  }
}
export function dataUrlForFileEntry(file){
  const type = file.type || 'application/octet-stream';
  return `data:${type};base64,${file.data}`;
}
