/**
 * xlsx-compare.js — Excel 对比算法（移植自 aibg 的 utils_excel_compare.py，纯逻辑、无 DOM）。
 * 依赖 xlsx-io.js 抽取出的纯文本行列，不接触 ExcelJS。
 * 全局暴露：XlsxCompare
 *
 * 设计要点（与 aibg 保持一致的地方）：
 *   - 键列匹配优先：勾选键列（可多列拼复合键）→ 按行匹配；未指定则自动检测常见批号列；
 *     都不可用时退化为整行哈希比对（只能判新增/删除，判不出修改）。
 *   - 宽松取值比较 valuesEqual：日期跨类型、浮点容差、'0'/0/0.0 等价，避免格式差异误报。
 *   - 只比较两文件共有的列；结构变化（新增列/删除列）单独记录并在报告里注明。
 *
 * 与 aibg 的差异：
 *   - 多行表头已在上游 XlsxIO.extractSheet 合并为 "父 / 子" 列名，这里只按最终列名工作。
 *   - 结果结构改为行列索引（不再用 DataFrame），便于前端直接渲染与跳转。
 *
 * XlsxCompare.compareSheet(oldSheet, newSheet, opts) -> {
 *   sheet, headers,
 *   added:    [{ newRow, cells:{} }],
 *   modified: [{ newRow, oldRow, cells:{col:newVal}, oldValues:{col:oldVal}, changedCols:[col] }],
 *   deleted:  [{ oldRow, cells:{} }],
 *   structural: { newColumns:[], deletedColumns:[] },
 *   autoKey: [col...] | null,
 *   compareMode: 'key' | 'hash'
 * }
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.XlsxCompare = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 自动检测键列时的候选列名（与 aibg 一致，顺序即优先级） */
  var KEY_CANDIDATES = ['提取物批号', '批号', 'ID', 'id', '编号', '序号', 'code'];

  /** 复合键拼接符（与 aibg 相同，出现在列名里也不会与普通值混淆的概率足够低） */
  var COMPOSITE_SEP = ' ||| ';

  /** 空值判定：null / undefined / 空串 / 'nan' 'none' 'null' 'nat'（不区分大小写） */
  function isBlank(v) {
    if (v === null || v === undefined) return true;
    var s = String(v).trim();
    if (s === '') return true;
    var low = s.toLowerCase();
    return low === 'nan' || low === 'none' || low === 'null' || low === 'nat';
  }

  /**
   * 宽松相等：忽略数值格式差异、日期跨类型差异、首尾空白。
   * 这是"不误报"的核心——ExcelJS 读出来的日期是 Date，另一侧可能是字符串 '2024-05-01'。
   */
  function valuesEqual(a, b) {
    var ba = isBlank(a), bb = isBlank(b);
    if (ba && bb) return true;
    if (ba || bb) return false;

    // 日期：统一成 YYYY-MM-DD[ HH:MM[:SS]] 再比；只有时/分/秒全为 0 时退化为纯日期比
    var da = toDateKey(a), db = toDateKey(b);
    if (da && db) return da === db;
    // 一侧是日期、另一侧是能解析成日期的字符串时，上面已覆盖；一侧是日期另一侧是数字则继续往下走

    // 数值：两端都能转成有限数字时按容差比（0 vs 0.0 vs '0'）
    var na = toNumber(a), nb = toNumber(b);
    if (na !== null && nb !== null) {
      if (na === nb) return true;
      var scale = Math.max(Math.abs(na), Math.abs(nb));
      var eps = Math.max(1e-9, scale * 1e-12);
      return Math.abs(na - nb) < eps;
    }

    return String(a).trim() === String(b).trim();
  }

  /** 转成可比较的日期键；不是日期返回 null */
  function toDateKey(v) {
    if (v instanceof Date) {
      return isNaN(v.getTime()) ? null : dateKeyOf(v);
    }
    if (typeof v === 'string') {
      var s = v.trim();
      // 只接受明显的日期写法，避免把 '123' 这类数字当成日期
      if (!/^\d{4}[-/]\d{1,2}[-/]\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2})?)?$/.test(s)) return null;
      var m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
      if (!m) return null;
      var hh = m[4] ? +m[4] : 0, mm = m[5] ? +m[5] : 0, ss = m[6] ? +m[6] : 0;
      var t = Date.UTC(+m[1], +m[2] - 1, +m[3], hh, mm, ss);
      if (isNaN(t)) return null;
      return dateKeyOf(new Date(t));
    }
    return null;
  }

  /** Date → 归一化键：无时间部分则只到日 */
  function dateKeyOf(d) {
    var p = function (x) { return x < 10 ? '0' + x : '' + x; };
    var y = d.getUTCFullYear(), mo = d.getUTCMonth() + 1, da = d.getUTCDate();
    var hh = d.getUTCHours(), mi = d.getUTCMinutes(), se = d.getUTCSeconds();
    var base = y + '-' + p(mo) + '-' + p(da);
    if (hh || mi || se) return base + ' ' + p(hh) + ':' + p(mi) + ':' + p(se);
    return base;
  }

  /** 转成有限数字；不可转返回 null */
  function toNumber(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v !== 'string') return null;
    var s = v.trim();
    if (s === '') return null;
    // 排除带单位的（'98.5%'、'1,234.5' 也不按数值宽松比较，交给字符串比）
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
    var n = parseFloat(s);
    return isFinite(n) ? n : null;
  }

  /** 自动检测键列：两表共有的候选列里取第一个 */
  function detectKeyColumn(oldHeaders, newHeaders) {
    var set = {};
    (newHeaders || []).forEach(function (h) { set[h] = true; });
    // 第一轮：列名与候选词完全一致（单行表头的常态）
    for (var i = 0; i < KEY_CANDIDATES.length; i++) {
      var c = KEY_CANDIDATES[i];
      if (set[c] && (oldHeaders || []).indexOf(c) >= 0) return c;
    }
    // 第二轮：多行表头合并后列名形如「公共列 / 提取物批号」——
    // 末段才是真正的列名，按末段再匹配一次，否则多行表头的表永远识别不出键列。
    for (var j = 0; j < KEY_CANDIDATES.length; j++) {
      var cand = KEY_CANDIDATES[j];
      var found = null;
      (newHeaders || []).forEach(function (h) {
        if (found) return;
        var tail = headerTail(h);
        if (tail === cand && (oldHeaders || []).indexOf(h) >= 0) found = h;
      });
      if (found) return found;
    }
    return null;
  }

  /** 多行表头合并名的末段（「公共列 / 提取物批号」→「提取物批号」） */
  function headerTail(h) {
    var s = String(h || '');
    var i = s.lastIndexOf(' / ');
    return i >= 0 ? s.slice(i + 3) : s;
  }

  /** 取多列拼成复合键 */
  function makeKey(row, idxs) {
    if (idxs.length === 1) {
      var v = row[idxs[0]];
      return v === null || v === undefined ? '' : String(v);
    }
    var parts = [];
    for (var i = 0; i < idxs.length; i++) {
      var x = row[idxs[i]];
      parts.push(x === null || x === undefined ? '' : String(x));
    }
    return parts.join(COMPOSITE_SEP);
  }

  /** 整行哈希（无键列时的退化模式） */
  function rowHash(row, idxs) {
    var parts = [];
    for (var i = 0; i < idxs.length; i++) {
      var v = row[idxs[i]];
      parts.push(v === null || v === undefined ? '' : String(v).trim());
    }
    // 简单 FNV-1a，避免为了一个哈希引入依赖
    var h = 0x811c9dc5;
    var s = parts.join('\u0001');
    for (var k = 0; k < s.length; k++) {
      h ^= s.charCodeAt(k);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16);
  }

  /**
   * 对比两张已抽取的工作表。
   * opts = {
   *   keyColumns: [列名...]   // 空数组表示自动检测；显式给出则严格使用
   *   compareMode: 'loose'|'strict'   // loose 用 valuesEqual；strict 用字符串严格比
   * }
   */
  function compareSheet(oldSheet, newSheet, opts) {
    opts = opts || {};
    var oldHeaders = (oldSheet && oldSheet.headers) || [];
    var newHeaders = (newSheet && newSheet.headers) || [];
    var oldRows = (oldSheet && oldSheet.rows) || [];
    var newRows = (newSheet && newSheet.rows) || [];
    var oldNums = (oldSheet && oldSheet.rowNumbers) || [];
    var newNums = (newSheet && newSheet.rowNumbers) || [];

    // ---- 结构变化：按列名比对（保持新表列序） ----
    var oldSet = {};
    oldHeaders.forEach(function (h) { oldSet[h] = true; });
    var newSet = {};
    newHeaders.forEach(function (h) { newSet[h] = true; });
    var newColumns = newHeaders.filter(function (h) { return !oldSet[h]; });
    var deletedColumns = oldHeaders.filter(function (h) { return !newSet[h]; });
    var commonColumns = newHeaders.filter(function (h) { return oldSet[h]; });
    var structural = { newColumns: newColumns, deletedColumns: deletedColumns, commonColumns: commonColumns };

    // 统一列名 → 两侧列索引（缺列记 -1）
    function indexOf(headers, name) { return headers.indexOf(name); }

    // ---- 决定键列 ----
    var keyNames = [];
    var explicit = opts.keyColumns && opts.keyColumns.length;
    if (explicit) {
      // 显式指定的键列必须在两侧都存在，否则该键失效（降级到自动检测）
      var valid = opts.keyColumns.filter(function (c) {
        return indexOf(oldHeaders, c) >= 0 && indexOf(newHeaders, c) >= 0;
      });
      if (valid.length) keyNames = valid;
    }
    var autoKey = null;
    if (!keyNames.length) {
      var det = detectKeyColumn(oldHeaders, newHeaders);
      if (det) { keyNames = [det]; autoKey = [det]; }
    }

    var compareMode = opts.compareMode === 'strict' ? 'strict' : 'loose';
    function same(a, b) {
      if (compareMode === 'strict') {
        return String(a === null || a === undefined ? '' : a).trim() ===
               String(b === null || b === undefined ? '' : b).trim();
      }
      return valuesEqual(a, b);
    }

    if (keyNames.length) {
      return compareByKey();
    }
    return compareByHash();

    // ---------- 键匹配 ----------
    function compareByKey() {
      var oldKeyIdx = keyNames.map(function (c) { return indexOf(oldHeaders, c); });
      var newKeyIdx = keyNames.map(function (c) { return indexOf(newHeaders, c); });

      var oldMap = Object.create(null);
      for (var i = 0; i < oldRows.length; i++) {
        var k = makeKey(oldRows[i], oldKeyIdx);
        if (isBlank(k)) continue;                 // 空键行不参与匹配（与 aibg 一致）
        // 重复键：保留首次出现（Excel 里重复批号应属数据问题，报告按第一行算）
        if (oldMap[k] === undefined) oldMap[k] = i;
      }
      var newMap = Object.create(null);
      for (var j = 0; j < newRows.length; j++) {
        var k2 = makeKey(newRows[j], newKeyIdx);
        if (isBlank(k2)) continue;
        if (newMap[k2] === undefined) newMap[k2] = j;
      }

      // 共同列在新/旧表里的下标
      var pairs = commonColumns.map(function (c) {
        return { name: c, ni: indexOf(newHeaders, c), oi: indexOf(oldHeaders, c) };
      });

      var added = [];
      var modified = [];
      var deleted = [];

      // 新增 / 修改（按新表行序）
      for (var nr = 0; nr < newRows.length; nr++) {
        var nk = makeKey(newRows[nr], newKeyIdx);
        if (isBlank(nk)) continue;
        var oi = oldMap[nk];
        if (oi === undefined) {
          // 整行全空的新增行不算新增（与 aibg 一致）
          if (!rowAllBlank(newRows[nr])) {
            added.push({ newRow: newNums[nr] || (nr + 1), cells: cellsObj(newRows[nr], newHeaders) });
          }
          continue;
        }
        var oldRow = oldRows[oi];
        var changedCols = [], cellsM = {}, oldValues = {};
        for (var p = 0; p < pairs.length; p++) {
          var pr = pairs[p];
          var nv = newRows[nr][pr.ni];
          var ov = oldRow[pr.oi];
          if (!same(ov, nv)) {
            changedCols.push(pr.name);
            cellsM[pr.name] = nv;
            oldValues[pr.name] = ov;
          }
        }
        // 新增列：该行有值时也算这行"有变化"
        for (var nc = 0; nc < newColumns.length; nc++) {
          var colName = newColumns[nc];
          var val = newRows[nr][indexOf(newHeaders, colName)];
          if (!isBlank(val)) {
            if (changedCols.indexOf(colName) < 0) changedCols.push(colName);
            cellsM[colName] = val;
          }
        }
        // 删除列：旧文件里有值 → 也要提示（否则用户看不出列没了）
        for (var dc = 0; dc < deletedColumns.length; dc++) {
          var dcol = deletedColumns[dc];
          var oval = oldRow[indexOf(oldHeaders, dcol)];
          if (!isBlank(oval)) {
            var marker = '旧_' + dcol;
            if (changedCols.indexOf(marker) < 0) changedCols.push(marker);
            cellsM[marker] = '';
            oldValues[marker] = oval;
          }
        }
        if (changedCols.length) {
          modified.push({
            newRow: newNums[nr] || (nr + 1),
            oldRow: oldNums[oi] || (oi + 1),
            cells: cellsM,
            oldValues: oldValues,
            changedCols: changedCols,
            allCells: cellsObj(newRows[nr], newHeaders),
            allOldCells: cellsObj(oldRow, oldHeaders)
          });
        }
      }

      // 删除（按旧表行序）
      for (var orow = 0; orow < oldRows.length; orow++) {
        var ok = makeKey(oldRows[orow], oldKeyIdx);
        if (isBlank(ok)) continue;
        if (newMap[ok] === undefined && !rowAllBlank(oldRows[orow])) {
          deleted.push({ oldRow: oldNums[orow] || (orow + 1), cells: cellsObj(oldRows[orow], oldHeaders) });
        }
      }

      return {
        sheet: (newSheet && newSheet.name) || (oldSheet && oldSheet.name) || '',
        headers: newHeaders,
        oldHeaders: oldHeaders,
        added: added,
        modified: modified,
        deleted: deleted,
        structural: structural,
        autoKey: autoKey,
        keyNames: keyNames,
        compareMode: 'key'
      };
    }

    // ---------- 哈希退化模式 ----------
    function compareByHash() {
      var idxsNew = newHeaders.map(function (_, i) { return i; });
      var idxsOld = oldHeaders.map(function (_, i) { return i; });

      var oldHashes = Object.create(null);
      for (var i = 0; i < oldRows.length; i++) {
        if (rowAllBlank(oldRows[i])) continue;
        var h = rowHash(oldRows[i], idxsOld);
        if (oldHashes[h] === undefined) oldHashes[h] = i;
      }
      var newHashes = Object.create(null);
      for (var j = 0; j < newRows.length; j++) {
        if (rowAllBlank(newRows[j])) continue;
        var h2 = rowHash(newRows[j], idxsNew);
        if (newHashes[h2] === undefined) newHashes[h2] = j;
      }

      var added = [], deleted = [];
      for (var nr = 0; nr < newRows.length; nr++) {
        if (rowAllBlank(newRows[nr])) continue;
        if (oldHashes[rowHash(newRows[nr], idxsNew)] === undefined) {
          added.push({ newRow: newNums[nr] || (nr + 1), cells: cellsObj(newRows[nr], newHeaders) });
        }
      }
      for (var orow = 0; orow < oldRows.length; orow++) {
        if (rowAllBlank(oldRows[orow])) continue;
        if (newHashes[rowHash(oldRows[orow], idxsOld)] === undefined) {
          deleted.push({ oldRow: oldNums[orow] || (orow + 1), cells: cellsObj(oldRows[orow], oldHeaders) });
        }
      }
      return {
        sheet: (newSheet && newSheet.name) || (oldSheet && oldSheet.name) || '',
        headers: newHeaders,
        oldHeaders: oldHeaders,
        added: added,
        modified: [],       // 哈希模式判不出"改了哪一列"
        deleted: deleted,
        structural: structural,
        autoKey: null,
        keyNames: [],
        compareMode: 'hash'
      };
    }

    function rowAllBlank(row) {
      for (var i = 0; i < row.length; i++) if (!isBlank(row[i])) return false;
      return true;
    }
    function cellsObj(row, headers) {
      var o = {};
      for (var i = 0; i < headers.length && i < row.length; i++) o[headers[i]] = row[i];
      return o;
    }
  }

  /**
   * 多 sheet 对比编排：配置里勾选的 sheet 才比；只在一侧存在的 sheet 单独标注。
   * cfg = { [sheetName]: { enabled, headerStart, headerEnd, keyColumns } }
   * 返回 { sheets:[compareSheet 结果], summary:{...}, missing:{onlyOld:[], onlyNew:[]} }
   */
  function compareWorkbook(oldBook, newBook, cfg) {
    cfg = cfg || {};
    var oldNames = (oldBook && oldBook.sheetNames) || [];
    var newNames = (newBook && newBook.sheetNames) || [];

    // 所有涉及到的 sheet 名（并集，保持新文件顺序在前）
    var all = newNames.slice();
    oldNames.forEach(function (n) { if (all.indexOf(n) < 0) all.push(n); });

    var results = [];
    var onlyOld = [], onlyNew = [];

    all.forEach(function (name) {
      var c = cfg[name] || {};
      // 明确 enabled === false 才跳过；未配置的 sheet 默认参与（与 aibg 一致）
      if (c.enabled === false) return;
      var inOld = oldNames.indexOf(name) >= 0;
      var inNew = newNames.indexOf(name) >= 0;

      var headerStart = resolveHeaderStart(c);
      var headerEnd = resolveHeaderEnd(c, headerStart);
      var opts = { keyColumns: c.keyColumns || [], compareMode: c.compareMode };

      // 只在一侧存在：整表视为全新增 / 全删除
      if (!inOld && inNew) {
        onlyNew.push(name);
        var nsOnly = extract(newBook, name, headerStart, headerEnd);
        results.push(compareSheet(emptySheet(name), nsOnly, opts));
        return;
      }
      if (inOld && !inNew) {
        onlyOld.push(name);
        var osOnly = extract(oldBook, name, headerStart, headerEnd);
        results.push(compareSheet(osOnly, emptySheet(name), opts));
        return;
      }

      var os = extract(oldBook, name, headerStart, headerEnd);
      var ns = extract(newBook, name, headerStart, headerEnd);
      results.push(compareSheet(os, ns, opts));
    });

    // 顶层汇总
    var totals = { added: 0, modified: 0, deleted: 0, sheetsWithDiff: 0, sheetsCompared: results.length };
    results.forEach(function (r) {
      totals.added += r.added.length;
      totals.modified += r.modified.length;
      totals.deleted += r.deleted.length;
      if (r.added.length || r.modified.length || r.deleted.length) totals.sheetsWithDiff++;
    });

    return { sheets: results, summary: totals, missing: { onlyOld: onlyOld, onlyNew: onlyNew } };
  }

  function extract(book, name, headerStart, headerEnd) {
    if (!book || !book.sheet) return emptySheet(name);
    var ws = book.sheet(name);
    if (!ws) return emptySheet(name);
    // XlsxIO 由调用方注入到 book 上（避免本模块直接依赖它）
    if (typeof book._extract === 'function') return book._extract(name, headerStart, headerEnd);
    return emptySheet(name);
  }

  function emptySheet(name) {
    return { name: name, headers: [], oldHeaders: [], rows: [], rowNumbers: [], above: [], meta: null };
  }

  /** 表头起始行：优先 headerStart（1 基），兼容旧配置 headerRow（0 基）；默认 1 */
  function resolveHeaderStart(c) {
    if (c.headerStart != null) {
      var hs = parseInt(c.headerStart, 10);
      if (hs >= 1) return hs;
    }
    if (c.headerRow != null) {
      var hr = parseInt(c.headerRow, 10);
      if (hr >= 0) return hr + 1;      // 旧配置是 0 基，转 1 基
    }
    return 1;
  }

  /** 表头结束行：不早于起始行，默认等于起始行（单行表头） */
  function resolveHeaderEnd(c, headerStart) {
    var he = c.headerEnd != null ? parseInt(c.headerEnd, 10) : NaN;
    if (!(he >= headerStart)) return headerStart;
    return he;
  }
  return {
    compareSheet: compareSheet,
    compareWorkbook: compareWorkbook,
    valuesEqual: valuesEqual,
    detectKeyColumn: detectKeyColumn,
    isBlank: isBlank,
    KEY_CANDIDATES: KEY_CANDIDATES,
    COMPOSITE_SEP: COMPOSITE_SEP
  };
});
