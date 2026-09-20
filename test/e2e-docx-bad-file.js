'use strict';
/**
 * e2e-docx-bad-file.js — 端到端：读不到 / 不是 docx 的文件，要"说清原因"，而不是把
 * JSZip 的 "End of data reached (data length = 0, asked index = 4). Corrupted zip ?" 甩给用户。
 * 该报错只有一种来源：喂进 JSZip 的字节数是 0。真实场景里就是文件本身是 0 字节
 * （网盘/OneDrive 占位文件没下载到本地、文件仍在写入或同步中、下载中断留下的空文件）。
 * 用 headless Edge + CDP 驱动真实页面，走用户同一条加载链路（FilterBar → loadFileToSide → fetch）：
 *   ① 空文件 → 提示"文件为空（0 字节）"（面板红框与 toast 同一句文案），编辑器内容不被污染；
 *   ② 非 ZIP（.doc 改名/损坏）→ 提示"缺少 ZIP 文件头"，与 ① 区分开；
 *   ③ 截断的真 docx（有 ZIP 头、内容不全）→ 仍交给 JSZip 报错，且不得误判成"文件为空"；
 *   ④ 路径指向已不存在的文件（404）→ 提示 HTTP 404，而不是把错误 JSON 当 docx 解析；
 *   ⑤ 随后加载正常 docx → 照常渲染（预检不误伤好文件）。
 * 运行：node test/e2e-docx-bad-file.js   （需要本机装有 Edge；自动起 serve.js 端口）
 */
var fs = require('fs');
var path = require('path');
var cp = require('child_process');
var JSZip = require(path.join(__dirname, '../lib/jszip.min.js'));

var ROOT = path.join(__dirname, '..');
var FIX = path.join(__dirname, 'fixtures-e2e-docx-bad');
// 端口按 pid 错开，避免连上上次失败残留的进程（读到旧页面状态）
var HTTP_PORT = 3423 + (process.pid % 200);
var DBG_PORT = 9633 + (process.pid % 200);
var EDGE = process.env.EDGE_PATH ||
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

/** 极简 OOXML：单节 + 每行一个段落 */
function buildDocx(paras) {
  var esc = function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  var body = '';
  paras.forEach(function (t) {
    body += '<w:p><w:pPr><w:spacing w:after="200"/></w:pPr><w:r><w:t xml:space="preserve">' + esc(t) + '</w:t></w:r></w:p>';
  });
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
  zip.folder('word').file('document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + body
    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>'
    + '</w:body></w:document>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

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
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (extra ? '：' + extra : '')); }
}
function has(s, sub) { return s != null && String(s).indexOf(sub) >= 0; }

function cleanup() {
  try { if (ws) ws.close(); } catch (e) {}
  try {
    if (edgeProc) {
      if (process.platform === 'win32') cp.execSync('taskkill /PID ' + edgeProc.pid + '/T /F 2>nul');
      else edgeProc.kill();
    }
  } catch (e2) {}
  try { if (serverProc) serverProc.kill(); } catch (e3) {}
  try { fs.rmSync(FIX, { recursive: true, force: true }); } catch (e4) {}
  try { fs.rmSync(path.join(require('os').tmpdir(), 'edge-e2e-docx-bad-' + process.pid), { recursive: true, force: true }); } catch (e5) {}
}

// 页面探针：toast 是 1.6s 后自动消失的临时元素，必须用 MutationObserver 留痕再断言。
// 安装只做一次（window.__toasts 已是数组就不再装），复位由调用方显式做，
// 否则"读状态"这一步自己就把要断言的记录清空了。
var HELPERS =
  'if(!window.__toasts){window.__toasts=[];new MutationObserver(function(ms){ms.forEach(function(m){' +
  'for(var i=0;i<m.addedNodes.length;i++){var n=m.addedNodes[i];' +
  'if(n.classList&&n.classList.contains("toast"))window.__toasts.push(n.textContent);}});' +
  '}).observe(document.body,{childList:true});}' +
  'function state(){var pl=document.getElementById("pdfLeft");' +
  'var cm=document.querySelectorAll("#editors .CodeMirror")[0].CodeMirror;' +
  'return JSON.stringify({toasts:window.__toasts.slice(-4),panelL:pl?pl.innerHTML:"",' +
  'loadedL:DocxView.isLoaded("L"),edL:cm.getValue()});}';
/** 选文件触发加载（与用户在下拉里选文件同一条链路），等界面稳定后取状态 */
function loadAndRead(file, ms) {
  return evaluate('(function(){' + HELPERS + 'window.__toasts.length=0;' +
    'FilterBar.selectFile("L",' + JSON.stringify(FIX.replace(/\\/g, '/') + '/') + '+"' + file + '");return 1;})()')
    .then(function () { return wait(ms || 1200); })
    .then(function () { return evaluate('(function(){' + HELPERS + 'return state();})()'); })
    .then(JSON.parse);
}

