/**
 * app.js — 界面层：多标签页、CodeMirror 编辑、选项、渲染（并排/流水）、同步滚动、
 * 折叠相同行、对比源/PDF 面板、历史记录（localStorage）、Worker 编排与降级。
 */
(function () {
  'use strict';

  // ---------- DOM ----------
  function $(id) { return document.getElementById(id); }
  var results = $('results');
  var statusEl = $('status');
  var statsEl = $('stats');
  var foldBtn = $('foldBtn');
  var toggleEditorsBtn = $('toggleEditorsBtn');
  var tidyBtn = $('tidyBtn');
  var resizeBar = $('resultsResize');
  var layoutEl = $('layout');
  var vsplitEl = $('vsplit');
  var historyList = $('historyList');
  var historyClearBtn = $('historyClear');
  var sidebarEl = $('sidebar');
  var sidebarToggle = $('sidebarToggle');
  var appEl = $('appRoot');
  var editorsEl = $('editors');
  var editorsResize = $('editorsResize');
  var clearBtn = $('clearBtn');
  var pdfFullscreen = $('pdfFullscreen');
  var srcPathInput = $('srcPathInput');
  var srcLoadBtn = $('srcLoadBtn');
  var srcPathCur = $('srcPathCur');
  var pdfareaEl = $('pdfarea');
  var swapBtn = $('swapBtn');
  var resetSplitBtn = $('resetSplitBtn');
  // 扫描版 OCR 弹窗
  var ocrMask = $('ocrMask');
  var ocrFile = $('ocrFile');
  var ocrProgress = $('ocrProgress');
  var ocrProgressText = $('ocrProgressText');
  var ocrErr = $('ocrErr');
  var ocrSkipBtn = $('ocrSkipBtn');
  var ocrGoBtn = $('ocrGoBtn');

  // ---------- 状态 ----------
  var OPT_MAP = {
    optIgnoreCase: 'ignoreCase',
    optIgnoreEol: 'ignoreEol',
    optIgnoreWhitespace: 'ignoreWhitespace',
    optIgnoreNewline: 'ignoreNewline',
    optIgnoreWidth: 'ignoreWidth',
    optIgnorePunct: 'ignorePunct'
  };
  // 差异计算、结果区渲染与主区域3 标注均在 src/pipeline.js（Pipeline），此处只保留界面状态
  var debounceTimer = null;
  var editorL, editorR;
  var HISTORY_KEY = 'diffchecker_history_v1';
  var RESIZE_KEY = 'diffchecker_results_h';
  var tidyBefore = null;    // 修整前的两侧文本快照（用于撤销）
  var resizeState = null;   // 标注区拖拽调整状态
  var switchSeq = 0;        // 单调递增：tab 切换 / 文件加载的陈旧异步丢弃令牌
  var restoring = false;    // tab 恢复中：抑制 setValue 触发的防抖 compare
  var lastCompareIsRestore = false;  // 本次 compare 是否由 tab 恢复发起（抑制历史记录）
  var tabs = [];            // 多标签页：[{id, title, state}]
  var activeTabId = null;
  var tabSeq = 0;
  var SIDEBAR_KEY = 'diffchecker_sidebar';
  var sidebarOpen = true;      // 侧边栏实时状态（不读 classList.contains）
  var sidebarPref = null;      // 持久化的用户偏好；null = 默认展开

  // ---------- 工具 ----------
  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function baseName(p) {
    var parts = String(p || '').split(/[\\/]/);
    return parts[parts.length - 1] || '';
  }
  function stripExt(n) { return String(n || '').replace(/\.[A-Za-z0-9]{1,8}$/, ''); }
  function abbrev(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s;
  }
  function readOptions() {
    var o = {};
    for (var id in OPT_MAP) o[OPT_MAP[id]] = $(id).checked;
    return o;
  }
  function applyOptions(o) {
    for (var id in OPT_MAP) {
      var k = OPT_MAP[id];
      if (k in o) $(id).checked = !!o[k];
    }
  }
  function setBusy(b) {
    var r = Pipeline.getResult();
    if (b) { statusEl.innerHTML = '<span class="spin"></span>正在计算…'; }
    else if (!r) { statusEl.textContent = '在两侧粘贴文本即可自动对比'; }
    else if (r.error) { statusEl.textContent = '计算出错：' + r.error; statusEl.classList.add('bad'); }
    else { statusEl.textContent = '对比完成'; statusEl.classList.remove('bad'); }
  }
  function toast(msg, isErr) {
    var el = document.createElement('div');
    el.className = 'toast' + (isErr ? ' err' : '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.classList.add('out'); setTimeout(function () { el.remove(); }, 400); }, 1600);
  }

  // ---------- 历史记录 ----------
  function loadHistory() {
    try {
      var raw = localStorage.getItem(HISTORY_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }
  function saveHistoryEntry() {
    var left = editorL.getValue(), right = editorR.getValue();
    if (!left && !right) return;
    try {
      var arr = loadHistory();
      if (arr.length && arr[0].left === left && arr[0].right === right
          && JSON.stringify(arr[0].options) === JSON.stringify(readOptions())) return;
      arr.unshift({ ts: Date.now(), left: left, right: right, options: readOptions() });
      arr = arr.slice(0, 100);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(arr));
    } catch (e) { /* quota 等异常忽略 */ }
  }

  // ---------- 扫描版 OCR 弹窗（检测 → 确认 → 进度） ----------
  var ocrSide = null;                  // 当前弹窗对应的侧（'L'|'R'）
  var ocrBusy = false;                 // OCR 正在跑：弹窗转进度模式

  function showOcrModal(side, absPath) {
    ocrSide = side;
    ocrBusy = false;
    ocrErr.hidden = true;
    ocrProgress.hidden = true;
    ocrSkipBtn.hidden = false;
    ocrSkipBtn.textContent = '跳过';
    ocrGoBtn.hidden = false;
    ocrGoBtn.textContent = 'OCR 识别';
    ocrFile.textContent = baseName(absPath);
    ocrMask.hidden = false;
  }
  function hideOcrModal() {
    ocrMask.hidden = true;
    ocrSide = null;
    ocrBusy = false;
  }
  function updateOcrProgress(side, info) {
    if (side !== ocrSide) return;
    if (info.phase === 'load') {
      // 首次加载模型：弹窗转进度
      ocrBusy = true;
      ocrProgress.hidden = false;
      ocrProgressText.textContent = '正在加载 OCR 模型（首次约 15MB，之后复用）…';
      ocrSkipBtn.hidden = true;
      ocrGoBtn.hidden = true;
    } else if (info.phase === 'page') {
      ocrProgress.hidden = false;
      ocrProgressText.textContent = '正在识别第 ' + info.page + ' / ' + info.total + ' 页…';
    } else if (info.phase === 'done') {
      ocrProgress.hidden = true;
    }
  }
  ocrSkipBtn.addEventListener('click', function () {
    if (ocrBusy) { Pipeline.cancelOcr(); hideOcrModal(); toast('已取消 OCR'); return; }
    hideOcrModal();
    toast('已跳过扫描版 PDF（无文字可对比）');
  });
  ocrGoBtn.addEventListener('click', function () {
    if (ocrBusy || !ocrSide) return;
    ocrBusy = true;
    ocrProgress.hidden = false;
    ocrProgressText.textContent = '正在准备…';
    ocrSkipBtn.hidden = true;
    ocrGoBtn.hidden = true;
    Pipeline.runOcr(ocrSide);
  });

  // ---------- 对比管线接线（差异计算 / 结果区渲染 / 主区域3 标注都在 Pipeline） ----------
  Pipeline.init({
    resultsEl: results,
    statsEl: statsEl,
    // 编辑器文本与选项：管线只读写文本，不关心编辑器是谁
    getText: function (side) { return side === 'L' ? editorL.getValue() : editorR.getValue(); },
    setText: function (side, text) { if (side === 'L') editorL.setValue(text); else editorR.setValue(text); },
    getOptions: readOptions,
    setBusy: setBusy,
    toast: toast,
    // 一次对比落定：历史记录与 tab 标题（tab 恢复发起时不写历史）
    onResult: function (res, isRestore) {
      if (!isRestore) saveHistoryEntry();
      renderHistory();
      if (!isRestore) updateTabTitle();
    },
    // 结果区 DOM 重建后：重新绑定协同滚动（左右栏/流水栏都是新元素）
    onRendered: function () { rebindScrollSync(); },
    // 文件文本就绪：字段下拉 + 写入该侧编辑区
    onPanelText: function (side, text) {
      if (FilterBar.setFields) FilterBar.setFields(PdfView.segmentFields ? PdfView.segmentFields(text) : []);
      if (side === 'L') editorL.setValue(text); else editorR.setValue(text);
    },
    // 主区域3（PDF/Word 面板）显隐随面板加载结果重算
    onPanelsChanged: updatePdfArea,
    // 两侧皆空：状态栏回到初始文案
    onPlaceholder: function () { statusEl.textContent = '在两侧粘贴文本即可自动对比'; },
    // 扫描版 PDF（无文字层）检测到：弹出确认框，用户决定是否 OCR
    onScannedPdf: function (side, absPath) {
      showOcrModal(side, absPath);
    },
    // OCR 进度：加载模型 / 逐页识别
    onOcrProgress: function (side, info) {
      updateOcrProgress(side, info);
    },
    // 该侧 OCR 状态变化
    onOcrState: function (side, state) {
      if (state === 'running' || state === 'pending') return;   // 弹窗/进度条已由上面回调驱动
      if (state === 'done') {
        if (ocrMask && !ocrMask.hidden) hideOcrModal();
        statusEl.textContent = 'OCR 识别完成，已加入对比';
        statusEl.classList.remove('bad');
      } else if (state === 'failed') {
        if (ocrMask && !ocrMask.hidden) hideOcrModal();
      }
    }
  });

  // ---------- 事件 -------
  function scheduleCompare() {
    if (restoring) return;                       // tab 恢复期间 setValue 触发的 change 不发对比
    Pipeline.updateMapMatches();                 // 编辑器文本变化 → PDF 表与编辑区是否仍同文本
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () { Pipeline.compare(); }, 400);
  }

  results.addEventListener('click', function (e) {
    var f = e.target.closest('.fold-row');
    if (f) {
      Pipeline.toggleFold(f.getAttribute('data-key'));
      var r = Pipeline.getResult();
      if (r && r.mode === 'grid') rerenderGridKeepScroll();
    }
  });

  // “修整”按钮单键切换：修整 ↔ 撤销修整（切换时改按钮文字与颜色）
  function setTidyBtnMode(undo) {
    if (undo) {
      tidyBtn.textContent = '撤销修整';
      tidyBtn.classList.remove('primary');
      tidyBtn.classList.add('revert');
      tidyBtn.title = '撤销最后一次修整，恢复原文本';
    } else {
      tidyBtn.textContent = '修整';
      tidyBtn.classList.remove('revert');
      tidyBtn.classList.add('primary');
      tidyBtn.title = '将两侧文本中多余的空格、制表符、换行符与空行统一整理为一行';
    }
  }
  tidyBtn.addEventListener('click', function () {
    if (tidyBefore) {                      // 处于“撤销修整”态 → 撤销并恢复
      var b = tidyBefore;
      tidyBefore = null;
      editorL.setValue(b.left);
      editorR.setValue(b.right);
      setTidyBtnMode(false);
      toast('已撤销修整');
      setTimeout(function () { Pipeline.compare(); }, 0);
      return;
    }
    var left = editorL.getValue(), right = editorR.getValue();
    var vL = Norm.tidyText(left), vR = Norm.tidyText(right);
    if (vL === left && vR === right) { toast('文本无需修整'); return; }
    tidyBefore = { left: left, right: right };   // 快照，供撤销
    editorL.setValue(vL);
    editorR.setValue(vR);
    setTidyBtnMode(true);
    toast('已整理为一行，可撤销');
    setTimeout(function () { Pipeline.compare(); }, 0); // setValue 已触发 change，此处兜底确保重算
  });

  // ---------- 历史记录 UI（内联于侧边栏，无需点击展开） ----------
  function pad2(x) { return x < 10 ? '0' + x : '' + x; }
  function renderHistory() {
    var arr = loadHistory();
    var html = arr.length ? '' : '<div class="h-empty">暂无历史记录</div>';
    for (var i = 0; i < arr.length; i++) {
      var it = arr[i];
      var d = new Date(it.ts);
      var time = pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' '
                 + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
      var snippet = (it.left || '').replace(/\s+/g, ' ').slice(0, 24);
      html += '<div class="h-item">'
        + '<button class="h-restore" data-i="' + i + '">恢复</button>'
        + '<span class="h-time">' + time + '</span>'
        + '<button class="h-del" data-i="' + i + '" title="删除">×</button>'
        + '<span class="h-snippet" title="' + escHtml(snippet) + '">' + escHtml(snippet) + '</span></div>';
    }
    historyList.innerHTML = html;
    historyClearBtn.hidden = !arr.length;      // “清空全部”固定侧边栏最底部（index.html 静态元素），无记录时隐藏
  }
  historyClearBtn.addEventListener('click', function () {
    try { localStorage.removeItem(HISTORY_KEY); } catch (e2) {}
    renderHistory();
  });
  historyList.addEventListener('click', function (e) {
    var t = e.target;
    if (t.classList.contains('h-restore')) {
      var it = loadHistory()[+t.getAttribute('data-i')];
      if (!it) return;
      editorL.setValue(it.left || '');
      editorR.setValue(it.right || '');
      applyOptions(it.options || {});
      Pipeline.compare();
    } else if (t.classList.contains('h-del')) {
      var arr = loadHistory();
      arr.splice(+t.getAttribute('data-i'), 1);
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(arr)); } catch (e2) {}
      renderHistory();
    }
  });

  // ---------- 标注区域高度可调 ----------
  function clampResizeH(h) { return Math.max(110, Math.min(640, h)); }
  function onResizeMove(ev) {
    if (!resizeState || resizeState.mode !== 'results') return;
    var y = ev.touches ? ev.touches[0].clientY : ev.clientY;
    results.style.height = clampResizeH(resizeState.base + (y - resizeState.y)) + 'px';
    queueRefitPage();
  }
  function onResizeUp() {
    if (!resizeState || resizeState.mode !== 'results') return;
    document.removeEventListener('mousemove', onResizeMove);
    document.removeEventListener('mouseup', onResizeUp);
    document.removeEventListener('touchmove', onResizeMove);
    document.removeEventListener('touchend', onResizeUp);
    try { localStorage.setItem(RESIZE_KEY, results.style.height); } catch (e) {}
    resizeState = null;
  }
  function beginResize(startY) {
    resizeState = { mode: 'results', y: startY, base: results.offsetHeight || 280 };
    document.addEventListener('mousemove', onResizeMove);
    document.addEventListener('mouseup', onResizeUp);
    document.addEventListener('touchmove', onResizeMove);
    document.addEventListener('touchend', onResizeUp);
  }
  resizeBar.addEventListener('mousedown', function (ev) { ev.preventDefault(); beginResize(ev.clientY); });
  resizeBar.addEventListener('touchstart', function (ev) {
    ev.preventDefault();
    var t = ev.touches && ev.touches[0];
    if (t) beginResize(t.clientY);
  }, { passive: false });
  try { var storedH = localStorage.getItem(RESIZE_KEY); if (storedH) results.style.height = storedH; } catch (e) {}

  // ---------- 左右列宽调整 ----------
  var SPLIT_KEY = 'diffchecker_split';
  function setSplitPct(pct) {
    pct = Math.max(25, Math.min(75, pct));
    layoutEl.style.setProperty('--split', pct + '%');
  }
  function vsplitMove(ev) {
    if (!resizeState) return;
    var x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - resizeState.rect.left;
    setSplitPct((x / resizeState.rect.width) * 100);
  }
  function vsplitUp() {
    if (!resizeState || resizeState.mode !== 'vsplit') return;
    vsplitEl.classList.remove('active');
    document.removeEventListener('mousemove', vsplitMove);
    document.removeEventListener('mouseup', vsplitUp);
    document.removeEventListener('touchmove', vsplitMove);
    document.removeEventListener('touchend', vsplitUp);
    try { localStorage.setItem(SPLIT_KEY, layoutEl.style.getPropertyValue('--split') || ''); } catch (e) {}
    if (PdfView.relayout) PdfView.relayout();   // 列宽变化后按当前缩放模式重排 PDF
    resizeState = null;
  }
  vsplitEl.addEventListener('mousedown', function (ev) {
    ev.preventDefault();
    vsplitEl.classList.add('active');
    resizeState = { mode: 'vsplit', rect: layoutEl.getBoundingClientRect() };
    document.addEventListener('mousemove', vsplitMove);
    document.addEventListener('mouseup', vsplitUp);
  });
  vsplitEl.addEventListener('touchstart', function (ev) {
    ev.preventDefault();
    vsplitEl.classList.add('active');
    resizeState = { mode: 'vsplit', rect: layoutEl.getBoundingClientRect() };
    document.addEventListener('touchmove', vsplitMove);
    document.addEventListener('touchend', vsplitUp);
  }, { passive: false });
  try {
    var savedSplit = localStorage.getItem(SPLIT_KEY);
    if (savedSplit && /^\d+(\.\d+)?%$/.test(savedSplit)) layoutEl.style.setProperty('--split', savedSplit);
  } catch (e) {}

  // ---------- 左右互换 / 重置居中 ----------
  // 互换：编辑区文本、文件下拉、PDF 面板（连同其标注/文本项/原文缓存）整体对调；
  // 修整快照同步对调，保证“撤销修整”仍恢复到对应侧。不重新读盘，互换即时完成。
  function swapSides() {
    var pL = FilterBar.getSelected ? FilterBar.getSelected('L') : '';
    var pR = FilterBar.getSelected ? FilterBar.getSelected('R') : '';
    var tL = editorL.getValue(), tR = editorR.getValue();
    Pipeline.invalidateAll();                 // 作废旧侧在途加载，防止其回填覆盖互换结果
    editorL.setValue(tR);
    editorR.setValue(tL);
    if (tidyBefore) { var tb = tidyBefore.left; tidyBefore.left = tidyBefore.right; tidyBefore.right = tb; }
    if (FilterBar.selectFile) { FilterBar.selectFile('L', pR, true); FilterBar.selectFile('R', pL, true); }
    if (PdfView.swap) PdfView.swap();
    if (DocxView.swap) DocxView.swap();
    Pipeline.resetCharMaps();                 // PDF 互换：作废旧字符表，待重算
    updateTabTitle();
    toast('已左右互换');
  }
  if (swapBtn) swapBtn.addEventListener('click', swapSides);
  // 重置居中：列宽恢复 50%（双击拖动条同效），PDF 按新列宽重排
  function resetSplit() {
    setSplitPct(50);
    try { localStorage.removeItem(SPLIT_KEY); } catch (e) {}
    if (PdfView.relayout) PdfView.relayout();
    toast('已恢复左右等宽');
  }
  if (resetSplitBtn) resetSplitBtn.addEventListener('click', resetSplit);
  vsplitEl.addEventListener('dblclick', resetSplit);

  // ---------- 清除 ----------
  clearBtn.addEventListener('click', function () {
    editorL.setValue('');
    editorR.setValue('');
    tidyBefore = null;
    setTidyBtnMode(false);
    if (PdfView.clear) PdfView.clear();
    if (DocxView.clear) DocxView.clear();
    updatePdfArea();                             // 清除后无 PDF → 隐藏主区域3
    Pipeline.resetCharMaps();
    if (FilterBar.setFields) FilterBar.setFields([]);
    toast('已清除');
    Pipeline.compare();
  });

  // ---------- 导出报告 ----------
  // 复用批量报告同款渲染（src/report.js 的 Report.build）+ 同款逐页光栅化（PdfView.rasterizePage），
  // 在 UI 内把当前对比结果导出自包含 HTML 报告（差异标注 + 逐页快照，双击即看）。
  var exportReportBtn = $('exportReportBtn');
  /** 最近一次采集的两侧快照（导出报告复用，避免重复采集） */
  var lastShots = { L: [], R: [] };
  function defaultReportName() {
    function base(p) { var n = String(p || '').split('/').pop(); return (n || '').replace(/\.[^.]+$/, ''); }
    var lb = FilterBar.getSelected ? base(FilterBar.getSelected('L')) : '';
    var rb = FilterBar.getSelected ? base(FilterBar.getSelected('R')) : '';
    var ts = new Date();
    function p2(x) { return x < 10 ? '0' + x : '' + x; }
    var stamp = ts.getFullYear() + p2(ts.getMonth() + 1) + p2(ts.getDate()) + '-' +
      p2(ts.getHours()) + p2(ts.getMinutes()) + p2(ts.getSeconds());
    if (lb && rb && lb !== rb) return lb + '-' + rb + '-' + stamp + '.html';
    return '对比报告-' + stamp + '.html';
  }
  /** 采集单侧逐页快照（PDF 直接光栅化；docx/纯文本无快照 → 空数组，报告显示"无快照"） */
  function captureShots(side) {
    var n = (PdfView.getNumPages && PdfView.getNumPages(side)) || 0;
    if (!n) return Promise.resolve([]);
    var out = [];
    var chain = Promise.resolve();
    for (var p = 1; p <= n; p++) {
      (function (pageNum) {
        chain = chain.then(function () {
          if (!PdfView.isPageRendered || !PdfView.isPageRendered(side, pageNum)) {
            return PdfView.rasterizePage(side, pageNum, 1, false);
          }
          return PdfView.rasterizePage(side, pageNum, 1, false);
        }).then(function (r) { if (r && r.data) out.push({ data: r.data, w: r.w, h: r.h }); });
      })(p);
    }
    return chain.then(function () { return out; });
  }
  /** 组装报告 HTML（快照 + 原始文本 diff 已就绪，同步调用） */
  function buildReportHtml(r, pL, pR) {
    function base(p) { var n = String(p || '').split('/').pop(); return n || '左侧'; }
    var rawL = tidyBefore ? tidyBefore.left : editorL.getValue();
    var rawR = tidyBefore ? tidyBefore.right : editorR.getValue();
    var rawResult = null;
    try {
      if (typeof Compute !== 'undefined' && Compute.computeDiff) {
        var ro = readOptions(); ro.ignoreNewline = false;
        rawResult = Compute.computeDiff({ left: rawL, right: rawR, options: ro });
      }
    } catch (e) { rawResult = null; }
    var pair = {
      leftName: base(pL), rightName: base(pR),
      result: r,
      shots: { L: lastShots.L, R: lastShots.R },
      // 修整前原文（供报告"取消修整"按钮）：修整过用修整前快照，否则用当前编辑器文本
      rawText: { L: rawL, R: rawR },
      rawResult: rawResult
    };
    return Report.build({
      title: defaultReportName().replace(/\.html$/, ''),
      time: new Date().toLocaleString('zh-CN'),
      pairs: [pair]
    });
  }

  function exportReport() {
    var r = Pipeline.getResult ? Pipeline.getResult() : null;
    if (!r || r.error) { toast('没有可导出的对比结果', true); return; }
    if (typeof Report === 'undefined' || !Report.build) { toast('报告模块未加载（report.js 缺失）', true); return; }
    if (!Source || !Source.writeFile) { toast('写文件不可用', true); return; }
    var pL = FilterBar.getSelected ? FilterBar.getSelected('L') : '';
    var pR = FilterBar.getSelected ? FilterBar.getSelected('R') : '';
    var name = defaultReportName();
    if (Source.isTauri) {
      // 桌面版：Picker 选目录（绝对路径）→ 生成 → 写入
      if (!Picker || !Picker.open) { toast('保存位置选择不可用', true); return; }
      Picker.open(function (dir) {
        if (!dir) return;                                  // 用户取消
        var full = dir.replace(/\/+$/, '') + '/' + name;
        toast('正在生成报告…');
        Promise.all([captureShots('L'), captureShots('R')]).then(function (sh) {
          lastShots = { L: sh[0], R: sh[1] };
          var html = buildReportHtml(r, pL, pR);
          return Source.writeFile(full, html);
        }).then(function () {
          toast('报告已导出：' + full);
        }).catch(function (e) {
          toast('导出失败：' + ((e && e.message) || e), true);
        });
      });
      return;
    }
    // 浏览器版：先弹系统"另存为"捕获用户手势（报告生成耗时可观，手势会过期），再生成、再写入
    toast('请选择报告保存位置…');
    Source.saveAsHandle(name).then(function (handle) {
      if (!handle) { toast('当前浏览器不支持选择保存位置，将改为直接下载', true); }
      toast('正在生成报告…');
      return Promise.all([captureShots('L'), captureShots('R')]).then(function (sh) {
        lastShots = { L: sh[0], R: sh[1] };
        var html = buildReportHtml(r, pL, pR);
        if (handle) return Source.writeHandle(handle, html);
        return Source.writeFile(name, html);   // 回退：浏览器下载
      });
    }).then(function (savedName) {
      toast('报告已导出：' + (savedName || name));
    }).catch(function (e) {
      toast('导出失败：' + ((e && e.message) || e), true);
    });
  }
  if (exportReportBtn) exportReportBtn.addEventListener('click', exportReport);

  // ---------- 编辑区高度可调 ----------
  var EDITORS_KEY = 'diffchecker_editors_h';
  var edResizeState = null;
  function clampEdH(h) { return Math.max(120, Math.min(640, h)); }
  function onEdResizeMove(ev) {
    if (!edResizeState) return;
    var y = ev.touches ? ev.touches[0].clientY : ev.clientY;
    editorsEl.style.height = clampEdH(edResizeState.base + (y - edResizeState.y)) + 'px';
    queueRefitPage();
  }
  function onEdResizeUp() {
    if (!edResizeState) return;
    document.removeEventListener('mousemove', onEdResizeMove);
    document.removeEventListener('mouseup', onEdResizeUp);
    document.removeEventListener('touchmove', onEdResizeMove);
    document.removeEventListener('touchend', onEdResizeUp);
    try { localStorage.setItem(EDITORS_KEY, editorsEl.style.height); } catch (e) {}
    edResizeState = null;
  }
  function beginEdResize(startY) {
    edResizeState = { y: startY, base: editorsEl.offsetHeight || 320 };
    document.addEventListener('mousemove', onEdResizeMove);
    document.addEventListener('mouseup', onEdResizeUp);
    document.addEventListener('touchmove', onEdResizeMove);
    document.addEventListener('touchend', onEdResizeUp);
  }
  editorsResize.addEventListener('mousedown', function (ev) { ev.preventDefault(); beginEdResize(ev.clientY); });
  editorsResize.addEventListener('touchstart', function (ev) {
    ev.preventDefault();
    var t = ev.touches && ev.touches[0];
    if (t) beginEdResize(t.clientY);
  }, { passive: false });
  try { var storedEdH = localStorage.getItem(EDITORS_KEY); if (storedEdH) editorsEl.style.height = storedEdH; } catch (e) {}

  // ---------- PDF 全屏 ----------
  var pdfFocus = false;
  function setPdfFocus(on) {
    pdfFocus = on;
    appEl.classList.toggle('pdf-focus', on);
    pdfFullscreen.textContent = on ? '还原' : '全屏';
    queueRefitPage();
  }
  pdfFullscreen.addEventListener('click', function () { setPdfFocus(!pdfFocus); });

  // ---------- 页面高度对齐 PDF 区底部 ----------
  // .pdfarea 有 65vh 上限：内容不足以撑满视口时，.layout 会在 PDF 下方留出空档，
  // 侧边栏（含“清空全部”按钮）随之低于 PDF 底边。此处把页面高度收缩到 PDF 底边：
  // 空档消失，侧边栏底=清空按钮底=PDF 区底；历史记录列表 flex:1+overflow:auto 内部滚动。
  // 主区域3（PDF 显示区 + 缩放控件）仅在至少一侧已加载 PDF 时显示；
  // 未选文件/对比源未加载/两侧均为非 PDF 时隐藏（PDF 区没有可显示内容）。
  // 仅切换主区域3 显隐；不在此处重排页面高度：PDF 渲染是异步的，此时 refit 会量到
  // 未就绪的 pdfarea 高度而把 appEl 永久缩矮（“清空全部”被侧边栏 overflow:hidden 裁掉）。
  // 自然布局在显示后自动对齐（同 HEAD 行为）；resize/拖拽/折叠等已有调用点负责显式重排。
  function updatePdfArea() {
    var hasPdf = !!(PdfView.isLoaded && (PdfView.isLoaded('L') || PdfView.isLoaded('R')))
      || !!(DocxView.isLoaded && (DocxView.isLoaded('L') || DocxView.isLoaded('R')));
    pdfareaEl.classList.toggle('hidden', !hasPdf);
  }
  function refitPageToPdf() {
    if (pdfFocus) return;                            // 全屏模式 PDF 不限高，无空档
    if (!layoutEl.getBoundingClientRect || !pdfareaEl.getBoundingClientRect) return;  // 桩环境
    appEl.style.minHeight = '';                      // 先还原自然布局再量
    appEl.style.height = '';

    var pdfHidden = pdfareaEl.classList.contains('hidden');

    // 情况 A：主区域 3 隐藏（未加载 PDF）→ 以主区域 2（#layout）底部作为页面最下方
    // 做法：把 #appRoot 高度锁到视口高度；#layout flex:1 自然吃掉剩余空间，
    //       其底部即视口底部，侧边栏（#layout 列内）的"清空全部"也贴到视口底。
    if (pdfHidden) {
      var vh = (typeof window !== 'undefined' && window.innerHeight)
        || (document.documentElement && document.documentElement.clientHeight)
        || 0;
      if (vh > 0) {
        appEl.style.minHeight = '0';
        appEl.style.height = vh + 'px';
      }
      return;
    }

    // 情况 B：主区域 3 可见（已加载 PDF）→ 以主区域 3（#pdfarea）底部作为页面最下方
    // 做法：量出 #layout 底与 #pdfarea 底的空档，把 #appRoot 高度缩短该空档，
    //       使 #pdfarea 底正好贴视口底，侧边栏（#layout 内）也随 #layout 一起被压到 #pdfarea 上方。
    //       CSS 已让 #layout 有 min-height:0 + overflow:hidden → 压缩时侧边栏内部由历史列表滚动，
    //       不会再因内容撑开而破坏对齐。
    var gap = layoutEl.getBoundingClientRect().bottom - pdfareaEl.getBoundingClientRect().bottom;
    if (gap > 1) {
      appEl.style.minHeight = '0';
      appEl.style.height = Math.max(360, Math.round(appEl.getBoundingClientRect().height - gap)) + 'px';
    }
  }
  var refitScheduled = false;
  function queueRefitPage() {
    if (refitScheduled) return;
    refitScheduled = true;
    var raf = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame
      : function (f) { return setTimeout(f, 16); };  // 桩环境无 rAF
    raf(function () { refitScheduled = false; refitPageToPdf(); });
  }

  // ---------- PDF 缩放（自动缩放/适应宽度/适应页面，互斥高亮） ----------
  var ZOOM_BTNS = { auto: $('pdfAuto'), width: $('pdfFitW'), page: $('pdfFitP') };
  var zoomHintEl = $('pdfZoomHint');
  /** 缩放比例提示：取左（其次右）面板当前实际渲染比例 */
  function updatePdfZoomHint() {
    if (!zoomHintEl) return;
    var s = null;
    if (PdfView.isLoaded && PdfView.isLoaded('L') && PdfView.getScale) s = PdfView.getScale('L');
    if (s == null && PdfView.isLoaded && PdfView.isLoaded('R') && PdfView.getScale) s = PdfView.getScale('R');
    zoomHintEl.textContent = s == null ? '' : Math.round(s * 100) + '%';
    zoomHintEl.title = s == null ? '' : '当前显示比例 ' + Math.round(s * 100) + '%';
  }
  function setPdfZoom(mode) {
    for (var m in ZOOM_BTNS) {
      var b = ZOOM_BTNS[m];
      if (b) b.classList.toggle('active', m === mode);
    }
    if (PdfView.setMode) PdfView.setMode(mode);
    updatePdfZoomHint();
  }
  for (var m in ZOOM_BTNS) {
    (function (mode) {
      var b = ZOOM_BTNS[mode];
      if (b) b.addEventListener('click', function () { setPdfZoom(mode); });
    })(m);
  }
  // Ctrl+滚轮：仅在“自动缩放”模式下调整缩放比例（拦截，避免触发浏览器页面缩放）
  function onPdfWheel(ev) {
    if (!ev || !ev.ctrlKey) return;
    if (!PdfView.getMode || PdfView.getMode() !== 'auto') return;
    if (ev.preventDefault) ev.preventDefault();      // 拦截浏览器页面缩放（桩事件无此方法则跳过）
    var f = PdfView.getZoomFactor ? PdfView.getZoomFactor() : 1;
    if (PdfView.setZoomFactor) PdfView.setZoomFactor(ev.deltaY < 0 ? f * 1.1 : f / 1.1);
    updatePdfZoomHint();
  }
  ['pdfLeft', 'pdfRight'].forEach(function (id) {
    var el = $(id);
    if (el) el.addEventListener('wheel', onPdfWheel, { passive: false });
  });
  if (PdfView.setAfterRender) PdfView.setAfterRender(function (side) { updatePdfZoomHint(side); updatePdfArea(); });   // 每轮渲染完成后刷新提示 + 同步主区域3 显隐

  // ---------- 对比源：侧边栏路径 + 顶部筛选区 + PDF 面板 ----------
  var SRCPATH_KEY = 'diffchecker_srcpath';
  function getSrcRoot() { return srcPathInput.value.trim(); }
  function setSrcPathCur(txt) { srcPathCur.textContent = txt; }
  function loadSrcPath(p) {
    p = (p || '').trim();
    if (!p) { toast('请输入对比源路径', true); return; }
    setSrcPathCur(p);
    try { localStorage.setItem(SRCPATH_KEY, p); } catch (e) {}
    // 加载对比源后即用默认填充的第一组文件渲染主区域
    if (FilterBar.reload) FilterBar.reload().then(onDirChange);
  }
  srcLoadBtn.addEventListener('click', function () { loadSrcPath(getSrcRoot()); });
  srcPathInput.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); loadSrcPath(getSrcRoot()); }
  });
  try {
    var savedSrc = localStorage.getItem(SRCPATH_KEY);
    if (savedSrc) { srcPathInput.value = savedSrc; setSrcPathCur(savedSrc); }
  } catch (e) {}

  // 文件加载（PDF/Word/文本 → 主区域3 面板 + 该侧编辑区）在 Pipeline.loadSide；
  // 同侧新加载作废旧加载、字节预检、面板互斥等都在那里，此处只负责选文件的事件接线。

  /** 用户切换子文件夹（或加载对比源）后：按当前所选原始/修改文件立即渲染主区域 */
  function onDirChange() {
    var pL = FilterBar.getSelected ? FilterBar.getSelected('L') : '';
    var pR = FilterBar.getSelected ? FilterBar.getSelected('R') : '';
    Pipeline.loadSide('L', pL);
    Pipeline.loadSide('R', pR);
  }
  if (FilterBar.init) {
    FilterBar.init({
      getRoot: getSrcRoot,
      onFileChange: function (side, absPath) { Pipeline.loadSide(side, absPath); },
      onFieldPick: function (text) { editorL.setValue(text); },
      onDirChange: onDirChange
    });
  }
  if (PdfView.init) PdfView.init({ left: $('pdfLeft'), right: $('pdfRight') });
  if (typeof DocxView !== 'undefined' && DocxView.init) DocxView.init({ left: $('pdfLeft'), right: $('pdfRight') });
  // 对比源路径输入框：点击弹出文件夹选择
  if (Picker && Picker.init) Picker.init({ input: srcPathInput, onPick: loadSrcPath });

  // ---------- 第一行按钮：隐藏/显示编辑区 + 折叠/展开相同行 ----------
  var editorsHidden = false;
  function setEditorsHidden(h) {
    editorsHidden = h;
    editorsEl.classList.toggle('hidden', h);
    editorsResize.classList.toggle('hidden', h);
    toggleEditorsBtn.textContent = h ? '显示编辑区' : '隐藏编辑区';
    queueCmRefresh();
    queueRefitPage();
  }
  toggleEditorsBtn.addEventListener('click', function () { setEditorsHidden(!editorsHidden); });
  foldBtn.addEventListener('click', function () {
    Pipeline.setFoldEnabled(!Pipeline.isFoldEnabled());
    foldBtn.textContent = Pipeline.isFoldEnabled() ? '折叠相同行' : '展开相同行';
    var r = Pipeline.getResult();
    if (r && r.mode === 'grid') rerenderGridKeepScroll();
  });

  // ---------- 跨区域协同滚动（主区域1 标注 / 主区域2 编辑 / 主区域3 PDF·Word） ----------
  // 内容锚定：6 个滚动区块统一以“文本行号”为坐标系——区域1 行带 data-ls，编辑区行号即文本行号，
  // PDF 文本项行号与提取文本完全一致，Word 面板的段号即 mammoth 文本行号。滚动时把驱动区视口顶部
  // 换算成锚定行，其余区滚动到同一行；左右两侧行号经 diff 对齐表互译。
  // 页数/字号/版式差异不影响对照；锚信息缺失时降级比例同步。
  function currentScrollers() {
    var out = [];
    var lb = $('leftBody'), rb = $('rightBody'), ib = $('inline-body');
    if (lb) out.push(lb);
    if (rb) out.push(rb);
    if (ib) out.push(ib);
    if (editorL && editorL.getScrollerElement) out.push(editorL.getScrollerElement());
    if (editorR && editorR.getScrollerElement) out.push(editorR.getScrollerElement());
    if (PdfView.getPanel) {
      ['L', 'R'].forEach(function (s) { var p = PdfView.getPanel(s); if (p) out.push(p); });
    }
    return out;
  }

  // --- 左右行号互译：grid 结果中 li/ri 同时存在的行作为对齐锚点，线性插值 + 端点斜率1外推 ---
  var anchorCache = { res: null, l2r: [], r2l: [] };
  function anchorArrays() {
    var res = Pipeline.getResult();
    if (anchorCache.res === res) return anchorCache;
    var l2r = [], r2l = [];
    if (res && !res.error && res.mode === 'grid' && res.rows) {
      for (var i = 0; i < res.rows.length; i++) {
        var r = res.rows[i];
        if (r.li >= 0 && r.ri >= 0) { l2r.push([r.li + 1, r.ri + 1]); r2l.push([r.ri + 1, r.li + 1]); }
      }
    }
    anchorCache = { res: res, l2r: l2r, r2l: r2l };
    return anchorCache;
  }
  /** 锚表插值（连续行位）：对浮点 line 线性插值、端点斜率1外推，不取整（worklist 144：去双重取整抖动）。
   *  ★ 顶部虚拟第 0 行特殊处理：line <= 0 时直接返回 0。
   *    因 char 坐标系没有"文档边界之上"这一坐标点（charToLineFrac(0) 恒返回 1），
   *    若不加保护，源到顶（e=0）时目标会被映射到首行行首（页边距下沿），永远到不了页边界。 */
  function interpAnchor(arr, line) {
    if (!arr.length) return null;
    // 顶部虚拟第 0 行：两侧对齐到 0 行位（文档顶 = 各自页边距起点）
    if (line <= 0) return 0;
    if (line < arr[0][0]) return line + (arr[0][1] - arr[0][0]);        // 首锚之前：斜率1外推
    var lo = 0, hi = arr.length - 1;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (arr[mid][0] <= line) lo = mid; else hi = mid - 1; }
    var a = arr[lo];
    if (a[0] === line) return a[1];
    var b = arr[lo + 1];
    if (!b) return line + (a[1] - a[0]);                                 // 末锚之后：斜率1外推
    if (b[0] === a[0]) return a[1];
    var t = (line - a[0]) / (b[0] - a[0]);
    return a[1] + t * (b[1] - a[1]);
  }

  // --- 各区块的 行号↔像素 适配器 ---
  /** 区域1 标注列：由 DOM 的 data-ls/data-le 构建 [像素top → 行号区间] 索引（rect 法，与定位无关） */
  function rectIndex(el) {
    var idx = [];
    if (!el || !el.children || !el.getBoundingClientRect) return idx;   // 桩环境：空索引 → 比例兜底
    var base = el.getBoundingClientRect().top;
    var st = el.scrollTop;
    var kids = el.children;
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      var ls = k.getAttribute ? +(k.getAttribute('data-ls') || 0) : 0;
      if (!ls) continue;
      var le = +(k.getAttribute('data-le') || 0) || ls;
      var r = k.getBoundingClientRect();
      idx.push({ top: r.top - base + st, ls: ls, le: le, h: r.height });
    }
    idx.sort(function (a, b) { return a.top - b.top; });
    return idx;
  }
  function findByTop(idx, px) {              // 最后一个 top<=px 的条目
    var lo = -1, hi = idx.length - 1;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (idx[mid].top <= px) lo = mid; else hi = mid - 1; }
    return lo >= 0 ? idx[lo] : null;
  }
  function findByLine(idx, line) {           // ls<=line<=le 的条目，否则之前最近，再否则首条
    var prev = null;
    for (var i = 0; i < idx.length; i++) {
      if (line >= idx[i].ls && line <= idx[i].le) return idx[i];
      if (idx[i].ls <= line) prev = idx[i];
      else break;
    }
    return prev || idx[0] || null;
  }
  function gridBodyAdapter(el, side) {
    var idx = null;                          // 懒构建：重渲染产生新元素 → 新适配器；折叠/滚动不影响索引
    function ensure() { if (!idx) idx = rectIndex(el); return idx; }
    function entryOf(line) { var e = findByLine(ensure(), line); return e; }
    return {
      side: side, space: 'text',
      lineAt: function (px) { var e = findByTop(ensure(), px); return e ? e.ls : null; },
      // 连续行位：行首像素 + 行内比例 × 行高（lineAt 恒返回行首 → anchorOf 的 frac 即整行比例，往返一致）
      offsetOf: function (line) { var e = entryOf(line); return e ? e.top + (line - e.ls) * e.h : null; },
      lineH: function (line) { var e = entryOf(line); return e ? e.h : null; },
      // 下一行条目的顶部：间隙（折叠/空行）内行位线性插值不越界，消除行位不单调（worklist 145）
      nextOffset: function (line) {
        var e = entryOf(line);
        if (!e) return null;
        var arr = ensure();
        for (var i = 0; i < arr.length; i++) if (arr[i] === e) return (i + 1 < arr.length) ? arr[i + 1].top : null;
        return null;
      }
    };
  }
  function editorAdapter(cm, side) {
    function clampLine(line) {
      var n = cm.lineCount ? cm.lineCount() : 0;
      return n ? Math.max(1, Math.min(n, Math.round(line))) : 0;
    }
    return {
      side: side, space: 'text',
      lineAt: function (px) {
        try { var pos = cm.coordsChar({ left: 0, top: px }, 'local'); return pos ? pos.line + 1 : null; }
        catch (e) { return null; }
      },
      // 连续行位：floor 行首像素 + 行内比例 × 该行行高（lineAt 返回整数行 → 往返一致）
      offsetOf: function (line) {
        try {
          var n = cm.lineCount ? cm.lineCount() : 0;
          if (!n) return null;
          var l = Math.floor(line);
          if (l < 1) l = 1;
          if (l > n) l = n;
          var t = cm.heightAtLine(l - 1, 'local');
          var b = l < n ? cm.heightAtLine(l, 'local') : t + (cm.defaultTextHeight ? cm.defaultTextHeight() : 20);
          return t + (line - l) * Math.max(1, b - t);
        } catch (e) { return null; }
      },
      lineH: function (line) {
        try {
          var l = clampLine(line);
          if (!l) return null;
          var t = cm.heightAtLine(l - 1, 'local');
          var n = cm.lineCount();
          var b = l < n ? cm.heightAtLine(l, 'local') : t + (cm.defaultTextHeight ? cm.defaultTextHeight() : 20);
          return Math.max(1, b - t);
        } catch (e) { return null; }
      },
      // 下一行顶部（CodeMirror 行连续，无间隙 → 与 lineH 等价，走公共间隙插值逻辑）
      nextOffset: function (line) {
        try {
          var n = cm.lineCount ? cm.lineCount() : 0;
          var l = Math.floor(line);
          if (l < 1) l = 1;
          if (l >= n) return null;
          return cm.heightAtLine(l, 'local');
        } catch (e) { return null; }
      }
    };
  }
  // 该侧“面板里真正显示的是 PDF 还是 Word”由 Pipeline.panelViewer 判定（它同时服务标注与滚动锚定）

  /**
   * 主区域3 面板适配器。PDF 面板与 Word 面板共用同一元素（#pdfLeft/#pdfRight），
   * 两者都提供同名同语义的 lineAtOffset/lineOffset/lineHeight/nextLineOffset，
   * 行号坐标系同为"面板原文行号"，故 Word 面板与 PDF 面板一样按行锚定（而非比例同步）。
   * ★ 每次调用现取查看器（而非绑定时判定一次）：文件加载与协同滚动绑定是两条独立的时序，
   *   适配器对象在 rebind 之后仍长期存活，绑定时那个决定会过期。
   */
  function pdfPanelAdapter(side) {
    function viewer() { return Pipeline.panelViewer(side) || PdfView; }
    return {
      side: side, space: 'pdf',                  // 与 PDF 同坐标系：行号 = 面板原文（PDF/Word 提取文本）行号
      lineAt: function (px) { var v = viewer(); return v.lineAtOffset ? v.lineAtOffset(side, px) : null; },
      offsetOf: function (line) { var v = viewer(); return v.lineOffset ? v.lineOffset(side, line) : null; },
      lineH: function (line) { var v = viewer(); return v.lineHeight ? v.lineHeight(side, line) : null; },
      nextOffset: function (line) { var v = viewer(); return v.nextLineOffset ? v.nextLineOffset(side, line) : null; }
    };
  }

  // --- 字符级互译（6 区协同的核心）：把“文本行号”先换算成字符偏移，经对齐锚表互译，
  // --- 再换回另一侧的行号+行内比例。比纯行级插值更贴近真实内容，修整/重排后仍对齐。
  // 两张对齐表（editor = 编辑器文本坐标系 / pdf = 主区域3 面板原文坐标系）由 Pipeline 构建，
  // 这里只做互译计算：行级覆盖够用时走行级，稀疏（段落重排）时退到字符级。
  /** 连续行位 e（行号+行内比例，1基）→ 字符偏移（float，允许落在行中任意字符间） */
  function lineToChar(starts, textLen, e) {
    var n = starts.length;
    var idx = Math.floor(e) - 1;
    if (idx < 0) idx = 0;
    if (idx > n - 1) idx = n - 1;
    var frac = e - (idx + 1);
    var end = idx + 1 < n ? starts[idx + 1] : textLen;
    return starts[idx] + Math.max(0, frac) * Math.max(0, end - starts[idx]);
  }
  /** 字符偏移 → 连续行位 e */
  function charToLineFrac(starts, textLen, c) {
    var lo = 0, hi = starts.length - 1;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (starts[mid] <= c) lo = mid; else hi = mid - 1; }
    var end = lo + 1 < starts.length ? starts[lo + 1] : textLen;
    var len = Math.max(1, end - starts[lo]);
    return (lo + 1) + Math.max(0, Math.min(1, (c - starts[lo]) / len));
  }
  /** 行级互译（同 grid 现有逻辑）：连续行位经行锚表线性插值（浮点，不取整） */
  function translateLineMap(map, from, to, e) {
    var arr = from === 'L' ? map.line.l2r : map.line.r2l;
    return interpAnchor(arr, e);
  }
  /** 字符级互译：连续行位 → 字符偏移 → 锚表 → 另一侧字符偏移 → 连续行位 */
  function translateCharMap(map, from, to, e) {
    var srcStarts = map.lineStarts[from], tgtStarts = map.lineStarts[to];
    var srcText = map.texts[from], tgtText = map.texts[to];
    var c = lineToChar(srcStarts, srcText.length, e);
    var arr = from === 'L' ? map.char.l2r : map.char.r2l;
    var c2 = interpAnchor(arr, c);
    if (c2 == null) return null;
    return charToLineFrac(tgtStarts, tgtText.length, c2);
  }
  /**
   * 用对齐表互译：行级覆盖足够（行结构化内容，精确无漂移）优先行级；
   * 覆盖稀疏（段落重排，行已打散）则退到字符级；行级表存在但覆盖低时仍可作兜底。
   *
   * ★ 关键：虚拟第 0 行（e < 1）直接映射，不进入任何行级/字符级互译。
   *   原因：char 坐标系里 c=0 表示"第 1 行第 1 字符"，charToLineFrac(c=0) 恒返回 1，
   *   会把"文档边界"错误映射到"首行行首"（页边距下沿）。任何 PDF 顶部都有页边距，
   *   源到顶（e=0）时目标就会停在首行上沿、永远滚不到边界。
   *   e < 1 直接返回 e，让两侧虚拟第 0 行按各自页边距比例同步（通常两侧页边距接近，
   *   视觉上完全对齐到边界）。这是"右侧差一点才能看到顶部"的根因修复。
   */
  function translateWithMap(map, from, to, e) {
    if (e < 1) return e;
    if (map.line) {
      var arr = from === 'L' ? map.line.l2r : map.line.r2l;
      if (arr && arr.length) {
        var firstSrc = arr[0][0];
        var lastSrc = arr[arr.length - 1][0];
        if (e < firstSrc || e > lastSrc) {
          var rBoundary = translateLineMap(map, from, to, e);
          if (rBoundary != null) return rBoundary;
        }
      }
      if (map.line.coverage >= 0.3) {
        var r = translateLineMap(map, from, to, e);
        if (r != null) return r;
      } else if (map.char) {
        var c = translateCharMap(map, from, to, e);
        if (c != null) return c;
      }
      var r2 = translateLineMap(map, from, to, e);
      if (r2 != null) return r2;
    }
    if (map.char) return translateCharMap(map, from, to, e);
    return null;
  }
  // ★ 这里的 "pdf" 指"主区域3 面板坐标系"（PDF 提取文本 / Word 的 mammoth 文本，行号都是面板原文行号），
  //   Word 面板与 PDF 面板共用该坐标系，故一律走面板原文表这条路径。
  function crossTranslate(srcA, oA, e) {
    var from = srcA.side, to = oA.side;
    var srcPdf = srcA.space === 'pdf', tgtPdf = oA.space === 'pdf';
    var maps = Pipeline.charMaps();
    var editorCharMap = maps.editor, pdfCharMap = maps.pdf, pdfMapMatchesEditors = maps.pdfMatchesEditors;
    var r;
    // 面板↔面板：恒用面板原文表（修整/手工改编辑器后依然对得准 —— 最高优先级）
    if (srcPdf && tgtPdf && pdfCharMap) {
      r = translateWithMap(pdfCharMap, from, to, e);
      if (r != null) return r;
    }
    // 编辑↔编辑：用对比结果表（编辑器文本坐标系）
    if (!srcPdf && !tgtPdf && editorCharMap) {
      r = translateWithMap(editorCharMap, from, to, e);
      if (r != null) return r;
    }
    // 混合（主区域3↔编辑）：仅当编辑器文本与面板原文一致时字符级坐标才成立
    if ((srcPdf !== tgtPdf) && pdfCharMap && pdfMapMatchesEditors) {
      r = translateWithMap(pdfCharMap, from, to, e);
      if (r != null) return r;
    }
    // 降级：行级对齐表（grid 行配对），无表则 null → 比例兜底
    var ac = anchorArrays();
    var arr = from === 'L' ? ac.l2r : ac.r2l;
    // ★ 空表留痕：flow 模式 / 未产生对齐锚点时，会频繁走这条路径退化为比例同步——
    //   若控制台频繁打印该警告，说明 diff 结果里 lineAnchors/charAnchors 未正确填充，
    //   需检查 worker 那边的计算，而非在协同滚动侧继续调参。
    if (!arr.length) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[sync] 对齐锚点为空，退化为比例同步:', from, '→', to);
      }
      return null;
    }
    return interpAnchor(arr, e);
  }
  if (SyncScroll && SyncScroll.setTranslator) {
    SyncScroll.setTranslator(function (srcA, oA, e) { return crossTranslate(srcA, oA, e); });
  }

  function rebindScrollSync() {
    if (!SyncScroll) return;
    if (SyncScroll.setAdapter) {
      var lb = $('leftBody'), rb = $('rightBody');
      if (lb) SyncScroll.setAdapter(lb, gridBodyAdapter(lb, 'L'));
      if (rb) SyncScroll.setAdapter(rb, gridBodyAdapter(rb, 'R'));
      if (editorL && editorL.getScrollerElement) SyncScroll.setAdapter(editorL.getScrollerElement(), editorAdapter(editorL, 'L'));
      if (editorR && editorR.getScrollerElement) SyncScroll.setAdapter(editorR.getScrollerElement(), editorAdapter(editorR, 'R'));
      if (PdfView.getPanel) {
        ['L', 'R'].forEach(function (s) { var p = PdfView.getPanel(s); if (p) SyncScroll.setAdapter(p, pdfPanelAdapter(s)); });
      }
    }
    if (SyncScroll.rebind) SyncScroll.rebind(currentScrollers());
  }

  /** 折叠/展开重渲染：按锚定行恢复位置（优于比例：折叠增删行后比例已失真，行号不会） */
  function rerenderGridKeepScroll() {
    var lb = $('leftBody');
    var px = lb ? lb.scrollTop : 0;
    var e = lb ? findByTop(rectIndex(lb), px) : null;
    var line = e ? e.ls : null;
    var dtop = e ? px - e.top : 0;
    Pipeline.renderGrid(Pipeline.getResult());    // 内部经 onRendered 重新绑定协同滚动（新元素 + 新适配器）
    var nlb = $('leftBody');
    if (nlb && line != null) {
      var ne = findByLine(rectIndex(nlb), line);
      if (ne) {
        var max = nlb.scrollHeight - nlb.clientHeight;
        nlb.scrollTop = Math.max(0, Math.min(max > 0 ? max : 0, ne.top + dtop));   // scroll 事件带动其余五区
        return;
      }
    }
    ['leftBody', 'rightBody'].forEach(function (id) {   // 锚丢失兜底：比例恢复
      var el = $(id);
      if (!el) return;
      var max2 = el.scrollHeight - el.clientHeight;
      if (max2 > 0) {
        var ratio = (lb && lb.scrollHeight > lb.clientHeight) ? px / (lb.scrollHeight - lb.clientHeight) : 0;
        el.scrollTop = ratio * max2;
      }
    });
  }

  // ---------- 侧边栏 ----------
  function isNarrow() {
    var w = (typeof window !== 'undefined' && window.innerWidth) ? window.innerWidth : 0;
    return w > 0 && w < 900;   // 沙箱无 window → w=0 → false（宽屏）
  }
  function applySidebar(open) {                       // 只反映到 DOM，不持久化
    sidebarOpen = open;
    sidebarEl.classList.toggle('collapsed', !open);
    sidebarToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  function queueCmRefresh() {
    setTimeout(function () {
      if (editorL && typeof editorL.refresh === 'function') editorL.refresh();
      if (editorR && typeof editorR.refresh === 'function') editorR.refresh();
    }, 220);                                          // 在 0.2s 过渡结束后重测宽高
  }
  function setSidebar(open) {                         // 用户主动切换：动画 + 持久化
    sidebarEl.classList.add('anim');
    applySidebar(open);
    sidebarPref = open;
    try { localStorage.setItem(SIDEBAR_KEY, open ? '1' : '0'); } catch (e) {}
    queueCmRefresh();
  }
  function refreshSidebarForViewport() {              // init 与 resize：窄屏收起、宽屏恢复偏好
    var open = isNarrow() ? false : (sidebarPref === null ? true : sidebarPref);
    if (open !== sidebarOpen) { applySidebar(open); queueCmRefresh(); }
  }
  sidebarToggle.addEventListener('click', function () { setSidebar(!sidebarOpen); });
  try {
    var sbSaved = localStorage.getItem(SIDEBAR_KEY);
    if (sbSaved === '0') sidebarPref = false;
    else if (sbSaved === '1') sidebarPref = true;
  } catch (e) {}
  refreshSidebarForViewport();                        // 先于 CodeMirror 创建，保证初次量宽正确
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('resize', function () { refreshSidebarForViewport(); queueRefitPage(); });
  }

  // ---------- 多标签页（会话切换：每标签保存自己的内容/选项/PDF/源文件） ----------
  function newTabState() {
    return {
      left: '', right: '',
      options: { ignoreEol: true, ignoreCase: true, ignoreWhitespace: true, ignoreNewline: true, ignoreWidth: true, ignorePunct: true },
      foldEnabled: true, editorsHidden: false, tidy: null,
      pdfMode: 'auto',
      srcRoot: '', dir: '', fileL: '', fileR: ''
    };
  }
  function captureState() {
    return {
      left: editorL.getValue(), right: editorR.getValue(),
      options: readOptions(),
      foldEnabled: Pipeline.isFoldEnabled(), editorsHidden: editorsHidden, tidy: tidyBefore,
      pdfMode: PdfView.getMode ? PdfView.getMode() : 'auto',
      srcRoot: srcPathInput.value.trim(),
      dir: $('dirSel') ? $('dirSel').value : '',
      fileL: FilterBar.getSelected ? FilterBar.getSelected('L') : '',
      fileR: FilterBar.getSelected ? FilterBar.getSelected('R') : ''
    };
  }
  function activeIndex() {
    for (var i = 0; i < tabs.length; i++) if (tabs[i].id === activeTabId) return i;
    return -1;
  }
  function currentTab() { var i = activeIndex(); return i < 0 ? null : tabs[i]; }
  function renderTabs() {
    if (Tabs && Tabs.setList) Tabs.setList(tabs.map(function (t) { return { id: t.id, title: t.title, tip: t.tip }; }));
  }
  // tab 标题取真实对比对象：优先两个文件名（精简显示、tooltip 完整），无文件时用两侧文本开头，兜底“对比 N”
  function computeTabTitle() {
    var pL = FilterBar.getSelected ? FilterBar.getSelected('L') : '';
    var pR = FilterBar.getSelected ? FilterBar.getSelected('R') : '';
    var nL = stripExt(baseName(pL)), nR = stripExt(baseName(pR));
    if (nL || nR) {
      return {
        title: abbrev(nL || '空', 8) + '↔' + abbrev(nR || '空', 8),
        tip: (nL || '（空）') + ' ↔ ' + (nR || '（空）')
      };
    }
    var lt = (editorL.getValue() || '').replace(/\s+/g, ' ').trim();
    var rt = (editorR.getValue() || '').replace(/\s+/g, ' ').trim();
    if (lt || rt) {
      return {
        title: abbrev(lt.slice(0, 8) || '空', 8) + '↔' + abbrev(rt.slice(0, 8) || '空', 8),
        tip: (lt.slice(0, 30) || '（空）') + ' ↔ ' + (rt.slice(0, 30) || '（空）')
      };
    }
    return null;
  }
  function updateTabTitle() {
    var tab = currentTab();
    if (!tab) return;
    var t = computeTabTitle();
    var title = t ? t.title : tab.defTitle;
    var tip = t ? t.tip : tab.defTitle;
    if (title !== tab.title || tip !== tab.tip) {
      tab.title = title;
      tab.tip = tip;
      renderTabs();
    }
  }
  function restoreTab(tab) {
    restoring = true;
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    editorL.setValue(tab.left || '');
    editorR.setValue(tab.right || '');
    applyOptions(tab.options || {});
    Pipeline.setFoldEnabled(tab.foldEnabled !== false);
    foldBtn.textContent = Pipeline.isFoldEnabled() ? '折叠相同行' : '展开相同行';
    setEditorsHidden(!!tab.editorsHidden);
    tidyBefore = tab.tidy || null;
    setTidyBtnMode(!!tidyBefore);
    Pipeline.resetFold();
    if (PdfView.setMode) PdfView.setMode(tab.pdfMode || 'auto');
    if (tab.srcRoot) { srcPathInput.value = tab.srcRoot; setSrcPathCur(tab.srcRoot); }
    if (FilterBar.setFields) FilterBar.setFields([]);
    Pipeline.compare(true);                        // 渲染差异区（恢复发起，不写历史）
    restoring = false;
    queueRefitPage();                              // 编辑区显隐恢复后重对齐页面高度
    restorePdfFiles(tab);                          // 异步恢复 PDF / 文件下拉
  }
  function selectTabFiles(tab, my) {
    var pair = [['L', tab.fileL], ['R', tab.fileR]];
    for (var i = 0; i < pair.length; i++) {
      var side = pair[i][0], path = pair[i][1];
      if (FilterBar.selectFile) FilterBar.selectFile(side, path || '', true);
      if (path && Source.fileUrl) {
        // fileUrl 返回 Promise（Tauri 模式需先经 Rust 读字节转 Blob URL）
        if (/\.pdf$/i.test(path)) {
          if (PdfView.load) {
            Source.fileUrl(path).then(function (url) {
              return PdfView.load(side, url, my);
            }).catch(function () {});
          }
        }
        else if (/\.docx$/i.test(path)) {
          // 恢复 docx 面板（文本已在 tab state 的编辑器里，这里只重渲染主区域3）。
          // IIFE 固定本轮的 side/path：var 提升后回调里读到的是循环结束值
          (function (sd, pth) {
            if (PdfView.clear) PdfView.clear(sd);
            Source.fileUrl(pth).then(function (url) {
              return fetch(url).then(function (r) { return r.arrayBuffer(); });
            }).then(function (buf) {
              // load 会作废该侧坐标系与标注（新 DOM 不能被旧标注命中），故重新提词登记
              return Promise.all([DocxView.load(sd, buf, my), DocxView.extractText(buf)]);
            }).then(function (rs) {
              var text = (rs && rs[1]) || '';
              if (DocxView.setSourceText) DocxView.setSourceText(sd, text);
              // 重渲染已作废该侧旧标注。仅当面板原文正是编辑器当前文本时，当前结果才是它的对比
              // 结果 → 直接重落；否则交给随后的对比流程重标（免得把别的 tab 的结果画到这份文档上）
              var cur = (sd === 'L' ? editorL.getValue() : editorR.getValue());
              var res = Pipeline.getResult();
              if (text && text === cur && res && !res.error) {
                var m = Pipeline.buildAnnotMaps(res);
                DocxView.setHighlight(sd, sd === 'L' ? m.L : m.R);
              }
              updatePdfArea();
            }).catch(function () {});
          })(side, path);
        }
        else { if (PdfView.clear) PdfView.clear(side); if (DocxView.clear) DocxView.clear(side); updatePdfArea(); }
      } else { if (PdfView.clear) PdfView.clear(side); if (DocxView.clear) DocxView.clear(side); updatePdfArea(); }
    }
  }
  function restorePdfFiles(tab) {
    var my = ++switchSeq;
    Pipeline.invalidateAll();        // 切标签页：作废上一个 tab 在途的文件加载，防止其回填覆盖
    if (!tab.srcRoot && !tab.dir && !tab.fileL && !tab.fileR) {  // 空白 tab：清空选择与 PDF
      if (FilterBar.selectFile) { FilterBar.selectFile('L', '', true); FilterBar.selectFile('R', '', true); }
      if (PdfView.clear) PdfView.clear();
      if (DocxView.clear) DocxView.clear();
      updatePdfArea();
      return;
    }
    var chain = (tab.srcRoot && tab.srcRoot !== getSrcRoot() && FilterBar.reload)
      ? FilterBar.reload() : Promise.resolve();
    chain.then(function () {
      if (my !== switchSeq) return;
      if (tab.dir && tab.dir !== ($('dirSel') ? $('dirSel').value : '') && FilterBar.selectDir) {
        return FilterBar.selectDir(tab.dir);
      }
    }).then(function () {
      if (my !== switchSeq) return;
      selectTabFiles(tab, my);
    }).catch(function () { /* 恢复失败不致命：编辑区内容已恢复 */ });
  }
  function onTabSwitch(id) {
    if (id === activeTabId) return;
    var cur = currentTab();
    if (cur) cur.state = captureState();
    activeTabId = id;
    restoreTab(currentTab().state);
  }
  function onTabAdd() {
    var id = ++tabSeq;
    tabs.push({ id: id, defTitle: '对比 ' + id, title: '对比 ' + id, tip: '对比 ' + id, state: newTabState() });
    renderTabs();
    if (Tabs.setActive) Tabs.setActive(id);
  }
  function onTabClose(id) {
    if (tabs.length <= 1) { toast('至少保留一个对比窗口'); return; }
    var idx = -1;
    for (var i = 0; i < tabs.length; i++) if (tabs[i].id === id) { idx = i; break; }
    if (idx < 0) return;
    if (id === activeTabId) {
      var nb = tabs[idx === 0 ? 1 : idx - 1];
      tabs.splice(idx, 1);
      activeTabId = nb.id;
      renderTabs();
      restoreTab(nb.state);
      if (Tabs.setActive) Tabs.setActive(nb.id);   // 内部 activeId 仍是已关闭 id → 触发 onSwitch → 守卫空转
    } else {
      tabs.splice(idx, 1);
      renderTabs();
    }
  }
  if (Tabs && Tabs.init) {
    Tabs.init({ listEl: $('tabs'), addBtn: $('tabAdd'), onAdd: onTabAdd, onSwitch: onTabSwitch, onClose: onTabClose });
  }

  // ---------- 初始化 ----------
  editorL = CodeMirror.fromTextArea($('leftEd'), { lineNumbers: true, mode: 'text/plain', lineWrapping: true, autofocus: true });
  editorR = CodeMirror.fromTextArea($('rightEd'), { lineNumbers: true, mode: 'text/plain', lineWrapping: true });
  for (var id in OPT_MAP) $(id).addEventListener('change', scheduleCompare);
  editorL.on('change', scheduleCompare);
  editorR.on('change', scheduleCompare);
  setTidyBtnMode(false);
  var firstTab = { id: ++tabSeq, defTitle: '对比 ' + tabSeq, title: '对比 ' + tabSeq, tip: '对比 ' + tabSeq, state: newTabState() };
  tabs.push(firstTab);
  renderTabs();
  if (Tabs.setActive) Tabs.setActive(firstTab.id);  // → onSwitch → restoreTab（首次空状态渲染）
  setPdfZoom('auto');
  renderHistory();                                 // 侧边栏历史首次渲染
  updatePdfArea();                                 // 首屏：未加载 PDF → 隐藏主区域3
  queueRefitPage();                                // 首屏：页面高度对齐 PDF 区底部
})();