/* =========================================================
 * ezScan — Document Scanner & OCR (100% client-side)
 * ---------------------------------------------------------
 * Alur: Capture (multi-halaman) → Crop & Filter (per halaman)
 *       → OCR sekuensial (Web Worker) → PDF searchable
 *       (invisible text overlay) → Auto-download + Preview + ZIP
 * ========================================================= */
'use strict';

/* ---------------- Konstanta optimasi ---------------- */
const MAX_DIM             = 2000;   // downsampling maks lebar/tinggi (anti-crash mobile)
const JPEG_EXPORT_QUALITY = 0.78;   // kompresi gambar di dalam PDF (ukuran kecil, teks tajam)
const JPEG_STORE_QUALITY  = 0.92;   // kualitas simpan sementara di memori (source & preview)
const OCR_LANGS           = 'ind+eng';
const MIN_WORD_CONFIDENCE = 35;     // buang kata hasil OCR yang terlalu tidak yakin
const A4_PT               = { w: 595.28, h: 841.89 }; // PDF points @72 DPI

/* ---------------- Referensi DOM ---------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const video          = $('#video');
const cameraFrame    = $('#cameraFrame');
const cameraOverlay  = $('#cameraOverlay');
const cameraOverlayText = $('#cameraOverlayText');
const btnStartCamera = $('#btnStartCamera');
const camStatus      = $('#camStatus');
const fpsChip        = $('#fpsChip');
const btnShutter     = $('#btnShutter');
const btnSwitchCam   = $('#btnSwitchCam');
const fileInput      = $('#fileInput');

const thumbGrid      = $('#thumbGrid');
const emptyHint      = $('#emptyHint');
const pageCountChip  = $('#pageCountChip');
const btnToCrop      = $('#btnToCrop');

const btnBackCapture = $('#btnBackCapture');
const cropPageLabel  = $('#cropPageLabel');
const btnPrevPage    = $('#btnPrevPage');
const btnNextPage    = $('#btnNextPage');
const filterSeg      = $('#filterSeg');
const btnResetCrop   = $('#btnResetCrop');
const btnApplyCrop   = $('#btnApplyCrop');
const cropImage      = $('#cropImage');
const cropSpinner    = $('#cropSpinner');
const cropRail       = $('#cropRail');
const btnAddMore     = $('#btnAddMore');
const btnExport      = $('#btnExport');

const procTitle      = $('#procTitle');
const procStatus     = $('#procStatus');
const procPercent    = $('#procPercent');
const procBarFill    = $('#procBarFill');
const procList       = $('#procList');
const btnCancelProc  = $('#btnCancelProc');
const procIcon       = $('#procIcon');

const resultMeta     = $('#resultMeta');
const pdfFrame       = $('#pdfFrame');
const pdfOpenTab     = $('#pdfOpenTab');
const btnDownloadPdf = $('#btnDownloadPdf');
const btnSplitZip    = $('#btnSplitZip');
const btnNewScan     = $('#btnNewScan');
const toasts         = $('#toasts');

/* ---------------- State aplikasi ---------------- */
const state = {
  screen: 'capture',
  pages: [],            // { id, source, filter, filterCache, ocrWords, ocrText, exportImage, exportW, exportH }
  nextPageId: 1,
  cropIndex: 0,
  cropToken: 0,         // guard untuk operasi async pada cropper
  restoreCrop: null,    // restore posisi crop box setelah cropper.replace()
  cropDirty: false,
  cropper: null,
  stream: null,
  facing: 'environment',
  camError: false,
  filterMode: 'bw',     // default: binarisasi (sesuai spesifikasi)
  worker: null,
  ocrActiveIndex: -1,
  processing: false,
  cancelRequested: false,
  pdfBlob: null,
  pdfURL: null,
  pdfName: '',
};

/* =========================================================
 * UTILITAS
 * ========================================================= */
function toast(message, type = 'ok', ms = 3200) {
  const icons = { ok: 'fa-circle-check', warn: 'fa-triangle-exclamation', err: 'fa-circle-xmark' };
  const el = document.createElement('div');
  el.className = `ez-toast ${type}`;
  el.innerHTML = `<i class="fa-solid ${icons[type] || icons.ok}"></i><span></span>`;
  el.querySelector('span').textContent = message;
  toasts.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, ms);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Gagal memuat gambar.'));
    img.src = src;
  });
}

/* Memory cleanup: bebaskan backing store canvas (spec: canvas.width = 0) */
function freeCanvas(canvas) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

function tick(ms = 0) { return new Promise((r) => setTimeout(r, ms)); }

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function throwIfCancelled() {
  if (state.cancelRequested) throw new Error('cancelled');
}

/* Baling-baling promise yang bisa dibatalkan (worker.terminate membuat
   promise recognize tidak pernah settle — kita race dengan flag cancel). */
