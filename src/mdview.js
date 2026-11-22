/**
 * mdview.js —— Markdown 查看器（第四种正文源：.md 文件）。
 *
 * 职责：把 Markdown 渲染到主区域 3 的面板（与 PdfView / DocxView / WebView 共用 #pdfLeft/#pdfRight，
 *       同侧互斥由调用方保证），并提供对比用原文、差异标注与行锚定协同滚动。
 * 不依赖 source-api / app.js；Markdown 文本由调用方传入（低耦合）。
 *
 * 全局暴露：MdView
 *
 *   MdView.init({ left, right })                    // left/right: 两个面板容器
 *   MdView.load(side, markdown, token) → Promise    // side: 'L'|'R'，渲染整篇 Markdown
 *   MdView.setSourceText(side, text)                // 登记该侧原文（= 编辑器文本，标注行号坐标系）
 *   MdView.extractPanel(side) → Promise<string|null>   // 该侧已登记原文（同 PdfView.extractPanel）
 *   MdView.setHighlight(side, map)                  // 落差异标注：行号 → 'rm'|'ad'|{t:'ch',segs}
 *   MdView.clear(side?) / isLoaded(side) / swap() / showError(side, msg)
 *   MdView.lineOffset / lineAtOffset / lineHeight / nextLineOffset   行锚定协同滚动
 *
 * 行号坐标系：与主区域1 完全一致 —— 行号 = Markdown 源码行号。mdrender.js 保证每个源码行都包在
 * 一个 .md-line[data-line=N] 元素里，故标注与滚动锚定都直接按元素定位，无需逐字符几何推算。
 *
 * 差异标注：整行涂色（'rm'|'ad'）给 .md-line 加段落级类；行内字符片段（{t:'ch',segs}）按
 * 「源码行文本 → 渲染后 DOM 文本」的字符 diff 映射偏移后包裹 span。Markdown 语法字符（#、-、
 * ** 等）在渲染时被剥掉，映射会把源码中这些被删字符折叠到当前 DOM 偏移，与 DocxView 同思路，
 * 保证同一段里删的标红、增的标绿，与主区域1 的行内着色一致。
 *
 * 降级说明：Markdown 是流式排版、无固定页宽，不参与 PDF 缩放控件；行锚点缺失时协同滚动自动
 * 退化为比例同步。
 */
