'use strict';
/** 探针2：复刻 spike 的 docx 加载序列，追踪 scrollTop 在滚动后是否/何时被拉回。 */
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var JSZip = require(path.join(__dirname, '../lib/jszip.min.js'));

var ROOT = path.join(__dirname, '..');
var FIX = path.join(ROOT, '.probe-out3b', 'fix');
var HTTP_PORT = 4431 + (process.pid % 200);
var DBG_PORT = 9431 + (process.pid % 200);
var EDGE = process.env.EDGE_PATH ||
  (process.platform === 'darwin'
    ? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');

function escXml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function buildDocx(paras) {
  var body = '';
  for (var i = 0; i < paras.length; i++) {
    body += '<w:p><w:pPr><w:spacing w:before="60" w:after="200"/></w:pPr>'
      + '<w:r><w:t xml:space="preserve">' + escXml(paras[i]) + '</w:t></w:r></w:p>';
    if (i === 14 || i === 29 || i === 44) body += '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  }
  var doc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + body
    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
    + '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>'
    + '</w:body></w:document>';
  var zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>');
  zip.folder('_rels').file('.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>');
  zip.folder('word').file('document.xml', doc);
  return zip.generateAsync({ type: 'nodebuffer' });
}

function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function fetchJson(url) { return fetch(url).then(function (r) { return r.json(); }); }
var serverProc = null, edgeProc = null, ws = null, msgId = 0, pending = {};
function cdpSend(method, params) {
  return new Promise(function (resolve, reject) {
    var id = ++msgId;
    pending[id] = { resolve: resolve, reject: reject };
    ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
  });
}
function evaluate(expr) {
  return cdpSend('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    .then(function (res) {
      if (res.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(res.exceptionDetails).slice(0, 400));
      return res.result ? res.result.value : undefined;
    });
}
function poll(expr, pred, tries, label) {
  return (function loop(n) {
    return evaluate(expr).then(function (v) {
      if (pred(v)) return v;
      if (n <= 0) throw new Error('等待超时：' + label + '，最后值 ' + JSON.stringify(v).slice(0, 300));
      return wait(300).then(function () { return loop(n - 1); });
    });
  })(tries == null ? 40 : tries);
}

(async function main() {
  fs.mkdirSync(FIX, { recursive: true });
  var paras = [];
  for (var i = 1; i <= 60; i++) paras.push('Line ' + ('00' + i).slice(-3) + ' shared content alpha beta gamma delta');
  fs.writeFileSync(path.join(FIX, 'a.docx'), await buildDocx(paras));
  var right = paras.slice(0, 3).concat(['Inserted paragraph A of two', 'Inserted paragraph B of two'])
    .concat(paras.slice(3, 5)).concat(paras.slice(6));
  right[0] = 'Line 001 MODIFIED content alpha beta gamma delta';
  fs.writeFileSync(path.join(FIX, 'b.docx'), await buildDocx(right));

  serverProc = cp.spawn(process.execPath, [path.join(ROOT, 'serve.js'), String(HTTP_PORT)], { stdio: 'ignore' });
  var k;
  for (k = 0; k < 40; k++) { try { await fetchJson('http://127.0.0.1:' + HTTP_PORT + '/api/list?path=' + encodeURIComponent(FIX)); break; } catch (e) { await wait(250); } }

  var profile = path.join(os.tmpdir(), 'edge-probe3b-' + process.pid);
  edgeProc = cp.spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    '--window-size=1600,1400', '--remote-debugging-port=' + DBG_PORT, '--user-data-dir=' + profile,
    'http://127.0.0.1:' + HTTP_PORT + '/'], { stdio: 'ignore' });

  var pg = null;
  for (k = 0; k < 60; k++) {
    try {
      var list = await fetchJson('http://127.0.0.1:' + DBG_PORT + '/json/list');
      pg = (list || []).filter(function (t) { return t.type === 'page' && t.url.indexOf('127.0.0.1:' + HTTP_PORT) !== -1; })[0];
      if (pg) break;
    } catch (e) { /* 未就绪 */ }
    await wait(300);
  }
  if (!pg) throw new Error('未拿到 Edge 页面目标');
  ws = new WebSocket(pg.webSocketDebuggerUrl);
  await new Promise(function (res, rej) { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = function (ev) {
    var m = JSON.parse(ev.data);
    if (m.id && pending[m.id]) { var p = pending[m.id]; delete pending[m.id]; m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  };
  await poll('(typeof DocxView!=="undefined")&&!!document.querySelector(".CodeMirror")', function (v) { return v === true; }, 40, '页面脚本就绪');

  // 复刻 spike：先注入布局再加载两侧
  await evaluate('(function(){var s=document.createElement("style");s.id="css";' +
    's.textContent="#results,#resultsResize,#editors,#editorsResize{display:none !important}"+' +
    '"#pdfarea{flex:1 1 auto !important;max-height:none !important;margin-top:0 !important}"+' +
    '"#pdfarea .pdf-controls{display:none !important}";document.head.appendChild(s);return 1;})()');
  await wait(400);
  await evaluate('(function(){' +
    'Pipeline.loadSide("L", ' + JSON.stringify(path.join(FIX, 'a.docx').replace(/\\/g, '/')) + ');' +
    'Pipeline.loadSide("R", ' + JSON.stringify(path.join(FIX, 'b.docx').replace(/\\/g, '/')) + ');return 1;})()');
  await poll('JSON.stringify({l:DocxView.isLoaded("L"),r:DocxView.isLoaded("R"),' +
    'd:DocxView._debug("L"),res:(function(){var x=Pipeline.getResult();return x?{err:!!x.error,mode:x.mode}:null;})()})',
    function (v) { var s = JSON.parse(v); return s.l && s.r && s.d.hasText && s.res && !s.res.err; }, 80, '加载+对比');
  await evaluate('document.fonts.ready.then(function(){return 1})');
  await wait(500);

  // 复刻 spike：解除协同滚动
  await evaluate('(function(){try{if(typeof SyncScroll!=="undefined"&&SyncScroll.rebind){SyncScroll.rebind([]);SyncScroll.rebind=function(){return;};return "ok";}}catch(e){return "err:"+e.message;}return "absent";})()');
  await wait(500);

  // 滚动到第 2 页并每 100ms 采样 scrollTop，看是否/何时被拉回
  var target = await evaluate('(function(){var p=document.getElementById("pdfLeft");' +
    'var el=p.querySelectorAll(".docx-wrapper section.docx")[1];' +
    'var want=Math.min(Math.max(0,el.getBoundingClientRect().top-p.getBoundingClientRect().top+p.scrollTop-4),p.scrollHeight-p.clientHeight);' +
    'p.scrollTop=want;return Math.round(want);})()');
  console.log('目标 scrollTop=' + target);
  for (var t = 0; t < 2000; t += 200) {
    await wait(200);
    var st = await evaluate('JSON.stringify({st:document.getElementById("pdfLeft").scrollTop,' +
      'vis:(function(){var p=document.getElementById("pdfLeft");var secs=p.querySelectorAll(".docx-wrapper section.docx");' +
      'var er=secs[1].getBoundingClientRect(),pr=p.getBoundingClientRect();' +
      'return Math.round(Math.min(pr.bottom,er.bottom)-Math.max(pr.top,er.top));})()})');
    console.log('  +' + t + 'ms  ' + st);
  }

  cleanup();
  process.exit(0);
})().catch(function (e) { console.log('FAIL ' + (e && e.message)); cleanup(); process.exit(1); });

function cleanup() {
  try { if (ws) ws.close(); } catch (e) {}
  try { if (edgeProc) edgeProc.kill(); } catch (e2) {}
  try { if (serverProc) serverProc.kill(); } catch (e3) {}
  try { fs.rmSync(path.join(ROOT, '.probe-out3'), { recursive: true, force: true }); } catch (e4) {}
  try { fs.rmSync(path.join(os.tmpdir(), 'edge-probe3b-' + process.pid), { recursive: true, force: true }); } catch (e5) {}
}
