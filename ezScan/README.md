# ezScan 📄✨

**Document Scanner & OCR — 100% client-side.** Aplikasi web single-page (SPA) untuk memindai dokumen multi-halaman langsung dari browser: kamera atau unggah gambar → crop manual → binarisasi adaptif → OCR (`ind`+`eng`) → **PDF searchable** dengan teks transparan → auto-download, preview, dan split ZIP per halaman. Tanpa backend; tidak ada data yang meninggalkan perangkat.

## 🚀 Menjalankan

```bash
cd ezScan
python3 -m http.server 8080
# buka http://localhost:8080
```

> **Catatan kamera:** `getUserMedia` membutuhkan *secure context*. `http://localhost` sudah cukup untuk pengembangan. Untuk akses dari LAN / produksi, sajikan via HTTPS (mis. GitHub Pages, Netlify, atau `npx serve` + tunnel HTTPS).

## 🧱 Struktur

```
ezScan/
├── index.html      # SPA: 4 screen (Capture → Crop & Filter → OCR → Hasil) + stepper
├── css/styles.css  # Stepper, shutter, cropper theme, progress bar, toast
└── js/app.js       # Seluruh logika (kamera, filter, OCR, PDF, ZIP)
```

**Pustaka (CDN):** Tailwind CSS · FontAwesome · Cropper.js 1.6 · Tesseract.js 5 (Web Worker) · jsPDF 2.5 · JSZip · FileSaver.js. Koneksi internet hanya dibutuhkan untuk memuat pustaka + data bahasa OCR (sekali; ~15 MB untuk `ind`+`eng`, di-cache browser).

## 🔄 Alur Pengguna

1. **Capture & Collect** — kamera (preview dikunci **20–25 FPS**, `frameRate: { ideal: 22.5, min: 20, max: 25 }`) atau unggah multi-gambar. Halaman masuk ke array `state.pages` dengan counter/thumbnail; bisa terus menambah.
2. **Crop & Filter (per halaman)** — crop box Cropper.js (diterapkan otomatis saat pindah halaman/Export), toggle filter **B&W Tajam** (adaptive thresholding) / **Warna** / **Asli** dengan preview langsung.
3. **Batch OCR** — Tesseract.js berjalan sekuensial per halaman di **Web Worker** dengan progress bar ("Memproses OCR halaman 2 dari 5…") dan daftar status per halaman; bisa dibatalkan.
4. **PDF Searchable** — tiap halaman menjadi halaman PDF berukuran proporsional gambar (fit A4, 72 DPI points); gambar JPEG terkompresi + teks OCR dengan `renderingMode: 'invisible'` (mode 3) pada koordinat bounding box hasil konversi (flip sumbu Y).
5. **Export** — **auto-download** PDF, preview interaktif via `<iframe>` (+ tautan tab baru untuk mobile), tombol **Download Split ZIP** (`Document_Page_01.pdf`, `Document_Page_02.pdf`, … → `Scanned_Pages_Split.zip`).

## ⚙️ Optimasi Teknis

| Aspek | Implementasi |
|---|---|
| Anti-crash mobile | Downsample semua input (kamera 4K/48MP, unggahan) ke **maks 2000px** sebelum diproses |
| UI non-freeze | OCR di Web Worker; pipeline `await` sekuensial + `yield` ke UI |
| Memory cleanup | `canvas.width = 0` setelah tiap operasi; `URL.revokeObjectURL` setelah pakai; cache filter dibebaskan saat pindah halaman; stream kamera di-stop saat keluar screen |
| Ukuran PDF | Gambar di dalam PDF `canvas.toDataURL('image/jpeg', 0.78)` + stream terkompresi jsPDF (`compress: true`) ≈ 3–5 MB per 10 halaman |
| Koordinat OCR→PDF | `pt = px × (pagePt / imgPx)`; baseline = `pageH − y0·s − 0.8·boxH` (origin PDF kiri-bawah) |
| FPS kamera | Constraint 20–25 fps (fallback `ideal` saja bila `OverconstrainedError`) |
| Binarisasi | Adaptive thresholding (Bradley, integral image O(n), jendela ≈ minDim/14, T=0.86) — menghilangkan bayangan & memutihkan kertas |

## 🔒 Privasi

Semua pemrosesan (crop, filter, OCR, penyusunan PDF, ZIP) terjadi di browser. Tidak ada request berisi gambar/teks ke server mana pun.

## 🛠 Debug

Buka console: `ezScan.state`, `ezScan.addPage(dataURL)`, `ezScan.gotoScreen('crop')`; error runtime terkumpul di `window.__ezErrors`.
