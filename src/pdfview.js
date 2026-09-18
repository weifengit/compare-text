/**
 * pdfview.js — PDF 自绘查看器（基于 pdf.js legacy，全局 pdfjsLib）。
 * 职责：把 PDF 渲染到 canvas、支持缩放模式、文本提取与字段分段。
 * 不依赖 source-api / app.js；URL 由调用方传入（低耦合）。
 * 全局暴露：PdfView
 *
 * PdfView.init({ left, right })                    // left/right: 两个面板容器
 * PdfView.load(side, url)                          // side: 'L'|'R'，渲染全部页面
 * PdfView.clear(side?)                             // 清空指定 / 全部面板
 * PdfView.setMode(mode) / getMode()                // 'auto'|'width'|'page'|'actual'
 * PdfView.extractText(url) → Promise<string>       // 提取全部文本（逐页拼接）
 * PdfView.segmentFields(text) → [{label,text}]     // 按编号/标题行切分章节（字段）
 * PdfView.setHighlight(side,map) / getHighlight(side) // 差异标注：行号→'rm'|'ad' 或 {t:'ch',segs:[{text,cls}]}（字符级）
 * PdfView.isLoaded(side)                            // 该侧是否已加载 PDF
 */
(function (root) {
  'use strict';

  var panels = { L: null, R: null };
  var docs = { L: null, R: null };
  var loadSeq = { L: 0, R: 0 };   // 每侧加载令牌：丢弃过期的 getDocument
  var mode = 'auto';
  var highlights = { L: {}, R: {} };      // 行号 → 'rm'|'ad'|'ch' 的差异标注映射
  var textItems = { L: null, R: null };   // 每侧 [{page, boxes:[{transform,width,line}]}]，与 collectText 行号一致
  var pageVps = { L: [], R: [] };         // 每侧每页当前 PageViewport（供重绘时换算坐标）
  var renderGen = { L: 0, R: 0 };         // 每侧渲染代数：renderAll 递增，renderPage 回调据此丢弃过期页面
  var renderTasks = { L: {}, R: {} };     // 每侧每页在途 RenderTask（重绘前取消，避免叠加/残留）
  var W = (typeof window !== 'undefined') ? window : null;

  /** 2D 矩阵相乘（pdf.js 的 [a,b,c,d,e,f] 形式）。把文本项变换（PDF 空间）变换到页面像素空间：像素 = vp * item */
  function mulMat(m1, m2) {
    return [
      m1[0] * m2[0] + m1[2] * m2[1],
      m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3],
      m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
      m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
    ];
  }

  /** 取消一侧全部在途渲染任务 */
  function cancelRenderTasks(side) {
    var t = renderTasks[side];
    for (var k in t) {
      if (t[k] && t[k].cancel) { try { t[k].cancel(); } catch (e) { /* 忽略 */ } }
      delete t[k];
    }
  }

  // 指定 pdf.js 的 Worker 脚本（相对页面根路径）
  if (root.pdfjsLib && root.pdfjsLib.GlobalWorkerOptions && !root.pdfjsLib.GlobalWorkerOptions.workerSrc) {
    root.pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
  }

  function clearPanel(side) {
    var p = panels[side];
    if (p) p.innerHTML = '';
    cancelRenderTasks(side);
    renderGen[side]++;                   // 作废在途 renderPage 回调，防止追加过期页面
    if (docs[side]) { try { docs[side].destroy && docs[side].destroy(); } catch (e) { /* 忽略 */ } docs[side] = null; }
    highlights[side] = {};
    textItems[side] = null;
    pageVps[side] = [];
  }

  function clear(side) {
    if (side === 'L' || side === 'R') clearPanel(side);
    else { clearPanel('L'); clearPanel('R'); }
  }

  /** 缩放比例：actual=100%；page=整页适配；width=适应宽度；auto=适应宽度但不超过实际大小 */
  function pageScale(vp1, p) {
    var cw = (p.clientWidth || 600) - 2;
    var ch = (p.clientHeight || 800) - 2;
    if (mode === 'actual') return 1;
    if (mode === 'page') return Math.max(0.1, Math.min(cw / vp1.width, ch / vp1.height));
    var fit = cw / vp1.width;
    return mode === 'auto' ? Math.min(fit, 1) : Math.max(fit, 0.1);
  }

  function renderPage(side, pageNum, pdf, gen) {
    var p = panels[side];
    if (!p) return;
    pdf.getPage(pageNum).then(function (page) {
      if (gen !== renderGen[side]) return;      // 过期渲染：已被新渲染取代，不追加不绘制
      var vp1 = page.getViewport({ scale: 1 });
      var scale = pageScale(vp1, p);
      var vp = page.getViewport({ scale: scale });
      var dpr = (W && W.devicePixelRatio) || 1; // 高分屏：canvas 按 dpr 渲染再缩放到 CSS 尺寸，避免模糊
      var wrap = document.createElement('div');
      wrap.className = 'pdf-page';
      wrap._pageNum = pageNum;
      wrap.style.height = vp.height + 'px';
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(vp.width * dpr));
      canvas.height = Math.max(1, Math.floor(vp.height * dpr));
      canvas.style.width = vp.width + 'px';
      canvas.style.height = vp.height + 'px';
      wrap.appendChild(canvas);
      var layer = document.createElement('div');
      layer.className = 'pdf-hl-layer';
      wrap._hlLayer = layer;
      wrap.appendChild(layer);
      var textLayer = document.createElement('div');
      textLayer.className = 'pdf-text-layer';
      wrap._textLayer = textLayer;
      wrap.appendChild(textLayer);
      p.appendChild(wrap);
      pageVps[side][pageNum - 1] = vp;
      var ctx = canvas.getContext('2d');
      if (ctx) {
        var task = page.render({
          canvasContext: ctx,
          viewport: vp,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null
        });
        renderTasks[side][pageNum] = task;
        task.promise.catch(function () { if (renderTasks[side][pageNum] === task) delete renderTasks[side][pageNum]; });
      }
      try { paintPage(side, pageNum, wrap, vp); }      // 差异标注：失败不影响页面渲染
      catch (e) { /* 忽略 */ }
      try { paintTextLayer(side, pageNum, wrap, vp); } // 可选中文本层：同上
      catch (e) { /* 忽略 */ }
    }).catch(function () { /* 单页失败忽略 */ });
  }

  function renderAll(side) {
    var pdf = docs[side];
    var p = panels[side];
    if (!pdf || !p) return;
    var gen = ++renderGen[side];
    cancelRenderTasks(side);                 // 取消上一轮在途渲染，防止残留叠加
    p.innerHTML = '';
    pageVps[side] = [];
    var total = pdf.numPages;
    for (var i = 1; i <= total; i++) renderPage(side, i, pdf, gen);
  }

  function load(side, url, token) {
    if (!root.pdfjsLib) return Promise.reject(new Error('pdf.js 未加载'));
    clearPanel(side);
    var p = panels[side];
    if (!p) return Promise.resolve();
    if (token === undefined) token = ++loadSeq[side];
    else loadSeq[side] = token;
    p.innerHTML = '<div class="pdf-loading">加载 PDF…</div>';
    return root.pdfjsLib.getDocument(url).promise.then(function (pdf) {
      if (loadSeq[side] !== token) {                 // 已被更新的加载取代 → 丢弃
        try { pdf.destroy && pdf.destroy(); } catch (e) { /* 忽略 */ }
        return undefined;
      }
      docs[side] = pdf;
      renderAll(side);
      if (pdf.numPages) collectItems(pdf, side, token);   // 收集文本项 → 行号→坐标 → 标注
      return pdf;
    }).catch(function (err) {
      if (loadSeq[side] === token && p) p.innerHTML = '<div class="pdf-error">PDF 加载失败：' + ((err && err.message) || err) + '</div>';
      throw err;
    });
  }

  function setMode(m) {
    mode = m;
    ['L', 'R'].forEach(function (s) { if (docs[s]) renderAll(s); });
  }
  function getMode() { return mode; }

  // 窗口尺寸变化时重排（节流）
  if (W) {
    var t = null;
    W.addEventListener('resize', function () {
      clearTimeout(t);
      t = setTimeout(function () { ['L', 'R'].forEach(function (s) { if (docs[s]) renderAll(s); }); }, 200);
    });
  }

  /** 从已加载的 pdf 文档提取全部文本（逐页，按文本项的 hasEOL 保留换行） */
  function collectText(pdf) {
    var chunks = [];
    var chain = Promise.resolve();
    function onePage(n) {
      return pdf.getPage(n).then(function (page) {
        return page.getTextContent().then(function (tc) {
          var out = '';
          for (var i = 0; i < tc.items.length; i++) {
            var it = tc.items[i];
            out += it.str;
            if (it.hasEOL) out += '\n';
          }
          chunks.push(out);
        });
      });
    }
    for (var i = 1; i <= pdf.numPages; i++) {
      (function (n) { chain = chain.then(function () { return onePage(n); }); })(i);
    }
    return chain.then(function () { return chunks.join('\n'); });
  }

  /** 提取 PDF 全部文本（自建文档，提完销毁；供一次性取词使用） */
  function extractText(url) {
    if (!root.pdfjsLib) return Promise.reject(new Error('pdf.js 未加载'));
    return root.pdfjsLib.getDocument(url).promise.then(function (pdf) {
      return collectText(pdf).then(function (text) {
        try { pdf.destroy && pdf.destroy(); } catch (e) { /* 忽略 */ }
        return text;
      });
    });
  }

  /** 从面板已加载的文档提取文本（不销毁，须在 load() 成功之后调用；供渲染+取词共用一次加载） */
  function extractPanel(side) {
    var pdf = docs[side];
    if (!pdf) return Promise.reject(new Error('PDF 未加载'));
    return collectText(pdf);
  }

  /** 字段分段（v1 启发式）：以编号/标题行作为新章节起点 */
  var HEAD_RE = /^\s*(?:第[一二三四五六七八九十百\d]+[章章节条]|[（(]?[0-9一二三四五六七八九十]{1,3}[.、．)）]\s)/;
  function segmentFields(text) {
    var lines = String(text || '').split('\n');
    var segs = [], cur = null;
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (HEAD_RE.test(ln)) {
        if (cur) segs.push(cur);
        cur = { label: ln.replace(/\s+/g, ' ').slice(0, 24), text: ln };
      } else if (cur) {
        cur.text += '\n' + ln;
      }
    }
    if (cur) segs.push(cur);
    return segs;
  }

  // ---------- 差异标注：把 diff 行号/字符区间映射到 PDF 文本项坐标 ----------

  var _mctx = null;   // 复用的测量 canvas（测不出时降级为均宽估算）
  function getMeasureCtx(fontH) {
    if (typeof document === 'undefined' || !document.createElement) return null;
    if (!_mctx) {
      try { var c = document.createElement('canvas'); _mctx = (c && c.getContext) ? c.getContext('2d') : null; }
      catch (e) { _mctx = null; }
    }
    if (_mctx) try { _mctx.font = fontH + 'px sans-serif'; } catch (e) { /* 桩环境忽略 */ }
    return _mctx;
  }

  /** 项内前 k 个字符的宽度（页面像素）。实测失败 → 按项宽均摊兜底 */
  function prefixWidth(itemStr, k, fontH, itemWpx) {
    var w = NaN;
    var ctx = getMeasureCtx(fontH);
    if (ctx) {
      try { var m = ctx.measureText(itemStr.slice(0, k)); if (m && typeof m.width === 'number') w = m.width; }
      catch (e) { w = NaN; }
    }
    if (!isFinite(w) || w < 0) w = itemWpx * (k / Math.max(1, itemStr.length));
    return w;
  }

  /** segs（区域1 变更行的字符片段）→ 非 eq 片段的行内偏移区间 [[s,e),...] */
  function segRanges(segs) {
    var out = [], off = 0;
    for (var i = 0; i < segs.length; i++) {
      var len = segs[i].text.length;
      if (segs[i].cls !== 'eq' && len > 0) out.push([off, off + len]);
      off += len;
    }
    return out;
  }

  function addHlBox(layer, cls, x, y, w, h) {
    var d = document.createElement('div');
    d.className = 'pdf-hl ' + cls;
    d.style.left = x + 'px';
    d.style.top = y + 'px';
    d.style.width = Math.max(1, w) + 'px';
    d.style.height = h + 'px';
    layer.appendChild(d);
  }

  /**
   * 在页面上画一层标注。hl 值两种形态：
   *   'rm'|'ad'           → 整行（该文本项）涂色；
   *   { t:'ch', segs }    → 只涂 segs 中非 eq 的字符区间（与区域1 行内高亮同源）。
   * 垂直方向：框顶=基线-字身高度，框高=字身×1.35，覆盖上伸/下伸笔画。
   */
  function paintInto(wrap, boxes, vp, hl) {
    var layer = wrap._hlLayer;
    if (!layer || !vp || !boxes) return;
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      var t = hl[b.line];
      if (!t) continue;
      var tm = mulMat(vp.transform, b.transform);
      var fontH = Math.max(1, Math.sqrt(tm[2] * tm[2] + tm[3] * tm[3]));
      var top = tm[5] - fontH;                       // 文本矩阵原点在基线：自字身上沿盖起
      var h = fontH * 1.35;                          // 下沿探到基线之下，覆盖 g/y/p 等下伸笔画
      var x0 = tm[4];
      var itemW = (b.width || 0) * vp.scale;
      if (typeof t === 'string') {
        addHlBox(layer, t, x0, top, itemW, h);
        continue;
      }
      var ranges = segRanges(t.segs || []);
      var full = prefixWidth(b.str, b.str.length, fontH, itemW);
      var ratio = full > 0 ? itemW / full : 1;       // 以 PDF 实际项宽归一测量误差，区间端点与项边缘对齐
      for (var r = 0; r < ranges.length; r++) {
        var s = ranges[r][0] - b.col, e = ranges[r][1] - b.col;   // 行内偏移 → 项内偏移
        if (e <= 0 || s >= b.str.length) continue;
        s = Math.max(0, s); e = Math.min(b.str.length, e);
        if (e <= s) continue;
        var xs = x0 + prefixWidth(b.str, s, fontH, itemW) * ratio;
        var xe = x0 + prefixWidth(b.str, e, fontH, itemW) * ratio;
        addHlBox(layer, t.t || 'ch', xs, top, xe - xs, h);
      }
    }
  }

  function paintPage(side, pageNum, wrap, vp) {
    var pages = textItems[side];
    if (!pages || !wrap._hlLayer) return;
    var boxes = null;
    for (var i = 0; i < pages.length; i++) {
      if (pages[i].page === pageNum) { boxes = pages[i].boxes; break; }
    }
    if (boxes) paintInto(wrap, boxes, vp, highlights[side] || {});
  }

  /** 全部页重绘标注层（不重渲 canvas） */
  function applyHighlights(side) {
    var p = panels[side];
    if (!p) return;
    var pages = textItems[side];
    if (!pages) return;
    var vps = pageVps[side] || [];
    var byPage = {};
    for (var i = 0; i < pages.length; i++) byPage[pages[i].page] = pages[i];
    for (var c = 0; c < (p.children || []).length; c++) {
      var wrap = p.children[c];
      var n = wrap._pageNum;
      if (!n || !byPage[n] || !wrap._hlLayer) continue;
      wrap._hlLayer.innerHTML = '';
      paintInto(wrap, byPage[n].boxes, vps[n - 1], highlights[side] || {});
    }
  }

  /** 在页面文本层按 PDF 度量逐项摆放 div（文字透明，靠浏览器原生选中高亮显示），实现鼠标选中 */
  function paintTextLayer(side, pageNum, wrap, vp) {
    var layer = wrap._textLayer;
    if (!layer || !vp) return;
    var pages = textItems[side];
    if (!pages) return;
    var boxes = null;
    for (var i = 0; i < pages.length; i++) {
      if (pages[i].page === pageNum) { boxes = pages[i].boxes; break; }
    }
    if (!boxes) { layer.innerHTML = ''; return; }
    layer.innerHTML = '';
    for (i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      if (!b.str) continue;
      var tm = mulMat(vp.transform, b.transform);
      var hgt = Math.max(1, Math.hypot(tm[2], tm[3]));         // 字身高度（页面像素）
      var boxH = hgt * 1.35;                                   // 盒高含下伸余量：与差异标注框同几何
      var d = document.createElement('div');
      d.className = 'pdf-tl';
      d.style.left = tm[4] + 'px';
      d.style.top = (tm[5] - hgt) + 'px';                      // 文字矩阵原点在基线：框顶 = 基线 - 字身高度
      d.style.width = (b.width * vp.scale) + 'px';
      d.style.height = boxH + 'px';
      d.style.fontSize = hgt + 'px';
      d.style.lineHeight = boxH + 'px';                        // 行盒撑满整盒：拖选底纹覆盖到字脚（下伸笔画）
      d.textContent = b.str + (b.hasEOL ? '\n' : '');
      layer.appendChild(d);
    }
  }

  /** 全部页重建文本层（canvas 重排后调用，与 applyHighlights 同级） */
  function applyTextLayer(side) {
    var p = panels[side];
    if (!p) return;
    var pages = textItems[side];
    if (!pages) return;
    var vps = pageVps[side] || [];
    var byPage = {};
    for (var i = 0; i < pages.length; i++) byPage[pages[i].page] = pages[i];
    for (var c = 0; c < (p.children || []).length; c++) {
      var wrap = p.children[c];
      var n = wrap._pageNum;
      if (!n || !byPage[n] || !wrap._textLayer) continue;
      paintTextLayer(side, n, wrap, vps[n - 1]);
    }
  }

  /** 收集各页文本项及其起始行号（全局行计数器与 collectText 完全一致）；col 为该项在行内的起始字符偏移 */
  function collectItems(pdf, side, token) {
    var pages = [];
    var line = 1;                       // 1-based：collectText 产出的文本行号
    var col = 0;                        // 当前文本项在行内的起始字符偏移（跨文本项续行时累计）
    var chain = Promise.resolve();
    function onePage(n) {
      return pdf.getPage(n).then(function (page) {
        return page.getTextContent().then(function (tc) {
          var boxes = [];
          for (var i = 0; i < tc.items.length; i++) {
            var it = tc.items[i];
            var str = String(it.str || '');
            boxes.push({ transform: it.transform, width: it.width, line: line, col: col, str: str, hasEOL: !!it.hasEOL });
            var nl = str.split('\n').length - 1;
            if (nl > 0) col = str.length - (str.lastIndexOf('\n') + 1);   // 项内含换行：col 重置为末段长度
            else col += str.length;
            line += nl;
            if (it.hasEOL) { line++; col = 0; }
          }
          pages.push({ page: n, boxes: boxes });
          line++; col = 0;              // 页间 join '\n'
        });
      });
    }
    for (var i = 1; i <= pdf.numPages; i++) {
      (function (n) { chain = chain.then(function () { return onePage(n); }); })(i);
    }
    return chain.then(function () {
      if (loadSeq[side] !== token) return;   // 已被新加载取代：不写入过期文本项
      textItems[side] = pages;
      applyHighlights(side);
      applyTextLayer(side);                  // 文本项就绪后补绘可选中文本层
    }).catch(function (e) { /* 标注收集失败不致命：仅失去高亮与文本层，但留痕便于排查 */
      if (W) W.__pdfCollectErr = (e && e.message) || String(e);
    });
  }

  function setHighlight(side, map) {
    highlights[side] = map || {};
    if (docs[side]) applyHighlights(side);
  }
  function getHighlight(side) { return highlights[side] || {}; }
  function isLoaded(side) { return !!docs[side]; }

  root.PdfView = {
    init: function (els) { panels.L = (els && els.left) || null; panels.R = (els && els.right) || null; },
    load: load, clear: clear, setMode: setMode, getMode: getMode,
    getPanel: function (side) { return panels[side] || null; },
    // 仅诊断用：各内部分解状态（正常功能不依赖）
    _debug: function (side) {
      var t = textItems[side] || [];
      return { pages: t.length, boxes: t.map(function (pg) { return pg.boxes.length; }),
        vps: (pageVps[side] || []).length, wraps: (panels[side] || {}).children ? panels[side].children.length : 0,
        hl: Object.keys(highlights[side] || {}).length, loadToken: loadSeq[side] };
    },
    extractText: extractText, extractPanel: extractPanel, segmentFields: segmentFields,
    setHighlight: setHighlight, getHighlight: getHighlight, isLoaded: isLoaded
  };
})(typeof self !== 'undefined' ? self : this);
