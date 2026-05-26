const fileInput    = document.getElementById('file-input');
const previewImg   = document.getElementById('preview-img');
const overlay      = document.getElementById('overlay');
const recognizeBtn = document.getElementById('recognize-btn');
const statusEl     = document.getElementById('status');
const errorEl      = document.getElementById('error');
const errorLog     = document.getElementById('error-log');
const retryBtn     = document.getElementById('retry-btn');
const resultText   = document.getElementById('result-text');
const regionsList  = document.getElementById('regions-list');
const copyBtn      = document.getElementById('copy-btn');
const langSelect   = document.getElementById('lang-select');
const numOnlyCheck = document.getElementById('num-only');
const canvas       = document.getElementById('canvas');

let currentImage = null;

// ---- helpers ----

function setStatus(msg) { if (statusEl) statusEl.textContent = msg; }

function showError(err) {
  console.error(err);
  if (errorEl && errorLog) {
    errorEl.style.display = 'block';
    errorLog.textContent = (err && err.stack) ? err.stack : String(err);
  } else {
    setStatus('エラー: ' + (err.message || err));
  }
  recognizeBtn.disabled = false;
  if (retryBtn) retryBtn.style.display = 'inline-block';
}

function waitForOpenCV(timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (window.cv && window.cv.Mat) return resolve(window.cv);
      if (Date.now() - start > timeoutMs) return reject(new Error('OpenCV.js の読み込みタイムアウト'));
      setTimeout(check, 100);
    };
    check();
  });
}

// ---- file input ----

fileInput.addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  previewImg.src = url;
  previewImg.onload = () => {
    URL.revokeObjectURL(url);
    previewImg.style.display = 'block';
    overlay.style.display = 'none';
    currentImage = previewImg;
    recognizeBtn.disabled = false;
    setStatus('画像読み込み完了');
    regionsList.innerHTML = '';
  };
});

// ---- OpenCV pipeline (number mode) ----

/**
 * Returns array of {x, y, w, h} bounding boxes likely containing digit groups.
 * Also draws overlay canvas with red boxes.
 */
function detectNumberRegions(cv, imgCanvas) {
  const src = cv.imread(imgCanvas);
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const thresh = new cv.Mat();
  const dilated = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

    // Adaptive threshold — handles uneven lighting / shadows
    cv.adaptiveThreshold(
      blurred, thresh, 255,
      cv.ADAPTIVE_THRESH_GAUSSIAN_C,
      cv.THRESH_BINARY_INV,
      15, 8
    );

    // Dilate to connect nearby digit strokes
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(12, 6));
    cv.dilate(thresh, dilated, kernel);
    kernel.delete();

    cv.findContours(dilated, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const W = imgCanvas.width;
    const H = imgCanvas.height;
    const minArea = W * H * 0.0005;
    const maxArea = W * H * 0.5;

    const boxes = [];
    for (let i = 0; i < contours.size(); i++) {
      const rect = cv.boundingRect(contours.get(i));
      const area = rect.width * rect.height;
      const aspect = rect.width / rect.height;
      // filter: reasonable size and aspect ratio for digit groups
      if (area < minArea || area > maxArea) continue;
      if (aspect < 0.2 || aspect > 15) continue;
      if (rect.height < 10 || rect.width < 8) continue;
      boxes.push({ x: rect.x, y: rect.y, w: rect.width, h: rect.height });
    }

    // Draw overlay
    overlay.width  = W;
    overlay.height = H;
    // match display size of preview
    overlay.style.width  = previewImg.offsetWidth  + 'px';
    overlay.style.height = previewImg.offsetHeight + 'px';
    overlay.style.display = 'block';

    const octx = overlay.getContext('2d');
    octx.clearRect(0, 0, W, H);
    octx.strokeStyle = '#e00';
    octx.lineWidth = Math.max(2, Math.round(W / 400));
    octx.font = `bold ${Math.max(12, Math.round(W / 60))}px monospace`;
    octx.fillStyle = '#e00';
    boxes.forEach((b, idx) => {
      octx.strokeRect(b.x, b.y, b.w, b.h);
      octx.fillText(idx + 1, b.x + 2, b.y + Math.max(14, Math.round(W / 50)));
    });

    return boxes;
  } finally {
    src.delete(); gray.delete(); blurred.delete();
    thresh.delete(); dilated.delete();
    contours.delete(); hierarchy.delete();
  }
}

/**
 * Crop a region from canvas, upscale, sharpen and return as a new canvas.
 */
