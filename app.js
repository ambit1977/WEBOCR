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

function yieldToUI() { return new Promise(r => setTimeout(r, 0)); }

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

function waitForOpenCV(timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (window.cv && window.cv.Mat) return resolve(window.cv);
      if (Date.now() - start > timeoutMs) return reject(new Error('OpenCV.js 読み込みタイムアウト'));
      setTimeout(check, 200);
    };
    check();
  });
}

// ---- resize large image to max dimension (avoid freezing) ----
function resizeCanvas(src, maxPx = 1600) {
  const { width: w, height: h } = src;
  if (w <= maxPx && h <= maxPx) return src;
  const scale = maxPx / Math.max(w, h);
  const out = document.createElement('canvas');
  out.width  = Math.round(w * scale);
  out.height = Math.round(h * scale);
  const ctx = out.getContext('2d');
  ctx.drawImage(src, 0, 0, out.width, out.height);
  return out;
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

// ---- OpenCV: detect number regions ----
function detectNumberRegions(cv, imgCanvas) {
  const src       = cv.imread(imgCanvas);
  const gray      = new cv.Mat();
  const blurred   = new cv.Mat();
  const thresh    = new cv.Mat();
  const dilated   = new cv.Mat();
  const contours  = new cv.MatVector();
  const hierarchy = new cv.Mat();

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    cv.adaptiveThreshold(blurred, thresh, 255,
      cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 15, 8);

    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(14, 8));
    cv.dilate(thresh, dilated, kernel);
    kernel.delete();

    cv.findContours(dilated, contours, hierarchy,
      cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const W = imgCanvas.width, H = imgCanvas.height;
    const minArea = W * H * 0.0003;
    const maxArea = W * H * 0.6;
    const boxes = [];

    for (let i = 0; i < contours.size(); i++) {
      const r = cv.boundingRect(contours.get(i));
      const area = r.width * r.height;
      const asp  = r.width / r.height;
      if (area < minArea || area > maxArea) continue;
      if (asp < 0.15 || asp > 20) continue;
      if (r.height < 8 || r.width < 6) continue;
      boxes.push({ x: r.x, y: r.y, w: r.width, h: r.height });
    }

    // draw overlay
    overlay.width  = W;
    overlay.height = H;
    overlay.style.width  = previewImg.offsetWidth  + 'px';
    overlay.style.height = previewImg.offsetHeight + 'px';
    overlay.style.display = 'block';

    const octx = overlay.getContext('2d');
    octx.clearRect(0, 0, W, H);
    octx.strokeStyle = '#e00';
    octx.lineWidth = Math.max(2, Math.round(W / 500));
    octx.font = `bold ${Math.max(12, Math.round(W / 70))}px monospace`;
    octx.fillStyle = '#e00';
    boxes.forEach((b, idx) => {
      octx.strokeRect(b.x, b.y, b.w, b.h);
      octx.fillText(idx + 1, b.x + 2, b.y + Math.max(14, Math.round(W / 60)));
    });

    return boxes;
  } finally {
    src.delete(); gray.delete(); blurred.delete();
    thresh.delete(); dilated.delete();
    contours.delete(); hierarchy.delete();
  }
}

// ---- crop + enhance a single region ----
function cropAndEnhance(srcCanvas, box, scale = 2) {
  const pad = Math.round(Math.min(box.w, box.h) * 0.15);
  const sx = Math.max(0, box.x - pad);
  const sy = Math.max(0, box.y - pad);
  const sw = Math.min(srcCanvas.width  - sx, box.w + pad * 2);
  const sh = Math.min(srcCanvas.height - sy, box.h + pad * 2);

  const out = document.createElement('canvas');
  out.width  = sw * scale;
  out.height = sh * scale;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(srcCanvas, sx, sy, sw, sh, 0, 0, out.width, out.height);

  // binarize
  const id = ctx.getImageData(0, 0, out.width, out.height);
  const d  = id.data;
  for (let i = 0; i < d.length; i += 4) {
    let v = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
    v = Math.min(255, Math.max(0, (v - 128) * 2.0 + 128));
    d[i] = d[i+1] = d[i+2] = (v > 128 ? 255 : 0);
  }
  ctx.putImageData(id, 0, 0);
  return out;
}

