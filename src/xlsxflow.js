/**
 * xlsxflow.js — Excel 对比的编排层：配置 → 读取 → 对比 → 渲染 → 导出。
 * 承住"多 sheet"的复杂度，让 app.js 只做接线（与 pipeline.js 之于文本对比是同一层的意思）。
 *
 * 关键设计：**单本持有 + 即时释放**
 *   读旧文件 → 抽取数据 + 格式元数据（约 16KB/sheet）→ 立即 dispose() 工作簿；
 *   再读新文件 → 同样抽取。两本工作簿永不同时驻留，峰值内存约为不释放时的一半。
 *   实测 5000 行 × 109 列：1098MB → 608MB，速度基本不变。
 *
 * 全局暴露：XlsxFlow
 *
 * XlsxFlow.configure(leftPath, rightPath) -> Promise<cfg>   // 读两边 sheet 清单做配置预览
 * XlsxFlow.run(cfg) -> Promise<result>                      // 执行对比
 * XlsxFlow.exportReport(name) -> Promise<{bytes, fileName}>
 * XlsxFlow.getConfig() / setConfig(cfg)
 * XlsxFlow.reset()
 */
(function (root) {
  'use strict';

  function dep(name) {
    if (root[name]) return root[name];
    if (typeof require === 'function') {
      try {
        if (name === 'XlsxIO') return require('./xlsx-io.js');
        if (name === 'XlsxCompare') return require('./xlsx-compare.js');
        if (name === 'XlsxReport') return require('./xlsx-report.js');
      } catch (e) { /* 忽略 */ }
    }
    return null;
  }

  var state = {
    leftPath: '',
    rightPath: '',
    config: null,      // { [sheet]: { enabled, headerStart, headerEnd, keyColumns } }
    lastResult: null,
    lastMeta: null,    // { oldMeta, newMeta, oldAbove, newAbove }
    lastSheets: null   // { old: {sheet: sheetData}, new: {...} } 供主区域3 显示
  };

  /** 读一个文件，抽取所有要参与的 sheet 的数据 + 元数据，然后立刻释放工作簿 */
  function readOne(path, cfg, sheetsToRead) {
    var XlsxIO = dep('XlsxIO');
    if (!XlsxIO) return Promise.reject(new Error('Excel 读取模块未加载'));
    return fetchBytes(path).then(function (bytes) {
      return XlsxIO.load(bytes, path);
    }).then(function (wb) {
      var out = { sheetNames: wb.sheetNames, data: {}, meta: {}, above: {} };
      sheetsToRead.forEach(function (name) {
        var ws = wb.sheet(name);
        if (!ws) return;
        var c = cfg[name] || {};
        var hs = c.headerStart || 1;
        var he = c.headerEnd || hs;
        var s = XlsxIO.extractSheet(ws, { headerStart: hs, headerEnd: he });
        out.data[name] = s;
        out.meta[name] = s.meta;
        out.above[name] = s.above;
      });
      wb.dispose();      // ★ 关键：读完立刻丢，峰值内存减半
      return out;
    });
  }

  /** 取文件原始字节（浏览器走 /api/file，Tauri 走 Rust 命令） */
  function fetchBytes(path) {
    var Source = root.Source;
    if (Source && Source.readBytes) return Source.readBytes(path);
    // 兜底：用 fileUrl 再 fetch
    if (Source && Source.fileUrl) {
      return Source.fileUrl(path).then(function (url) {
        if (typeof url !== 'string') {
          // Tauri 返回 Blob URL
          return fetch(url).then(function (r) { return r.arrayBuffer(); });
        }
        return fetch(url).then(function (r) { return r.arrayBuffer(); });
      });
    }
    return fetch('/api/file?path=' + encodeURIComponent(path)).then(function (r) { return r.arrayBuffer(); });
  }

  /** 读取两边文件，产出"待用户确认的配置"（每个 sheet 的预览 + 默认表头行） */
  function configure(leftPath, rightPath) {
    state.leftPath = leftPath || '';
    state.rightPath = rightPath || '';
    var XlsxIO = dep('XlsxIO');
    if (!XlsxIO) return Promise.reject(new Error('Excel 读取模块未加载（lib/exceljs.min.js 缺失）'));
    if (!leftPath && !rightPath) return Promise.reject(new Error('请先选择要对比的 Excel 文件'));

    // 预览两侧：以"新文件"（右侧）为主，旧文件（左侧）可能为空
    var jobs = [];
    jobs.push(leftPath ? peekOne(XlsxIO, leftPath) : Promise.resolve([]));
    jobs.push(rightPath ? peekOne(XlsxIO, rightPath) : Promise.resolve([]));

    return Promise.all(jobs).then(function (rs) {
      var oldSheets = rs[0] || [], newSheets = rs[1] || [];
      var cfg = {};
      var seen = {};

      // 合并 sheet 清单：新文件优先
      newSheets.forEach(function (s) {
        seen[s.name] = true;
        cfg[s.name] = {
          enabled: true,
          headerStart: 1,
          headerEnd: 1,
          keyColumns: [],
          _preview: s.preview,
          _rowCount: s.rowCount,
          _columnCount: s.columnCount,
          _oldPreview: null
        };
      });
      oldSheets.forEach(function (s) {
        if (cfg[s.name]) {
          cfg[s.name]._oldPreview = s.preview;
          cfg[s.name]._oldRowCount = s.rowCount;
        } else {
          cfg[s.name] = {
            enabled: true,
            headerStart: 1,
            headerEnd: 1,
            keyColumns: [],
            _preview: null,
            _rowCount: 0,
            _columnCount: s.columnCount,
            _oldPreview: s.preview,
            _oldRowCount: s.rowCount,
            _onlyOld: true
          };
        }
      });

      // 默认表头行：优先猜一个（第一个"看起来像表头"的行）
      Object.keys(cfg).forEach(function (name) {
        cfg[name].headerStart = guessHeaderRow(cfg[name]._preview) || 1;
        cfg[name].headerEnd = cfg[name].headerStart;
      });

      state.config = cfg;
      return cfg;
    });
  }

  function peekOne(XlsxIO, path) {
    return fetchBytes(path).then(function (bytes) {
      return XlsxIO.peek(bytes, path, 10);
    });
  }

  /**
   * 猜表头行（1 基）：找"非空单元格最多、且下一行开始是数据"的那一行。
   * 启发式而不是死板取第 1 行——真实报表常常前两行是标题栏/分组行。
   * 预览只取前 10 行，所以最多猜到第 5 行。
   */
  function guessHeaderRow(preview) {
    if (!preview || !preview.length) return 1;
    var best = 1, bestScore = -1;
    var limit = Math.min(preview.length - 1, 5);
    for (var i = 0; i < limit; i++) {
      var row = preview[i] || [];
      var nonEmpty = 0, distinct = {}, nonNumeric = 0;
      for (var c = 0; c < row.length; c++) {
        var v = row[c];
        if (v === null || v === undefined || String(v).trim() === '') continue;
        nonEmpty++;
        distinct[String(v)] = true;
        // 表头通常是文本，数据行里数字更多
        if (isNaN(parseFloat(String(v)))) nonNumeric++;
      }
      if (!nonEmpty) continue;
      // 得分：非空多 + 文本比例高 + 取值不重复（重复说明是"公共列"这类分组行）
      var distinctRatio = Object.keys(distinct).length / nonEmpty;
      var score = nonEmpty + nonNumeric * 2 + distinctRatio * 10;
      if (score > bestScore) { bestScore = score; best = i + 1; }
    }
    return best;
  }

  /** 执行对比：读旧 → 读新 → 比对 → 生成报告数据 */
  function run(cfg) {
    if (cfg) state.config = cfg;
    var C = dep('XlsxCompare');
    if (!C) return Promise.reject(new Error('Excel 对比模块未加载'));
    var conf = state.config || {};
    var leftPath = state.leftPath, rightPath = state.rightPath;
    if (!leftPath && !rightPath) return Promise.reject(new Error('请先选择要对比的 Excel 文件'));

    // 要参与的 sheet 名（enabled 未显式为 false 的都算）
    var names = Object.keys(conf).filter(function (n) { return conf[n].enabled !== false; });
    if (!names.length) return Promise.reject(new Error('请至少勾选一个 Sheet 参与对比'));

    var t0 = Date.now();
    var oldRead = leftPath ? readOne(leftPath, conf, names) : Promise.resolve({ sheetNames: [], data: {}, meta: {}, above: {} });

    return oldRead.then(function (oldOut) {
      var newRead = rightPath ? readOne(rightPath, conf, names) : Promise.resolve({ sheetNames: [], data: {}, meta: {}, above: {} });
      return newRead.then(function (newOut) {
        // 只在一侧存在的 sheet 也要参与（另一侧给空表）
        var oldBook = {
          sheetNames: oldOut.sheetNames,
          sheet: function (n) { return oldOut.data[n] || null; },
          _extract: function (n) { return oldOut.data[n] || emptySheet(n); }
        };
        var newBook = {
          sheetNames: newOut.sheetNames,
          sheet: function (n) { return newOut.data[n] || null; },
          _extract: function (n) { return newOut.data[n] || emptySheet(n); }
        };

        // 传给 compareWorkbook 的配置：只保留参与的 sheet
        var passCfg = {};
        names.forEach(function (n) { passCfg[n] = conf[n]; });

        var result = C.compareWorkbook(oldBook, newBook, passCfg);
        result.elapsedMs = Date.now() - t0;

        state.lastResult = result;
        state.lastMeta = {
          oldMeta: oldOut.meta, newMeta: newOut.meta,
          oldAbove: oldOut.above, newAbove: newOut.above
        };
        state.lastSheets = { old: oldOut.data, new: newOut.data };
        return result;
      });
    });
  }

  function emptySheet(name) {
    return { name: name, headers: [], oldHeaders: [], rows: [], rowNumbers: [], above: [], meta: null };
  }

  /** 生成 Excel 报告（返回字节，由调用方决定落盘方式） */
  function exportReport(fileBaseName) {
    var R = dep('XlsxReport');
    if (!R) return Promise.reject(new Error('Excel 报告模块未加载'));
    if (!state.lastResult) return Promise.reject(new Error('没有可导出的对比结果'));
    var m = state.lastMeta || {};
    var name = fileBaseName || defaultName();
    return R.build(state.lastResult, {
      oldMeta: m.oldMeta || {},
      newMeta: m.newMeta || {},
      oldAbove: m.oldAbove || {},
      newAbove: m.newAbove || {}
    }).then(function (bytes) {
      return { bytes: bytes, fileName: name };
    });
  }

  function defaultName() {
    function base(p) { var n = String(p || '').split('/').pop(); return (n || '').replace(/\.[^.]+$/, ''); }
    var lb = base(state.leftPath), rb = base(state.rightPath);
    var d = new Date();
    function p2(x) { return x < 10 ? '0' + x : '' + x; }
    var stamp = d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' +
      p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
    if (lb && rb && lb !== rb) return lb + '-' + rb + '-对比报告-' + stamp + '.xlsx';
    return '表格对比报告-' + stamp + '.xlsx';
  }

  /** 把对比结果转成主区域3 需要的"行/单元格差异标记" */
  function buildDiffMarks(sheetName) {
    var res = state.lastResult;
    if (!res) return { L: null, R: null };
    var r = null;
    for (var i = 0; i < res.sheets.length; i++) {
      if (res.sheets[i].sheet === sheetName) { r = res.sheets[i]; break; }
    }
    if (!r) return { L: null, R: null };

    var marksL = { rows: {}, cells: {} };
    var marksR = { rows: {}, cells: {} };

    r.added.forEach(function (it) {
      marksR.rows[it.newRow] = 'add';
      var cellMap = {};
      r.headers.forEach(function (h) {
        if (it.cells[h] !== undefined && String(it.cells[h]).trim() !== '') cellMap[h] = 'add';
      });
      marksR.cells[it.newRow] = cellMap;
    });
    r.modified.forEach(function (it) {
      marksL.rows[it.oldRow] = 'mod';
      marksR.rows[it.newRow] = 'mod';
      var cmR = {}, cmL = {};
      (it.changedCols || []).forEach(function (col) {
        if (col.indexOf('旧_') === 0) return;
        cmR[col] = 'mod';
        cmL[col] = 'mod';
      });
      marksR.cells[it.newRow] = cmR;
      marksL.cells[it.oldRow] = cmL;
    });
    r.deleted.forEach(function (it) {
      marksL.rows[it.oldRow] = 'del';
      var cellMap = {};
      var hdrs = r.oldHeaders && r.oldHeaders.length ? r.oldHeaders : r.headers;
      hdrs.forEach(function (h) {
        if (it.cells[h] !== undefined && String(it.cells[h]).trim() !== '') cellMap[h] = 'del';
      });
      marksL.cells[it.oldRow] = cellMap;
    });

    return { L: marksL, R: marksR };
  }

  function getConfig() { return state.config; }
  function setConfig(c) { state.config = c; }
  function getResult() { return state.lastResult; }
  function getSheets() { return state.lastSheets; }
  /** 只改路径，不重读预览（配置弹窗改过下拉时用）。空右路径 → 右侧视为不参与。 */
  function configurePaths(leftPath, rightPath) {
    state.leftPath = leftPath || '';
    state.rightPath = rightPath || '';
  }
  function reset() {
    state = {
      leftPath: state.leftPath, rightPath: state.rightPath,
      config: null, lastResult: null, lastMeta: null, lastSheets: null
    };
  }

  root.XlsxFlow = {
    configure: configure,
    configurePaths: configurePaths,
    run: run,
    exportReport: exportReport,
    buildDiffMarks: buildDiffMarks,
    getConfig: getConfig,
    setConfig: setConfig,
    getResult: getResult,
    getSheets: getSheets,
    reset: reset,
    defaultName: defaultName,
    // 供测试
    _guessHeaderRow: guessHeaderRow,
    _fetchBytes: fetchBytes
  };
})(typeof self !== 'undefined' ? self : this);
