'use strict';
/**
 * e2e-pdf-fixes.js — 端到端回归三项修复：
 *  ① “修整”后 PDF 差异标注仍有效（标注坐标系改为 PDF 原文，不再随编辑器行号系失效）；
 *  ② “适应页面”模式同一 PDF 各页统一缩放（夹具末页 MediaBox 故意做窄，旧实现末页会变大）；
 *  ③ 历史记录布局：列表动态撑满侧边栏、“清空全部”固定可见区最底部。
 * 运行：node test/e2e-pdf-fixes.js   （需要本机装有 Edge；自动起 serve.js）
 */
var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var ROOT = path.join(__dirname, '..');
var FIX = path.join(__dirname, 'fixtures-e2e');
var HTTP_PORT = 4000 + (process.pid % 200);
var DBG_PORT = 9700 + (process.pid % 200);
var EDGE = process.env.EDGE_PATH ||
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

// ---------- 夹具：左 4 页（末页 MediaBox 故意窄 500）/80 行；右 3 页/85 行（插10删5） ----------
function esc(s) { return s.replace(/[()\\]/g, ''); }
function buildPdf(pages, fontSize, leading, pageWidths) {
  var n = pages.length;
  var objs = ['%PDF-1.4\n'];
  objs.push('1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n');
  var kids = [];
  for (var i = 0; i < n; i++) kids.push((3 + i) + ' 0 R');
  objs.push('2 0 obj << /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + n + ' >> endobj\n');
  for (var p = 0; p < n; p++) {
    var w = pageWidths[p] || 612;
    objs.push((3 + p) + ' 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + w + ' 792] /Resources << /Font << /F1 ' + (3 + n) + ' 0 R >> >> /Contents ' + (4 + n + p) + ' 0 R >> endobj\n');
  }
  objs.push((3 + n) + ' 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n');
  for (var c = 0; c < n; c++) {
    var st = 'BT /F1 ' + fontSize + ' Tf 72 740 Td ' + leading + ' TL ';
    pages[c].forEach(function (ln, i) { st += (i ? 'T* ' : '') + '(' + esc(ln) + ') Tj '; });
    st += 'ET\n';
    objs.push((4 + n + c) + ' 0 obj << /Length ' + st.length + ' >> stream\n' + st + 'endstream endobj\n');
  }
  objs.push('xref\n0 ' + (5 + n) + '\n0000000000 65535 f \n');
  for (var k = 0; k < 4 + n; k++) objs.push('0000000009 00000 n \n');
  objs.push('trailer << /Size ' + (5 + n) + ' /Root 1 0 R >>\nstartxref\n9\n%%EOF\n');
  return Buffer.from(objs.join(''), 'latin1');
}
function chunk(arr, n) {
  var out = [];
  for (var i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
var linesL = [];
for (var i = 1; i <= 80; i++) linesL.push('Line ' + ('00' + i).slice(-3) + ' shared content alpha beta');
var linesR = linesL.slice(0, 20)
  .concat(Array.apply(null, { length: 10 }).map(function (_, k) { return 'Inserted extra line ' + (k + 1) + ' of ten'; }))
  .concat(linesL.slice(20, 45)).concat(linesL.slice(50));
var MB_L = [612, 612, 612, 500];   // 左 PDF 末页故意做窄：旧“适应页面”末页会被放大

// ---------- CDP 基础设施 ----------
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
      if (res.exceptionDetails) throw new Error('页面内执行异常: ' + JSON.stringify(res.exceptionDetails).slice(0, 400));
      return res.result ? res.result.value : undefined;
    });
}
function poll(expr, pred, tries, label) {
  var last;
  return (function loop(n) {
    return evaluate(expr).then(function (v) {
      last = v;
      if (pred(v)) return v;
      if (n <= 0) throw new Error('等待超时：' + label + '，最后值 ' + JSON.stringify(v).slice(0, 200));
      return wait(300).then(function () { return loop(n - 1); });
    });
  })(tries == null ? 40 : tries);
}

var passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok  ' + name + (detail ? '（' + detail + '）' : '')); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '：' + detail : '')); }
}
function cleanup() {
  try { if (ws) ws.close(); } catch (e) {}
  try { if (edgeProc) cp.execSync('taskkill /PID ' + edgeProc.pid + ' /T /F 2>nul'); } catch (e2) {}
  try { if (serverProc) serverProc.kill(); } catch (e3) {}
  try { fs.rmSync(FIX, { recursive: true, force: true }); } catch (e4) {}
  try { fs.rmSync(path.join(require('os').tmpdir(), 'edge-fix-profile-' + process.pid), { recursive: true, force: true }); } catch (e5) {}
}

(async function main() {
  fs.mkdirSync(FIX, { recursive: true });
  fs.writeFileSync(path.join(FIX, 'a.pdf'), buildPdf(chunk(linesL, 20), 20, 26, MB_L));
  fs.writeFileSync(path.join(FIX, 'b.pdf'), buildPdf(chunk(linesR, 40), 14, 18, [612, 612, 612]));

  serverProc = cp.spawn(process.execPath, [path.join(ROOT, 'serve.js'), String(HTTP_PORT)], { stdio: 'ignore' });
  var i;
  for (i = 0; i < 40; i++) { try { await fetchJson('http://127.0.0.1:' + HTTP_PORT + '/api/list?path=' + encodeURIComponent(FIX)); break; } catch (e) { await wait(250); } }

  edgeProc = cp.spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--remote-debugging-port=' + DBG_PORT, '--user-data-dir=' + path.join(require('os').tmpdir(), 'edge-fix-profile-' + process.pid),
    'http://127.0.0.1:' + HTTP_PORT + '/'], { stdio: 'ignore' });

  var pg = null;
  for (i = 0; i < 60; i++) {
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

  await poll('(typeof PdfView!=="undefined")&&!!document.querySelector(".CodeMirror")', function (v) { return v === true; }, 40, '页面脚本就绪');
  await evaluate('(function(){var i=document.getElementById("srcPathInput");i.value=' + JSON.stringify(FIX.replace(/\\/g, '/')) + ';document.getElementById("srcLoadBtn").click();return 1;})()');
  await poll('JSON.stringify({l:PdfView.isLoaded("L"),r:PdfView.isLoaded("R"),dl:PdfView._debug("L"),dr:PdfView._debug("R"),hl:Object.keys(PdfView.getHighlight("L")).length})',
    function (v) { var s = JSON.parse(v); return s.l && s.r && s.dl.pages > 0 && s.dr.pages > 0 && s.hl > 0; }, 60, 'PDF 加载与初次标注');

  // ---------- ① 修整后 PDF 标注仍有效 ----------
  // 差异事实：左 46–50 行被删（rm）。修整把编辑器压成 1 行——旧实现标注会塌到第 1 行或清空。
  var maxKey = function (v) { return Math.max.apply(null, Object.keys(JSON.parse(v)).map(Number).concat([0])); };
  var before = await evaluate('JSON.stringify(PdfView.getHighlight("L"))');
  var beforeR = await evaluate('JSON.stringify(PdfView.getHighlight("R"))');
  check('修整前 PDF 左标注落在 46–50 行', maxKey(before) >= 46 && maxKey(before) <= 50, '最大标注行=' + maxKey(before));
  await evaluate('document.getElementById("tidyBtn").click()');
  var after = await poll('JSON.stringify(PdfView.getHighlight("L"))', function (v) { return maxKey(v) >= 46; }, 25, '修整后标注重算');
  check('修整后 PDF 左标注仍在 46–50 行（不塌到第 1 行）', maxKey(after) >= 46 && maxKey(after) <= 50, '最大标注行=' + maxKey(after));
  check('修整后左标注与修整前完全一致（PDF 原文坐标系不受编辑器影响）', after === before);
  var afterR = await evaluate('JSON.stringify(PdfView.getHighlight("R"))');
  check('修整后右标注与修整前完全一致', afterR === beforeR);
  await evaluate('document.getElementById("tidyBtn").click()');   // 撤销修整
  await poll('JSON.stringify(PdfView.getHighlight("L"))', function (v) { return maxKey(v) >= 46; }, 25, '撤销修整后标注');

  // ---------- ② 适应页面：同一 PDF 各页统一缩放 ----------
  await evaluate('document.getElementById("pdfFitP").click()');
  await poll('(function(){var w=document.querySelectorAll("#pdfLeft .pdf-page canvas");return w.length===4&&Array.prototype.every.call(w,function(c){return +c.style.width.replace("px","")>0;});})()', function (v) { return v === true; }, 30, '适应页面重排完成');
  var dimsL = JSON.parse(await evaluate('JSON.stringify({w:Array.prototype.map.call(document.querySelectorAll("#pdfLeft .pdf-page canvas"),function(c){return parseFloat(c.style.width);}),cw:document.getElementById("pdfLeft").clientWidth,ch:document.getElementById("pdfLeft").clientHeight})'));
  var scales = dimsL.w.map(function (w, k) { return w / MB_L[k]; });
  var s0 = scales[0];
  var uniform = scales.every(function (s) { return Math.abs(s - s0) / s0 < 0.005; });
  check('适应页面：左 PDF 四页缩放一致（末页 MediaBox 窄也不放大）', uniform, '各页 scale=' + scales.map(function (s) { return s.toFixed(4); }).join(','));
  // 理论值：min(cw/612, ch/792)（各页约束的最严格者；末页 500 宽的 cw/500 不起约束作用）
  var expectS = Math.min((dimsL.cw - 2) / 612, (dimsL.ch - 2) / 792);
  check('适应页面：缩放取所有页约束的最严格者', Math.abs(s0 - expectS) / expectS < 0.01, '实际=' + s0.toFixed(4) + ' 期望=' + expectS.toFixed(4));

  // ---------- ③ 历史记录布局 ----------
  await poll('document.getElementById("historyList").children.length>0', function (v) { return v === true; }, 20, '历史记录有条目');
  var lay = JSON.parse(await evaluate(
    'JSON.stringify((function(){var sb=document.getElementById("sidebar"),hl=document.getElementById("historyList"),cl=document.getElementById("historyClear");' +
    'var cs=getComputedStyle(hl),sbR=sb.getBoundingClientRect(),clR=cl.getBoundingClientRect();' +
    'return {maxH:cs.maxHeight,flexGrow:cs.flexGrow,hidden:cl.hidden,last:sb.lastElementChild===cl,h:hl.clientHeight,vh:window.innerHeight,sb:sb.offsetHeight,sbCollapsed:sb.classList.contains("collapsed"),gap:sbR.bottom-clR.bottom};})())'));
  check('历史列表不再限高（max-height:none）', lay.maxH === 'none', 'maxHeight=' + lay.maxH);
  check('历史列表弹性撑满剩余空间', lay.flexGrow === '1' && lay.h > 0, 'flexGrow=' + lay.flexGrow + ' 高=' + lay.h + ' 侧边栏=' + lay.sb + ' 视口=' + lay.vh + ' collapsed=' + lay.sbCollapsed);
  check('“清空全部”为侧边栏最底部可见元素', !lay.hidden && lay.last && Math.abs(lay.gap) <= 20, 'hidden=' + lay.hidden + ' last=' + lay.last + ' 距底=' + Math.round(lay.gap) + 'px');

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
})().catch(function (e) {
  console.log('FAIL  ' + (e && e.message));
  process.exitCode = 1;
}).then(function () { cleanup(); setTimeout(function () { process.exit(process.exitCode || 0); }, 500); });
