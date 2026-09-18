'use strict';
/**
 * e2e-scroll-anchor.js — 端到端：内容锚定协同滚动（3 主区域 × 左右 6 区块）。
 * 构造两份 PDF：左 4 页/字号20/80 行，右 3 页/字号14/85 行（中段插入10行、删除5行），
 * 页数、字号、版式、行数全部不同 —— 旧比例同步必然错位，内容锚定应对齐到同一文字行。
 * 用 headless Edge + CDP 驱动真实页面验证：
 *   ① 滚 pdfLeft 到左行60 → pdfRight 顶行≈右行65、rightBody 顶行≈65、leftBody 顶行≈60、编辑区同步；
 *   ② 滚 rightBody 到右行40 → leftBody 顶行≈30、pdfLeft 顶行≈30、编辑区同步。
 * 运行：node test/e2e-scroll-anchor.js   （需要本机装有 Edge；自动起 serve.js 3123 端口）
 */
var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var ROOT = path.join(__dirname, '..');
var FIX = path.join(__dirname, 'fixtures-e2e');
// 端口按 pid 错开，避免连上上次失败残留的 Edge/serve 进程（读到旧页面状态）
var HTTP_PORT = 3123 + (process.pid % 200);
var DBG_PORT = 9333 + (process.pid % 200);
var EDGE = process.env.EDGE_PATH ||
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

// ---------- 1. 生成 PDF 夹具 ----------
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
// 左：80 行公共文字；右：行20后插入 10 行、删掉左 46–50 行
var linesL = [];
for (var i = 1; i <= 80; i++) linesL.push('Line ' + ('00' + i).slice(-3) + ' shared content alpha beta');
var linesR = linesL.slice(0, 20)
  .concat(Array.apply(null, { length: 10 }).map(function (_, k) { return 'Inserted extra line ' + (k + 1) + ' of ten'; }))
  .concat(linesL.slice(20, 45)).concat(linesL.slice(50));
function rightLineOf(l) { return l <= 20 ? l : l <= 45 ? l + 10 : l + 5; }
var pagesL = chunk(linesL, 20);   // 4 页，字号 20
var pagesR = chunk(linesR, 40);   // 3 页，字号 14 —— 页数/字号/版式均不同

// ---------- 2. 基础设施：起服务、起 Edge、CDP ----------
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
function check(name, actual, expected, tol) {
  var ok = actual != null && Math.abs(actual - expected) <= tol;
  if (ok) { passed++; console.log('  ok  ' + name + '（' + actual + ' ≈ ' + expected + '）'); }
  else { failed++; console.log('FAIL  ' + name + '：实际 ' + actual + '，期望 ' + expected + ' ±' + tol); }
}

function cleanup() {
  try { if (ws) ws.close(); } catch (e) {}
  try { if (edgeProc) cp.execSync('taskkill /PID ' + edgeProc.pid + ' /T /F 2>nul'); } catch (e2) {}
  try { if (serverProc) serverProc.kill(); } catch (e3) {}
  try { fs.rmSync(FIX, { recursive: true, force: true }); } catch (e4) {}
  try { fs.rmSync(path.join(require('os').tmpdir(), 'edge-e2e-profile-' + process.pid), { recursive: true, force: true }); } catch (e5) {}
}