function raceCancel(promise) {
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (state.cancelRequested) { clearInterval(timer); reject(new Error('cancelled')); }
    }, 150);
    promise.then(
      (v) => { clearInterval(timer); resolve(v); },
      (e) => { clearInterval(timer); reject(e); }
    );
  });
}

/* Downsample gambar apa pun ke maks MAX_DIM px ( anti OOM untuk foto 4K/48MP ) */
function downscaleToCanvas(img, maxDim = MAX_DIM) {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const scale = Math.min(1, maxDim / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/* =========================================================
 * FILTER GAMBAR
 * ========================================================= */

/* Binarization — Adaptive Thresholding (Bradley, integral image O(n)).
   Menghilangkan bayangan & memutihkan kertas → kontras hitam-putih tajam. */
function binarizeCanvas(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const w = canvas.width, h = canvas.height;
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;
  const n = w * h;

  // 1) Grayscale cepat (koefisien integer, >> 8)
  const gray = new Uint8ClampedArray(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    gray[p] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  }

  // 2) Integral image (Uint32 aman: 2000×2000×255 ≈ 1.02e9 < 2^32)
  const iw = w + 1;
  const integral = new Uint32Array(iw * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += gray[y * w + x];
      integral[(y + 1) * iw + (x + 1)] = integral[y * iw + (x + 1)] + rowSum;
    }
  }

  // 3) Threshold lokal: hitam jika piksel < 86% rata-rata jendela lokalnya
  const win = Math.max(15, Math.round(Math.min(w, h) / 14));
  const half = win >> 1;
  const T = 0.86;
  for (let y = 0; y < h; y++) {
    const rowTop = Math.max(0, y - half) * iw;              // baris atas jendela (offset integral)
    const rowBot = (Math.min(h - 1, y + half) + 1) * iw;    // baris bawah jendela (eksklusif)
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - half);
      const x1 = Math.min(w - 1, x + half) + 1;             // kolom kanan jendela (eksklusif)
      const count = (x1 - x0) * (rowBot - rowTop) / iw;
      const sum = integral[rowBot + x1] - integral[rowTop + x1] - integral[rowBot + x0] + integral[rowTop + x0];
      const g = gray[y * w + x];
      const v = g * count < sum * T ? 0 : 255;
      const i = (y * w + x) << 2;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
  ctx.putImageData(imgData, 0, 0);
}

/* Color Enhanced — kontras + kecerahan + saturasi via LUT per-piksel (cross-browser) */
function enhanceCanvas(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = imgData.data;
  const CONTRAST = 1.24, BRIGHT = 8, SAT = 0.12;
  for (let i = 0; i < d.length; i += 4) {
    const r = (d[i] - 128) * CONTRAST + 128 + BRIGHT;
    const g = (d[i + 1] - 128) * CONTRAST + 128 + BRIGHT;
    const b = (d[i + 2] - 128) * CONTRAST + 128 + BRIGHT;
    const avg = (r + g + b) / 3;
    d[i]     = r + (r - avg) * SAT;   // Uint8ClampedArray meng-clamp otomatis
    d[i + 1] = g + (g - avg) * SAT;
    d[i + 2] = b + (b - avg) * SAT;
  }
  ctx.putImageData(imgData, 0, 0);
}

function applyFilterToCanvas(canvas, mode) {
  if (mode === 'bw') binarizeCanvas(canvas);
  else if (mode === 'enhanced') enhanceCanvas(canvas);
}

/* Versi ter-filter (dataURL) untuk preview cropper — dengan cache per halaman */
async function getFilteredImage(page, mode) {
  if (mode === 'original') return page.source;
  if (!page.filterCache) page.filterCache = {};
  if (page.filterCache[mode]) return page.filterCache[mode];
  const img = await loadImage(page.source);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0);
  applyFilterToCanvas(canvas, mode);
  const url = canvas.toDataURL('image/jpeg', JPEG_STORE_QUALITY);
  freeCanvas(canvas);
  page.filterCache[mode] = url;
  return url;
}

/* =========================================================
 * KAMERA (constraint FPS 20–25)
 * ========================================================= */
function setCamStatus(text, cls = 'bg-ink/5 text-ink/50') {
  camStatus.className = `chip ${cls}`;
  camStatus.innerHTML = `<i class="fa-regular fa-clock"></i> ${text}`;
}

