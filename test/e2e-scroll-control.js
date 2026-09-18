'use strict';
/**
 * e2e-scroll-control.js — 端到端：协同滚动的多层面控制（worklist 144）。
 * 左 80 行（字号14，2 页）、右 100 行（字号20，4 页，末 20 行为右侧独有的尾页）→
 * 左先滚到底，右还剩一大段可滚。用 headless Edge + CDP 发真实滚轮验证：
 *   ① 左连续下滚：右 scrollTop 轨迹单调不减（无回弹/抖动）；
 *   ② 左到底后继续滚左：右持续推进到自身 max（边界死锁解除）；
 *   ③ 顶部小幅滚一次：右顶行只跟到第 1 页内容，不跳到第 2 页（不跳页）。
 * 运行：node test/e2e-scroll-control.js   （需要本机装有 Edge）
 */
var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var ROOT = path.join(__dirname, '..');
var FIX = path.join(__dirname, 'fixtures-e2e-ctrl');
var HTTP_PORT = 4123 + (process.pid % 200);
var DBG_PORT = 9444 + (process.pid % 200);
var EDGE = process.env.EDGE_PATH ||
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';

function esc(s) { return s.replace(/[()\\]/g, ''); }
function buildPdf(pages, fontSize, leading) {
  var n = pages.length;
  var objs = ['%PDF-1.4\n'];
  objs.push('1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n');
  var kids = [];
  for (var i = 0; i < n; i++) kids.push((3 + i) + ' 0 R');
  objs.push('2 0 obj << /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + n + ' >> endobj\n');
  for (var p = 0; p < n; p++) {
    objs.push((3 + p) + ' 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ' + (3 + n) + ' 0 R >> >> /Contents ' + (4 + n + p) + ' 0 R >> endobj\n');
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
var linesL = [], linesR = [];
for (var i = 1; i <= 80; i++) {
  var ln = 'Line ' + ('00' + i).slice(-3) + ' shared content alpha beta';
  linesL.push(ln);
  linesR.push(ln);
}
for (i = 81; i <= 100; i++) linesR.push('Line ' + ('00' + i).slice(-3) + ' extra trailing page only');
var pagesL = chunk(linesL, 41);   // 2 页（字号 14）
var pagesR = chunk(linesR, 28);   // 4 页（字号 20，含右侧独有尾页）

function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function fetchJson(url) { return fetch(url).then(function (r) { return r.json(); }); }

var serverProc = null, edgeProc = null, ws = null, msgId = 0;
var pending = {};
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
var passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ok  ' + name + (extra ? '（' + extra + '）' : '')); }
  else { failed++; console.log('FAIL  ' + name + '：' + extra); }
}
function cleanup() {
  try { if (ws) ws.close(); } catch (e) {}
  try { if (edgeProc) edgeProc.kill(); } catch (e2) {}
  try { if (serverProc) serverProc.kill(); } catch (e3) {}
  try { fs.rmSync(FIX, { recursive: true, force: true }); } catch (e4) {}
  try { fs.rmSync(path.join(require('os').tmpdir(), 'edge-ctrl-profile-' + process.pid), { recursive: true, force: true }); } catch (e5) {}
}

(async function main() {
  fs.mkdirSync(FIX, { recursive: true });
  fs.writeFileSync(path.join(FIX, 'a.pdf'), buildPdf(pagesL, 14, 18));
  fs.writeFileSync(path.join(FIX, 'b.pdf'), buildPdf(pagesR, 20, 26));

  serverProc = cp.spawn(process.execPath, [path.join(ROOT, 'serve.js'), String(HTTP_PORT)], { stdio: 'ignore' });
  var i;
  for (i = 0; i < 40; i++) { try { await fetchJson('http://127.0.0.1:' + HTTP_PORT + '/api/list?path=' + encodeURIComponent(FIX)); break; } catch (e) { await wait(250); } }

  var prof = path.join(require('os').tmpdir(), 'edge-ctrl-profile-' + process.pid);
  edgeProc = cp.spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--remote-debugging-port=' + DBG_PORT, '--user-data-dir=' + prof,
    'http://127.0.0.1:' + HTTP_PORT + '/'], { stdio: 'ignore' });

  var targets = null;
  for (i = 0; i < 60; i++) {
    try {
      targets = await fetchJson('http://127.0.0.1:' + DBG_PORT + '/json/list');
      var pg = (targets || []).filter(function (t) { return t.type === 'page' && t.url.indexOf('127.0.0.1:' + HTTP_PORT) !== -1; })[0];
      if (pg) { targets = pg; break; }
    } catch (e) { /* 未就绪 */ }
    await wait(300);
  }
  if (!targets || !targets.webSocketDebuggerUrl) throw new Error('未拿到 Edge 页面目标（Edge 不可用？）');

  ws = new WebSocket(targets.webSocketDebuggerUrl);
  await new Promise(function (res, rej) { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = function (ev) {
    var m = JSON.parse(ev.data);
    if (m.id && pending[m.id]) { var p = pending[m.id]; delete pending[m.id]; m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  };

  for (i = 0; i < 40; i++) {
    var boot = await evaluate('(typeof PdfView!=="undefined")&&!!document.getElementById("srcPathInput")&&!!document.querySelector(".CodeMirror")');
    if (boot) break;
    await wait(300);
  }
  if (!boot) throw new Error('页面脚本未就绪');
  await evaluate('(function(){var i=document.getElementById("srcPathInput");i.value=' + JSON.stringify(FIX.replace(/\\/g, '/')) + ';document.getElementById("srcLoadBtn").click();return 1;})()');
  var ready = false, st;
  for (i = 0; i < 80; i++) {
    st = await evaluate('JSON.stringify({l:PdfView.isLoaded("L"),r:PdfView.isLoaded("R"),dl:PdfView._debug("L"),dr:PdfView._debug("R")})');
    st = JSON.parse(st);
    if (st.l && st.r && st.dl.pages > 0 && st.dr.pages > 0 && st.dl.wraps >= st.dl.pages && st.dr.wraps >= st.dr.pages) { ready = true; break; }
    await wait(300);
  }
  if (!ready) throw new Error('页面加载超时');
  await wait(2000);   // 等 PDF 字符对齐表与对比结果落定

  // 把左面板滚进视口内（headless 窗口 800×600，默认在折叠线下方 → elementFromPoint 为空）
  await evaluate('(function(){PdfView.getPanel("L").scrollIntoView({block:"end"});return 1;})()');
  await wait(200);
  function rect(side) {
    return evaluate('(function(){var p=PdfView.getPanel("' + side + '");var r=p.getBoundingClientRect();' +
      'return JSON.stringify({x:r.left+r.width/2,y:r.top+Math.min(r.height,300),hit:document.elementFromPoint(r.left+r.width/2,r.top+Math.min(r.height,300))?1:0});})()').then(JSON.parse);
  }
  async function wheelAt(side, n, dy) {
    var rc = await rect(side);
    for (var k = 0; k < n; k++) {
      await cdpSend('Input.dispatchMouseEvent', { type: 'mouseWheel', x: rc.x, y: rc.y, deltaX: 0, deltaY: dy });
      await wait(24);
    }
  }
  function snap() {
    return evaluate('(function(){var pl=PdfView.getPanel("L"),pr=PdfView.getPanel("R");' +
      'return JSON.stringify({pl:pl.scrollTop,pr:pr.scrollTop,plL:PdfView.lineAtOffset("L",pl.scrollTop),prL:PdfView.lineAtOffset("R",pr.scrollTop),' +
      'maxL:pl.scrollHeight-pl.clientHeight,maxR:pr.scrollHeight-pr.clientHeight});})()').then(JSON.parse);
  }
  var probe = await evaluate('(function(){var pl=PdfView.getPanel("L");var before=pl.scrollTop;pl.scrollBy(0,50);var after=pl.scrollTop;pl.scrollTop=0;return after-before;})()');
  if (!(probe > 0)) throw new Error('左面板不可滚动（scrollBy 无效）');

  // ---- ① 连续下滚：右轨迹单调不减（无回弹） ----
  var trace = [];
  for (i = 0; i < 30; i++) {
    await cdpSend('Input.dispatchMouseEvent', { type: 'mouseWheel', x: (await rect('L')).x, y: (await rect('L')).y, deltaX: 0, deltaY: 50 });
    await wait(24);
    trace.push(await snap());
  }
  var minDelta = Infinity;
  for (i = 1; i < trace.length; i++) minDelta = Math.min(minDelta, trace[i].pr - trace[i - 1].pr);
  check('① 左连续下滚 30 次：右 scrollTop 无回弹（最小步进 ≥ -6px）', minDelta >= -6,
    '最小步进 ' + minDelta.toFixed(1) + 'px');
  check('① 右随左持续推进（总前进 > 150px）', trace[trace.length - 1].pr - trace[0].pr > 150,
    '右 ' + trace[0].pr.toFixed(0) + '→' + trace[trace.length - 1].pr.toFixed(0) + 'px');

  // ---- ② 边界死锁：左到底，右仍剩内容；继续滚左，右推进到自身 max ----
  await evaluate('(async function(){var pl=PdfView.getPanel("L");pl.scrollTop=pl.scrollHeight-pl.clientHeight;' +
    'pl.dispatchEvent(new Event("scroll"));await new Promise(function(r){setTimeout(r,300);});return 1;})()');
  var before = await snap();
  check('② 左到底后右还剩内容（未到底）', before.pr < before.maxR - 150,
    '右 ' + before.pr.toFixed(0) + '/' + before.maxR.toFixed(0) + '（顶行 ' + before.prL + '）');
  var rcL = await rect('L');
  for (i = 0; i < 40; i++) {
    await cdpSend('Input.dispatchMouseEvent', { type: 'mouseWheel', x: rcL.x, y: rcL.y, deltaX: 0, deltaY: 120 });
    await wait(20);
  }
  await wait(250);
  var after = await snap();
  check('② 左贴边继续滚 → 右推进到自身 max（死锁解除）', after.pr >= after.maxR - 10,
    '右 ' + before.pr.toFixed(0) + '→' + after.pr.toFixed(0) + '（max ' + after.maxR.toFixed(0) + '）');

  // ---- ③ 顶部小幅滚一次：右顶行只跟到第 1 页内容，不跳到第 2 页 ----
  await evaluate('(async function(){var pl=PdfView.getPanel("L");pl.scrollTop=0;' +
    'await new Promise(function(r){setTimeout(r,100);});pl.scrollTop=0;pl.dispatchEvent(new Event("scroll"));' +
    'await new Promise(function(r){setTimeout(r,250);});return 1;})()');
  var top0 = await snap();
  await cdpSend('Input.dispatchMouseEvent', { type: 'mouseWheel', x: (await rect('L')).x, y: (await rect('L')).y, deltaX: 0, deltaY: 50 });
  await wait(200);
  var top1 = await snap();
  check('③ 顶部小幅滚一次：右顶行 ≤ 15（未跳到第 2 页 22 行处）', top1.prL <= 15,
    '右顶行 ' + top0.prL + '→' + top1.prL);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
})().catch(function (e) {
  console.log('FAIL  ' + (e && e.message));
  process.exitCode = 1;
}).then(function () { cleanup(); setTimeout(function () { process.exit(process.exitCode || 0); }, 500); });
