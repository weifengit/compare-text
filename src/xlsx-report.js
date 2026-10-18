/**
 * xlsx-report.js — Excel 对比报告生成（移植自 aibg 的 generate_report + apply_formatting_to_report）。
 * 输出一份带源文件格式还原的 .xlsx：格式由 ExcelJS 复制，不依赖任何后端。
 * 全局暴露：XlsxReport
 *
 * XlsxReport.build(result, opts) -> Promise<Uint8Array>
 *   result = XlsxCompare.compareWorkbook() 的返回值
 *   opts = {
 *     oldMeta:  { [sheet]: meta }   旧文件各 sheet 的格式元数据（删除 sheet 用）
 *     newMeta:  { [sheet]: meta }   新文件各 sheet 的格式元数据
 *     oldAbove: { [sheet]: rows }   旧文件的表头以上行
 *     newAbove: { [sheet]: rows }   新文件的表头以上行
 *     title:    string
 *   }
 *
 * 报告结构（与 aibg 一致）：
 *   对比总览 / {sheet}_新增 / {sheet}_修改 / {sheet}_删除 / {sheet}_源表头以上
 *   —— 只输出有差异的 sheet 对应的分表，总览永远输出。
 *
 * 格式还原要点：
 *   列宽、隐藏列、表头样式、行高、冻结窗格全部从源文件元数据复制（纯列级信息，约 16KB/sheet），
 *   因此调用方可以在抽取元数据后立即释放整个源工作簿。
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.XlsxReport = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  function getExcelJS() {
    if (root.ExcelJS) return root.ExcelJS;
    if (typeof require === 'function') {
      try { return require('../lib/exceljs.min.js'); } catch (e) { /* 忽略 */ }
    }
    return null;
  }

  // ---- 配色（与 aibg 的 _PAIR_FILLS / 特殊列配色同源） ----
  var HEADER_FILL = 'FFDDEBF7';      // 普通表头淡蓝
  var SPECIAL_HEADER_FILL = 'FFFFF2CC'; // 特殊列（行号/变化情况）浅黄
  var DEL_DATA_FILL = 'FFFFF0F0';    // 删除 sheet 数据行浅红
  var PAIR_FILLS = ['FFE6F3FF', 'FFE6FFE6', 'FFFFE6E6', 'FFFFF3E6', 'FFF3E6FF', 'FFFFFFE6'];

  var SPECIAL_COLS = ['新文件行号', '旧文件行号', '变化情况'];
  var THIN = { style: 'thin' };

  function border() { return { top: THIN, left: THIN, bottom: THIN, right: THIN }; }
  function fillOf(argb) { return { type: 'pattern', pattern: 'solid', fgColor: { argb: argb } }; }

  /** 安全写入值：ExcelJS 不接受 undefined；超长字符串截断保护 */
  function safeVal(v) {
    if (v === undefined) return '';
    return v;
  }

  /**
   * 把源文件的列级格式套到目标 sheet。
   * meta = { colWidths, colHidden, headerStyles, rowHeights, freeze, merges }
   * colOffset = 目标 sheet 前面多出的列数（如"新文件行号"占 1 列）
   */
  function applyMeta(ws, meta, colOffset, headerRowCount, maxCols) {
    if (!meta) return;
    colOffset = colOffset || 0;
    headerRowCount = headerRowCount || 1;

    // 列宽 / 隐藏：注意 ExcelJS 里 width 恰为默认值 9 时不会写出 <cols>，
    // XlsxIO 抽元数据时已把 9 抬成 9.0001，这里直接写即可。
    var widths = meta.colWidths || [];
    var hidden = meta.colHidden || [];
    // 只写到目标 sheet 实际有的列：源文件可能有 100+ 列，而报告里可能只保留了
    // 变化的几列（如“修改”表只输出改过的列）。超出会使 columnCount 虚高，
    // 用户打开报告会看到尾部一片空列。
    // 不能用 ws.columnCount：一旦 getCell 访问到更右的列它就会被抬高。
    // maxCols 是目标 sheet 的**绝对**列数（含偏移），由调用方按 headers.length 传入。
    var maxCol = maxCols || ws.columnCount || 0;
    for (var i = 0; i < widths.length; i++) {
      var colNo = i + 1 + colOffset;
      if (maxCol && colNo > maxCol) break;
      var col = ws.getColumn(colNo);
      if (typeof widths[i] === 'number' && widths[i] > 0) col.width = widths[i];
      if (hidden[i]) col.hidden = true;
    }

    // 表头样式：同列宽一样受 maxCol 限制，否则按源文件列数写样式会把目标
    // sheet 的列数抬高（例如"修改"表只输出 5 列，却因源有 5 列 + 偏移 3 而被撑到 8 列）。
    var hStyles = meta.headerStyles || [];
    for (var c = 0; c < hStyles.length; c++) {
      if (!hStyles[c]) continue;
      var styleCol = c + 1 + colOffset;
      if (maxCol && styleCol > maxCol) break;
      var cell = ws.getRow(1).getCell(styleCol);
      try { cell.style = hStyles[c]; } catch (e) { /* 样式结构异常时忽略，不影响数据 */ }
    }

    // 行高（按表头行序号映射）
    var heights = meta.rowHeights || {};
    for (var key in heights) {
      if (!Object.prototype.hasOwnProperty.call(heights, key)) continue;
      var r = parseInt(key, 10);
      if (r >= 1 && r <= headerRowCount) {
        try { ws.getRow(r).height = heights[key]; } catch (e) { /* 忽略 */ }
      }
    }

    // 冻结窗格
    if (meta.freeze && meta.freeze.state) {
      try { ws.views = [meta.freeze]; } catch (e) { /* 忽略 */ }
    }
  }

  /** 特殊列样式：行号 / 变化情况 —— 黄底 + 粗体 + 边框 + 居中 */
  function styleSpecialCol(ws, colIndex, numDataRows) {
    var h = ws.getRow(1).getCell(colIndex);
    h.fill = fillOf(SPECIAL_HEADER_FILL);
    h.font = { bold: true, size: 10 };
    h.border = border();
    h.alignment = { horizontal: 'center', vertical: 'center', wrapText: true };
    for (var r = 2; r <= numDataRows + 1; r++) {
      var c = ws.getRow(r).getCell(colIndex);
      c.border = border();
      c.alignment = { horizontal: 'center', vertical: 'center' };
    }
  }

  /** 表头行统一：自动换行 + 居中 + 顶端对齐 */
  function styleHeaderRow(ws, fromCol, toCol) {
    for (var c = fromCol; c <= toCol; c++) {
      var cell = ws.getRow(1).getCell(c);
      cell.alignment = { horizontal: 'center', vertical: 'top', wrapText: true };
    }
  }

  /**
   * 生成 _.新增 分表。
   * 列结构：[新文件行号] + 新文件全部列
   */
  function addAddedSheet(wb, r, meta) {
    if (!r.added.length) return;
    var ws = wb.addWorksheet(trimSheetName(r.sheet + '_新增'));
    var headers = ['新文件行号'].concat(r.headers);
    ws.addRow(headers);
    r.added.forEach(function (item) {
      var row = [item.newRow];
      r.headers.forEach(function (h) { row.push(safeVal(item.cells[h])); });
      ws.addRow(row);
    });
    applyMeta(ws, meta, 1, 1, headers.length);
    styleHeaderRow(ws, 1, headers.length);
    styleSpecialCol(ws, 1, r.added.length);
  }

  /**
   * 生成 _.修改 分表。
   * 列结构：[新文件行号][旧文件行号][变化情况] + 逐列"新值、旧_新值"穿插
   * 只有实际发生变化的列才输出旧值列，保持报告可读（与 aibg 的穿插规则一致）。
   */
  function addModifiedSheet(wb, r, meta) {
    if (!r.modified.length) return;

    // 收集所有出现过的、真正被修改的列（不含结构增删的标记列）
    var changedSet = {};
    r.modified.forEach(function (m) { m.changedCols.forEach(function (c) { changedSet[c] = true; }); });

    // 列顺序：按新表列序，变化列后面紧跟其"旧_xxx"
    var layout = [];   // [{header, kind:'new'|'old', col}]
    r.headers.forEach(function (h) {
      if (!changedSet[h]) return;
      layout.push({ header: h, kind: 'new', col: h });
      layout.push({ header: '旧_' + h, kind: 'old', col: h });
    });
    // 只出现在旧文件、被删除的列：以 旧_xxx 形式补在最后
    var oldOnly = {};
    r.modified.forEach(function (m) {
      m.changedCols.forEach(function (c) {
        if (c.indexOf('旧_') === 0 && !changedSet[c.slice(2)]) oldOnly[c] = true;
      });
    });
    Object.keys(oldOnly).forEach(function (marker) {
      layout.push({ header: marker, kind: 'oldMark', col: marker });
    });

    var ws = wb.addWorksheet(trimSheetName(r.sheet + '_修改'));
    var headers = ['新文件行号', '旧文件行号', '变化情况'].concat(layout.map(function (x) { return x.header; }));
    ws.addRow(headers);

    r.modified.forEach(function (m) {
      var row = [m.newRow, m.oldRow, '修改：' + m.changedCols.filter(function (c) { return c.indexOf('旧_') !== 0; }).join('、')];
      layout.forEach(function (x) {
        if (x.kind === 'new') row.push(safeVal(m.cells[x.col]));
        else if (x.kind === 'old') row.push(safeVal(m.oldValues[x.col]));
        else row.push(safeVal(m.oldValues[x.col]));
      });
      ws.addRow(row);
    });

    applyMeta(ws, meta, 3, 1, headers.length);
    styleHeaderRow(ws, 1, headers.length);
    styleSpecialCol(ws, 1, r.modified.length);
    styleSpecialCol(ws, 2, r.modified.length);
    styleSpecialCol(ws, 3, r.modified.length);

    // 成对的"新/旧"列用同一种浅色底并加宽，方便一眼看出改动
    var pairIdx = 0;
    for (var i = 0; i < layout.length; i += 2) {
      var x1 = layout[i];
      if (!x1 || x1.kind !== 'new') { continue; }
      var x2 = layout[i + 1];
      if (!x2 || x2.kind !== 'old') continue;
      var color = PAIR_FILLS[pairIdx % PAIR_FILLS.length];
      pairIdx++;
      [3 + i + 1, 3 + i + 2].forEach(function (colNo) {
        var hc = ws.getRow(1).getCell(colNo);
        hc.fill = fillOf(color);
        hc.font = { bold: true, size: 10 };
        hc.border = border();
        var w = ws.getColumn(colNo).width;
        ws.getColumn(colNo).width = Math.max((w || 12) * 1.2, 14);
        for (var rr = 2; rr <= r.modified.length + 1; rr++) {
          var cc = ws.getRow(rr).getCell(colNo);
          cc.fill = fillOf(color);
          cc.border = border();
        }
      });
    }
  }

  /**
   * 生成 _.删除 分表。
   * 列结构：[旧文件行号] + 旧文件全部列
   */
  function addDeletedSheet(wb, r, meta) {
    if (!r.deleted.length) return;
    var ws = wb.addWorksheet(trimSheetName(r.sheet + '_删除'));
    var headers = ['旧文件行号'].concat(r.oldHeaders && r.oldHeaders.length ? r.oldHeaders : r.headers);
    ws.addRow(headers);
    var oldHeaders = r.oldHeaders && r.oldHeaders.length ? r.oldHeaders : r.headers;
    r.deleted.forEach(function (item) {
      var row = [item.oldRow];
      oldHeaders.forEach(function (h) { row.push(safeVal(item.cells[h])); });
      ws.addRow(row);
    });
    applyMeta(ws, meta, 1, 1, headers.length);
    styleHeaderRow(ws, 1, headers.length);
    styleSpecialCol(ws, 1, r.deleted.length);
    // 删除行整体浅红底：一眼可辨
    for (var rr = 2; rr <= r.deleted.length + 1; rr++) {
      for (var cc = 2; cc <= headers.length; cc++) {
        ws.getRow(rr).getCell(cc).fill = fillOf(DEL_DATA_FILL);
      }
    }
  }

  /**
   * 源表头以上内容：单独 sheet 保留（标题栏 / 分组行 / 公式行），不混进数据表。
   * 这是与 aibg 的差异——aibg 直接丢弃，导致报告看不出表从哪来。
   */
  function addAboveSheet(wb, sheetName, above, meta) {
    if (!above || !above.length) return;
    var ws = wb.addWorksheet(trimSheetName(sheetName + '_源表头以上'));
    above.forEach(function (row) { ws.addRow(row.map(safeVal)); });
    // 这组行可能不满列（例如只有 A 列有标题），按实际最宽行定列数再套格式
    var maxCol = 0;
    above.forEach(function (row) { if (row.length > maxCol) maxCol = row.length; });
    applyMeta(ws, meta, 0, above.length, maxCol);
    // 表头以上区域内容可能不全，统一加边框提升可读性
    for (var r = 1; r <= above.length; r++) {
      for (var c = 1; c <= maxCol; c++) ws.getRow(r).getCell(c).border = border();
    }
    ws.getRow(1).height = ws.getRow(1).height || 20;
  }

  /** 对比总览：每个 sheet 一行，只列有差异的类别（与 aibg 一致） */
  function addSummarySheet(wb, result, title) {
    var ws = wb.addWorksheet('对比总览');
    var headers = ['Sheet', '类别', '数量', '比较方式', '键列', '结构变化'];
    ws.addRow(headers);

    result.sheets.forEach(function (r) {
      var keyStr = (r.keyNames && r.keyNames.length) ? r.keyNames.join(' + ') : '';
      var mode = r.compareMode === 'key' ? '键值精确比较' : '哈希比较';
      var parts = [];
      if (r.structural.newColumns.length) parts.push('新增列：' + r.structural.newColumns.join('、'));
      if (r.structural.deletedColumns.length) parts.push('删除列：' + r.structural.deletedColumns.join('、'));
      var note = parts.join('；');

      [['新增', r.added.length], ['修改', r.modified.length], ['删除', r.deleted.length]].forEach(function (pair) {
        if (pair[1] > 0) {
          ws.addRow([r.sheet, pair[0], pair[1], mode, keyStr, note]);
        }
      });
    });

    if (ws.rowCount === 1) {
      // 没有任何差异：给一行明确提示，避免总览只剩表头看起来像出错
      ws.addRow(['（全部所选 Sheet 无差异）', '', '', '', '', '']);
    }

    // 有行的类别上色：新增绿 / 修改蓝 / 删除红（与页面三视图配色一致）
    var colorMap = { '新增': 'FFE7F8EE', '修改': 'FFE6F0FF', '删除': 'FFFFEEF0' };
    for (var r = 2; r <= ws.rowCount; r++) {
      var cat = ws.getRow(r).getCell(2).value;
      var color = colorMap[cat];
      if (color) {
        for (var c = 1; c <= headers.length; c++) ws.getRow(r).getCell(c).fill = fillOf(color);
      }
    }

    // 表头样式
    for (var hc = 1; hc <= headers.length; hc++) {
      var cell = ws.getRow(1).getCell(hc);
      cell.fill = fillOf(HEADER_FILL);
      cell.font = { bold: true, size: 10 };
      cell.border = border();
      cell.alignment = { horizontal: 'center', vertical: 'center', wrapText: true };
    }
    ws.getColumn(1).width = 24;
    ws.getColumn(2).width = 10;
    ws.getColumn(3).width = 10;
    ws.getColumn(4).width = 16;
    ws.getColumn(5).width = 22;
    ws.getColumn(6).width = 36;
    return ws;
  }

  /** Excel sheet 名上限 31 字符，且不能含 []:*?/\ */
  function trimSheetName(name) {
    var s = String(name).replace(/[\[\]:*?\/\\]/g, '_');
    if (s.length <= 31) return s;
    // 保留尾部（往往是 _新增/_修改/_删除/_源表头以上 这类区分信息）：
    // 直接截断会把所有分表截成同名 → ExcelJS 会自动改名成 xxx1/xxx2，反而难认。
    var tail = '';
    var m = /_(新增|修改|删除|源表头以上|新|旧)$/.exec(s);
    if (m) tail = m[0];
    var keep = 31 - tail.length;
    if (keep < 1) return s.slice(0, 31);
    return s.slice(0, keep) + tail;
  }

  /**
   * 组装整份报告。
   * 顺序：对比总览 → 各 sheet 源表头以上 → 新增 → 修改 → 删除。
   * 同一 sheet 的 4 类分表连续排列，便于按 sheet 翻阅。
   */
  function build(result, opts) {
    opts = opts || {};
    var ExcelJS = getExcelJS();
    if (!ExcelJS) return Promise.reject(new Error('Excel 生成库未加载（lib/exceljs.min.js 缺失）'));

    var wb = new ExcelJS.Workbook();
    try { wb.creator = 'compare-text'; } catch (e) { /* 忽略 */ }
    try { wb.created = new Date(); } catch (e) { /* 忽略 */ }

    addSummarySheet(wb, result, opts.title);

    var oldMeta = opts.oldMeta || {};
    var newMeta = opts.newMeta || {};
    var oldAbove = opts.oldAbove || {};
    var newAbove = opts.newAbove || {};

    result.sheets.forEach(function (r) {
      // 表头以上：新文件优先（报告默认以"新文件"为视角），旧文件补在删除表旁
      if (newAbove[r.sheet] && newAbove[r.sheet].length) {
        addAboveSheet(wb, r.sheet + '_新', newAbove[r.sheet], newMeta[r.sheet]);
      }
      if (oldAbove[r.sheet] && oldAbove[r.sheet].length) {
        addAboveSheet(wb, r.sheet + '_旧', oldAbove[r.sheet], oldMeta[r.sheet]);
      }
      addAddedSheet(wb, r, newMeta[r.sheet]);
      addModifiedSheet(wb, r, newMeta[r.sheet]);
      addDeletedSheet(wb, r, oldMeta[r.sheet]);
    });

    return wb.xlsx.writeBuffer().then(function (buf) {
      return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    });
  }

  return {
    build: build,
    trimSheetName: trimSheetName,
    // 供测试
    SPECIAL_COLS: SPECIAL_COLS
  };
});
