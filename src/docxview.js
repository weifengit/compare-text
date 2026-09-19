/**
 * docxview.js — Word(.docx) 查看器（mammoth 提取文本 + docx-preview 渲染 HTML）。
 * 职责：把 docx 渲染到主区域 3 的面板（与 PdfView 共用 #pdfLeft/#pdfRight，两侧互斥由调用方保证）、
 *       并提供对比用纯文本提取。不依赖 source-api / app.js；ArrayBuffer 由调用方传入（低耦合）。
 * 全局暴露：DocxView
 *
 * DocxView.init({ left, right })                    // left/right: 两个面板容器
 * DocxView.load(side, arrayBuffer, token) → Promise // side: 'L'|'R'，渲染整篇 HTML
 * DocxView.extractText(arrayBuffer) → Promise<string> // mammoth 提取纯文本（对比用）
 * DocxView.clear(side?)                             // 清空指定 / 全部面板
 * DocxView.isLoaded(side)                           // 该侧是否已加载 docx
 * DocxView.swap()                                   // 左右面板内容整体互换
 *
 * 降级说明：缩放控件/差异标注/行号↔像素同步滚动均为 PDF 专属能力，docx 面板不参与
 * （同步滚动自动退化为比例同步）；缩放固定为"适应宽度"（CSS zoom，内容超宽时缩小）。
 */
(function (root) {
  'use strict';

  var panels = { L: null, R: null };
  var bufs = { L: null, R: null };      // 每侧已加载文档的 ArrayBuffer（swap 重渲染用）
  var loadSeq = { L: 0, R: 0 };         // 每侧加载令牌：丢弃过期的 renderAsync
  var W = (typeof window !== 'undefined') ? window : null;

  function init(opts) {
    panels.L = opts.left || null;
    panels.R = opts.right || null;
  }

  function clearPanel(side) {
    var p = panels[side];
    if (p) p.innerHTML = '';
    bufs[side] = null;
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

  /**
   * 左右面板内容整体互换（左右互换按钮）：ArrayBuffer 对调后就地重渲染，不重新取文件。
   * 两侧在途加载一律作废，防止回填覆盖互换结果。
   */
  function swap() {
    var t = bufs.L; bufs.L = bufs.R; bufs.R = t;
    loadSeq.L++; loadSeq.R++;
    if (panels.L) panels.L.innerHTML = '';
    if (panels.R) panels.R.innerHTML = '';
    var bufL = bufs.L, bufR = bufs.R;
    if (bufL) load('L', bufL);
    if (bufR) load('R', bufR);
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
    // 仅诊断用：各内部分解状态（正常功能不依赖）
    _debug: function (side) {
      return { loaded: !!bufs[side], bytes: bufs[side] ? bufs[side].byteLength : 0, loadToken: loadSeq[side] };
    }
  };
})(typeof self !== 'undefined' ? self : this);
