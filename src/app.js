/**
 * app.js — 界面层：CodeMirror 编辑、选项、渲染（并排/内联/流水）、同步滚动、
 * 折叠相同行、复制 unified diff、历史记录（localStorage）、Worker 编排与降级。
 */
(function () {
  'use strict';

  // ---------- DOM ----------
  function $(id) { return document.getElementById(id); }
  var results = $('results');
  var statusEl = $('status');
  var statsEl = $('stats');
  var viewToggle = $('viewToggle');
  var foldBtn = $('foldBtn');
  var toggleEditorsBtn = $('toggleEditorsBtn');
  var tidyBtn = $('tidyBtn');
  var resizeBar = $('resultsResize');
  var layoutEl = $('layout');
  var vsplitEl = $('vsplit');
  var copyBtn = $('copyUnified');
  var historyBtn = $('historyBtn');
  var historyPanel = $('historyPanel');
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

  // ---------- 状态 ----------
  var OPT_MAP = {
    optIgnoreCase: 'ignoreCase',
    optIgnoreEol: 'ignoreEol',
    optIgnoreWhitespace: 'ignoreWhitespace',
    optIgnoreNewline: 'ignoreNewline',
    optIgnoreWidth: 'ignoreWidth',
    optIgnorePunct: 'ignorePunct'
  };
  var view = 'side';            // 'side' | 'inline'
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
  var SIDEBAR_KEY = 'diffchecker_sidebar';
  var sidebarOpen = true;      // 侧边栏实时状态（不读 classList.contains）
  var sidebarPref = null;      // 持久化的用户偏好；null = 默认展开

  // ---------- 工具 ----------
  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
  function compare() {
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

  function cellHtml(ln, content, cls) {
    return '<div class="row ' + cls + '"><span class="ln">' + ln + '</span><span class="content">' + content + '</span></div>';
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
        leftBody += '<div class="fold-row" data-key="' + r.key + '">' + fb + '</div>';
        rightBody += '<div class="fold-row" data-key="' + r.key + '">' + fb + '</div>';
        continue;
      }
      var lnL = r.li >= 0 ? String(r.li + 1) : '';
      var lnR = r.ri >= 0 ? String(r.ri + 1) : '';
      if (r.type === 'equal') {
        leftBody += cellHtml(lnL, escHtml(L[r.li]), 'same');
        rightBody += cellHtml(lnR, escHtml(R[r.ri]), 'same');
      } else if (r.type === 'change') {
        leftBody += cellHtml(lnL, segsHtml(r.segL), 'change-l');
        rightBody += cellHtml(lnR, segsHtml(r.segR), 'change-r');
      } else if (r.type === 'remove') {
        leftBody += cellHtml(lnL, escHtml(L[r.li]), 'remove');
        rightBody += '<div class="row empty"></div>';
      } else if (r.type === 'add') {
        leftBody += '<div class="row empty"></div>';
        rightBody += cellHtml(lnR, escHtml(R[r.ri]), 'add');
      }
    }
    results.innerHTML =
      '<div class="grid">' +
      '<div class="colhead">原文<em>Original</em></div>' +
      '<div class="colhead">修改后<em>Modified</em></div>' +
      '<div class="grid-body" id="leftBody">' + leftBody + '</div>' +
      '<div class="grid-body" id="rightBody">' + rightBody + '</div>' +
      '</div>';
    syncScroll();
    reportStats(res);
  }

  function renderInline(res) {
    var rowsArr = buildRowsWithFold(res.rows);
    var L = res.leftLines, R = res.rightLines;
    var html = '';
    for (var i = 0; i < rowsArr.length; i++) {
      var r = rowsArr[i];
      if (r.type === 'fold') {
        html += '<div class="irow fold-row" data-key="' + r.key + '"><span class="fold-bar" style="flex:1">▶ ' + r.count + ' ' + FOLD_LABEL + '</span></div>';
        continue;
      }
      if (r.type === 'equal') {
        html += '<div class="irow eq"><span class="isign"> </span><span class="iln">' + (r.li + 1) + '</span><span class="icontent">' + escHtml(L[r.li]) + '</span></div>';
      } else if (r.type === 'change') {
        html += '<div class="irow del"><span class="isign del">-</span><span class="iln">' + (r.li + 1) + '</span><span class="icontent">' + segsHtml(r.segL) + '</span></div>';
        html += '<div class="irow add"><span class="isign add">+</span><span class="iln">' + (r.ri + 1) + '</span><span class="icontent">' + segsHtml(r.segR) + '</span></div>';
      } else if (r.type === 'remove') {
        html += '<div class="irow del"><span class="isign del">-</span><span class="iln">' + (r.li + 1) + '</span><span class="icontent">' + escHtml(L[r.li]) + '</span></div>';
      } else if (r.type === 'add') {
        html += '<div class="irow add"><span class="isign add">+</span><span class="iln">' + (r.ri + 1) + '</span><span class="icontent">' + escHtml(R[r.ri]) + '</span></div>';
      }
    }
    results.innerHTML = '<div class="inline-body" id="inline-body">' + html + '</div>';
    reportStats(res);
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
      h += '<div class="row"><span class="ln">' + r.n + '</span><span class="content">' + inner + '</span></div>';
    }
    return h;
  }

  function renderFlow(res) {
    if (res.skipped) {
      results.innerHTML = '<div class="inline-body" style="padding:20px;color:#666">'
        + '文本过大，忽略换行模式暂无法逐字符对比（' + res.leftLen + ' / ' + res.rightLen + ' 字符）。'
        + '可关闭“忽略换行”后重试。</div>';
      reportStats(null);
      return;
    }
    results.innerHTML =
      '<div class="grid">' +
      '<div class="colhead">原文（忽略换行）<em>按原行号标注</em></div>' +
      '<div class="colhead">修改后（忽略换行）<em>按原行号标注</em></div>' +
      '<div class="grid-body">' + flowRowsHtml(flowLineRows(res.segsL)) + '</div>' +
      '<div class="grid-body">' + flowRowsHtml(flowLineRows(res.segsR)) + '</div>' +
      '</div>';
    reportStats({ mode: 'flow', addedChars: res.addedChars, removedChars: res.removedChars });
  }

  function renderResult(res) {
    lastResult = res;
    saveHistoryEntry();
    setBusy(false);
    if (res.error) { results.innerHTML = ''; reportStats(null); rebindScrollSync(); return; }
    if (editorL.getValue() === '' && editorR.getValue() === '') {
      results.innerHTML = '<div class="placeholder">在两侧粘贴文本，即可自动开始对比</div>';
      statsEl.innerHTML = '';
      statusEl.textContent = '在两侧粘贴文本即可自动对比';
      rebindScrollSync();
      return;
    }
    if (res.mode === 'flow') renderFlow(res);
    else if (view === 'inline') renderInline(res);
    else renderGrid(res);
    rebindScrollSync();
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

  // ---------- 同步滚动 ----------
  function syncScroll() {
    var l = $('leftBody'), rEl = $('rightBody');
    if (!l || !rEl) return;
    var syncing = false;
    function make(a, b) {
      return function () {
        if (syncing) return;
        syncing = true;
        b.scrollTop = a.scrollTop;
        b.scrollLeft = a.scrollLeft;
        syncing = false;
      };
    }
    l.addEventListener('scroll', make(l, rEl));
    rEl.addEventListener('scroll', make(rEl, l));
  }

  // ---------- 事件 -------
  function scheduleCompare() { clearTimeout(debounceTimer); debounceTimer = setTimeout(compare, 400); }

  viewToggle.addEventListener('click', function () {
    view = view === 'side' ? 'inline' : 'side';
    viewToggle.textContent = view === 'side' ? '内联视图' : '并排视图';
    if (lastResult && lastResult.mode === 'grid') {
      if (view === 'inline') renderInline(lastResult);
      else renderGrid(lastResult);
    }
  });

  results.addEventListener('click', function (e) {
    var f = e.target.closest('.fold-row');
    if (f) {
      var key = f.getAttribute('data-key');
      if (expanded[key]) delete expanded[key];
      else expanded[key] = true;
      if (lastResult && lastResult.mode === 'grid') {
        if (view === 'inline') renderInline(lastResult); else renderGrid(lastResult);
      }
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

  copyBtn.addEventListener('click', function () {
    if (!lastResult || !lastResult.unified) {
      toast('当前无差异，或忽略换行模式下暂无 unified 文本', true);
      return;
    }
    var text = lastResult.unified;
    var done = function () { toast('已复制 unified diff'); };
    var fail = function () {
      // 降级：textarea 选中复制
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      toast(ok ? '已复制 unified diff' : '复制失败，请手动选择', !ok);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fail);
    } else fail();
  });

  // ---------- 历史记录 UI ----------
  function pad2(x) { return x < 10 ? '0' + x : '' + x; }
  function renderHistory() {
    var arr = loadHistory();
    var html = arr.length ? '' : '<div class="h-empty">暂无历史记录</div>';
    for (var i = 0; i < arr.length; i++) {
      var it = arr[i];
      var d = new Date(it.ts);
      var time = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' '
                 + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
      var snippet = (it.left || '').replace(/\s+/g, ' ').slice(0, 24);
      html += '<div class="h-item">'
        + '<button class="h-restore" data-i="' + i + '">恢复</button>'
        + '<span class="h-time">' + time + '</span>'
        + '<span class="h-snippet">' + escHtml(snippet) + '</span>'
        + '<button class="h-del" data-i="' + i + '" title="删除">×</button></div>';
    }
    if (arr.length) html += '<button class="h-clear">清空全部</button>';
    historyPanel.innerHTML = html;
  }
  function toggleHistory() {
    var hidden = historyPanel.classList.contains('hidden');
    if (hidden) {
      renderHistory();
      historyPanel.classList.remove('hidden');
    } else {
      historyPanel.classList.add('hidden');
    }
  }
  historyBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleHistory(); });
  document.addEventListener('click', function () { historyPanel.classList.add('hidden'); });
  historyPanel.addEventListener('click', function (e) {
    e.stopPropagation();
    var t = e.target;
    if (t.classList.contains('h-restore')) {
      var it = loadHistory()[+t.getAttribute('data-i')];
      if (!it) return;
      editorL.setValue(it.left || '');
      editorR.setValue(it.right || '');
      applyOptions(it.options || {});
      historyPanel.classList.add('hidden');
      compare();
    } else if (t.classList.contains('h-del')) {
      var arr = loadHistory();
      arr.splice(+t.getAttribute('data-i'), 1);
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(arr)); } catch (e2) {}
      renderHistory();
    } else if (t.classList.contains('h-clear')) {
      try { localStorage.removeItem(HISTORY_KEY); } catch (e2) {}
      renderHistory();
    }
  });

  // ---------- 标注区域高度可调 ----------
  function clampResizeH(h) { return Math.max(110, Math.min(640, h)); }
  function onResizeMove(ev) {
    if (!resizeState) return;
    var y = ev.touches ? ev.touches[0].clientY : ev.clientY;
    results.style.height = clampResizeH(resizeState.base + (y - resizeState.y)) + 'px';
  }
  function onResizeUp() {
    if (!resizeState) return;
    document.removeEventListener('mousemove', onResizeMove);
    document.removeEventListener('mouseup', onResizeUp);
    document.removeEventListener('touchmove', onResizeMove);
    document.removeEventListener('touchend', onResizeUp);
    try { localStorage.setItem(RESIZE_KEY, results.style.height); } catch (e) {}
    resizeState = null;
  }
  function beginResize(startY) {
    resizeState = { y: startY, base: results.offsetHeight || 280 };
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

  // ---------- 清除 ----------
  clearBtn.addEventListener('click', function () {
    editorL.setValue('');
    editorR.setValue('');
    tidyBefore = null;
    setTidyBtnMode(false);
    if (PdfView.clear) PdfView.clear();
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
  }
  pdfFullscreen.addEventListener('click', function () { setPdfFocus(!pdfFocus); });

  // ---------- 对比源：侧边栏路径 + 顶部筛选区 + PDF 面板 ----------
  var SRCPATH_KEY = 'diffchecker_srcpath';
  function getSrcRoot() { return srcPathInput.value.trim(); }
  function setSrcPathCur(txt) { srcPathCur.textContent = txt; }
  function loadSrcPath(p) {
    p = (p || '').trim();
    if (!p) { toast('请输入对比源路径', true); return; }
    setSrcPathCur(p);
    try { localStorage.setItem(SRCPATH_KEY, p); } catch (e) {}
    if (FilterBar.reload) FilterBar.reload();
  }
  srcLoadBtn.addEventListener('click', function () { loadSrcPath(getSrcRoot()); });
  srcPathInput.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); loadSrcPath(getSrcRoot()); }
  });
  try {
    var savedSrc = localStorage.getItem(SRCPATH_KEY);
    if (savedSrc) { srcPathInput.value = savedSrc; setSrcPathCur(savedSrc); }
  } catch (e) {}

  function loadFileToSide(side, absPath) {
    if (!absPath || !Source.fileUrl) return;
    var url = Source.fileUrl(absPath);
    if (PdfView.load) PdfView.load(side, url).catch(function () {});
    if (PdfView.extractText) {
      PdfView.extractText(url).then(function (text) {
        if (FilterBar.setFields) FilterBar.setFields(PdfView.segmentFields ? PdfView.segmentFields(text) : []);
        if (side === 'L') editorL.setValue(text);
        else editorR.setValue(text);
      }).catch(function () {});
    }
  }
  if (FilterBar.init) {
    FilterBar.init({
      getRoot: getSrcRoot,
      onFileChange: loadFileToSide,
      onFieldPick: function (text) { editorL.setValue(text); }
    });
  }
  if (PdfView.init) PdfView.init({ left: $('pdfLeft'), right: $('pdfRight') });

  // ---------- 第一行按钮：隐藏/显示编辑区 + 折叠/展开相同行 ----------
  var foldEnabled = true;
  var editorsHidden = false;
  function setEditorsHidden(h) {
    editorsHidden = h;
    editorsEl.classList.toggle('hidden', h);
    editorsResize.classList.toggle('hidden', h);
    toggleEditorsBtn.textContent = h ? '显示编辑区' : '隐藏编辑区';
    queueCmRefresh();
  }
  toggleEditorsBtn.addEventListener('click', function () { setEditorsHidden(!editorsHidden); });
  foldBtn.addEventListener('click', function () {
    foldEnabled = !foldEnabled;
    foldBtn.textContent = foldEnabled ? '折叠相同行' : '展开相同行';
    if (lastResult && lastResult.mode === 'grid') {
      if (view === 'inline') renderInline(lastResult); else renderGrid(lastResult);
    }
  });

  // ---------- 跨区域协同滚动（主区域1 标注 / 主区域2 编辑 / 主区域3 PDF） ----------
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
  function rebindScrollSync() {
    if (SyncScroll && SyncScroll.rebind) SyncScroll.rebind(currentScrollers());
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
    window.addEventListener('resize', refreshSidebarForViewport);
  }

  // ---------- 初始化 ----------
  editorL = CodeMirror.fromTextArea($('leftEd'), { lineNumbers: true, mode: 'text/plain', lineWrapping: true, autofocus: true });
  editorR = CodeMirror.fromTextArea($('rightEd'), { lineNumbers: true, mode: 'text/plain', lineWrapping: true });
  for (var id in OPT_MAP) $(id).addEventListener('change', scheduleCompare);
  editorL.on('change', scheduleCompare);
  editorR.on('change', scheduleCompare);
  setTidyBtnMode(false);
  compare();
})();