async function startCamera() {
  if (state.stream) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showCameraError('Browser ini tidak mendukung akses kamera (MediaDevices). Silakan unggah gambar.');
    return;
  }
  setCamStatus('Meminta izin…', 'bg-amber-100 text-amber-600');
  const base = {
    audio: false,
    video: {
      facingMode: { ideal: state.facing },
      width: { ideal: 1920 },
      height: { ideal: 1440 },
    },
  };
  let stream = null;
  try {
    // Constraint wajib: preview dikunci 20–25 FPS (hemat RAM/baterai)
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        ...base,
        video: { ...base.video, frameRate: { ideal: 22.5, min: 20, max: 25 } },
      });
    } catch (err) {
      if (err && err.name === 'OverconstrainedError') {
        // Fallback untuk perangkat yang tidak punya rentang 20–25 fps
        stream = await navigator.mediaDevices.getUserMedia({
          ...base,
          video: { ...base.video, frameRate: { ideal: 22.5 } },
        });
        fpsChip.innerHTML = '<i class="fa-solid fa-bolt mr-1 text-brand-300"></i>FPS optimal';
      } else {
        throw err;
      }
    }

    state.stream = stream;
    state.camError = false;
    video.srcObject = stream;
    video.play().catch(() => {});
    cameraOverlay.style.display = 'none';
    btnShutter.disabled = false;

    const settings = stream.getVideoTracks()[0].getSettings();
    const fps = settings && settings.frameRate ? Math.round(settings.frameRate) : null;
    setCamStatus(`Aktif${fps ? ` · ${fps} FPS` : ''}`, 'bg-emerald-100 text-emerald-600');
  } catch (err) {
    console.error('Camera error:', err);
    showCameraError(
      err && err.name === 'NotAllowedError'
        ? 'Izin kamera ditolak. Izinkan akses kamera di browser, atau gunakan unggah gambar.'
        : 'Kamera tidak dapat diaktifkan di perangkat ini. Gunakan unggah gambar.'
    );
  }
}

function showCameraError(message) {
  state.camError = true;
  state.stream = null;
  btnShutter.disabled = true;
  cameraOverlayText.textContent = message;
  cameraOverlay.style.display = '';
  setCamStatus('Tidak aktif', 'bg-red-100 text-red-500');
}

function stopCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  video.srcObject = null;
  if (state.screen !== 'capture') return;
  btnShutter.disabled = true;
  setCamStatus('Idle');
}

async function switchCamera() {
  state.facing = state.facing === 'environment' ? 'user' : 'environment';
  stopCamera();
  await startCamera();
}

/* Ambil frame video → downsample ≤2000px → simpan sebagai halaman */
function capturePhoto() {
  if (!state.stream || !video.videoWidth) return;
  // efek kilat
  cameraFrame.classList.remove('flash-active');
  void cameraFrame.offsetWidth; // restart animasi
  cameraFrame.classList.add('flash-active');

  const scale = Math.min(1, MAX_DIM / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0, canvas.width, canvas.height);
  const dataURL = canvas.toDataURL('image/jpeg', JPEG_STORE_QUALITY);
  freeCanvas(canvas);
  addPage(dataURL);
}

/* =========================================================
 * MANAJEMEN HALAMAN
 * ========================================================= */
function addPage(sourceDataURL) {
  state.pages.push({
    id: state.nextPageId++,
    source: sourceDataURL,
    filter: state.filterMode,
    filterCache: {},
    ocrWords: null,
    ocrText: '',
    exportImage: null,
    exportW: 0,
    exportH: 0,
  });
  syncPageUI();
}

async function handleFiles(fileList) {
  const files = Array.from(fileList).filter((f) => f.type && f.type.startsWith('image/'));
  if (!files.length) {
    toast('File tidak didukung — pilih berkas gambar.', 'warn');
    return;
  }
  toast(`Menambahkan ${files.length} gambar…`, 'ok', 1600);
  for (const file of files) {
    const objectURL = URL.createObjectURL(file);
    try {
      const img = await loadImage(objectURL);
      const canvas = downscaleToCanvas(img); // ≤ 2000px
      const dataURL = canvas.toDataURL('image/jpeg', JPEG_STORE_QUALITY);
      freeCanvas(canvas);
      addPage(dataURL);
    } catch (e) {
      console.error(e);
      toast(`Gagal membaca "${file.name}".`, 'err');
    } finally {
      URL.revokeObjectURL(objectURL); // memory cleanup object URL
    }
  }
  fileInput.value = '';
}

function deletePage(index) {
  state.pages.splice(index, 1);
  if (state.screen === 'crop') {
    if (!state.pages.length) { gotoScreen('capture'); return; }
    state.cropIndex = Math.min(state.cropIndex, state.pages.length - 1);
    showCropPage(state.cropIndex);
  }
  syncPageUI();
  toast(`Halaman ${index + 1} dihapus.`, 'warn', 2000);
}

/* =========================================================
 * RENDER UI (thumbnails, counter, stepper)
 * ========================================================= */
