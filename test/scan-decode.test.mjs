// Prueba de extremo a extremo del escaneo de cubo con la respuesta de color NO
// lineal de una cámara/pantalla (gamma + saturación + tinte). Usa las funciones
// REALES de producción: buildPayload → render de celdas → pintado canónico con
// distorsión → decodeCanonicalFaces (paleta fija y, si falla, clustering) →
// tryDecryptPayload. Reproduce el fallo "N de N bloques ilegibles" con el método
// congelado y verifica que el clustering adaptativo lo recupera.
//
// Ejecutar: node test/scan-decode.test.mjs
import assert from 'node:assert/strict';

globalThis.window = globalThis;
globalThis.document = { createElement(){ return {}; }, head:{ appendChild(){} } };

const crypto_ = await import('../js/crypto.js');
const cube = await import('../js/cube3d.js');
const { PALETTE, TIERS, buildPayload, tryDecryptPayload,
        rsEncodePayloadToRaw, payloadToColorIndices, RS_PARITY } = crypto_;

// --- Geometría de baldosa (copiada de cube3d.js; no exportada) ---
const F=0.07,B=0.10,G=0.03,DI=F+B+G, FINDER=0.075;
const FINDER_CENTERS=[[F+B/2,F+B/2],[1-F-B/2,F+B/2],[1-F-B/2,1-F-B/2],[F+B/2,1-F-B/2]];
const CANONICAL_DARK=[true,true,false,true];
const ID_BIT_X=[0.42,0.50,0.58], ID_BIT_Y=F+B/2;
const BLACK=[10,10,10], WHITE=[255,255,255];
const hexToRgb=h=>{const v=h.replace('#','');return[parseInt(v.slice(0,2),16),parseInt(v.slice(2,4),16),parseInt(v.slice(4,6),16)];};

function paint(cells, grid, faceIndex, size, colorFn=(c)=>c){
  const buf=new Uint8ClampedArray(size*size*4);
  const fill=(nx,ny,nw,nh,rgb)=>{
    const x0=Math.max(0,Math.round(nx*size)),x1=Math.min(size,Math.round((nx+nw)*size));
    const y0=Math.max(0,Math.round(ny*size)),y1=Math.min(size,Math.round((ny+nh)*size));
    const cc=colorFn(rgb);
    for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){const i=(y*size+x)*4;buf[i]=cc[0];buf[i+1]=cc[1];buf[i+2]=cc[2];buf[i+3]=255;}
  };
  fill(0,0,1,1,WHITE);fill(0,0,1,F,BLACK);fill(0,1-F,1,F,BLACK);fill(0,0,F,1,BLACK);fill(1-F,0,F,1,BLACK);
  FINDER_CENTERS.forEach(([cx,cy],i)=>{if(CANONICAL_DARK[i])fill(cx-FINDER/2,cy-FINDER/2,FINDER,FINDER,BLACK);});
  for(let b=0;b<3;b++){const bit=(faceIndex>>(2-b))&1;const s=FINDER*0.7;fill(ID_BIT_X[b]-s/2,ID_BIT_Y-s/2,s,s,bit?BLACK:WHITE);}
  const span=1-2*DI,cN=span/grid;let idx=0;
  for(let r=0;r<grid;r++)for(let c=0;c<grid;c++) fill(DI+c*cN,DI+r*cN,cN,cN,hexToRgb(PALETTE[cells[idx++]]));
  return {data:buf,size};
}
const gamma=g=>rgb=>rgb.map(v=>255*Math.pow(v/255,g));
const sat=s=>rgb=>{const m=(rgb[0]+rgb[1]+rgb[2])/3;return rgb.map(v=>Math.max(0,Math.min(255,m+(v-m)*s)));};
const warm=rgb=>[Math.min(255,rgb[0]*1.08),rgb[1]*0.98,rgb[2]*0.9];
const compose=(...fns)=>rgb=>fns.reduce((a,fn)=>fn(a),rgb);

// Construye las 6 caras canónicas (con distorsión) de un cubo recién generado.
async function makeCube(tier, secret, pass, colorFn){
  const built = await buildPayload({ secretText: secret, realPass: pass, hiddenEnabled:false, tier });
  const grid = TIERS[tier].grid;
  const raw = rsEncodePayloadToRaw(built.payload, grid, built.parity);
  const indices = payloadToColorIndices(raw);
  const canonByFace = {};
  for (let f=0; f<6; f++){
    const cells = cube.faceSliceFromColorIndices(indices, grid, f);
    canonByFace[f] = paint(cells, grid, f, 600, colorFn);
  }
  return { canonByFace, parity: built.parity };
}

let passed=0, failed=0;
async function test(name, fn){ try{ await fn(); console.log(`OK   ${name}`); passed++; } catch(e){ console.error(`FAIL ${name}\n     ${e.message}`); failed++; } }

const SECRET='clave-secreta-de-prueba-123', PASS='mi-frase-larga-y-segura';

await test('cubo SIN distorsión: el método congelado (paleta fija) descifra', async () => {
  const { canonByFace } = await makeCube('mini', SECRET, PASS, c=>c);
  const { payload } = cube.decodeCanonicalFaces(canonByFace, TIERS);
  const res = await tryDecryptPayload(payload, PASS);
  assert.equal(res.text, SECRET);
});

await test('cubo con GAMMA (cámara): el método congelado FALLA por color', async () => {
  const { canonByFace, parity } = await makeCube('mini', SECRET, PASS, gamma(1.8));
  // Simula el camino "solo congelado" llamando directo a la lectura de paleta fija.
  const grid = TIERS.mini.grid;
  const facesByIndex = {};
  for (let f=0; f<6; f++) facesByIndex[f] = cube.sampleFaceCells(canonByFace[f], grid);
  assert.throws(() => cube.facesToPayload(facesByIndex, grid, parity),
    /demasiado dañado/);
});

await test('cubo con GAMMA (cámara): decodeCanonicalFaces lo recupera por clustering', async () => {
  const { canonByFace } = await makeCube('mini', SECRET, PASS, gamma(1.8));
  const { payload } = cube.decodeCanonicalFaces(canonByFace, TIERS);
  const res = await tryDecryptPayload(payload, PASS);
  assert.equal(res.text, SECRET);
});

await test('cubo con GAMMA + saturación + luz cálida: se recupera', async () => {
  const { canonByFace } = await makeCube('mini', SECRET, PASS, compose(gamma(0.6), sat(1.35), warm));
  const { payload } = cube.decodeCanonicalFaces(canonByFace, TIERS);
  const res = await tryDecryptPayload(payload, PASS);
  assert.equal(res.text, SECRET);
});

await test('nivel Estándar con gamma fuerte: se recupera', async () => {
  const { canonByFace } = await makeCube('estandar', SECRET, PASS, compose(gamma(2.0), sat(1.2)));
  const { payload } = cube.decodeCanonicalFaces(canonByFace, TIERS);
  const res = await tryDecryptPayload(payload, PASS);
  assert.equal(res.text, SECRET);
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
if (failed>0) process.exitCode = 1;
