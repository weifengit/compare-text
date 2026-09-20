'use strict';
/** 探针：docx-preview breakPages 的 DOM 结构。一次性调查用，验证后并入 spike-capture.js。 */
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var JSZip = require(path.join(__dirname, '../lib/jszip.min.js'));

var ROOT = path.join(__dirname, '..');
var FIX = path.join(ROOT, '.probe-out', 'fix');
var HTTP_PORT = 4411 + (process.pid % 200);
var DBG_PORT = 9411 + (process.pid % 200);
var EDGE = process.env.EDGE_PATH ||
  (process.platform === 'darwin'
    ? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');

function escXml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function buildDocx(paras, pageBreaks) {
  var body = '';
  for (var i = 0; i < paras.length; i++) {
    body += '<w:p><w:pPr><w:spacing w:before="60" w:after="200"/></w:pPr>'
      + '<w:r><w:t xml:space="preserve">' + escXml(paras[i]) + '</w:t></w:r></w:p>';
    if (pageBreaks && pageBreaks.indexOf(i) !== -1) {
      body += '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    }
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
  for (var i = 1; i <= 30; i++) paras.push('Para ' + ('00' + i).slice(-3) + ' shared content alpha beta gamma delta');
  var pageBreaks = [7, 15, 23];
  fs.writeFileSync(path.join(FIX, 'a.docx'), await buildDocx(paras, pageBreaks));

  serverProc = cp.spawn(process.execPath, [path.join(ROOT, 'serve.js'), String(HTTP_PORT)], { stdio: 'ignore' });
  var k;
  for (k = 0; k < 40; k++) { try { await fetchJson('http://127.0.0.1:' + HTTP_PORT + '/api/list?path=' + encodeURIComponent(FIX)); break; } catch (e) { await wait(250); } }

  var profile = path.join(os.tmpdir(), 'edge-probe-' + process.pid);
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

  // 直接走 Pipeline.loadSide（真实路径；内部调 DocxView.load）
  await evaluate('Pipeline.loadSide("L", ' + JSON.stringify(path.join(FIX, 'a.docx').replace(/\\/g, '/')) + ')');
  await poll('JSON.stringify({l:DocxView.isLoaded("L"),d:DocxView._debug("L"),rows:(document.getElementById("leftBody")||{children:[]}).children.length})',
    function (v) { var s = JSON.parse(v); return s.l && s.d.hasText; }, 60, 'docx 加载');
  await evaluate('document.fonts.ready.then(function(){return 1})');

  // 转储 docx-host 结构
  var dump = await evaluate('(function(){var host=document.querySelector("#pdfLeft .docx-host");if(!host)return "NO HOST";' +
    'var out={hostClass:host.className,childCount:host.children.length,children:[]};' +
    'for(var i=0;i<host.children.length;i++){var c=host.children[i];var secs=c.querySelectorAll?c.querySelectorAll("section").length:0;' +
    'var secs2=c.querySelectorAll?c.querySelectorAll("section.docx").length:0;' +
    'out.children.push({cls:c.className,tag:c.tagName,secs:secs,secsDocx:secs2,scrollH:c.scrollHeight||0});}' +
    'var wrapper=host.querySelector(".docx-wrapper");var secs=wrapper?wrapper.querySelectorAll("section"):[];' +
    'out.pageCount=secs.length;out.pages=[];' +
    'for(var j=0;j<secs.length;j++){var r=secs[j];out.pages.push({cls:r.className,tag:r.tagName,ph:r.offsetHeight,phClient:r.clientHeight});}' +
    'return JSON.stringify(out);})()');
  console.log('DOCX DOM:\n' + JSON.stringify(JSON.parse(dump), null, 2));

  cleanup();
  process.exit(0);
})().catch(function (e) { console.log('FAIL ' + (e && e.message)); cleanup(); process.exit(1); });

function cleanup() {
  try { if (ws) ws.close(); } catch (e) {}
  try { if (edgeProc) edgeProc.kill(); } catch (e2) {}
  try { if (serverProc) serverProc.kill(); } catch (e3) {}
  try { fs.rmSync(path.join(ROOT, '.probe-out'), { recursive: true, force: true }); } catch (e4) {}
  try { fs.rmSync(path.join(os.tmpdir(), 'edge-probe-' + process.pid), { recursive: true, force: true }); } catch (e5) {}
}
