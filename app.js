'use strict';

// フェーズA: ODOメーター数値抽出（ヒューリスティック）
//  1. HSV色マスク (cyan/green/orange/white を試行)
//  2. 横方向膨張で数字を連結
//  3. 連結成分ラベリング → 矩形候補
//  4. 形状スコアリング
//  5. 上位候補をクロップ → Tesseractで数字認識
// ユーザータップで位置を指定すると、その点を含む候補を優先

const fileInput  = document.getElementById('file-input');
const previewImg = document.getElementById('preview-img');
const overlay    = document.getElementById('overlay');
const recognizeBtn = document.getElementById('recognize-btn');
const statusEl   = document.getElementById('status');
const errorEl    = document.getElementById('error');
const errorLog   = document.getElementById('error-log');
const retryBtn   = document.getElementById('retry-btn');
const resultText = document.getElementById('result-text');
const regionsList = document.getElementById('regions-list');
const copyBtn    = document.getElementById('copy-btn');
const canvas     = document.getElementById('canvas');

let currentImage = null;
let userPoint    = null;

function setStatus(m){ if(statusEl) statusEl.textContent = m; }
function yieldUI(){ return new Promise(r=>setTimeout(r,0)); }
function showError(msg){
  if(errorEl && errorLog){ errorEl.style.display='block'; errorLog.textContent=msg; }
  else setStatus('エラー: '+msg);
  recognizeBtn.disabled = false;
  if(retryBtn) retryBtn.style.display='inline-block';
}

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
    userPoint = null;
    recognizeBtn.disabled = false;
    setStatus('読み込み完了。メーター付近をタップで指定可');
    regionsList.innerHTML = '';
    resultText.value = '';
  };
});

