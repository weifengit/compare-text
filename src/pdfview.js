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
 * PdfView.setHighlight(side,map) / getHighlight(side) // 差异标注：行号→'rm'|'ad'|'ch'
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
      var wrap = document.createElement('div');
      wrap.className = 'pdf-page';
      wrap._pageNum = pageNum;
      wrap.style.height = vp.height + 'px';
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(vp.width));
      canvas.height = Math.max(1, Math.floor(vp.height));
      canvas.style.width = vp.width + 'px';
      canvas.style.height = vp.height + 'px';
      wrap.appendChild(canvas);
      var layer = document.createElement('div');
      layer.className = 'pdf-hl-layer';
      wrap._hlLayer = layer;
      wrap.appendChild(layer);
      p.appendChild(wrap);
      pageVps[side][pageNum - 1] = vp;
      var ctx = canvas.getContext('2d');
      if (ctx) {
        var task = page.render({ canvasContext: ctx, viewport: vp });
        renderTasks[side][pageNum] = task;
        task.promise.catch(function () { if (renderTasks[side][pageNum] === task) delete renderTasks[side][pageNum]; });
      }
      try { paintPage(side, pageNum, wrap, vp); }   // 标注失败不影响页面渲染
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

  // ---------- 差异标注：把 diff 行号映射到 PDF 文本项坐标 ----------

  /** 在页面上画一层标注：每文本项若其起始行在 hl 映射中命中，则按坐标涂色 */
  function paintInto(wrap, boxes, vp, hl) {
    var layer = wrap._hlLayer;
    if (!layer || !vp || !boxes) return;
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      var t = hl[b.line];
      if (!t) continue;
      var tm = vp.transform(b.transform);
      var h = Math.sqrt(tm[2] * tm[2] + tm[3] * tm[3]);
      var d = document.createElement('div');
      d.className = 'pdf-hl ' + t;
      d.style.left = tm[4] + 'px';
      d.style.top = (tm[5] - h) + 'px';          // 文本矩阵原点在基线，框自基线向上覆盖字形
      d.style.width = ((b.width || 0) * vp.scale) + 'px';
      d.style.height = h + 'px';
      layer.appendChild(d);
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

  /** 收集各页文本项及其起始行号（全局行计数器与 collectText 完全一致） */
  function collectItems(pdf, side, token) {
    var pages = [];
    var line = 1;                       // 1-based：collectText 产出的文本行号
    var chain = Promise.resolve();
    function onePage(n) {
      return pdf.getPage(n).then(function (page) {
        return page.getTextContent().then(function (tc) {
          var boxes = [];
          for (var i = 0; i < tc.items.length; i++) {
            var it = tc.items[i];
            var str = String(it.str || '');
            boxes.push({ transform: it.transform, width: it.width, line: line });
            line += (str.split('\n').length - 1);
            if (it.hasEOL) line++;
          }
          pages.push({ page: n, boxes: boxes });
          line++;                       // 页间 join '\n'
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
    }).catch(function () { /* 标注收集失败不致命：仅失去高亮 */ });
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
    extractText: extractText, extractPanel: extractPanel, segmentFields: segmentFields,
    setHighlight: setHighlight, getHighlight: getHighlight, isLoaded: isLoaded
  };
})(typeof self !== 'undefined' ? self : this);
