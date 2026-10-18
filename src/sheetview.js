/**
 * sheetview.js — 主区域3 的 Excel 表格查看器（只读、虚拟滚动、差异涂色）。
 * 与 PdfView / DocxView 平级：同一侧三者互斥，共用 #pdfLeft / #pdfRight 面板容器。
 *
 * 为什么需要它：
 *   主区域1 的三视图回答"哪一行、哪一列变了"；主区域3 回答"这张表长什么样"。
 *   Excel 对比时必须能像看原文件一样扫一眼列宽、合并单元格、底纹——这是判断
 *   "这个改动是不是在正确的位置"的关键，光看差异列表看不出上下文。
 *
 * 虚拟滚动：只渲染视口附近的行（真实 Excel 常见几百到几千行，一次性铺 DOM 会卡）。
 * 行高固定（单行不换行，超出省略），因此偏移量 = 行号 × 行高，无需测量。
 *
 * 全局暴露：SheetView
 *
 * SheetView.init({ left, right })         // 两个面板容器（与 PdfView 共用的那两个）
 * SheetView.load(side, sheetData)         // sheetData = XlsxIO.extractSheet() 的结果
 * SheetView.setDiff(side, marks)          // marks = { rows:{行号:'add'|'mod'|'del'}, cells:{行号:{列名:'add'|'mod'|'del'}} }
 * SheetView.clear(side?)
 * SheetView.isLoaded(side)
 * SheetView.scrollToRow(side, row)        // 三视图点"新 N 行"跳过来
 * SheetView.highlightRow(side, row)       // 短暂高亮，让用户看清跳到了哪
 * SheetView.getSheetName(side)
 */