(async function main() {
  fs.mkdirSync(FIX, { recursive: true });
  var good = await buildDocx(['First paragraph', 'Second paragraph', 'Third paragraph']);
  fs.writeFileSync(path.join(FIX, 'a.docx'), good);
  fs.writeFileSync(path.join(FIX, 'empty.docx'), Buffer.alloc(0));     // ① 0 字节
  fs.writeFileSync(path.join(FIX, 'garbage.docx'), '这其实是一个文本文件，只是改成了 .docx 后缀\n');  // ② 无 ZIP 头
  fs.writeFileSync(path.join(FIX, 'truncated.docx'), good.slice(0, 120));  // ③ 有 ZIP 头但不完整

  serverProc = cp.spawn(process.execPath, [path.join(ROOT, 'serve.js'), String(HTTP_PORT)], { stdio: 'ignore' });
  var i;
  for (i = 0; i < 40; i++) { try { await fetchJson('http://127.0.0.1:' + HTTP_PORT + '/api/list?path=' + encodeURIComponent(FIX)); break; } catch (e) { await wait(250); } }

  // Edge 配置目录不能放在夹具根下（否则被当成"子文件夹"选中，docx 永远轮不到）
  var prof = path.join(require('os').tmpdir(), 'edge-e2e-docx-bad-' + process.pid);
  edgeProc = cp.spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--window-size=1400,1000',
    '--remote-debugging-port=' + DBG_PORT, '--user-data-dir=' + prof,
    'http://127.0.0.1:' + HTTP_PORT + '/'], { stdio: 'ignore' });

  var target = null;
  for (i = 0; i < 60; i++) {
    try {
      var targets = await fetchJson('http://127.0.0.1:' + DBG_PORT + '/json/list');
      var pg = (targets || []).filter(function (t) { return t.type === 'page' && t.url.indexOf('127.0.0.1:' + HTTP_PORT) !== -1; })[0];
      if (pg) { target = pg; break; }
    } catch (e) { /* 未就绪 */ }
    await wait(300);
  }
  if (!target || !target.webSocketDebuggerUrl) throw new Error('未拿到 Edge 页面目标（Edge 不可用？）');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(function (res, rej) { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = function (ev) {
    var m = JSON.parse(ev.data);
    if (m.id && pending[m.id]) { var p = pending[m.id]; delete pending[m.id]; m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  };

  var boot = false;
  for (i = 0; i < 40; i++) {
    boot = await evaluate('(typeof DocxView!=="undefined")&&(typeof FilterBar!=="undefined")&&!!document.querySelector("#editors .CodeMirror")&&!!document.getElementById("srcPathInput")');
    if (boot) break;
    await wait(300);
  }
  if (!boot) throw new Error('页面脚本未就绪');
  // 选对比源 → 等某侧 docx 渲染好（此时主区域3 可见，面板红框才看得见）
  await evaluate('(function(){var i=document.getElementById("srcPathInput");i.value=' + JSON.stringify(FIX.replace(/\\/g, '/')) + ';document.getElementById("srcLoadBtn").click();return 1;})()');
  await evaluate('(function(){' + HELPERS + 'return 1;})()');   // 尽早挂上 toast 留痕
  var first = await loadAndRead('a.docx', 2500);
  check('前置：正常 docx 能渲染（后面用它对比"预检不误伤好文件"）', first.loadedL && has(first.panelL, 'docx-host'), JSON.stringify(first).slice(0, 300));

  // ---------- ① 0 字节文件（用户报的那个错就来自这里）----------
  var before = first.edL;
  var r1 = await loadAndRead('empty.docx');
  check('①空文件：面板红框说"文件为空（0 字节）"', has(r1.panelL, 'Word 文档加载失败') && has(r1.panelL, '文件为空（0 字节）'), r1.panelL.slice(0, 200));
  check('①空文件：toast 同一句文案（含文件名，便于定位）', has(r1.toasts.join('|'), '文件为空（0 字节）：empty.docx'), JSON.stringify(r1.toasts));
  check('①空文件：不再出现 Corrupted zip 这种看不出原因的报错', !has(r1.toasts.join('|') + r1.panelL, 'Corrupted zip'), JSON.stringify(r1.toasts));
  check('①空文件：编辑器原有内容不被错误内容污染', r1.edL === before, '原 ' + before.length + ' 字符 → 现 ' + r1.edL.length + ' 字符');

  // ---------- ② 非 ZIP：.doc 改名 / 文件损坏 ----------
  var r2 = await loadAndRead('garbage.docx');
  check('②非 ZIP：提示"缺少 ZIP 文件头"（与"空文件"区分开）', has(r2.panelL, '不是有效的 .docx（缺少 ZIP 文件头）') && has(r2.panelL, 'garbage.docx'), r2.panelL.slice(0, 200));
  check('②非 ZIP：toast 也带上文件名', has(r2.toasts.join('|'), '不是有效的 .docx'), JSON.stringify(r2.toasts));

  // ---------- ③ 截断的真 docx：有 ZIP 头 → 预检放行，交给 JSZip 报错（不得误判成"空文件"）----------
  var r3 = await loadAndRead('truncated.docx');
  check('③截断文件：仍是红色失败提示，且不误判成"文件为空"', has(r3.panelL, 'Word 文档加载失败') && !has(r3.panelL, '文件为空（0 字节）'), r3.panelL.slice(0, 200));
  console.log('      （截断文件的实际报错，仍由 JSZip 给出：' + r3.panelL.replace(/<[^>]*>/g, '').slice(0, 120) + '）');

  // ---------- ④ 文件不存在（下拉里选了个已被移走的路径）：404 也要说清是没读到文件 ----------
  var r5 = await loadAndRead('missing.docx');
  check('④文件不存在：提示 HTTP 404，而不是拿错误 JSON 当 docx 解析', has(r5.panelL, 'Word 文档加载失败：HTTP 404') && has(r5.toasts.join('|'), 'HTTP 404'), r5.panelL.slice(0, 200));

  // ---------- ⑤ 预检不误伤：再加载正常 docx 必须照常渲染 ----------
  var r4 = await loadAndRead('a.docx', 2000);
  check('⑤好文件：照常渲染，无错误红框', r4.loadedL && has(r4.panelL, 'docx-host') && !has(r4.panelL, 'pdf-error'), r4.panelL.slice(0, 200));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
})().catch(function (e) {
  console.log('FAIL  ' + (e && e.message));
  process.exitCode = 1;
}).then(function () { cleanup(); setTimeout(function () { process.exit(process.exitCode || 0); }, 500); });
