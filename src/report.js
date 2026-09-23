/**
 * report.js — 自包含对比报告模板（单文件 HTML，CSS/JS/图片全内联，零安装双击即看）。
 * 数据源是 pipeline.js 的对比结果（grid / flow 两种模式）与无头采集的页面快照。
 * 与页面运行时样式完全解耦：这里的颜色是写死的，页面样式改动不会破坏已导出的报告。
 * 全局暴露：Report
 *
 * Report.build(cfg) -> html 字符串
 *   cfg = {
 *     title:  报告标题
 *     time:   对比时间（字符串，调用方已格式化）
 *     pairs:  [{ leftName, rightName, result, shots, rawText? }]
 *               leftName/rightName: 两侧文件名
 *               result:  Pipeline.getResult()（mode/rows/segs/stats…）
 *               shots:   { L:[{data,w,h}], R:[{data,w,h}] }  每页快照（base64 dataURL）
 *               rawText: { L, R } 修整前原始文本（可选；提供后"取消修整"按钮才有内容切换，
 *                         缺省时按钮仍显示但点击提示无原始文本数据）
 *   }
 * 每对 = 头部摘要 + 双视图（左右分栏 / Redline 合并，报告内一键切换）+ 区域3 左/右快照。
 * 头部右侧按钮组（flex 右对齐，竖线分隔）：【取消修整】【隐藏文字区】｜【左右分栏】【Redline 合并】。
 * 多对时：开头带总览（每对一行：文件名、差异数、锚点超链接），右侧带悬浮导航
 * （参考 base.html #floating-nav：右侧中部固定、半透明胶囊、悬停变实、窄屏收缩）。
 * 一份报告最多 10 对，超出由调用方分卷（本模块不自行分卷，tools/render.js 在入口处拦截）。
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Report = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 与 styles.css 的 diff 色同源（红=删除/原文，绿=新增/修改后），写死以解耦
  var CSS = '' +
    ':root{--bg:#f4f6f8;--panel:#fff;--border:#e1e5e9;--line-num:#9aa4af;--txt:#1c2430;--muted:#6b7683;' +
    '--del-bg:#ffeef0;--del-strong:#f5c2c8;--del-text:#8a1f2f;' +
    '--add-bg:#e7f8ee;--add-strong:#b0ecc8;--add-text:#1a7f37;' +
    '--mono:ui-monospace,"SF Mono","Consolas","Menlo","Courier New",monospace;}' +
    '*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--txt);' +
    'font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;}' +
    'html{scroll-behavior:smooth}' +
    'h1{font-size:18px;margin:0}h2{font-size:15px;margin:14px 0 8px}' +
    '.rep-head{position:sticky;top:0;z-index:5;background:var(--panel);' +
    'border-bottom:1px solid var(--border);padding:10px 16px;display:flex;flex-wrap:wrap;gap:6px 18px;align-items:baseline}' +
    '.rep-meta{display:flex;gap:14px;flex-wrap:wrap;color:var(--muted);font-size:12px;width:100%}' +
    '.rep-stats .ok{color:#1a7f37;font-weight:600}.rep-stats .bad{color:#a02030;font-weight:600}' +
    '.rep-pair{margin:0 16px 20px;scroll-margin-top:60px}' +
    '.rep-pairhead{background:var(--panel);border:1px solid var(--border);border-radius:6px 6px 0 0;' +
    'padding:6px 10px;display:flex;flex-wrap:wrap;gap:6px 14px;align-items:baseline;font-size:12px}' +
    '.rep-pairname{font-weight:600;color:var(--txt)}' +
    '.rep-diff{display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid var(--border);' +
    'border-top:0;border-radius:0 0 6px 6px;overflow:hidden}' +
    '.rep-col{background:var(--panel);min-width:0}.rep-col+.rep-col{border-left:1px solid var(--border)}' +
    '.rep-colhead{background:#eef3f9;border-bottom:1px solid var(--border);padding:4px 10px;' +
    'font-size:12px;color:var(--muted);font-weight:600}' +
    // 左右协同滚动：两栏各自独立滚动容器（等高），JS 同步 scrollTop
    '.rep-sync{overflow:auto;max-height:520px}' +
    '.rep-grid{font-family:var(--mono);font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-all}' +
    '.rep-grid .row{display:flex}.rep-grid .ln{flex:0 0 44px;text-align:right;padding-right:8px;' +
    'color:var(--line-num);user-select:none;border-right:1px solid var(--border);margin-right:8px}' +
    '.rep-grid .content{flex:1;padding-right:8px}.rep-grid .row.empty{min-height:20px}' +
    '.rep-grid .row.same{background:#fff}.rep-grid .row.remove{background:var(--del-bg)}' +
    '.rep-grid .row.add{background:var(--add-bg)}.rep-grid .row.change-l{background:var(--del-bg)}' +
    '.rep-grid .row.change-r{background:var(--add-bg)}' +
    '.hl.rm{background:var(--del-strong);color:var(--del-text)}' +
    '.hl.ad{background:var(--add-strong);color:var(--add-text)}.hl.eq{background:transparent}' +
    '.rep-shots{border:1px solid var(--border);border-top:0;border-radius:0 0 6px 6px;' +
    'background:var(--panel);padding:0 10px 6px}.rep-shots h2{margin:12px 0 8px}' +
    '.rep-shotcols{display:grid;grid-template-columns:1fr 1fr;gap:10px}' +
    '.rep-shotcol{min-width:0}.rep-shotcol+.rep-shotcol{border-left:1px solid var(--border);padding-left:10px}' +
    '.rep-shot{text-align:center;margin-bottom:12px}' +
    // 快照默认「适应宽度」：图片始终铺满所在列宽，原图较窄时不再两侧留白；点击放大到原始像素
    '.rep-shot img{width:100%;height:auto;border:1px solid var(--border);border-radius:4px;cursor:zoom-in}' +
    '.rep-shot img.zoomed{width:auto;max-width:none;height:auto;cursor:zoom-out}' +
    // 快照视图模式（整份报告统一切换，默认适应宽度；与界面 PDF 缩放的「适应宽度」一致）
    '.rep-shotmode{display:flex;gap:4px;align-items:center;margin:0 0 8px}' +
    '.rep-shotmode button{font:inherit;font-size:12px;padding:1px 10px;border:1px solid var(--border);' +
    'background:#fff;border-radius:4px;cursor:pointer;color:var(--muted)}' +
    '.rep-shotmode button.on{background:#eef3f9;color:var(--txt);font-weight:600;border-color:#c8d4e2}' +
    '.rep-shotcol.mode-actual .rep-shot img{width:auto;max-width:100%;height:auto}' +
    '.rep-shot .cap{font-size:11px;color:var(--muted);margin-top:4px}' +
    '.rep-empty{padding:20px;color:var(--muted)}' +
    // C1 批量总览
    '.rep-toc{margin:14px 16px 0;background:var(--panel);border:1px solid var(--border);' +
    'border-radius:6px;padding:8px 12px}' +
    '.rep-toc h2{margin:0 0 6px}' +
    '.rep-toc table{border-collapse:collapse;width:100%;font-size:12px}' +
    '.rep-toc td{padding:3px 8px;border-top:1px solid var(--border);vertical-align:baseline}' +
    '.rep-toc tr:first-child td{border-top:0}' +
    '.rep-toc .rep-toc-no{color:var(--muted);width:30px}' +
    '.rep-toc a{color:#1158c7;text-decoration:none}.rep-toc a:hover{text-decoration:underline}' +
    // C2 双视图切换 + Redline 合并视图（删除=红色删除线，新增=蓝色下划线）
    '.rep-pairbtns{margin-left:auto;display:flex;gap:4px;align-items:center}' +
    '.rep-pairbtns button{font:inherit;font-size:12px;padding:2px 10px;border:1px solid var(--border);' +
    'background:#fff;border-radius:4px;cursor:pointer;color:var(--muted)}' +
    '.rep-pairbtns button.on{background:#eef3f9;color:var(--txt);font-weight:600;border-color:#c8d4e2}' +
    // 每对头部右侧：取消修整/隐藏文字区 与 视图切换 同组，用竖线分隔
    '.rep-pairbtns button[data-raw].on,.rep-pairbtns button[data-hidetext].on{background:#fdf6ec;color:#7a4d12;border-color:#e3c98f}' +
    '.rep-sep{width:1px;background:var(--border);margin:2px 6px;align-self:stretch}' +
    '.rep-rawview{border:1px solid var(--border);border-top:0;background:var(--panel)}' +
    '.rep-rawdiff{display:grid;grid-template-columns:1fr 1fr;gap:0}' +
    '.rep-rawdiff .rep-col+.rep-col{border-left:1px solid var(--border)}' +
    '.rep-rawview .rep-rawpre{padding:6px 10px}' +
    '.rep-rawview pre{margin:0;padding:8px 10px;background:#fbfcfe;border:1px solid var(--border);' +
    'border-radius:4px;font-family:var(--mono);font-size:12px;line-height:1.7;' +
    'white-space:pre-wrap;word-break:break-all;max-height:480px;overflow:auto}' +
    '.rep-rawview[hidden]{display:none}' +
    '.rep-textarea[hidden]{display:none}' +
    '.rep-view[hidden]{display:none}' +
    '.rep-redline{border:1px solid var(--border);border-top:0;background:var(--panel);padding:6px 10px;' +
    'font-family:var(--mono);font-size:12px;line-height:1.7;white-space:pre-wrap;word-break:break-all}' +
    '.rep-redline .rl-line{min-height:20px}' +
    '.rl-del{color:#b3202c;text-decoration:line-through;background:#ffe9eb}' +
    '.rl-ins{color:#1158c7;text-decoration:underline;background:#e8f0fe}' +
    // 右侧悬浮导航（参考 base.html #floating-nav：右侧中部固定、半透明胶囊、悬停变实）
    '.rep-floatnav{position:fixed;right:15px;top:50%;transform:translateY(-50%);z-index:1000;' +
    'background:rgba(255,255,255,.85);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);' +
    'border:1px solid var(--border);border-radius:48px;padding:8px 4px;' +
    'box-shadow:0 15px 40px -10px rgba(0,0,0,.15);opacity:.35;transition:opacity .3s}' +
    '.rep-floatnav:hover{opacity:1}' +
    '.rep-floatnav a{display:flex;align-items:center;justify-content:center;min-width:34px;' +
    'padding:6px 8px;margin:1px 0;border-radius:40px;color:#334155;font-size:12px;' +
    'font-weight:500;text-decoration:none;white-space:nowrap}' +
    '.rep-floatnav a:hover{background:rgba(128,128,128,.2);color:var(--txt)}' +
    // 窄屏收缩：只留 顶部/底部 两项，悬停展开全部（同 base.html 的 <=1200px 行为）
    '@media (max-width:1200px){.rep-floatnav{opacity:.18}.rep-floatnav:hover{opacity:1}' +
    '.rep-floatnav .rep-fn-item{display:none}.rep-floatnav:hover .rep-fn-item{display:flex}}';

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** 行内高亮片段：segs = [{text, cls:'eq'|'rm'|'ad'}]（grid 的 change 行 / flow 的整篇） */
  function segsHtml(segs) {
    var h = '';
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      h += '<span class="hl ' + (s.cls === 'rm' ? 'rm' : s.cls === 'ad' ? 'ad' : 'eq') + '">' +
           escHtml(s.text).replace(/\r/g, '') + '</span>';
    }
    return h;
  }

  function rowHtml(ln, content, cls, extraCls) {
    return '<div class="row ' + cls + (extraCls ? ' ' + extraCls : '') + '">' +
      '<span class="ln">' + ln + '</span><span class="content">' + content + '</span></div>';
  }

  /** grid 渲染：same/change/remove/add */
  function gridBodies(res) {
    var L = res.leftLines, R = res.rightLines;
    var rows = res.rows, n = rows.length, i;
    var leftBody = '', rightBody = '';
    for (i = 0; i < n; i++) {
      var r = rows[i];
      var lnL = r.li >= 0 ? String(r.li + 1) : '';
      var lnR = r.ri >= 0 ? String(r.ri + 1) : '';
      if (r.type === 'equal') {
        leftBody += rowHtml(lnL, escHtml(L[r.li]), 'same');
        rightBody += rowHtml(lnR, escHtml(R[r.ri]), 'same');
      } else if (r.type === 'change') {
        leftBody += rowHtml(lnL, segsHtml(r.segL), 'change-l');
        rightBody += rowHtml(lnR, segsHtml(r.segR), 'change-r');
      } else if (r.type === 'remove') {
        leftBody += rowHtml(lnL, escHtml(L[r.li]), 'remove');
        rightBody += '<div class="row empty"></div>';
      } else { // add
        leftBody += '<div class="row empty"></div>';
        rightBody += rowHtml(lnR, escHtml(R[r.ri]), 'add');
      }
    }
    return { left: leftBody, right: rightBody };
  }

  /** flow 渲染：按原文实际行拆行（保留行号），与并排视图一致 */
  function flowLineRows(segs) {
    var rows = [], cur = [], ln = 1;
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      var parts = String(s.text).split(/(\r\n|\n|\r)/);
      for (var p = 0; p < parts.length; p++) {
        var part = parts[p];
        if (/^(\r\n|\n|\r)$/.test(part)) { rows.push({ n: ln, segs: cur }); cur = []; ln++; }
        else if (part !== '') cur.push({ text: part, cls: s.cls });
      }
    }
    if (cur.length) rows.push({ n: ln, segs: cur });
    return rows;
  }

  function flowBody(rows) {
    var h = '';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var inner = '', j;
      for (j = 0; j < r.segs.length; j++) {
        var s = r.segs[j];
        inner += '<span class="hl ' + (s.cls === 'rm' ? 'rm' : s.cls === 'ad' ? 'ad' : 'eq') + '">' +
                 escHtml(s.text).replace(/\r/g, '') + '</span>';
      }
      h += rowHtml(r.n, inner, '');
    }
    return h;
  }

  // ---------- C2：Redline 合并视图（删除=红色删除线，新增=蓝色下划线，未变=黑色） ----------

  /** Redline 行内片段：rm→rl-del，ad→rl-ins，eq→原样 */
  function rlSegsHtml(segs) {
    var h = '';
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i], t = escHtml(s.text).replace(/\r/g, '');
      if (s.cls === 'rm') h += '<span class="rl-del">' + t + '</span>';
      else if (s.cls === 'ad') h += '<span class="rl-ins">' + t + '</span>';
      else h += t;
    }
    return h;
  }

  /**
   * 合并两侧片段流：segL(eq/rm) 与 segR(eq/ad) 的 eq 段一一对应，
   * 并行交错走——同一位置先出删除（划线）再出新增（下划线），eq 只出一次。
   * grid 的 change 行、flow 的整篇 segs 都适用。
   */
  function mergeSegs(segL, segR) {
    var out = [], i = 0, j = 0;
    while (i < segL.length || j < segR.length) {
      var l = segL[i], r = segR[j];
      if (l && l.cls === 'rm') { out.push(l); i++; }
      else if (r && r.cls === 'ad') { out.push(r); j++; }
      else if (l) { out.push(l); i++; if (r && r.cls === 'eq') j++; }
      else { out.push(r); j++; }
    }
    return out;
  }

  /** grid 的 Redline：按行合并为单栏（remove 整行划线，add 整行下划线，change 行内交错） */
  function redlineGridBody(res) {
    var L = res.leftLines, R = res.rightLines, rows = res.rows, h = '';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i], inner;
      if (r.type === 'equal') inner = escHtml(L[r.li]);
      else if (r.type === 'remove') inner = '<span class="rl-del">' + escHtml(L[r.li]) + '</span>';
      else if (r.type === 'add') inner = '<span class="rl-ins">' + escHtml(R[r.ri]) + '</span>';
      else inner = rlSegsHtml(mergeSegs(r.segL, r.segR));
      h += '<div class="rl-line">' + inner + '</div>';
    }
    return h;
  }

  /** flow 的 Redline：整篇合并后按换行拆行 */
  function redlineFlowBody(res) {
    var rows = flowLineRows(mergeSegs(res.segsL, res.segsR)), h = '';
    for (var i = 0; i < rows.length; i++) h += '<div class="rl-line">' + rlSegsHtml(rows[i].segs) + '</div>';
    return h;
  }

  /** 每对统计文案：grid=行数，flow=字符数；无差异给"内容一致" */
  function statsHtml(res) {
    if (res.error) return '<span class="bad">对比失败</span>';
    if (res.mode === 'flow') {
      if (res.skipped) return '<span class="muted">文本过大，未做逐字符对比</span>';
      var n = (res.addedChars || 0) + (res.removedChars || 0);
      if (n === 0) return '<span class="ok">内容一致（忽略换行）</span>';
      return '修改内容：<span class="bad">增 ' + res.addedChars + '</span> · <span class="bad">删 ' + res.removedChars + '</span> 字符';
    }
    var s = res.stats;
    if (!s) return '';
    var total = s.added + s.removed + s.modified;
    if (total === 0) return '<span class="ok">内容一致（当前忽略选项下）</span>';
    return '修改 <span class="bad">' + s.modified + '</span> · 新增 <span class="ok">' + s.added + '</span> · 删除 <span class="bad">' + s.removed + '</span> 行';
  }

  /** 快照列：一列一段 <img>，点击放大/还原 */
  function shotsHtml(list) {
    if (!list || !list.length) return '<div class="rep-empty">无快照</div>';
    var h = '';
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      h += '<div class="rep-shot"><img src="' + s.data + '" alt="第 ' + (i + 1) + ' 页" loading="lazy">' +
           '<div class="cap">第 ' + (i + 1) + '/' + list.length + ' 页</div></div>';
    }
    return h;
  }

  /** 导航文案：去掉文件格式后缀，取头部最多 5 个字符（不足 5 个全显） */
  function shortName(name) {
    return String(name || '').replace(/\.[^.]+$/, '').slice(0, 5);
  }

  /** 右侧悬浮导航：顶部 / 各对"左名VS右名"缩写（悬停显示完整文件名）/ 底部，纯锚点跳转 */
  function floatNavHtml(pairs) {
    var items = '';
    for (var i = 0; i < pairs.length; i++) {
      var full = (pairs[i].leftName || '左') + ' ↔ ' + (pairs[i].rightName || '右');
      items += '<a class="rep-fn-item" href="#pair-' + (i + 1) + '" title="' + escHtml(full) + '">' +
        escHtml(shortName(pairs[i].leftName) + 'VS' + shortName(pairs[i].rightName)) + '</a>';
    }
    return '<nav class="rep-floatnav"><a href="#top">顶部</a>' + items +
      '<a href="#rep-bottom">底部</a></nav>';
  }

  /** C1 批量总览：每对一行（序号、文件名、差异数、锚点超链接） */
  function tocHtml(pairs) {
    var rows = '';
    for (var i = 0; i < pairs.length; i++) {
      var p = pairs[i];
      rows += '<tr><td class="rep-toc-no">' + (i + 1) + '</td>' +
        '<td><a href="#pair-' + (i + 1) + '">' + escHtml(p.leftName || '左') + ' ↔ ' +
        escHtml(p.rightName || '右') + '</a></td>' +
        '<td class="rep-stats">' + statsHtml(p.result || {}) + '</td></tr>';
    }
    return '<nav class="rep-toc"><h2>总览（共 ' + pairs.length + ' 对）</h2><table>' + rows + '</table></nav>';
  }

  /** 单对正文：头部摘要 + 双视图（左右分栏 / Redline 合并）+ 区域3 左/右快照 */
  function pairHtml(pair, idx) {
    var res = pair.result || {};
    var L = '', R = '', RL = '';
    if (res.error) {
      L = R = RL = '<div class="rep-empty">对比失败：' + escHtml(res.error) + '</div>';
    } else if (res.mode === 'flow') {
      if (res.skipped) {
        L = R = RL = '<div class="rep-empty">文本过大，忽略换行模式暂无法逐字符对比（' +
          res.leftLen + ' / ' + res.rightLen + ' 字符）。</div>';
      } else {
        L = flowBody(flowLineRows(res.segsL)); R = flowBody(flowLineRows(res.segsR));
        RL = redlineFlowBody(res);
      }
    } else if (res.mode === 'grid') {
      var b = gridBodies(res);
      L = b.left; R = b.right; RL = redlineGridBody(res);
    } else {
      L = R = RL = '<div class="rep-empty">无对比结果</div>';
    }
    var raw = pair.rawText || null;
    var rawRes = pair.rawResult || null;
    var rawHtml = '';
    if (raw) {
      if (rawRes && rawRes.mode === 'grid') {
        // 原始文本 diff（保留换行按行对比）：与 split 视图同构的带色网格 + 协同滚动
        var rb = gridBodies(rawRes);
        rawHtml = '<div class="rep-rawview" hidden><div class="rep-rawdiff">' +
          '<div class="rep-col"><div class="rep-colhead">原文（修整前）</div>' +
          '<div class="rep-grid rep-sync" data-side="L">' + rb.left + '</div></div>' +
          '<div class="rep-col"><div class="rep-colhead">修改后（修整前）</div>' +
          '<div class="rep-grid rep-sync" data-side="R">' + rb.right + '</div></div>' +
          '</div></div>';
      } else {
        // 无 diff 数据回退纯文本
        rawHtml = '<div class="rep-rawview" hidden><div class="rep-rawpre">' +
          '<div class="rep-colhead">原文（修整前）</div><pre>' + escHtml(raw.L || '') + '</pre>' +
          '<div class="rep-colhead">修改后（修整前）</div><pre>' + escHtml(raw.R || '') + '</pre>' +
          '</div></div>';
      }
    }
    return '<section class="rep-pair" id="pair-' + (idx + 1) + '">' +
      '<div class="rep-pairhead">' +
      '<span class="rep-pairname">' + escHtml(pair.leftName || '左') + ' ↔ ' + escHtml(pair.rightName || '右') + '</span>' +
      '<span class="rep-stats">' + statsHtml(res) + '</span>' +
      '<span class="rep-pairbtns">' +
      '<button type="button" data-raw="1" title="在 diff 高亮视图与修整前原始文本（保留空格/换行）间切换">取消修整</button>' +
      '<button type="button" data-hidetext="1" title="隐藏/显示文字区（只看快照）">隐藏文字区</button>' +
      '<span class="rep-sep"></span>' +
      '<button type="button" data-view="split" class="on">左右分栏</button>' +
      '<button type="button" data-view="redline">Redline 合并</button>' +
      '</span></div>' +
      '<div class="rep-textarea">' +
      '<div class="rep-view rep-view-split">' +
      '<div class="rep-diff">' +
      '<div class="rep-col"><div class="rep-colhead">原文</div><div class="rep-grid rep-sync" data-side="L">' + L + '</div></div>' +
      '<div class="rep-col"><div class="rep-colhead">修改后</div><div class="rep-grid rep-sync" data-side="R">' + R + '</div></div>' +
      '</div></div>' +
      '<div class="rep-view rep-view-redline" hidden><div class="rep-redline">' + RL + '</div></div>' +
      '</div>' +
      rawHtml +
      '<div class="rep-shots"><h2>原始文件快照（含差异标注）</h2>' +
      '<div class="rep-shotmode"><button type="button" data-shotmode="width" class="on" title="页面铺满所在列宽（消除两侧空白）">适应宽度</button>' +
      '<button type="button" data-shotmode="actual" title="按原始像素大小显示">原始大小</button></div>' +
      '<div class="rep-shotcols">' +
      '<div class="rep-shotcol"><div class="rep-colhead">原文</div>' + shotsHtml((pair.shots && pair.shots.L) || []) + '</div>' +
      '<div class="rep-shotcol"><div class="rep-colhead">修改后</div>' + shotsHtml((pair.shots && pair.shots.R) || []) + '</div>' +
      '</div></div>' +
      '</section>';
  }

  var JS = '' +
    '(function(){' +
    // 双视图切换：数据同源只是渲染不同，切换一对时全部对一起切，并用 localStorage 记住上次选择
    'function apply(view){' +
    'document.querySelectorAll(".rep-pair").forEach(function(sec){' +
    // 视图切换时若处于"取消修整"态，先回到 diff 视图再切（避免 raw 覆盖新视图）
    'var rb0=sec.querySelector("[data-raw]"),rv0=sec.querySelector(".rep-rawview"),ta0=sec.querySelector(".rep-textarea");' +
    'if(rb0&&rb0.classList.contains("on")){rb0.classList.remove("on");rb0.textContent="取消修整";' +
    'if(rv0)rv0.hidden=true;if(ta0)ta0.hidden=false;}' +
    'sec.querySelectorAll(".rep-view").forEach(function(v){v.hidden=!v.classList.contains("rep-view-"+view);});' +
    'sec.querySelectorAll(".rep-pairbtns button[data-view]").forEach(function(b){' +
    'b.classList.toggle("on",b.getAttribute("data-view")===view);});});}' +
    'var saved=null;try{saved=window.localStorage.getItem("repView");}catch(e){}' +
    'apply(saved==="redline"?"redline":"split");' +
    'document.querySelectorAll(".rep-pairbtns button[data-view]").forEach(function(b){' +
    'b.onclick=function(){var v=b.getAttribute("data-view");apply(v);' +
    'try{window.localStorage.setItem("repView",v);}catch(e){}};});' +
    // 修正/取消修整（每对独立）：切换 diff 视图 ↔ 原始文本（保留空格换行）
    'document.querySelectorAll(".rep-pair").forEach(function(sec){' +
    'var rv=sec.querySelector(".rep-rawview"),ta=sec.querySelector(".rep-textarea"),rb=sec.querySelector("[data-raw]");' +
    'if(rb){rb.onclick=function(){if(!rv){alert("该报告未包含修整前原始文本");return;}' +
    'var raw=rb.classList.toggle("on");' +
    'rv.hidden=!raw;if(ta)ta.hidden=raw;' +
    'rb.textContent=raw?"修整":"取消修整";' +
    'rb.title=raw?"恢复 diff 高亮视图（修整后文本）":"显示修整前原始文本（保留空格与换行）";};}' +
    // 隐藏/显示文字区（每对独立）：只看快照
    'var hb=sec.querySelector("[data-hidetext]");' +
    'if(hb){hb.onclick=function(){var hid=hb.classList.toggle("on");' +
    'if(ta)ta.hidden=hid;if(rv)rv.hidden=true;if(rb)rb.classList.remove("on");if(rb)rb.textContent="取消修整";' +
    'hb.textContent=hid?"显示文字区":"隐藏文字区";};}' +
    '});' +
    // 左右协同滚动：每对每个双栏容器（split diff / 原始 diff）内两个 .rep-sync 同步 scrollTop
    'document.querySelectorAll(".rep-diff,.rep-rawdiff").forEach(function(d){' +
    'var cs=d.querySelectorAll(".rep-sync");if(cs.length!==2)return;' +
    'var a=cs[0],b=cs[1],lock=false;' +
    'function sync(src,dst){if(lock)return;lock=true;dst.scrollTop=src.scrollTop;lock=false;}' +
    'a.addEventListener("scroll",function(){sync(a,b);});' +
    'b.addEventListener("scroll",function(){sync(b,a);});' +
    '});' +
    // 快照视图模式切换（默认适应宽度；整份报告统一切换，localStorage 记住选择）
    'document.querySelectorAll(".rep-shots").forEach(function(sec){' +
    'var btns=sec.querySelectorAll("[data-shotmode]");' +
    'function applyMode(m){sec.querySelectorAll(".rep-shotcol").forEach(function(c){' +
    'c.classList.toggle("mode-actual",m==="actual");});' +
    'btns.forEach(function(b){b.classList.toggle("on",b.getAttribute("data-shotmode")===m);});' +
    'try{window.localStorage.setItem("repShotMode",m);}catch(e){}}' +
    'var sm=null;try{sm=window.localStorage.getItem("repShotMode");}catch(e){}' +
    'applyMode(sm==="actual"?"actual":"width");' +
    'btns.forEach(function(b){b.onclick=function(){applyMode(b.getAttribute("data-shotmode"));};});' +
    '});' +
    // 快照点击放大/还原
    'document.querySelectorAll(".rep-shot img").forEach(function(im){' +
    'im.onclick=function(){im.classList.toggle("zoomed");};});' +
    '})();';

  function build(cfg) {
    var pairs = (cfg && cfg.pairs) || [];
    var inner = pairs.length > 1 ? floatNavHtml(pairs) + tocHtml(pairs) : '';
    for (var i = 0; i < pairs.length; i++) inner += pairHtml(pairs[i], i);
    var title = escHtml((cfg && cfg.title) || '文本对比报告');
    return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      '<title>' + title + ' · 对比报告</title>\n<style>\n' + CSS + '\n</style>\n</head>\n<body>\n' +
      // 顶部锚点必须是独立静态元素：id 放在 sticky 头部上时，浏览器认为它已吸附在视口内，点 #top 不滚动
      '<div id="top"></div>\n' +
      '<header class="rep-head"><h1>' + title + '</h1>' +
      '<div class="rep-meta"><span class="rep-time">' + escHtml((cfg && cfg.time) || '') + '</span>' +
      '<span class="rep-count">共 ' + pairs.length + ' 对</span></div></header>\n' +
      inner + '\n<div id="rep-bottom"></div>\n' +
      '<script>\n' + JS + '\n<\/script>\n</body>\n</html>\n';
  }

  return { build: build };
});
