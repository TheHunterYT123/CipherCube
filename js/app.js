'use strict';
/* =========================================================
   APP — bootstrap + pantallas Inicio, Crear, Tienda, Perfil.
   Orquesta crypto.js/plans.js/storage.js/ui.js; la pantalla
   Descifrar vive en camera.js.
   ========================================================= */
import {
  TIERS, MAGIC, SHARE_GRID, SHAMIR_MAGIC, PALETTE, FACE_LABELS, FACE_ORDER,
  effectiveCapacityForGrid, slotPlaintextLenForCapacity, capacityBytesForGrid,
  buildPayload, rsEncodePayloadToRaw, payloadToColorIndices, drawCubeNet,
  composeSecretPayload, splitSecret, shareToPayload, RS_PARITY_HIGH,
} from './crypto.js';
import { planAllows, planLabel, PLAN_REQUIREMENT_LABEL } from './plans.js';
import { appState, addCubeToHistory, resetHistory } from './storage.js';
import {
  initNavigation, showScreen, onScreenChange, applyTheme, setTheme,
  showToast, showError, armLockZone, openSheet, closeSheet, applyStagger,
} from './ui.js';
import {
  initAuth, initAuthUI, setOnAuthChange, logout, changePassword, beginPurchase,
} from './auth.js';
import { initAdmin, openAdmin, isAdminEmail } from './admin.js';
import { getCurrentUser } from './auth.js';
import { twoFactor as twoFactorApi, auth as authApi } from './api.js';
import { initCamera, resetCameraScreen, stopShareScanner } from './camera.js';
import { initLiveScanner, startLiveScanner, stopLiveScanner } from './camera-live.js';
import { renderAllFaceTilesV2 } from './cube3d.js';
import { loadArgon2 } from './argon2-loader.js';

/* ---- Inicio: mini-preview de cifrado ---- */
let miniPreviewDebounce = null;
async function updateMiniPreview(text){
  const data = new TextEncoder().encode(text || 'CipherCube');
  const hashBuf = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(hashBuf);
  const canvas = document.getElementById('miniPreview');
  const ctx = canvas.getContext('2d');
  canvas.width=58; canvas.height=58;
  const cells=8, cellPx=58/cells;
  for(let r=0;r<cells;r++) for(let c=0;c<cells;c++){ ctx.fillStyle=PALETTE[bytes[(r*cells+c)%bytes.length]%8]; ctx.fillRect(c*cellPx,r*cellPx,cellPx,cellPx); }
}

/* ---- Crear: segmentado Cubo/Bóveda ---- */
function initCrearSegmented(){
  document.querySelectorAll('.seg-crear').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.seg-crear').forEach(b=>b.classList.remove('active')); btn.classList.add('active');
    const isCubo = btn.dataset.target==='crear-cubo';
    document.getElementById('crear-cubo').style.display = isCubo?'block':'none';
    document.getElementById('crear-boveda').style.display = isCubo?'none':'block';
  }));
}
function initBovedaLock(){
  armLockZone(document.getElementById('bovedaZone'), {
    isLocked: () => !planAllows('shamir'),
    requirementLabel: PLAN_REQUIREMENT_LABEL.shamir,
    onUpgrade: () => showScreen('tienda'),
  });
}

/* ---- Crear > Cubo: tier ---- */
let selectedTier = 'mini';
let highEccEnabled = false;
function refreshTierLocks(){
  document.querySelectorAll('#tierOptions .chip').forEach(chip => {
    const locked = (chip.dataset.tier==='estandar' && !planAllows('standard_tier')) || (chip.dataset.tier==='pro' && !planAllows('pro_tier'));
    chip.classList.toggle('locked', locked);
    const nameEl = chip.querySelector('.cname');
    const baseName = chip.dataset.tier==='estandar' ? 'Estándar' : chip.dataset.tier==='pro' ? 'Pro' : 'Mini';
    nameEl.innerHTML = locked
      ? `${baseName} <svg class="lock-ic" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 1 1 8 0v4"/></svg>`
      : baseName;
  });
  if (selectedTier!=='mini' && !planAllows(selectedTier==='estandar' ? 'standard_tier' : 'pro_tier')) {
    selectedTier='mini';
    document.querySelectorAll('#tierOptions .chip').forEach(c=>c.classList.toggle('selected', c.dataset.tier==='mini'));
    syncHighEccVisibility();
  }
}
/** Muestra el toggle de alta corrección solo cuando el tier activo es Pro; si se
 * sale de Pro con el toggle marcado, se apaga (no aplica a otros tiers). */
