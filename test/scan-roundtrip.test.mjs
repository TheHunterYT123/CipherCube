// Diagnóstico del lector de caras: ¿el pipeline de LECTURA (sampleFaceCells)
// recupera las celdas de color de una cara PERFECTA (como saldría de un warp
// ideal de cámara, sin ruido)? Si esto falla, el bug está en el código de
// lectura, no en la luz/impresora/cámara.
//
// Ejecutar con: node test/scan-roundtrip.test.mjs
import assert from 'node:assert/strict';

globalThis.window = globalThis;
globalThis.document = { createElement(){ return {}; }, head:{ appendChild(){} } };

const { PALETTE, TIERS } = await import('../js/crypto.js');
const cube = await import('../js/cube3d.js');

// --- Constantes geométricas, copiadas de cube3d.js (no están exportadas) ---
const F = 0.07, B = 0.10, G = 0.03, DI = F + B + G;
const FINDER = 0.075;
const FINDER_CENTERS = [
  [F + B/2, F + B/2], [1 - F - B/2, F + B/2],
  [1 - F - B/2, 1 - F - B/2], [F + B/2, 1 - F - B/2],
];
const CANONICAL_DARK = [true, true, false, true];
const ID_BIT_X = [0.42, 0.50, 0.58], ID_BIT_Y = F + B/2;
const BLACK = [10,10,10], WHITE = [255,255,255];

function hexToRgb(hex){ const v=hex.replace('#',''); return [parseInt(v.slice(0,2),16),parseInt(v.slice(2,4),16),parseInt(v.slice(4,6),16)]; }

/** Pinta una cara canónica (RGBA) replicando EXACTAMENTE drawFaceTileV2. */
function paintCanonical(cells, grid, faceIndex, size){
  const buf = new Uint8ClampedArray(size*size*4);
  const fill = (nx,ny,nw,nh,rgb) => {
    const x0=Math.max(0,Math.round(nx*size)), x1=Math.min(size,Math.round((nx+nw)*size));
    const y0=Math.max(0,Math.round(ny*size)), y1=Math.min(size,Math.round((ny+nh)*size));
    for(let y=y0;y<y1;y++) for(let x=x0;x<x1;x++){ const i=(y*size+x)*4; buf[i]=rgb[0];buf[i+1]=rgb[1];buf[i+2]=rgb[2];buf[i+3]=255; }
  };
  fill(0,0,1,1,WHITE);                       // fondo blanco
  fill(0,0,1,F,BLACK); fill(0,1-F,1,F,BLACK); // marco arriba/abajo
  fill(0,0,F,1,BLACK); fill(1-F,0,F,1,BLACK); // marco izq/der
  FINDER_CENTERS.forEach(([cx,cy],i)=>{ if(CANONICAL_DARK[i]) fill(cx-FINDER/2,cy-FINDER/2,FINDER,FINDER,BLACK); });
  for(let b=0;b<3;b++){ const bit=(faceIndex>>(2-b))&1; const s=FINDER*0.7; fill(ID_BIT_X[b]-s/2,ID_BIT_Y-s/2,s,s, bit?BLACK:WHITE); }
  const dataSpan = 1 - 2*DI, cellN = dataSpan/grid;
  let idx=0;
  for(let r=0;r<grid;r++) for(let c=0;c<grid;c++){
    fill(DI + c*cellN, DI + r*cellN, cellN, cellN, hexToRgb(PALETTE[cells[idx++]]));
  }
  return { data: buf, size };
}

function randCells(grid){ const n=grid*grid, a=new Array(n); for(let i=0;i<n;i++) a[i]=(Math.random()*8)|0; return a; }

let passed=0, failed=0;
function test(name, fn){ try{ fn(); console.log(`OK   ${name}`); passed++; } catch(e){ console.error(`FAIL ${name}\n     ${e.message}`); failed++; } }

// --- Test 1: lectura pixel-perfect de una cara, por cada nivel ---
for (const [tierKey, info] of Object.entries(TIERS)){
  test(`lectura pixel-perfect recupera 100% de celdas — ${info.label} (grid ${info.grid})`, () => {
    let totalCells=0, wrong=0;
    for(let f=0; f<6; f++){
      const cells = randCells(info.grid);
      const canon = paintCanonical(cells, info.grid, f, 600);
      const read = cube.sampleFaceCells(canon, info.grid);
      for(let i=0;i<cells.length;i++){ totalCells++; if(read[i]!==cells[i]) wrong++; }
    }
    const pct = (wrong/totalCells*100).toFixed(2);
    assert.equal(wrong, 0, `${wrong}/${totalCells} celdas mal leídas (${pct}%) en una cara PERFECTA`);
  });
}

console.log(`\n${passed} pasaron, ${failed} fallaron`);
if (failed>0) process.exitCode = 1;