(function (root) {
  'use strict';

  var panels = { L: null, R: null };
  var texts = { L: null, R: null };        // 每侧已登记原文（Markdown 源码，标注行号坐标系）
  var hlMaps = { L: {}, R: {} };           // 每侧差异标注映射：行号 → 'rm'|'ad'|{ t:'ch', segs }
  var loadSeq = { L: 0, R: 0 };            // 每侧加载令牌：丢弃过期渲染
  var posIndex = { L: null, R: null };     // 行位索引（惰性构建，渲染/标注后失效）
  var D = root.Diff || root.diff || null;  // jsdiff（可选：缺失时行内对位退化为"不猜、不标注"）

  function init(opts) {
    panels.L = opts.left || null;
    panels.R = opts.right || null;
  }

  function clearPanel(side) {
    var p = panels[side];
    if (p) p.innerHTML = '';
    texts[side] = null;
    hlMaps[side] = {};
    invalidatePos(side);
  }

  function clear(side) {
    if (side === 'L' || side === 'R') clearPanel(side);
    else { clearPanel('L'); clearPanel('R'); }
  }

  function isLoaded(side) { return texts[side] != null; }

  function showError(side, msg) {
    var p = panels[side];
    if (p) p.innerHTML = '<div class="pdf-error">Markdown 加载失败：' +
      ((msg && msg.message) || msg) + '</div>';
  }

  // ---------- 渲染 ----------
  function load(side, markdown, token) {
    if (!root.MdRender || !root.MdRender.render) return Promise.reject(new Error('mdrender.js 未加载'));
    clearPanel(side);
    var p = panels[side];
    if (!p) return Promise.resolve();
    if (token === undefined) token = ++loadSeq[side];
    else loadSeq[side] = token;
    var text = String(markdown == null ? '' : markdown);
    texts[side] = text;                       // 原文即 Markdown 源码，标注行号以它为坐标系
    var res;
    try {
      res = root.MdRender.render(text);
    } catch (e) {
      if (loadSeq[side] === token) showError(side, e);
      return Promise.reject(e);
    }
    if (loadSeq[side] !== token) return Promise.resolve();   // 已被更新的加载取代
    p.innerHTML = '<div class="md-view">' + res.html + '</div>';
    applyHighlights(side);
    return Promise.resolve();
  }

  function setSourceText(side, text) {
    if (side !== 'L' && side !== 'R') return;
    texts[side] = (text == null) ? null : String(text);
    applyHighlights(side);
  }

  function extractPanel(side) { return Promise.resolve(texts[side]); }

  // ---------- 差异标注 ----------
  function hostOf(side) {
    var p = panels[side];
    var host = p && p.firstChild;
    if (!host || !host.querySelectorAll) return null;
    return (' ' + (host.className || '') + ' ').indexOf(' md-view ') >= 0 ? host : null;
  }

  function countNl(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) if (s.charAt(i) === '\n') n++;
    return n;
  }

  /** 源码行文本 → 渲染后 DOM 文本的单调偏移映射，长度 = src.length + 1。
   *  Markdown 语法字符在渲染时被剥掉，映射把它们折叠到当前 DOM 偏移（与 DocxView 同思路）。 */
  function mapInlineOffsets(src, domText) {
    var n = src.length, to = new Array(n + 1), i, j;
    if (src === domText) { for (i = 0; i <= n; i++) to[i] = i; return to; }
    if (!D || !D.diffChars) { for (i = 0; i <= n; i++) to[i] = Math.min(i, domText.length); return to; }
    var ops = D.diffChars(domText, src);      // domText 为旧、src 为新：to[] 映射 src 下标 → dom 偏移
    var d = 0, k = 0;
    for (i = 0; i < ops.length; i++) {
      var len = ops[i].value.length;
      if (ops[i].added) { for (j = 0; j < len; j++) to[k + j] = d; k += len; }
      else if (ops[i].removed) { d += len; }
      else { for (j = 0; j < len; j++) to[k + j] = d + j; k += len; d += len; }
    }
    to[n] = d;
    return to;
  }

  function segRanges(segs, fallback) {
    var fb = fallback === 'rm' ? 'rm' : 'ad';
    var out = [], off = 0;
    for (var i = 0; i < segs.length; i++) {
      var len = (segs[i].text || '').length;
      if (segs[i].cls !== 'eq' && len > 0) {
        out.push({ s: off, e: off + len,
          cls: segs[i].cls === 'rm' ? 'rm' : (segs[i].cls === 'ad' ? 'ad' : fb) });
      }
      off += len;
    }
    return out;
  }

  function textNodesOf(el) {
    var out = [];
    (function walk(node) {
      var cs = (node && node.childNodes) || [];
      for (var i = 0; i < cs.length; i++) {
        var c = cs[i];
        if (c.nodeType === 3) out.push(c);
        else if (c.nodeType === 1) walk(c);
      }
    })(el);
    return out;
  }

  function charsOf(el) {
    var nodes = textNodesOf(el), text = '', owner = [];
    for (var i = 0; i < nodes.length; i++) {
      var s = nodes[i].nodeValue || '';
      for (var j = 0; j < s.length; j++) owner.push({ node: nodes[i], off: j });
      text += s;
    }
    return { text: text, owner: owner };
  }

  function unwrap(el) {
    var par = el.parentNode;
    if (!par) return;
    while (el.firstChild) par.insertBefore(el.firstChild, el);
    par.removeChild(el);
  }

  function wrapText(node, s, e, cls) {
    var target = s > 0 ? node.splitText(s) : node;
    if (e - s < (target.nodeValue || '').length) target.splitText(e - s);
    var par = target.parentNode;
    if (!par) return;
    var span = document.createElement('span');
    span.className = 'md-hl md-hl-' + cls;
    par.insertBefore(span, target);
    span.appendChild(target);
  }

  function clearPaint(side) {
    var host = hostOf(side);
    if (!host) return;
    var i, lines;
    var spans = host.querySelectorAll('span.md-hl');
    for (i = 0; i < spans.length; i++) unwrap(spans[i]);
    lines = host.querySelectorAll('.md-line');
    for (i = 0; i < lines.length; i++) {
      if (lines[i].classList) {
        lines[i].classList.remove('md-hl-para');
        lines[i].classList.remove('md-hl-rm');
        lines[i].classList.remove('md-hl-ad');
      }
      if (lines[i].normalize) lines[i].normalize();
    }
  }

  /** 落一行的标注：字符串 → 整行涂色；{t:'ch',segs} → 按字符区间包裹 span。 */
  function paintLine(el, marker, srcText) {
    if (typeof marker === 'string') {
      if (el.classList) el.classList.add('md-hl-para', 'md-hl-' + (marker === 'rm' ? 'rm' : 'ad'));
      return;
    }
    var ranges = segRanges(marker.segs || [], marker.t);
    if (!ranges.length) return;
    var dc = charsOf(el);
    if (!dc.text) return;
    var to = mapInlineOffsets(srcText, dc.text);
    var want = [], i, prevEnd = 0;
    // 行内偏移 → DOM 偏移。ranges 首尾相接不重叠，映射后用 prevEnd 夹住起点，避免写出嵌套 span
    for (i = 0; i < ranges.length; i++) {
      var s = Math.max(prevEnd, to[Math.min(ranges[i].s, srcText.length)]);
      var e = Math.max(s, to[Math.min(ranges[i].e, srcText.length)]);
      if (e > s) { want.push({ s: s, e: e, cls: ranges[i].cls }); prevEnd = e; }
    }
    if (!want.length) return;
    var jobs = [];                                         // 逆序收集 → 逆序执行
    for (i = want.length - 1; i >= 0; i--) {
      var a = want[i].s, b = want[i].e, cls = want[i].cls, p = b - 1;
      while (p >= a) {
        var own = dc.owner[p];
        if (!own) { p--; continue; }
        var s2 = p;                                        // 同一文本节点内的连续字符并成一段
        while (s2 - 1 >= a && dc.owner[s2 - 1] && dc.owner[s2 - 1].node === own.node) s2--;
        jobs.push({ node: own.node, s: dc.owner[s2].off, e: own.off + 1, cls: cls });
        p = s2 - 1;
      }
    }
    for (i = 0; i < jobs.length; i++) {
      if (jobs[i].node.parentNode) wrapText(jobs[i].node, jobs[i].s, jobs[i].e, jobs[i].cls);
    }
  }

  function applyHighlights(side) {
    var host = hostOf(side);
    if (!host) return;
    clearPaint(side);
    invalidatePos(side);       // 标注会包裹 span 改动 DOM：行位索引重建后再用
    var text = texts[side];
    if (text == null) return;
    var srcLines = root.MdRender.splitLines(text);
    var lines = host.querySelectorAll('.md-line');
    var map = hlMaps[side] || {};
    for (var i = 0; i < lines.length; i++) {
      var ln = parseInt(lines[i].getAttribute('data-line'), 10);
      if (!ln) continue;
      var mk = map[ln];
      if (!mk) continue;
      paintLine(lines[i], mk, srcLines[ln - 1] || '');
    }
  }

  function setHighlight(side, map) {
    if (side !== 'L' && side !== 'R') return;
    hlMaps[side] = map || {};
    applyHighlights(side);
  }

  // ---------- 行号 ↔ 滚动像素（内容锚定协同滚动；与 PdfView/DocxView 同名同语义） ----------
  function invalidatePos(side) { posIndex[side] = null; }

  function topInPanel(p, el) {
    try { return el.getBoundingClientRect().top - p.getBoundingClientRect().top + (p.scrollTop || 0); }
    catch (e) { return null; }
  }

  function buildPosIndex(side) {
    var p = panels[side], host = hostOf(side), text = texts[side];
    // 面板隐藏（display:none）时所有 rect 为 0：量出来的索引毫无意义，宁可不给
    if (!p || !host || text == null || !p.getBoundingClientRect || !p.clientHeight) return null;
    var lines = host.querySelectorAll('.md-line'), arr = [];
    for (var i = 0; i < lines.length; i++) {
      var ln = parseInt(lines[i].getAttribute('data-line'), 10);
      if (!ln) continue;
      var top = topInPanel(p, lines[i]);
      if (top == null) return null;
      arr.push({ line: ln, top: top, h: lines[i].getBoundingClientRect().height || 0 });
    }
    if (!arr.length) return null;
    arr.sort(function (a, b) { return a.top - b.top || a.line - b.line; });
    // 顶部虚拟锚点（与 PdfView/DocxView 同）：首行之上也算第 0 行位，两侧到顶时文档边界严格对齐
    if (arr[0].line >= 1) arr.unshift({ line: 0, top: 0, h: arr[0].h || 16 });
    return arr;
  }

  function posIndexOf(side) {
    if (!posIndex[side]) posIndex[side] = buildPosIndex(side);
    return posIndex[side];
  }

  function idxAtPx(arr, px) {
    var lo = -1, hi = arr.length - 1;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (arr[mid].top <= px) lo = mid; else hi = mid - 1; }
    return lo;
  }

  function idxAtLine(arr, e) {
    var lo = -1, hi = arr.length - 1;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (arr[mid].line <= e) lo = mid; else hi = mid - 1; }
    return lo;
  }

  function lineOffset(side, line) {
    var arr = posIndexOf(side);
    if (!arr) return null;
    var i = idxAtLine(arr, line);
    if (i < 0) i = 0;
    var e = arr[i], span = e.h;
    if (i + 1 < arr.length) { var gap = arr[i + 1].top - e.top; if (gap > 0) span = gap; }
    return e.top + (line - e.line) * span;
  }

  function lineHeightAtLine(side, line) {
    var arr = posIndexOf(side);
    if (!arr) return null;
    var i = idxAtLine(arr, line);
    if (i < 0) i = 0;
    if (i + 1 < arr.length) { var gap = arr[i + 1].top - arr[i].top; if (gap > 0) return gap; }
    return arr[i].h;
  }

  function lineAtOffset(side, px) {
    var arr = posIndexOf(side);
    if (!arr) return null;
    var i = idxAtPx(arr, px);
    if (i < 0) return arr[0] ? arr[0].line : 1;
    return arr[i].line;
  }

  function nextLineOffset(side, line) {
    var arr = posIndexOf(side);
    if (!arr) return null;
    var i = idxAtLine(arr, line);
    if (i < 0) i = 0;
    return (i + 1 < arr.length) ? arr[i + 1].top : null;
  }

  // ---------- 互换 ----------
  function swap() {
    var tx = texts.L, hx = hlMaps.L;
    texts.L = texts.R; hlMaps.L = hlMaps.R;
    texts.R = tx; hlMaps.R = hx;
    loadSeq.L++; loadSeq.R++;
    if (panels.L) panels.L.innerHTML = '';
    if (panels.R) panels.R.innerHTML = '';
    invalidatePos('L'); invalidatePos('R');
    var textL = texts.L, textR = texts.R, hlL = hlMaps.L, hlR = hlMaps.R;
    function restore(side, text, map) {
      texts[side] = text;
      hlMaps[side] = map;
      applyHighlights(side);
    }
    if (textL != null) load('L', textL).then(function () { restore('L', textL, hlL); }).catch(function () {});
    if (textR != null) load('R', textR).then(function () { restore('R', textR, hlR); }).catch(function () {});
  }

  root.MdView = {
    init: init, load: load, clear: clear,
    isLoaded: isLoaded, swap: swap, showError: showError,
    setSourceText: setSourceText, extractPanel: extractPanel, setHighlight: setHighlight,
    lineOffset: lineOffset, lineAtOffset: lineAtOffset, lineHeight: lineHeightAtLine,
    nextLineOffset: nextLineOffset,
    _debug: function (side) {
      return {
        loaded: texts[side] != null, hasText: texts[side] != null,
        hlLines: Object.keys(hlMaps[side] || {}).length,
        posEntries: posIndex[side] ? posIndex[side].length : 0
      };
    },
    _pure: {
      mapInlineOffsets: mapInlineOffsets,
      segRanges: segRanges,
      countNl: countNl
    }
  };
})(typeof self !== 'undefined' ? self : this);
