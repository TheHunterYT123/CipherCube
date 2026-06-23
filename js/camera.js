'use strict';
/* =========================================================
   CAMERA — pantalla "Descifrar": captura/subida, calibración
   por homografía, detección de tier, descifrado y reconstrucción
   Shamir desde partes (escaneadas en vivo cara por cara, o subidas
   como imagen — lámina plana o hoja de 6 caras 3D).
   ========================================================= */
import {
  TIERS, SHARE_GRID, SHAMIR_MAGIC,
  capacityBytesForGrid, detectTierFromImageDimensions,
  readColorIndicesFromImage, readColorIndicesViaHomography,
  colorIndicesToPayload, rsDecodeRawToPayload, tryDecryptPayload,
  payloadToShare, reconstructSecret, parseDecodedPayload, dataUrlForFileEntry,
} from './crypto.js';
import {
  detectSheetTier, decodeSheetImage, isShareSheet, decodeShareSheetImage, shareFacesToPayload,
} from './cube3d.js';
import { createLiveScanner, stopLiveScanner, startLiveScanner } from './camera-live.js';
import { showError, showToast } from './ui.js';

let photoImgEl = null;
let detectedDecodeTier = null;
let detectedSheetTier = null; // si la imagen subida es una hoja de 6 caras 3D
let selectedDecodeTier = 'estandar';
let cornerHandles = []; // {el, xPct, yPct} en % del contenedor
let collectedShares = []; // { label, share:{index,bytes} } — de cámara o de imagen
let shareScanner = null;