function renderThumbGrid() {
  thumbGrid.innerHTML = state.pages.map((p, i) => `
    <div class="group relative overflow-hidden rounded-xl border border-brand-100 bg-white shadow-sm">
      <img src="${p.source}" class="aspect-[3/4] w-full cursor-pointer object-cover transition group-hover:opacity-90"
           data-open="${i}" alt="Halaman ${i + 1}" />
      <span class="absolute left-1 top-1 rounded-md bg-ink/70 px-1.5 py-0.5 text-[10px] font-bold text-white">${i + 1}</span>
      <button data-del="${i}" aria-label="Hapus halaman ${i + 1}"
              class="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-md bg-ink/70 text-white transition hover:!bg-red-500">
        <i class="fa-solid fa-xmark text-[11px]"></i>
      </button>
      ${p.filter === 'bw' ? '<span class="absolute bottom-1 left-1 rounded bg-brand-500/90 px-1 py-0.5 text-[8px] font-bold text-white">B&W</span>' : ''}
    </div>`).join('');
  emptyHint.classList.toggle('hidden', state.pages.length > 0);
}

function renderCropRail() {
  cropRail.innerHTML = state.pages.map((p, i) => `
    <button data-rail="${i}"
      class="relative shrink-0 overflow-hidden rounded-lg border-2 transition
             ${i === state.cropIndex ? 'border-brand-500 ring-2 ring-brand-200' : 'border-brand-100 opacity-70 hover:opacity-100'}">
      <img src="${p.source}" class="h-16 w-12 object-cover" alt="Halaman ${i + 1}" />
      <span class="absolute bottom-0 left-0 right-0 bg-ink/70 text-center text-[9px] font-bold text-white">${i + 1}</span>
    </button>`).join('');
}

function syncPageUI() {
  const n = state.pages.length;
  pageCountChip.innerHTML = `<i class="fa-solid fa-files"></i> ${n} Halaman${n ? ' Ditangkap' : ''}`;
  btnToCrop.disabled = n === 0;
  btnExport.disabled = n === 0;
  cropPageLabel.textContent = n ? `Halaman ${state.cropIndex + 1}/${n}` : 'Halaman 0/0';
  btnPrevPage.disabled = state.cropIndex <= 0;
  btnNextPage.disabled = state.cropIndex >= n - 1;
  renderThumbGrid();
  if (state.screen === 'crop') renderCropRail();
}

function updateSteps(screenName) {
  const map = { capture: 1, crop: 2, process: 3, result: 4 };
  const current = map[screenName] || 1;
  $$('#stepper .step').forEach((el) => {
    const s = Number(el.dataset.step);
    el.classList.toggle('active', s === current);
    el.classList.toggle('done', s < current);
  });
  $$('#stepper .step-line').forEach((el, idx) => {
    el.classList.toggle('done', idx + 1 < current);
  });
}

function gotoScreen(name) {
  if (state.screen === name) return;
  if (state.screen === 'capture' && name !== 'capture') stopCamera();
  state.screen = name;
  $$('.screen').forEach((s) => s.classList.add('hidden'));
  const target = $(`#screen-${name}`);
  target.classList.remove('hidden');
  // restart animasi fade
  target.style.animation = 'none';
  void target.offsetWidth;
  target.style.animation = '';
  updateSteps(name);
  window.scrollTo({ top: 0 });

  if (name === 'capture' && !state.stream && !state.camError) startCamera();
  if (name === 'crop') showCropPage(state.cropIndex);
}

/* =========================================================
 * SCREEN 2 — CROP & FILTER (Cropper.js)
 * ========================================================= */
function destroyCropper() {
  if (state.cropper) {
    try { state.cropper.destroy(); } catch (_) { /* noop */ }
    state.cropper = null;
  }
  state.cropDirty = false;
}

function initCropper(src) {
  destroyCropper();
  cropImage.onload = () => {
    if (typeof Cropper === 'undefined') {
      toast('Pustaka Cropper.js gagal dimuat. Periksa koneksi internet lalu muat ulang.', 'err');
      return;
    }
    state.cropper = new Cropper(cropImage, {
      viewMode: 1,
      dragMode: 'crop',
      autoCrop: true,
      autoCropArea: 1.0,      // crop box awal mencakup seluruh gambar
      background: false,
      responsive: true,
      restore: false,
      guides: true,
      center: false,
      highlight: false,
      rotatable: false,
      scalable: false,
      zoomable: true,
      zoomOnWheel: true,
      toggleDragModeOnDblclick: false,
      minCropBoxWidth: 40,
      minCropBoxHeight: 40,
      ready() {
        // restore crop box setelah ganti sumber gambar (toggle filter)
        if (state.restoreCrop) {
          try { this.setData(state.restoreCrop); state.cropDirty = true; } catch (_) { /* noop */ }
          state.restoreCrop = null;
        }
      },
      cropend() { state.cropDirty = true; },
      zoom() { state.cropDirty = true; },
    });
  };
  cropImage.src = src;
}

function setCropSpinner(show) {
  cropSpinner.style.display = show ? 'grid' : 'none';
}

