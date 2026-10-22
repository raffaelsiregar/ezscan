'use strict';

/* Find a rectangular paper region on a small, unfiltered image. Uncertain
   detections return null so the full photo stays available for manual framing. */
function detectDocumentBounds({ data, width: w, height: h }) {
  const n = w * h;
  const luminance = new Uint8Array(n);
  const histogram = new Uint32Array(256);
  const border = [[], [], []];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x, i = p * 4;
      const value = Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
      luminance[p] = value;
      histogram[value]++;
      if (x < 3 || y < 3 || x >= w - 3 || y >= h - 3) {
        for (let c = 0; c < 3; c++) border[c].push(data[i + c]);
      }
    }
  }
  const background = border.map(values => values.sort((a, b) => a - b)[values.length >> 1]);
  let total = 0, sum = 0, count = 0, bestVariance = 0, threshold = 128;
  for (let v = 0; v < 256; v++) total += v * histogram[v];
  for (let v = 0; v < 255; v++) {
    count += histogram[v];
    sum += v * histogram[v];
    if (!count || count === n) continue;
    const difference = sum / count - (total - sum) / (n - count);
    const variance = count * (n - count) * difference * difference;
    if (variance > bestVariance) { bestVariance = variance; threshold = v; }
  }

  let best = null, bestScore = 0;
  const queue = new Int32Array(n);
  // Bright paper and contrast against the photo border cover both dark desks
  // and colored/darker pages on a lighter surface.
  for (const mode of ['bright', 'contrast']) {
    const mask = new Uint8Array(n);
    for (let p = 0; p < n; p++) {
      const i = p * 4;
      const distance = Math.max(...background.map((value, c) => Math.abs(data[i + c] - value)));
      mask[p] = mode === 'bright' ? luminance[p] > threshold + 5 : distance > 30;
    }
    for (let start = 0; start < n; start++) {
      if (!mask[start]) continue;
      let head = 0, tail = 1, left = w, top = h, right = 0, bottom = 0;
      queue[0] = start;
      mask[start] = 0;
      while (head < tail) {
        const p = queue[head++], x = p % w, y = Math.floor(p / w);
        left = Math.min(left, x); right = Math.max(right, x);
        top = Math.min(top, y); bottom = Math.max(bottom, y);
        const neighbors = [x > 0 ? p - 1 : -1, x + 1 < w ? p + 1 : -1,
          y > 0 ? p - w : -1, y + 1 < h ? p + w : -1];
        for (const next of neighbors) {
          if (next >= 0 && mask[next]) { mask[next] = 0; queue[tail++] = next; }
        }
      }
      const boxW = right - left + 1, boxH = bottom - top + 1;
      const area = boxW * boxH;
      const fill = tail / area;
      const edges = Number(left <= 1) + Number(top <= 1) + Number(right >= w - 2) + Number(bottom >= h - 2);
      if (tail < n * 0.08 || area > n * 0.96 || fill < 0.55 || edges >= 3 || boxW < w * 0.2 || boxH < h * 0.2) continue;
      const score = tail * fill;
      if (score > bestScore) {
        bestScore = score;
        // Exclude the one-pixel blended edge from the downsampled background.
        best = { x: left + 1, y: top + 1, width: boxW - 2, height: boxH - 2, rotate: 0 };
      }
    }
  }
  return best;
}
