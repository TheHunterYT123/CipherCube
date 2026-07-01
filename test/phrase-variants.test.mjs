// Regresión del hallazgo "el cubo se lee bien pero NUNCA descifra": el cubo se
// crea en el PC (frase limpia) y se descifra en el TELÉFONO, cuyo teclado altera
// la frase sin que el usuario lo vea — mayúscula inicial automática, espacio final
// al aceptar una sugerencia, doble espacio, apóstrofes "inteligentes" (curvos) y
// composición Unicode distinta (NFC/NFD en acentos/ñ). Como el mensaje de error
// decía "frase incorrecta O CUBO DAÑADO", el fallo se atribuía al escáner.
//
// tryDecryptPayload ahora prueba la frase EXACTA primero (retrocompatible) y
// luego variantes que deshacen esas alteraciones. Ejecutar:
//   node test/phrase-variants.test.mjs
import assert from 'node:assert/strict';
globalThis.window = globalThis;
globalThis.document = { createElement(){ return {}; }, head:{ appendChild(){} } };

const { buildPayload, tryDecryptPayload } = await import('../js/crypto.js');

let passed = 0, failed = 0;
async function test(name, fn){
  try{ await fn(); console.log(`OK   ${name}`); passed++; }
  catch(e){ console.error(`FAIL ${name}\n     ${e.message}`); failed++; }
}

const SECRET = 'mi secreto de prueba';
async function build(realPass, extra = {}){
  const { payload } = await buildPayload({ secretText: SECRET, realPass, hiddenEnabled: false, tier: 'mini', ...extra });
  return payload;
}

await test('frase exacta descifra y NO se marca como ajustada', async () => {
  const payload = await build('correcto caballo bateria');
  const r = await tryDecryptPayload(payload, 'correcto caballo bateria');
  assert.equal(r.text, SECRET);
  assert.equal(r.phraseAdjusted, false);
});

await test('mayúscula inicial automática del teclado móvil descifra igual', async () => {
  const payload = await build('correcto caballo bateria');
  const r = await tryDecryptPayload(payload, 'Correcto caballo bateria');
  assert.equal(r.text, SECRET);
  assert.equal(r.phraseAdjusted, true);
});

await test('espacio final del autocompletado + mayúscula inicial descifra igual', async () => {
  const payload = await build('correcto caballo bateria');
  const r = await tryDecryptPayload(payload, 'Correcto caballo bateria ');
  assert.equal(r.text, SECRET);
});

await test('doble espacio interno (sugerencias del teclado) descifra igual', async () => {
  const payload = await build('correcto caballo bateria');
  const r = await tryDecryptPayload(payload, 'correcto  caballo bateria');
  assert.equal(r.text, SECRET);
});

await test('acentos en NFD (teclado/SO distinto) descifran un cubo creado en NFC', async () => {
  const nfc = 'contraseña con acción'.normalize('NFC');
  const nfd = 'contraseña con acción'.normalize('NFD');
  assert.notEqual(nfc, nfd); // sanity: son bytes distintos
  const payload = await build(nfc);
  const r = await tryDecryptPayload(payload, nfd);
  assert.equal(r.text, SECRET);
});

await test('apóstrofe "inteligente" (curvo, iOS) descifra un cubo creado con apóstrofe recto', async () => {
  const payload = await build("l'aigua d'estiu");
  const r = await tryDecryptPayload(payload, 'l’aigua d’estiu');
  assert.equal(r.text, SECRET);
});

await test('una frase GENUINAMENTE distinta sigue fallando (sin falsos positivos)', async () => {
  const payload = await build('correcto caballo bateria');
  await assert.rejects(() => tryDecryptPayload(payload, 'otra frase cualquiera'), e => e.code === 'bad-phrase');
});

await test('capitalización a mitad de frase NO se "corrige" (solo la inicial del teclado)', async () => {
  const payload = await build('correcto caballo bateria');
  await assert.rejects(() => tryDecryptPayload(payload, 'correcto Caballo bateria'), e => e.code === 'bad-phrase');
});

await test('volumen oculto: la frase REAL alterada por el teclado sigue abriendo el secreto real', async () => {
  const { payload } = await buildPayload({
    secretText: SECRET, realPass: 'frase real secreta', hiddenEnabled: true,
    decoyPass: 'frase senuelo publica', decoyText: 'nada que ver aqui', tier: 'mini',
  });
  const r = await tryDecryptPayload(payload, 'Frase real secreta ');
  assert.equal(r.text, SECRET);
  assert.equal(r.slot, 'oculto');
  const d = await tryDecryptPayload(payload, 'Frase senuelo publica');
  assert.equal(d.text, 'nada que ver aqui');
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
if (failed) process.exit(1);