function syncFilterSeg(mode) {
  $$('#filterSeg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.filter === mode));
}

async function showCropPage(index) {
  if (!state.pages.length) { gotoScreen('capture'); return; }
  index = Math.max(0, Math.min(state.pages.length - 1, index));
  const token = ++state.cropToken;
  state.cropIndex = index;
  const page = state.pages[index];

  // hemat RAM: buang cache filter halaman yang tidak sedang dilihat
  state.pages.forEach((p, i) => { if (i !== index) p.filterCache = {}; });

  syncPageUI();
  syncFilterSeg(page.filter);
  setCropSpinner(true);
  try {
    const src = await getFilteredImage(page, page.filter);
    if (token !== state.cropToken) return;
    initCropper(src);
  } catch (e) {
    console.error(e);
    toast('Gagal menyiapkan gambar halaman.', 'err');
  } finally {
    if (token === state.cropToken) setCropSpinner(false);
  }
}

async function setFilterMode(mode) {
  const page = state.pages[state.cropIndex];
  if (!page || page.filter === mode) { syncFilterSeg(page ? page.filter : mode); return; }
  page.filter = mode;
  state.filterMode = mode; // jadi default untuk halaman berikutnya
  syncFilterSeg(mode);
  setCropSpinner(true);
  const token = state.cropToken;
  try {
    const src = await getFilteredImage(page, mode);
    if (token !== state.cropToken) return;
    if (state.cropper) {
      // pertahankan posisi crop box saat preview filter berganti
      state.restoreCrop = state.cropDirty ? state.cropper.getData(true) : null;
      state.cropper.replace(src);
    } else {
      initCropper(src);
    }
  } catch (e) {
    console.error(e);
    toast('Gagal menerapkan filter.', 'err');
  } finally {
    if (token === state.cropToken) setCropSpinner(false);
  }
}

/* Terapkan crop: koordinat getData() adalah koordinat gambar asli
   (dimensi identik dengan versi ter-filter), sehingga pemotongan
   selalu dilakukan pada SUMBER asli agar warna tidak hilang. */
async function applyCropToPage(index, { interactive = false } = {}) {
  const page = state.pages[index];
  if (!page || !state.cropper || !state.cropDirty) return false;
  const d = state.cropper.getData(true);
  if (!d || d.width < 8 || d.height < 8) return false;
  try {
    const img = await loadImage(page.source);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(d.width);
    canvas.height = Math.round(d.height);
    canvas.getContext('2d', { willReadFrequently: true })
      .drawImage(img, d.x, d.y, d.width, d.height, 0, 0, canvas.width, canvas.height);
    page.source = canvas.toDataURL('image/jpeg', JPEG_STORE_QUALITY);
    page.filterCache = {}; // cache filter tidak valid lagi
    freeCanvas(canvas);
    state.cropDirty = false;
    syncPageUI();
    if (interactive) {
      toast(`Crop halaman ${index + 1} diterapkan.`, 'ok', 2000);
      await showCropPage(index);
    }
    return true;
  } catch (e) {
    console.error(e);
    toast('Gagal menerapkan crop.', 'err');
    return false;
  }
}

/* =========================================================
 * SCREEN 3 — PIPELINE: PREPARE → OCR SEKUENSIAL (WEB WORKER)
 * ========================================================= */
function humanizeTessStatus(status) {
  const map = {
    'loading tesseract core': 'Memuat mesin OCR (WASM core)…',
    'initializing tesseract': 'Inisialisasi mesin OCR…',
    'loading language traineddata': 'Memuat data bahasa ind+eng (sekali saja)…',
    'initializing api': 'Menyiapkan API OCR…',
  };
  return map[status] || 'Menyiapkan mesin OCR…';
}

async function ensureWorker() {
  if (state.worker) return state.worker;
  if (typeof Tesseract === 'undefined') throw new Error('Pustaka Tesseract.js gagal dimuat. Periksa koneksi internet.');
  state.worker = await Tesseract.createWorker(OCR_LANGS, 1, { logger: onOcrLog });
  try { await state.worker.setParameters({ preserve_interword_spaces: '1' }); } catch (_) { /* noop */ }
  return state.worker;
}

function onOcrLog(m) {
  if (!state.processing || !m) return;
  const n = state.pages.length;
  if (m.status === 'recognizing text' && state.ocrActiveIndex >= 0) {
    const i = state.ocrActiveIndex;
    const frac = 0.08 + 0.92 * (i + 0.15 + 0.85 * (m.progress || 0)) / n;
    setProgress(frac, `Memproses OCR halaman ${i + 1} dari ${n}…`);
    updateRowOcr(i, m.progress || 0);
  } else if (m.progress != null && state.ocrActiveIndex < 0) {
    setProgress(0.02 + 0.06 * m.progress, humanizeTessStatus(m.status));
  }
}

/* Kumpulkan kata + bounding box dari hierarki blok Tesseract v5
   (fallback ke data.words untuk API v4). */
function collectWords(data) {
  const words = [];
  if (data && Array.isArray(data.blocks)) {
    for (const block of data.blocks) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          for (const word of line.words || []) words.push(word);
        }
      }
    }
  } else if (data && Array.isArray(data.words)) {
    words.push(...data.words);
  }
  return words.filter(
    (w) => w && w.bbox && typeof w.text === 'string' && w.text.trim() &&
      (w.confidence == null || w.confidence >= MIN_WORD_CONFIDENCE)
  );
}

