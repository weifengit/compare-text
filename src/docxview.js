/**
 * docxview.js — Word(.docx) 查看器（mammoth 提取文本 + docx-preview 渲染 HTML）。
 * 职责：把 docx 渲染到主区域 3 的面板（与 PdfView 共用 #pdfLeft/#pdfRight，两侧互斥由调用方保证）、
 *       并提供对比用纯文本提取。不依赖 source-api / app.js；ArrayBuffer 由调用方传入（低耦合）。
 * 全局暴露：DocxView
 *
 * DocxView.init({ left, right })                    // left/right: 两个面板容器
 * DocxView.load(side, arrayBuffer, token) → Promise // side: 'L'|'R'，渲染整篇 HTML
 * DocxView.extractText(arrayBuffer) → Promise<string> // mammoth 提取纯文本（对比用）
 * DocxView.setSourceText(side, text)                // 登记该侧原文（= 编辑器文本，标注行号坐标系）
 * DocxView.extractPanel(side) → Promise<string|null>   // 该侧已登记原文（同 PdfView.extractPanel）
 * DocxView.setHighlight(side, map)                  // 落差异标注：行号 → 'rm'|'ad'|{t:'ch',segS}
 * DocxView.clear(side?)                             // 清空指定 / 全部面板
 * DocxView.isLoaded(side)                           // 该侧是否已加载 docx
 * DocxView.swap()                                   // 左右面板内容整体互换
 *
 * 差异标注：坐标系与主区域1 完全一致 —— 行号 = mammoth 提取文本的行号（mammoth 的段落
 * 收尾恒为 "\n\n"，故第 k 段（0 基）落在第 2k+1 行），映射语义也与主区域1 同源：
 *   'rm'|'ad'        整段涂色（该段即一行）；
 *   {t:'ch', segs}   段内按字符片段涂色（segs 与区域1 行内高亮同一份数据，逐片段取 rm/ad 配色，
 *                    故同一段里删的标红、增的标绿，与区域1 的行内着色完全一致）。
 * 段落 ↔ 行的对应关系不靠"数数"：先把 DOM 段落文本与 mammoth 段落文本逐一对齐
 * （完全一致走零开销快路径，否则退化为序列 diff 对齐），未配对的段不标注，
 * 因此文档里存在提取器/渲染器覆盖范围不一致的内容（文本框等）时也不会整体错位。
 *
 * 降级说明：缩放控件/行号↔像素同步滚动仍为 PDF 专属能力，docx 面板不参与
 * （同步滚动自动退化为比例同步）；缩放固定为"适应宽度"（CSS zoom，内容超宽时缩小）。
 */
