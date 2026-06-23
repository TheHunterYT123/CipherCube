'use strict';
/* =========================================================
   ARGON2-LOADER — carga diferida y no bloqueante de Argon2id.
   El archivo está auto-hospedado en vendor/ (no se descarga de
   ningún CDN en tiempo de ejecución): funciona sin internet y
   queda cubierto por el Service Worker como el resto del app shell.
   ========================================================= */
let available = false;
let loadPromise = null;

function loadScript(src){
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error('No se pudo cargar ' + src));
    document.head.appendChild(script);
  });
}

/** Inicia la carga de Argon2id en segundo plano. No bloquea el arranque
 * de la app: si falla o tarda, el resto de la UI sigue funcionando y
 * buildPayload cae de vuelta a PBKDF2 automáticamente. */
export function loadArgon2(){
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try{
      await loadScript('./vendor/argon2-bundled.min.js');
      const argon2 = window.argon2;
      if (!argon2 || typeof argon2.hash !== 'function') throw new Error('argon2 global no disponible');
      // Hash de prueba mínimo: confirma que el WASM realmente corre en este navegador.
      await argon2.hash({ pass: 'probe', salt: 'probeprobeprobe', type: argon2.ArgonType.Argon2id, time: 1, mem: 8, hashLen: 16 });
      available = true;
    } catch(_){
      available = false;
    }
    return available;
  })();
  return loadPromise;
}
export function isArgon2Available(){ return available; }
export function getArgon2(){ return window.argon2; }