// ---- Tesseract worker (reused across regions) ----
let sharedWorker = null;

async function getWorker(lang, numOnly) {
  // If language changed or no worker yet, create one
  const key = lang + (numOnly ? '_num' : '');
  if (sharedWorker && sharedWorker._key === key) return sharedWorker;
  if (sharedWorker) {
    try { await sharedWorker.terminate(); } catch(e) {}
    sharedWorker = null;
  }

  if (typeof Tesseract === 'undefined') throw new Error('Tesseract.js が読み込まれていません');
  const worker = Tesseract.createWorker({});

  if (typeof worker.load === 'function') {
    setStatus('Tesseract モデル読み込み中...');
    await worker.load();
    await worker.loadLanguage(lang);
    await worker.initialize(lang);
    if (numOnly) await worker.setParameters({
      tessedit_char_whitelist: '0123456789',
      tessedit_pageseg_mode: '7',  // single line
    });
  }

  worker._key = key;
  sharedWorker = worker;
  return worker;
}

async function ocrCanvas(worker, cvs) {
  const { data: { text } } = await worker.recognize(cvs);
  return text;
}

// ---- main recognize ----

recognizeBtn.addEventListener('click', async () => {
  if (!currentImage) return;
  recognizeBtn.disabled = true;
  if (errorEl) errorEl.style.display = 'none';
  if (retryBtn) retryBtn.style.display = 'none';
  resultText.value = '';
  regionsList.innerHTML = '';

  const numOnly = numOnlyCheck && numOnlyCheck.checked;
  const lang    = numOnly ? 'eng' : (langSelect.value || 'eng');

  try {
    setStatus('画像準備中...');
    await yieldToUI();

    // draw + resize
    canvas.width  = currentImage.naturalWidth;
    canvas.height = currentImage.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(currentImage, 0, 0);
    await yieldToUI();

    const workCanvas = resizeCanvas(canvas);

    if (numOnly) {
      setStatus('OpenCV.js 待機中...');
      await yieldToUI();
      const cv = await waitForOpenCV();

      setStatus('数字領域を検出中...');
      await yieldToUI();
      const boxes = detectNumberRegions(cv, workCanvas);
      await yieldToUI();

      if (boxes.length === 0) {
        resultText.value = '（数字領域が検出されませんでした）';
        setStatus('完了（領域なし）');
        recognizeBtn.disabled = false;
        return;
      }

      // Cap at 20 regions
      const limited = boxes.slice(0, 20);
      setStatus(`${limited.length} 領域検出。Tesseract準備中...`);
      await yieldToUI();

      const worker = await getWorker(lang, true);
      const results = [];

      for (let i = 0; i < limited.length; i++) {
        setStatus(`OCR中... 領域 ${i + 1} / ${limited.length}`);
        await yieldToUI();
        const cropped = cropAndEnhance(workCanvas, limited[i]);
        const raw     = await ocrCanvas(worker, cropped);
        const digits  = raw.replace(/[^0-9]/g, '');
        results.push({ idx: i + 1, digits });
      }

      resultText.value = results.filter(r => r.digits).map(r => `[${r.idx}] ${r.digits}`).join('\n')
                         || '（認識できた数字なし）';

      regionsList.innerHTML = results.map(r =>
        `<div class="region-item">
          <span class="region-num">${r.idx}</span>
          <span class="region-digits">${r.digits || '—'}</span>
         </div>`
      ).join('');

      setStatus('完了');

    } else {
      setStatus('Tesseract準備中...');
      await yieldToUI();
      const worker = await getWorker(lang, false);
      setStatus('認識中...');
      await yieldToUI();
      const text = await ocrCanvas(worker, workCanvas);
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

// cleanup worker on page unload
window.addEventListener('beforeunload', () => {
  if (sharedWorker) sharedWorker.terminate().catch(() => {});
});
