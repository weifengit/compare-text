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

  // ---------- 状态 ----------
  var OPT_MAP = {
    optIgnoreCase: 'ignoreCase',
    optIgnoreEol: 'ignoreEol',
    optIgnoreWhitespace: 'ignoreWhitespace',
    optIgnoreNewline: 'ignoreNewline',
    optIgnoreWidth: 'ignoreWidth',
    optIgnorePunct: 'ignorePunct'
  };
  var expanded = {};            // 折叠行展开状态
  var lastResult = null;        // 最近一次计算结果
  var lastOptions = null;       // 最近一次对比所用选项
  var worker = null;
  var seq = 0;
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
    if (b) { statusEl.innerHTML = '<span class="spin"></span>正在计算…'; }
    else if (!lastResult) { statusEl.textContent = '在两侧粘贴文本即可自动对比'; }
    else if (lastResult.error) { statusEl.textContent = '计算出错：' + lastResult.error; statusEl.classList.add('bad'); }
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

  // ---------- 对比入口 ----------
  function ensureWorker() {
    if (worker) { var w = worker; return w; }
    try {
      worker = new Worker('src/worker.js');
    } catch (e) {
      worker = null;
      return null;
    }
    worker.onmessage = function (ev) {
      if (ev.data.id !== seq) return; // 丢弃过期结果
      setBusy(false);
      if (ev.data.error) { lastResult = { error: ev.data.error }; setBusy(false); reportStats(null); return; }
      ev.data.result._options = lastOptions;
      renderResult(ev.data.result);
    };
    worker.onerror = function () { worker = null; };
    return worker;
  }
  function runLocal(payload) {
    try { return Compute.computeDiff(payload); } catch (e) { return { error: String((e && e.stack) || e) }; }
  }
  function compare(fromRestore) {
    lastCompareIsRestore = !!fromRestore;
    var left = editorL.getValue(), right = editorR.getValue();
    var o = readOptions();
    lastOptions = o;
    lastResult = null;
    var payload = { left: left, right: right, options: o };
    var w = ensureWorker();
    if (w) {
      setBusy(true);
      w.postMessage({ id: ++seq, payload: payload });
    } else {
      var res = runLocal(payload);
      res._options = o;
      renderResult(res);
    }
  }

  // ---------- 渲染 ----------
  function segsHtml(segs) {
    var h = '';
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      h += '<span class="hl ' + (s.cls === 'rm' ? 'rm' : s.cls === 'ad' ? 'ad' : 'eq') + '">' +
           escHtml(s.text).replace(/\r/g, '') + '</span>';
    }
    return h;
  }

  function buildRowsWithFold(rows) {
    var n = rows.length, out = [], i = 0;
    while (i < n) {
      if (foldEnabled && rows[i].type === 'equal') {
        var j = i;
        while (j < n && rows[j].type === 'equal') j++;
        if (j - i >= 3) {
          var key = i + ':' + (j - 1);
          if (expanded[key]) { for (var k = i; k < j; k++) out.push(rows[k]); }
          else out.push({ type: 'fold', count: j - i, li: rows[i].li, ri: rows[i].ri, key: key });
          i = j;
          continue;
        }
      }
      out.push(rows[i]);
      i++;
    }
    return out;
  }

  // data-ls/data-le：该行（或折叠条）覆盖的文本行号区间（1 基），供内容锚定协同滚动定位
  function cellHtml(ln, content, cls, attrs) {
    return '<div class="row ' + cls + '"' + (attrs || '') + '><span class="ln">' + ln + '</span><span class="content">' + content + '</span></div>';
  }

  var FOLD_LABEL = '行相同内容（点击展开）';

  function renderGrid(res) {
    var rowsArr = buildRowsWithFold(res.rows);
    var L = res.leftLines, R = res.rightLines;
    var leftBody = '', rightBody = '';
    for (var i = 0; i < rowsArr.length; i++) {
      var r = rowsArr[i];
      if (r.type === 'fold') {
        var lbl = '▶ ' + r.count + ' ' + FOLD_LABEL;
        var fb = '<div class="fold-bar">' + lbl + '</div>';
        leftBody += '<div class="fold-row" data-key="' + r.key + '" data-ls="' + (r.li + 1) + '" data-le="' + (r.li + r.count) + '">' + fb + '</div>';
        rightBody += '<div class="fold-row" data-key="' + r.key + '" data-ls="' + (r.ri + 1) + '" data-le="' + (r.ri + r.count) + '">' + fb + '</div>';
        continue;
      }
      var lnL = r.li >= 0 ? String(r.li + 1) : '';
      var lnR = r.ri >= 0 ? String(r.ri + 1) : '';
      var lsL = ' data-ls="' + (r.li + 1) + '"';
      var lsR = ' data-ls="' + (r.ri + 1) + '"';
      if (r.type === 'equal') {
        leftBody += cellHtml(lnL, escHtml(L[r.li]), 'same', lsL);
        rightBody += cellHtml(lnR, escHtml(R[r.ri]), 'same', lsR);
      } else if (r.type === 'change') {
        leftBody += cellHtml(lnL, segsHtml(r.segL), 'change-l', lsL);
        rightBody += cellHtml(lnR, segsHtml(r.segR), 'change-r', lsR);
      } else if (r.type === 'remove') {
        leftBody += cellHtml(lnL, escHtml(L[r.li]), 'remove', lsL);
        rightBody += '<div class="row empty"></div>';
      } else if (r.type === 'add') {
        leftBody += '<div class="row empty"></div>';
        rightBody += cellHtml(lnR, escHtml(R[r.ri]), 'add', lsR);
      }
    }
    results.innerHTML =
      '<div class="grid">' +
      '<div class="colhead">原文</div>' +
      '<div class="colhead">修改后</div>' +
      '<div class="grid-body" id="leftBody">' + leftBody + '</div>' +
      '<div class="grid-body" id="rightBody">' + rightBody + '</div>' +
      '</div>';
    reportStats(res);
    rebindScrollSync();   // 重渲染重建了 leftBody/rightBody，必须重新绑定协同滚动
  }

  /** 流水视图：按原文实际行拆行（保留行号），每行一段高亮片段 */
  function flowLineRows(segs) {
    var rows = [], cur = [], ln = 1;
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      var parts = String(s.text).split(/(\r\n|\n|\r)/);
      for (var p = 0; p < parts.length; p++) {
        var part = parts[p];
        if (/^(\r\n|\n|\r)$/.test(part)) {
          rows.push({ n: ln, segs: cur });
          cur = [];
          ln++;
        } else if (part !== '') {
          cur.push({ text: part, cls: s.cls });
        }
      }
    }
    if (cur.length) rows.push({ n: ln, segs: cur });
    return rows;
  }

  /** 流水行渲染：左侧行号列 + 内容，与并排视图一致 */
  function flowRowsHtml(rows) {
    var h = '';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var inner = '';
      for (var j = 0; j < r.segs.length; j++) {
        var s = r.segs[j];
        var cls = s.cls === 'rm' ? 'rm' : s.cls === 'ad' ? 'ad' : 'eq';
        inner += '<span class="hl ' + cls + '">' + escHtml(s.text).replace(/\r/g, '') + '</span>';
      }
      h += '<div class="row" data-ls="' + r.n + '"><span class="ln">' + r.n + '</span><span class="content">' + inner + '</span></div>';
    }
    return h;
  }

  function renderFlow(res) {
    if (res.skipped) {
      results.innerHTML = '<div class="inline-body" id="inline-body" style="padding:20px;color:#666">'
        + '文本过大，忽略换行模式暂无法逐字符对比（' + res.leftLen + ' / ' + res.rightLen + ' 字符）。'
        + '可关闭“忽略换行”后重试。</div>';
      reportStats(null);
      return;
    }
    results.innerHTML =
      '<div class="grid">' +
      '<div class="colhead">原文（标注）</div>' +
      '<div class="colhead">修改后（标注）</div>' +
      '<div class="grid-body" id="leftBody">' + flowRowsHtml(flowLineRows(res.segsL)) + '</div>' +
      '<div class="grid-body" id="rightBody">' + flowRowsHtml(flowLineRows(res.segsR)) + '</div>' +
      '</div>';
    reportStats({ mode: 'flow', addedChars: res.addedChars, removedChars: res.removedChars });
    rebindScrollSync();   // 同上：重建了左右栏后重新绑定协同滚动
  }

  function renderResult(res) {
    lastResult = res;
    refreshEditorCharMap();              // 编辑区字符对齐表随结果重建（渲染前，供后续滚动互译）
    var isRestore = lastCompareIsRestore;
    if (!isRestore) saveHistoryEntry();
    lastCompareIsRestore = false;
    setBusy(false);
    renderHistory();                       // 侧边栏历史随每次对比刷新
    if (!isRestore) updateTabTitle();      // tab 标题随对比对象更新（恢复 tab 时保留其已有标题）
    if (res.error) { results.innerHTML = ''; reportStats(null); updatePdfAnnotations(null); rebindScrollSync(); return; }
    if (editorL.getValue() === '' && editorR.getValue() === '') {
      results.innerHTML = '<div class="placeholder">在两侧粘贴文本，即可自动开始对比</div>';
      statsEl.innerHTML = '';
      statusEl.textContent = '在两侧粘贴文本即可自动对比';
      updatePdfAnnotations(null);
      rebindScrollSync();
      return;
    }
    if (res.mode === 'flow') renderFlow(res);
    else renderGrid(res);
    updatePdfAnnotations(res);
    rebindScrollSync();
  }

  /** 由 diff 结果构建 PDF 标注映射：rm/ad 整行涂色；change 行携带行内字符片段（segL/segR，与区域1 高亮同源）做字符级标注 */
  function buildAnnotMaps(res) {
    var mapL = {}, mapR = {};
    function put(rows) {
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (r.type === 'change') {
          if (r.li >= 0) mapL[r.li + 1] = { t: 'ch', segs: r.segL || [] };
          if (r.ri >= 0) mapR[r.ri + 1] = { t: 'ch', segs: r.segR || [] };
        } else if (r.type === 'remove') {
          if (r.li >= 0) mapL[r.li + 1] = 'rm';
        } else if (r.type === 'add') {
          if (r.ri >= 0) mapR[r.ri + 1] = 'ad';
        }
      }
    }
    /** 流水字符片段 → 逐行 { t, segs } 映射（segs 需含 eq 片段以维持行内偏移） */
    function putFlow(map, segs, t) {
      if (!segs || !segs.length) return;
      var line = 1;
      var cur = [];                                   // 当前行片段（含 eq，保证偏移正确）
      function flush() {
        for (var i = 0; i < cur.length; i++) {
          if (cur[i].cls !== 'eq') { map[line] = { t: t, segs: cur }; break; }
        }
        cur = [];
      }
      for (var i = 0; i < segs.length; i++) {
        var cls = segs[i].cls, text = segs[i].text, a = 0;
        for (var j = 0; j <= text.length; j++) {
          if (j === text.length || text[j] === '\n') {
            if (j > a) cur.push({ text: text.slice(a, j), cls: cls });
            if (j < text.length) { flush(); line++; }
            a = j + 1;
          }
        }
      }
      flush();
    }
    if (res && !res.error && res.mode === 'grid') {
      put(res.rows);
    } else if (res && !res.error && res.mode === 'flow') {
      // flow 结果已含全部忽略选项语义（含忽略换行）：把整篇字符片段按行切分，
      // 左侧标 rm 片段、右侧标 ad 片段，与区域1 流水视图完全一致（不再补算行级 diff，
      // 否则换行/重排差异会被错误地标到 PDF 上）
      putFlow(mapL, res.segsL, 'rm');
      putFlow(mapR, res.segsR, 'ad');
    }
    return { L: mapL, R: mapR };
  }

  /** 把 diff 结果标注到主区域3 的 PDF / Word 面板（先按编辑器 diff 标注，再按需用面板原文校正，见下） */
  function updatePdfAnnotations(res) {
    var maps = buildAnnotMaps(res);
    if (PdfView.setHighlight) {
      PdfView.setHighlight('L', maps.L);
      PdfView.setHighlight('R', maps.R);
    }
    // Word 面板与 PDF 面板共用主区域3（同侧互斥），标注映射同语义、行号坐标系同源（见 DocxView 头注释）
    if (typeof DocxView !== 'undefined' && DocxView.setHighlight) {
      DocxView.setHighlight('L', maps.L);
      DocxView.setHighlight('R', maps.R);
    }
    syncPdfTextAnnotations();
    syncDocxAnnotations();
  }

  // PDF 标注的行号坐标系 = PDF 原文行号。“修整”（或手工编辑）会改变编辑器文本的行号系，
  // 使编辑器 diff 的行号与 PDF 原文错位（修整成 1 行后全部标到 PDF 第 1 行 → 标注失效）。
  // 因此：凡已加载 PDF 且其原文与编辑器当前文本不一致，就用 PDF 原文 + 当前忽略选项另算一份
  // diff（与区域1 同一数据流：grid 行 / flow 片段）覆盖该侧标注；一致时零额外开销。
  var pdfAnnSeq = 0;
  function syncPdfTextAnnotations() {
    if (!PdfView.isLoaded || !PdfView.extractPanel || !PdfView.setHighlight) return;
    var hasL = PdfView.isLoaded('L'), hasR = PdfView.isLoaded('R');
    if (!hasL && !hasR) return;
    var my = ++pdfAnnSeq;
    Promise.all([
      hasL ? PdfView.extractPanel('L') : Promise.resolve(null),
      hasR ? PdfView.extractPanel('R') : Promise.resolve(null)
    ]).then(function (txts) {
      if (my !== pdfAnnSeq) return;                 // 已有更新的标注流程接管
      var tL = txts[0], tR = txts[1];
      refreshPdfCharMap(tL, tR);                    // 先重建 PDF 字符对齐表（无论标注是否需校正）
      var diffL = hasL && tL != null && tL !== editorL.getValue();
      var diffR = hasR && tR != null && tR !== editorR.getValue();
      if (!diffL && !diffR) return;                 // 编辑器即 PDF 原文：现有标注已正确
      var r2 = runLocal({                           // PDF 原文的 diff（同步；文本量与 PDF 相当，可控）
        left: tL == null ? '' : tL,
        right: tR == null ? '' : tR,
        options: readOptions()
      });
      if (my !== pdfAnnSeq || !r2 || r2.error) return;
      var maps = buildAnnotMaps(r2);
      if (diffL) PdfView.setHighlight('L', maps.L);
      if (diffR) PdfView.setHighlight('R', maps.R);
    }).catch(function () { /* 提取失败：保留编辑器 diff 的标注 */ });
  }

  // Word 面板同理，只是"面板原文"由 DocxView（mammoth 提取）提供，坐标系即 mammoth 文本行号：
  // 加载时编辑器文本就等于它，故只有"修整"/手工编辑后才需要重算。DocxView 的标注是同步落 DOM 的，
  // 因此这里重算后直接 setHighlight 即完成重绘。
  var docxAnnSeq = 0;
  function syncDocxAnnotations() {
    if (typeof DocxView === 'undefined' || !DocxView.isLoaded || !DocxView.setHighlight || !DocxView.extractPanel) return;
    var hasL = DocxView.isLoaded('L'), hasR = DocxView.isLoaded('R');
    if (!hasL && !hasR) return;
    var my = ++docxAnnSeq;
    Promise.all([
      hasL ? DocxView.extractPanel('L') : Promise.resolve(null),
      hasR ? DocxView.extractPanel('R') : Promise.resolve(null)
    ]).then(function (txts) {
      if (my !== docxAnnSeq) return;                 // 已有更新的标注流程接管
      var tL = txts[0], tR = txts[1];
      var diffL = hasL && tL != null && tL !== editorL.getValue();
      var diffR = hasR && tR != null && tR !== editorR.getValue();
      if (!diffL && !diffR) return;                  // 编辑器即 Word 原文：现有标注已正确
      var r2 = runLocal({
        left: tL == null ? '' : tL,
        right: tR == null ? '' : tR,
        options: readOptions()
      });
      if (my !== docxAnnSeq || !r2 || r2.error) return;
      var maps = buildAnnotMaps(r2);
      if (diffL) DocxView.setHighlight('L', maps.L);
      if (diffR) DocxView.setHighlight('R', maps.R);
    }).catch(function () { /* 提取失败：保留编辑器 diff 的标注 */ });
  }

  function reportStats(res) {
    if (!res || res.error) { statsEl.textContent = ''; return; }
    if (res.mode === 'flow') {
      var n = (res.addedChars || 0) + (res.removedChars || 0);
      if (n === 0) statsEl.innerHTML = '<span class="ok">内容一致（忽略换行）</span>';
      else statsEl.innerHTML = '修改内容：<span class="bad">增 ' + res.addedChars + '</span> · <span class="bad">删 ' + res.removedChars + '</span> 字符';
      return;
    }
    var s = res.stats;
    var total = s.added + s.removed + s.modified;
    if (total === 0) {
      statsEl.innerHTML = '<span class="ok">内容一致（当前忽略选项下）</span>';
    } else {
      statsEl.innerHTML =
        '修改 <span class="bad">' + s.modified + '</span> · 新增 '
        + '<span class="ok">' + s.added + '</span> · 删除 <span class="bad">' + s.removed + '</span> 行';
    }
  }

  // ---------- 事件 -------
  function scheduleCompare() {
    if (restoring) return;                       // tab 恢复期间 setValue 触发的 change 不发对比
    updatePdfMapMatches();                       // 编辑器文本变化 → PDF 表与编辑区是否仍同文本
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(compare, 400);
  }

  results.addEventListener('click', function (e) {
    var f = e.target.closest('.fold-row');
    if (f) {
      var key = f.getAttribute('data-key');
      if (expanded[key]) delete expanded[key];
      else expanded[key] = true;
      if (lastResult && lastResult.mode === 'grid') rerenderGridKeepScroll();
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
      setTimeout(compare, 0);
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
    setTimeout(compare, 0); // setValue 已触发 change，此处兜底确保重算
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
      compare();
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
    fileSeq.L++; fileSeq.R++;                 // 作废旧侧在途加载，防止其回填覆盖互换结果
    editorL.setValue(tR);
    editorR.setValue(tL);
    if (tidyBefore) { var tb = tidyBefore.left; tidyBefore.left = tidyBefore.right; tidyBefore.right = tb; }
    if (FilterBar.selectFile) { FilterBar.selectFile('L', pR, true); FilterBar.selectFile('R', pL, true); }
    if (PdfView.swap) PdfView.swap();
    if (DocxView.swap) DocxView.swap();
    pdfCharMap = null; updatePdfMapMatches();   // PDF 互换：作废旧字符表，待重算
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
    pdfCharMap = null; updatePdfMapMatches();
    if (FilterBar.setFields) FilterBar.setFields([]);
    toast('已清除');
    compare();
  });

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

  var fileSeq = { L: 0, R: 0 };   // 每侧文件加载令牌：同侧新加载作废旧加载（两侧可并行互不干扰）
  function loadFileToSide(side, absPath) {
    if (!absPath || !Source.fileUrl) return;
    var sw = switchSeq;                        // 快照：tab 切换作废在途加载
    var my = ++fileSeq[side];
    // fileUrl 返回 Promise（Tauri 模式需先经 Rust 读字节转 Blob URL）
    Source.fileUrl(absPath).then(function (url) {
      if (my !== fileSeq[side] || sw !== switchSeq) return;
      if (/\.pdf$/i.test(absPath)) {
      if (DocxView.clear) DocxView.clear(side);  // 与 Word 面板互斥：同侧只保留一种渲染
      // 单次取文档：渲染 + 提词复用同一份，提词成功后立即写编辑器
      var load = PdfView.load(side, url, my);
      if (load && load.then) {
        load.then(function () {
          if (my !== fileSeq[side] || sw !== switchSeq) return;
          return PdfView.extractPanel(side);
        }).then(function (text) {
          if (my !== fileSeq[side] || sw !== switchSeq || !text) return;
          if (FilterBar.setFields) FilterBar.setFields(PdfView.segmentFields ? PdfView.segmentFields(text) : []);
          if (side === 'L') editorL.setValue(text); else editorR.setValue(text);
        }).catch(function (err) {
          if (my === fileSeq[side] && sw === switchSeq) toast('加载 PDF 失败：' + ((err && err.message) || err), true);
        });
      }
      } else if (/\.docx$/i.test(absPath)) {
      if (PdfView.clear) PdfView.clear(side);    // 与 PDF 面板互斥
      fetch(url).then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
        if (my !== fileSeq[side] || sw !== switchSeq) return;
        // 渲染（DocxView.load）与提词（extractText）并行，同一份 ArrayBuffer
        return Promise.all([DocxView.load(side, buf, my), DocxView.extractText(buf)]);
      }).then(function (rs) {
        var text = rs && rs[1];
        if (my !== fileSeq[side] || sw !== switchSeq) return;
        // 登记 Word 原文：docx 面板差异标注的行号坐标系就是它（与编辑器初始文本同一份）。
        // 必须在 setValue 之前登记——编辑器变更随后触发的对比会用新标注覆盖，顺序颠倒会闪回旧标注
        if (DocxView.setSourceText) DocxView.setSourceText(side, text || '');
        if (!text) { updatePdfArea(); return; }
        if (FilterBar.setFields) FilterBar.setFields(PdfView.segmentFields ? PdfView.segmentFields(text) : []);
        if (side === 'L') editorL.setValue(text); else editorR.setValue(text);
        updatePdfArea();                         // docx 已渲染 → 重算主区域3 显隐
      }).catch(function (err) {
        if (my === fileSeq[side] && sw === switchSeq) toast('加载 Word 文档失败：' + ((err && err.message) || err), true);
      });
      } else if (/\.doc$/i.test(absPath)) {
      // 旧版二进制 .doc 不支持（无法可靠解析），明确提示，不显示乱码
      if (PdfView.clear) PdfView.clear(side);
      if (DocxView.clear) DocxView.clear(side);
      updatePdfArea();
      toast('暂不支持旧版 .doc 格式，请先用 Word/WPS 另存为 .docx', true);
      } else {
      fetch(url).then(function (r) { return r.text(); }).then(function (text) {
        if (my !== fileSeq[side] || sw !== switchSeq) return;
        if (side === 'L') editorL.setValue(text); else editorR.setValue(text);
        if (PdfView.clear) PdfView.clear(side);
        if (DocxView.clear) DocxView.clear(side);
        updatePdfArea();                         // 非 PDF 文件：该侧无 PDF → 重算主区域3 显隐
      }).catch(function (err) {
        if (my === fileSeq[side] && sw === switchSeq) toast('读取文件失败：' + ((err && err.message) || err), true);
      });
      }
    }).catch(function (err) {
      if (my === fileSeq[side] && sw === switchSeq) toast('读取文件失败：' + ((err && err.message) || err), true);
    });
  }
  /** 用户切换子文件夹（或加载对比源）后：按当前所选原始/修改文件立即渲染主区域 */
  function onDirChange() {
    var pL = FilterBar.getSelected ? FilterBar.getSelected('L') : '';
    var pR = FilterBar.getSelected ? FilterBar.getSelected('R') : '';
    loadFileToSide('L', pL);
    loadFileToSide('R', pR);
  }
  if (FilterBar.init) {
    FilterBar.init({
      getRoot: getSrcRoot,
      onFileChange: loadFileToSide,
      onFieldPick: function (text) { editorL.setValue(text); },
      onDirChange: onDirChange
    });
  }
  if (PdfView.init) PdfView.init({ left: $('pdfLeft'), right: $('pdfRight') });
  if (typeof DocxView !== 'undefined' && DocxView.init) DocxView.init({ left: $('pdfLeft'), right: $('pdfRight') });
  // 对比源路径输入框：点击弹出文件夹选择
  if (Picker && Picker.init) Picker.init({ input: srcPathInput, onPick: loadSrcPath });

  // ---------- 第一行按钮：隐藏/显示编辑区 + 折叠/展开相同行 ----------
  var foldEnabled = true;
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
    foldEnabled = !foldEnabled;
    foldBtn.textContent = foldEnabled ? '折叠相同行' : '展开相同行';
    if (lastResult && lastResult.mode === 'grid') rerenderGridKeepScroll();
  });

  // ---------- 跨区域协同滚动（主区域1 标注 / 主区域2 编辑 / 主区域3 PDF） ----------
  // 内容锚定：6 个滚动区块统一以“文本行号”为坐标系——区域1 行带 data-ls，编辑区行号即文本行号，
  // PDF 文本项行号与提取文本完全一致。滚动时把驱动区视口顶部换算成锚定行，其余区滚动到同一行；
  // 左右两侧行号经 diff 对齐表互译。页数/字号/版式差异不影响对照；锚信息缺失时降级比例同步。
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
    if (anchorCache.res === lastResult) return anchorCache;
    var l2r = [], r2l = [];
    if (lastResult && !lastResult.error && lastResult.mode === 'grid' && lastResult.rows) {
      for (var i = 0; i < lastResult.rows.length; i++) {
        var r = lastResult.rows[i];
        if (r.li >= 0 && r.ri >= 0) { l2r.push([r.li + 1, r.ri + 1]); r2l.push([r.ri + 1, r.li + 1]); }
      }
    }
    anchorCache = { res: lastResult, l2r: l2r, r2l: r2l };
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
  function pdfPanelAdapter(side) {
    return {
      side: side, space: 'pdf',
      lineAt: function (px) { return PdfView.lineAtOffset ? PdfView.lineAtOffset(side, px) : null; },
      offsetOf: function (line) { return PdfView.lineOffset ? PdfView.lineOffset(side, line) : null; },
      lineH: function (line) { return PdfView.lineHeight ? PdfView.lineHeight(side, line) : null; },
      nextOffset: function (line) { return PdfView.nextLineOffset ? PdfView.nextLineOffset(side, line) : null; }
    };
  }

  // --- 字符级互译（6 区协同的核心）：把“文本行号”先换算成字符偏移，经对齐锚表互译，
  // --- 再换回另一侧的行号+行内比例。比纯行级插值更贴近真实内容，修整/重排后仍对齐。
  // 两张对齐表：
  //   editorCharMap —— 来自对比结果 charAnchors（编辑器文本坐标系，随对比结果刷新）；
  //   pdfCharMap    —— 来自 PDF 原文（PDF 坐标系，修整后 PDF↔PDF 依然用它对得准）。
  var editorCharMap = null;            // { l2r, r2l, texts:{L,R}, lineStarts:{L,R} }
  var pdfCharMap = null;               // 同上，但基于 PDF 原文
  var pdfMapSeq = 0;
  var pdfMapMatchesEditors = false;    // pdfCharMap 与编辑器当前文本一致时，混合跨区（PDF↔编辑）才能用字符级坐标

  /** 文本行号 → 每行起始字符偏移表（1 基行号；文本不含行尾换行的情形也正确） */
  function lineStartsOf(text) {
    var starts = [0], i;
    for (i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
    return starts;
  }
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
  /** 编辑器文本坐标系对齐表（行级+字符级）：随对比结果（lastResult）重建 */
  function refreshEditorCharMap() {
    editorCharMap = null;
    if (!lastResult || lastResult.error || !(lastResult.lineAnchors || lastResult.charAnchors)) return;
    var tl = editorL.getValue(), tr = editorR.getValue();
    editorCharMap = {
      line: lastResult.lineAnchors || null,
      char: lastResult.charAnchors || null,
      texts: { L: tl, R: tr },
      lineStarts: { L: lineStartsOf(tl), R: lineStartsOf(tr) }
    };
  }
  /** 基于 PDF 原文重建对齐表（行级+字符级）。编辑器文本恰为 PDF 原文时复用对比结果表（零额外 diff），否则另算 */
  function refreshPdfCharMap(tL, tR) {
    var my = ++pdfMapSeq;
    pdfCharMap = null;
    if (tL == null || tR == null) return;
    var anchors = null;
    if (lastResult && lastResult.charAnchors && editorL.getValue() === tL && editorR.getValue() === tR) {
      anchors = { line: lastResult.lineAnchors || null, char: lastResult.charAnchors || null };
    } else {
      var r2 = runLocal({ left: tL, right: tR, options: readOptions() });
      if (my !== pdfMapSeq || r2.error) return;
      anchors = { line: r2.lineAnchors || null, char: r2.charAnchors || null };
    }
    if (my !== pdfMapSeq) return;
    pdfCharMap = anchors ? {
      line: anchors.line || null, char: anchors.char || null,
      texts: { L: tL, R: tR },
      lineStarts: { L: lineStartsOf(tL), R: lineStartsOf(tR) }
    } : null;
    updatePdfMapMatches();
  }
  function updatePdfMapMatches() {
    pdfMapMatchesEditors = !!(pdfCharMap && pdfCharMap.texts.L === editorL.getValue()
      && pdfCharMap.texts.R === editorR.getValue());
  }

  function crossTranslate(srcA, oA, e) {
    var from = srcA.side, to = oA.side;
    var srcPdf = srcA.space === 'pdf', tgtPdf = oA.space === 'pdf';
    var r;
    // PDF↔PDF：恒用 PDF 原文表（修整/手工改编辑器后依然对得准 —— 最高优先级）
    if (srcPdf && tgtPdf && pdfCharMap) {
      r = translateWithMap(pdfCharMap, from, to, e);
      if (r != null) return r;
    }
    // 编辑↔编辑：用对比结果表（编辑器文本坐标系）
    if (!srcPdf && !tgtPdf && editorCharMap) {
      r = translateWithMap(editorCharMap, from, to, e);
      if (r != null) return r;
    }
    // 混合（PDF↔编辑）：仅当编辑器文本与 PDF 原文一致时字符级坐标才成立
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
    renderGrid(lastResult);                      // 内部 rebindScrollSync（新元素 + 新适配器）
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
      foldEnabled: foldEnabled, editorsHidden: editorsHidden, tidy: tidyBefore,
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
    foldEnabled = tab.foldEnabled !== false;
    foldBtn.textContent = foldEnabled ? '折叠相同行' : '展开相同行';
    setEditorsHidden(!!tab.editorsHidden);
    tidyBefore = tab.tidy || null;
    setTidyBtnMode(!!tidyBefore);
    expanded = {};
    if (PdfView.setMode) PdfView.setMode(tab.pdfMode || 'auto');
    if (tab.srcRoot) { srcPathInput.value = tab.srcRoot; setSrcPathCur(tab.srcRoot); }
    if (FilterBar.setFields) FilterBar.setFields([]);
    compare(true);                                 // 渲染差异区（恢复发起，不写历史）
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
              // 重渲染已作废该侧旧标注。仅当面板原文正是编辑器当前文本时，lastResult 才是它的对比
              // 结果 → 直接重落；否则交给随后的对比流程重标（免得把别的 tab 的结果画到这份文档上）
              var cur = (sd === 'L' ? editorL.getValue() : editorR.getValue());
              if (text && text === cur && lastResult && !lastResult.error) {
                var m = buildAnnotMaps(lastResult);
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