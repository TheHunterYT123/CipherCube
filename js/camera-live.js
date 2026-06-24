'use strict';
/* =========================================================
   CAMERA-LIVE — escaneo de cubo 3D cara por cara, en vivo.

   La cámara queda activa dentro del recuadro negro. El usuario coloca una
   cara dentro de la guía; cuando se detecta de forma estable, se captura
   sola, se muestra una animación para girar el cubo y se repite hasta tener
   las 6 caras.

   `createLiveScanner(config)` es una fábrica: cada instancia tiene su
   propio estado (cámara, caras capturadas, etc.), así pueden coexistir el
   escáner del cubo principal y el escáner de partes de la Bóveda sin
   pisarse. `config.onAction` recibe las 6 caras enderezadas y decide qué
   hacer (descifrar el cubo, o convertir una parte Shamir).
   ========================================================= */
import {
  FACE_LABELS, FACE_ORDER, TIERS, tryDecryptPayload, parseDecodedPayload, dataUrlForFileEntry,
} from './crypto.js';
import { detectTile, warpToCanonical, decodeCanonicalFaces, diagnoseCanonicalFaces, FACE_COUNT } from './cube3d.js';
import { showToast, showError } from './ui.js';

const SAMPLE_SIZE = 480;        // lado del lienzo cuadrado de muestreo
const GUIDE_INSET = 0.09;       // margen de la guía (coincide con el CSS .scan-frame)
const STABLE_NEEDED = 4;        // lecturas estables consecutivas antes de capturar
const DETECT_EVERY_MS = 110;    // periodicidad de detección
const ROTATE_PAUSE_MS = 1300;   // pausa con animación "gira el cubo"

function guideCorners(){
  const m = Math.round(SAMPLE_SIZE * GUIDE_INSET);
  const e = SAMPLE_SIZE - m;
  return [[m, m], [e, m], [e, e], [m, e]];
}

/**
 * Crea un escáner en vivo independiente.
 * config: {
 *   ids: { viewfinder, canvas, status, flash, rotate, completeBadge, progress, count,
 *          captureBtn, resetBtn, actionBtn, pass?, output?, reveal? },
 *   requiresPass: boolean (default true),
 *   busyLabel: string,
 *   labelComplete: string,
 *   labelIncomplete: (faltan) => string,
 *   resetAfterAction: boolean (default false),
 *   onAction: async (canonByFace, { pass }) => void,   // lanza Error en caso de fallo
 * }
 */