previewImg.addEventListener('click', (e) => {
  if (!currentImage || !canvas.width){
    // canvas未描画なら一度描画してから
    if (currentImage) drawResized(currentImage);
    else return;
  }
  const rect = previewImg.getBoundingClientRect();
  const sx = canvas.width / rect.width, sy = canvas.height / rect.height;
  userPoint = { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
  setStatus(`指定位置: (${userPoint.x|0},${userPoint.y|0}) — 認識ボタンで実行`);
  drawOverlay([], -1, userPoint);
});

function drawResized(img, maxPx = 1400){
  const w = img.naturalWidth, h = img.naturalHeight;
  const scale = Math.min(1, maxPx / Math.max(w, h));
  canvas.width  = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
}

function rgb2hsv(r,g,b){
  r/=255; g/=255; b/=255;
  const mx=Math.max(r,g,b), mn=Math.min(r,g,b), v=mx, d=mx-mn;
  const s = mx===0 ? 0 : d/mx;
  let h = 0;
  if (d !== 0){
    if (mx===r) h = ((g-b)/d) % 6;
    else if (mx===g) h = (b-r)/d + 2;
    else h = (r-g)/d + 4;
    h *= 60; if (h<0) h += 360;
  }
  return [h,s,v];
}

function makeColorMask(img, type){
  const W = img.width, H = img.height, d = img.data;
  const mask = new Uint8Array(W*H);
  for (let i=0, p=0; i<d.length; i+=4, p++){
    const [h,s,v] = rgb2hsv(d[i], d[i+1], d[i+2]);
    let m = 0;
    switch(type){
      case 'cyan':   m = (h>=160 && h<=220 && s>=0.25 && v>=0.35)?1:0; break;
      case 'green':  m = (h>= 80 && h<=160 && s>=0.25 && v>=0.35)?1:0; break;
      case 'orange': m = ((h<=40 || h>=340) && s>=0.4 && v>=0.4)?1:0; break;
      case 'white':  m = (v>=0.80 && s<=0.25)?1:0; break;
    }
    mask[p] = m;
  }
  return mask;
}

function dilateHoriz(mask, W, H, kx){
  const out = new Uint8Array(W*H);
  const r = kx >> 1;
  for (let y=0; y<H; y++){
    const row = y*W;
    // naive (sufficient for our sizes)
    for (let x=0; x<W; x++){
      let found = 0;
      const x0 = Math.max(0, x-r), x1 = Math.min(W-1, x+r);
      for (let k=x0; k<=x1; k++){ if (mask[row+k]){ found=1; break; } }
      out[row+x] = found;
    }
  }
  return out;
}

function connectedComponents(mask, W, H){
  const lbl = new Int32Array(W*H);
  const boxes = [];
  const stack = [];
  let id = 0;
  for (let y=0; y<H; y++){
    for (let x=0; x<W; x++){
      const p0 = y*W + x;
      if (!mask[p0] || lbl[p0]) continue;
      id++;
      stack.push(p0); lbl[p0] = id;
      let x0=x, x1=x, y0=y, y1=y, area=0;
      while (stack.length){
        const p = stack.pop();
        const px = p % W, py = (p / W)|0;
        if (px<x0) x0=px; if (px>x1) x1=px;
        if (py<y0) y0=py; if (py>y1) y1=py;
        area++;
        if (px>0    && mask[p-1] && !lbl[p-1]){ lbl[p-1]=id; stack.push(p-1); }
        if (px<W-1  && mask[p+1] && !lbl[p+1]){ lbl[p+1]=id; stack.push(p+1); }
        if (py>0    && mask[p-W] && !lbl[p-W]){ lbl[p-W]=id; stack.push(p-W); }
        if (py<H-1  && mask[p+W] && !lbl[p+W]){ lbl[p+W]=id; stack.push(p+W); }
      }
      if (area >= 20)
        boxes.push({ x:x0, y:y0, w:x1-x0+1, h:y1-y0+1, area });
    }
  }
  return boxes;
}

function scoreBox(b, W, H){
  const asp  = b.w / b.h;
  const fill = b.area / (b.w * b.h);
  if (asp  < 2.0 || asp  > 15) return -Infinity;
  if (b.h  < H*0.012 || b.h > H*0.20) return -Infinity;
  if (b.w  < W*0.04  || b.w > W*0.60) return -Infinity;
  if (fill < 0.10    || fill > 0.85) return -Infinity;
  const aDiff = Math.abs(Math.log(asp / 5.0));
  const fDiff = Math.abs(fill - 0.4);
  const sDiff = Math.abs(Math.log((b.h / H) / 0.05));
  return -(aDiff + fDiff*2 + sDiff*0.5);
}

function drawOverlay(boxes, bestIdx, point){
  const W = canvas.width, H = canvas.height;
  overlay.width = W; overlay.height = H;
  overlay.style.width  = previewImg.offsetWidth  + 'px';
  overlay.style.height = previewImg.offsetHeight + 'px';
  overlay.style.display = 'block';
  const o = overlay.getContext('2d');
  o.clearRect(0,0,W,H);
  o.lineWidth = Math.max(2, W/500);
  o.font = `bold ${Math.max(14, W/60)}px monospace`;
  boxes.forEach((b,i) => {
    o.strokeStyle = (i===bestIdx) ? '#00e676' : '#e0e040';
    o.fillStyle   = o.strokeStyle;
    o.strokeRect(b.x, b.y, b.w, b.h);
    o.fillText(i+1, b.x+2, b.y+Math.max(14, W/55));
  });
  if (point){
    o.fillStyle = '#00bfff';
    o.beginPath(); o.arc(point.x, point.y, Math.max(8, W/120), 0, 6.28); o.fill();
  }
}

function cropAndEnhance(box){
  const pad = Math.round(box.h * 0.25);
  const sx = Math.max(0, box.x - pad);
  const sy = Math.max(0, box.y - pad);
  const sw = Math.min(canvas.width  - sx, box.w + pad*2);
  const sh = Math.min(canvas.height - sy, box.h + pad*2);
  const out = document.createElement('canvas');
  const scale = Math.max(2, Math.round(60 / Math.max(1, box.h)));
  out.width  = sw * scale;
  out.height = sh * scale;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, out.width, out.height);

  const id = ctx.getImageData(0, 0, out.width, out.height);
  const d  = id.data;
  let mean = 0;
  for (let i=0; i<d.length; i+=4){
    mean += 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
  }
  mean /= (d.length/4);
  const invert = mean < 100;
  for (let i=0; i<d.length; i+=4){
    let v = 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
    v = Math.min(255, Math.max(0, (v-128)*2.2 + 128));
    let bw = v > 128 ? 255 : 0;
    if (invert) bw = 255 - bw;
    d[i]=d[i+1]=d[i+2] = bw;
  }
  ctx.putImageData(id, 0, 0);
  return out;
}

