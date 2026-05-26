'use strict';

// OpenCV.js をワーカー内でロード → WASMコンパイルがメインスレッドをブロックしない
let _cvResolve, _cvReject;
const cvReady = new Promise((res, rej) => { _cvResolve = res; _cvReject = rej; });

self.Module = {
  onRuntimeInitialized() {
    // cv はグローバルに展開される
    _cvResolve(self.cv !== undefined ? self.cv : cv);
  }
};

try {
  importScripts('https://docs.opencv.org/4.8.0/opencv.js');
} catch (e) {
  _cvReject(new Error('OpenCV.js 読み込み失敗: ' + e.message));
}

// フォールバック: Module が呼ばれないビルド向けポーリング
const _poll = setInterval(() => {
  try {
    const c = (typeof cv !== 'undefined' && cv && cv.Mat) ? cv : null;
    if (c) { clearInterval(_poll); _cvResolve(c); }
  } catch(e) {}
}, 200);
setTimeout(() => { clearInterval(_poll); _cvReject(new Error('OpenCV.js タイムアウト')); }, 40000);

// ---------- 領域検出 ----------
function detectRegions(CV, imageData, W, H) {
  // ImageData → Mat (worker では canvas がないため直接構築)
  const src = new CV.Mat(H, W, CV.CV_8UC4);
  src.data.set(imageData.data);

  const gray      = new CV.Mat();
  const blurred   = new CV.Mat();
  const thresh    = new CV.Mat();
  const dilated   = new CV.Mat();
  const contours  = new CV.MatVector();
  const hierarchy = new CV.Mat();

  try {
    CV.cvtColor(src, gray, CV.COLOR_RGBA2GRAY);
    CV.GaussianBlur(gray, blurred, new CV.Size(5, 5), 0);
    CV.adaptiveThreshold(
      blurred, thresh, 255,
      CV.ADAPTIVE_THRESH_GAUSSIAN_C, CV.THRESH_BINARY_INV,
      15, 8
    );

    const kernel = CV.getStructuringElement(CV.MORPH_RECT, new CV.Size(14, 8));
    CV.dilate(thresh, dilated, kernel);
    kernel.delete();

    CV.findContours(dilated, contours, hierarchy,
      CV.RETR_EXTERNAL, CV.CHAIN_APPROX_SIMPLE);

    const minArea = W * H * 0.0003;
    const maxArea = W * H * 0.6;
    const boxes = [];

    for (let i = 0; i < contours.size(); i++) {
      const r    = CV.boundingRect(contours.get(i));
      const area = r.width * r.height;
      const asp  = r.width / r.height;
      if (area < minArea || area > maxArea) continue;
      if (asp < 0.15 || asp > 20) continue;
      if (r.height < 8 || r.width < 6) continue;
      boxes.push({ x: r.x, y: r.y, w: r.width, h: r.height });
    }

    return boxes;
  } finally {
    src.delete(); gray.delete(); blurred.delete();
    thresh.delete(); dilated.delete();
    contours.delete(); hierarchy.delete();
  }
}

// ---------- メッセージハンドラ ----------
self.onmessage = async (e) => {
  const { imageData, width, height } = e.data;
  try {
    self.postMessage({ type: 'status', text: 'OpenCV 初期化中 (初回のみ数秒かかります)...' });
    const CV = await cvReady;

    self.postMessage({ type: 'status', text: '数字領域を検出中...' });
    const boxes = detectRegions(CV, imageData, width, height);

    self.postMessage({ type: 'done', boxes });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || String(err) });
  }
};