function cropAndEnhance(srcCanvas, box, scale = 3) {
  const { x, y, w, h } = box;
  // add padding
  const pad = Math.round(Math.min(w, h) * 0.15);
  const sx = Math.max(0, x - pad);
  const sy = Math.max(0, y - pad);
  const sw = Math.min(srcCanvas.width  - sx, w + pad * 2);
  const sh = Math.min(srcCanvas.height - sy, h + pad * 2);

  const out = document.createElement('canvas');
  out.width  = sw * scale;
  out.height = sh * scale;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(srcCanvas, sx, sy, sw, sh, 0, 0, out.width, out.height);

  // grayscale + contrast + binarize
  const id = ctx.getImageData(0, 0, out.width, out.height);
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    let v = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
    v = Math.min(255, Math.max(0, (v - 128) * 2.0 + 128));
    v = v > 128 ? 255 : 0;
    d[i] = d[i+1] = d[i+2] = v;
  }
  ctx.putImageData(id, 0, 0);
  return out;
}

// ---- Tesseract helpers ----

async function runTesseract(srcCanvas, lang, numOnly, logger) {
  const params = numOnly ? { tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: '6' } : {};

  if (typeof Tesseract === 'undefined') throw new Error('Tesseract.js が読み込まれていません');

  let text;
  if (typeof Tesseract.createWorker === 'function') {
    const worker = Tesseract.createWorker({ logger });
    if (typeof worker.load === 'function') {
      await worker.load();
      await worker.loadLanguage(lang);
      await worker.initialize(lang);
      if (numOnly) await worker.setParameters(params);
      ({ data: { text } } = await worker.recognize(srcCanvas));
      await worker.terminate();
    } else {
      ({ data: { text } } = await Tesseract.recognize(srcCanvas, lang, { logger, ...params }));
    }
  } else {
    ({ data: { text } } = await Tesseract.recognize(srcCanvas, lang, { logger, ...params }));
  }
  return text;
}

// ---- main recognize flow ----

recognizeBtn.addEventListener('click', async () => {
  if (!currentImage) return;
  recognizeBtn.disabled = true;
  if (errorEl) errorEl.style.display = 'none';
  if (retryBtn) retryBtn.style.display = 'none';
  resultText.value = '';
  regionsList.innerHTML = '';

  const numOnly = numOnlyCheck && numOnlyCheck.checked;

  // draw image to canvas
  canvas.width  = currentImage.naturalWidth;
  canvas.height = currentImage.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(currentImage, 0, 0);

  const lang = numOnly ? 'eng' : (langSelect.value || 'eng');

  const logger = m => {
    if (m.status === 'recognizing text' || m.status === 'loading tesseract core') {
      setStatus(`${m.status} — ${(m.progress * 100).toFixed(1)}%`);
    } else if (m.status) {
      setStatus(m.status);
    }
  };

  try {
    if (numOnly) {
      // --- OpenCV path ---
      setStatus('OpenCV.js を待機中...');
      const cv = await waitForOpenCV();

      setStatus('数字領域を検出中...');
      const boxes = detectNumberRegions(cv, canvas);

      if (boxes.length === 0) {
        resultText.value = '（数字領域が検出されませんでした）';
        setStatus('完了（領域なし）');
        recognizeBtn.disabled = false;
        return;
      }

      setStatus(`${boxes.length} 領域を検出。OCR実行中...`);
      const results = [];
      for (let i = 0; i < boxes.length; i++) {
        setStatus(`OCR中... 領域 ${i + 1} / ${boxes.length}`);
        const cropped = cropAndEnhance(canvas, boxes[i]);
        const raw = await runTesseract(cropped, 'eng', true, logger);
        const digits = raw.replace(/[^0-9\n]/g, '').trim();
        results.push({ idx: i + 1, box: boxes[i], digits });
      }

      // build output
      const lines = results.filter(r => r.digits).map(r => `[${r.idx}] ${r.digits}`);
      resultText.value = lines.join('\n') || '（認識できた数字なし）';

      // build region list
      regionsList.innerHTML = results.map(r =>
        `<div class="region-item">
          <span class="region-num">${r.idx}</span>
          <span class="region-digits">${r.digits || '—'}</span>
         </div>`
      ).join('');

      setStatus('完了');
    } else {
      // --- simple path ---
      setStatus('認識中...');
      const text = await runTesseract(canvas, lang, false, logger);
      resultText.value = text;
      setStatus('完了');
    }
  } catch (err) {
    showError(err);
  } finally {
    recognizeBtn.disabled = false;
  }
});

if (retryBtn) retryBtn.addEventListener('click', () => {
  if (errorEl) errorEl.style.display = 'none';
  retryBtn.style.display = 'none';
  recognizeBtn.click();
});

copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(resultText.value);
    copyBtn.textContent = 'コピー完了';
    setTimeout(() => copyBtn.textContent = 'コピー', 1500);
  } catch (e) {
    alert('クリップボードにコピーできませんでした');
  }
});

window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault();
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f) return;
  fileInput.files = e.dataTransfer.files;
  fileInput.dispatchEvent(new Event('change'));
});
