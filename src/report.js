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
 *     pairs:  [{ leftName, rightName, result, shots }]
 *               leftName/rightName: 两侧文件名
 *               result:  Pipeline.getResult()（mode/rows/segs/stats…）
 *               shots:   { L:[{data,w,h}], R:[{data,w,h}] }  每页快照（base64 dataURL）
 *   }
 * 目前只做"左右分栏视图"（阶段 B）：每对 = 头部摘要 + 区域1 左/右差异文本 + 区域3 左/右快照。
 * 批量总览（C1）与 Redline 合并视图（C2）留到阶段 C。
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
    'h1{font-size:18px;margin:0}h2{font-size:15px;margin:14px 0 8px}' +
    '.rep-head{position:sticky;top:0;z-index:5;background:var(--panel);' +
    'border-bottom:1px solid var(--border);padding:10px 16px;display:flex;flex-wrap:wrap;gap:6px 18px;align-items:baseline}' +
    '.rep-meta{display:flex;gap:14px;flex-wrap:wrap;color:var(--muted);font-size:12px;width:100%}' +
    '.rep-stats .ok{color:#1a7f37;font-weight:600}.rep-stats .bad{color:#a02030;font-weight:600}' +
    '.rep-pair{margin:0 16px 20px}' +
    '.rep-pairhead{background:var(--panel);border:1px solid var(--border);border-radius:6px 6px 0 0;' +
    'padding:6px 10px;display:flex;flex-wrap:wrap;gap:6px 14px;align-items:baseline;font-size:12px}' +
    '.rep-pairname{font-weight:600;color:var(--txt)}' +
    '.rep-diff{display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid var(--border);' +
    'border-top:0;border-radius:0 0 6px 6px;overflow:hidden}' +
    '.rep-col{background:var(--panel);min-width:0}.rep-col+.rep-col{border-left:1px solid var(--border)}' +
    '.rep-colhead{background:#eef3f9;border-bottom:1px solid var(--border);padding:4px 10px;' +
    'font-size:12px;color:var(--muted);font-weight:600}' +
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
    '.rep-shot img{max-width:100%;border:1px solid var(--border);border-radius:4px;cursor:zoom-in}' +
    '.rep-shot img.zoomed{max-width:none;cursor:zoom-out}' +
    '.rep-shot .cap{font-size:11px;color:var(--muted);margin-top:4px}' +
    '.rep-empty{padding:20px;color:var(--muted)}';

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

  /** 单对正文：头部摘要 + 区域1 左/右 + 区域3 左/右 */
  function pairHtml(pair) {
    var res = pair.result || {};
    var L = '', R = '';
    if (res.error) {
      L = R = '<div class="rep-empty">对比失败：' + escHtml(res.error) + '</div>';
    } else if (res.mode === 'flow') {
      if (res.skipped) {
        L = R = '<div class="rep-empty">文本过大，忽略换行模式暂无法逐字符对比（' +
          res.leftLen + ' / ' + res.rightLen + ' 字符）。</div>';
      } else { L = flowBody(flowLineRows(res.segsL)); R = flowBody(flowLineRows(res.segsR)); }
    } else if (res.mode === 'grid') {
      var b = gridBodies(res);
      L = b.left; R = b.right;
    } else {
      L = R = '<div class="rep-empty">无对比结果</div>';
    }
    return '<section class="rep-pair">' +
      '<div class="rep-pairhead">' +
      '<span class="rep-pairname">' + escHtml(pair.leftName || '左') + ' ↔ ' + escHtml(pair.rightName || '右') + '</span>' +
      '<span class="rep-stats">' + statsHtml(res) + '</span></div>' +
      '<div class="rep-diff">' +
      '<div class="rep-col"><div class="rep-colhead">原文</div><div class="rep-grid" data-side="L">' + L + '</div></div>' +
      '<div class="rep-col"><div class="rep-colhead">修改后</div><div class="rep-grid" data-side="R">' + R + '</div></div>' +
      '</div>' +
      '<div class="rep-shots"><h2>原始文件快照（含差异标注）</h2><div class="rep-shotcols">' +
      '<div class="rep-shotcol"><div class="rep-colhead">原文</div>' + shotsHtml((pair.shots && pair.shots.L) || []) + '</div>' +
      '<div class="rep-shotcol"><div class="rep-colhead">修改后</div>' + shotsHtml((pair.shots && pair.shots.R) || []) + '</div>' +
      '</div></div>' +
      '</section>';
  }

  var JS = '' +
    '(function(){' +
    'document.querySelectorAll(".rep-shot img").forEach(function(im){' +
    'im.onclick=function(){im.classList.toggle("zoomed");};});' +
    '})();';

  function build(cfg) {
    var pairs = (cfg && cfg.pairs) || [];
    var inner = '';
    for (var i = 0; i < pairs.length; i++) inner += pairHtml(pairs[i]);
    var title = escHtml((cfg && cfg.title) || '文本对比报告');
    return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      '<title>' + title + ' · 对比报告</title>\n<style>\n' + CSS + '\n</style>\n</head>\n<body>\n' +
      '<header class="rep-head"><h1>' + title + '</h1>' +
      '<div class="rep-meta"><span class="rep-time">' + escHtml((cfg && cfg.time) || '') + '</span>' +
      '<span class="rep-count">共 ' + pairs.length + ' 对</span></div></header>\n' +
      inner + '\n' +
      '<script>\n' + JS + '\n<\/script>\n</body>\n</html>\n';
  }

  return { build: build };
});
