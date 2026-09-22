/**
 * pipeline.js — 对比管线：加载一对文件 → 计算差异 → 渲染结果区 → 映射到 PDF/Word 面板并上色。
 *
 * 定位：数据层（Source / PdfView / DocxView / Compute）与界面层（src/app.js）之间的承重层。
 * 内部不持有标签页 / 历史记录 / 侧边栏 / 缩放拖拽等 UI 状态，也不监听 UI 事件；
 * 界面层通过 Pipeline.init(cfg) 注入编辑器存取器、选项读取、结果区元素与若干回调。
 *
 * 之所以独立成模块：无头渲染（tools/render.js）要在没有 UI 交互的前提下走完同一条链路，
 * 若上色/映射逻辑留在 app.js，无头驱动就得复制一份，两边必然走样。
 *
 * 全局暴露：Pipeline
 *
 *   Pipeline.init(cfg)            注入依赖，见 init 注释
 *   Pipeline.compare(fromRestore) 读两侧文本 + 当前选项 → Worker/本地计算 → 渲染 → 面板上色
 *   Pipeline.getResult()          最近一次计算结果（null 表示尚无结果/计算中）
 *   Pipeline.loadSide(side, path) 把 PDF/Word/文本加载到主区域3 与该侧编辑区
 *   Pipeline.invalidateSide(side) / invalidateAll()  作废在途加载（左右互换 / 切标签页）
 *   Pipeline.annotate(res)        把结果标注到主区域3 面板（也可由外部单独触发）
 *   Pipeline.buildAnnotMaps(res)  结果 → 两侧 {行号: 标注} 映射（供外部复用）
 *   Pipeline.panelViewer(side)    主区域3 该侧当前实际渲染的查看器（PDF / Word）
 *   Pipeline.charMaps()           协同滚动用的字符对齐表 { editor, pdf, pdfMatchesEditors }
 *   Pipeline.renderGrid(res)      单独重渲染结果区（折叠/展开等局部刷新）
 *   Pipeline.setFoldEnabled(on) / isFoldEnabled() / toggleFold(key) / resetFold()
 */
