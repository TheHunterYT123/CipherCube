'use strict';
/* =========================================================
   APP — bootstrap + pantallas Inicio, Crear, Tienda, Perfil.
   Orquesta crypto.js/plans.js/storage.js/ui.js; la pantalla
   Descifrar vive en camera.js.
   ========================================================= */
import {
  TIERS, MAGIC, SHARE_GRID, SHAMIR_MAGIC, PALETTE,
  effectiveCapacityForGrid, slotPlaintextLenForCapacity, capacityBytesForGrid,
  buildPayload, rsEncodePayloadToRaw, payloadToColorIndices, drawCubeNet,
  composeSecretPayload, splitSecret, shareToPayload,
} from './crypto.js';
import { planAllows, planLabel, PLAN_REQUIREMENT_LABEL } from './plans.js';
import { appState, addCubeToHistory, resetHistory } from './storage.js';
import {
  initNavigation, showScreen, onScreenChange, applyTheme, setTheme,
  showToast, showError, armLockZone, openSheet, closeSheet, applyStagger,
} from './ui.js';
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
  }
}
function initTierChips(){
  document.querySelectorAll('#tierOptions .chip').forEach(chip => chip.addEventListener('click', () => {
    const locked = (chip.dataset.tier==='estandar' && !planAllows('standard_tier')) || (chip.dataset.tier==='pro' && !planAllows('pro_tier'));
    if (locked) { showError(`La capacidad ${chip.dataset.tier==='estandar'?'Estándar':'Pro'} requiere el plan ${PLAN_REQUIREMENT_LABEL.standard_tier}.`); return; }
    document.querySelectorAll('#tierOptions .chip').forEach(c=>c.classList.remove('selected'));
    chip.classList.add('selected'); selectedTier = chip.dataset.tier;
    updateSecretCounter();
  }));
}

/* ---- Crear > Cubo: archivos adjuntos + contador de capacidad ---- */
let attachedSecretFiles = [];
function maxSecretBytesForSelectedTier(){
  const usable = effectiveCapacityForGrid(TIERS[selectedTier].grid).usable;
  return slotPlaintextLenForCapacity(usable) - 2;
}
function updateSecretCounter(){
  const counterEl = document.getElementById('secretCounter');
  const attachHint = document.getElementById('attachHint');
  try{
    const usable = effectiveCapacityForGrid(TIERS[selectedTier].grid).usable;
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
    if (!realPass || realPass.length<6) { showError('Tu frase maestra debe tener al menos 6 caracteres.'); return; }
    if (hiddenEnabled && (!decoyPass || decoyPass.length<6)) { showError('Define una frase señuelo de al menos 6 caracteres.'); return; }
    if (hiddenEnabled && decoyPass===realPass) { showError('La frase señuelo debe ser distinta de la real.'); return; }
    btn.disabled=true; btn.innerHTML='<span class="spinner"></span> Cifrando…';
    try{
      const built = await buildPayload({ secretText, realPass, hiddenEnabled, decoyPass, decoyText, tier: selectedTier });
      const rawBytes = rsEncodePayloadToRaw(built.payload, built.grid);
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

function initResultView(){
  document.getElementById('downloadBtn').addEventListener('click', () => {
    if (!lastGenerated) return;
    const link=document.createElement('a');
    link.download=`ciphercube-${lastGenerated.tier}.png`;
    link.href=lastGenerated.canvas.toDataURL('image/png');
    link.click();
  });
  document.getElementById('download3dBtn').addEventListener('click', () => {
    if (!lastGenerated) return;
    const sheet = buildFaceSheetCanvas(lastGenerated.indices, lastGenerated.grid);
    const link = document.createElement('a');
    link.download = `ciphercube-${lastGenerated.tier}-caras3d.png`;
    link.href = sheet.toDataURL('image/png');
    link.click();
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
        const dl3dBtn = document.createElement('button'); dl3dBtn.textContent='Descargar caras 3D';
        item.appendChild(canvas); item.appendChild(lbl); item.appendChild(dlBtn); item.appendChild(dl3dBtn); list.appendChild(item);
        drawCubeNet(canvas, indices, SHARE_GRID);
        dlBtn.addEventListener('click', () => { const link=document.createElement('a'); link.download=`ciphercube-parte-${share.index}-de-${n}.png`; link.href=canvas.toDataURL('image/png'); link.click(); });
        dl3dBtn.addEventListener('click', () => {
          const sheet = buildFaceSheetCanvas(indices, SHARE_GRID);
          const link = document.createElement('a');
          link.download = `ciphercube-parte-${share.index}-de-${n}-caras3d.png`;
          link.href = sheet.toDataURL('image/png');
          link.click();
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
    appState.plan = btn.dataset.plan;
    refreshPlanButtons(); refreshTierLocks(); syncHiddenToggleWithPlan();
    updateSecretCounter();
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
  document.getElementById('onboardSaveBtn').addEventListener('click', () => {
    const name = document.getElementById('onboardName').value.trim();
    if (!name) return;
    appState.userName = name; renderPerfil();
  });
  document.getElementById('goToTiendaBtn').addEventListener('click', () => showScreen('tienda'));
  document.getElementById('themeToggle').addEventListener('change', e => setTheme(e.target.checked ? 'dark' : 'light'));
  document.getElementById('resetSessionBtn').addEventListener('click', () => {
    appState.userName=null; appState.plan='free'; appState.myOrders=[];
    resetHistory();
    refreshPlanButtons(); refreshTierLocks(); syncHiddenToggleWithPlan(); updateSecretCounter(); renderPerfil();
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

  registerServiceWorker();
}
initApp();