(function (root) {
  'use strict';

  var ROW_H = 26;            // 每行像素高度（固定，虚拟滚动依赖它）
  var OVERSCAN = 8;          // 视口上下各多渲染的行数
  var HIGHLIGHT_MS = 1600;

  var cfg = { left: null, right: null };
  var panels = { L: null, R: null };   // { data, diffs, scrollEl, bodyEl, ... }

  function init(c) {
    cfg.left = (c && c.left) || null;
    cfg.right = (c && c.right) || null;
  }

  function panelOf(side) { return side === 'L' ? cfg.left : cfg.right; }
  function stateOf(side) { return panelOf(side) ? panels[side] : null; }

  function escHtml(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function isLoaded(side) {
    return !!(panels[side] && panels[side].data);
  }
  function getSheetName(side) {
    return panels[side] && panels[side].data ? panels[side].data.name : '';
  }

  // ---------- 构建 DOM ----------

  function build(side) {
    var host = panelOf(side);
    if (!host) return null;
    var st = panels[side];
    var data = st.data;

    host.innerHTML = '';
    host.classList.add('sv-host');

    var wrap = document.createElement('div');
    wrap.className = 'sv-wrap';

    var scroll = document.createElement('div');
    scroll.className = 'sv-scroll';

    // 表头（固定，不随内容滚动）
    var head = document.createElement('div');
    head.className = 'sv-head';
    head.style.width = totalWidth(data) + 'px';

    // 行容器
    var body = document.createElement('div');
    body.className = 'sv-body';
    body.style.height = (data.rows.length * ROW_H) + 'px';
    body.style.width = totalWidth(data) + 'px';

    var spacer = document.createElement('div');
    spacer.className = 'sv-spacer';

    scroll.appendChild(body);
    wrap.appendChild(head);
    wrap.appendChild(scroll);
    host.appendChild(wrap);

    st.scrollEl = scroll;
    st.bodyEl = body;
    st.headEl = head;

    // 表头内容：行号列 + 数据列
    var hh = '<div class="sv-th sv-th-ln">行</div>';
    for (var c = 0; c < data.headers.length; c++) {
      var w = colWidth(data, c);
      var hidden = (data.meta && data.meta.colHidden && data.meta.colHidden[c]);
      if (hidden) continue;
      hh += '<div class="sv-th" style="width:' + w + 'px" title="' + escHtml(data.headers[c]) + '">' +
        escHtml(data.headers[c]) + '</div>';
    }
    head.innerHTML = hh;

    // 滚动时只重绘可见行
    var rendering = false;
    scroll.addEventListener('scroll', function () {
      if (rendering) return;
      rendering = true;
      var raf = (typeof window !== 'undefined' && window.requestAnimationFrame)
        ? window.requestAnimationFrame : function (fn) { return setTimeout(fn, 16); };
      raf(function () { rendering = false; renderRows(side); });
    });

    // 横向滚动时表头跟随（表头本身不滚动，只平移）
    scroll.addEventListener('scroll', function () {
      head.style.transform = 'translateX(' + (-scroll.scrollLeft) + 'px)';
    });

    renderRows(side);
    return wrap;
  }

  function totalWidth(data) {
    var w = 56;   // 行号列
    for (var c = 0; c < data.headers.length; c++) {
      var hidden = (data.meta && data.meta.colHidden && data.meta.colHidden[c]);
      if (hidden) continue;
      w += colWidth(data, c);
    }
    return Math.max(w, 320);
  }

  /** 列宽：优先用源文件的列宽（按字符数换算成像素），否则按表头名长度估 */
  function colWidth(data, c) {
    var meta = data.meta;
    var w = meta && meta.colWidths ? meta.colWidths[c] : null;
    if (typeof w === 'number' && w > 0) {
      // Excel 列宽单位 ≈ 字符数；1 字符 ≈ 7px（11pt 等宽），加 padding
      return Math.max(56, Math.min(Math.round(w * 7.5 + 12), 420));
    }
    var h = data.headers[c] || '';
    return Math.max(72, Math.min(h.length * 14 + 16, 260));
  }

  /** 可见列索引（跳过隐藏列） */
  function visibleCols(data) {
    var out = [];
    for (var c = 0; c < data.headers.length; c++) {
      var hidden = (data.meta && data.meta.colHidden && data.meta.colHidden[c]);
      if (!hidden) out.push(c);
    }
    return out;
  }

  function renderRows(side) {
    var st = panels[side];
    if (!st || !st.data) return;
    var data = st.data;
    var scroll = st.scrollEl;
    var body = st.bodyEl;
    if (!scroll || !body) return;

    var cols = visibleCols(data);
    var top = scroll.scrollTop || 0;
    var viewH = scroll.clientHeight || 400;
    var first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    var last = Math.min(data.rows.length - 1, Math.ceil((top + viewH) / ROW_H) + OVERSCAN);

    var html = [];
    // 顶部占位：让未渲染部分保持正确高度
    html.push('<div style="height:' + (first * ROW_H) + 'px"></div>');

    var diffRows = (st.diffs && st.diffs.rows) || {};
    var diffCells = (st.diffs && st.diffs.cells) || {};

    for (var i = first; i <= last; i++) {
      var excelRow = data.rowNumbers[i];
      var rowDiff = diffRows[excelRow];
      var cls = 'sv-tr' + (rowDiff ? ' sv-' + rowDiff : '');
      if (st.highlightRow === excelRow) cls += ' sv-hit';
      html.push('<div class="' + cls + '" style="height:' + ROW_H + 'px" data-row="' + excelRow + '">');
      html.push('<div class="sv-td sv-td-ln">' + excelRow + '</div>');
      var cellsOfRow = diffCells[excelRow] || null;
      for (var k = 0; k < cols.length; k++) {
        var c = cols[k];
        var v = data.rows[i][c];
        var w = colWidth(data, c);
        var cellCls = 'sv-td';
        if (cellsOfRow && cellsOfRow[data.headers[c]]) {
          cellCls += ' sv-cell-' + cellsOfRow[data.headers[c]];
        }
        var text = v === null || v === undefined ? '' : String(v);
        html.push('<div class="' + cellCls + '" style="width:' + w + 'px" title="' +
          escHtml(text) + '">' + escHtml(text) + '</div>');
      }
      html.push('</div>');
    }

    // 底部占位
    var rest = data.rows.length - (last + 1);
    if (rest > 0) html.push('<div style="height:' + (rest * ROW_H) + 'px"></div>');

    body.innerHTML = html.join('');
  }

  // ---------- 对外接口 ----------

  function load(side, sheetData) {
    if (!panelOf(side) || !sheetData) return;
    panels[side] = { data: sheetData, diffs: { rows: {}, cells: {} }, highlightRow: null };
    build(side);
  }

  /** marks = { rows:{行号:'add'|'mod'|'del'}, cells:{行号:{列名:kind}} } */
  function setDiff(side, marks) {
    var st = panels[side];
    if (!st) return;
    st.diffs = marks || { rows: {}, cells: {} };
    renderRows(side);
  }

  /**
   * 清空某侧（或全部）。
   * keepHost=true 时保留 sv-host 类：切到"只在一侧存在的 sheet"时，另一侧会被清空，
   * 但面板仍处于表格模式，底色必须是白而不是 PDF 的深灰（否则提示文字压在深底上看不清）。
   */
  function clear(side, keepHost) {
    var sides = side ? [side] : ['L', 'R'];
    for (var i = 0; i < sides.length; i++) {
      var s = sides[i];
      panels[s] = null;
      var host = panelOf(s);
      if (host) {
        host.innerHTML = '';
        if (!keepHost) host.classList.remove('sv-host');
      }
    }
  }

  /** 滚到指定 Excel 行号（三视图跳转）。行号是 1 基绝对行号。 */
  function scrollToRow(side, excelRow) {
    var st = panels[side];
    if (!st || !st.data || !st.scrollEl) return;
    var idx = st.data.rowNumbers.indexOf(excelRow);
    if (idx < 0) return;   // 该行不在数据区（可能落在表头或表头以上）
    // 居中显示：让目标行落在视口中部，而不是贴边
    var viewH = st.scrollEl.clientHeight || 400;
    var target = Math.max(0, idx * ROW_H - Math.floor(viewH / 2) + ROW_H / 2);
    if (st.scrollEl.scrollTo) st.scrollEl.scrollTo({ top: target, behavior: 'smooth' });
    else st.scrollEl.scrollTop = target;
    highlightRow(side, excelRow);
    // 平滑滚动期间多次重绘，保证目标行已渲染出来
    var times = 0;
    var timer = setInterval(function () {
      renderRows(side);
      if (++times > 12) clearInterval(timer);
    }, 60);
  }

  function highlightRow(side, excelRow) {
    var st = panels[side];
    if (!st) return;
    st.highlightRow = excelRow;
    renderRows(side);
    setTimeout(function () {
      if (st.highlightRow === excelRow) {
        st.highlightRow = null;
        renderRows(side);
      }
    }, HIGHLIGHT_MS);
  }

  root.SheetView = {
    init: init,
    load: load,
    setDiff: setDiff,
    clear: clear,
    isLoaded: isLoaded,
    getSheetName: getSheetName,
    scrollToRow: scrollToRow,
    highlightRow: highlightRow,
    // 供测试
    _colWidth: colWidth,
    _totalWidth: totalWidth,
    _visibleCols: visibleCols,
    _ROW_H: ROW_H
  };
})(typeof self !== 'undefined' ? self : this);