(async function main() {
  fs.mkdirSync(FIX, { recursive: true });
  fs.writeFileSync(path.join(FIX, 'a.pdf'), buildPdf(pagesL, 20, 26));
  fs.writeFileSync(path.join(FIX, 'b.pdf'), buildPdf(pagesR, 14, 18));

  serverProc = cp.spawn(process.execPath, [path.join(ROOT, 'serve.js'), String(HTTP_PORT)], { stdio: 'ignore' });
  var i;
  for (i = 0; i < 40; i++) { try { await fetchJson('http://127.0.0.1:' + HTTP_PORT + '/api/list?path=' + encodeURIComponent(FIX)); break; } catch (e) { await wait(250); } }

  // Edge 配置目录不能放在夹具根下（否则被当成“子文件夹”选中，PDF 永远轮不到）
  var prof = path.join(require('os').tmpdir(), 'edge-e2e-profile-' + process.pid);
  edgeProc = cp.spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--remote-debugging-port=' + DBG_PORT, '--user-data-dir=' + prof,
    'http://127.0.0.1:' + HTTP_PORT + '/'], { stdio: 'ignore' });

  var targets = null;
  for (var i = 0; i < 60; i++) {
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

  // ---------- 3. 加载对比源 → 等 PDF/文本/对比就绪 → 关“忽略换行”进入 grid ----------
  for (i = 0; i < 40; i++) {   // 等 app.js 初始化完成（CodeMirror 已挂载 → 事件监听就绪）
    var boot = await evaluate('(typeof PdfView!=="undefined")&&!!document.getElementById("srcPathInput")&&!!document.querySelector(".CodeMirror")');
    if (boot) break;
    await wait(300);
  }
  if (!boot) throw new Error('页面脚本未就绪');
  await evaluate('(function(){var i=document.getElementById("srcPathInput");i.value=' + JSON.stringify(FIX.replace(/\\/g, '/')) + ';document.getElementById("srcLoadBtn").click();return 1;})()');
  var ready = false;
  for (i = 0; i < 80; i++) {
    var st = await evaluate('JSON.stringify({l:PdfView.isLoaded("L"),r:PdfView.isLoaded("R"),dl:PdfView._debug("L"),dr:PdfView._debug("R"),rows:(document.getElementById("leftBody")||{children:[]}).children.length})');
    st = JSON.parse(st);
    if (st.l && st.r && st.dl.pages > 0 && st.dr.pages > 0 && st.dl.wraps >= st.dl.pages && st.dr.wraps >= st.dr.pages && st.rows > 10) { ready = true; break; }
    await wait(300);
  }
  if (!ready) throw new Error('页面加载超时：' + JSON.stringify(st));
  await evaluate('(function(){var c=document.getElementById("optIgnoreNewline");if(c.checked){c.checked=false;c.dispatchEvent(new Event("change"));}return 1;})()');
  await wait(1500);   // 防抖 400ms + worker 计算 + 渲染
  var stats = await evaluate('document.getElementById("stats").textContent');
  if (stats.indexOf('行') === -1) throw new Error('应进入 grid 模式（按行统计），实际：' + stats);
  // 展开全部相同行：折叠条会把锚定行吞进区间（定位仍正确，但测试无法逐行断言）；
  // 且展开后区域1 可滚范围增大，探针行远离末尾不会触底钳制
  await evaluate('(function(){var b=document.getElementById("foldBtn");if(b.textContent.indexOf("折叠")!==-1)b.click();return b.textContent;})()');
  await wait(500);

  // 公共探针脚本：topLine=区域1 视口顶部所在 data-ls 行号
  var HELPERS = 'function topLine(el){var k=el.children,st=el.scrollTop,best=null;for(var i=0;i<k.length;i++){var ls=+(k[i].getAttribute("data-ls")||0);if(!ls)continue;if(k[i].offsetTop<=st)best=ls;else break;}return best;}' +
    'var pl=PdfView.getPanel("L"),pr=PdfView.getPanel("R"),lb=document.getElementById("leftBody"),rb=document.getElementById("rightBody");' +
    'var cmL=document.querySelectorAll("#editors .CodeMirror")[0].CodeMirror,scL=cmL.getScrollerElement();';

  // ---------- 4. 探针①：滚 pdfLeft → 左行 60（右侧应为 65） ----------
  var L1 = 60, R1 = rightLineOf(L1);
  await evaluate('(function(){' + HELPERS + 'pl.scrollTop=PdfView.lineOffset("L",' + L1 + ');return 1;})()');
  await wait(400);
  var r1 = JSON.parse(await evaluate('(function(){' + HELPERS +
    'return JSON.stringify({prTop:PdfView.lineAtOffset("R",pr.scrollTop),lbTop:topLine(lb),rbTop:topLine(rb),cmTop:cmL.coordsChar({left:0,top:scL.scrollTop},"local").line+1});})()'));
  check('①滚PDF左→PDF右 按内容对齐', r1.prTop, R1, 2);
  check('①滚PDF左→区域1左列 对齐行', r1.lbTop, L1, 2);
  check('①滚PDF左→区域1右列 按内容对齐', r1.rbTop, R1, 2);
  check('①滚PDF左→编辑区左 对齐行', r1.cmTop, L1, 2);

  // ---------- 5. 探针②：滚 rightBody → 右行 40（左侧应为 30） ----------
  var R2 = 40, L2 = 30;
  await evaluate('(function(){' + HELPERS +
    'var k=rb.children,t=null;for(var i=0;i<k.length;i++){var ls=+(k[i].getAttribute("data-ls")||0),le=+(k[i].getAttribute("data-le")||0)||ls;if(ls&&ls<=' + R2 + '&&' + R2 + '<=le){t=k[i];break;}}' +
    'if(t)rb.scrollTop=t.offsetTop;return 1;})()');
  await wait(400);
  var r2 = JSON.parse(await evaluate('(function(){' + HELPERS +
    'return JSON.stringify({lbTop:topLine(lb),plTop:PdfView.lineAtOffset("L",pl.scrollTop),cmTop:cmL.coordsChar({left:0,top:scL.scrollTop},"local").line+1});})()'));
  check('②滚区域1右列→区域1左列 按内容对齐', r2.lbTop, L2, 2);
  check('②滚区域1右列→PDF左 按内容对齐', r2.plTop, L2, 2);
  check('②滚区域1右列→编辑区左 按内容对齐', r2.cmTop, L2, 2);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
})().catch(function (e) {
  console.log('FAIL  ' + (e && e.message));
  process.exitCode = 1;
}).then(function () { cleanup(); setTimeout(function () { process.exit(process.exitCode || 0); }, 500); });