(function (root) {
  'use strict';

  // ---------- 注入配置 ----------
  // cfg = {
  //   resultsEl, statsEl,                       结果区 / 统计区元素
  //   getText(side) -> string,                   编辑区文本读取（side: 'L'|'R'）
  //   setText(side, text),                       编辑区文本写入（纯文本文件走这条；PDF/Word 走 onPanelText）
  //   getOptions() -> 选项对象,
  //   setBusy(bool),                             计算中状态（状态栏）
  //   toast(msg, isErr),                         轻提示
  //   onResult(res, isRestore),                  一次对比落定：历史记录 / tab 标题
  //   onRendered(res),                           结果区 DOM 重建后：重新绑定协同滚动
  //   onPanelText(side, text),                   文件文本就绪：字段下拉 + 写入编辑区
  //   onPanelsChanged(),                         主区域3 面板变化：重算显隐
  //   onPlaceholder()                            两侧皆空时的状态栏文案
  //   onScannedPdf(side, absPath, url),          扫描版 PDF（无文字层）检测到：UI 决定是否 OCR
  //   onOcrProgress(side, info),                 OCR 进度：{ phase:'load'|'page'|'done', page, total, loadedMB? }
  //   onOcrState(side, state)                    侧 OCR 状态变化：'idle'|'pending'|'running'|'done'|'failed'
  // }
  var cfg = {};
  function init(c) {
    cfg = c || {};
    if (typeof cfg.getText !== 'function') cfg.getText = function () { return ''; };
    if (typeof cfg.getOptions !== 'function') cfg.getOptions = function () { return {}; };
    var fns = ['setBusy', 'toast', 'onResult', 'onRendered', 'onPanelText', 'onPanelsChanged', 'onPlaceholder',
      'onScannedPdf', 'onOcrProgress', 'onOcrState'];
    for (var i = 0; i < fns.length; i++) {
      if (typeof cfg[fns[i]] !== 'function') cfg[fns[i]] = function () {};
    }
  }
  function resultsEl() { return cfg.resultsEl; }
  function statsEl() { return cfg.statsEl; }

  // ---------- 状态 ----------
  var expanded = {};            // 折叠行展开状态
  var foldEnabled = true;       // 是否折叠相同行
  var lastResult = null;        // 最近一次计算结果
  var lastOptions = null;       // 最近一次对比所用选项
  var worker = null;
  var seq = 0;                  // Worker 请求序号：丢弃过期结果
  var lastCompareIsRestore = false;  // 本次 compare 是否由 tab 恢复发起（抑制历史记录）
  var panelAnnSeq = 0;          // 面板标注流程序号：丢弃过期的异步标注
  var fileSeq = { L: 0, R: 0 }; // 每侧文件加载令牌：同侧新加载作废旧加载（两侧可并行互不干扰）
  var ocrSeq = 0;               // OCR 流程序号：取消/换文件/切 tab 作废在途 OCR
  var ocrWorker = null;         // OCR Worker 实例（惰性创建）
  var ocrWorkerReady = false;   // Worker 已加载运行时（ort+模型+字典）
  var ocrLoading = false;       // Worker 正在加载运行时
  var ocrState = { L: 'idle', R: 'idle' };   // 每侧 OCR 状态
  var ocrPendingSide = null;   // 待 OCR 的侧（扫描版检测到后登记，UI 确认后清除）
  function setOcrState(side, s) {
    if (ocrState[side] === s) return;
    ocrState[side] = s;
    try { cfg.onOcrState(side, s); } catch (e) { /* 忽略 */ }
  }

  // ---------- 工具 ----------
  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
      cfg.setBusy(false);
      if (ev.data.error) { lastResult = { error: ev.data.error }; cfg.setBusy(false); reportStats(null); return; }
      ev.data.result._options = lastOptions;
      render(ev.data.result);
    };
    worker.onerror = function () { worker = null; };
    return worker;
  }
  /** 主线程本地计算（无 Worker 环境 / 面板坐标校正用） */
  function runSync(payload) {
    try { return Compute.computeDiff(payload); } catch (e) { return { error: String((e && e.stack) || e) }; }
  }
  function compare(fromRestore) {
    lastCompareIsRestore = !!fromRestore;
    var left = cfg.getText('L'), right = cfg.getText('R');
    var o = cfg.getOptions();
    lastOptions = o;
    lastResult = null;
    var payload = { left: left, right: right, options: o };
    var w = ensureWorker();
    if (w) {
      cfg.setBusy(true);
      w.postMessage({ id: ++seq, payload: payload });
    } else {
      var res = runSync(payload);
      res._options = o;
      render(res);
    }
  }

  // ---------- 结果区渲染 ----------
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
    resultsEl().innerHTML =
      '<div class="grid">' +
      '<div class="colhead">原文</div>' +
      '<div class="colhead">修改后</div>' +
      '<div class="grid-body" id="leftBody">' + leftBody + '</div>' +
      '<div class="grid-body" id="rightBody">' + rightBody + '</div>' +
      '</div>';
    reportStats(res);
    cfg.onRendered(res);   // 重渲染重建了 leftBody/rightBody，必须重新绑定协同滚动
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
      resultsEl().innerHTML = '<div class="inline-body" id="inline-body" style="padding:20px;color:#666">'
        + '文本过大，忽略换行模式暂无法逐字符对比（' + res.leftLen + ' / ' + res.rightLen + ' 字符）。'
        + '可关闭“忽略换行”后重试。</div>';
      reportStats(null);
      return;
    }
    resultsEl().innerHTML =
      '<div class="grid">' +
      '<div class="colhead">原文（标注）</div>' +
      '<div class="colhead">修改后（标注）</div>' +
      '<div class="grid-body" id="leftBody">' + flowRowsHtml(flowLineRows(res.segsL)) + '</div>' +
      '<div class="grid-body" id="rightBody">' + flowRowsHtml(flowLineRows(res.segsR)) + '</div>' +
      '</div>';
    reportStats({ mode: 'flow', addedChars: res.addedChars, removedChars: res.removedChars });
    cfg.onRendered(res);   // 同上：重建了左右栏后重新绑定协同滚动
  }

  function render(res) {
    lastResult = res;
    refreshEditorCharMap();              // 编辑区字符对齐表随结果重建（渲染前，供后续滚动互译）
    var isRestore = lastCompareIsRestore;
    lastCompareIsRestore = false;
    cfg.setBusy(false);
    cfg.onResult(res, isRestore);        // 历史记录 / tab 标题（恢复发起时不写历史）
    if (res.error) {
      resultsEl().innerHTML = '';
      reportStats(null);
      annotate(null);
      cfg.onRendered(res);
      return;
    }
    if (cfg.getText('L') === '' && cfg.getText('R') === '') {
      resultsEl().innerHTML = '<div class="placeholder">在两侧粘贴文本，即可自动开始对比</div>';
      statsEl().innerHTML = '';
      cfg.onPlaceholder();
      annotate(null);
      cfg.onRendered(res);
      return;
    }
    if (res.mode === 'flow') renderFlow(res);
    else renderGrid(res);
    annotate(res);
    cfg.onRendered(res);
  }

  function reportStats(res) {
    if (!res || res.error) { statsEl().textContent = ''; return; }
    if (res.mode === 'flow') {
      var n = (res.addedChars || 0) + (res.removedChars || 0);
      if (n === 0) statsEl().innerHTML = '<span class="ok">内容一致（忽略换行）</span>';
      else statsEl().innerHTML = '修改内容：<span class="bad">增 ' + res.addedChars + '</span> · <span class="bad">删 ' + res.removedChars + '</span> 字符';
      return;
    }
    var s = res.stats;
    var total = s.added + s.removed + s.modified;
    if (total === 0) {
      statsEl().innerHTML = '<span class="ok">内容一致（当前忽略选项下）</span>';
    } else {
      statsEl().innerHTML =
        '修改 <span class="bad">' + s.modified + '</span> · 新增 '
        + '<span class="ok">' + s.added + '</span> · 删除 <span class="bad">' + s.removed + '</span> 行';
    }
  }

  // ---------- 主区域3 面板标注 ----------
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
  function annotate(res) {
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
    syncPanelTextAnnotations();
  }

  // 主区域3 面板标注的行号坐标系 = 面板原文行号（PDF 的提取文本 / Word 的 mammoth 文本）。
  // “修整”（或手工编辑）会改变编辑器文本的行号系，使编辑器 diff 的行号与面板原文错位
  // （修整成 1 行后全部标到第 1 行 → 标注失效）。因此：凡该侧已加载面板且其原文与编辑器当前文本
  // 不一致，就用面板原文 + 当前忽略选项另算一份 diff（与区域1 同一数据流：grid 行 / flow 片段）
  // 覆盖该侧标注；一致时零额外开销。
  // PDF 与 Word 面板在这一层完全同构（都有 extractPanel / setHighlight，同名同语义），故共用一条流程；
  // 两者各自的字符对齐表也一并由此刷新（面板原文坐标系，供协同滚动互译）。
  function syncPanelTextAnnotations() {
    var vL = panelViewer('L'), vR = panelViewer('R');
    if (!vL && !vR) return;
    var my = ++panelAnnSeq;
    Promise.all([
      vL ? vL.extractPanel('L') : Promise.resolve(null),
      vR ? vR.extractPanel('R') : Promise.resolve(null)
    ]).then(function (txts) {
      if (my !== panelAnnSeq) return;                 // 已有更新的标注流程接管
      var tL = txts[0], tR = txts[1];
      refreshPdfCharMap(tL, tR);                      // 先重建面板字符对齐表（无论标注是否需校正）
      var diffL = !!vL && tL != null && tL !== cfg.getText('L');
      var diffR = !!vR && tR != null && tR !== cfg.getText('R');
      if (!diffL && !diffR) return;                   // 编辑器即面板原文：现有标注已正确
      var r2 = runSync({                              // 面板原文的 diff（同步；文本量与面板文档相当，可控）
        left: tL == null ? '' : tL,
        right: tR == null ? '' : tR,
        options: cfg.getOptions()
      });
      if (my !== panelAnnSeq || !r2 || r2.error) return;
      var maps = buildAnnotMaps(r2);
      if (diffL) vL.setHighlight('L', maps.L);
      if (diffR) vR.setHighlight('R', maps.R);
    }).catch(function () { /* 提取失败：保留编辑器 diff 的标注 */ });
  }

  /** 主区域3 该侧当前实际渲染的查看器：认面板 DOM 里的内容（docx-host → Word，否则 PDF）。
   *  同侧互斥由加载方保证（loadSide 会 clear 掉另一个），这里再看一眼 DOM 是防时序错位：
   *  万一 "已加载标记" 与 "面板里真正显示的东西" 不一致，锚点必须跟面板走，否则协同滚动会错位。 */
  function panelViewer(side) {
    var p = PdfView.getPanel ? PdfView.getPanel(side) : null;
    var host = p && p.firstChild;
    var isDocx = !!(host && (' ' + (host.className || '') + ' ').indexOf(' docx-host ') >= 0);
    if (isDocx && typeof DocxView !== 'undefined' && DocxView.isLoaded && DocxView.isLoaded(side) && DocxView.lineAtOffset) return DocxView;
    if (PdfView.isLoaded && PdfView.isLoaded(side) && PdfView.lineAtOffset) return PdfView;
    return null;
  }

  // ---------- 字符级对齐表（协同滚动的跨区互译基准） ----------
  // 两张表：
  //   editorCharMap —— 来自对比结果 charAnchors（编辑器文本坐标系，随对比结果刷新）；
  //   pdfCharMap    —— 来自主区域3 的面板原文（PDF 提取文本 / Word 的 mammoth 文本，两者同为
  //                    "面板坐标系"，修整后 PDF↔PDF、Word↔Word、PDF↔Word 依然用它对得准）。
  var editorCharMap = null;            // { l2r, r2l, texts:{L,R}, lineStarts:{L,R} }
  var pdfCharMap = null;               // 同上，但基于主区域3 面板原文（PDF/Word）
  var pdfMapSeq = 0;
  var pdfMapMatchesEditors = false;    // pdfCharMap 与编辑器当前文本一致时，混合跨区（PDF↔编辑）才能用字符级坐标

  /** 文本行号 → 每行起始字符偏移表（1 基行号；文本不含行尾换行的情形也正确） */
  function lineStartsOf(text) {
    var starts = [0], i;
    for (i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
    return starts;
  }
  /** 编辑器文本坐标系对齐表（行级+字符级）：随对比结果（lastResult）重建 */
  function refreshEditorCharMap() {
    editorCharMap = null;
    if (!lastResult || lastResult.error || !(lastResult.lineAnchors || lastResult.charAnchors)) return;
    var tl = cfg.getText('L'), tr = cfg.getText('R');
    editorCharMap = {
      line: lastResult.lineAnchors || null,
      char: lastResult.charAnchors || null,
      texts: { L: tl, R: tr },
      lineStarts: { L: lineStartsOf(tl), R: lineStartsOf(tr) }
    };
  }
  /** 基于主区域3 面板原文（PDF 提取文本 / Word 的 mammoth 文本）重建对齐表（行级+字符级）。
   *  编辑器文本恰为面板原文时复用对比结果表（零额外 diff），否则另算 */
  function refreshPdfCharMap(tL, tR) {
    var my = ++pdfMapSeq;
    pdfCharMap = null;
    if (tL == null || tR == null) return;
    var anchors = null;
    if (lastResult && lastResult.charAnchors && cfg.getText('L') === tL && cfg.getText('R') === tR) {
      anchors = { line: lastResult.lineAnchors || null, char: lastResult.charAnchors || null };
    } else {
      var r2 = runSync({ left: tL, right: tR, options: cfg.getOptions() });
      if (my !== pdfMapSeq || r2.error) return;
      anchors = { line: r2.lineAnchors || null, char: r2.charAnchors || null };
    }
    if (my !== pdfMapSeq) return;
    pdfCharMap = anchors ? {
      line: anchors.line || null, char: anchors.char || null,
      texts: { L: tL, R: tR },
      lineStarts: { L: lineStartsOf(tL), R: lineStartsOf(tR) }
    } : null;
    updateMapMatches();
  }
  /** pdfCharMap 是否与编辑器当前文本一致（编辑器文本变化后立即失效） */
  function updateMapMatches() {
    pdfMapMatchesEditors = !!(pdfCharMap && pdfCharMap.texts.L === cfg.getText('L')
      && pdfCharMap.texts.R === cfg.getText('R'));
  }
  /** 供协同滚动取用：对齐表 + 是否与编辑器同文本 */
  function charMaps() {
    return { editor: editorCharMap, pdf: pdfCharMap, pdfMatchesEditors: pdfMapMatchesEditors };
  }
  /** 左右互换等使面板原文与编辑器一起换位：作废面板对齐表 */
  function resetCharMaps() {
    pdfCharMap = null;
    updateMapMatches();
  }

  // ---------- 文件加载（主区域3 面板 + 该侧编辑区文本） ----------
  /** 作废某侧在途加载（左右互换 / 该侧重新选文件）；同时取消该侧在途 OCR */
  function invalidateSide(side) {
    fileSeq[side]++;
    if (ocrState[side] === 'running' || ocrState[side] === 'pending') setOcrState(side, 'idle');
    ocrSeq++;                        // 作废在途 OCR（runOcr 内部检查 my === ocrSeq）
    ocrPathBySide[side] = null;      // 作废已登记的 OCR 路径（避免缓存写到旧文件）
  }
  /** 作废两侧在途加载（切换标签页 / 恢复会话）；同时取消全部在途 OCR */
  function invalidateAll() {
    fileSeq.L++; fileSeq.R++;
    ocrSeq++;                        // 作废在途 OCR
    ['L', 'R'].forEach(function (s) { if (ocrState[s] === 'running' || ocrState[s] === 'pending') setOcrState(s, 'idle'); });
    ocrPathBySide.L = null; ocrPathBySide.R = null;
  }
  /** 取消在途 OCR（UI 取消按钮）。 */
  function cancelOcr() {
    ocrSeq++;
    ['L', 'R'].forEach(function (s) { if (ocrState[s] === 'running' || ocrState[s] === 'pending') setOcrState(s, 'idle'); });
    ocrPendingSide = null;
  }

  /** docx 字节预检：不通过时返回给用户看的文案，通过返回 null。
   *  0 字节的 .docx 现实中并不少见（网盘/OneDrive 占位文件尚未下载到本地、文件仍在写入或同步中、
   *  下载中断留下的空文件），但这份字节一路传到 JSZip 里只会抛一句
   *  "End of data reached (data length = 0, asked index = 4). Corrupted zip ?"——看不出是文件没读到。
   *  ZIP 文件头固定是 "PK"，据此把"空文件/不完整"和"根本不是 docx（.doc 改名、损坏）"分开说。
   *  桩环境（单测传 {len:1,byteLength:100} 这类假 buffer）拿不到真实字节 → 只做长度判断。 */
  function docxBytesError(buf, absPath) {
    var n = (buf && buf.byteLength) || 0;
    var name = String(absPath).replace(/^.*[\\/]/, '');
    if (!n) return '文件为空（0 字节）：' + name + ' —— 请确认文件已完整保存到本地（网盘中的占位文件需先下载），再重新加载';
    if (!(typeof ArrayBuffer !== 'undefined' && buf instanceof ArrayBuffer)) return null;
    if (n < 4) return '文件不完整（仅 ' + n + ' 字节）：' + name + '，可能仍在写入或下载未完成';
    var b = new Uint8Array(buf, 0, 2);
    if (b[0] !== 0x50 || b[1] !== 0x4B) return '不是有效的 .docx（缺少 ZIP 文件头）：' + name + '，文件可能已损坏或是 .doc 改名而来';
    return null;
  }

  /** 把文件加载到该侧：主区域3 渲染（PDF / Word），并把提取文本写进该侧编辑区。
   *  同侧新加载会作废在途加载；跨侧互不干扰。（编辑区写入与字段下拉由 cfg.onPanelText 承担） */
  function loadSide(side, absPath) {
    if (!absPath || !Source.fileUrl) return;
    var my = ++fileSeq[side];                  // 本次加载令牌：同侧新加载作废旧加载
    function stale() { return my !== fileSeq[side]; }
    // fileUrl 返回 Promise（Tauri 模式需先经 Rust 读字节转 Blob URL）
    Source.fileUrl(absPath).then(function (url) {
      if (stale()) return;
      if (/\.pdf$/i.test(absPath)) {
        if (typeof DocxView !== 'undefined' && DocxView.clear) DocxView.clear(side);  // 与 Word 面板互斥：同侧只保留一种渲染
        // ★ 新 PDF 加载开始即把 OCR 状态重置为 pending：render.js 报告通道的 OCR 轮询
        //   靠 ocrState 判断"扫描识别是否落定"，若沿用上一对的残留 done/idle 会在
        //   extractPanel 判定前就通过 → textItems 尚未注入 → 扫描页差异标注缺失。
        //   文字层 PDF：extractPanel 返回文本后下面会复位 idle（轮询见 idle 即通过）；
        //   扫描版：保持 pending → 缓存命中/OCR 完成才置 done（轮询等 done 才通过）。
        setOcrState(side, 'pending');
        // 单次取文档：渲染 + 提词复用同一份
        var load = PdfView.load(side, url, my);
        if (load && load.then) {
          load.then(function () {
            if (stale()) return;
            return PdfView.extractPanel(side);
          }).then(function (text) {
            if (stale()) return;
            if (!text || !text.trim()) {
              // 扫描版 PDF：无文字层（getTextContent 为空）→ 无法直接对比。
              // 优先复用 OCR 结果缓存（同一文件已识别过 → 直接注入，跳过 Worker 加载与逐页识别）；
              // 未命中：无头模式（__HEADLESS_OCR__=true，render.js 报告通道）自动跑 OCR 不弹窗，
              // 交互模式交给 UI 层决定（弹确认框）；识别完成后把结果写回缓存供下次复用。
              if (PdfView.getNumPages && PdfView.getNumPages(side) > 0) {
                ocrPathBySide[side] = absPath;   // 登记路径：OCR 完成后写结果缓存（复用）
                var headlessOcr = typeof window !== 'undefined' && window.__HEADLESS_OCR__;
                // 先同步登记 pending：无头报告通道的 OCR 轮询会等它落定（done/failed），
                // 不会被编辑器里上一对的残留文本短路——保证 textItems 注入完成后再截图（标注不丢）。
                setOcrState(side, 'pending');
                ocrCacheGet(absPath).then(function (cached) {
                  if (stale()) return;
                  if (cached) {
                    // 缓存命中：复用上次识别结果（text 进编辑器、items 供扫描页差异标注）
                    PdfView.setOcrResult(side, { text: cached.text, items: cached.items });
                    cfg.onPanelText(side, cached.text);
                    setOcrState(side, 'done');
                    if (cfg.onOcrProgress) cfg.onOcrProgress(side, { phase: 'done', pages: cached.items.length, cached: true });
                    return;
                  }
                  if (headlessOcr) {
                    runOcr(side);           // 自动识别（识别完成内部置 done + 写缓存）
                  } else {
                    ocrPendingSide = side;
                    if (cfg.onScannedPdf) cfg.onScannedPdf(side, absPath, url);
                  }
                });
              }
              return;
            }
            cfg.onPanelText(side, text);
            setOcrState(side, 'idle');       // 文字层 PDF：OCR 决策完成（非扫描）→ 复位，轮询见 idle 即通过
          }).catch(function (err) {
            if (!stale()) {
              setOcrState(side, 'idle');   // 加载失败：OCR 决策终止，复位避免轮询死等 pending
              cfg.toast('加载 PDF 失败：' + ((err && err.message) || err), true);
            }
          });
        }
      } else if (/\.docx$/i.test(absPath)) {
        if (PdfView.clear) PdfView.clear(side);      // 与 PDF 面板互斥
        fetch(url).then(function (r) {
          // 服务端出错时响应体是 JSON（如 404 {"ok":false,"error":"文件不存在"}），
          // 直接把它当 docx 喂给 JSZip 只会得到 "Corrupted zip"，看不出是没读到文件
          if (!r.ok) {
            var m = 'HTTP ' + r.status + (r.status === 404 ? '（文件不存在，可能已被移动或删除）' : '');
            if (DocxView.showError) DocxView.showError(side, m);
            throw new Error(m);
          }
          return r.arrayBuffer();
        }).then(function (buf) {
          if (stale()) return;
          // 字节预检不通过就没必要渲染/提词：面板红框 + 抛给下面统一 toast，文案一致
          var bad = docxBytesError(buf, absPath);
          if (bad) {
            if (DocxView.showError) DocxView.showError(side, bad);
            throw new Error(bad);
          }
          // 渲染（DocxView.load）与提词（extractText）并行，同一份 ArrayBuffer
          return Promise.all([DocxView.load(side, buf, my), DocxView.extractText(buf)]);
        }).then(function (rs) {
          var text = rs && rs[1];
          if (stale()) return;
          // 登记 Word 原文：docx 面板差异标注的行号坐标系就是它（与编辑器初始文本同一份）。
          // 必须在 setValue 之前登记——编辑器变更随后触发的对比会用新标注覆盖，顺序颠倒会闪回旧标注
          if (DocxView.setSourceText) DocxView.setSourceText(side, text || '');
          if (!text) { cfg.onPanelsChanged(); return; }
          cfg.onPanelText(side, text);
          cfg.onPanelsChanged();                 // docx 已渲染 → 重算主区域3 显隐
        }).catch(function (err) {
          if (!stale()) cfg.toast('加载 Word 文档失败：' + ((err && err.message) || err), true);
        });
      } else if (/\.doc$/i.test(absPath)) {
        // 旧版二进制 .doc 不支持（无法可靠解析），明确提示，不显示乱码
        if (PdfView.clear) PdfView.clear(side);
        if (typeof DocxView !== 'undefined' && DocxView.clear) DocxView.clear(side);
        cfg.onPanelsChanged();
        cfg.toast('暂不支持旧版 .doc 格式，请先用 Word/WPS 另存为 .docx', true);
      } else {
        fetch(url).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status + (r.status === 404 ? '（文件不存在）' : ''));
          return r.text();                        // 否则错误 JSON 会被当成文件内容灌进编辑器
        }).then(function (text) {
          if (stale()) return;
          if (side === 'L') cfg.setText('L', text); else cfg.setText('R', text);
          if (PdfView.clear) PdfView.clear(side);
          if (typeof DocxView !== 'undefined' && DocxView.clear) DocxView.clear(side);
          cfg.onPanelsChanged();                 // 非 PDF 文件：该侧无 PDF → 重算主区域3 显隐
        }).catch(function (err) {
          if (!stale()) cfg.toast('读取文件失败：' + ((err && err.message) || err), true);
        });
      }
    }).catch(function (err) {
      if (!stale()) cfg.toast('读取文件失败：' + ((err && err.message) || err), true);
    });
  }

  // ---------- 扫描版 OCR ----------
  /**
   * OCR 结果磁盘缓存（识别结果复用）：命中返回 {text, items}，未命中/不可用返回 null。
   * 走 serve.js 的 /api/ocr-cache（服务端按 path+size+mtime 算键，文件变化自动失效）；
   * Tauri/离线等无该 API 的环境静默回退（返回 null，走正常 OCR）。
   */
  function ocrCacheGet(absPath) {
    if (typeof fetch !== 'function') return Promise.resolve(null);
    return fetch('/api/ocr-cache?path=' + encodeURIComponent(absPath))
      .then(function (r) {
        return r.json().catch(function () { return null; });
      })
      .then(function (d) {
        return (d && d.ok && d.hit && typeof d.text === 'string' && d.text && Array.isArray(d.items) && d.items.length)
          ? { text: d.text, items: d.items } : null;
      })
      .catch(function () { return null; });
  }
  /** 把一次 OCR 结果写进磁盘缓存（失败静默，不影响主流程）。 */
  function ocrCachePut(absPath, text, items) {
    if (typeof fetch !== 'function') return;
    try {
      fetch('/api/ocr-cache', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: absPath, text: text, items: items })
      }).catch(function () {});
    } catch (e) { /* 忽略 */ }
  }

  /**
   * OCR 渲染缩放（页面 pt → 像素，1pt = 1/72in，故 scale = DPI/72）。
   * 2x 仅 ~144 DPI：会把 300 DPI 扫描件降采样一半，小字号正文被压缩到 ~20px 高，
   * det 热力带断裂 + rec 拉伸失真 → 系统性误识。4x ≈ 288 DPI，接近扫描原生分辨率，
   * 正文约 40px 高，识别质量显著提升。长边封顶防超大页面爆内存。
   */
  var OCR_SCALE = 2;
  var OCR_MAX_SIDE = 4000;
  /** 每页 OCR 前重置该侧 pending 标记 */
  var ocrRunToken = { L: 0, R: 0 };
  /** 该侧当前待 OCR 文件的绝对路径（写结果缓存用；扫描版检测到即登记，弹窗/无头共用） */
  var ocrPathBySide = { L: null, R: null };

  /** 惰性创建 OCR Worker 并加载运行时（ort + 模型 + 字典）。返回 Promise<Worker>。 */
  function ensureOcrWorker() {
    if (ocrWorker && ocrWorkerReady) return Promise.resolve(ocrWorker);
    if (ocrLoading) {
      // 已有加载在途：返回一个等它完成的 Promise
      return new Promise(function (resolve, reject) {
        var tries = 0;
        (function poll() {
          if (ocrWorkerReady) return resolve(ocrWorker);
          if (++tries > 600) return reject(new Error('OCR 运行时加载超时'));
          setTimeout(poll, 100);
        })();
      });
    }
    ocrLoading = true;
    if (cfg.onOcrProgress) cfg.onOcrProgress('L', { phase: 'load' });
    return new Promise(function (resolve, reject) {
      var w;
      try { w = new Worker('src/ocr-worker.js'); }
      catch (e) { ocrLoading = false; reject(new Error('无法创建 OCR Worker（当前环境不支持）：' + e.message)); return; }
      ocrWorker = w;
      var baseUrl = (typeof location !== 'undefined' && location.origin) ? location.origin + '/' : '';
      w.onmessage = function (ev) {
        var m = ev.data || {};
        if (m.type === 'loaded') {
          ocrWorkerReady = true;
          ocrLoading = false;
          resolve(w);
        } else if (m.type === 'error' && m.message) {
          ocrLoading = false;
          reject(new Error(m.message));
        }
      };
      w.onerror = function (e) {
        ocrLoading = false;
        reject(new Error('OCR Worker 出错：' + ((e && e.message) || '未知')));
      };
      w.postMessage({ type: 'load', baseUrl: baseUrl });
    });
  }

  /** 识别该侧扫描版 PDF 全部页，结果注入面板 + 编辑区。返回 Promise。 */
  function runOcr(side) {
    var my = ++ocrSeq;
    ocrPendingSide = null;
    setOcrState(side, 'running');
    var total = (PdfView.getNumPages && PdfView.getNumPages(side)) || 0;
    if (!total) {
      setOcrState(side, 'failed');
      return Promise.reject(new Error('PDF 未加载或页数为 0'));
    }
    // 加载运行时（含首次下载/加载模型的进度提示）
    return ensureOcrWorker().then(function (w) {
      if (my !== ocrSeq) return;            // 已被取消/换文件
      var allText = [], allItems = [];
      var lineOffset = 0;                   // 前面页已占用的行数（textItems 跨页行号连续）
      var chain = Promise.resolve();
      for (var p = 1; p <= total; p++) {
        (function (pageNum) {
          chain = chain.then(function () {
            if (my !== ocrSeq) return Promise.reject(new Error('cancelled'));
            if (cfg.onOcrProgress) cfg.onOcrProgress(side, { phase: 'page', page: pageNum, total: total });
            // 渲染 scale：OCR 对扫描件的正文行识别已由「rec 动态宽度」解决（见 ocr.js），
            // 渲染分辨率不再影响质量（scale2 实测 4gram 87.7% ≥ scale4 的 84.4%，且更快更省内存）。
            // 长边封顶仅防超大页面（A3/图纸）爆内存。
            var effScale = OCR_SCALE;
            return (PdfView.getPageViewport ? PdfView.getPageViewport(side, pageNum, 1) : Promise.resolve(null)).then(function (vp1) {
              if (vp1) {
                var longSide = Math.max(vp1.width, vp1.height) * OCR_SCALE;
                if (longSide > OCR_MAX_SIDE) effScale = Math.max(2, OCR_MAX_SIDE / Math.max(vp1.width, vp1.height));
              }
              return PdfView.renderPageToImage(side, pageNum, effScale);
            });
          }).then(function (img) {
            if (!img) return null;          // 单页渲染失败：跳过该页
            return new Promise(function (resolvePage, rejectPage) {
              var id = ++ocrRunToken[side];
              var byteLength = img.data.byteLength;
              var buf = img.data.buffer;
              var onMsg = function (ev) {
                var m = ev.data || {};
                if (m.id !== id) return;
                w.removeEventListener('message', onMsg);
                if (m.type === 'result') resolvePage(m.result);
                else if (m.type === 'error') rejectPage(new Error(m.message || 'OCR 识别失败'));
              };
              w.addEventListener('message', onMsg);
              w.postMessage({
                type: 'recognize',
                id: id,
                data: buf,
                byteOffset: img.data.byteOffset,
                byteLength: byteLength,
                width: img.width, height: img.height, stride: img.width * 4,
                pageW: img.pageW, pageH: img.pageH, scale: img.scale,
                pageNum: pageNum, startLine: lineOffset
              }, [buf]);                     // 转移所有权：主线程不再持有该页像素
            }).then(function (res) {
              if (!res) return;
              if (res.text) allText.push(res.text);
              if (res.items && res.items.length) {
                var boxesN = res.items[0].boxes.length;
                lineOffset += boxesN;
                allItems = allItems.concat(res.items);
              }
            });
          });
        })(p);
      }
      return chain.catch(function (err) {
        if (String(err && err.message) === 'cancelled') return;   // 被取消：静默结束
        throw err;
      }).then(function () {
        if (my !== ocrSeq) return;
        var text = allText.join('\n');
        if (!text) {
          setOcrState(side, 'failed');
          cfg.toast('OCR 未识别出任何文字（可能是空白页或图片质量过低）', true);
          return;
        }
        PdfView.setOcrResult(side, { text: text, items: allItems });
        cfg.onPanelText(side, text);
        setOcrState(side, 'done');
        if (cfg.onOcrProgress) cfg.onOcrProgress(side, { phase: 'done', pages: total });
        if (ocrPathBySide[side]) ocrCachePut(ocrPathBySide[side], text, allItems);   // 识别结果落盘缓存（下次复用）
        return { text: text, items: allItems };
      });
    }).catch(function (err) {
      if (my !== ocrSeq) return;
      setOcrState(side, 'failed');
      cfg.toast('OCR 失败：' + ((err && err.message) || err), true);
    });
  }

  /** 当前是否有待 OCR 的扫描版（UI 据此显示提示条） */
  function hasPendingOcr() { return ocrPendingSide != null; }
  function getOcrPendingSide() { return ocrPendingSide; }
  function getOcrState(side) { return ocrState[side] || 'idle'; }

  // ---------- 折叠状态 ----------
  function setFoldEnabled(on) { foldEnabled = !!on; }
  function isFoldEnabled() { return foldEnabled; }
  function toggleFold(key) {
    if (expanded[key]) delete expanded[key];
    else expanded[key] = true;
  }
  function resetFold() { expanded = {}; }

  // ---------- 导出 ----------
  root.Pipeline = {
    init: init,
    // 计算
    compare: compare,
    runSync: runSync,
    getResult: function () { return lastResult; },
    getOptions: function () { return lastOptions; },
    // 渲染
    render: render,
    renderGrid: renderGrid,
    reportStats: reportStats,
    setFoldEnabled: setFoldEnabled,
    isFoldEnabled: isFoldEnabled,
    toggleFold: toggleFold,
    resetFold: resetFold,
    // 标注
    annotate: annotate,
    buildAnnotMaps: buildAnnotMaps,
    panelViewer: panelViewer,
    // 字符对齐表
    charMaps: charMaps,
    updateMapMatches: updateMapMatches,
    resetCharMaps: resetCharMaps,
    lineStartsOf: lineStartsOf,
    // 文件加载
    loadSide: loadSide,
    invalidateSide: invalidateSide,
    invalidateAll: invalidateAll,
    docxBytesError: docxBytesError,
    // 扫描版 OCR
    runOcr: runOcr,
    cancelOcr: cancelOcr,
    hasPendingOcr: hasPendingOcr,
    getOcrPendingSide: getOcrPendingSide,
    getOcrState: getOcrState
  };
})(typeof self !== 'undefined' ? self : this);
