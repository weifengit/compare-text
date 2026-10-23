'use strict';
/**
 * pdfgen.js — 用 headless Edge（CDP Page.printToPDF）把分页内容渲染成 PDF。
 *
 * 为什么不用纯 Node 手写 PDF：软著材料需要**页眉 + 右上角页码 + 中文字体**，
 * 手写 PDF 要内嵌 CJK 字体（体积大、许可复杂）。交给浏览器渲染则天然具备：
 *   · 中文用系统字体（宋体/苹方）排版，不缺字；
 *   · 页眉页码用 Chrome 的 headerTemplate（页码在右上角，官方要求）；
 *   · 页面尺寸、边距按毫米精确指定。
 *
 * toPdf({ outFile, title, headerLeft, page, bodyCss, pages })
 *   pages: [{ type:'code', lines:[…] } | { type:'flow', html:'…' }]
 */

var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');

var BROWSER = process.env.EDGE_PATH ||
  (process.platform === 'darwin'
    ? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 逐页渲染成 HTML（每页一个 .pg 容器，page-break-after 控制分页） */
function pagesToHtml(cfg) {
  // rawHtml：调用方已自备完整 HTML（自行控制 @page 与样式），直接使用
  if (cfg.rawHtml) return cfg.rawHtml;

  var body = cfg.pages.map(function (p) {
    if (p.type === 'code') {
      return '<div class="pg">' + p.lines.map(function (l) {
        return '<div class="ln">' + esc(l) + '</div>';
      }).join('') + '</div>';
    }
    return '<div class="pg">' + p.html + '</div>';
  }).join('\n');

  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>' +
    esc(cfg.title || '') + '</title><style>' +
    '@page{size:' + cfg.page.widthMm + 'mm ' + cfg.page.heightMm + 'mm;' +
    'margin:' + cfg.page.marginTopMm + 'mm ' + cfg.page.marginRightMm + 'mm ' +
    cfg.page.marginBottomMm + 'mm ' + cfg.page.marginLeftMm + 'mm;}' +
    'html,body{margin:0;padding:0;}' +
    (cfg.bodyCss || '') +
    '</style></head><body>' + body + '</body></html>';
}

/** 打印用的页眉模板：左=软件名，右=页码（官方要求页码在右上角） */
function headerTemplate(left) {
  return '<div style="font-family:sans-serif;font-size:9pt;width:100%;' +
    'padding:0 ' + '18mm' + ';color:#000;display:flex;justify-content:space-between;">' +
    '<span>' + esc(left) + '</span>' +
    '<span class="pageNumber"></span>' +
    '</div>';
}

/**
 * 生成 PDF。
 * 返回 Promise<{ outFile, bytes, pages, html }>
 */
function toPdf(cfg) {
  var html = pagesToHtml(cfg);
  var tmpHtml = path.join(os.tmpdir(), 'pdfgen-' + process.pid + '-' + Date.now() + '.html');
  fs.writeFileSync(tmpHtml, html);

  var dbgPort = 9920 + (process.pid % 300);
  var profile = path.join(os.tmpdir(), 'pdfgen-prof-' + process.pid);
  var proc = null, ws = null, msgId = 0, pending = {};

  function cdpSend(method, params, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var id = ++msgId;
      var t = setTimeout(function () { delete pending[id]; reject(new Error('CDP 超时 ' + method)); }, timeoutMs || 120000);
      pending[id] = {
        resolve: function (v) { clearTimeout(t); resolve(v); },
        reject: function (e) { clearTimeout(t); reject(e); }
      };
      ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    });
  }

  return (async function () {
    proc = cp.spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-sandbox',
      '--remote-debugging-port=' + dbgPort, '--user-data-dir=' + profile, 'about:blank'],
    { stdio: 'ignore' });

    var target = null;
    for (var k = 0; k < 80; k++) {
      if (proc.exitCode !== null) throw new Error('浏览器进程提前退出');
      try {
        var list = await (await fetch('http://127.0.0.1:' + dbgPort + '/json/list')).json();
        target = (list || []).filter(function (x) { return x.type === 'page'; })[0];
        if (target) break;
      } catch (e) { /* 未就绪 */ }
      await new Promise(function (r) { setTimeout(r, 250); });
    }
    if (!target) throw new Error('未拿到浏览器页面目标');

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(function (res, rej) { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = function (ev) {
      var m = JSON.parse(ev.data);
      if (m.id && pending[m.id]) {
        var p = pending[m.id]; delete pending[m.id];
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      }
    };

    await cdpSend('Page.enable');
    await cdpSend('Page.navigate', { url: 'file://' + tmpHtml }, 30000);
    await new Promise(function (r) { setTimeout(r, 1500); });

    var r = await cdpSend('Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: headerTemplate(cfg.headerLeft || cfg.title || ''),
      footerTemplate: '<div></div>',
      marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
      paperWidth: cfg.page.widthMm / 25.4,
      paperHeight: cfg.page.heightMm / 25.4
    }, 180000);

    var buf = Buffer.from(r.data, 'base64');
    fs.writeFileSync(cfg.outFile, buf);

    try { ws.close(); } catch (e) {}
    try { proc.kill(); } catch (e) {}
    try { fs.unlinkSync(tmpHtml); } catch (e) {}

    return { outFile: cfg.outFile, bytes: buf.length, pages: countPdfPages(buf), html: html };
  })().catch(function (e) {
    try { if (ws) ws.close(); } catch (x) {}
    try { if (proc) proc.kill(); } catch (x) {}
    try { fs.unlinkSync(tmpHtml); } catch (x) {}
    throw e;
  });
}

/** 数 PDF 页数：统计 "/Type /Page" 对象（排除 /Pages） */
function countPdfPages(buf) {
  var s = buf.toString('latin1');
  var m = s.match(/\/Type\s*\/Page[^s]/g);
  return m ? m.length : 0;
}

module.exports = { toPdf: toPdf, countPdfPages: countPdfPages, pagesToHtml: pagesToHtml };
