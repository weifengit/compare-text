'use strict';
/**
 * spike-ocr.js — PP-OCR (onnxruntime-web) 管线技术验证原型。
 * 验证 det/cls/rec 三个 ONNX 模型在 ort wasm 下的可用性，输出识别文本。
 * 预处理参数对照 SWHL/RapidOCR 的 onnxruntime-web 参考实现：
 *   - 通道顺序：RGB（SWHL 导出的 ONNX 模型内置 RGB 预处理）
 *   - det：limit_side_len=736, limit_type=min, mean/std=0.5, scale=1/255,
 *          thresh=0.3, box_thresh=0.5, unclip_ratio=1.6
 *   - rec：48 高、宽按比例、右填零到 48x320，mean/std=0.5
 *   - cls：48x192，mean/std=0.5，thresh=0.9
 *
 * 用法：node tools/spike-ocr.js <image.rgba> <width> <height>
 *       （rgba = 32bpp BGRA 原始像素（System.Drawing 导出布局），白底；样例见 test/fixtures/*.rgba）
 * 注意：此工具独立维护自己的像素转换（按 BGRA 读夹具）；src/ocr.js 的 recognize() 按画布
 *       ImageData 的 RGBA 布局读取（两者各自与自己的数据源一致）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ORT = path.join(ROOT, 'lib', 'onnxruntime');
const MODELS = path.join(ROOT, 'models');

const MODEL_DET = path.join(MODELS, 'ch_PP-OCRv4_det_infer.onnx');
const MODEL_REC = path.join(MODELS, 'ch_PP-OCRv4_rec_infer.onnx');
const MODEL_CLS = path.join(MODELS, 'ch_ppocr_mobile_v2.0_cls_infer.onnx');
const DICT = path.join(MODELS, 'ppocr_keys_v1.txt');

// det 参数
const DET_LIMIT_SIDE = 736;
const DET_LIMIT_TYPE = 'min';
const DET_THRESH = 0.3;
const DET_BOX_THRESH = 0.5;
const DET_UNCLIP_RATIO = 1.6;
// rec 参数
const REC_IMG_SHAPE = [3, 48, 320];
// cls 参数
const CLS_IMG_SHAPE = [3, 48, 192];
const CLS_THRESH = 0.9;

// ---------- 图像工具 ----------

/** 把 rgba(32bpp ARGB, stride 对齐) 转成 {w,h,data:RGB uint8 平面}，同时去 alpha 白底 */
function rgbaToRgb(rgba, w, h, stride) {
  const n = w * h;
  const rgb = new Uint8Array(n * 3);
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    for (let x = 0; x < w; x++) {
      const i = row + x * 4;
      const a = rgba[i + 3];
      const r = rgba[i + 2], g = rgba[i + 1], b = rgba[i];
      const out = (y * w + x) * 3;
      if (a >= 255) {
        rgb[out] = r; rgb[out + 1] = g; rgb[out + 2] = b;
      } else {
        const f = a / 255;
        rgb[out] = Math.round(r * f + 255 * (1 - f));
        rgb[out + 1] = Math.round(g * f + 255 * (1 - f));
        rgb[out + 2] = Math.round(b * f + 255 * (1 - f));
      }
    }
  }
  return { w, h, data: rgb };
}

/** 等比缩放 RGB 图像（双线性），返回新 {w,h,data} */
function resizeRgb(src, dw, dh) {
  const { w, h, data } = src;
  const out = new Uint8Array(dw * dh * 3);
  const xr = w / dw, yr = h / dh;
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(h - 1, Math.max(0, Math.floor(y * yr)));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(w - 1, Math.max(0, Math.floor(x * xr)));
      const si = (sy * w + sx) * 3;
      const di = (y * dw + x) * 3;
      out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2];
    }
  }
  return { w: dw, h: dh, data: out };
}

/** 旋转 RGB 图像 90° 的倍数（k=1 顺时针 90） */
function rotateRgb(src, k) {
  k = ((k % 4) + 4) % 4;
  if (k === 0) return src;
  const { w, h, data } = src;
  let nw = w, nh = h;
  if (k === 1 || k === 3) { nw = h; nh = w; }
  const out = new Uint8Array(nw * nh * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 3;
      let dx, dy;
      if (k === 1) { dx = h - 1 - y; dy = x; }
      else if (k === 2) { dx = w - 1 - x; dy = h - 1 - y; }
      else { dx = y; dy = w - 1 - x; }
      const di = (dy * nw + dx) * 3;
      out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2];
    }
  }
  return { w: nw, h: nh, data: out };
}

