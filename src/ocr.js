/**
 * ocr.js — PP-OCR (onnxruntime-web + WASM) 扫描版 PDF/图片文字识别。
 *
 * 定位：纯逻辑 + 运行时抽象，浏览器主线程 / Web Worker / Node 三处共用。
 *   - 全局暴露 Ocr；UMD 导出（与 normalize.js / compute.js 同款 IIFE 模式）。
 *   - 模型与 ort 运行时通过可注入的 assetLoader 获取，默认实现走浏览器 fetch；
 *     Node 测试注入 fs 读取的实现即可。
 *   - 全程离线、不引入 Python、不引入系统级依赖。
 *
 * 数据流：
 *   Ocr.createRuntime({ assetLoader, baseUrl? })  →  runtime（一次性加载 ort + 3 模型 + 字典）
 *   runtime.recognize({ data, width, height, stride? })  →  { text, lines:[{text, box, conf}] }
 *   Ocr.linesToTextItems(lines, pageW, pageH, dpiScale)  →  pdf.js textItems 同构结构
 *     （供 src/pdfview.js 的 collectItems 坐标体系直接复用 → 扫描版也能直接标注差异）
 *
 * 图像输入约定：data 为 RGBA（32bpp，stride 对齐），白底；Ocr 内部转 RGB 平面。
 *
 * PP-OCRv4 (SWHL ONNX 导出) 预处理参数（对照 RapidOCR onnxruntime-web 参考实现）：
 *   - 通道顺序：RGB（模型内置 RGB 预处理，勿用 BGR）
 *   - det：limit_side_len=736, limit_type=min, mean/std=0.5, scale=1/255,
 *          thresh=0.3, box_thresh=0.5, unclip_ratio=1.6
 *   - rec：高固定 48、宽按比例、右填零到 48x320，mean/std=0.5
 *   - cls：48x192，mean/std=0.5，thresh=0.9
 *
 * 资源路径（相对项目根 / baseUrl）：
 *   lib/onnxruntime/ort.wasm.min.js             WASM-only onnxruntime UMD
 *   lib/onnxruntime/ort-wasm-simd-threaded.wasm  CPU WASM 运行时
 *   models/ch_PP-OCRv4_det_infer.onnx            文本检测
 *   models/ch_PP-OCRv4_rec_infer.onnx            文本识别
 *   models/ch_ppocr_mobile_v2.0_cls_infer.onnx   方向分类
 *   models/ppocr_keys_v1.txt                     识别字典
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Ocr = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- 模型 / 运行时配置 ----------
  var RUNTIME_FILES = {
    ortJs: 'lib/onnxruntime/ort.wasm.min.js',
    ortWasm: 'lib/onnxruntime/ort-wasm-simd-threaded.wasm',
    ortMjs: 'lib/onnxruntime/ort-wasm-simd-threaded.mjs',
    det: 'models/ch_PP-OCRv4_det_infer.onnx',
    rec: 'models/ch_PP-OCRv4_rec_infer.onnx',
    cls: 'models/ch_ppocr_mobile_v2.0_cls_infer.onnx',
    dict: 'models/ppocr_keys_v1.txt'
  };

  // det 参数
  var DET_LIMIT_SIDE = 736;
  var DET_LIMIT_TYPE = 'min';
  var DET_THRESH = 0.3;
  var DET_BOX_THRESH = 0.5;
  var DET_UNCLIP_RATIO = 1.6;
  var DET_MIN_BOX_PX = 3;
  // rec 参数
  var REC_IMG_SHAPE = [3, 48, 320];
  // cls 参数
  var CLS_IMG_SHAPE = [3, 48, 192];
  var CLS_THRESH = 0.9;
  // 输出过滤：识别置信度低于此值的行仍返回（标记 lowConf），但全文中剔除
  var CONF_KEEP = 0.25;

  // ---------- 图像工具（RGB 平面） ----------

  /** RGBA(画布原生布局: byte0=R,byte1=G,byte2=B,byte3=A, stride 对齐) → {w,h,data:RGB uint8 平面}；去 alpha 白底 */
  function rgbaToRgb(rgba, w, h, stride) {
    var n = w * h;
    var rgb = new Uint8Array(n * 3);
    for (var y = 0; y < h; y++) {
      var row = y * stride;
      for (var x = 0; x < w; x++) {
        var i = row + x * 4;
        var a = rgba[i + 3];
        var r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
        var out = (y * w + x) * 3;
        if (a >= 255) {
          rgb[out] = r; rgb[out + 1] = g; rgb[out + 2] = b;
        } else {
          var f = a / 255;
          rgb[out] = Math.round(r * f + 255 * (1 - f));
          rgb[out + 1] = Math.round(g * f + 255 * (1 - f));
          rgb[out + 2] = Math.round(b * f + 255 * (1 - f));
        }
      }
    }
    return { w: w, h: h, data: rgb };
  }

  /** 双线性缩放 RGB 平面 */
  function resizeRgb(src, dw, dh) {
    var w = src.w, h = src.h, data = src.data;
    var out = new Uint8Array(dw * dh * 3);
    var xr = w / dw, yr = h / dh;
    for (var y = 0; y < dh; y++) {
      var syf = y * yr, sy = Math.floor(syf), fy = syf - sy;
      var sy2 = Math.min(h - 1, sy + 1);
      for (var x = 0; x < dw; x++) {
        var sxf = x * xr, sx = Math.floor(sxf), fx = sxf - sx;
        var sx2 = Math.min(w - 1, sx + 1);
        var i00 = (sy * w + sx) * 3, i10 = (sy * w + sx2) * 3;
        var i01 = (sy2 * w + sx) * 3, i11 = (sy2 * w + sx2) * 3;
        var di = (y * dw + x) * 3;
        for (var c = 0; c < 3; c++) {
          var top = data[i00 + c] * (1 - fx) + data[i10 + c] * fx;
          var bot = data[i01 + c] * (1 - fx) + data[i11 + c] * fx;
          out[di + c] = Math.round(top * (1 - fy) + bot * fy);
        }
      }
    }
    return { w: dw, h: dh, data: out };
  }

  /** 旋转 RGB 平面 90° 的倍数（k=1 顺时针 90） */
  function rotateRgb(src, k) {
    k = ((k % 4) + 4) % 4;
    if (k === 0) return src;
    var w = src.w, h = src.h, data = src.data;
    var nw = w, nh = h;
    if (k === 1 || k === 3) { nw = h; nh = w; }
    var out = new Uint8Array(nw * nh * 3);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var si = (y * w + x) * 3;
        var dx, dy;
        if (k === 1) { dx = h - 1 - y; dy = x; }
        else if (k === 2) { dx = w - 1 - x; dy = h - 1 - y; }
        else { dx = y; dy = w - 1 - x; }
        var di = (dy * nw + dx) * 3;
        out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2];
      }
    }
    return { w: nw, h: nh, data: out };
  }

  /**
   * 四点透视矫正裁剪：把任意四边形区域变换为水平矩形（双线性采样）。
   * 四边形点序：左上、右上、右下、左下（PDF 文本习惯）。
   * 返回 { w, h, data }，宽高 = 四边形上下边 / 左右边平均长度。
   */
  function warpQuad(rgb, quad) {
    var w = rgb.w, h = rgb.h, data = rgb.data;
    var p0 = quad[0], p1 = quad[1], p2 = quad[2], p3 = quad[3];
    var dstW = Math.max(8, Math.round((dist(p0, p1) + dist(p3, p2)) / 2));
    var dstH = Math.max(8, Math.round((dist(p0, p3) + dist(p1, p2)) / 2));
    var out = new Uint8Array(dstW * dstH * 3);
    // 目标坐标 → 源四边形双线性插值
    for (var dy = 0; dy < dstH; dy++) {
      var t = (dy + 0.5) / dstH;
      for (var dx = 0; dx < dstW; dx++) {
        var s = (dx + 0.5) / dstW;
        var sx = lerp2(p0.x, p1.x, p3.x, p2.x, s, t);
        var sy = lerp2(p0.y, p1.y, p3.y, p2.y, s, t);
        if (sx < 0 || sy < 0 || sx >= w - 1 || sy >= h - 1) continue;
        var x0 = Math.floor(sx), y0 = Math.floor(sy);
        var fx = sx - x0, fy = sy - y0;
        var x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
        var i00 = (y0 * w + x0) * 3, i10 = (y0 * w + x1) * 3;
        var i01 = (y1 * w + x0) * 3, i11 = (y1 * w + x1) * 3;
        var di = (dy * dstW + dx) * 3;
        for (var c = 0; c < 3; c++) {
          var top = data[i00 + c] * (1 - fx) + data[i10 + c] * fx;
          var bot = data[i01 + c] * (1 - fx) + data[i11 + c] * fx;
          out[di + c] = Math.round(top * (1 - fy) + bot * fy);
        }
      }
    }
    return { w: dstW, h: dstH, data: out };
  }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function lerp2(x0, x1, y0, y1, s, t) {
    // 双线性插值：top = x0 + (x1-x0)*s; bot = y0 + (y1-y0)*s; 结果 = top + (bot-top)*t
    return (x0 + (x1 - x0) * s) * (1 - t) + (y0 + (y1 - y0) * s) * t;
  }

  // ---------- det 后处理（DB） ----------

  /** 8 连通域标记 */
  function labelConnected(map, w, h) {
    var labels = new Int32Array(w * h);
    for (var i = 0; i < w * h; i++) labels[i] = -1;
    var count = 0;
    var stack = [];
    for (var i2 = 0; i2 < w * h; i2++) {
      if (map[i2] && labels[i2] < 0) {
        labels[i2] = count;
        stack.push(i2);
        while (stack.length) {
          var p = stack.pop();
          var px = p % w, py = (p / w) | 0;
          for (var dy = -1; dy <= 1; dy++) {
            for (var dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue;
              var nx = px + dx, ny = py + dy;
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
              var ni = ny * w + nx;
              if (map[ni] && labels[ni] < 0) { labels[ni] = count; stack.push(ni); }
            }
          }
        }
        count++;
      }
    }
    return { labels: labels, count: count };
  }

  /** 点集最小外接旋转矩形：枚举每条边投影求最小面积 */
  function minAreaRect(points) {
    var best = null;
    var n = points.length;
    for (var i = 0; i < n; i++) {
      var a = points[i], b = points[(i + 1) % n];
      var dx = b.x - a.x, dy = b.y - a.y;
      var len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      var ux = dx / len, uy = dy / len;
      var vx = -uy, vy = ux;
      var minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (var k = 0; k < n; k++) {
        var p = points[k];
        var u = (p.x - a.x) * ux + (p.y - a.y) * uy;
        var v = (p.x - a.x) * vx + (p.y - a.y) * vy;
        if (u < minU) minU = u; if (u > maxU) maxU = u;
        if (v < minV) minV = v; if (v > maxV) maxV = v;
      }
      var area = (maxU - minU) * (maxV - minV);
      if (!best || area < best.area) {
        var cx = a.x + (minU + maxU) / 2 * ux + (minV + maxV) / 2 * vx;
        var cy = a.y + (minU + maxU) / 2 * uy + (minV + maxV) / 2 * vy;
        var hw = (maxU - minU) / 2, hh = (maxV - minV) / 2;
        best = {
          area: area,
          pts: [
            { x: cx - hw * ux - hh * vx, y: cy - hw * uy - hh * vy },
            { x: cx + hw * ux - hh * vx, y: cy + hw * uy - hh * vy },
            { x: cx + hw * ux + hh * vx, y: cy + hw * uy + hh * vy },
            { x: cx - hw * ux + hh * vx, y: cy - hw * uy + hh * vy }
          ]
        };
      }
    }
    return best || { area: 0, pts: points };
  }

  /**
   * 概率图 → 文本框（4 点，原图坐标）。
   * 简化 DB：阈值 → 8 连通域 → 最小外接旋转矩形 → unclip 扩张（矩形近似）。
   */
  function boxesFromProb(prob, w, h, ratioW, ratioH) {
    var map = new Uint8Array(w * h);
    for (var i = 0; i < w * h; i++) map[i] = prob[i] > DET_THRESH ? 1 : 0;
    var cc = labelConnected(map, w, h);
    var labels = cc.labels, count = cc.count;
    var comps = [];
    for (var c = 0; c < count; c++) comps.push({ minX: w, minY: h, maxX: -1, maxY: -1, sum: 0, n: 0 });
    for (var i2 = 0; i2 < w * h; i2++) {
      var l = labels[i2];
      if (l < 0) continue;
      var x = i2 % w, y = (i2 / w) | 0;
      var cp = comps[l];
      if (x < cp.minX) cp.minX = x; if (x > cp.maxX) cp.maxX = x;
      if (y < cp.minY) cp.minY = y; if (y > cp.maxY) cp.maxY = y;
      cp.sum += prob[i2]; cp.n++;
    }
    var boxes = [];
    for (var c2 = 0; c2 < count; c2++) {
      var ccp = comps[c2];
      if (ccp.n < DET_MIN_BOX_PX) continue;
      var ww = ccp.maxX - ccp.minX + 1, hh = ccp.maxY - ccp.minY + 1;
      if (ww < DET_MIN_BOX_PX || hh < DET_MIN_BOX_PX) continue;
      var avg = ccp.sum / ccp.n;
      if (avg < DET_BOX_THRESH) continue;
      // unclip：按矩形外扩（矩形近似）
      var ex = Math.max(1, ww * 0.02 * DET_UNCLIP_RATIO);
      var ey = Math.max(1, hh * 0.02 * DET_UNCLIP_RATIO);
      var x0 = Math.max(0, ccp.minX - ex), y0 = Math.max(0, ccp.minY - ey);
      var x1 = Math.min(w - 1, ccp.maxX + ex), y1 = Math.min(h - 1, ccp.maxY + ey);
      var quad = [
        { x: x0 * ratioW, y: y0 * ratioH },
        { x: x1 * ratioW, y: y0 * ratioH },
        { x: x1 * ratioW, y: y1 * ratioH },
        { x: x0 * ratioW, y: y1 * ratioH }
      ];
      boxes.push({ box: quad, score: avg });
    }
    return boxes;
  }

  // ---------- rec 后处理（CTC） ----------

  /** CTC 解码：argmax 序列去重（相邻相同合并）+ 去 blank(0) */
  function ctcDecode(probs, dict) {
    var T = probs.length;
    var text = '';
    var confSum = 0, confN = 0;
    var last = -1;
    for (var t = 0; t < T; t++) {
      var row = probs[t];
      var C = row.length;
      var argmax = 0, maxp = -Infinity;
      for (var c = 0; c < C; c++) {
        if (row[c] > maxp) { maxp = row[c]; argmax = c; }
      }
      if (argmax !== last && argmax !== 0) {
        text += dict[argmax] || '?';
        confSum += maxp; confN++;
      }
      last = argmax;
    }
    return { text: text, conf: confN ? confSum / confN : 0 };
  }

  // ---------- 默认资源加载器（浏览器 fetch） ----------

  /** 浏览器默认：相对 baseUrl（默认空=页面根）fetch */
  function browserAssetLoader(baseUrl) {
    baseUrl = baseUrl || '';
    if (baseUrl && baseUrl[baseUrl.length - 1] !== '/') baseUrl += '/';
    return {
      loadScript: function (url) {
        return new Promise(function (resolve, reject) {
          var s = document.createElement('script');
          s.src = baseUrl + url;
          s.onload = function () { resolve(); };
          s.onerror = function () { reject(new Error('加载脚本失败：' + url)); };
          (document.head || document.documentElement).appendChild(s);
        });
      },
      getBytes: function (url) {
        return fetch(baseUrl + url).then(function (r) {
          if (!r.ok) throw new Error('获取资源失败：' + url + ' (HTTP ' + r.status + ')');
          return r.arrayBuffer();
        });
      },
      getText: function (url) {
        return fetch(baseUrl + url).then(function (r) {
          if (!r.ok) throw new Error('获取资源失败：' + url + ' (HTTP ' + r.status + ')');
          return r.text();
        });
      }
    };
  }

  // ---------- 运行时创建 ----------

  var runtimeCache = null;

  /**
   * 创建并缓存 OCR 运行时（加载 ort + 3 模型 + 字典）。
   * options:
   *   assetLoader?  { loadScript, getBytes, getText }；缺省用浏览器 fetch 实现
   *   baseUrl?      浏览器资源相对路径（默认 '' = 页面根）
   *   numThreads?   0=自动（有 crossOriginIsolated 用多线程，否则 1）
   *   onProgress?   (stage:string, done:number, total:number) => void
   */
  function createRuntime(options) {
    if (runtimeCache) return runtimeCache;
    options = options || {};
    var loader = options.assetLoader || browserAssetLoader(options.baseUrl);
    var ort = null;
    var total = 6, done = 0;
    function prog(stage) {
      done++;
      if (options.onProgress) {
        try { options.onProgress(stage, done, total); } catch (e) { /* ignore */ }
      }
    }

    var p = Promise.resolve().then(function () {
      // 1. 加载 ort（UMD：浏览器全局 / Node require）
      if (options.ort) {
        ort = options.ort;
        prog('ort');
        return;
      }
      if (typeof window !== 'undefined' && window.ort) {
        ort = window.ort;
        prog('ort');
        return;
      }
      if (typeof module === 'object' && module.require) {
        try {
          // Node：从 RUNTIME_FILES.ortJs 相对项目根 require（测试环境注入 rootDir）
          var fs = require('fs'), path = require('path');
          var pkg = options.rootDir || process.cwd();
          ort = module.require(path.join(pkg, RUNTIME_FILES.ortJs));
          prog('ort');
          return;
        } catch (e) { /* 落到 loader.loadScript */ }
      }
      return loader.loadScript(RUNTIME_FILES.ortJs).then(function () {
        ort = (typeof window !== 'undefined') ? window.ort : (typeof self !== 'undefined' ? self.ort : null);
        if (!ort) throw new Error('ort 加载失败：未找到 window.ort/self.ort');
        prog('ort');
      });
    }).then(function () {
      runtimeOrt = ort;
      // 2. 加载 wasm 二进制 + 配置 ort 的 wasm 模块路径
      return loader.getBytes(RUNTIME_FILES.ortWasm).then(function (buf) {
        ort.env.wasm.numThreads = resolveThreads(options);
        ort.env.wasm.wasmBinary = buf;
        // 显式给出 .mjs/.wasm 的绝对路径：ort 的 wasm 胶水模块用动态 import() 加载，
        // 在 classic Worker 里相对路径会按 Worker 脚本 URL（而非页面/资源 URL）解析 → 404。
        // 绝对 URL 的 import() 在 Worker 里可用；wasmBinary 已提供，二进制不再走网络。
        try {
          var base = options.baseUrl || (typeof location !== 'undefined' ? location.href : '');
          var mjsUrl = new URL(RUNTIME_FILES.ortMjs, base).href;
          ort.env.wasm.wasmPaths = { mjs: mjsUrl, wasm: mjsUrl.replace(/\.mjs$/, '.wasm') };
        } catch (e) { /* 解析失败则交给 ort 默认逻辑 */ }
        prog('wasm');
      });
    }).then(function () {
      // 3. 加载三个模型
      return Promise.all([
        loader.getBytes(RUNTIME_FILES.det).then(function (b) { return ort.InferenceSession.create(b, { executionProviders: ['wasm'] }); }),
        loader.getBytes(RUNTIME_FILES.rec).then(function (b) { return ort.InferenceSession.create(b, { executionProviders: ['wasm'] }); }),
        loader.getBytes(RUNTIME_FILES.cls).then(function (b) { return ort.InferenceSession.create(b, { executionProviders: ['wasm'] }); })
      ]).then(function (sessions) {
        runtimeSessions = sessions;
        prog('det'); prog('rec'); prog('cls');
      });
    }).then(function () {
      // 4. 加载字典
      return loader.getText(RUNTIME_FILES.dict).then(function (txt) {
        var dict = txt.split('\n').map(function (s) { return s.replace(/\r$/, ''); });
        dict.unshift('');   // index 0 = blank
        runtimeDict = dict;
        prog('dict');
      });
    });

    runtimeCache = p;
    return p;
  }
  function resolveThreads(options) {
    if (options.numThreads) return options.numThreads;
    // 有跨源隔离（COOP/COEP）→ 可多线程；否则单线程
    if (typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated) {
      var hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
      return Math.min(4, hc);
    }
    return 1;
  }
  var runtimeSessions = null;
  var runtimeDict = null;
  var runtimeOrt = null;
  function requireRuntime() {
    if (!runtimeSessions || !runtimeDict || !runtimeOrt) throw new Error('OCR 运行时未加载，先调用 Ocr.createRuntime()');
    return { ort: runtimeOrt, sessions: runtimeSessions, dict: runtimeDict };
  }

  // ---------- det / cls / rec 推理（复用 runtime 的 ort） ----------

  function runDet(ort, detS, rgb, w, h) {
    // limit_type=min：把短边放到 limit_side_len
    var ratio = DET_LIMIT_TYPE === 'max'
      ? Math.min(1, DET_LIMIT_SIDE / Math.max(w, h))
      : (Math.min(w, h) < DET_LIMIT_SIDE ? DET_LIMIT_SIDE / Math.min(w, h) : 1);
    var tw = Math.max(32, Math.ceil(Math.round(w * ratio) / 32) * 32);
    var th = Math.max(32, Math.ceil(Math.round(h * ratio) / 32) * 32);
    var img = resizeRgb(rgb, tw, th);
    var mean = 0.5, std = 0.5, scale = 1 / 255;
    var input = new Float32Array(1 * 3 * th * tw);
    for (var i = 0; i < th * tw; i++) {
      input[i] = (img.data[i * 3] * scale - mean) / std;
      input[th * tw + i] = (img.data[i * 3 + 1] * scale - mean) / std;
      input[2 * th * tw + i] = (img.data[i * 3 + 2] * scale - mean) / std;
    }
    return detS.run({ [detS.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, th, tw]) }).then(function (out) {
      var outName = detS.outputNames[0];
      var prob = out[outName].data;
      var pw = out[outName].dims[3], ph = out[outName].dims[2];
      return boxesFromProb(prob, pw, ph, w / pw, h / ph);
    });
  }

  function runCls(ort, clsS, rgb) {
    var H = CLS_IMG_SHAPE[1], W = CLS_IMG_SHAPE[2];
    var img = resizeRgb(rgb, W, H);
    var mean = 0.5, std = 0.5;
    var input = new Float32Array(1 * 3 * H * W);
    for (var i = 0; i < H * W; i++) {
      input[i] = (img.data[i * 3] / 255 - mean) / std;
      input[H * W + i] = (img.data[i * 3 + 1] / 255 - mean) / std;
      input[2 * H * W + i] = (img.data[i * 3 + 2] / 255 - mean) / std;
    }
    return clsS.run({ [clsS.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, H, W]) }).then(function (out) {
      var d = out[clsS.outputNames[0]].data;
      var label = d[0] >= d[1] ? 0 : 1;
      var conf = Math.max(d[0], d[1]);
      return { angle: label === 1 ? 180 : 0, conf: conf };
    });
  }

  function runRec(ort, recS, rgb, dict) {
    var H = REC_IMG_SHAPE[1], W = REC_IMG_SHAPE[2];
    var w = rgb.w, h = rgb.h;
    var maxWhRatio = W / H;
    var u = H / h;
    var l = Math.max(8, Math.round(w * u));
    l = Math.min(l, Math.round(H * maxWhRatio));
    l = Math.min(l, W);
    var resized = resizeRgb(rgb, l, H);
    var mean = 0.5, std = 0.5;
    var input = new Float32Array(1 * 3 * H * W);
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < l; x++) {
        var si = (y * l + x) * 3;
        var di = y * W + x;
        input[di] = (resized.data[si] / 255 - mean) / std;
        input[H * W + di] = (resized.data[si + 1] / 255 - mean) / std;
        input[2 * H * W + di] = (resized.data[si + 2] / 255 - mean) / std;
      }
    }
    return recS.run({ [recS.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, H, W]) }).then(function (out) {
      var outName = recS.outputNames[0];
      var dims = out[outName].dims;
      var T = dims[1], C = dims[2];
      var d = out[outName].data;
      var probs = [];
      for (var t = 0; t < T; t++) {
        var row = new Float32Array(C);
        for (var c = 0; c < C; c++) row[c] = d[t * C + c];
        probs.push(row);
      }
      return ctcDecode(probs, dict);
    });
  }

  // ---------- 阅读顺序排序 ----------

  /**
   * 按阅读顺序排序：先按 y 分桶（同一行 = 行高容差内），桶内按 x，桶间按 y。
   * boxes: [{box:[p0,p1,p2,p3], ...}]（p0 左上、p1 右上、p2 右下、p3 左下）
   */
  function sortReadingOrder(items) {
    if (items.length <= 1) return items;
    // 每行取 top-y 与行高
    var entries = items.map(function (it) {
      var top = Math.min(it.box[0].y, it.box[3].y);
      var bot = Math.max(it.box[1].y, it.box[2].y);
      var left = Math.min(it.box[0].x, it.box[3].x);
      return { it: it, top: top, bot: bot, left: left, h: Math.max(1, bot - top) };
    });
    entries.sort(function (a, b) { return a.top - b.top; });
    // 贪心分桶：与当前桶最后一行 top 相差 <= 中位行高*0.5 → 同行
    var hs = entries.map(function (e) { return e.h; }).sort(function (a, b) { return a - b; });
    var medH = hs[hs.length >> 1] || 1;
    var buckets = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var last = buckets.length ? buckets[buckets.length - 1] : null;
      if (last && e.top - last.anchorTop <= medH * 0.5) {
        last.items.push(e);
        last.anchorTop = Math.max(last.anchorTop, e.top);
      } else {
        buckets.push({ items: [e], anchorTop: e.top });
      }
    }
    var out = [];
    for (var b = 0; b < buckets.length; b++) {
      buckets[b].items.sort(function (a, b2) { return a.left - b2.left; });
      for (var j = 0; j < buckets[b].items.length; j++) out.push(buckets[b].items[j].it);
    }
    return out;
  }

  // ---------- 主识别入口 ----------

  /**
   * 识别一张图片。返回 Promise<{ text, lines }>。
   *   lines[i] = { text, box:[4 点, 输入图坐标], conf, lowConf }
   *   text = 按阅读顺序拼接的全文（剔除 lowConf 行）
   * 输入 data: RGBA(32bpp, stride 对齐)，白底。
   */
  function recognize(img) {
    var rt = requireRuntime();
    var ort = rt.ort, dict = rt.dict;
    var detS = rt.sessions[0], recS = rt.sessions[1], clsS = rt.sessions[2];
    var w = img.width, h = img.height;
    var stride = img.stride || w * 4;
    var rgb = rgbaToRgb(img.data, w, h, stride);

    return runDet(ort, detS, rgb, w, h).then(function (boxes) {
      var tasks = [];
      for (var i = 0; i < boxes.length; i++) {
        (function (b) {
          tasks.push(
            Promise.resolve().then(function () {
              // 透视矫正裁剪
              var crop = warpQuad(rgb, b.box);
              return runCls(ort, clsS, crop).then(function (cls) {
                var img2 = crop;
                if (cls.angle === 180) img2 = rotateRgb(crop, 2);
                return runRec(ort, recS, img2, dict).then(function (rec) {
                  return { text: rec.text, conf: rec.conf, box: b.box, boxScore: b.score, clsAngle: cls.angle };
                });
              });
            })
          );
        })(boxes[i]);
      }
      return Promise.all(tasks).then(function (rawLines) {
        var sorted = sortReadingOrder(rawLines);
        var kept = sorted.filter(function (l) { return l.conf >= CONF_KEEP && l.text !== ''; });
        var text = kept.map(function (l) { return l.text; }).join('\n');
        return {
          text: text,
          lines: sorted.map(function (l) {
            return {
              text: l.text,
              box: l.box,
              conf: l.conf,
              lowConf: l.conf < CONF_KEEP
            };
          })
        };
      });
    });
  }

  // ---------- OCR 行 → pdf.js textItems（扫描版直接标注） ----------

  /**
   * 把一页 OCR 结果转换为 pdf.js textItems 同构结构（供 PdfView 差异标注复用）。
   * lines: Ocr.recognize 的 lines（box 为「识别时输入图」像素坐标）。
   * pageW/pageH: 该页 pdf.js page.getViewport({scale:1}) 的宽高（PDF 页面单位）。
   * 输入图（识别时）与 PDF 页面单位之间的换算：输入图 = 页面按 scale 渲染 → 1 输入像素 = 1/pageScale 页面单位。
   * 调用方传入 pageScale（渲染输入图时用的 pdf.js scale），本函数把像素 → 页面单位。
   *
   * pageNum/startLine：多页累积时传入当前页号与前面页已占用的行数（startLine 从 0 起），
   * 返回的 textItems 行号跨页连续（第 1 页 1..N，第 2 页 N+1..M…），与拼接后的全文行号一一对应。
   *
   * 返回 [{ page: pageNum, boxes:[{transform, width, line, col, str, hasEOL}] }]，
   * 每行一个 textItem（str = 行文本，transform 由行矩形推导）。
   * 与 PdfView.collectItems 产出的结构一致 → computeHlBoxes/applyHighlights/rasterizePage 零改动复用。
   */
  function linesToTextItems(lines, pageW, pageH, pageScale, pageNum, startLine) {
    pageScale = pageScale || 1;
    pageNum = pageNum || 1;
    startLine = startLine || 0;
    var inv = 1 / pageScale;
    var boxes = [];
    var line = startLine;
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (!l || l.lowConf || l.text === '') continue;   // 低置信行不参与标注坐标
      var q = l.box;
      // 输入图坐标 → 页面单位
      var x0 = Math.min(q[0].x, q[3].x) * inv;
      var x1 = Math.max(q[1].x, q[2].x) * inv;
      var y0 = Math.min(q[0].y, q[1].y) * inv;
      var y1 = Math.max(q[2].y, q[3].y) * inv;
      var bw = Math.max(0, x1 - x0);
      var bh = Math.max(0, y1 - y0);
      var fontH = bh > 0 ? bh : 12;
      // pdf.js 文本矩阵：transform=[a,b,c,d,e,f]，e/f=基线原点，字身高=sqrt(c²+d²)
      // 合成：a=fontH(横向字宽近似), d=fontH, e=x0, f=y0+fontH（基线≈框顶+字身）
      line++;
      boxes.push({
        transform: [fontH, 0, 0, fontH, x0, y0 + fontH],
        width: bw,
        line: line,
        col: 0,
        str: l.text,
        hasEOL: true
      });
    }
    return [{ page: pageNum, boxes: boxes }];
  }

  return {
    createRuntime: createRuntime,
    recognize: recognize,
    linesToTextItems: linesToTextItems,
    sortReadingOrder: sortReadingOrder,
    RUNTIME_FILES: RUNTIME_FILES,
    CONF_KEEP: CONF_KEEP,
    _internal: {
      rgbaToRgb: rgbaToRgb,
      resizeRgb: resizeRgb,
      rotateRgb: rotateRgb,
      warpQuad: warpQuad,
      ctcDecode: ctcDecode,
      labelConnected: labelConnected,
      minAreaRect: minAreaRect,
      boxesFromProb: boxesFromProb
    }
  };
});
