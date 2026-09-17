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
 */
(function (root) {
  'use strict';

  var panels = { L: null, R: null };
  var docs = { L: null, R: null };
  var loadSeq = { L: 0, R: 0 };   // 每侧加载令牌：丢弃过期的 getDocument
  var mode = 'auto';
  var W = (typeof window !== 'undefined') ? window : null;

  // 指定 pdf.js 的 Worker 脚本（相对页面根路径）
  if (root.pdfjsLib && root.pdfjsLib.GlobalWorkerOptions && !root.pdfjsLib.GlobalWorkerOptions.workerSrc) {
    root.pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
  }

  function clearPanel(side) {
    var p = panels[side];
    if (p) p.innerHTML = '';
    if (docs[side]) { try { docs[side].destroy && docs[side].destroy(); } catch (e) { /* 忽略 */ } docs[side] = null; }
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

  function renderPage(side, pageNum, pdf) {
    var p = panels[side];
    if (!p) return;
    pdf.getPage(pageNum).then(function (page) {
      var vp1 = page.getViewport({ scale: 1 });
      var scale = pageScale(vp1, p);
      var vp = page.getViewport({ scale: scale });
      var wrap = document.createElement('div');
      wrap.className = 'pdf-page';
      wrap.style.height = vp.height + 'px';
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(vp.width));
      canvas.height = Math.max(1, Math.floor(vp.height));
      canvas.style.width = vp.width + 'px';
      canvas.style.height = vp.height + 'px';
      wrap.appendChild(canvas);
      p.appendChild(wrap);
      page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
    }).catch(function () { /* 单页失败忽略 */ });
  }

  function renderAll(side) {
    var pdf = docs[side];
    var p = panels[side];
    if (!pdf || !p) return;
    p.innerHTML = '';
    var total = pdf.numPages;
    for (var i = 1; i <= total; i++) renderPage(side, i, pdf);
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

  root.PdfView = {
    init: function (els) { panels.L = (els && els.left) || null; panels.R = (els && els.right) || null; },
    load: load, clear: clear, setMode: setMode, getMode: getMode,
    getPanel: function (side) { return panels[side] || null; },
    extractText: extractText, extractPanel: extractPanel, segmentFields: segmentFields
  };
})(typeof self !== 'undefined' ? self : this);