/* Prepare satu halaman: filter → JPEG 0.78 untuk PDF & OCR */
async function preparePage(page) {
  const img = await loadImage(page.source);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  applyFilterToCanvas(canvas, page.filter);
  const jpeg = canvas.toDataURL('image/jpeg', JPEG_EXPORT_QUALITY);
  const out = { jpeg, w: canvas.width, h: canvas.height };
  freeCanvas(canvas); // memory cleanup
  return out;
}

function buildProcList() {
  procList.innerHTML = state.pages.map((p, i) => `
    <li id="proc-row-${i}" class="flex items-center gap-3 rounded-xl border border-brand-100 bg-white/70 px-3 py-2">
      <img src="${p.source}" class="h-12 w-9 shrink-0 rounded-md border border-brand-100 object-cover" alt="" />
      <div class="min-w-0 flex-1">
        <p class="text-sm font-extrabold">Halaman ${i + 1}</p>
        <p id="proc-sub-${i}" class="truncate text-xs font-medium text-ink/50">Menunggu…</p>
      </div>
      <span id="proc-badge-${i}" class="chip bg-ink/5 text-ink/40"><i class="fa-regular fa-clock"></i></span>
    </li>`).join('');
}

function setRowState(i, st, extraText = '') {
  const badge = $(`#proc-badge-${i}`);
  const sub = $(`#proc-sub-${i}`);
  if (!badge || !sub) return;
  if (st === 'prep') {
    badge.className = 'chip bg-brand-50 text-brand-600';
    badge.innerHTML = '<i class="fa-solid fa-crop-simple"></i>';
    sub.textContent = 'Menerapkan crop & filter…';
  } else if (st === 'ocr') {
    badge.className = 'chip bg-brand-100 text-brand-700';
    badge.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i>';
    sub.textContent = 'OCR berjalan…';
  } else if (st === 'done') {
    badge.className = 'chip bg-emerald-100 text-emerald-600';
    badge.innerHTML = '<i class="fa-solid fa-check"></i>';
    sub.textContent = extraText || 'Selesai';
  }
}

function updateRowOcr(i, progress) {
  const sub = $(`#proc-sub-${i}`);
  if (sub) sub.textContent = `OCR berjalan… ${Math.round((progress || 0) * 100)}%`;
}

function setProgress(frac, text) {
  const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
  procBarFill.style.width = `${pct}%`;
  procPercent.textContent = `${pct}%`;
  if (text) procStatus.textContent = text;
}

/* =========================================================
 * SCREEN 4 — PDF SEARCHABLE (INVISIBLE TEXT) + ZIP
 * ========================================================= */
function pageGeometry(imgW, imgH) {
  // skala piksel → PDF points (72 DPI), proporsi dijaga, muat dalam A4
  const s = Math.min(A4_PT.w / imgW, A4_PT.h / imgH);
  return { pw: imgW * s, ph: imgH * s, s };
}

/* Sisipkan gambar + lapisan teks invisible (renderingMode 3) agar
   PDF searchable & copyable. Konversi koordinat Tesseract (origin
   kiri-ATAS, piksel) → PDF points (origin kiri-BAWAH). */
function addPageContent(doc, page) {
  const { pw, ph, s } = pageGeometry(page.exportW, page.exportH);
  doc.addImage(page.exportImage, 'JPEG', 0, 0, pw, ph, undefined, 'FAST');
  doc.setFont('helvetica', 'normal');
  const words = page.ocrWords || [];
  for (const word of words) {
    const text = word.text.trim();
    if (!text) continue;
    const { x0, y0, x1, y1 } = word.bbox;
    const boxHpt = (y1 - y0) * s;
    if (boxHpt < 1.2) continue;
    doc.setFontSize(boxHpt);                       // ukuran font ≈ tinggi bounding box
    const baseline = ph - y0 * s - boxHpt * 0.8;   // flip sumbu Y + offset baseline
    doc.text(text, x0 * s, baseline, { renderingMode: 'invisible' });
  }
}

function newPdfForPage(page) {
  if (!window.jspdf || !window.jspdf.jsPDF) throw new Error('Pustaka jsPDF gagal dimuat.');
  const { pw, ph } = pageGeometry(page.exportW, page.exportH);
  return new window.jspdf.jsPDF({
    orientation: pw > ph ? 'l' : 'p',
    unit: 'pt',
    format: [pw, ph],
    compress: true,
  });
}