function handleFileSelected(file){
  const reader = new FileReader();
  reader.onload = () => {
    document.getElementById('vfBeforeImage').style.display='none';
    document.getElementById('vfAfterImage').style.display='block';
    const calibImg = document.getElementById('calibImg');
    calibImg.onload = () => {
      photoImgEl = calibImg;
      detectedSheetTier = detectSheetTier(calibImg, TIERS);
      detectedDecodeTier = detectedSheetTier ? null : detectTierFromImageDimensions(calibImg);
      const hint = document.getElementById('decodeAutoHint');
      if (detectedSheetTier){
        hint.textContent = `Hoja de caras 3D detectada (${TIERS[detectedSheetTier].label}). Se leerá directamente.`;
      } else if (detectedDecodeTier){
        selectedDecodeTier = detectedDecodeTier;
        hint.textContent = `Capacidad detectada: ${TIERS[detectedDecodeTier].label}. El PNG exportado se leerá directamente, sin marcar esquinas.`;
      } else {
        hint.textContent = 'No se detectó una imagen exportada exacta. La app probará las capacidades automáticamente; ajusta los puntos a las esquinas del cubo.';
      }
      setupCornerHandles();
    };
    calibImg.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function setupCornerHandles(){
  document.querySelectorAll('.corner-handle').forEach(h=>h.remove());
  cornerHandles = [];
  const wrap = document.getElementById('calibrateWrap');
  const positions = [[0,0],[100,0],[100,100],[0,100]]; // TL,TR,BR,BL en %
  positions.forEach(([xPct,yPct]) => {
    const el = document.createElement('div');
    el.className = 'corner-handle';
    el.style.left = xPct+'%'; el.style.top = yPct+'%';
    wrap.appendChild(el);
    const handle = { el, xPct, yPct };
    cornerHandles.push(handle);
    let dragging=false;
    el.addEventListener('pointerdown', e => { dragging=true; el.setPointerCapture(e.pointerId); });
    el.addEventListener('pointermove', e => {
      if (!dragging) return;
      const rect = wrap.getBoundingClientRect();
      handle.xPct = Math.max(0, Math.min(100, ((e.clientX-rect.left)/rect.width)*100));
      handle.yPct = Math.max(0, Math.min(100, ((e.clientY-rect.top)/rect.height)*100));
      el.style.left = handle.xPct+'%'; el.style.top = handle.yPct+'%';
    });
    el.addEventListener('pointerup', () => dragging=false);
  });
}
function getCornersInNaturalPixels(){
  return cornerHandles.map(h => [ h.xPct/100*photoImgEl.naturalWidth, h.yPct/100*photoImgEl.naturalHeight ]);
}
function renderDecodedSecret(rawText, totalCorrected){
  const reveal = document.getElementById('decodeReveal');
  const decoded = parseDecodedPayload(rawText);
  reveal.innerHTML = '';
  const textBlock = document.createElement('div');
  textBlock.textContent = decoded.text || (decoded.files.length ? '(sin texto, solo archivos adjuntos)' : '');
  reveal.appendChild(textBlock);
  if (decoded.files.length){
    const list = document.createElement('div');
    list.className = 'file-list';
    decoded.files.forEach(file => {
      const row = document.createElement('div');
      row.className = 'file-item';
      const sizeKb = Math.max(1, Math.round((file.size || 0)/1024));
      const name = document.createElement('span');
      name.textContent = `${file.name || 'archivo'} · ${sizeKb} KB`;
      const link = document.createElement('a');
      link.className = 'file-download';
      link.href = dataUrlForFileEntry(file);
      link.download = file.name || 'ciphercube-archivo';
      link.textContent = 'Descargar';
      row.appendChild(name);
      row.appendChild(link);
      list.appendChild(row);
    });
    reveal.appendChild(list);
  }
  if (totalCorrected>0){
    const note = document.createElement('div');
    note.style.marginTop = '12px';
    note.textContent = `[Reed-Solomon corrigió ${totalCorrected} byte(s) dañado(s) automáticamente]`;
    reveal.appendChild(note);
  }
}
function tiersToTryForCurrentImage(){
  if (detectedDecodeTier) return [detectedDecodeTier];
  return [selectedDecodeTier, ...Object.keys(TIERS).filter(t => t!==selectedDecodeTier)];
}
async function readAndDecryptCurrentImage(tier, passphrase){
  const grid = TIERS[tier].grid;
  let indices;
  if (detectedDecodeTier === tier){
    indices = readColorIndicesFromImage(photoImgEl, grid);
  } else {
    const photoCanvas = document.createElement('canvas');
    photoCanvas.width = photoImgEl.naturalWidth; photoCanvas.height = photoImgEl.naturalHeight;
    const pctx = photoCanvas.getContext('2d'); pctx.drawImage(photoImgEl, 0, 0);
    const corners = getCornersInNaturalPixels();
    indices = readColorIndicesViaHomography(pctx, photoCanvas.width, photoCanvas.height, corners, grid);
  }
  const rawBytes = colorIndicesToPayload(indices, capacityBytesForGrid(grid));
  const { payload, totalCorrected } = rsDecodeRawToPayload(rawBytes, grid);
  const result = await tryDecryptPayload(payload, passphrase);
  return { result, totalCorrected, tier };
}

/* ---- Partes de la Bóveda: lista unificada (cámara + imagen) ---- */
function renderShareUploadList(){
  const wrap = document.getElementById('shareUploadList'); wrap.innerHTML='';
  if (!collectedShares.length){
    const empty = document.createElement('div'); empty.className='hint';
    empty.textContent = 'Aún no hay partes. Escanéalas con la cámara o sube su imagen.';
    wrap.appendChild(empty);
    return;
  }
  collectedShares.forEach((entry,i) => {
    const row=document.createElement('div'); row.className='upload-mini'; row.innerHTML=`<span>${entry.label}</span>`;
    const rm=document.createElement('button'); rm.textContent='Quitar'; rm.addEventListener('click',()=>{collectedShares.splice(i,1); renderShareUploadList();});
    row.appendChild(rm); wrap.appendChild(row);
  });
}

/** Intenta reconstruir con las partes reunidas hasta ahora. Si `showErrorIfFail`
 * es false, falla en silencio (se asume que aún faltan partes). */
function attemptReconstruct(showErrorIfFail){
  if (collectedShares.length < 2){
    if (showErrorIfFail) showError('Reúne al menos 2 partes (escaneadas o subidas).');
    return false;
  }
  try{
    const shares = collectedShares.map(e => e.share);
    const recovered = reconstructSecret(shares);
    const magicOk = recovered[0]===SHAMIR_MAGIC[0]&&recovered[1]===SHAMIR_MAGIC[1]&&recovered[2]===SHAMIR_MAGIC[2]&&recovered[3]===SHAMIR_MAGIC[3];
    if (!magicOk){
      if (showErrorIfFail) showError('No se pudo reconstruir: faltan partes o no son del mismo reparto.');
      return false;
    }
    document.getElementById('reconstructReveal').textContent = new TextDecoder().decode(recovered.slice(4));
    document.getElementById('reconstructOutput').classList.remove('hidden');
    showToast('Frase reconstruida.');
    return true;
  } catch(e){
    if (showErrorIfFail) showError('Error al reconstruir: '+e.message);
    return false;
  }
}

/** Una imagen de parte subida puede ser una hoja de 6 caras 3D o una lámina plana. */
function decodeShareImageToShare(img){
  if (isShareSheet(img)){
    const payload = decodeShareSheetImage(img);
    return payloadToShare(payload);
  }
  const indices = readColorIndicesFromImage(img, SHARE_GRID);
  const payload = colorIndicesToPayload(indices, capacityBytesForGrid(SHARE_GRID));
  return payloadToShare(payload);
}

/** Vuelve la pantalla Descifrar a su estado inicial: sin imagen, sin frase,
 * sin resultado previo. Se usa al reintentar y al volver a entrar a la pantalla. */
export function resetCameraScreen(){
  document.getElementById('vfBeforeImage').style.display='block';
  document.getElementById('vfAfterImage').style.display='none';
  document.querySelectorAll('.corner-handle').forEach(h=>h.remove());
  photoImgEl = null;
  detectedDecodeTier = null;
  detectedSheetTier = null;
  document.getElementById('decodePass').value = '';
  document.getElementById('decodeOutput').classList.add('hidden');
  document.getElementById('reconstructBody').classList.remove('show');
  document.getElementById('reconstructArrow').textContent = '▾';
  document.getElementById('shareUploadBody').classList.remove('show');
  document.getElementById('shareUploadArrow').textContent = '▾';
  document.getElementById('reconstructOutput').classList.add('hidden');
  collectedShares = [];
  renderShareUploadList();
  if (shareScanner){ shareScanner.stop(); shareScanner.reset(); }
}

/** Detiene la cámara del escáner de partes (usado al salir de la pantalla Descifrar). */
export function stopShareScanner(){ if (shareScanner) shareScanner.stop(); }

export function initCamera(){
  document.getElementById('takePhotoBtn').addEventListener('click', () => document.getElementById('cameraCaptureInput').click());
  document.getElementById('uploadPhotoBtn').addEventListener('click', () => document.getElementById('uploadFileInput').click());
  document.getElementById('cameraCaptureInput').addEventListener('change', e => { if(e.target.files[0]) handleFileSelected(e.target.files[0]); });
  document.getElementById('uploadFileInput').addEventListener('change', e => { if(e.target.files[0]) handleFileSelected(e.target.files[0]); });
  document.getElementById('retakeBtn').addEventListener('click', () => {
    document.getElementById('vfBeforeImage').style.display='block';
    document.getElementById('vfAfterImage').style.display='none';
    document.querySelectorAll('.corner-handle').forEach(h=>h.remove());
    photoImgEl = null;
    detectedDecodeTier = null;
    detectedSheetTier = null;
    document.getElementById('decodeOutput').classList.add('hidden');
  });

  document.querySelectorAll('#decodeTierOptions .chip').forEach(chip => chip.addEventListener('click', () => {
    document.querySelectorAll('#decodeTierOptions .chip').forEach(c=>c.classList.remove('selected'));
    chip.classList.add('selected'); selectedDecodeTier = chip.dataset.tier;
  }));

  document.getElementById('decodeBtn').addEventListener('click', async () => {
    const btn = document.getElementById('decodeBtn');
    document.getElementById('decodeOutput').classList.add('hidden');
    const pass = document.getElementById('decodePass').value;
    if (!photoImgEl) { showError('Captura o sube primero la imagen del cubo.'); return; }
    if (!pass) { showError('Escribe tu frase.'); return; }
    btn.disabled=true; btn.innerHTML='<span class="spinner"></span> Leyendo y descifrando…';
    try{
      if (detectedSheetTier){
        // Imagen subida = hoja de 6 caras 3D exportada: léela directamente.
        const { payload, totalCorrected } = decodeSheetImage(photoImgEl, TIERS[detectedSheetTier].grid);
        const result = await tryDecryptPayload(payload, pass);
        renderDecodedSecret(result.text, totalCorrected);
        document.getElementById('decodeOutput').classList.remove('hidden');
        return;
      }
      const errors = [];
      let decoded = null;
      for (const tier of tiersToTryForCurrentImage()){
        try{
          decoded = await readAndDecryptCurrentImage(tier, pass);
          break;
        } catch(e){
          errors.push(`${TIERS[tier].label}: ${e.message}`);
        }
      }
      if (!decoded) throw new Error(detectedDecodeTier ? errors[0] : 'No se pudo descifrar probando Mini, Estándar y Pro. Revisa la frase o ajusta mejor las esquinas.');
      renderDecodedSecret(decoded.result.text, decoded.totalCorrected);
      document.getElementById('decodeOutput').classList.remove('hidden');
    } catch(e){ showError(e.message); }
    finally{ btn.disabled=false; btn.textContent='Descifrar'; }
  });

  document.getElementById('uploadTrigger').addEventListener('click', () => {
    const body = document.getElementById('uploadBody'); body.classList.toggle('show');
    document.getElementById('uploadArrow').textContent = body.classList.contains('show')?'▴':'▾';
  });

  document.getElementById('reconstructTrigger').addEventListener('click', () => {
    const body = document.getElementById('reconstructBody');
    const opening = !body.classList.contains('show');
    body.classList.toggle('show');
    document.getElementById('reconstructArrow').textContent = opening?'▴':'▾';
    // Solo una cámara a la vez: la del cubo principal o la de partes.
    if (opening){ stopLiveScanner(); shareScanner.start(); }
    else { shareScanner.stop(); startLiveScanner(); }
  });

  document.getElementById('shareUploadTrigger').addEventListener('click', () => {
    const body = document.getElementById('shareUploadBody'); body.classList.toggle('show');
    document.getElementById('shareUploadArrow').textContent = body.classList.contains('show')?'▴':'▾';
  });

  document.getElementById('addShareBtn').addEventListener('click', () => document.getElementById('shareFilesInput').click());
  document.getElementById('shareFilesInput').addEventListener('change', e => {
    [...e.target.files].forEach(file => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          try{
            const share = decodeShareImageToShare(img);
            collectedShares.push({ label: file.name, share });
            renderShareUploadList();
            attemptReconstruct(false);
          } catch(e){ showError(`No se pudo leer "${file.name}": ${e.message}`); }
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  });

  document.getElementById('shamirReconstructBtn').addEventListener('click', () => {
    document.getElementById('reconstructOutput').classList.add('hidden');
    attemptReconstruct(true);
  });

  shareScanner = createLiveScanner({
    ids: {
      viewfinder: 'shareLiveViewfinder', canvas: 'shareLiveCanvas', status: 'shareScanStatus',
      flash: 'shareScanFlash', rotate: 'shareScanRotate', completeBadge: 'shareScanComplete',
      progress: 'shareFaceProgress', count: 'shareFaceCount',
      captureBtn: 'shareLiveCaptureBtn', resetBtn: 'shareLiveResetBtn', actionBtn: 'shareLiveAddBtn',
    },
    requiresPass: false,
    busyLabel: 'Agregando parte…',
    labelComplete: 'Agregar parte',
    labelIncomplete: n => `Agregar parte (faltan ${n})`,
    resetAfterAction: true,
    onAction: async (canonByFace) => {
      const payload = shareFacesToPayload(canonByFace);
      const share = payloadToShare(payload);
      collectedShares.push({ label: `Parte escaneada #${collectedShares.length + 1}`, share });
      renderShareUploadList();
      showToast(`Parte añadida por cámara. Total: ${collectedShares.length}.`);
      attemptReconstruct(false);
    },
  });
  shareScanner.init();
  renderShareUploadList();
}
