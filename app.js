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
function yieldUI() { return new Promise(r => setTimeout(r, 0)); }

function showError(msg) {
  if (errorEl && errorLog) {
    errorEl.style.display = 'block';
    errorLog.textContent = msg;
  } else { setStatus('エラー: ' + msg); }
  recognizeBtn.disabled = false;
  if (retryBtn) retryBtn.style.display = 'inline-block';
}

// -------- 画像入力 --------
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

// -------- 画像をリサイズしてメインcanvasへ --------
function drawResized(img, maxPx = 1200) {
  const { naturalWidth: w, naturalHeight: h } = img;
  const scale = Math.min(1, maxPx / Math.max(w, h));
  canvas.width  = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
}

// -------- 大津の二値化（自動しきい値） --------
function otsuBinarize(gray) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, varMax = 0, threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (wB === 0) continue;
    const wF = total - wB; if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v  = wB * wF * (mB - mF) * (mB - mF);
    if (v > varMax) { varMax = v; threshold = t; }
  }
  const bin = new Uint8Array(gray.length);
  // 黒地白文字でも対応するため、平均より暗ければ反転
  let mean = 0; for (let i = 0; i < gray.length; i++) mean += gray[i];
  mean /= gray.length;
  const invert = mean < 128;
  for (let i = 0; i < gray.length; i++) {
    const fg = invert ? gray[i] > threshold : gray[i] < threshold;
    bin[i] = fg ? 1 : 0;  // 1 = 前景(文字)
  }
  return bin;
}

// -------- メインcanvasから二値化マップを得る --------
function getBinaryMap() {
  const { width: W, height: H } = canvas;
  const id = canvas.getContext('2d').getImageData(0, 0, W, H);
  const d  = id.data;
  const gray = new Uint8ClampedArray(W * H);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    gray[j] = (0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2]) | 0;
  }
  return { bin: otsuBinarize(gray), W, H };
}

// -------- 水平投影で「テキスト行」を検出 --------
function detectRows(bin, W, H) {
  const row = new Int32Array(H);
  for (let y = 0; y < H; y++) {
    let s = 0;
    const base = y * W;
    for (let x = 0; x < W; x++) s += bin[base + x];
    row[y] = s;
  }
  // 行のしきい値: 平均の20%以上を「文字あり」とみなす
  let mean = 0; for (let y = 0; y < H; y++) mean += row[y]; mean /= H;
  const TH  = Math.max(W * 0.005, mean * 0.2);
  const rows = [];
  let start = -1;
  for (let y = 0; y < H; y++) {
    if (row[y] > TH) { if (start < 0) start = y; }
    else if (start >= 0) {
      if (y - start >= 8) rows.push({ y0: start, y1: y });
      start = -1;
    }
  }
  if (start >= 0 && H - start >= 8) rows.push({ y0: start, y1: H });
  return rows;
}

// -------- 各行に対して垂直投影で「文字塊」を検出してマージ --------
function detectBoxesInRow(bin, W, H, row) {
  const { y0, y1 } = row;
  const colH = y1 - y0;
  const col = new Int32Array(W);
  for (let x = 0; x < W; x++) {
    let s = 0;
    for (let y = y0; y < y1; y++) s += bin[y * W + x];
    col[x] = s;
  }
  const TH = Math.max(1, colH * 0.05);
  const segs = [];
  let start = -1;
  for (let x = 0; x < W; x++) {
    if (col[x] > TH) { if (start < 0) start = x; }
    else if (start >= 0) { segs.push([start, x]); start = -1; }
  }
  if (start >= 0) segs.push([start, W]);

  // 近い文字塊をマージ（gap が rowHeight の 1.2 倍以下）
  const merged = [];
  const gapMax = colH * 1.2;
  for (const s of segs) {
    if (merged.length && s[0] - merged[merged.length - 1][1] < gapMax) {
      merged[merged.length - 1][1] = s[1];
    } else merged.push([s[0], s[1]]);
  }

  // ボックス化（小さすぎは除外）
  return merged
    .filter(([a, b]) => b - a >= Math.max(8, colH * 0.6))
    .map(([a, b]) => ({ x: a, y: y0, w: b - a, h: colH }));
}

// -------- overlay描画 --------
function drawOverlay(boxes) {
  const W = canvas.width, H = canvas.height;
  overlay.width  = W; overlay.height = H;
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

// -------- 領域クロップ + 2倍拡大 + 二値化 --------
function cropAndEnhance(box) {
  const pad = Math.round(box.h * 0.2);
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

// -------- Tesseract Worker (再利用) --------
let tWorker = null;
async function getTesseract(lang, numOnly) {
  const key = lang + (numOnly ? '_n' : '');
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

// -------- メイン --------
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
    await yieldUI();
    drawResized(currentImage);

    if (numOnly) {
      setStatus('二値化中...');
      await yieldUI();
      const { bin, W, H } = getBinaryMap();

      setStatus('テキスト行を検出中...');
      await yieldUI();
      const rows = detectRows(bin, W, H);

      let boxes = [];
      for (const r of rows) {
        boxes = boxes.concat(detectBoxesInRow(bin, W, H, r));
      }
      // 上から順
      boxes.sort((a, b) => (a.y - b.y) || (a.x - b.x));

      drawOverlay(boxes);

      if (boxes.length === 0) {
        resultText.value = '（数字領域が検出されませんでした）';
        setStatus('完了（領域なし）');
        recognizeBtn.disabled = false;
        return;
      }

      const limited = boxes.slice(0, 30);
      setStatus(`${limited.length} 領域検出。Tesseract準備中...`);
      const tw = await getTesseract('eng', true);

      const results = [];
      for (let i = 0; i < limited.length; i++) {
        setStatus(`OCR中... 領域 ${i + 1} / ${limited.length}`);
        await yieldUI();
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
      setStatus('Tesseract準備中...');
      const tw = await getTesseract(lang, false);
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
});
