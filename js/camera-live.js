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
import { detectTile, warpToCanonical, refineTileCorners, readCanonicalFaceId, decodeCanonicalFaces, diagnoseCanonicalFaces, dataSampleBoxes, FACE_COUNT } from './cube3d.js';
import { showToast, showError } from './ui.js';

const SAMPLE_SIZE = 720;        // lado del lienzo cuadrado de muestreo (más px/celda en Pro)
const GUIDE_INSET = 0.09;       // margen de la guía (coincide con el CSS .scan-frame)
const STABLE_NEEDED = 2;        // detecciones estables antes de capturar (rápido pero no por un cuadro suelto)
const DETECT_EVERY_MS = 70;     // periodicidad de detección (rápida: que "agarre" al instante)
const STABLE_MAX_MISS = 5;      // cuadros sin detección tolerados sin reiniciar la cuenta (mal pulso)
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
  // Seguimiento de estabilidad para captura de UN solo cuadro (lo fiable). La
  // detección barata (detectTile) cuenta estabilidad; al alcanzarla se endereza el
  // cuadro y solo se captura si pasa la COMPUERTA de calidad (readCanonicalFaceId
  // sobre la baldosa ya enderezada): así un encuadre torcido o borroso no se
  // captura como basura. Tolera cuadros perdidos para no desesperar con mal pulso.
  let stableFace = -1, stableCount = 0, stableMiss = 0;
  let lockBar = null;
  let captured = {};
  let lastDiagnosticUrl = null;

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

  function setLock(active, frac){
    if (els.viewfinder) els.viewfinder.classList.toggle('scan-locking', !!active);
    if (lockBar) lockBar.style.width = `${Math.round(Math.min(1, frac || 0) * 100)}%`;
  }

  /** Endereza el cuadro ACTUAL del lienzo a un cuadrado canónico. Afina las
   * esquinas reales del marco antes de enderezar: la detección es tolerante a
   * desalineación pero la rejilla de datos no, así que sin esto la lectura sale
   * corrida aunque la cara se haya "detectado bien". */
  function warpCurrentFrame(detection){
    const img = cleanCtx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    const corners = refineTileCorners(img.data, SAMPLE_SIZE, SAMPLE_SIZE, guideCorners(), detection.rotation);
    return warpToCanonical(img.data, SAMPLE_SIZE, SAMPLE_SIZE, corners, detection.rotation);
  }

  function resetStable(){ stableFace = -1; stableCount = 0; stableMiss = 0; }

  /** Guarda UN cuadro ya enderezado como una cara. La identidad se lee de la propia
   * baldosa enderezada (readCanonicalFaceId), fiable porque las marcas caen en su
   * sitio; si no se ve el patrón, se conserva la cara que dio la detección. El
   * descifrado final reordena las caras por Reed-Solomon, así que una etiqueta
   * equivocada no es fatal. */
  function finalizeCapture(canon, fallbackFace){
    setLock(false, 0);
    resetStable();
    const idInfo = readCanonicalFaceId(canon);
    const faceIndex = idInfo.ok ? idInfo.faceIndex : fallbackFace;
    const isNew = !captured[faceIndex];
    captured[faceIndex] = canon;
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
    if (!isNew) showToast('Esa cara ya estaba; muestra una nueva.');
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
    if (Object.keys(captured).length >= FACE_COUNT) return;

    const det = tryDetectFrame();
    if (!det.ok){
      // No se ve cara. Tolera varios cuadros perdidos sin reiniciar la cuenta (mal
      // pulso / desenfoque momentáneo): así no se "desespera" el usuario.
      if (stableCount > 0 && ++stableMiss <= STABLE_MAX_MISS){
        setStatus(`Fijando cara… mantén firme (${Math.min(stableCount, STABLE_NEEDED)}/${STABLE_NEEDED})`);
      } else {
        resetStable(); setLock(false, 0); setStatus('Centra una cara del cubo en el recuadro.');
      }
      return;
    }
    stableMiss = 0;
    if (det.faceIndex === stableFace) stableCount++; else { stableFace = det.faceIndex; stableCount = 1; }
    setLock(true, stableCount / STABLE_NEEDED);
    setStatus(`Fijando cara… mantén firme (${Math.min(stableCount, STABLE_NEEDED)}/${STABLE_NEEDED})`);
    if (stableCount < STABLE_NEEDED) return;

    // Estable: endereza ESTE cuadro y solo captura si la baldosa enderezada se lee
    // limpia (COMPUERTA de calidad). Esto evita capturar encuadres torcidos/borrosos
    // como basura — la causa de que "ya no descifre".
    const canon = warpCurrentFrame(det);
    if (!readCanonicalFaceId(canon).ok){
      // El cuadro entró torcido/borroso: no captura, pide enderezar y reintenta.
      stableCount = 1;
      setStatus('Mantén la cara recta y bien centrada…');
      return;
    }
    finalizeCapture(canon, det.faceIndex);
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
    resetStable(); paused = false;
    setLock(false, 0);
    if (els.output) els.output.classList.add('hidden');
    if (els.diag) els.diag.classList.add('hidden');
    if (els.pass) els.pass.value = '';
    renderProgress();
    setStatus(running ? 'Centra una cara del cubo en el recuadro.' : 'Cámara detenida.');
  }

  /** Imagen de diagnóstico: las 6 caras ENDEREZADAS (lo que ve el decodificador)
   * con la rejilla de muestreo magenta encima y, por cara, cuántos bloques
   * Reed-Solomon quedaron irrecuperables. Mirando esta imagen se distingue al
   * instante la causa real: si las cajas magenta NO caen centradas en cada cuadro
   * de color = desalineación; si caen centradas pero los colores se ven apagados o
   * cambiados = color/luz; si una cara sale torcida o recortada = captura. */
  function buildDiagnosticDataURL(){
    let report = null;
    try{ report = diagnoseCanonicalFaces({ ...captured }, TIERS); } catch(_){ /* sin reporte */ }
    const grid = report ? report.grid : 24;
    const boxes = dataSampleBoxes(grid);
    const TILE = 240, PAD = 12, COLS = 3, ROWS = 2, HEAD = 64, FOOT = 22;
    const W = PAD + COLS * (TILE + PAD), H = HEAD + ROWS * (TILE + PAD + FOOT);
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#111'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff'; ctx.textBaseline = 'top'; ctx.font = '600 15px sans-serif';
    ctx.fillText(`Diagnóstico — capacidad ${report ? report.tier : '?'} (grid ${grid}) · bloques mal: ${report ? report.failedBlocks + '/' + report.numBlocks : '?'}`, PAD, 12);
    ctx.font = '12px sans-serif'; ctx.fillStyle = '#bbb';
    ctx.fillText('Magenta = dónde se lee el color de cada celda. Si NO cae centrado en cada cuadro → desalineación.', PAD, 34);
    for (let f = 0; f < FACE_COUNT; f++){
      const col = f % COLS, row = (f / COLS) | 0;
      const x = PAD + col * (TILE + PAD), y = HEAD + row * (TILE + PAD + FOOT);
      const canon = captured[f];
      if (canon){
        const tc = document.createElement('canvas'); tc.width = canon.size; tc.height = canon.size;
        tc.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(canon.data), canon.size, canon.size), 0, 0);
        ctx.drawImage(tc, x, y, TILE, TILE);
        ctx.strokeStyle = 'rgba(255,0,255,0.55)'; ctx.lineWidth = 1;
        ctx.beginPath();
        for (const b of boxes){ ctx.rect(x + b.x * TILE, y + b.y * TILE, b.w * TILE, b.h * TILE); }
        ctx.stroke();
      } else { ctx.fillStyle = '#400'; ctx.fillRect(x, y, TILE, TILE); }
      ctx.fillStyle = '#fff'; ctx.font = '600 12px sans-serif';
      const fail = report ? report.perFaceFailed[f] : '?', tot = report ? report.perFaceTotal[f] : '?';
      ctx.fillText(`cara ${f + 1}: ${fail}/${tot} bloques mal`, x, y + TILE + 4);
    }
    return cv.toDataURL('image/png');
  }

  function showDiagnostic(){
    if (!els.diag) return;
    let url; try{ url = buildDiagnosticDataURL(); } catch(_){ return; }
    lastDiagnosticUrl = url;
    els.diag.innerHTML = '';
    const p = document.createElement('div'); p.className = 'scan-diag-note';
    p.textContent = 'No se pudo descifrar. Descarga esta imagen y envíasela al desarrollador: muestra exactamente lo que ve el escáner.';
    const img = document.createElement('img'); img.src = url; img.className = 'scan-diag-img';
    const a = document.createElement('a'); a.href = url; a.download = 'ciphercube-diagnostico.png';
    a.textContent = '⬇ Descargar diagnóstico'; a.className = 'btn-secondary scan-diag-dl';
    els.diag.appendChild(p); els.diag.appendChild(img); els.diag.appendChild(a);
    els.diag.classList.remove('hidden');
  }

  async function runAction(){
    if (Object.keys(captured).length < FACE_COUNT){ showError('Faltan caras por capturar.'); return; }
    const pass = els.pass ? els.pass.value : null;
    if (requiresPass && !pass){ showError('Escribe tu frase.'); return; }
    const btn = els.actionBtn;
    if (els.diag) els.diag.classList.add('hidden');
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> ${config.busyLabel || 'Procesando…'}`;
    try{
      await config.onAction({ ...captured }, { pass });
      if (config.resetAfterAction) resetScan();
    } catch(e){
      showError(e.message);
      // Diagnóstico visual SOLO para el escáner del cubo (decode Reed-Solomon): así
      // el usuario puede mandar una imagen de lo que ve el escáner y ver la causa.
      if (config.diagnostic) showDiagnostic();
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
    // Barra de progreso del "fijado" (ráfaga multi-frame), creada en JS para no
    // tocar el HTML de ambos escáneres.
    if (els.viewfinder && !els.viewfinder.querySelector('.scan-lockbar')){
      lockBar = document.createElement('i');
      const wrap = document.createElement('div');
      wrap.className = 'scan-lockbar'; wrap.appendChild(lockBar);
      els.viewfinder.appendChild(wrap);
    }
    // Contenedor del diagnóstico (solo se llena/visualiza al fallar el descifrado).
    if (config.diagnostic && els.actionBtn){
      els.diag = document.createElement('div');
      els.diag.className = 'scan-diag hidden';
      els.actionBtn.parentNode.insertBefore(els.diag, els.actionBtn.nextSibling);
    }

    els.captureBtn.addEventListener('click', () => {
      if (!running){ showError('La cámara no está activa.'); return; }
      const det = tryDetectFrame();
      if (!det.ok){ showToast('No veo una cara válida; acércala y céntrala.'); return; }
      // Captura forzada del cuadro actual (escape para impacientes), sin compuerta.
      paused = false;
      finalizeCapture(warpCurrentFrame(det), det.faceIndex);
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

function renderCubeReveal(rawText){
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
  diagnostic: true,
  onAction: async (canonByFace, { pass }) => {
    const { payload } = decodeCanonicalFaces(canonByFace, TIERS);
    const result = await tryDecryptPayload(payload, pass);
    renderCubeReveal(result.text);
    document.getElementById('liveDecodeOutput').classList.remove('hidden');
  },
});

export function initLiveScanner(){ cubeScanner.init(); }
export function startLiveScanner(){ cubeScanner.start(); }
export function stopLiveScanner(){ cubeScanner.stop(); }
