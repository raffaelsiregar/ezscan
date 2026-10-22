const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}) });
  try {
    const page = await browser.newPage();
    await page.goto(`file://${path.resolve('index.html')}`);
    await page.waitForFunction(() => typeof Cropper !== 'undefined' && window.ezScan);
    await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 300; canvas.height = 400;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#aaa090'; ctx.fillRect(0, 0, 300, 400);
      ctx.fillStyle = '#b02020'; ctx.fillRect(80, 100, 80, 80);
      ezScan.addPage(canvas.toDataURL());
      ezScan.gotoScreen('crop');
    });
    await page.waitForFunction(() => state.cropper && state.cropper.ready);
    const results = await page.evaluate(async () => {
      const original = state.pages[0].source;
      state.cropper.setData({ x: 40, y: 50, width: 200, height: 280 });
      state.cropDirty = true;
      await applyCropToPage(0);
      await setFilterMode('enhanced');
      return { preserved: state.pages[0].source === original, crop: state.pages[0].cropData };
    });
    assert.equal(results.preserved, true);
    assert.equal(Math.round(results.crop.width), 200);
    await page.waitForFunction(() => state.cropper && state.cropper.ready);
    const checks = await page.evaluate(async () => {
      const img = await loadImage(state.pages[0].source);
      const crop = cropSource(img, state.pages[0].cropData);
      const raw = downscaleToCanvas(img);
      const ctx = raw.getContext('2d');
      const before = ctx.getImageData(0, 0, 1, 1).data[0];
      applyFilterToCanvas(raw, 'enhanced', 0);
      const zero = ctx.getImageData(0, 0, 1, 1).data[0];
      applyFilterToCanvas(raw, 'enhanced', 100);
      const white = ctx.getImageData(0, 0, 1, 1).data[0];
      const ink = ctx.getImageData(110, 130, 1, 1).data;
      return { width: crop.width, height: crop.height, before, zero, white, red: ink[0] > ink[1] * 2 };
    });
    assert.equal(checks.width, 200); assert.equal(checks.height, 280);
    assert.equal(checks.before, checks.zero); assert.ok(checks.white > checks.before); assert.ok(checks.red);
    await page.evaluate(() => setFilterMode('original'));
    await page.waitForFunction(() => state.cropper && state.cropper.ready);
    const rotations = await page.evaluate(async () => {
      const img = await loadImage(state.pages[0].source);
      return [0, 90, 180, 270].map(rotate => {
        state.cropper.setData({ rotate, x: 70, y: 80, width: 140, height: 160 });
        const actual = state.cropper.getCroppedCanvas();
        const expected = cropSource(img, state.cropper.getData());
        const a = actual.getContext('2d').getImageData(0, 0, actual.width, actual.height).data;
        const b = expected.getContext('2d').getImageData(0, 0, expected.width, expected.height).data;
        return actual.width === expected.width && actual.height === expected.height && a.every((value, i) => Math.abs(value - b[i]) <= 2);
      });
    });
    assert.ok(rotations.every(Boolean), `rotation mismatch: ${rotations}`);
    const detections = await page.evaluate(() => {
      const cases = [
        { bg: '#35303a', paper: '#f5f0df' },
        { bg: '#f8f4f0', paper: '#7b7d8a' },
        { bg: '#35303a', paper: '#d0c8b0', shadow: true },
      ];
      return cases.map(({ bg, paper, shadow }) => {
        const canvas = document.createElement('canvas');
        canvas.width = 320; canvas.height = 400;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = bg; ctx.fillRect(0, 0, 320, 400);
        ctx.fillStyle = paper; ctx.fillRect(50, 60, 210, 280);
        if (shadow) {
          const gradient = ctx.createLinearGradient(50, 0, 260, 0);
          gradient.addColorStop(0, '#aaa08b'); gradient.addColorStop(1, '#fefaf1');
          ctx.fillStyle = gradient; ctx.fillRect(50, 60, 210, 280);
        }
        ctx.fillStyle = '#25202a';
        for (let y = 100; y < 300; y += 20) ctx.fillRect(75, y, 140, 3);
        return detectDocumentBounds(ctx.getImageData(0, 0, 320, 400));
      });
    });
    for (const bounds of detections) {
      assert.ok(bounds, 'paper should be detected');
      assert.ok(Math.abs(bounds.x - 50) < 5 && Math.abs(bounds.y - 60) < 5, JSON.stringify(bounds));
      assert.ok(Math.abs(bounds.width - 210) < 10 && Math.abs(bounds.height - 280) < 10, JSON.stringify(bounds));
    }
    const fallback = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 400;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#eee'; ctx.fillRect(0, 0, 320, 400);
      const blank = detectDocumentBounds(ctx.getImageData(0, 0, 320, 400));
      ctx.fillStyle = '#222'; ctx.fillRect(100, 100, 70, 2);
      return [blank, detectDocumentBounds(ctx.getImageData(0, 0, 320, 400))];
    });
    assert.deepEqual(fallback, [null, null], 'uncertain/full-frame pages should stay intact');

    const mobile = await browser.newPage({ viewport: { width: 393, height: 664 }, isMobile: true, hasTouch: true });
    mobile.on('pageerror', error => console.error('Mobile page error:', error.message));
    mobile.on('requestfailed', request => console.error('Mobile request failed:', request.url(), request.failure()?.errorText));
    await mobile.addInitScript(() => {
      if (window.top !== window || !navigator.mediaDevices) return;
      const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 800;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#373340'; ctx.fillRect(0, 0, 600, 800);
      ctx.fillStyle = '#f7f3e8'; ctx.fillRect(70, 65, 460, 660);
      ctx.fillStyle = '#4a3f9c'; ctx.font = 'bold 32px sans-serif'; ctx.fillText('Project notes', 105, 145);
      ctx.fillStyle = '#403b48'; ctx.font = '18px sans-serif'; ctx.fillText('A clearer way to scan your documents.', 105, 190);
      for (let y = 245; y < 650; y += 30) ctx.fillRect(105, y, 365 - (y % 60), 4);
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
        const stream = canvas.captureStream(22);
        setInterval(() => ctx.fillRect(105, 700, 1, 1), 100);
        return stream;
      } });
    });
    await mobile.goto(`file://${path.resolve('index.html')}`, { waitUntil: 'domcontentloaded' });
    await mobile.waitForFunction(() => window.ezScan && video.videoWidth > 0 && !btnShutter.disabled).catch(async error => {
      console.log(await mobile.evaluate(() => ({ errors: window.__ezErrors, status: document.querySelector('#camStatus')?.textContent, overlay: document.querySelector('#cameraOverlayText')?.textContent, width: document.querySelector('video')?.videoWidth })));
      await mobile.screenshot({ animations: 'disabled', path: '/tmp/ezscan-mobile-error.png' });
      throw error;
    });
    const metrics = await mobile.evaluate(() => {
      const rect = btnShutter.getBoundingClientRect(), frame = cameraFrame.getBoundingClientRect();
      return { bottom: rect.bottom, height: innerHeight, ratio: frame.width / frame.height,
        overflow: document.documentElement.scrollWidth > innerWidth, header: document.querySelector('header').getBoundingClientRect().height };
    });
    assert.ok(metrics.bottom < metrics.height - 20, JSON.stringify(metrics));
    assert.ok(metrics.header < 100, 'compact header');
    assert.ok(Math.abs(metrics.ratio - 0.75) < 0.01);
    assert.equal(metrics.overflow, false);
    await mobile.screenshot({ animations: 'disabled', path: '/tmp/ezscan-capture-mobile.png' });
    await mobile.click('#btnShutter');
    await mobile.click('#btnToCrop');
    await mobile.waitForFunction(() => state.cropper?.ready && !btnApplyCrop.disabled);
    const initial = await mobile.evaluate(() => ({ data: state.pages[0].cropData, source: state.pages[0].source, found: state.pages[0].autoCropFound }));
    assert.equal(initial.found, true, 'initial grid should automatically frame the paper');
    assert.ok(initial.data.width < 500 && initial.data.height < 700);
    await mobile.screenshot({ animations: 'disabled', path: '/tmp/ezscan-auto-crop-mobile.png', fullPage: true });
    await mobile.click('#btnApplyCrop');
    await mobile.waitForFunction(() => state.pages[0].cropApplied && scanPreview.complete && scanPreview.naturalWidth > 0 && cropSpinner.style.display === 'none');
    const applied = await mobile.evaluate(async () => {
      const output = await preparePage(state.pages[0]);
      return { width: scanPreview.naturalWidth, height: scanPreview.naturalHeight,
        same: output.jpeg === scanPreview.src, source: state.pages[0].source, cropper: !!state.cropper };
    });
    assert.equal(applied.source, initial.source, 'applying crop must preserve the original');
    assert.equal(applied.same, true, 'preview must match the exported page exactly');
    assert.equal(applied.cropper, false, 'preview should display the cropped image without the editor');
    await mobile.screenshot({ animations: 'disabled', path: '/tmp/ezscan-preview-mobile.png', fullPage: true });
    await mobile.click('[data-filter="enhanced"]');
    await mobile.waitForFunction(() => state.pages[0].filter === 'enhanced' && cropSpinner.style.display === 'none');
    assert.equal(await mobile.locator('#scanPreview').isVisible(), true);
    await mobile.locator('#enhanceStrength').fill('45');
    await mobile.locator('#enhanceStrength').dispatchEvent('change');
    await mobile.waitForFunction(() => state.pages[0].strength === 45 && cropSpinner.style.display === 'none');
    assert.equal(await mobile.locator('#scanPreview').isVisible(), true, 'slider must retain cropped preview');
    await mobile.click('#btnEditCrop');
    await mobile.waitForFunction(() => state.cropper?.ready);
    await mobile.click('#btnApplyCrop');
    await mobile.waitForFunction(() => state.pages[0].cropApplied && cropSpinner.style.display === 'none');
    assert.equal(await mobile.evaluate(() => scanPreview.naturalWidth), applied.width, 'repeated crops must not shrink the page');
    await mobile.click('#btnResetCrop');
    await mobile.waitForFunction(() => state.cropper?.ready);
    assert.equal(await mobile.evaluate(() => state.pages[0].cropData), null, 'reset must show the full original');
    await mobile.click('#btnAutoCrop');
    await mobile.waitForFunction(() => state.cropper?.ready && state.pages[0].autoCropFound);
    await mobile.click('#btnApplyCrop');
    await mobile.waitForFunction(() => state.pages[0].cropApplied && cropSpinner.style.display === 'none');
    await mobile.click('#btnBackCapture');
    await mobile.click('#btnToCrop');
    await mobile.waitForFunction(() => !scanPreview.hidden && cropSpinner.style.display === 'none');
    assert.equal(await mobile.locator('#btnEditCrop').isVisible(), true, 'page navigation must retain applied preview');
    assert.deepEqual(await mobile.evaluate(() => window.__ezErrors), []);
    for (const height of [550, 744, 852]) {
      await mobile.evaluate(() => gotoScreen('capture'));
      await mobile.setViewportSize({ width: 393, height });
      const fits = await mobile.evaluate(() => {
        const r = btnShutter.getBoundingClientRect();
        return r.top >= 0 && r.bottom < innerHeight - 20 && document.documentElement.scrollWidth <= innerWidth;
      });
      assert.ok(fits, `camera controls should fit at 393×${height}: ${JSON.stringify(await mobile.evaluate(() => ({ bottom: btnShutter.getBoundingClientRect().bottom, top: btnShutter.getBoundingClientRect().top, height: innerHeight, scrollY, width: innerWidth, scrollWidth: document.documentElement.scrollWidth })))}`);
    }
    const exports = await mobile.evaluate(async () => {
      gotoScreen('crop');
      // PDF/ZIP assembly uses the real libraries; stub OCR to keep tests offline
      // with respect to language data and independent of recognition accuracy.
      state.worker = { recognize: async () => ({ data: { words: [], text: '' } }) };
      const downloads = [];
      window.saveAs = (blob, name) => downloads.push({ blob, name });
      state.documentName = 'Project notes';
      await runPipeline();
      const pdf = downloads[0];
      await buildSplitZip();
      const zip = downloads[1];
      const files = await JSZip.loadAsync(zip.blob);
      return { screen: state.screen, pdfName: pdf.name, pdfSignature: (await pdf.blob.text()).slice(0, 4),
        zipName: zip.name, files: Object.keys(files.files), words: document.querySelector('#resultMeta').textContent };
    });
    assert.equal(exports.screen, 'result');
    assert.equal(exports.pdfName, 'Project_notes.pdf');
    assert.equal(exports.pdfSignature, '%PDF');
    assert.equal(exports.zipName, 'Project_notes.zip');
    assert.deepEqual(exports.files, ['Project_notes_01.pdf']);
    assert.ok(exports.words.includes('searchable words'));
    await mobile.close();
    console.log('PASS: filters, original preservation, rotated crops, auto detection, fallback, applied previews, slider, reset, navigation, mobile camera layout, PDF/ZIP assembly');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