// ---------- det 后处理（DB） ----------

/** 8 连通域标记，返回 { labels: Int32Array(w*h), count } */
function labelConnected(map, w, h) {
  const labels = new Int32Array(w * h).fill(-1);
  let count = 0;
  const stack = [];
  for (let i = 0; i < w * h; i++) {
    if (map[i] && labels[i] < 0) {
      labels[i] = count;
      stack.push(i);
      while (stack.length) {
        const p = stack.pop();
        const px = p % w, py = (p / w) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = px + dx, ny = py + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const ni = ny * w + nx;
            if (map[ni] && labels[ni] < 0) { labels[ni] = count; stack.push(ni); }
          }
        }
      }
      count++;
    }
  }
  return { labels, count };
}

/** 计算点集的最小外接矩形（旋转矩形）——枚举每条边投影求最小面积 */
function minAreaRect(points) {
  let best = null;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i], b = points[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const ux = dx / len, uy = dy / len;
    const vx = -uy, vy = ux;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of points) {
      const u = (p.x - a.x) * ux + (p.y - a.y) * uy;
      const v = (p.x - a.x) * vx + (p.y - a.y) * vy;
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (v < minV) minV = v; if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) {
      const cx = a.x + (minU + maxU) / 2 * ux + (minV + maxV) / 2 * vx;
      const cy = a.y + (minU + maxU) / 2 * uy + (minV + maxV) / 2 * vy;
      const pts = [
        { x: cx - (maxU - minU) / 2 * ux - (maxV - minV) / 2 * vx, y: cy - (maxU - minU) / 2 * uy - (maxV - minV) / 2 * vy },
        { x: cx + (maxU - minU) / 2 * ux - (maxV - minV) / 2 * vx, y: cy + (maxU - minU) / 2 * uy - (maxV - minV) / 2 * vy },
        { x: cx + (maxU - minU) / 2 * ux + (maxV - minV) / 2 * vx, y: cy + (maxU - minU) / 2 * uy + (maxV - minV) / 2 * vy },
        { x: cx - (maxU - minU) / 2 * ux + (maxV - minV) / 2 * vx, y: cy - (maxU - minU) / 2 * uy + (maxV - minV) / 2 * vy }
      ];
      best = { area, cx, cy, pts };
    }
  }
  return best || { area: 0, cx: 0, cy: 0, pts: points };
}

/** 从概率图提取文本框：阈值 → 连通域 → 外接矩形 → unclip 扩张（简化版，矩形近似） */
function boxesFromProb(prob, w, h, ratioW, ratioH) {
  const map = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) map[i] = prob[i] > DET_THRESH ? 1 : 0;
  const { labels, count } = labelConnected(map, w, h);
  const comps = [];
  for (let c = 0; c < count; c++) comps.push({ minX: w, minY: h, maxX: -1, maxY: -1, sum: 0, n: 0 });
  for (let i = 0; i < w * h; i++) {
    const l = labels[i];
    if (l < 0) continue;
    const x = i % w, y = (i / w) | 0;
    const c = comps[l];
    if (x < c.minX) c.minX = x; if (x > c.maxX) c.maxX = x;
    if (y < c.minY) c.minY = y; if (y > c.maxY) c.maxY = y;
    c.sum += prob[i]; c.n++;
  }
  const boxes = [];
  for (let c = 0; c < count; c++) {
    const cc = comps[c];
    if (cc.n < 3) continue;
    const ww = cc.maxX - cc.minX + 1, hh = cc.maxY - cc.minY + 1;
    if (ww < 3 || hh < 3) continue;
    const avg = cc.sum / cc.n;
    if (avg < DET_BOX_THRESH) continue;
    // unclip：按矩形外扩
    const ex = Math.max(1, ww * 0.02 * DET_UNCLIP_RATIO);
    const ey = Math.max(1, hh * 0.02 * DET_UNCLIP_RATIO);
    const x0 = Math.max(0, cc.minX - ex), y0 = Math.max(0, cc.minY - ey);
    const x1 = Math.min(w - 1, cc.maxX + ex), y1 = Math.min(h - 1, cc.maxY + ey);
    boxes.push({
      box: [
        { x: x0 * ratioW, y: y0 * ratioH },
        { x: x1 * ratioW, y: y0 * ratioH },
        { x: x1 * ratioW, y: y1 * ratioH },
        { x: x0 * ratioW, y: y1 * ratioH }
      ],
      score: avg
    });
  }
  return boxes;
}

