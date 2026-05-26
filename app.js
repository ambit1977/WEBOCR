const fileInput = document.getElementById('file-input');
const previewImg = document.getElementById('preview-img');
const recognizeBtn = document.getElementById('recognize-btn');
const statusEl = document.getElementById('status');
const errorEl = document.getElementById('error');
const errorLog = document.getElementById('error-log');
const retryBtn = document.getElementById('retry-btn');
const resultText = document.getElementById('result-text');
const copyBtn = document.getElementById('copy-btn');
const langSelect = document.getElementById('lang-select');
const numOnlyCheck = document.getElementById('num-only');
const canvas = document.getElementById('canvas');

let currentImage = null;

function preprocessCanvas(src) {
  const out = document.createElement('canvas');
  out.width = src.width * 2;
  out.height = src.height * 2;
  const ctx = out.getContext('2d');
  ctx.drawImage(src, 0, 0, out.width, out.height);
  const id = ctx.getImageData(0, 0, out.width, out.height);
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    let v = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
    v = Math.min(255, Math.max(0, (v - 128) * 1.8 + 128));
    v = v > 140 ? 255 : 0;
    d[i] = d[i+1] = d[i+2] = v;
  }
  ctx.putImageData(id, 0, 0);
  return out;
}

function showError(err) {
  console.error(err);
  if (errorEl && errorLog) {
    errorEl.style.display = 'block';
    errorLog.textContent = (err && err.stack) ? err.stack : String(err);
  } else if (statusEl) {
    statusEl.textContent = 'エラー: ' + (err.message || err);
  }
  recognizeBtn.disabled = false;
  if (retryBtn) retryBtn.style.display = 'inline-block';
}

fileInput.addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  previewImg.src = url;
  previewImg.onload = () => {
    URL.revokeObjectURL(url);
    previewImg.style.display = 'block';
    currentImage = previewImg;
    recognizeBtn.disabled = false;
    if (statusEl) statusEl.textContent = '画像読み込み完了';
  };
});

recognizeBtn.addEventListener('click', async () => {
  if (!currentImage) return;
  recognizeBtn.disabled = true;
  if (errorEl) errorEl.style.display = 'none';
  if (retryBtn) retryBtn.style.display = 'none';
  resultText.value = '';
  if (statusEl) statusEl.textContent = '処理中...';

  const numOnly = numOnlyCheck && numOnlyCheck.checked;

  canvas.width = currentImage.naturalWidth;
  canvas.height = currentImage.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(currentImage, 0, 0);

  const srcCanvas = numOnly ? preprocessCanvas(canvas) : canvas;
  const lang = numOnly ? 'eng' : (langSelect.value || 'eng');
  const params = numOnly ? {
    tessedit_char_whitelist: '0123456789',
    tessedit_pageseg_mode: '6',
  } : {};

  const logger = m => {
    if (!statusEl) return;
    if (m.status === 'recognizing text' || m.status === 'loading tesseract core') {
      statusEl.textContent = `${m.status} — ${(m.progress * 100).toFixed(1)}%`;
    } else if (m.status) {
      statusEl.textContent = m.status;
    }
  };

  try {
    if (typeof Tesseract === 'undefined') throw new Error('Tesseract.js が読み込まれていません');

    let text;
    if (typeof Tesseract.createWorker === 'function') {
      const worker = Tesseract.createWorker({ logger });
      if (typeof worker.load === 'function') {
        await worker.load();
        await worker.loadLanguage(lang);
        await worker.initialize(lang);
        if (numOnly) await worker.setParameters(params);
        if (statusEl) statusEl.textContent = '認識中...';
        ({ data: { text } } = await worker.recognize(srcCanvas));
        await worker.terminate();
      } else {
        if (statusEl) statusEl.textContent = '認識中...';
        ({ data: { text } } = await Tesseract.recognize(srcCanvas, lang, { logger, ...params }));
      }
    } else if (typeof Tesseract.recognize === 'function') {
      if (statusEl) statusEl.textContent = '認識中...';
      ({ data: { text } } = await Tesseract.recognize(srcCanvas, lang, { logger, ...params }));
    } else {
      throw new Error('Tesseract.js のサポートされるAPIが見つかりません');
    }

    resultText.value = numOnly ? text.replace(/[^0-9\n]/g, '').trim() : text;
    if (statusEl) statusEl.textContent = '完了';
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
