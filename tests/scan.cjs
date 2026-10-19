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
    console.log('PASS: original preservation, crop dimensions, zero strength, paper whitening, colored ink');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