// ---------- rec 后处理（CTC） ----------

/** CTC 解码：argmax 序列去重（相邻相同合并）+ 去 blank(0) */
function ctcDecode(probs, dict) {
  const T = probs.length;
  let text = '';
  let confSum = 0, confN = 0;
  let last = -1;
  for (let t = 0; t < T; t++) {
    let argmax = 0, maxp = -Infinity;
    const row = probs[t];
    const C = row.length;
    for (let c = 0; c < C; c++) {
      if (row[c] > maxp) { maxp = row[c]; argmax = c; }
    }
    if (argmax !== last && argmax !== 0) {
      text += dict[argmax] || '?';
      confSum += maxp; confN++;
    }
    last = argmax;
  }
  return { text, conf: confN ? confSum / confN : 0 };
}

// ---------- ort 加载 ----------

async function loadOrt() {
  const ort = require(path.join(ORT, 'ort.wasm.min.js'));  // WASM-only UMD
  const wasmPath = path.join(ORT, 'ort-wasm-simd-threaded.wasm');
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmBinary = fs.readFileSync(wasmPath);
  return ort;
}

async function loadModel(ort, p) {
  const buf = fs.readFileSync(p);
  return ort.InferenceSession.create(buf, { executionProviders: ['wasm'] });
}

// ---------- 推理 ----------

/** det：RGB 输入，返回原图坐标文本框 */
async function runDet(ort, session, rgb, w, h) {
  // limit_type=min：把短边放到 limit_side_len
  const ratio = DET_LIMIT_TYPE === 'max'
    ? Math.min(1, DET_LIMIT_SIDE / Math.max(w, h))
    : (Math.min(w, h) < DET_LIMIT_SIDE ? DET_LIMIT_SIDE / Math.min(w, h) : 1);
  const tw = Math.max(32, Math.ceil(Math.round(w * ratio) / 32) * 32);
  const th = Math.max(32, Math.ceil(Math.round(h * ratio) / 32) * 32);
  const img = resizeRgb(rgb, tw, th);
  const mean = 0.5, std = 0.5, scale = 1 / 255;
  const input = new Float32Array(1 * 3 * th * tw);
  for (let i = 0; i < th * tw; i++) {
    input[i] = (img.data[i * 3] * scale - mean) / std;                    // R
    input[th * tw + i] = (img.data[i * 3 + 1] * scale - mean) / std;      // G
    input[2 * th * tw + i] = (img.data[i * 3 + 2] * scale - mean) / std;  // B
  }
  const tensor = new ort.Tensor('float32', input, [1, 3, th, tw]);
  const feeds = {};
  feeds[session.inputNames[0]] = tensor;
  const out = await session.run(feeds);
  const outName = session.outputNames[0];
  const prob = out[outName].data;
  const pw = out[outName].dims[3], ph = out[outName].dims[2];
  return boxesFromProb(prob, pw, ph, w / pw, h / ph);
}

/** 从原图裁剪四边形区域（包围盒近似） */
function cropBox(rgb, w, h, box) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of box) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  minX = Math.max(0, Math.floor(minX)); minY = Math.max(0, Math.floor(minY));
  maxX = Math.min(w - 1, Math.ceil(maxX)); maxY = Math.min(h - 1, Math.ceil(maxY));
  const cw = maxX - minX + 1, ch = maxY - minY + 1;
  const out = new Uint8Array(cw * ch * 3);
  for (let y = 0; y < ch; y++) {
    const sy = minY + y;
    for (let x = 0; x < cw; x++) {
      const si = (sy * w + minX + x) * 3;
      const di = (y * cw + x) * 3;
      out[di] = rgb.data[si]; out[di + 1] = rgb.data[si + 1]; out[di + 2] = rgb.data[si + 2];
    }
  }
  return { w: cw, h: ch, data: out, offsetX: minX, offsetY: minY };
}

/** cls：方向分类，返回 { angle: 0|180, conf } */
async function runCls(ort, session, rgb) {
  const [C, H, W] = CLS_IMG_SHAPE;
  const img = resizeRgb(rgb, W, H);
  const mean = 0.5, std = 0.5;
  const input = new Float32Array(1 * 3 * H * W);
  for (let i = 0; i < H * W; i++) {
    input[i] = (img.data[i * 3] / 255 - mean) / std;
    input[H * W + i] = (img.data[i * 3 + 1] / 255 - mean) / std;
    input[2 * H * W + i] = (img.data[i * 3 + 2] / 255 - mean) / std;
  }
  const tensor = new ort.Tensor('float32', input, [1, 3, H, W]);
  const feeds = {};
  feeds[session.inputNames[0]] = tensor;
  const out = await session.run(feeds);
  const d = out[session.outputNames[0]].data;
  const label = d[0] >= d[1] ? 0 : 1;
  const conf = Math.max(d[0], d[1]);
  return { angle: label === 1 ? 180 : 0, conf };
}