export function createLiveScanner(config){
  const requiresPass = config.requiresPass !== false;

  let els = null;
  let stream = null;
  let video = null;
  let cleanCanvas = null, cleanCtx = null;
  let rafId = null;
  let running = false;
  let paused = false;
  let lastDetect = 0;
  let stableFace = -1, stableCount = 0;
  let captured = {};

  function setStatus(text){ if (els.status) els.status.textContent = text; }

  function renderProgress(){
    els.progress.innerHTML = '';
    for (let f = 0; f < FACE_COUNT; f++){
      const dot = document.createElement('div');
      dot.className = 'face-dot' + (captured[f] ? ' done' : '');
      dot.textContent = captured[f] ? '✓' : (f + 1);
      dot.title = FACE_LABELS[FACE_ORDER[f]];
      els.progress.appendChild(dot);
    }
    const n = Object.keys(captured).length;
    els.count.textContent = `${n} / ${FACE_COUNT}`;
    const complete = n === FACE_COUNT;
    els.actionBtn.disabled = !complete;
    els.actionBtn.textContent = complete
      ? (config.labelComplete || 'Continuar')
      : (config.labelIncomplete ? config.labelIncomplete(FACE_COUNT - n) : `Continuar (faltan ${FACE_COUNT - n})`);
    els.viewfinder.classList.toggle('scan-done', complete);
    els.completeBadge.classList.toggle('show', complete);
  }

  function flash(){
    els.flash.classList.remove('show');
    void els.flash.offsetWidth; // reinicia la animación
    els.flash.classList.add('show');
  }
  /* Animación "tipo foto": congela lo que hay dentro de la guía, lo encoge y lo
     manda a una esquina del visor antes de desvanecerse. */
  function playCaptureAnimation(){
    const vf = els.viewfinder;
    if (!vf) return;
    const rect = vf.getBoundingClientRect();
    if (!rect.width) return;
    const inset = GUIDE_INSET;
    const gx = rect.width * inset, gy = rect.height * inset;
    const gw = rect.width * (1 - 2 * inset), gh = rect.height * (1 - 2 * inset);
    // Instantánea de la región dentro de la guía (del lienzo de muestreo, ya recortado).
    const m = Math.round(SAMPLE_SIZE * inset);
    const snap = document.createElement('canvas');
    snap.width = SAMPLE_SIZE - 2 * m; snap.height = SAMPLE_SIZE - 2 * m;
    snap.getContext('2d').drawImage(cleanCanvas, m, m, snap.width, snap.height, 0, 0, snap.width, snap.height);
    const fx = document.createElement('div');
    fx.className = 'capture-fx';
    fx.style.left = gx + 'px'; fx.style.top = gy + 'px';
    fx.style.width = gw + 'px'; fx.style.height = gh + 'px';
    fx.appendChild(snap);
    vf.appendChild(fx);
    // Destino: esquina superior derecha del visor, encogido.
    const scale = 0.16;
    const tx = (rect.width - 6 - (gw * scale) / 2) - (gx + gw / 2);
    const ty = (6 + (gh * scale) / 2) - (gy + gh / 2);
    requestAnimationFrame(() => {
      fx.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
      fx.classList.add('fly');
    });
    setTimeout(() => fx.remove(), 720);
  }
  function showRotateHint(){
    els.rotate.classList.add('show');
    setStatus('Capturada. Gira el cubo y muestra otra cara.');
    setTimeout(() => { els.rotate.classList.remove('show'); paused = false; if (running) setStatus('Buscando una cara…'); }, ROTATE_PAUSE_MS);
  }

  function captureFace(detection){
    const img = cleanCtx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    const canon = warpToCanonical(img.data, SAMPLE_SIZE, SAMPLE_SIZE, guideCorners(), detection.rotation);
    const isNew = !captured[detection.faceIndex];
    captured[detection.faceIndex] = canon;
    stableFace = -1; stableCount = 0;
    flash();
    playCaptureAnimation();
    renderProgress();
    if (Object.keys(captured).length === FACE_COUNT){
      setStatus('¡Listo! 6 caras capturadas.');
      showToast('6 / 6 caras capturadas.');
      return;
    }
    paused = true;
    showRotateHint();
    if (!isNew) showToast('Esa cara se actualizó.');
  }

  function tryDetectFrame(){
    const corners = guideCorners();
    const img = cleanCtx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    return detectTile(img.data, SAMPLE_SIZE, SAMPLE_SIZE, corners);
  }

  function loop(ts){
    if (!running) return;
    rafId = requestAnimationFrame(loop);
    if (!video || video.readyState < 2) return;
    // Recorte cuadrado centrado del video al lienzo de muestreo.
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    const s = Math.min(vw, vh);
    const sx = (vw - s) / 2, sy = (vh - s) / 2;
    cleanCtx.drawImage(video, sx, sy, s, s, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);

    if (paused) return;
    if (ts - lastDetect < DETECT_EVERY_MS) return;
    lastDetect = ts;

    const det = tryDetectFrame();
    if (!det.ok){ stableFace = -1; stableCount = 0; if (Object.keys(captured).length < FACE_COUNT) setStatus('Centra una cara del cubo en el recuadro.'); return; }
    if (captured[det.faceIndex]){ setStatus('Esa cara ya está. Muestra otra (o reescanéala con “Capturar ahora”).'); return; }
    if (det.faceIndex === stableFace){ stableCount++; } else { stableFace = det.faceIndex; stableCount = 1; }
    setStatus(`Detectando cara… manténla firme (${Math.min(stableCount, STABLE_NEEDED)}/${STABLE_NEEDED})`);
    if (stableCount >= STABLE_NEEDED) captureFace(det);
  }

  async function start(){
    if (running) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
      setStatus('Tu navegador no permite cámara aquí. Usa la opción de subir imagen.');
      els.viewfinder.classList.add('scan-error');
      return;
    }
    setStatus('Iniciando cámara…');
    try{
      // Pide buena resolución para que las celdas tengan suficientes píxeles al acercar.
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
    } catch(e){
      els.viewfinder.classList.add('scan-error');
      setStatus('No se pudo abrir la cámara (permiso denegado o sin cámara). Usa la opción de subir imagen.');
      return;
    }
    els.viewfinder.classList.remove('scan-error');
    // El <video> se muestra en el visor (algunos navegadores móviles, p. ej. iOS
    // Safari, no entregan frames si el video está fuera del DOM). El muestreo se
    // hace en un canvas oculto.
    video = document.createElement('video');
    video.className = 'live-video';
    video.setAttribute('playsinline', '');
    video.setAttribute('autoplay', '');
    video.muted = true; video.playsInline = true;
    video.srcObject = stream;
    els.viewfinder.insertBefore(video, els.canvas);
    await video.play().catch(() => {});
    // Autoenfoque continuo donde el dispositivo lo permita: al acercar la cámara a
    // la cara del cubo, evita el desenfoque que hacía casi imposible la detección.
    try{
      const track = stream.getVideoTracks()[0];
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      const adv = [];
      if (caps.focusMode && caps.focusMode.includes('continuous')) adv.push({ focusMode: 'continuous' });
      if (adv.length) await track.applyConstraints({ advanced: adv });
    } catch(_){ /* el dispositivo no expone control de enfoque; se usa el automático */ }
    running = true; paused = false;
    setStatus('Centra una cara del cubo en el recuadro.');
    rafId = requestAnimationFrame(loop);
  }

  function stop(){
    running = false;
    if (rafId){ cancelAnimationFrame(rafId); rafId = null; }
    if (stream){ stream.getTracks().forEach(t => t.stop()); stream = null; }
    if (video){ video.srcObject = null; if (video.parentNode) video.parentNode.removeChild(video); video = null; }
  }

  function resetScan(){
    captured = {};
    stableFace = -1; stableCount = 0; paused = false;
    if (els.output) els.output.classList.add('hidden');
    if (els.pass) els.pass.value = '';
    renderProgress();
    setStatus(running ? 'Centra una cara del cubo en el recuadro.' : 'Cámara detenida.');
  }

  async function runAction(){
    if (Object.keys(captured).length < FACE_COUNT){ showError('Faltan caras por capturar.'); return; }
    const pass = els.pass ? els.pass.value : null;
    if (requiresPass && !pass){ showError('Escribe tu frase.'); return; }
    const btn = els.actionBtn;
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> ${config.busyLabel || 'Procesando…'}`;
    try{
      await config.onAction({ ...captured }, { pass });
      if (config.resetAfterAction) resetScan();
    } catch(e){
      showError(e.message);
    } finally {
      btn.disabled = false;
      renderProgress();
    }
  }

  function init(){
    els = {
      viewfinder: document.getElementById(config.ids.viewfinder),
      canvas: document.getElementById(config.ids.canvas),
      status: document.getElementById(config.ids.status),
      flash: document.getElementById(config.ids.flash),
      rotate: document.getElementById(config.ids.rotate),
      completeBadge: document.getElementById(config.ids.completeBadge),
      progress: document.getElementById(config.ids.progress),
      count: document.getElementById(config.ids.count),
      captureBtn: document.getElementById(config.ids.captureBtn),
      resetBtn: document.getElementById(config.ids.resetBtn),
      actionBtn: document.getElementById(config.ids.actionBtn),
      pass: config.ids.pass ? document.getElementById(config.ids.pass) : null,
      output: config.ids.output ? document.getElementById(config.ids.output) : null,
      reveal: config.ids.reveal ? document.getElementById(config.ids.reveal) : null,
    };
    // Lienzo visible = lienzo de muestreo (sin overlay encima; las guías son DOM).
    els.canvas.width = SAMPLE_SIZE; els.canvas.height = SAMPLE_SIZE;
    cleanCanvas = els.canvas;
    cleanCtx = cleanCanvas.getContext('2d', { willReadFrequently: true });

    els.captureBtn.addEventListener('click', () => {
      if (!running){ showError('La cámara no está activa.'); return; }
      const det = tryDetectFrame();
      if (!det.ok){ showToast('No veo una cara válida; acércala y céntrala.'); return; }
      if (captured[det.faceIndex]) showToast('Recapturando esa cara.');
      paused = false; captureFace(det);
    });
    els.resetBtn.addEventListener('click', resetScan);
    els.actionBtn.addEventListener('click', runAction);
    renderProgress();
  }

  return {
    init, start, stop, reset: resetScan,
    isRunning: () => running,
    /** Para pruebas e integración: inyecta una cara ya enderezada. */
    injectCanonicalFace(faceIndex, canon){ captured[faceIndex] = canon; if (els) renderProgress(); },
  };
}

/* ---- Instancia lista para el escáner del cubo principal (pantalla Descifrar) ---- */

function renderCubeReveal(rawText, totalCorrected){
  const reveal = document.getElementById('liveDecodeReveal');
  const decoded = parseDecodedPayload(rawText);
  reveal.innerHTML = '';
  const textBlock = document.createElement('div');
  textBlock.textContent = decoded.text || (decoded.files.length ? '(sin texto, solo archivos adjuntos)' : '');
  reveal.appendChild(textBlock);
  if (decoded.files.length){
    const list = document.createElement('div');
    list.className = 'file-list';
    decoded.files.forEach(file => {
      const row = document.createElement('div'); row.className = 'file-item';
      const sizeKb = Math.max(1, Math.round((file.size || 0) / 1024));
      const name = document.createElement('span'); name.textContent = `${file.name || 'archivo'} · ${sizeKb} KB`;
      const link = document.createElement('a'); link.className = 'file-download';
      link.href = dataUrlForFileEntry(file); link.download = file.name || 'ciphercube-archivo'; link.textContent = 'Descargar';
      row.appendChild(name); row.appendChild(link); list.appendChild(row);
    });
    reveal.appendChild(list);
  }
  if (totalCorrected > 0){
    const note = document.createElement('div'); note.style.marginTop = '12px';
    note.textContent = `[Reed-Solomon corrigió ${totalCorrected} byte(s) dañado(s) automáticamente]`;
    reveal.appendChild(note);
  }
}

/* Panel de diagnóstico cuando el descifrado falla por lectura de color: dice qué
   caras tienen colores ilegibles, en el panel persistente (no en un toast fugaz). */
function renderCubeDiagnostic(report){
  const reveal = document.getElementById('liveDecodeReveal');
  reveal.innerHTML = '';
  const title = document.createElement('div');
  title.style.fontWeight = '600';
  title.textContent = `No se pudo descifrar: ${report.failedBlocks} de ${report.numBlocks} bloques ilegibles (nivel ${report.tier}).`;
  reveal.appendChild(title);

  const problem = [];
  for (let f = 0; f < FACE_COUNT; f++) if (report.perFaceFailed[f] > 0) problem.push(f);

  const body = document.createElement('div');
  body.style.marginTop = '10px';
  if (problem.length && problem.length < FACE_COUNT){
    const sub = document.createElement('div');
    sub.textContent = 'Caras con colores ilegibles — reescanéalas con más luz y sin reflejos:';
    body.appendChild(sub);
    problem.forEach(f => {
      const row = document.createElement('div'); row.style.marginTop = '4px';
      const pct = Math.round((report.perFaceFailed[f] / report.perFaceTotal[f]) * 100);
      row.textContent = `• ${FACE_LABELS[FACE_ORDER[f]]}: ${report.perFaceFailed[f]}/${report.perFaceTotal[f]} bloques dañados (${pct}%)`;
      body.appendChild(row);
    });
  } else {
    const sub = document.createElement('div');
    sub.textContent = 'El daño está repartido entre todas las caras: suele ser luz despareja, reflejos sobre las caras, o un desajuste de color de la impresora. Prueba con luz difusa más fuerte y la cámara llenando el recuadro.';
    body.appendChild(sub);
  }
  reveal.appendChild(body);
}

const cubeScanner = createLiveScanner({
  ids: {
    viewfinder: 'liveViewfinder', canvas: 'liveCanvas', status: 'scanStatus',
    flash: 'scanFlash', rotate: 'scanRotate', completeBadge: 'scanComplete',
    progress: 'faceProgress', count: 'faceCount',
    captureBtn: 'liveCaptureBtn', resetBtn: 'liveResetBtn', actionBtn: 'liveDecodeBtn',
    pass: 'liveDecodePass', output: 'liveDecodeOutput',
  },
  requiresPass: true,
  busyLabel: 'Descifrando…',
  labelComplete: 'Descifrar',
  labelIncomplete: n => `Descifrar (faltan ${n})`,
  resetAfterAction: false,
  onAction: async (canonByFace, { pass }) => {
    let payload, totalCorrected;
    try{
      ({ payload, totalCorrected } = decodeCanonicalFaces(canonByFace, TIERS));
    } catch(e){
      // Falló la lectura de color: muestra qué caras están mal en el panel y
      // relanza un error corto para el toast.
      const report = diagnoseCanonicalFaces(canonByFace, TIERS);
      if (report){
        renderCubeDiagnostic(report);
        document.getElementById('liveDecodeOutput').classList.remove('hidden');
        throw new Error('No se pudo descifrar. Mira el detalle por cara abajo.');
      }
      throw e;
    }
    const result = await tryDecryptPayload(payload, pass);
    renderCubeReveal(result.text, totalCorrected);
    document.getElementById('liveDecodeOutput').classList.remove('hidden');
  },
});

export function initLiveScanner(){ cubeScanner.init(); }
export function startLiveScanner(){ cubeScanner.start(); }
export function stopLiveScanner(){ cubeScanner.stop(); }
export function resetLiveScanner(){ cubeScanner.reset(); }
export function isCubeLiveScannerRunning(){ return cubeScanner.isRunning(); }
/** Para pruebas e integración: inyecta una cara ya enderezada. */
export function __injectCanonicalFace(faceIndex, canon){ cubeScanner.injectCanonicalFace(faceIndex, canon); }