/* Memory cleanup pasca-generate: canvas sementara sudah dibebaskan
   inline (freeCanvas); di sini bebaskan cropper + object URL lama. */
function cleanupMemory() {
  destroyCropper();
  cropImage.removeAttribute('src');
  if (state.pdfURL) { URL.revokeObjectURL(state.pdfURL); state.pdfURL = null; }
}

function showResult() {
  const totalWords = state.pages.reduce((acc, p) => acc + ((p.ocrWords && p.ocrWords.length) || 0), 0);
  state.pdfURL = URL.createObjectURL(state.pdfBlob);
  pdfFrame.src = state.pdfURL;
  pdfOpenTab.href = state.pdfURL;
  resultMeta.textContent =
    `${state.pdfName} · ${formatBytes(state.pdfBlob.size)} · ${state.pages.length} halaman · ${totalWords} kata terindeks`;
  btnSplitZip.disabled = false;
  gotoScreen('result');
  toast('PDF searchable selesai & terunduh otomatis.', 'ok', 4200);
}

/* ---------- Pipeline utama ---------- */
async function runPipeline() {
  if (state.processing || !state.pages.length) return;
  state.processing = true;
  state.cancelRequested = false;
  state.ocrActiveIndex = -1;
  stopCamera();
  await applyCropToPage(state.cropIndex); // crop halaman terakhir yang diedit
  gotoScreen('process');
  buildProcList();
  setProgress(0.01, 'Menyiapkan mesin OCR…');

  try {
    await ensureWorker();
    const n = state.pages.length;

    for (let i = 0; i < n; i++) {
      throwIfCancelled();
      const page = state.pages[i];
      setRowState(i, 'prep');
      setProgress(0.08 + 0.92 * (i + 0.05) / n, `Menerapkan crop & filter halaman ${i + 1}…`);
      const prep = await preparePage(page);
      page.exportImage = prep.jpeg;
      page.exportW = prep.w;
      page.exportH = prep.h;

      throwIfCancelled();
      setRowState(i, 'ocr');
      state.ocrActiveIndex = i;
      const { data } = await raceCancel(
        state.worker.recognize(prep.jpeg, {}, { blocks: true, text: true })
      );
      state.ocrActiveIndex = -1;
      page.ocrWords = collectWords(data);
      page.ocrText = (data && data.text) || '';
      setRowState(i, 'done', `${page.ocrWords.length} kata terdeteksi`);
      setProgress(0.08 + 0.92 * (i + 1) / n, `Halaman ${i + 1} selesai.`);
      await tick(30); // yield ke UI
    }

    throwIfCancelled();
    setProgress(0.985, 'Menyusun PDF searchable & mengompresi gambar…');
    await tick(60);

    // PDF utama: satu dokumen multi-halaman
    const doc = newPdfForPage(state.pages[0]);
    addPageContent(doc, state.pages[0]);
    for (let i = 1; i < n; i++) {
      const { pw, ph } = pageGeometry(state.pages[i].exportW, state.pages[i].exportH);
      doc.addPage([pw, ph], pw > ph ? 'l' : 'p');
      addPageContent(doc, state.pages[i]);
    }
    state.pdfName = `ezScan_${stamp()}.pdf`;
    state.pdfBlob = doc.output('blob');
    setProgress(1, 'Selesai!');

    saveAs(state.pdfBlob, state.pdfName); // AUTO-DOWNLOAD
    cleanupMemory();
    showResult();
  } catch (err) {
    const cancelled = err && err.message === 'cancelled';
    if (state.cancelRequested && state.worker) {
      try { await state.worker.terminate(); } catch (_) { /* noop */ }
      state.worker = null;
    }
    if (cancelled) {
      toast('Proses dibatalkan.', 'warn');
    } else {
      console.error(err);
      toast(`Gagal memproses: ${err && err.message ? err.message : err}`, 'err', 5000);
    }
    gotoScreen(state.pages.length ? 'crop' : 'capture');
  } finally {
    state.processing = false;
    state.ocrActiveIndex = -1;
  }
}

