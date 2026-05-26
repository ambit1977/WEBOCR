'use strict';

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

function setStatus(msg) { if (statusEl) statusEl.textContent = msg; }

function showError(msg) {
  if (errorEl && errorLog) {
    errorEl.style.display = 'block';
    errorLog.textContent = msg;
  } else {
    setStatus('エラー: ' + msg);
  }
  recognizeBtn.disabled = false;
  if (retryBtn) retryBtn.style.display = 'inline-block';
}

// ---- ファイル選択 ----
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
    resultText.value = '';
  };
});

// ---- 画像をリサイズしてcanvasに描画 ----
function drawResized(img, maxPx = 1400) {
  const { naturalWidth: w, naturalHeight: h } = img;
  const scale = Math.min(1, maxPx / Math.max(w, h));
  canvas.width  = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
}

// ---- overlayに矩形描画 ----
function drawOverlay(boxes) {
  const W = canvas.width, H = canvas.height;
  overlay.width  = W;
  overlay.height = H;
  overlay.style.width  = previewImg.offsetWidth  + 'px';
  overlay.style.height = previewImg.offsetHeight + 'px';
  overlay.style.display = 'block';

  const octx = overlay.getContext('2d');
  octx.clearRect(0, 0, W, H);
  octx.strokeStyle = '#e00';
  octx.lineWidth = Math.max(2, W / 500);
  octx.font = `bold ${Math.max(12, W / 70)}px monospace`;
  octx.fillStyle = '#e00';
  boxes.forEach((b, i) => {
    octx.strokeRect(b.x, b.y, b.w, b.h);
    octx.fillText(i + 1, b.x + 2, b.y + Math.max(14, W / 60));
  });
}

// ---- 領域クロップ + 前処理 ----
function cropAndEnhance(box) {
  const pad = Math.round(Math.min(box.w, box.h) * 0.15);
  const sx = Math.max(0, box.x - pad);
  const sy = Math.max(0, box.y - pad);
  const sw = Math.min(canvas.width  - sx, box.w + pad * 2);
  const sh = Math.min(canvas.height - sy, box.h + pad * 2);

  const out = document.createElement('canvas');
  out.width  = sw * 2;
  out.height = sh * 2;
  const ctx = out.getContext('2d');
  ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, out.width, out.height);

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

// ---- Tesseractワーカー (セッション内で再利用) ----
let tWorker = null;

async function getTesseractWorker(lang, numOnly) {
  const key = lang + (numOnly ? '_num' : '');
  if (tWorker && tWorker._key === key) return tWorker;
  if (tWorker) { try { await tWorker.terminate(); } catch(e) {} tWorker = null; }

  if (typeof Tesseract === 'undefined') throw new Error('Tesseract.js が読み込まれていません');
  const w = Tesseract.createWorker({});
  if (typeof w.load === 'function') {
    setStatus('Tesseract モデル読み込み中...');
    await w.load();
    await w.loadLanguage(lang);
    await w.initialize(lang);
    if (numOnly) await w.setParameters({
      tessedit_char_whitelist: '0123456789',
      tessedit_pageseg_mode: '7',
    });
  }
  w._key = key;
  tWorker = w;
  return w;
}

// ---- Web Worker (OpenCV) ----
let ocrWorker = null;

function getOcrWorker() {
  if (!ocrWorker) ocrWorker = new Worker('ocr-worker.js');
  return ocrWorker;
}

function runWorker(imageData, width, height) {
  return new Promise((resolve, reject) => {
    const worker = getOcrWorker();
    worker.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'status') { setStatus(d.text); }
      else if (d.type === 'done')  { resolve(d.boxes); }
      else if (d.type === 'error') { reject(new Error(d.message)); }
    };
    worker.onerror = (e) => reject(new Error(e.message));
    // ImageData.data は SharedArrayBuffer ではないため clone転送
    worker.postMessage({ imageData, width, height });
  });
}

// ---- メイン処理 ----
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
    const imageData = drawResized(currentImage);  // returns ImageData

    if (numOnly) {
      // OpenCV 領域検出 (Web Worker)
      const boxes = await runWorker(imageData, canvas.width, canvas.height);

      drawOverlay(boxes);

      if (boxes.length === 0) {
        resultText.value = '（数字領域が検出されませんでした）';
        setStatus('完了（領域なし）');
        recognizeBtn.disabled = false;
        return;
      }

      const limited = boxes.slice(0, 20);
      setStatus(`${limited.length} 領域を検出。Tesseract準備中...`);

      // Tesseract (Tesseract内部は別ワーカーで動く)
      const tw = await getTesseractWorker(lang, true);
      const results = [];

      for (let i = 0; i < limited.length; i++) {
        setStatus(`OCR中... 領域 ${i + 1} / ${limited.length}`);
        const cropped = cropAndEnhance(limited[i]);
        const { data: { text } } = await tw.recognize(cropped);
        const digits = text.replace(/[^0-9]/g, '');
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
      // 通常OCR
      setStatus('Tesseract準備中...');
      const tw = await getTesseractWorker(lang, false);
      setStatus('認識中...');
      const { data: { text } } = await tw.recognize(canvas);
      resultText.value = text;
      setStatus('完了');
    }

  } catch (err) {
    console.error(err);
    showError((err && err.stack) ? err.stack : String(err));
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
  } catch (e) { alert('クリップボードにコピーできませんでした'); }
});

window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault();
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f) return;
  fileInput.files = e.dataTransfer.files;
  fileInput.dispatchEvent(new Event('change'));
});

window.addEventListener('beforeunload', () => {
  if (tWorker) tWorker.terminate().catch(() => {});
  if (ocrWorker) ocrWorker.terminate();
});
