/**
 * xlsx-io.js — Excel(.xlsx) 读取层：definedNames 预清洗 + 工作表值/格式抽取。
 * 纯逻辑，无 DOM；浏览器 / Worker / Node 三处共用。
 * 依赖全局 JSZip（lib/jszip.min.js）与 ExcelJS（lib/exceljs.min.js）。
 * 全局暴露：XlsxIO
 *
 * 为什么需要预清洗（core 中的血泪教训）：
 *   WPS/Excel 保存自动筛选时，会把 _FilterDatabase 定义名写成整张表的最大范围，
 *   例如 `生产数据收集表!$A$2:$XFC$2025` —— 16384 列 × 2025 行 ≈ 3300 万单元格。
 *   ExcelJS 解析这个定义名时会按区域大小分配内存，1MB 的文件能吃出 3GB 堆，
 *   2000 行的小表直接卡死。实测同一文件：原样 3049MB/2423ms，去掉定义名后 120MB/438ms。
 *   因此**无条件**清洗（不只在检测到异常时），保证同一批文件行为一致。
 *
 * XlsxIO.load(arrayBuffer) -> Promise<Workbook 包装>
 *   返回 {
 *     sheetNames: [string],
 *     sheet(name) -> Sheet | null,
 *     eachSheet(fn),
 *     dispose()           // 释放工作簿引用（调用方读完立刻丢，峰值内存减半）
 *   }
 * Sheet = { name, rowCount, columnCount, cellText(r,c), cellValue(r,c), meta, above, rows, headers }
 *   r/c 均为 1 基（与 Excel 一致，也与 ExcelJS 一致）
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.XlsxIO = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  /** 取全局依赖：浏览器/Worker 挂 self，Node 走 require。 */
  function getJSZip() {
    if (root.JSZip) return root.JSZip;
    if (typeof require === 'function') {
      try { return require('../lib/jszip.min.js'); } catch (e) { /* 忽略 */ }
    }
    return null;
  }
  function getExcelJS() {
    if (root.ExcelJS) return root.ExcelJS;
    if (typeof require === 'function') {
      try { return require('../lib/exceljs.min.js'); } catch (e) { /* 忽略 */ }
    }
    return null;
  }

  // ---------- 字节工具 ----------

  /** 任意输入（ArrayBuffer / Uint8Array / Buffer / number[]）→ Uint8Array */
  function toBytes(input) {
    if (!input) return null;
    if (input instanceof Uint8Array) return input;
    if (typeof ArrayBuffer !== 'undefined') {
      if (input instanceof ArrayBuffer) return new Uint8Array(input);
      if (ArrayBuffer.isView && ArrayBuffer.isView(input)) {
        return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      }
    }
    if (Array.isArray(input)) return new Uint8Array(input);
    return null;
  }

  /** ZIP 文件头校验：不是 PK 开头的说明根本不是 xlsx（或已损坏）。 */
  function zipHeadError(bytes, fileName) {
    var name = fileName ? String(fileName).replace(/^.*[\\/]/, '') : '该文件';
    if (!bytes || !bytes.length) {
      return '文件为空（0 字节）：' + name + ' —— 请确认文件已完整保存到本地（网盘占位文件需先下载），再重新加载';
    }
    if (bytes.length < 4) return '文件不完整（仅 ' + bytes.length + ' 字节）：' + name + '，可能仍在写入或下载未完成';
    // "PK\x03\x04" / "PK\x05\x06"(空档) / "PK\x07\x08"(分卷)
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4B) {
      return '不是有效的 .xlsx（缺少 ZIP 文件头）：' + name + '。' +
        '若是旧版 .xls 或已损坏的文件，请先用 Excel/WPS 另存为 .xlsx';
    }
    return null;
  }

  // ---------- 定义名预清洗 ----------

  /**
   * 把 workbook.xml 里过宽的 _FilterDatabase 定义名按各 sheet 的 <dimension> 收窄。
   * 只动 _FilterDatabase / 打印区域这类与对比无关的区域型定义名；具名公式不碰。
   * 返回 { xml, changed } —— changed 为被改写的条数，供调用方写日志/测试断言。
   */
  function cleanDefinedNamesXml(wbXml, dimsBySheetFile, sheetFileByName) {
    var changed = 0;
    var out = String(wbXml).replace(
      /<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/g,
      function (whole, attrs, body) {
        var ref = parseAreaRef(body);
        if (!ref) return whole;                      // 不是区域引用（常量/公式）→ 原样保留
        // 找这个定义名属于哪个 sheet：优先 localSheetId，其次看名字前缀
        var targetDim = null;
        var m = /localSheetId\s*=\s*"(\d+)"/.exec(attrs);
        if (m) {
          var sheetName = null;
          var idx = parseInt(m[1], 10);
          // workbook.xml 里 <sheet> 顺序即 localSheetId 顺序
          var sheets = [];
          var re = /<sheet\b[^>]*name="([^"]*)"[^>]*>/g, sm;
          while ((sm = re.exec(wbXml))) sheets.push(unescapeXml(sm[1]));
          if (idx >= 0 && idx < sheets.length) sheetName = sheets[idx];
          if (sheetName && sheetFileByName && sheetFileByName[sheetName]) {
            targetDim = dimsBySheetFile[sheetFileByName[sheetName]] || null;
          }
        }
        if (!targetDim) return whole;
        var dim = parseAreaRef(targetDim);
        if (!dim) return whole;
        // 只有当定义名覆盖范围明显大于实际数据区（列数或行数更多）时才收窄
        if (ref.cols <= dim.cols && ref.rows <= dim.rows) return whole;
        changed++;
        var prefix = ref.sheetPrefix || '';
        // 收窄时**保留原起点**，只把终点收到实际数据区：原范围往往刻意从第 2 行
        // （数据首行，跳过表头）开始，直接换成 dimension 会把表头也圈进筛选区。
        // 起点完全沿用原定义名（它通常已经从数据首行开始，跳过表头）；
        // 终点收到实际数据区与原来的较小者。min/max 两侧都做保护，避免区间倒置。
        var startC = ref.minC, startR = ref.minR;
        var endC = Math.max(startC, Math.min(ref.maxC, dim.maxC));
        var endR = Math.max(startR, Math.min(ref.maxR, dim.maxR));
        var fixed = '$' + colLetter(startC) + '$' + startR + ':$' + colLetter(endC) + '$' + endR;
        return '<definedName' + attrs + '>' + prefix + fixed + '</definedName>';
      }
    );
    return { xml: out, changed: changed };
  }

  /** 解析 `Sheet1!$A$2:$XFC$2025` / `$A$2:$XFC$2025` → 行列数与规范化写法 */
  function parseAreaRef(text) {
    if (!text) return null;
    var s = String(text).trim();
    var bang = s.lastIndexOf('!');
    var sheetPrefix = '';
    var range = s;
    if (bang >= 0) { sheetPrefix = s.slice(0, bang + 1); range = s.slice(bang + 1); }
    var m = /^\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?$/.exec(range.trim());
    if (!m) return null;
    var c1 = colIndex(m[1]), c2 = m[3] ? colIndex(m[3]) : c1;
    var r1 = parseInt(m[2], 10), r2 = m[4] ? parseInt(m[4], 10) : r1;
    if (!(c1 > 0 && c2 > 0 && r1 > 0 && r2 > 0)) return null;
    var minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
    var minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
    return {
      sheetPrefix: sheetPrefix,
      cols: maxC - minC + 1,
      rows: maxR - minR + 1,
      minC: minC, maxC: maxC, minR: minR, maxR: maxR,
      normalized: '$' + colLetter(minC) + '$' + minR + ':$' + colLetter(maxC) + '$' + maxR
    };
  }

  /** 列字母 → 1 基列号（A=1, AA=27） */
  function colIndex(letters) {
    var n = 0, s = String(letters).toUpperCase();
    for (var i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
    return n;
  }
  /** 1 基列号 → 列字母 */
  function colLetter(n) {
    var s = '';
    while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }
  function unescapeXml(s) {
    return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  }

  /**
   * 预清洗整个 xlsx 字节流：解包 → 读各 sheet dimension → 收窄定义名 → 重打包。
   * 返回 { bytes: Uint8Array, changed: number }。
   * JSZip 不可用（如极旧环境）时原样返回并置 changed=-1，让调用方决定是否继续。
   */
  function preclean(bytes) {
    var JSZip = getJSZip();
    if (!JSZip || !JSZip.loadAsync) return Promise.resolve({ bytes: bytes, changed: -1 });
    return JSZip.loadAsync(bytes).then(function (zip) {
      var wbFile = zip.file('xl/workbook.xml');
      if (!wbFile) throw new Error('工作簿结构缺失（xl/workbook.xml）：可能不是有效的 .xlsx');
      return wbFile.async('string').then(function (wbXml) {
        // 收集每个 sheet 文件的 dimension
        var names = Object.keys(zip.files);
        var sheetFiles = names.filter(function (n) { return /^xl\/worksheets\/sheet\d+\.xml$/.test(n); });
        var dims = {};
        var chain = Promise.resolve();
        sheetFiles.forEach(function (sf) {
          chain = chain.then(function () {
            return zip.file(sf).async('string').then(function (x) {
              var dm = /<dimension\b[^>]*ref="([^"]+)"/.exec(x);
              dims[sf] = dm ? dm[1] : null;
            });
          });
        });
        return chain.then(function () {
          // 建立 sheet 名 → sheet 文件 的映射（按 _rels 的 rId 对应）
          return zip.file('xl/_rels/workbook.xml.rels').async('string').catch(function () { return ''; })
            .then(function (relsXml) {
              var nameToFile = {};
              var sheetRe = /<sheet\b([^>]*)\/?>/g, sm;
              // Target 可能是 "worksheets/sheet1.xml"（相对 xl/）或 "/xl/worksheets/sheet1.xml"（绝对）
              var rIdMap = {};
              var relRe = /<Relationship\b([^>]*)\/?>/g, rm;
              while ((rm = relRe.exec(relsXml))) {
                var idm = /Id="([^"]+)"/.exec(rm[1]);
                var tgm = /Target="([^"]+)"/.exec(rm[1]);
                if (!idm || !tgm) continue;
                var t = tgm[1];
                t = /^\/?xl\//.test(t) ? t.replace(/^\//, '') : 'xl/' + t.replace(/^\//, '');
                rIdMap[idm[1]] = t;
              }
              while ((sm = sheetRe.exec(wbXml))) {
                var nm = /name="([^"]*)"/.exec(sm[1]);
                var rid = /r:id="([^"]+)"/.exec(sm[1]);
                if (nm && rid && rIdMap[rid[1]]) nameToFile[unescapeXml(nm[1])] = rIdMap[rid[1]];
              }
              var res = cleanDefinedNamesXml(wbXml, dims, nameToFile);
              if (!res.changed) return { bytes: bytes, changed: 0 };
              zip.file('xl/workbook.xml', res.xml);
              return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
                .then(function (out) { return { bytes: out, changed: res.changed }; });
            });
        });
      });
    });
  }

  // ---------- 单元格取值 ----------

  /**
   * 单元格 → 纯文本（对比与展示都走它）。
   * 注意：ExcelJS 的值可能是 Date / 富文本对象 / 公式对象 / 超链接对象 / 错误值，
   * 不展开会得到 "[object Object]" 或时区错位。
   */
  function cellText(v) {
    if (v === null || v === undefined) return '';
    var t = typeof v;
    if (t === 'string') return v;
    if (t === 'number') return numText(v);
    if (t === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (v instanceof Date) return dateText(v);
    if (t === 'object') {
      if (v.richText) {
        var s = '';
        for (var i = 0; i < v.richText.length; i++) s += (v.richText[i].text || '');
        return s;
      }
      if (v.error) return String(v.error);
      // 公式：对比看结果值；没有缓存结果时退化为公式文本（避免误判相等）
      if (Object.prototype.hasOwnProperty.call(v, 'formula') || Object.prototype.hasOwnProperty.call(v, 'sharedFormula')) {
        if (v.result !== null && v.result !== undefined) return cellText(v.result);
        return '=' + (v.formula || '');
      }
      if (v.text !== undefined) return String(v.text);      // 超链接对象
    }
    return String(v);
  }

  /** 数字 → 文本：整数不带 .0，避免 0 与 0.0 被误判为差异 */
  function numText(n) {
    if (!isFinite(n)) return String(n);
    if (Number.isInteger(n)) return String(n);
    var s = String(n);
    // 消除浮点尾巴：0.1+0.2 这类
    return s.length > 17 ? String(parseFloat(n.toPrecision(15))) : s;
  }

  /** 日期 → YYYY-MM-DD（Excel 的日期都按"本地日期"语义读，不做时区偏移） */
  function dateText(d) {
    var y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, day = d.getUTCDate();
    var hh = d.getUTCHours(), mm = d.getUTCMinutes(), ss = d.getUTCSeconds();
    var p = function (x) { return x < 10 ? '0' + x : '' + x; };
    var base = y + '-' + p(m) + '-' + p(day);
    if (hh || mm || ss) return base + ' ' + p(hh) + ':' + p(mm) + (ss ? ':' + p(ss) : '');
    return base;
  }

  // ---------- 工作表抽取 ----------

  /**
   * 抽取一张工作表的全部内容 + 格式元数据。
   * cfg = { headerStart, headerEnd }  1 基，闭区间；表头为多行时逐格向下拼接
   *
   * 返回 {
   *   name, rowCount, columnCount,
   *   above:  [[string]]           表头行以上的原始行（保留，供报告展示）
   *   headers:[string]             合并后的列名
   *   headerMap: [{col, parts[]}]  每列的原始分段（供报告还原多行表头）
   *   rows:   [[string]]           数据行（纯文本，1:1 对应 Excel 行，跳过表头区）
   *   rowNumbers: [number]         每行对应的 Excel 行号（1 基）
   *   meta:   { colWidths, colHidden, headerStyles, rowHeights, freeze, merges }
   * }
   */
  function extractSheet(ws, cfg) {
    cfg = cfg || {};
    var headerStart = Math.max(1, parseInt(cfg.headerStart, 10) || 1);
    var headerEnd = Math.max(headerStart, parseInt(cfg.headerEnd, 10) || headerStart);
    var nCol = ws.columnCount || 0;
    var nRow = ws.rowCount || 0;

    // 表头以上：原样保留（可能是标题栏 / 分组行 / 公式行）
    var above = [];
    for (var r = 1; r < headerStart; r++) {
      var rowA = ws.getRow(r);
      var arrA = [];
      for (var c = 1; c <= nCol; c++) arrA.push(cellText(rowA.getCell(c).value));
      above.push(arrA);
    }

    // 多行表头：逐列把各行的值向下拼接，去空段
    var headers = [], headerMap = [];
    for (var hc = 1; hc <= nCol; hc++) {
      var parts = [];
      for (var hr = headerStart; hr <= headerEnd; hr++) {
        var t = cellText(ws.getRow(hr).getCell(hc).value).trim();
        if (t) parts.push(t);
      }
      headerMap.push({ col: hc, parts: parts.slice() });
      headers.push(parts.length ? parts.join(' / ') : ('列' + hc));
    }

    // 数据行
    var rows = [], rowNumbers = [];
    for (var dr = headerEnd + 1; dr <= nRow; dr++) {
      var rowD = ws.getRow(dr);
      var arrD = [];
      for (var dc = 1; dc <= nCol; dc++) arrD.push(cellText(rowD.getCell(dc).value));
      rows.push(arrD);
      rowNumbers.push(dr);
    }

    return {
      name: ws.name,
      rowCount: nRow,
      columnCount: nCol,
      above: above,
      headers: headers,
      headerMap: headerMap,
      rows: rows,
      rowNumbers: rowNumbers,
      meta: extractMeta(ws, headerStart, headerEnd, nCol)
    };
  }

  /**
   * 格式元数据：只保留"列级别"信息（约 16KB 量级），
   * 因此调用方可以立刻丢弃整个工作簿而不丢格式还原能力。
   */
  function extractMeta(ws, headerStart, headerEnd, nCol) {
    var clone = function (o) {
      if (!o) return null;
      try { var s = JSON.stringify(o); return s === '{}' ? null : JSON.parse(s); } catch (e) { return null; }
    };
    var colWidths = [], colHidden = [], headerStyles = [];
    for (var c = 1; c <= nCol; c++) {
      var col = ws.getColumn(c);
      // ExcelJS 的默认列宽是 9；恰好等于 9 时写回去会被判为"非自定义"而丢 `<cols>`，
      // 故这里把 9 抬高一丁点，保证源文件显式设置的 9 能真正写进报告。
      var w = col.width;
      if (typeof w === 'number' && Math.abs(w - 9) < 1e-9) w = 9.0001;
      colWidths.push(typeof w === 'number' ? w : null);
      colHidden.push(!!col.hidden);
    }
    for (var hc = 1; hc <= nCol; hc++) {
      var st = null;
      // 多行表头时取第一段有样式的，避免后段覆盖前段
      for (var hr = headerStart; hr <= headerEnd; hr++) {
        var s2 = clone(ws.getRow(hr).getCell(hc).style);
        if (s2) { st = s2; break; }
      }
      headerStyles.push(st);
    }
    var rowHeights = {};
    for (var rr = 1; rr <= headerEnd; rr++) {
      var h = ws.getRow(rr).height;
      if (h) rowHeights[rr] = h;
    }
    return {
      colWidths: colWidths,
      colHidden: colHidden,
      headerStyles: headerStyles,
      rowHeights: rowHeights,
      freeze: clone(ws.views && ws.views[0] ? ws.views[0] : null),
      merges: (ws.model && ws.model.merges ? ws.model.merges : []).slice()
    };
  }

  // ---------- 对外主入口 ----------

  /**
   * 读取一个 .xlsx：预清洗 → ExcelJS 载入 → 返回可查询的包装。
   * 调用方读完所需的 sheet 后应立即 dispose()（峰值内存差一倍）。
   */
  function load(input, fileName) {
    var bytes = toBytes(input);
    var headErr = zipHeadError(bytes, fileName);
    if (headErr) return Promise.reject(new Error(headErr));
    var ExcelJS = getExcelJS();
    if (!ExcelJS) return Promise.reject(new Error('Excel 解析库未加载（lib/exceljs.min.js 缺失）'));

    return preclean(bytes).then(function (res) {
      var wb = new ExcelJS.Workbook();
      return wb.xlsx.load(res.bytes instanceof Uint8Array ? res.bytes : res.bytes)
        .then(function () {
          var disposed = false;
          var sheets = wb.worksheets || [];
          return {
            sheetNames: sheets.map(function (s) { return s.name; }),
            cleaned: res.changed,
            sheet: function (name) {
              if (disposed) return null;
              for (var i = 0; i < sheets.length; i++) if (sheets[i].name === name) return sheets[i];
              return null;
            },
            eachSheet: function (fn) {
              if (disposed) return;
              for (var i = 0; i < sheets.length; i++) fn(sheets[i]);
            },
            dispose: function () {
              disposed = true;
              try { wb.removeWorksheet && sheets.forEach(function (s) { try { wb.removeWorksheet(s.id); } catch (e) { /* 忽略 */ } }); } catch (e) { /* 忽略 */ }
              sheets = null;
              wb = null;
            }
          };
        });
    });
  }

  /** 只读工作表清单 + 每张表的前 N 行预览（配置弹窗用，不抽取全量数据） */
  function peek(input, fileName, maxRows) {
    maxRows = maxRows || 10;
    var bytes = toBytes(input);
    var headErr = zipHeadError(bytes, fileName);
    if (headErr) return Promise.reject(new Error(headErr));
    var ExcelJS = getExcelJS();
    if (!ExcelJS) return Promise.reject(new Error('Excel 解析库未加载（lib/exceljs.min.js 缺失）'));
    return preclean(bytes).then(function (res) {
      var wb = new ExcelJS.Workbook();
      return wb.xlsx.load(res.bytes).then(function () {
        var out = [];
        (wb.worksheets || []).forEach(function (ws) {
          var nCol = ws.columnCount || 0;
          var lim = Math.min(maxRows, ws.rowCount || 0);
          var preview = [];
          for (var r = 1; r <= lim; r++) {
            var row = ws.getRow(r), arr = [];
            for (var c = 1; c <= nCol; c++) arr.push(cellText(row.getCell(c).value));
            preview.push(arr);
          }
          out.push({
            name: ws.name,
            rowCount: ws.rowCount || 0,
            columnCount: nCol,
            preview: preview
          });
        });
        try { wb.removeWorksheet && out.forEach(function () {}); } catch (e) { /* 忽略 */ }
        return out;
      });
    });
  }

  return {
    load: load,
    peek: peek,
    extractSheet: extractSheet,
    cellText: cellText,
    // 以下导出供测试直接断言
    preclean: preclean,
    cleanDefinedNamesXml: cleanDefinedNamesXml,
    parseAreaRef: parseAreaRef,
    zipHeadError: zipHeadError,
    colIndex: colIndex,
    colLetter: colLetter
  };
});
