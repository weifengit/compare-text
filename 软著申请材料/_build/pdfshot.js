'use strict';
/**
 * pdfshot.js — 把 PDF 的指定页渲染成 PNG（用仓库自带的 pdf.js + headless Edge）。
 *
 * 用途：对生成的鉴别材料做**视觉自检** —— 页眉、页码、每页行数、图表清晰度，
 * 光靠文本层统计看不出排版问题（行溢出、页眉压正文、图被裁）。
 *
 * 用法：node pdfshot.js <pdf路径> <输出目录> [页号,页号...]（页号从 1 起，缺省全部）
 */
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');

var ROOT = path.join(__dirname, '..', '..');
var PORT = 4940 + (process.pid % 200);
var DBG = 9940 + (process.pid % 200);
var BROWSER = process.env.EDGE_PATH ||
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';

var pdfPath = process.argv[2];
var outDir = process.argv[3];
var want = (process.argv[4] || '').split(',').filter(Boolean).map(Number);

if (!pdfPath || !outDir) {
  console.error('用法：node pdfshot.js <pdf路径> <输出目录> [页号,页号…]');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

var serverProc, edgeProc, ws, msgId = 0, pending = {};
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
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
function evaluate(expr) {
  return cdpSend('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    .then(function (r) {
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
      return r.result ? r.result.value : undefined;
    });
}

(async function main() {
  serverProc = cp.spawn(process.execPath, [path.join(ROOT, 'serve.js'), String(PORT)], { stdio: 'ignore' });
  await wait(1200);
  var profile = path.join(os.tmpdir(), 'pdfshot-' + process.pid);
  edgeProc = cp.spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-sandbox',
    '--remote-debugging-port=' + DBG, '--user-data-dir=' + profile,
    'http://127.0.0.1:' + PORT + '/'], { stdio: 'ignore' });

  var target = null;
  for (var k = 0; k < 60; k++) {
    try {
      var list = await (await fetch('http://127.0.0.1:' + DBG + '/json/list')).json();
      target = (list || []).filter(function (x) { return x.type === 'page' && x.url.indexOf('127.0.0.1:' + PORT) !== -1; })[0];
      if (target) break;
    } catch (e) { /* 未就绪 */ }
    await wait(300);
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
  await wait(2000);

  var url = 'http://127.0.0.1:' + PORT + '/api/file?path=' + encodeURIComponent(pdfPath);
  var list = await evaluate('(function(){return fetch(' + JSON.stringify(url) + ').then(r=>r.arrayBuffer()).then(b=>' +
    'pdfjsLib.getDocument({data:b}).promise).then(d=>d.numPages);})()');
  console.log('PDF 共 ' + list + ' 页');
  var pages = want.length ? want : [];
  if (!pages.length) for (var i = 1; i <= list; i++) pages.push(i);

  for (var n = 0; n < pages.length; n++) {
    var pno = pages[n];
    var dataUrl = await evaluate('(function(){return fetch(' + JSON.stringify(url) + ').then(r=>r.arrayBuffer()).then(b=>' +
      'pdfjsLib.getDocument({data:b}).promise).then(async d=>{var p=await d.getPage(' + pno + ');' +
      'var vp=p.getViewport({scale:1.6});var c=document.createElement("canvas");' +
      'c.width=Math.round(vp.width);c.height=Math.round(vp.height);' +
      'var ctx=c.getContext("2d");ctx.fillStyle="#fff";ctx.fillRect(0,0,c.width,c.height);' +
      'await p.render({canvasContext:ctx,viewport:vp}).promise;return c.toDataURL("image/png");});})()');
    var b64 = dataUrl.split(',')[1];
    var out = path.join(outDir, 'p' + String(pno).padStart(3, '0') + '.png');
    fs.writeFileSync(out, Buffer.from(b64, 'base64'));
    console.log('  ' + path.basename(out) + '  ' + (fs.statSync(out).size / 1024).toFixed(0) + 'KB');
  }

  try { ws.close(); } catch (e) {}
  try { edgeProc.kill(); } catch (e) {}
  try { serverProc.kill(); } catch (e) {}
  process.exit(0);
})().catch(function (e) {
  console.error('失败：' + e.stack);
  try { if (ws) ws.close(); } catch (x) {}
  try { if (edgeProc) edgeProc.kill(); } catch (x) {}
  try { if (serverProc) serverProc.kill(); } catch (x) {}
  process.exit(1);
});
