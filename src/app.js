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
  var foldToggle = $('foldToggle');
  var tidyBtn = $('tidyBtn');
  var copyBtn = $('copyUnified');
  var historyBtn = $('historyBtn');
  var historyPanel = $('historyPanel');

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
      arr = arr.slice(0, 10);
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
      if (foldToggle.checked && rows[i].type === 'equal') {
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
    results.innerHTML = '<div class="inline-body">' + html + '</div>';
    reportStats(res);
  }

  function flowHtml(segs) {
    var h = '';
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      var cls = s.cls === 'rm' ? 'rm' : s.cls === 'ad' ? 'ad' : 'eq';
      h += '<span class="hl ' + cls + '">' +
           escHtml(s.text).replace(/(\r\n|\n|\r)/g, '<br>') + '</span>';
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
      '<div class="colhead">原文（忽略换行）<em>变化标红</em></div>' +
      '<div class="colhead">修改后（忽略换行）<em>变化标绿</em></div>' +
      '<div class="grid-body">' + flowHtml(res.segsL) + '</div>' +
      '<div class="grid-body">' + flowHtml(res.segsR) + '</div>' +
      '</div>';
    reportStats({ mode: 'flow', addedChars: res.addedChars, removedChars: res.removedChars });
  }

  function renderResult(res) {
    lastResult = res;
    saveHistoryEntry();
    setBusy(false);
    if (res.error) { results.innerHTML = ''; reportStats(null); return; }
    if (editorL.getValue() === '' && editorR.getValue() === '') {
      results.innerHTML = '<div class="placeholder">在两侧粘贴文本，即可自动开始对比</div>';
      statsEl.innerHTML = '';
      statusEl.textContent = '在两侧粘贴文本即可自动对比';
      return;
    }
    if (res.mode === 'flow') renderFlow(res);
    else if (view === 'inline') renderInline(res);
    else renderGrid(res);
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

  foldToggle.addEventListener('change', function () {
    if (lastResult && lastResult.mode === 'grid') {
      if (view === 'inline') renderInline(lastResult); else renderGrid(lastResult);
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

  tidyBtn.addEventListener('click', function () {
    var changed = false;
    [editorL, editorR].forEach(function (ed) {
      var v = Norm.tidyText(ed.getValue());
      if (v !== ed.getValue()) { ed.setValue(v); changed = true; }
    });
    toast(changed ? '已整理为一行' : '文本无需修整');
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

  // ---------- 初始化 ----------
  editorL = CodeMirror.fromTextArea($('leftEd'), { lineNumbers: true, mode: 'text/plain', lineWrapping: false, autofocus: true });
  editorR = CodeMirror.fromTextArea($('rightEd'), { lineNumbers: true, mode: 'text/plain', lineWrapping: false });
  for (var id in OPT_MAP) $(id).addEventListener('change', scheduleCompare);
  editorL.on('change', scheduleCompare);
  editorR.on('change', scheduleCompare);
  compare();
})();