function syncHighEccVisibility(){
  const zone = document.getElementById('highEccZone');
  if (!zone) return;
  zone.style.display = selectedTier === 'pro' ? 'block' : 'none';
  if (selectedTier !== 'pro' && highEccEnabled){
    highEccEnabled = false;
    const toggle = document.getElementById('highEccToggle');
    if (toggle) toggle.checked = false;
  }
}
function initTierChips(){
  document.querySelectorAll('#tierOptions .chip').forEach(chip => chip.addEventListener('click', () => {
    const locked = (chip.dataset.tier==='estandar' && !planAllows('standard_tier')) || (chip.dataset.tier==='pro' && !planAllows('pro_tier'));
    if (locked) { showError(`La capacidad ${chip.dataset.tier==='estandar'?'Estándar':'Pro'} requiere el plan ${PLAN_REQUIREMENT_LABEL.standard_tier}.`); return; }
    document.querySelectorAll('#tierOptions .chip').forEach(c=>c.classList.remove('selected'));
    chip.classList.add('selected'); selectedTier = chip.dataset.tier;
    syncHighEccVisibility();
    updateSecretCounter();
  }));
  document.getElementById('highEccToggle').addEventListener('change', e => {
    highEccEnabled = e.target.checked;
    updateSecretCounter();
  });
  syncHighEccVisibility();
}

/* ---- Crear > Cubo: archivos adjuntos + contador de capacidad ---- */
let attachedSecretFiles = [];
function currentParity(){ return (selectedTier === 'pro' && highEccEnabled) ? RS_PARITY_HIGH : undefined; }
function maxSecretBytesForSelectedTier(){
  const usable = effectiveCapacityForGrid(TIERS[selectedTier].grid, currentParity()).usable;
  return slotPlaintextLenForCapacity(usable) - 2;
}
function updateSecretCounter(){
  const counterEl = document.getElementById('secretCounter');
  const attachHint = document.getElementById('attachHint');
  try{
    const usable = effectiveCapacityForGrid(TIERS[selectedTier].grid, currentParity()).usable;
    const slotLen = slotPlaintextLenForCapacity(usable);
    const packed = composeSecretPayload(document.getElementById('secretText').value, attachedSecretFiles);
    const used = new TextEncoder().encode(packed).length;
    const max = slotLen-2;
    counterEl.textContent = `${used} / ${max} bytes`;
    counterEl.classList.toggle('over', used > max);
    if (attachHint) attachHint.textContent = attachedSecretFiles.length
      ? `${attachedSecretFiles.length} archivo(s) adjunto(s) · cifrados junto con tu secreto.`
      : 'Se cifran junto con tu secreto y restan espacio disponible.';
  } catch(e){
    counterEl.textContent = 'Capacidad insuficiente para este tier con volumen oculto.';
  }
}
function fileToBase64(file){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
    reader.readAsDataURL(file);
  });
}
function renderAttachedFiles(){
  const list = document.getElementById('secretFilesList');
  list.innerHTML = '';
  attachedSecretFiles.forEach((file, index) => {
    const row = document.createElement('div');
    row.className = 'file-item';
    const sizeKb = Math.max(1, Math.round(file.size/1024));
    row.innerHTML = `<span>${file.name} · ${sizeKb} KB</span>`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Quitar';
    remove.addEventListener('click', () => {
      attachedSecretFiles.splice(index, 1);
      renderAttachedFiles();
      updateSecretCounter();
    });
    row.appendChild(remove);
    list.appendChild(row);
  });
}
function initFileAttach(){
  document.getElementById('attachFilesBtn').addEventListener('click', () => document.getElementById('secretFilesInput').click());
  document.getElementById('secretFilesInput').addEventListener('change', async e => {
    for (const file of e.target.files){
      const data = await fileToBase64(file);
      const candidate = [...attachedSecretFiles, { name:file.name, type:file.type, size:file.size, data }];
      const candidatePayload = composeSecretPayload(document.getElementById('secretText').value, candidate);
      if (new TextEncoder().encode(candidatePayload).length > maxSecretBytesForSelectedTier()){
        showError(`"${file.name}" excede la capacidad actual del cubo. Prueba una capacidad mayor o quita otros archivos.`);
        continue;
      }
      attachedSecretFiles.push({ name:file.name, type:file.type, size:file.size, data });
    }
    e.target.value = '';
    renderAttachedFiles();
    updateSecretCounter();
  });
  document.getElementById('secretText').addEventListener('input', updateSecretCounter);
}

/* ---- Crear > Cubo: volumen oculto ---- */
function initHiddenLock(){
  armLockZone(document.getElementById('hiddenZone'), {
    isLocked: () => !planAllows('hidden_volume'),
    requirementLabel: PLAN_REQUIREMENT_LABEL.hidden_volume,
    onUpgrade: () => showScreen('tienda'),
  });
}
/** Si el plan baja y el volumen oculto quedó marcado de antes, lo desactiva
 * para que la UI no muestre algo que ya no se va a aplicar al generar. */