/** rec：识别单行文本，返回 { text, conf } */
async function runRec(ort, session, rgb, dict) {
  const [C, H, W] = REC_IMG_SHAPE;   // [3, 48, 320]
  const { w, h } = rgb;
  const maxWhRatio = W / H;          // 320/48
  // 高固定 48，宽按比例；clamp 到 maxWhRatio*48 与 320
  const u = H / h;
  let l = Math.round(w * u);
  l = Math.max(8, l);
  l = Math.min(l, Math.round(H * maxWhRatio));
  l = Math.min(l, W);
  const resized = resizeRgb(rgb, l, H);
  const mean = 0.5, std = 0.5;
  const input = new Float32Array(1 * 3 * H * W);   // 固定 320 宽，右侧填零
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < l; x++) {
      const si = (y * l + x) * 3;
      const di = y * W + x;
      input[di] = (resized.data[si] / 255 - mean) / std;
      input[H * W + di] = (resized.data[si + 1] / 255 - mean) / std;
      input[2 * H * W + di] = (resized.data[si + 2] / 255 - mean) / std;
    }
  }
  const tensor = new ort.Tensor('float32', input, [1, 3, H, W]);
  const feeds = {};
  feeds[session.inputNames[0]] = tensor;
  const out = await session.run(feeds);
  const outName = session.outputNames[0];
  const dims = out[outName].dims;
  const T = dims[1], C2 = dims[2];
  const d = out[outName].data;
  const probs = [];
  for (let t = 0; t < T; t++) {
    const row = new Float32Array(C2);
    for (let c = 0; c < C2; c++) row[c] = d[t * C2 + c];
    probs.push(row);
  }
  return ctcDecode(probs, dict);
}

// ---------- 主流程 ----------

async function main() {
  const [rgbaPath, wStr, hStr] = process.argv.slice(2);
  if (!rgbaPath) { console.error('用法：node tools/spike-ocr.js <image.rgba> <width> <height>'); process.exit(1); }
  const w = parseInt(wStr, 10), h = parseInt(hStr, 10);
  const rgba = new Uint8Array(fs.readFileSync(rgbaPath));
  const stride = w * 4;

  console.log('加载 ort + 模型（首次加载较慢，请稍候）…');
  const t0 = Date.now();
  const ort = await loadOrt();
  console.log('ort 就绪：' + (Date.now() - t0) + 'ms');

  const [detS, recS, clsS] = await Promise.all([
    loadModel(ort, MODEL_DET),
    loadModel(ort, MODEL_REC),
    loadModel(ort, MODEL_CLS)
  ]);
  console.log('三个模型加载完成：' + (Date.now() - t0) + 'ms');

  const dict = fs.readFileSync(DICT, 'utf8').split('\n').map(s => s.replace(/\r$/, ''));
  dict.unshift('');   // index 0 = blank
  console.log('字典大小：' + dict.length);

  const rgb = rgbaToRgb(rgba, w, h, stride);
  console.log(`图像 ${w}x${h}`);

  const t1 = Date.now();
  const boxes = await runDet(ort, detS, rgb, w, h);
  console.log(`检测到 ${boxes.length} 个文本区域（${Date.now() - t1}ms）`);

  const lines = [];
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    let crop = cropBox(rgb, w, h, b.box);
    const clsRes = await runCls(ort, clsS, crop);
    if (clsRes.angle === 180) {
      crop = rotateRgb(crop, 2);
    }
    const recRes = await runRec(ort, recS, crop, dict);
    lines.push({
      text: recRes.text,
      conf: recRes.conf,
      clsAngle: clsRes.angle,
      box: b.box,
      boxScore: b.score
    });
    console.log(`  [${i}] conf=${recRes.conf.toFixed(2)} (cls=${clsRes.angle}°) ${recRes.text || '（空）'}`);
  }

  lines.sort((a, b) => a.box[0].y - b.box[0].y);
  const full = lines.map(l => l.text).join('\n');
  console.log('---- 全文 ----');
  console.log(full);
  console.log('---- 总计 ' + (Date.now() - t0) + 'ms ----');
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