let tWorker = null;
async function getTesseract(){
  if (tWorker) return tWorker;
  if (typeof Tesseract === 'undefined') throw new Error('Tesseract.js が読み込まれていません');
  const w = Tesseract.createWorker({});
  if (typeof w.load === 'function'){
    setStatus('Tesseract モデル読み込み中（初回のみ）...');
    await w.load();
    await w.loadLanguage('eng');
    await w.initialize('eng');
    await w.setParameters({
      tessedit_char_whitelist: '0123456789',
      tessedit_pageseg_mode: '7',
    });
  }
  tWorker = w;
  return w;
}

recognizeBtn.addEventListener('click', async () => {
  if (!currentImage) return;
  recognizeBtn.disabled = true;
  if (errorEl) errorEl.style.display='none';
  if (retryBtn) retryBtn.style.display='none';
  resultText.value = '';
  regionsList.innerHTML = '';

  try {
    setStatus('画像準備中...');
    await yieldUI();
    drawResized(currentImage);
    const W = canvas.width, H = canvas.height;
    const imgData = canvas.getContext('2d').getImageData(0, 0, W, H);

    const colors = ['cyan', 'green', 'orange', 'white'];
    const allCandidates = [];

    for (const c of colors){
      setStatus(`色マスク [${c}] 処理中...`);
      await yieldUI();
      const mask = makeColorMask(imgData, c);
      const kx   = Math.max(5, Math.round(W * 0.012));
      const dil  = dilateHoriz(mask, W, H, kx);
      const boxes = connectedComponents(dil, W, H);
      for (const b of boxes){
        const s = scoreBox(b, W, H);
        if (s > -Infinity){
          allCandidates.push({ ...b, score: s, color: c });
        }
      }
    }

    if (userPoint){
      for (const c of allCandidates){
        if (userPoint.x >= c.x && userPoint.x <= c.x + c.w &&
            userPoint.y >= c.y && userPoint.y <= c.y + c.h){
          c.score += 5;
        }
      }
    }

    allCandidates.sort((a,b) => b.score - a.score);
    const topN = allCandidates.slice(0, 8);

    if (topN.length === 0){
      drawOverlay([], -1, userPoint);
      resultText.value = '（メーター候補が検出されませんでした。\nメーター付近をタップして指定後、再度実行してみてください）';
      setStatus('完了（候補なし）');
      recognizeBtn.disabled = false;
      return;
    }

    drawOverlay(topN, 0, userPoint);

    setStatus(`${topN.length} 候補。Tesseract準備中...`);
    const tw = await getTesseract();

    const results = [];
    for (let i=0; i<topN.length; i++){
      setStatus(`OCR ${i+1}/${topN.length} (${topN[i].color})...`);
      await yieldUI();
      const cropped = cropAndEnhance(topN[i]);
      const { data: { text, confidence } } = await tw.recognize(cropped);
      const digits = text.replace(/[^0-9]/g, '');
      results.push({ idx:i+1, color:topN[i].color, digits, conf: confidence|0, score: topN[i].score.toFixed(2) });
    }

    // ODO らしさ: 4〜7桁の数字を優先
    const valid = results.filter(r => r.digits.length >= 4 && r.digits.length <= 7);
    const best  = valid.length ? valid[0] : results.find(r => r.digits) || null;

    resultText.value = best
      ? `推定ODO: ${best.digits}  (候補#${best.idx}, color=${best.color}, conf=${best.conf})\n\n--- 全候補 ---\n` +
        results.map(r => `[${r.idx}] ${r.color.padEnd(6)} score=${r.score} conf=${r.conf} → ${r.digits || '—'}`).join('\n')
      : '（数字を認識できませんでした）\n\n--- 候補 ---\n' +
        results.map(r => `[${r.idx}] ${r.color} score=${r.score} → ${r.digits || '—'}`).join('\n');

    regionsList.innerHTML = results.map(r =>
      `<div class="region-item">
        <span class="region-num">${r.idx}</span>
        <span class="region-digits">${r.digits || '—'}</span>
        <small style="color:#666">${r.color}</small>
       </div>`
    ).join('');

    if (best){
      const bestIdx = results.indexOf(best);
      drawOverlay(topN, bestIdx, userPoint);
    }

    setStatus('完了');
  } catch (err) {
    console.error(err);
    showError((err && err.stack) ? err.stack : String(err));
  } finally {
    recognizeBtn.disabled = false;
  }
});

if (retryBtn) retryBtn.addEventListener('click', () => {
  if (errorEl) errorEl.style.display='none';
  retryBtn.style.display='none';
  recognizeBtn.click();
});

copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(resultText.value || '');
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
  if (tWorker) tWorker.terminate().catch(()=>{});
});