function syncHiddenToggleWithPlan(){
  const hiddenToggle = document.getElementById('hiddenToggle');
  if (!planAllows('hidden_volume') && hiddenToggle.checked){
    hiddenToggle.checked = false;
    document.getElementById('hiddenFields').classList.remove('show');
    updateSecretCounter();
  }
}
function initHiddenToggle(){
  const hiddenToggle = document.getElementById('hiddenToggle');
  hiddenToggle.addEventListener('change', () => {
    document.getElementById('hiddenFields').classList.toggle('show', hiddenToggle.checked);
    updateSecretCounter();
  });
}

/* ---- Crear > Cubo: generar + vista de resultado ---- */
let lastGenerated = null;
let mpRevealed = false;

async function sha256Hex(bytes){
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2,'0')).join('');
}
function resetCreateForm(){
  document.getElementById('secretText').value = '';
  document.getElementById('realPass').value = '';
  document.getElementById('decoyPass').value = '';
  document.getElementById('decoyText').value = '';
  const hiddenToggle = document.getElementById('hiddenToggle');
  hiddenToggle.checked = false;
  document.getElementById('hiddenFields').classList.remove('show');
  highEccEnabled = false;
  document.getElementById('highEccToggle').checked = false;
  attachedSecretFiles = [];
  renderAttachedFiles();
  updateSecretCounter();
  document.getElementById('crearFormFields').style.display = 'block';
  document.getElementById('resultView').classList.add('hidden');
  lastGenerated = null;
}
function showResultAfterGenerate(data){
  lastGenerated = data;
  mpRevealed = false;
  document.getElementById('mpValue').textContent = '••••••••••';
  document.getElementById('mpToggleBtn').textContent = 'Mostrar';
  document.getElementById('crearFormFields').style.display = 'none';
  document.getElementById('resultView').classList.remove('hidden');
}
function initGenerate(){
  document.getElementById('generateBtn').addEventListener('click', async () => {
    const btn = document.getElementById('generateBtn');
    const typedSecretText = document.getElementById('secretText').value;
    const secretText = composeSecretPayload(typedSecretText, attachedSecretFiles);
    const realPass = document.getElementById('realPass').value;
    const hiddenToggle = document.getElementById('hiddenToggle');
    const hiddenEnabled = hiddenToggle.checked && planAllows('hidden_volume');
    const decoyPass = document.getElementById('decoyPass').value;
    const decoyText = document.getElementById('decoyText').value;
    if (!typedSecretText.trim() && attachedSecretFiles.length===0) { showError('Escribe un secreto o adjunta al menos un archivo.'); return; }
    // Validación de capacidad clara ANTES de cifrar: cubre texto + archivos juntos,
    // y casos en que se cambió de tier después de adjuntar (p. ej. bajar a Mini).
    const usedBytes = new TextEncoder().encode(secretText).length;
    const maxBytes = maxSecretBytesForSelectedTier();
    if (usedBytes > maxBytes){
      const overKb = ((usedBytes - maxBytes) / 1024).toFixed(1);
      const biggerTier = selectedTier === 'mini' ? 'Estándar o Pro' : (selectedTier === 'estandar' ? 'Pro' : null);
      showError(
        `El contenido pesa ${usedBytes} de ${maxBytes} bytes disponibles en ${TIERS[selectedTier].label} ` +
        `(te sobran ~${overKb} KB). ` +
        (biggerTier ? `Sube a capacidad ${biggerTier}, ` : '') +
        `acorta el texto o quita algún archivo.`
      );
      return;
    }
    if (!realPass || realPass.length<6) { showError('Tu frase maestra debe tener al menos 6 caracteres.'); return; }
    if (hiddenEnabled && (!decoyPass || decoyPass.length<6)) { showError('Define una frase señuelo de al menos 6 caracteres.'); return; }
    if (hiddenEnabled && decoyPass===realPass) { showError('La frase señuelo debe ser distinta de la real.'); return; }
    btn.disabled=true; btn.innerHTML='<span class="spinner"></span> Cifrando…';
    try{
      const highEcc = selectedTier === 'pro' && highEccEnabled;
      const built = await buildPayload({ secretText, realPass, hiddenEnabled, decoyPass, decoyText, tier: selectedTier, highEcc });
      const rawBytes = rsEncodePayloadToRaw(built.payload, built.grid, built.parity);
      const indices = payloadToColorIndices(rawBytes);
      const canvas = document.getElementById('generateCanvas');
      drawCubeNet(canvas, indices, built.grid);
      const checksum = await sha256Hex(rawBytes);
      showResultAfterGenerate({ canvas, built, tier: selectedTier, hiddenEnabled, realPass, checksum, indices, grid: built.grid });
      addCubeToHistory({ tier: TIERS[selectedTier].label, hidden: hiddenEnabled, ts: new Date() });
    } catch(e){ showError(e.message); }
    finally { btn.disabled=false; btn.textContent='Generar cubo cifrado'; }
  });
}
/** Hoja imprimible de 6 baldosas escaneables (2 columnas × 3 filas) a partir de colorIndices. */
function buildFaceSheetCanvas(colorIndices, grid){
  const tiles = renderAllFaceTilesV2(colorIndices, grid);
  const tile = tiles[0].width;
  const pad = Math.round(tile * 0.12), cols = 2, rows = 3;
  const sheet = document.createElement('canvas');
  sheet.width = pad + cols * (tile + pad);
  sheet.height = pad + rows * (tile + pad);
  const sctx = sheet.getContext('2d');
  sctx.fillStyle = '#ffffff'; sctx.fillRect(0, 0, sheet.width, sheet.height);
  tiles.forEach((t, i) => {
    const cx = pad + (i % cols) * (tile + pad);
    const cy = pad + Math.floor(i / cols) * (tile + pad);
    sctx.drawImage(t, cx, cy);
  });
  return sheet;
}

