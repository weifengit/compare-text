'use strict';
/** 探针：docx 的滚动容器与页面几何。一次性调查用。 */
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var JSZip = require(path.join(__dirname, '../lib/jszip.min.js'));

var ROOT = path.join(__dirname, '..');
var FIX = path.join(ROOT, '.probe-out2', 'fix');
var HTTP_PORT = 4421 + (process.pid % 200);
var DBG_PORT = 9421 + (process.pid % 200);
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

var SNAP = '(function(){var p=document.getElementById("pdfLeft");' +
  'var hst=p.querySelector(".docx-host"),wr=hst?hst.querySelector(".docx-wrapper"):null;' +
  'var secs=wr?wr.querySelectorAll("section.docx"):[];' +
  'var s=[];for(var i=0;i<secs.length;i++){var r=secs[i].getBoundingClientRect();s.push(Math.round(r.top-p.getBoundingClientRect().top+p.scrollTop));}' +
  'function ov(el){return el?getComputedStyle(el).overflow+"|"+getComputedStyle(el).overflowY:"";}' +
  'return JSON.stringify({panelScrollTop:p.scrollTop,panelScrollH:p.scrollHeight,panelClientH:p.clientHeight,' +
  'panelOv:ov(p),hostOv:ov(hst),hostRect:hst?Math.round(hst.getBoundingClientRect().height):-1,' +
  'hostScrollH:hst?hst.scrollHeight:-1,wrapOv:ov(wr),wrapScrollH:wr?wr.scrollHeight:-1,' +
  'wrapRect:wr?Math.round(wr.getBoundingClientRect().height):-1,' +
  'secTops:s,secHeights:(function(){var a=[];for(var i=0;i<secs.length;i++)a.push(Math.round(secs[i].getBoundingClientRect().height));return a;})()});})()';

(async function main() {
  fs.mkdirSync(FIX, { recursive: true });
  var paras = [];
  for (var i = 1; i <= 60; i++) paras.push('Line ' + ('00' + i).slice(-3) + ' shared content alpha beta gamma delta');
  fs.writeFileSync(path.join(FIX, 'a.docx'), await buildDocx(paras));

  serverProc = cp.spawn(process.execPath, [path.join(ROOT, 'serve.js'), String(HTTP_PORT)], { stdio: 'ignore' });
  var k;
  for (k = 0; k < 40; k++) { try { await fetchJson('http://127.0.0.1:' + HTTP_PORT + '/api/list?path=' + encodeURIComponent(FIX)); break; } catch (e) { await wait(250); } }

  var profile = path.join(os.tmpdir(), 'edge-probe2-' + process.pid);
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

  // 无头布局 + 加载（与 spike 相同顺序）
  await evaluate('(function(){var s=document.createElement("style");s.id="css";' +
    's.textContent="#results,#resultsResize,#editors,#editorsResize{display:none !important}"+' +
    '"#pdfarea{flex:1 1 auto !important;max-height:none !important;margin-top:0 !important}"+' +
    '"#pdfarea .pdf-controls{display:none !important}";document.head.appendChild(s);return 1;})()');
  await wait(400);
  await evaluate('Pipeline.loadSide("L", ' + JSON.stringify(path.join(FIX, 'a.docx').replace(/\\/g, '/')) + ')');
  await poll('JSON.stringify({l:DocxView.isLoaded("L"),d:DocxView._debug("L")})',
    function (v) { var s = JSON.parse(v); return s.l && s.d.hasText; }, 60, 'docx 加载');
  await evaluate('document.fonts.ready.then(function(){return 1})');
  await wait(300);

  console.log('初始: ' + await evaluate(SNAP));
  await evaluate('(function(){var p=document.getElementById("pdfLeft");p.scrollTop=1900;return p.scrollTop;})()');
  await wait(300);
  console.log('scrollTop=1900 后: ' + await evaluate(SNAP));
  await evaluate('(function(){var p=document.getElementById("pdfLeft");p.scrollTop=0;return 1;})()');
  await wait(300);
  // 直接滚 docx-wrapper
  await evaluate('(function(){var p=document.getElementById("pdfLeft");var wr=p.querySelector(".docx-wrapper");wr.scrollTop=1900;return wr.scrollTop;})()');
  await wait(300);
  console.log('wrapper.scrollTop=1900 后: ' + await evaluate(SNAP));

  cleanup();
  process.exit(0);
})().catch(function (e) { console.log('FAIL ' + (e && e.message)); cleanup(); process.exit(1); });

function cleanup() {
  try { if (ws) ws.close(); } catch (e) {}
  try { if (edgeProc) edgeProc.kill(); } catch (e2) {}
  try { if (serverProc) serverProc.kill(); } catch (e3) {}
  try { fs.rmSync(path.join(ROOT, '.probe-out2'), { recursive: true, force: true }); } catch (e4) {}
  try { fs.rmSync(path.join(os.tmpdir(), 'edge-probe2-' + process.pid), { recursive: true, force: true }); } catch (e5) {}
}
