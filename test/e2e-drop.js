/**
 * e2e-drop.js — 端到端：把文件拖进界面完成对比。
 * 运行：node test/e2e-drop.js   （需要本机装有 Edge / Chrome；找不到则跳过，不算失败）
 *
 * 走的是拖拽这条真实入口，证的是"接线"而不是某个函数自洽：
 *   拖入 → 遮罩指出会落到哪一侧 → 松手 → 两侧编辑区出现文件文本 → 差异区出结果
 *   → 两个文件框显示的是真实文件名（而不是内部引用 blobdrop/…）。
 * 单测（test/drop.js）证落点判定与引用登记，这里证它们真的接到了 Pipeline.loadSide 上。
 */
'use strict';
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');

var ROOT = path.join(__dirname, '..');
var HTTP_PORT = 3600 + (process.pid % 200);
var DBG_PORT = 9800 + (process.pid % 200);
var PAGE = 'http://127.0.0.1:' + HTTP_PORT + '/';

function findBrowser() {
  if (process.env.EDGE_PATH && fs.existsSync(process.env.EDGE_PATH)) return process.env.EDGE_PATH;
  var candidates = process.platform === 'darwin'
    ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
       '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
       'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'];
  for (var i = 0; i < candidates.length; i++) {
    if (fs.existsSync(candidates[i])) return candidates[i];
  }
  return null;
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
      if (res.exceptionDetails) {
        throw new Error('页面内执行异常: ' + JSON.stringify(res.exceptionDetails).slice(0, 400));
      }
      return res.result ? res.result.value : undefined;
    });
}
/** 轮询页面表达式直到为真（拖入 → 装载 → 对比是异步的） */
async function waitFor(expr, tries) {
  for (var i = 0; i < (tries || 40); i++) {
    var v = await evaluate(expr);
    if (v) return v;
    await wait(250);
  }
  return null;
}

var passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (extra === undefined ? '' : '：' + String(extra).slice(0, 300))); }
}

function cleanup() {
  try { if (ws) ws.close(); } catch (e) {}
  try { if (edgeProc) edgeProc.kill(); } catch (e2) {}
  try { if (serverProc) serverProc.kill(); } catch (e3) {}
  try { fs.rmSync(path.join(os.tmpdir(), 'edge-e2e-drop-' + process.pid), { recursive: true, force: true }); } catch (e4) {}
}

/**
 * 页面内的拖拽夹具：用真实 DataTransfer 装真实 File，再派发真实 DragEvent。
 * 这是浏览器里唯一能"无人工干预地"复现从系统拖入文件的方式。
 */
var PAGE_HELPERS = [
  'window.__mkFiles = function (list) {',
  '  var dt = new DataTransfer();',
  '  list.forEach(function (f) { dt.items.add(new File([f.text], f.name, { type: "text/plain" })); });',
  '  return dt;',
  '};',
  // 二进制文件（docx / pdf / xlsx）拖入：字节要在页面内造出来，证明 blob 引用不只对纯文本管用
  'window.__mkBinary = function (name, b64, mime) {',
  '  var bin = atob(b64), arr = new Uint8Array(bin.length);',
  '  for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);',
  '  var dt = new DataTransfer();',
  '  dt.items.add(new File([arr], name, { type: mime }));',
  '  return dt;',
  '};',
  // 落点坐标取自 #layout 实际矩形：窗口尺寸变了也不会算到界面外
  'window.__dropPoint = function (frac) {',
  '  var r = document.getElementById("layout").getBoundingClientRect();',
  '  return { x: Math.round(r.left + r.width * frac), y: Math.round(r.top + 40) };',
  '};',
  'window.__drag = function (type, dt, p) {',
  '  var ev = new DragEvent(type, { dataTransfer: dt, clientX: p.x, clientY: p.y, bubbles: true, cancelable: true });',
  '  window.dispatchEvent(ev);',
  '  return ev.defaultPrevented;',
  '};',
  'window.__mask = function () {',
  '  var m = document.querySelector(".drop-mask");',
  '  if (!m) return null;',
  '  return { hidden: !!m.hidden, L: m.children[0].classList.contains("on"), R: m.children[1].classList.contains("on"),',
  '           hint: m.querySelector(".drop-hint").textContent, pe: getComputedStyle(m).pointerEvents };',
  '};',
  '1'
].join('\n');