/** Abre una hoja A4 lista para imprimir: 6 caras a tamaño físico exacto (50 mm),
 * con líneas de corte, etiqueta de cada cara e instrucciones de armado. El usuario
 * solo imprime al 100% y pega; no tiene que pelear con medidas. */
function openPrintSheet(colorIndices, grid, opts){
  opts = opts || {};
  const faceMm = 50;
  const tiles = renderAllFaceTilesV2(colorIndices, grid);
  const cells = tiles.map((t, i) => {
    const label = `Cara ${i + 1} · ${FACE_LABELS[FACE_ORDER[i]]}`;
    return `<div class="cell"><div class="cut"><img src="${t.toDataURL('image/png')}" alt="${label}"></div><div class="cap">${label}</div></div>`;
  }).join('');
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title || 'CipherCube'} — Imprimir y armar</title>
<style>
  :root{ color-scheme: light; }
  *{ box-sizing:border-box; }
  body{ font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; color:#111; margin:0; padding:14mm; background:#fff; }
  h1{ font-size:15pt; margin:0 0 6pt; }
  ol{ font-size:9.5pt; line-height:1.55; margin:0 0 12pt; padding-left:16pt; }
  ol b{ color:#000; }
  .toolbar{ margin-bottom:12pt; }
  .toolbar button{ font:600 11pt/1 inherit; padding:9pt 16pt; border:0; border-radius:8pt; background:#111; color:#fff; cursor:pointer; }
  .grid{ display:grid; grid-template-columns:repeat(2, ${faceMm}mm); gap:9mm 12mm; justify-content:center; margin-top:4mm; }
  .cell{ display:flex; flex-direction:column; align-items:center; }
  .cut{ width:${faceMm}mm; height:${faceMm}mm; outline:0.3mm dashed #999; outline-offset:1.2mm; }
  .cut img{ width:100%; height:100%; display:block; image-rendering:pixelated; }
  .cap{ font-size:8pt; color:#333; margin-top:3.5mm; font-weight:600; }
  .note{ font-size:8.5pt; color:#666; margin-top:12pt; }
  @page{ size:A4 portrait; margin:10mm; }
  @media print{ .screen-only{ display:none !important; } body{ padding:0; } }
</style></head>
<body>
  <div class="toolbar screen-only"><button onclick="window.print()">🖨️ Imprimir / Guardar PDF</button></div>
  <h1>CipherCube — ${opts.heading || 'Cubo para imprimir y armar'}</h1>
  <ol>
    <li><b>Imprime a tamaño real (100%).</b> En el diálogo de impresión elige escala <b>100%</b> y desactiva “Ajustar a la página”. Cada cara debe medir <b>${faceMm}×${faceMm} mm</b> (mídela con regla para confirmar).</li>
    <li>Usa <b>papel mate</b> si puedes: el brillo crea reflejos que dificultan el escaneo.</li>
    <li><b>Recorta</b> cada cara por su línea punteada.</li>
    <li><b>Pega</b> cada cara en una cara distinta de un cubo de <b>${faceMm} mm</b> (5 cm). Sirve un cubo de cartón/madera o un Rubik estándar (~5,7 cm). No importa el orden: cada cara se identifica sola al escanear.</li>
    <li><b>Escanea</b> con la cámara: acerca cada cara dentro del recuadro y se captura sola. Repite las 6.</li>
  </ol>
  <div class="grid">${cells}</div>
  <p class="note">Consejo: con buena luz y la cámara enfocada, el escaneo es casi instantáneo. Si una cara cuesta, manténla firme un segundo dentro de la guía.</p>
</body></html>`;
  const w = window.open('', '_blank');
  if (!w){ showError('Permite las ventanas emergentes para abrir la hoja de impresión.'); return; }
  w.document.open(); w.document.write(html); w.document.close();
  showToast('Hoja lista. Imprime al 100% (tamaño real).');
}

function initResultView(){
  const downloadMenu = document.getElementById('downloadMenu');
  document.getElementById('downloadMenuBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    downloadMenu.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!downloadMenu.classList.contains('hidden') && !document.getElementById('downloadDropdown').contains(e.target)){
      downloadMenu.classList.add('hidden');
    }
  });
  document.getElementById('downloadBtn').addEventListener('click', () => {
    if (!lastGenerated) return;
    const link=document.createElement('a');
    link.download=`ciphercube-${lastGenerated.tier}.png`;
    link.href=lastGenerated.canvas.toDataURL('image/png');
    link.click();
    downloadMenu.classList.add('hidden');
  });
  document.getElementById('download3dBtn').addEventListener('click', () => {
    if (!lastGenerated) return;
    openPrintSheet(lastGenerated.indices, lastGenerated.grid, {
      title: `CipherCube ${TIERS[lastGenerated.tier] ? TIERS[lastGenerated.tier].label : ''}`.trim(),
      heading: 'Cubo para imprimir y armar',
    });
    downloadMenu.classList.add('hidden');
  });
  document.getElementById('download3dPngBtn').addEventListener('click', () => {
    if (!lastGenerated) return;
    const sheet = buildFaceSheetCanvas(lastGenerated.indices, lastGenerated.grid);
    const link = document.createElement('a');
    link.download = `ciphercube-${lastGenerated.tier}-caras3d.png`;
    link.href = sheet.toDataURL('image/png');
    link.click();
    downloadMenu.classList.add('hidden');
  });
  document.getElementById('viewInfoBtn').addEventListener('click', () => {
    if (!lastGenerated) return;
    document.getElementById('infoCapacity').textContent = `${lastGenerated.built.usableCapacity} bytes`;
    document.getElementById('infoGrid').textContent = `${lastGenerated.built.grid}×${lastGenerated.built.grid}`;
    document.getElementById('infoVersion').textContent = 'Formato ' + new TextDecoder().decode(MAGIC);
    document.getElementById('infoKdf').textContent = lastGenerated.built.kdf === 'argon2id' ? 'Argon2id' : 'PBKDF2-SHA256';
    document.getElementById('infoChecksum').textContent = lastGenerated.checksum;
    document.getElementById('infoMasterPhrase').textContent = lastGenerated.realPass;
    openSheet(document.getElementById('infoSheetBackdrop'));
  });
  document.getElementById('infoSheetClose').addEventListener('click', () => closeSheet(document.getElementById('infoSheetBackdrop')));
  document.getElementById('infoSheetBackdrop').addEventListener('click', (e) => {
    if (e.target.id==='infoSheetBackdrop') closeSheet(e.target);
  });
  document.getElementById('createAnotherBtn').addEventListener('click', resetCreateForm);

  document.getElementById('mpToggleBtn').addEventListener('click', () => {
    if (!lastGenerated) return;
    mpRevealed = !mpRevealed;
    document.getElementById('mpValue').textContent = mpRevealed ? lastGenerated.realPass : '••••••••••';
    document.getElementById('mpToggleBtn').textContent = mpRevealed ? 'Ocultar' : 'Mostrar';
  });
  document.getElementById('mpCopyBtn').addEventListener('click', async () => {
    if (!lastGenerated) return;
    try{
      await navigator.clipboard.writeText(lastGenerated.realPass);
      showToast('Frase copiada al portapapeles.');
    } catch(_){
      const ta = document.createElement('textarea');
      ta.value = lastGenerated.realPass; ta.style.position='fixed'; ta.style.opacity='0';
      document.body.appendChild(ta); ta.select();
      try{ document.execCommand('copy'); showToast('Frase copiada al portapapeles.'); }
      catch(_){ showError('No se pudo copiar automáticamente. Selecciónala manualmente.'); }
      ta.remove();
    }
  });
}

/* ---- Crear > Bóveda: repartir Shamir ---- */
function initShamirSplit(){
  document.getElementById('shamirSplitBtn').addEventListener('click', () => {
    const passphrase = document.getElementById('shamirPass').value;
    const n = parseInt(document.getElementById('shamirN').value,10);
    const k = parseInt(document.getElementById('shamirK').value,10);
    if (!passphrase) { showError('Escribe la frase que quieres repartir.'); return; }
    try{
      const secretBytes = new Uint8Array([...SHAMIR_MAGIC, ...new TextEncoder().encode(passphrase)]);
      if (secretBytes.length > capacityBytesForGrid(SHARE_GRID)-3) throw new Error('La frase es demasiado larga para el tamaño de parte.');
      const shares = splitSecret(secretBytes, n, k);
      const list = document.getElementById('shareList'); list.innerHTML='';
      shares.forEach(share => {
        const payload = shareToPayload(share.index, share.bytes);
        const indices = payloadToColorIndices(payload);
        const item = document.createElement('div'); item.className='share-item';
        const canvas = document.createElement('canvas');
        const lbl = document.createElement('div'); lbl.className='lbl'; lbl.textContent=`Parte ${share.index}/${n}`;
        const dlBtn = document.createElement('button'); dlBtn.textContent='Descargar';
        const dl3dBtn = document.createElement('button'); dl3dBtn.textContent='Imprimir y armar';
        item.appendChild(canvas); item.appendChild(lbl); item.appendChild(dlBtn); item.appendChild(dl3dBtn); list.appendChild(item);
        drawCubeNet(canvas, indices, SHARE_GRID);
        dlBtn.addEventListener('click', () => { const link=document.createElement('a'); link.download=`ciphercube-parte-${share.index}-de-${n}.png`; link.href=canvas.toDataURL('image/png'); link.click(); });
        dl3dBtn.addEventListener('click', () => {
          openPrintSheet(indices, SHARE_GRID, {
            title: `CipherCube parte ${share.index}/${n}`,
            heading: `Parte ${share.index} de ${n} — imprimir y armar`,
          });
        });
      });
    } catch(e){ showError(e.message); }
  });
}

/* ---- Tienda ---- */
function refreshPlanButtons(){
  const planCtas = { free:'Volver a Básico', plus:'Obtener Plus', boveda:'Obtener Bóveda' };
  document.querySelectorAll('.plan-btn').forEach(btn => {
    const p = btn.dataset.plan;
    if (p === appState.plan) { btn.textContent='Plan actual'; btn.disabled=true; btn.className='btn btn-sm plan-btn btn-secondary'; }
    else { btn.textContent = planCtas[p] || 'Cambiar plan'; btn.disabled=false; btn.className='btn btn-sm plan-btn btn-primary'; }
  });
}
function initTienda(){
  document.querySelectorAll('.seg-tienda').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.seg-tienda').forEach(b=>b.classList.remove('active')); btn.classList.add('active');
    const isApp = btn.dataset.target==='tienda-app';
    document.getElementById('tienda-app').style.display = isApp?'block':'none';
    document.getElementById('tienda-kits').style.display = isApp?'none':'block';
  }));
  document.querySelectorAll('.plan-btn').forEach(btn => btn.addEventListener('click', () => {
    const plan = btn.dataset.plan;
    if (plan === 'free' || plan === appState.plan) return; // no se "compra" el gratis ni el actual
    beginPurchase(plan);
  }));
  document.querySelectorAll('.kit-btn').forEach(btn => btn.addEventListener('click', () => {
    appState.myOrders.push({ name: btn.dataset.kit, ts: new Date() });
    btn.textContent = '✓ Pedido realizado'; setTimeout(()=>{ btn.textContent='Comprar'; }, 1400);
  }));
}

/* ---- Perfil ---- */
function renderPerfil(){
  if (!appState.userName) { document.getElementById('perfilOnboard').style.display='block'; document.getElementById('perfilMain').style.display='none'; return; }
  document.getElementById('perfilOnboard').style.display='none'; document.getElementById('perfilMain').style.display='block';
  document.getElementById('avatarCircle').textContent = appState.userName.trim()[0]?.toUpperCase() || '?';
  document.getElementById('profileName').textContent = appState.userName;
  document.getElementById('profilePlanTag').textContent = 'Plan ' + planLabel(appState.plan);
  document.getElementById('profilePlanVal').textContent = planLabel(appState.plan);
  document.getElementById('profileCubeCount').textContent = appState.myCubes.length;
  document.getElementById('profileOrderCount').textContent = appState.myOrders.length;
  const themeToggle = document.getElementById('themeToggle');
  if (themeToggle) themeToggle.checked = appState.theme === 'dark';
  // Botón del panel de administración: pista visual basada en el flag is_admin
  // que firma el backend (con fallback al correo). El acceso real lo valida el
  // servidor: las rutas /api/admin/* responden 403 a cualquier no-admin.
  const adminBtn = document.getElementById('openAdminBtn');
  if (adminBtn){
    const user = getCurrentUser();
    const isAdmin = !!user && (user.isAdmin === true || isAdminEmail(user.email));
    adminBtn.style.display = isAdmin ? 'flex' : 'none';
  }
  // Aviso de correo sin verificar (solo con sesión iniciada y email no verificado).
  const verifyNotice = document.getElementById('emailVerifyNotice');
  if (verifyNotice){
    const user = getCurrentUser();
    verifyNotice.style.display = (user && user.emailVerified === false) ? 'flex' : 'none';
  }
  // La sección de 2FA solo tiene sentido con sesión iniciada.
  const twoFATrigger = document.getElementById('twoFATrigger');
  if (twoFATrigger) twoFATrigger.style.display = getCurrentUser() ? 'flex' : 'none';
  const cubesList = document.getElementById('myCubesList');
  cubesList.innerHTML = appState.myCubes.length ? '' : '<div class="hint">Aún no has creado ningún cubo.</div>';
  appState.myCubes.slice().reverse().forEach(c => {
    const item = document.createElement('div'); item.className='mycube-item';
    item.innerHTML = `<div><div class="mt">Cubo ${c.tier}${c.hidden?' · oculto':''}</div></div><div class="mts">${c.ts.toLocaleTimeString()}</div>`;
    cubesList.appendChild(item);
  });
  const ordersList = document.getElementById('myOrdersList');
  ordersList.innerHTML = appState.myOrders.length ? '' : '<div class="hint">Aún no has pedido ningún kit.</div>';
  appState.myOrders.slice().reverse().forEach(o => {
    const item = document.createElement('div'); item.className='mycube-item';
    item.innerHTML = `<div><div class="mt">${o.name}</div></div><div class="mts">${o.ts.toLocaleTimeString()}</div>`;
    ordersList.appendChild(item);
  });
}
function initPerfil(){
  document.getElementById('goToTiendaBtn').addEventListener('click', () => showScreen('tienda'));
  document.getElementById('openAdminBtn').addEventListener('click', () => openAdmin());
  document.getElementById('themeToggle').addEventListener('change', e => setTheme(e.target.checked ? 'dark' : 'light'));

  document.getElementById('changePassTrigger').addEventListener('click', (e) => {
    document.getElementById('changePassBody').classList.toggle('show');
    e.currentTarget.classList.toggle('open');
  });
  document.getElementById('changePassBtn').addEventListener('click', async () => {
    const current = document.getElementById('currentPass').value;
    const next = document.getElementById('newPass').value;
    if (!current || !next){ showError('Completa ambos campos.'); return; }
    const btn = document.getElementById('changePassBtn');
    btn.disabled = true; const prev = btn.textContent; btn.innerHTML='<span class="spinner"></span> Guardando…';
    try{
      await changePassword(current, next);
      document.getElementById('currentPass').value=''; document.getElementById('newPass').value='';
      document.getElementById('changePassBody').classList.remove('show');
      document.getElementById('changePassTrigger').classList.remove('open');
      renderPerfil();
    } catch(e){ showError(e.message); }
    finally { btn.disabled=false; btn.textContent=prev; }
  });

  // Reenviar correo de verificación.
  const resendBtn = document.getElementById('resendVerifyBtn');
  if (resendBtn) resendBtn.addEventListener('click', async () => {
    resendBtn.disabled = true; const prev = resendBtn.textContent;
    resendBtn.innerHTML = '<span class="spinner"></span> Enviando…';
    try{ await authApi.resendVerification(); showToast('Correo de verificación enviado. Revisa tu bandeja.'); }
    catch(e){ showError(e.message || 'No se pudo enviar el correo.'); }
    finally{ resendBtn.disabled = false; resendBtn.textContent = prev; }
  });

  // ---- 2FA ----
  initTwoFactorUI();

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await logout();
    renderPerfil();
  });
}

/* ---- Verificación en dos pasos (perfil) ---- */
function initTwoFactorUI(){
  const trigger = document.getElementById('twoFATrigger');
  if (!trigger) return;
  const body = document.getElementById('twoFABody');
  const statusEl = document.getElementById('twoFAStatus');
  const setupEl = document.getElementById('twoFASetup');
  const startBtn = document.getElementById('twoFAStartBtn');
  const recoveryEl = document.getElementById('twoFARecovery');
  const disableEl = document.getElementById('twoFADisable');

  async function refresh(){
    setupEl.style.display = 'none';
    recoveryEl.style.display = 'none';
    disableEl.style.display = 'none';
    startBtn.style.display = 'none';
    statusEl.textContent = 'Cargando…';
    try{
      const st = await twoFactorApi.status();
      if (st.enabled){
        statusEl.textContent = `Activado ✓ · ${st.recoveryCodesLeft} códigos de recuperación sin usar.`;
        disableEl.style.display = 'block';
      } else {
        statusEl.textContent = 'Añade una capa extra de seguridad con una app autenticadora (Google Authenticator, Authy…).';
        startBtn.style.display = 'block';
      }
    } catch(e){ statusEl.textContent = e.message || 'No se pudo cargar el estado del 2FA.'; }
  }

  trigger.addEventListener('click', () => {
    const open = body.classList.toggle('show');
    trigger.classList.toggle('open', open);
    if (open) refresh();
  });

  startBtn.addEventListener('click', async () => {
    startBtn.disabled = true; const prev = startBtn.textContent;
    startBtn.innerHTML = '<span class="spinner"></span> Generando…';
    try{
      const data = await twoFactorApi.setup();
      document.getElementById('twoFAQr').src = data.qrDataUrl;
      document.getElementById('twoFASecret').textContent = data.secret;
      setupEl.style.display = 'block';
      startBtn.style.display = 'none';
      statusEl.textContent = 'Escanea el QR y escribe el código que muestra tu app.';
    } catch(e){ showError(e.message || 'No se pudo iniciar el 2FA.'); }
    finally{ startBtn.disabled = false; startBtn.textContent = prev; }
  });

  document.getElementById('twoFAEnableBtn').addEventListener('click', async () => {
    const code = document.getElementById('twoFACode').value.trim();
    if (!code){ showError('Escribe el código de 6 dígitos.'); return; }
    const btn = document.getElementById('twoFAEnableBtn');
    btn.disabled = true; const prev = btn.textContent; btn.innerHTML = '<span class="spinner"></span> Activando…';
    try{
      const { recoveryCodes } = await twoFactorApi.enable(code);
      setupEl.style.display = 'none';
      document.getElementById('twoFACode').value = '';
      recoveryEl.style.display = 'block';
      recoveryEl.innerHTML = `
        <div class="hint" style="margin-bottom:6px;">✅ 2FA activado. Guarda estos códigos de recuperación en un lugar seguro (cada uno sirve una sola vez):</div>
        <div class="card" style="padding:12px 16px;font-family:monospace;line-height:1.9;">${recoveryCodes.map(c => `<div>${c}</div>`).join('')}</div>`;
      showToast('Verificación en dos pasos activada.');
      // Refresca la sesión para reflejar twoFactorEnabled.
      try{ await authApi.me(); }catch(_){ /* no crítico */ }
    } catch(e){ showError(e.message || 'Código incorrecto.'); }
    finally{ btn.disabled = false; btn.textContent = prev; }
  });

  document.getElementById('twoFADisableBtn').addEventListener('click', async () => {
    const pass = document.getElementById('twoFADisablePass').value;
    if (!pass){ showError('Confirma tu contraseña.'); return; }
    const btn = document.getElementById('twoFADisableBtn');
    btn.disabled = true; const prev = btn.textContent; btn.innerHTML = '<span class="spinner"></span> Desactivando…';
    try{
      await twoFactorApi.disable(pass);
      document.getElementById('twoFADisablePass').value = '';
      showToast('Verificación en dos pasos desactivada.');
      await refresh();
    } catch(e){ showError(e.message || 'No se pudo desactivar el 2FA.'); }
    finally{ btn.disabled = false; btn.textContent = prev; }
  });
}

/* ---- Service Worker (PWA) ---- */
function registerServiceWorker(){
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* sin SW la app sigue funcionando */ });
  });
}

/* ---- Bootstrap ---- */
function initApp(){
  applyTheme();
  loadArgon2(); // en segundo plano, no bloqueante: si falla o tarda, buildPayload usa PBKDF2
  initNavigation();
  initCamera();
  initLiveScanner();
  let prevScreen = 'inicio';
  onScreenChange(name => {
    if (name==='perfil') renderPerfil();
    if (name==='camara'){ resetCameraScreen(); startLiveScanner(); }
    if (prevScreen==='camara' && name!=='camara'){ stopLiveScanner(); stopShareScanner(); }
    prevScreen = name;
  });

  document.getElementById('miniInput').addEventListener('input', e => {
    clearTimeout(miniPreviewDebounce);
    miniPreviewDebounce = setTimeout(() => updateMiniPreview(e.target.value), 150);
  });
  updateMiniPreview('');
  const useGrid = document.querySelector('.use-grid');
  if (useGrid) applyStagger(useGrid);

  initCrearSegmented();
  initTierChips();
  initFileAttach();
  initHiddenToggle();
  initHiddenLock();
  initBovedaLock();
  initGenerate();
  initResultView();
  initShamirSplit();
  refreshTierLocks(); updateSecretCounter();

  initTienda();
  refreshPlanButtons();

  initPerfil();
  initAdmin();
  initAuthUI();
  // Cuando cambia la sesión/plan (login, logout, compra), refresca toda la UI dependiente.
  setOnAuthChange(() => {
    refreshPlanButtons(); refreshTierLocks(); syncHiddenToggleWithPlan();
    updateSecretCounter(); renderPerfil();
  });
  initAuth(); // restaura sesión y procesa retorno de pago (async, no bloquea el arranque)

  registerServiceWorker();
}
initApp();