(function (root) {
  'use strict';

  var panels = { L: null, R: null };
  var bufs = { L: null, R: null };      // 每侧已加载文档的 ArrayBuffer（swap 重渲染用）
  var texts = { L: null, R: null };     // 每侧已登记原文（mammoth 提取，标注行号坐标系）
  var hlMaps = { L: {}, R: {} };        // 每侧差异标注映射：行号 → 'rm'|'ad'|{ t:'ch', segs }
  var loadSeq = { L: 0, R: 0 };         // 每侧加载令牌：丢弃过期的 renderAsync
  var W = (typeof window !== 'undefined') ? window : null;
  var D = root.Diff || root.diff || null;   // jsdiff（可选：缺失时对位退化为"不猜、不标注"）

  function init(opts) {
    panels.L = opts.left || null;
    panels.R = opts.right || null;
  }

  function clearPanel(side) {
    var p = panels[side];
    if (p) p.innerHTML = '';
    // 换文档即作废该侧的坐标系与标注：新 DOM 不能被上一份文档的标注命中
    bufs[side] = null;
    texts[side] = null;
    hlMaps[side] = {};
  }

  function clear(side) {
    if (side === 'L' || side === 'R') clearPanel(side);
    else { clearPanel('L'); clearPanel('R'); }
  }

  function isLoaded(side) { return !!bufs[side]; }

  /** 适应宽度：docx 页面宽度取自文档节设置，超过面板宽时整体缩小（zoom 参与布局，无底部留白） */
  function fitWidth(side) {
    var p = panels[side];
    var host = p && p.firstChild;
    if (!host) return;
    var sec = host.querySelector ? host.querySelector('.docx-wrapper > section') : null;
    var w = sec ? (sec.offsetWidth || 0) : 0;
    var cw = (p.clientWidth || 0) - 2;
    host.style.zoom = (w > 0 && cw > 0) ? Math.min(1, cw / w) : 1;
  }

  function load(side, arrayBuffer, token) {
    if (!root.docx || !root.docx.renderAsync) return Promise.reject(new Error('docx-preview 未加载'));
    clearPanel(side);
    var p = panels[side];
    if (!p) return Promise.resolve();
    if (token === undefined) token = ++loadSeq[side];
    else loadSeq[side] = token;
    p.innerHTML = '<div class="pdf-loading">加载 Word 文档…</div>';
    // 先渲染进游离容器再挂载：过期渲染不会写进面板（clear/新加载已清面板也不受影响）
    var host = document.createElement('div');
    host.className = 'docx-host';
    return root.docx.renderAsync(arrayBuffer, host, null, {
      className: 'docx', inWrapper: true, breakPages: true
    }).then(function () {
      if (loadSeq[side] !== token) return;      // 已被更新的加载取代 → 丢弃
      bufs[side] = arrayBuffer;
      p.innerHTML = '';
      p.appendChild(host);
      fitWidth(side);
    }).catch(function (err) {
      if (loadSeq[side] === token && p) p.innerHTML = '<div class="pdf-error">Word 文档加载失败：' + ((err && err.message) || err) + '</div>';
      throw err;
    });
  }

  function extractText(arrayBuffer) {
    if (!root.mammoth || !root.mammoth.extractRawText) return Promise.reject(new Error('mammoth 未加载'));
    return root.mammoth.extractRawText({ arrayBuffer: arrayBuffer })
      .then(function (r) { return (r && r.value) || ''; });
  }

  // ---------- 差异标注（坐标系 = mammoth 提取文本行号，与主区域1 完全一致） ----------

  /** 该侧面板里已挂载的 docx 渲染容器；未加载/仍在加载中返回 null */
  function hostOf(side) {
    var p = panels[side];
    var host = p && p.firstChild;
    if (!host || !host.querySelectorAll) return null;
    return (' ' + (host.className || '') + ' ').indexOf(' docx-host ') >= 0 ? host : null;
  }

  /** 制表符归一：docx-preview 把 <w:tab/> 渲染成 emsp 的 span，mammoth 出 "\t"。
   *  一对一替换（字符数不变），故按字符记的偏移不受影响 */
  function normTab(s) { return String(s == null ? '' : s).replace(/\u2003/g, '\t'); }

  function countNl(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) if (s.charAt(i) === '\n') n++;
    return n;
  }

  /**
   * mammoth 原文 → 段落列表 [{ text, line }]。mammoth 的每个段落恒定以 "\n\n" 收尾
   * （空段落就是两个换行、<w:br/> 不产生字符、表格单元格内的段落同样各带收尾），
   * 因此按 "\n\n" 切分可无歧义地还原段落序列（含空段落）。
   * 行号按实际换行数累加，而非 2k+1 推导：<w:t> 里若含裸换行也不会错位。
   */
  function splitParas(text) {
    var s = String(text == null ? '' : text);
    var out = [];
    if (!s) return out;
    var parts = s.split('\n\n');
    if (s.slice(-2) === '\n\n') parts.pop();     // 末尾分隔符多切出的空元素，不是真实段落
    var line = 1;
    for (var i = 0; i < parts.length; i++) {
      out.push({ text: parts[i], line: line });
      line += countNl(parts[i]) + 2;
    }
    return out;
  }

  /**
   * DOM 段落文本 ↔ mammoth 段落对齐 → [[domIdx, mIdx], ...]（未配对的段落不返回）。
   * 同一份文档由两个库各自解析，段落序列绝大多数逐条相等 → 先走"条数相同且逐条相等"的
   * 零开销快路径；否则用序列 diff 对齐。只认真正相等的段：宁可漏标，也不错位到别的段上
   * （文本框中等只有一方解析到的内容只会让该段不参与，后续段落仍能重新对齐）。
   */
  function alignParas(domTexts, mParas) {
    var n = domTexts.length, m = mParas.length, i, j, out = [];
    if (!n || !m) return out;
    if (n === m) {
      var same = true;
      for (i = 0; i < n; i++) {
        if (domTexts[i] !== mParas[i].text) { same = false; break; }
      }
      if (same) { for (i = 0; i < n; i++) out.push([i, i]); return out; }
    }
    if (!D || !D.diffArrays) return out;         // 无 diff 库：不猜
    var mTexts = [];
    for (i = 0; i < m; i++) mTexts.push(mParas[i].text);
    var ops = D.diffArrays(domTexts, mTexts);
    var d = 0, k = 0;
    for (i = 0; i < ops.length; i++) {
      var len = ops[i].value.length;
      if (ops[i].added) { k += len; continue; }
      if (ops[i].removed) { d += len; continue; }
      for (j = 0; j < len; j++) out.push([d + j, k + j]);
      d += len; k += len;
    }
    return out;
  }

  /**
   * mammoth 段内偏移 → DOM 文本偏移的单调映射，长度 = mt.length + 1。
   * 两侧本应逐字符相等（含段内 tab）；不等时用字符 diff 定位：只有 mammoth 有的字符
   * （如 \t 对 emsp 之外的对不上的符号）落在当前 DOM 位置，只有 DOM 有的字符跳过。
   */
  function mapInlineOffsets(mt, domText) {
    var n = mt.length, to = new Array(n + 1), i, j;
    if (mt === domText) { for (i = 0; i <= n; i++) to[i] = i; return to; }
    if (!D || !D.diffChars) { for (i = 0; i <= n; i++) to[i] = Math.min(i, domText.length); return to; }
    var ops = D.diffChars(domText, mt);
    var d = 0, k = 0;
    for (i = 0; i < ops.length; i++) {
      var len = ops[i].value.length;
      if (ops[i].added) { for (j = 0; j < len; j++) to[k + j] = d; k += len; }
      else if (ops[i].removed) { d += len; }
      else {
        for (j = 0; j < len; j++) to[k + j] = d + j;
        k += len; d += len;
      }
    }
    to[n] = d;
    return to;
  }

  /**
   * segs（区域1 变更行的字符片段）→ 非 eq 片段的行内偏移区间 [{ s, e, cls }]。
   * cls 逐片段取各自的 rm/ad（与区域1 行内着色一致：同一行里删的标红、增的标绿）；
   * 片段没带 rm/ad 时（正常数据不会）退回映射自身的 t。
   */
  function segRanges(segs, fallback) {
    var fb = fallback === 'rm' ? 'rm' : 'ad';
    var out = [], off = 0;
    for (var i = 0; i < segs.length; i++) {
      var len = segs[i].text.length;
      if (segs[i].cls !== 'eq' && len > 0) {
        out.push({ s: off, e: off + len, cls: segs[i].cls === 'rm' ? 'rm' : (segs[i].cls === 'ad' ? 'ad' : fb) });
      }
      off += len;
    }
    return out;
  }

  /** 段落内的文本节点（文档顺序）：元素边界（<br>、CSS 计数器生成的编号）不产生字符，正合 mammoth */
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

  /** 段落文本（制表符已归一）+ 每个字符的属主（文本节点, 节点内偏移） */
  function charsOf(el) {
    var nodes = textNodesOf(el), text = '', owner = [];
    for (var i = 0; i < nodes.length; i++) {
      var s = nodes[i].nodeValue || '';
      for (var j = 0; j < s.length; j++) owner.push({ node: nodes[i], off: j });
      text += s;
    }
    return { text: normTab(text), owner: owner };
  }

  /** 拆掉标注 span，子节点还给父节点 */
  function unwrap(el) {
    var par = el.parentNode;
    if (!par) return;
    while (el.firstChild) par.insertBefore(el.firstChild, el);
    par.removeChild(el);
  }

  /** 把文本节点的 [s,e) 段包进标注 span（先按偏移切分，再包裹） */
  function wrapText(node, s, e, cls) {
    var target = s > 0 ? node.splitText(s) : node;         // target 从 s 起
    if (e - s < (target.nodeValue || '').length) target.splitText(e - s);   // 截到 e 为止
    var par = target.parentNode;
    if (!par) return;
    var span = document.createElement('span');
    span.className = 'docx-hl docx-hl-' + cls;   // 与 CSS / clearPaint 的类名一致，勿写成 "docx-hl rm"
    par.insertBefore(span, target);
    span.appendChild(target);
  }

  /** 清掉该侧上一次的标注（段落级类 + 行内 span），并合并回被切碎的文本节点 */
  function clearPaint(side) {
    var host = hostOf(side);
    if (!host) return;
    var i, ps;
    var spans = host.querySelectorAll('span.docx-hl');
    for (i = 0; i < spans.length; i++) unwrap(spans[i]);
    ps = host.querySelectorAll('p');
    for (i = 0; i < ps.length; i++) {
      if (ps[i].classList) {
        ps[i].classList.remove('docx-hl-para');
        ps[i].classList.remove('docx-hl-rm');
        ps[i].classList.remove('docx-hl-ad');
      }
      if (ps[i].normalize) ps[i].normalize();  // 还原被 splitText 拆碎的文本节点，偏移重新可靠
    }
  }

  /**
   * 落一段的标注：字符串 → 整段涂色；{t:'ch', segs} → 段内按字符区间涂色。
   * 区间先归并再"从后往前"包裹：切分靠后的文本节点不会影响靠前的偏移。
   */
  function paintPara(el, marker, text) {
    if (typeof marker === 'string') {
      if (el.classList) el.classList.add('docx-hl-para', 'docx-hl-' + (marker === 'rm' ? 'rm' : 'ad'));
      return;
    }
    var ranges = segRanges(marker.segs || [], marker.t);
    if (!ranges.length) return;
    var dc = charsOf(el);
    if (!dc.text) return;
    var to = mapInlineOffsets(text, dc.text);
    var want = [], i, prevEnd = 0;
    // 行内偏移 → DOM 偏移。ranges 本身首尾相接不重叠，映射后用 prevEnd 夹住起点，
    // 保证 DOM 侧也不重叠（缺字符时区间会靠拢，不夹住就会写出嵌套 span）
    for (i = 0; i < ranges.length; i++) {
      var s = Math.max(prevEnd, to[Math.min(ranges[i].s, text.length)]);
      var e = Math.max(s, to[Math.min(ranges[i].e, text.length)]);
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

  /** 按当前映射重绘该侧标注（先清后画；段落索引在清色后重建，偏移才对得上渲染结果） */
  function applyHighlights(side) {
    var host = hostOf(side);
    if (!host) return;
    clearPaint(side);
    var text = texts[side];
    if (text == null) return;
    var found = host.querySelectorAll('p'), els = [], domTexts = [], i;
    for (i = 0; i < found.length; i++) {
      els.push(found[i]);
      domTexts.push(normTab(found[i].textContent || ''));
    }
    var mParas = splitParas(text);
    var pairs = alignParas(domTexts, mParas);
    var map = hlMaps[side] || {};
    for (i = 0; i < pairs.length; i++) {
      var para = mParas[pairs[i][1]];
      var mk = map[para.line];
      if (!mk) continue;
      paintPara(els[pairs[i][0]], mk, para.text);
    }
  }

  /** 落差异标注：行号 → 'rm'|'ad'|{ t:'ch', segs }（与 PdfView.setHighlight 同语义） */
  function setHighlight(side, map) {
    if (side !== 'L' && side !== 'R') return;
    hlMaps[side] = map || {};
    applyHighlights(side);
  }

  /** 登记该侧原文（mammoth 提取结果 = 编辑器初始文本）。标注行号以它为坐标系，登记后立即重绘 */
  function setSourceText(side, text) {
    if (side !== 'L' && side !== 'R') return;
    texts[side] = (text == null) ? null : String(text);
    applyHighlights(side);
  }

  /** 该侧已登记的原文（未加载/未登记 → null）；与 PdfView.extractPanel 同形，便于上层统一处理 */
  function extractPanel(side) { return Promise.resolve(texts[side]); }

  /**
   * 左右面板内容整体互换（左右互换按钮）：ArrayBuffer 对调后就地重渲染，不重新取文件。
   * 两侧在途加载一律作废，防止回填覆盖互换结果。
   * 原文与标注映射一并跟过去，并在重渲染完成后重绘（clearPanel 会清掉它们，故此处回填）。
   */
  function swap() {
    var t = bufs.L; bufs.L = bufs.R; bufs.R = t;
    var tx = texts.L, hx = hlMaps.L;
    texts.L = texts.R; hlMaps.L = hlMaps.R;
    texts.R = tx; hlMaps.R = hx;
    loadSeq.L++; loadSeq.R++;
    if (panels.L) panels.L.innerHTML = '';
    if (panels.R) panels.R.innerHTML = '';
    var bufL = bufs.L, bufR = bufs.R;
    var textL = texts.L, hlL = hlMaps.L, textR = texts.R, hlR = hlMaps.R;
    function restore(side, text, map) {          // load 清空后回填，再按互换后的映射重绘
      texts[side] = text;
      hlMaps[side] = map;
      applyHighlights(side);
    }
    if (bufL) load('L', bufL).then(function () { restore('L', textL, hlL); }).catch(function () {});
    if (bufR) load('R', bufR).then(function () { restore('R', textR, hlR); }).catch(function () {});
  }

  // 窗口尺寸变化时重算适应宽度（节流）
  if (W) {
    var t = null;
    W.addEventListener('resize', function () {
      clearTimeout(t);
      t = setTimeout(function () { ['L', 'R'].forEach(function (s) { if (bufs[s]) fitWidth(s); }); }, 200);
    });
  }

  root.DocxView = {
    init: init, load: load, extractText: extractText, clear: clear,
    isLoaded: isLoaded, swap: swap,
    setSourceText: setSourceText, extractPanel: extractPanel, setHighlight: setHighlight,
    // 仅诊断用：各内部分解状态（正常功能不依赖）
    _debug: function (side) {
      return {
        loaded: !!bufs[side], bytes: bufs[side] ? bufs[side].byteLength : 0, loadToken: loadSeq[side],
        hasText: texts[side] != null, hlLines: Object.keys(hlMaps[side] || {}).length
      };
    },
    // 仅供测试：纯函数（不碰 DOM），便于在无浏览器环境验证行号/对齐/偏移映射
    _pure: {
      splitParas: splitParas, alignParas: alignParas, mapInlineOffsets: mapInlineOffsets,
      segRanges: segRanges, normTab: normTab
    }
  };
})(typeof self !== 'undefined' ? self : this);