(async function main() {
  var browser = findBrowser();
  if (!browser) {
    console.log('未找到 Edge / Chrome，跳过 e2e-drop（不算失败）');
    process.exit(0);
  }

  var env = Object.assign({}, process.env, { HOST: '127.0.0.1' });
  serverProc = cp.spawn(process.execPath, [path.join(ROOT, 'serve.js'), String(HTTP_PORT)], { stdio: 'ignore', env: env });
  var i;
  for (i = 0; i < 40; i++) {
    try { await fetchJson('http://127.0.0.1:' + HTTP_PORT + '/api/list?path=' + encodeURIComponent(ROOT)); break; }
    catch (e) { await wait(250); }
  }

  var prof = path.join(os.tmpdir(), 'edge-e2e-drop-' + process.pid);
  edgeProc = cp.spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--window-size=1400,1000', '--remote-debugging-port=' + DBG_PORT, '--user-data-dir=' + prof, PAGE],
    { stdio: 'ignore' });

  var target = null;
  for (i = 0; i < 80; i++) {
    try {
      var targets = await fetchJson('http://127.0.0.1:' + DBG_PORT + '/json/list');
      target = (targets || []).filter(function (t) {
        return t.type === 'page' && t.url.indexOf('127.0.0.1:' + HTTP_PORT) !== -1;
      })[0];
      if (target) break;
    } catch (e) { /* 调试端口未就绪 */ }
    await wait(250);
  }
  if (!target || !target.webSocketDebuggerUrl) {
    console.log('FAIL  没连上浏览器调试端口'); cleanup(); process.exit(1);
  }

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(function (res, rej) { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = function (ev) {
    var m = JSON.parse(ev.data);
    if (m.id && pending[m.id]) {
      var q = pending[m.id]; delete pending[m.id];
      m.error ? q.reject(new Error(m.error.message)) : q.resolve(m.result);
    }
  };
  await cdpSend('Runtime.enable');

  // 页面脚本就绪：新模块没进 index.html 或加载顺序错，这里就先失败，
  // 而不是让后面每条断言都因为 DropZone undefined 而莫名报错。
  var boot = await waitFor('(typeof DropZone !== "undefined") && (typeof LocalFile !== "undefined")'
    + ' && !!(FilterBar && FilterBar.addExtraOption) && !!document.querySelector("#editors .CodeMirror")', 40);
  if (!boot) { console.log('FAIL  页面脚本未就绪（dropzone.js / local-file.js 没加载？）'); cleanup(); process.exit(1); }

  await evaluate(PAGE_HELPERS);

  // 默认勾着「忽略换行」→ 差异按字符算；这里关掉，让结论按"行"给出，断言才有意义
  await evaluate('(function(){var cb=document.getElementById("optIgnoreNewline");'
    + 'if(cb&&cb.checked){cb.checked=false;cb.dispatchEvent(new Event("change",{bubbles:true}));}return 1;})()');

  console.log('drop e2e\n');

  // ---------- ① 拖拽过程中：遮罩指明落点，且自己不抢命中 ----------
  var leftPt = await evaluate('JSON.stringify(window.__dropPoint(0.25))').then(JSON.parse);
  var rightPt = await evaluate('JSON.stringify(window.__dropPoint(0.75))').then(JSON.parse);

  await evaluate('window.__drag("dragover", window.__mkFiles([{name:"旧版.txt",text:"a"}]), ' + JSON.stringify(leftPt) + ')');
  var m1 = await evaluate('JSON.stringify(window.__mask())').then(JSON.parse);
  check('1-1. 拖一个文件到左半区：遮罩只亮左侧，提示写明落到「原文」',
    m1 && m1.hidden === false && m1.L === true && m1.R === false && m1.hint.indexOf('原文') >= 0, JSON.stringify(m1));
  check('1-2. 遮罩不参与命中判定（pointer-events:none）——否则落点会被遮罩自己顶掉',
    m1 && m1.pe === 'none', m1 && m1.pe);

  await evaluate('window.__drag("dragover", window.__mkFiles([{name:"旧版.txt",text:"a"}]), ' + JSON.stringify(rightPt) + ')');
  var m2 = await evaluate('JSON.stringify(window.__mask())').then(JSON.parse);
  check('1-3. 同一份文件移到右半区：亮起的一侧跟着变',
    m2 && m2.L === false && m2.R === true && m2.hint.indexOf('修改后') >= 0, JSON.stringify(m2));

  await evaluate('window.__drag("dragover", window.__mkFiles([{name:"旧版.txt",text:"a"},{name:"新版.txt",text:"b"}]), '
    + JSON.stringify(leftPt) + ')');
  var m3 = await evaluate('JSON.stringify(window.__mask())').then(JSON.parse);
  check('1-4. 一次拖两个文件：两侧同时亮，提示带上两个文件名',
    m3 && m3.L === true && m3.R === true && m3.hint.indexOf('旧版.txt') >= 0 && m3.hint.indexOf('新版.txt') >= 0,
    JSON.stringify(m3));

  // ---------- ② 松手：两个文件落到两侧，差异出结果 ----------
  await evaluate('window.__drag("drop", window.__mkFiles(['
    + '{name:"旧版对比.txt",text:"第一行\\n旧内容\\n第三行\\n"},'
    + '{name:"新版对比.txt",text:"第一行\\n新内容\\n第三行\\n第四行\\n"}'
    + ']), ' + JSON.stringify(leftPt) + ')');

  var loaded = await waitFor('(function(){'
    + 'var cm=document.querySelectorAll("#editors .CodeMirror")[0].CodeMirror;'
    + 'var cr=document.querySelectorAll("#editors .CodeMirror")[1].CodeMirror;'
    + 'return (cm.getValue().indexOf("旧内容")>=0 && cr.getValue().indexOf("新内容")>=0)?1:0;})()', 40);
  check('2-1. 拖入的两个文件都被读进两侧编辑区', !!loaded);

  var texts = await evaluate('(function(){'
    + 'var cm=document.querySelectorAll("#editors .CodeMirror")[0].CodeMirror;'
    + 'var cr=document.querySelectorAll("#editors .CodeMirror")[1].CodeMirror;'
    + 'return JSON.stringify({L:cm.getValue(),R:cr.getValue()});})()').then(JSON.parse);
  check('2-2. 左侧装的是第一个文件（原文）',
    texts && texts.L.indexOf('旧内容') >= 0 && texts.L.indexOf('新内容') < 0, JSON.stringify(texts && texts.L));
  check('2-3. 右侧装的是第二个文件（修改后）',
    texts && texts.R.indexOf('新内容') >= 0 && texts.R.indexOf('第四行') >= 0, JSON.stringify(texts && texts.R));

  // 装载完成后还有一次防抖对比，统计要等它跑完才算数
  var stats = await waitFor('(function(){var s=document.getElementById("stats").textContent;'
    + 'return (s.indexOf("行")>=0)?s:"";})()', 40);
  check('2-4. 差异按行算出来了：修改 1 · 新增 1',
    !!stats && stats.indexOf('修改 1') >= 0 && stats.indexOf('新增 1') >= 0, stats);

  var maskGone = await evaluate('(function(){var m=document.querySelector(".drop-mask");return !m||!!m.hidden;})()');
  check('2-5. 落定后遮罩收起', !!maskGone);

  // ---------- ③ 文件框显示的是真实文件名，而不是内部引用 ----------
  var boxes = await evaluate('(function(){'
    + 'function label(id){var el=document.getElementById(id);var inp=el&&el.querySelector(".cb-input");return inp?inp.value:"";}'
    + 'return JSON.stringify({L:label("fileSelL"),R:label("fileSelR"),'
    + '  refL:(FilterBar.getSelected?FilterBar.getSelected("L"):""),'
    + '  isRef:(typeof LocalFile!=="undefined")&&LocalFile.isRef(FilterBar.getSelected("L"))});})()').then(JSON.parse);
  check('3-1. 左侧文件框显示第一个文件的文件名', boxes && boxes.L === '旧版对比.txt', boxes && boxes.L);
  check('3-2. 右侧文件框显示第二个文件的文件名', boxes && boxes.R === '新版对比.txt', boxes && boxes.R);
  check('3-3. 内部引用被 LocalFile 认领（下游装载与磁盘文件同一条链路）',
    boxes && boxes.isRef === true, boxes && boxes.refL);

  // ---------- ④ 单文件拖入：按落点只换一侧 ----------
  await evaluate('window.__drag("drop", window.__mkFiles([{name:"单侧覆盖.txt",text:"左侧被替换\\n"}]), '
    + JSON.stringify(leftPt) + ')');
  var single = await waitFor('(function(){'
    + 'var cm=document.querySelectorAll("#editors .CodeMirror")[0].CodeMirror;'
    + 'var cr=document.querySelectorAll("#editors .CodeMirror")[1].CodeMirror;'
    + 'return (cm.getValue().indexOf("左侧被替换")>=0)?1:0;})()', 40);
  var after = await evaluate('(function(){'
    + 'var cm=document.querySelectorAll("#editors .CodeMirror")[0].CodeMirror;'
    + 'var cr=document.querySelectorAll("#editors .CodeMirror")[1].CodeMirror;'
    + 'var el=document.getElementById("fileSelL").querySelector(".cb-input");'
    + 'var er=document.getElementById("fileSelR").querySelector(".cb-input");'
    + 'return JSON.stringify({L:cm.getValue(),R:cr.getValue(),nameL:el.value,nameR:er.value});})()').then(JSON.parse);
  check('4-1. 拖到左半区的单个文件替换了左侧', !!single && after.L.indexOf('左侧被替换') >= 0, JSON.stringify(after && after.L));
  check('4-2. 右侧不受影响（仍是上一个文件）',
    !!after && after.R.indexOf('新内容') >= 0 && after.nameR === '新版对比.txt', after && after.nameR);
  check('4-3. 左侧文件框跟着换名', !!after && after.nameL === '单侧覆盖.txt', after && after.nameL);

  // ---------- ⑤ 二进制文件（docx）：blob 引用不只对纯文本管用 ----------
  var docxB64 = fs.readFileSync(path.join(__dirname, 'fixtures', 'gdherb-std.docx')).toString('base64');
  await evaluate('window.__drag("drop", window.__mkBinary("标准原文.docx", ' + JSON.stringify(docxB64)
    + ', "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), '
    + JSON.stringify(leftPt) + ')');
  var docxOk = await waitFor('(function(){return (typeof DocxView!=="undefined" && DocxView.isLoaded("L"))?1:0;})()', 80);
  check('5-1. 拖入 .docx：Word 面板按二进制正常渲染（MIME 与字节通道都对）', !!docxOk);

  var docxText = await evaluate('(function(){'
    + 'var cm=document.querySelectorAll("#editors .CodeMirror")[0].CodeMirror;'
    + 'var el=document.getElementById("fileSelL").querySelector(".cb-input");'
    + 'return JSON.stringify({len:cm.getValue().length,name:el.value});})()').then(JSON.parse);
  check('5-2. docx 正文被提进左侧编辑区', !!docxText && docxText.len > 0, JSON.stringify(docxText));
  check('5-3. 文件框显示 docx 文件名', !!docxText && docxText.name === '标准原文.docx', docxText && docxText.name);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch(function (e) {
  console.log('FAIL  用例异常：' + (e && e.message));
  cleanup();
  process.exit(1);
});
