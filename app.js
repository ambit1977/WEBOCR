'use strict';

// 簡易ブラウザOCR — 現状は「画像読み込み + プレビュー表示」のみに簡略化
// 数字認識ロジック(テキスト行抽出/Tesseract呼び出し)は撤去済み。
// 次フェーズで ODO メーター抽出器(特徴量 or DL)を実装予定。

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

function setStatus(msg) { if (statusEl) statusEl.textContent = msg; }

fileInput.addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  previewImg.src = url;
  previewImg.onload = () => {
    URL.revokeObjectURL(url);
    previewImg.style.display = 'block';
    if (overlay) overlay.style.display = 'none';
    setStatus('画像読み込み完了（OCR機能は再設計中）');
    if (regionsList) regionsList.innerHTML = '';
    if (resultText) resultText.value = '';
    if (recognizeBtn) recognizeBtn.disabled = true;
  };
});

if (recognizeBtn) {
  recognizeBtn.disabled = true;
  recognizeBtn.title = 'OCRロジックは再設計中です';
}

if (copyBtn) copyBtn.addEventListener('click', async () => {
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