/* ---------- Split ZIP (satu PDF per halaman) ---------- */
async function buildSplitZip() {
  if (state.processing) return;
  if (!state.pages.length || !state.pages.every((p) => p.exportImage)) {
    toast('Jalankan "Proses & Export PDF" terlebih dahulu.', 'warn');
    return;
  }
  if (typeof JSZip === 'undefined') { toast('Pustaka JSZip gagal dimuat.', 'err'); return; }
  const original = btnSplitZip.innerHTML;
  btnSplitZip.disabled = true;
  try {
    const zip = new JSZip();
    for (let i = 0; i < state.pages.length; i++) {
      const page = state.pages[i];
      const doc = newPdfForPage(page);
      addPageContent(doc, page);
      const name = `Document_Page_${String(i + 1).padStart(2, '0')}.pdf`; // Page_01, Page_02, …
      zip.file(name, doc.output('arraybuffer'));
      btnSplitZip.innerHTML = `<i class="fa-solid fa-box-archive"></i> Mengemas ${i + 1}/${state.pages.length}…`;
      await tick(0); // yield UI
    }
    const blob = await zip.generateAsync(
      { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
      (meta) => { btnSplitZip.innerHTML = `<i class="fa-solid fa-file-zip fa-beat"></i> Kompresi ${Math.round(meta.percent)}%`; }
    );
    saveAs(blob, 'Scanned_Pages_Split.zip');
    toast('Scanned_Pages_Split.zip terunduh.', 'ok');
  } catch (e) {
    console.error(e);
    toast(`Gagal membuat ZIP: ${e && e.message ? e.message : e}`, 'err', 5000);
  } finally {
    btnSplitZip.disabled = false;
    btnSplitZip.innerHTML = original;
  }
}

/* ---------- Reset sesi ---------- */
function resetAll() {
  if (state.processing) return;
  if (!window.confirm('Mulai scan baru? Semua halaman saat ini akan dihapus.')) return;
  destroyCropper();
  state.pages.length = 0;
  state.cropIndex = 0;
  state.pdfBlob = null;
  state.pdfName = '';
  if (state.pdfURL) { URL.revokeObjectURL(state.pdfURL); state.pdfURL = null; } // memory cleanup
  pdfFrame.src = 'about:blank';
  pdfOpenTab.href = '#';
  btnSplitZip.disabled = true;
  syncPageUI();
  gotoScreen('capture');
  toast('Siap untuk scan baru.', 'ok', 2200);
}

/* =========================================================
 * EVENT BINDING & INIT
 * ========================================================= */
function bindEvents() {
  // Kamera
  btnStartCamera.addEventListener('click', () => { state.camError = false; startCamera(); });
  btnShutter.addEventListener('click', capturePhoto);
  btnSwitchCam.addEventListener('click', switchCamera);

  // Unggah
  fileInput.addEventListener('change', (e) => handleFiles(e.target.files || []));

  // Navigasi capture → crop
  btnToCrop.addEventListener('click', () => gotoScreen('crop'));
  btnBackCapture.addEventListener('click', () => gotoScreen('capture'));
  btnAddMore.addEventListener('click', () => gotoScreen('capture'));

  // Thumbnail (capture): buka crop / hapus
  thumbGrid.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) { deletePage(Number(del.dataset.del)); return; }
    const open = e.target.closest('[data-open]');
    if (open) {
      state.cropIndex = Number(open.dataset.open);
      gotoScreen('crop');
    }
  });

  // Rail (crop): pindah halaman
  cropRail.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-rail]');
    if (!btn) return;
    const target = Number(btn.dataset.rail);
    if (target === state.cropIndex) return;
    await applyCropToPage(state.cropIndex);
    showCropPage(target);
  });

  // Navigasi halaman crop
  btnPrevPage.addEventListener('click', async () => {
    if (state.cropIndex <= 0) return;
    await applyCropToPage(state.cropIndex);
    showCropPage(state.cropIndex - 1);
  });
  btnNextPage.addEventListener('click', async () => {
    if (state.cropIndex >= state.pages.length - 1) return;
    await applyCropToPage(state.cropIndex);
    showCropPage(state.cropIndex + 1);
  });

  // Filter & crop
  filterSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (btn) setFilterMode(btn.dataset.filter);
  });
  btnApplyCrop.addEventListener('click', () => applyCropToPage(state.cropIndex, { interactive: true }));
  btnResetCrop.addEventListener('click', () => {
    if (!state.cropper) return;
    state.cropper.reset();
    state.cropDirty = false;
  });

  // Pipeline & hasil
  btnExport.addEventListener('click', runPipeline);
  btnCancelProc.addEventListener('click', () => { state.cancelRequested = true; procStatus.textContent = 'Membatalkan…'; });
  btnDownloadPdf.addEventListener('click', () => {
    if (state.pdfBlob) saveAs(state.pdfBlob, state.pdfName);
  });
  btnSplitZip.addEventListener('click', buildSplitZip);
  btnNewScan.addEventListener('click', resetAll);
}

function init() {
  bindEvents();
  syncPageUI();
  updateSteps('capture');
  startCamera(); // auto-attempt; fallback ke unggah bila gagal
}

/* Error trap + API debug (membantu pengujian di console) */
window.__ezErrors = [];
window.addEventListener('error', (e) => window.__ezErrors.push(String(e.message)));
window.ezScan = { state, addPage, gotoScreen, runPipeline, toast };

init();
