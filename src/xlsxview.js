/**
 * xlsxview.js — Excel 对比结果渲染（主区域1 的"三视图"）。
 * 只负责把 XlsxCompare 的结果变成 DOM/HTML，状态（当前 sheet、当前视图）由调用方持有。
 * 与 pipeline.js 的文本网格渲染并行存在：文本走 renderGrid，Excel 走这里。
 *
 * 为什么不做左右对照栏：
 *   新增行在旧文件里根本不存在、删除行在新文件里不存在，左右对齐在这个模型上不成立
 *   （aibg 用"拆成 3 个 sheet"绕开了同一问题）。所以改成按差异类型分视图：
 *   全部 / 新增 / 修改 / 删除，每行线性展开"列名 → 旧值 ⇢ 新值"。
 *
 * 全局暴露：XlsxView
 *
 * XlsxView.init({ mount, onJump })    // mount: 结果区容器；onJump(sheet,row,side)
 * XlsxView.render(result, opts) -> void
 *   result = XlsxCompare.compareWorkbook() 的返回值
 *   opts = { sheet, view }               // 当前 sheet 与视图，不传则用内部状态
 * XlsxView.setState({ sheet, view })
 * XlsxView.getState()
 * XlsxView.summaryHtml(result)
 */
(function (root) {
  'use strict';

  var cfg = { mount: null, onJump: null, onSheetChange: null };
  var lastResult = null;
  var state = { sheet: null, view: 'all' };

  /**
   * 单行最多展示多少列。真实报表动辄上百列，全铺出来既看不完也难读。
   * 超出部分折叠成"其余 N 列"提示——用户想看具体某列，可以点"新 N 行"跳到主区域3 的表格里看。
   * 修改行不受此限：它只列真正变化的列，本来就少。
   */
  var MAX_CELLS = 12;

  var VIEWS = [
    { key: 'all', label: '全部' },
    { key: 'added', label: '新增' },
    { key: 'modified', label: '修改' },
    { key: 'deleted', label: '删除' }
  ];

  function init(c) {
    cfg = { mount: null, onJump: null, onSheetChange: null };
    if (c) {
      if (c.mount) cfg.mount = c.mount;
      if (typeof c.onJump === 'function') cfg.onJump = c.onJump;
      if (typeof c.onSheetChange === 'function') cfg.onSheetChange = c.onSheetChange;
    }
  }

  function escHtml(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * 列名显示用的短名。
   * 多行表头会合并成「父 / 子」，但真实报表里父级常是「公共列」这类零信息量的分组名，
   * 109 列全带「公共列 / 」前缀时，界面上看到的就是满屏重复，很难读。
   * 这里把这种"在整表里重复出现、且本身不像列名"的前缀去掉。
   * 判定很保守：只有该前缀在本表出现次数 ≥ 3 次才当成"分组名"剥掉，
   * 避免把「检验结果 / 含量」「检验结果 / 水分」这种有意义的分组也删了。
   */
  function shortName(name, headers) {
    var s = String(name == null ? '' : name);
    var idx = s.indexOf(' / ');
    if (idx < 0) return s;
    var prefix = s.slice(0, idx);
    var count = 0;
    for (var i = 0; i < (headers || []).length; i++) {
      if (String(headers[i]).indexOf(prefix + ' / ') === 0) count++;
    }
    // 重复 ≥3 次的分组名视为无信息量，剥掉；否则保留完整路径
    return count >= 3 ? s.slice(idx + 3) : s;
  }

  /** 单元格值展示：空值显示为灰色占位，避免看起来像"内容丢失" */
  function valHtml(v) {
    var s = v === null || v === undefined ? '' : String(v);
    if (s.trim() === '') return '<span class="xv-empty">（空）</span>';
    return escHtml(s);
  }

  function sheetOf(result, name) {
    if (!result || !result.sheets) return null;
    for (var i = 0; i < result.sheets.length; i++) {
      if (result.sheets[i].sheet === name) return result.sheets[i];
    }
    return null;
  }

  /** 顶部的 sheet 切换条：显示每个 sheet 的差异总数，0 差异的也列出（否则用户以为表丢了） */
  function sheetTabsHtml(result, cur) {
    if (!result || !result.sheets.length) return '';
    var h = '<div class="xv-sheetbar" role="tablist">';
    for (var i = 0; i < result.sheets.length; i++) {
      var r = result.sheets[i];
      var n = r.added.length + r.modified.length + r.deleted.length;
      var cls = 'xv-sheet' + (r.sheet === cur ? ' active' : '') + (n ? '' : ' nodiff');
      var badge = n ? '<span class="xv-badge">' + n + '</span>' : '<span class="xv-badge ok">✓</span>';
      h += '<button type="button" class="' + cls + '" data-sheet="' + escHtml(r.sheet) + '" role="tab">' +
        escHtml(r.sheet) + badge + '</button>';
    }
    h += '</div>';
    return h;
  }

  /** 视图切换条：全部/新增/修改/删除，带数量 */
  function viewTabsHtml(r, cur) {
    if (!r) return '';
    var counts = { all: r.added.length + r.modified.length + r.deleted.length, added: r.added.length, modified: r.modified.length, deleted: r.deleted.length };
    var h = '<div class="xv-viewbar">';
    for (var i = 0; i < VIEWS.length; i++) {
      var v = VIEWS[i];
      var n = counts[v.key];
      var cls = 'xv-view' + (v.key === cur ? ' active' : '') + (n ? '' : ' empty');
      h += '<button type="button" class="' + cls + '" data-view="' + v.key + '">' +
        escHtml(v.label) + ' <span class="xv-count">' + n + '</span></button>';
    }
    h += '</div>';
    return h;
  }

  /** 结构变化提示条：列增删是"表结构"级的差异，放在行列表上方单独说 */
  function structuralHtml(r) {
    var a = r.structural.newColumns || [];
    var d = r.structural.deletedColumns || [];
    if (!a.length && !d.length) return '';
    var h = '<div class="xv-structural">';
    if (a.length) h += '<span class="xv-st-add">新增列：' + escHtml(a.join('、')) + '</span>';
    if (d.length) h += '<span class="xv-st-del">删除列：' + escHtml(d.join('、')) + '</span>';
    h += '</div>';
    return h;
  }

  /** 表头说明：让用户知道"这些行靠什么匹配上的"，以及匹配方式 */
  function modeHtml(r) {
    var mode = r.compareMode === 'key'
      ? '按「' + escHtml((r.keyNames || []).map(function (n) { return shortName(n, r.headers); }).join(' + ')) + '」匹配'
      : '无可用键列，退化为整行哈希比对（只能看出整行新增/删除，判不出改了哪一列）';
    var auto = (r.autoKey && r.autoKey.length) ? '（自动识别）' : '';
    return '<span class="xv-mode">' + mode + auto + '</span>';
  }

  // ---------- 各视图的行渲染 ----------

  /** 新增：列出该行所有非空列 */
  function addedRowHtml(r, item, idx) {
    // 列顺序：先键列（用于认出"这是哪一条记录"），再按原表列序补其余有值的列。
    // 这样即便只显示前 12 列，用户也能一眼知道新增的是哪一条。
    var order = [];
    var keySet = {};
    (r.keyNames || []).forEach(function (k) { keySet[k] = true; order.push(k); });
    for (var i = 0; i < r.headers.length; i++) {
      if (!keySet[r.headers[i]]) order.push(r.headers[i]);
    }

    var cells = [];
    var hidden = 0;
    for (var j = 0; j < order.length; j++) {
      var name = order[j];
      var v = item.cells[name];
      if (v === null || v === undefined || String(v).trim() === '') continue;
      if (cells.length >= MAX_CELLS) { hidden++; continue; }
      var isKey = !!keySet[name];
      cells.push('<span class="xv-cell' + (isKey ? ' xv-cell-key' : '') + '">' +
        '<span class="xv-k">' + escHtml(shortName(name, r.headers)) + '</span>' +
        '<span class="xv-v">' + valHtml(v) + '</span></span>');
    }
    if (hidden > 0) {
      cells.push('<span class="xv-more" title="完整内容请点行号到下方表格查看">…另有 ' + hidden + ' 列未展开</span>');
    }
    return '<div class="xv-row xv-row-add" data-kind="added" data-row="' + item.newRow + '">' +
      '<div class="xv-rowhead">' +
      '<span class="xv-tag add">新增</span>' +
      '<button type="button" class="xv-ln" data-jump="' + item.newRow + '" data-side="R" title="在右侧表格中定位该行">新 ' + item.newRow + ' 行</button>' +
      '</div>' +
      '<div class="xv-cells">' + (cells.join('') || '<span class="xv-empty">（整行空白）</span>') + '</div>' +
      '</div>';
  }

  /** 修改：只列发生变化的列，"旧值 ⇢ 新值" */
  function modifiedRowHtml(r, item) {
    var cells = [];
    var cols = item.changedCols || [];
    for (var i = 0; i < cols.length; i++) {
      var name = cols[i];
      var isDelCol = name.indexOf('旧_') === 0;
      var display = isDelCol ? shortName(name.slice(2), r.headers) + '（列已删除）' : shortName(name, r.headers);
      var oldV = item.oldValues ? item.oldValues[name] : undefined;
      var newV = item.cells ? item.cells[name] : undefined;
      cells.push('<span class="xv-cell xv-changed">' +
        '<span class="xv-k">' + escHtml(display) + '</span>' +
        '<span class="xv-diff">' +
        '<span class="xv-old" title="旧值">' + valHtml(oldV) + '</span>' +
        '<span class="xv-arrow">→</span>' +
        '<span class="xv-new" title="新值">' + valHtml(newV) + '</span>' +
        '</span></span>');
    }
    return '<div class="xv-row xv-row-mod" data-kind="modified" data-row="' + item.newRow + '">' +
      '<div class="xv-rowhead">' +
      '<span class="xv-tag mod">修改</span>' +
      '<button type="button" class="xv-ln" data-jump="' + item.oldRow + '" data-side="L" title="在左侧表格中定位旧行">旧 ' + item.oldRow + ' 行</button>' +
      '<span class="xv-arrow-sep">→</span>' +
      '<button type="button" class="xv-ln" data-jump="' + item.newRow + '" data-side="R" title="在右侧表格中定位新行">新 ' + item.newRow + ' 行</button>' +
      '<span class="xv-changed-count">改了 ' + cols.length + ' 列</span>' +
      '</div>' +
      '<div class="xv-cells">' + (cells.join('') || '<span class="xv-empty">（无可见变化）</span>') + '</div>' +
      '</div>';
  }

  /** 删除：列出该行所有非空列 */
  function deletedRowHtml(r, item) {
    var headers = r.oldHeaders && r.oldHeaders.length ? r.oldHeaders : r.headers;
    var orderDel = [];
    var keySetDel = {};
    (r.keyNames || []).forEach(function (k) { keySetDel[k] = true; orderDel.push(k); });
    for (var i = 0; i < headers.length; i++) {
      if (!keySetDel[headers[i]]) orderDel.push(headers[i]);
    }
    var cells = [];
    var hiddenDel = 0;
    for (var j = 0; j < orderDel.length; j++) {
      var name = orderDel[j];
      var v = item.cells[name];
      if (v === null || v === undefined || String(v).trim() === '') continue;
      if (cells.length >= MAX_CELLS) { hiddenDel++; continue; }
      var isKeyDel = !!keySetDel[name];
      cells.push('<span class="xv-cell' + (isKeyDel ? ' xv-cell-key' : '') + '">' +
        '<span class="xv-k">' + escHtml(shortName(name, headers)) + '</span>' +
        '<span class="xv-v">' + valHtml(v) + '</span></span>');
    }
    if (hiddenDel > 0) {
      cells.push('<span class="xv-more" title="完整内容请点行号到下方表格查看">…另有 ' + hiddenDel + ' 列未展开</span>');
    }
    return '<div class="xv-row xv-row-del" data-kind="deleted" data-row="' + item.oldRow + '">' +
      '<div class="xv-rowhead">' +
      '<span class="xv-tag del">删除</span>' +
      '<button type="button" class="xv-ln" data-jump="' + item.oldRow + '" data-side="L" title="在左侧表格中定位该行">旧 ' + item.oldRow + ' 行</button>' +
      '</div>' +
      '<div class="xv-cells">' + (cells.join('') || '<span class="xv-empty">（整行空白）</span>') + '</div>' +
      '</div>';
  }

  /** 按当前视图组装行列表；「全部」按 新增→修改→删除 分区，每区带小标题 */
  function rowsHtml(r, view) {
    var out = [];
    function section(title, cls, items, fn, emptyText) {
      if (!items.length) {
        if (view === 'all') return;      // 「全部」下空分区直接省略，减少噪音
        out.push('<div class="xv-empty-state">' + emptyText + '</div>');
        return;
      }
      out.push('<div class="xv-section ' + cls + '"><div class="xv-sectionhead">' +
        title + '（' + items.length + '）</div>');
      for (var i = 0; i < items.length; i++) out.push(fn(items[i], i));
      out.push('</div>');
    }
    if (view === 'all' || view === 'added') {
      section('新增行', 'sec-add', r.added, function (it) { return addedRowHtml(r, it); }, '没有新增的行');
    }
    if (view === 'all' || view === 'modified') {
      section('修改行', 'sec-mod', r.modified, function (it) { return modifiedRowHtml(r, it); }, '没有修改的行');
    }
    if (view === 'all' || view === 'deleted') {
      section('删除行', 'sec-del', r.deleted, function (it) { return deletedRowHtml(r, it); }, '没有删除的行');
    }
    if (!out.length) {
      out.push('<div class="xv-empty-state ok">该 Sheet 所选范围内没有差异</div>');
    }
    return out.join('');
  }

  // ---------- 主渲染 ----------

  function render(result, opts) {
    opts = opts || {};
    if (result) lastResult = result;
    if (!cfg.mount) return;
    if (opts.sheet) state.sheet = opts.sheet;
    if (opts.view) state.view = opts.view;

    var res = lastResult;
    if (!res || !res.sheets || !res.sheets.length) {
      cfg.mount.innerHTML = '<div class="xv-empty-state">没有可对比的 Sheet（请检查勾选与表头行配置）</div>';
      return;
    }
    // 当前 sheet 不在结果里（切了文件）→ 回落到第一个
    var cur = state.sheet;
    if (!sheetOf(res, cur)) {
      cur = res.sheets[0].sheet;
      state.sheet = cur;
    }
    var r = sheetOf(res, cur);

    var html = '<div class="xv">';
    html += sheetTabsHtml(res, cur);
    html += viewTabsHtml(r, state.view);
    html += structuralHtml(r);
    html += '<div class="xv-meta">' + modeHtml(r) +
      '<span class="xv-stat">' +
      '<span class="ok-add">+' + r.added.length + '</span> ' +
      '<span class="ok-mod">~' + r.modified.length + '</span> ' +
      '<span class="ok-del">-' + r.deleted.length + '</span>' +
      '</span></div>';
    html += '<div class="xv-rows">' + rowsHtml(r, state.view) + '</div>';
    html += '</div>';

    cfg.mount.innerHTML = html;
    bindEvents();
  }

  function bindEvents() {
    var el = cfg.mount;
    if (!el || !el.querySelectorAll) return;

    var sheetBtns = el.querySelectorAll('.xv-sheet');
    for (var i = 0; i < sheetBtns.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var next = btn.getAttribute('data-sheet');
          if (next === state.sheet) return;      // 点当前 sheet 不重复刷新
          state.sheet = next;
          render(null);
          // 主区域3 显示的是"当前 sheet 的原表"，切 sheet 必须跟着换。
          // 之前只 render 了三视图、没通知外部，用户看到的就是"表格区还是上一个 sheet"。
          if (typeof cfg.onSheetChange === 'function') cfg.onSheetChange(next);
        });
      })(sheetBtns[i]);
    }

    var viewBtns = el.querySelectorAll('.xv-view');
    for (var j = 0; j < viewBtns.length; j++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          state.view = btn.getAttribute('data-view');
          render(null);
        });
      })(viewBtns[j]);
    }

    var jumpBtns = el.querySelectorAll('.xv-ln');
    for (var k = 0; k < jumpBtns.length; k++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var row = parseInt(btn.getAttribute('data-jump'), 10);
          var side = btn.getAttribute('data-side');
          if (typeof cfg.onJump === 'function' && row) cfg.onJump(state.sheet, row, side);
        });
      })(jumpBtns[k]);
    }
  }

  /** 状态栏摘要：多 sheet 时给出总量，单 sheet 时给出分项 */
  function summaryHtml(res) {
    if (!res || !res.summary) return '';
    var s = res.summary;
    var parts = [];
    if (s.added) parts.push('新增 ' + s.added + ' 行');
    if (s.modified) parts.push('修改 ' + s.modified + ' 行');
    if (s.deleted) parts.push('删除 ' + s.deleted + ' 行');
    if (!parts.length) return '所有所选 Sheet 无差异（共比对 ' + s.sheetsCompared + ' 个）';
    return parts.join('，') + '（' + s.sheetsCompared + ' 个 Sheet，' + s.sheetsWithDiff + ' 个有差异）';
  }

  function setState(s) {
    if (!s) return;
    if (s.sheet) state.sheet = s.sheet;
    if (s.view) state.view = s.view;
  }
  function getState() { return { sheet: state.sheet, view: state.view }; }
  function reset() { lastResult = null; state = { sheet: null, view: 'all' }; }

  root.XlsxView = {
    init: init,
    render: render,
    summaryHtml: summaryHtml,
    setState: setState,
    getState: getState,
    reset: reset,
    // 供测试
    _escHtml: escHtml,
    _shortName: shortName,
    _onSheetChange: function (n) { if (typeof cfg.onSheetChange === 'function') cfg.onSheetChange(n); },
    _MAX_CELLS: MAX_CELLS,
    _VIEWS: VIEWS
  };
})(typeof self !== 'undefined' ? self : this);
