'use strict';
/**
 * e2e-scroll-docx.js — 端到端：Word(.docx) 面板的协同滚动按"行号锚定"（而非比例同步）。
 * 构造两份真实 .docx（JSZip 现拼 OOXML）：左 60 段；右 65 段 —— 中段插入 10 段、删掉 5 段，
 * 故两侧段落数/内容高度都不同，比例同步在文档中段必然错开好几个段落。
 * 用 headless Edge + CDP 驱动真实页面验证（判据是"面板视口顶部是哪一段文字"，即内容对齐）：
 *   ① 滚 Word 左面板到 Line 030 → Word 右面板顶部 ≈ Line 030、区域1 左右列/编辑区同步到对应行；
 *   ② 滚编辑区左到行 49（Line 025）→ 两侧 Word 面板顶部 ≈ Line 025；
 *   ③ 滚 Word 右面板到 Line 045 → Word 左面板顶部 ≈ Line 045（删掉 5 段后仍按内容对齐）。
 * 运行：node test/e2e-scroll-docx.js   （需要本机装有 Edge；自动起 serve.js 端口）
 */
var fs = require('fs');
var path = require('path');
var cp = require('child_process');
var JSZip = require(path.join(__dirname, '../lib/jszip.min.js'));

var ROOT = path.join(__dirname, '..');
var FIX = path.join(__dirname, 'fixtures-e2e-docx');
// 端口按 pid 错开，避免连上上次失败残留的进程（读到旧页面状态）
var HTTP_PORT = 3323 + (process.pid % 200);
var DBG_PORT = 9533 + (process.pid % 200);
var EDGE = process.env.EDGE_PATH ||
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

// ---------- 1. 生成 docx 夹具 ----------
function escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/** 极简 OOXML：单节 + 每行一个段落（段后间距 200 twips，让文档有可滚动的真实高度） */
function buildDocx(paras) {
  var body = '';
  for (var i = 0; i < paras.length; i++) {
    body += '<w:p><w:pPr><w:spacing w:before="60" w:after="200"/></w:pPr>'
      + '<w:r><w:t xml:space="preserve">' + escXml(paras[i]) + '</w:t></w:r></w:p>';
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

// 左：Line 001..060；右：Line 001..015 → 插入 10 段 → Line 016..035 → 删掉 Line 036..040 → Line 041..060
var LINE = [];
for (var i = 1; i <= 60; i++) LINE.push('Line ' + ('00' + i).slice(-3) + ' shared content alpha beta');
function inserted(k) { return 'Inserted extra paragraph ' + (k + 1) + ' of ten'; }
var rightParas = LINE.slice(0, 15)
  .concat(Array.apply(null, { length: 10 }).map(function (_, k) { return inserted(k); }))
  .concat(LINE.slice(15, 35))
  .concat(LINE.slice(40));
/** 内容行 Line N 在右侧的段序号（1 基）：插入 10 段 → N≥16 后移 10；删掉 036..040 → N≥41 回移 5 */
function rightParaOf(n) { return n <= 15 ? n : (n <= 35 ? n + 10 : n + 5); }
/** mammoth 行号：第 k 段（1 基）恒在第 2k−1 行（mammoth 段间以 "\n\n" 收尾） */
function lineOf(para) { return 2 * para - 1; }

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
  if (ok) { passed++; console.log('  ok  ' + name + '（' + actual + ' ≈ ' + expected + '±' + tol + '）'); }
  else { failed++; console.log('FAIL  ' + name + '：实际 ' + actual + '，期望 ' + expected + ' ±' + tol); }
}
function checkStr(name, actual, expected) {
  if (actual === expected) { passed++; console.log('  ok  ' + name + '（' + actual + '）'); }
  else { failed++; console.log('FAIL  ' + name + '：实际 ' + JSON.stringify(actual) + '，期望 ' + JSON.stringify(expected)); }
}

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
  try { fs.rmSync(path.join(require('os').tmpdir(), 'edge-e2e-docx-' + process.pid), { recursive: true, force: true }); } catch (e5) {}
}

// 探针：区域1 视口顶部行号 / Word 面板视口顶部段落文字 / 编辑区顶部行号
var HELPERS =
  'function topLine(el){var k=el.children,st=el.scrollTop,best=null;for(var i=0;i<k.length;i++){' +
  'var ls=+(k[i].getAttribute("data-ls")||0);if(!ls)continue;if(k[i].offsetTop<=st)best=ls;else break;}return best;}' +
  // 视口顶部所在段落：第一个"底边越过面板顶端"的 <p>（内容对齐的判据）
  'function topPara(el){var ps=el.querySelectorAll("p"),pr=el.getBoundingClientRect();' +
  'for(var i=0;i<ps.length;i++){if(ps[i].getBoundingClientRect().bottom-pr.top>0)return ps[i].textContent;}return null;}' +
  'function paraNo(s){var m=/Line (\\d{3})/.exec(s||"");return m?+m[1]:null;}' +
  'var pl=document.getElementById("pdfLeft"),pr2=document.getElementById("pdfRight");' +
  'var lb=document.getElementById("leftBody"),rb=document.getElementById("rightBody");' +
  'var cmL=document.querySelectorAll("#editors .CodeMirror")[0].CodeMirror;' +
  'var scL=cmL.getScrollerElement();' +
  'function cmTop(){return cmL.coordsChar({left:0,top:scL.scrollTop},"local").line+1;}' +
  'function snap(){return JSON.stringify({docxL:paraNo(topPara(pl)),docxR:paraNo(topPara(pr2)),' +
  'lbTop:topLine(lb),rbTop:topLine(rb),cmTop:cmTop()});}';

(async function main() {
  fs.mkdirSync(FIX, { recursive: true });
  fs.writeFileSync(path.join(FIX, 'a.docx'), await buildDocx(LINE));
  fs.writeFileSync(path.join(FIX, 'b.docx'), await buildDocx(rightParas));

  serverProc = cp.spawn(process.execPath, [path.join(ROOT, 'serve.js'), String(HTTP_PORT)], { stdio: 'ignore' });
  var i;
  for (i = 0; i < 40; i++) { try { await fetchJson('http://127.0.0.1:' + HTTP_PORT + '/api/list?path=' + encodeURIComponent(FIX)); break; } catch (e) { await wait(250); } }

  // Edge 配置目录不能放在夹具根下（否则被当成"子文件夹"选中，docx 永远轮不到）
  var prof = path.join(require('os').tmpdir(), 'edge-e2e-docx-' + process.pid);
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

  // ---------- 3. 加载对比源 → 等 docx/编辑器/对比就绪 → 关"忽略换行"进入 grid ----------
  var boot = false;
  for (i = 0; i < 40; i++) {
    boot = await evaluate('(typeof DocxView!=="undefined")&&!!document.getElementById("srcPathInput")&&!!document.querySelector(".CodeMirror")');
    if (boot) break;
    await wait(300);
  }
  if (!boot) throw new Error('页面脚本未就绪');
  await evaluate('(function(){var i=document.getElementById("srcPathInput");i.value=' + JSON.stringify(FIX.replace(/\\/g, '/')) + ';document.getElementById("srcLoadBtn").click();return 1;})()');

  var st = null, ready = false;
  for (i = 0; i < 80; i++) {
    st = JSON.parse(await evaluate('JSON.stringify({l:DocxView.isLoaded("L"),r:DocxView.isLoaded("R"),' +
      'dl:DocxView._debug("L"),dr:DocxView._debug("R"),toast:(document.querySelector(".toast")||{}).textContent||"",' +
      'rows:(document.getElementById("leftBody")||{children:[]}).children.length})'));
    if (st.l && st.r && st.dl.hasText && st.dr.hasText && st.rows > 10) { ready = true; break; }
    await wait(300);
  }
  if (!ready) throw new Error('Word 面板加载超时：' + JSON.stringify(st));

  // 行号锚点必须可用（这是本用例的核心前提：拿不到锚点就只会退化成比例同步）
  var anchor = JSON.parse(await evaluate('JSON.stringify({' +
    'off:DocxView.lineOffset("L",' + lineOf(30) + '),' +
    'at:DocxView.lineAtOffset("L",DocxView.lineOffset("L",' + lineOf(30) + ')),' +
    'pe:DocxView._debug("L").posEntries})'));
  if (anchor.off == null || anchor.at !== lineOf(30) || !anchor.pe) {
    throw new Error('Word 面板行位索引不可用（协同滚动会退化为比例同步）：' + JSON.stringify(anchor));
  }

  await evaluate('(function(){var c=document.getElementById("optIgnoreNewline");if(c.checked){c.checked=false;c.dispatchEvent(new Event("change"));}return 1;})()');
  await wait(1500);   // 防抖 400ms + worker 计算 + 渲染
  var stats = await evaluate('document.getElementById("stats").textContent');
  if (stats.indexOf('行') === -1) throw new Error('应进入 grid 模式（按行统计），实际：' + stats);
  // 展开全部相同行：折叠条会把锚定行吞进区间（定位仍正确，但无法逐行断言）
  await evaluate('(function(){var b=document.getElementById("foldBtn");if(b.textContent.indexOf("折叠")!==-1)b.click();return b.textContent;})()');
  await wait(500);

  // ---------- 4. 探针①：滚 Word 左面板到 Line 030 → 右面板/区域1/编辑区按内容对齐 ----------
  await evaluate('(function(){' + HELPERS +
    'pl.scrollTop=DocxView.lineOffset("L",' + lineOf(30) + ');return 1;})()');
  await wait(500);
  var r1 = JSON.parse(await evaluate('(function(){' + HELPERS + 'return snap();})()'));
  // 左第 30 段 = Line 030；右侧该内容在右第 40 段（插入 10 段）
  check('①滚Word左→Word右 按内容对齐', r1.docxR, 30, 1);
  check('①滚Word左→区域1左列 对齐行', r1.lbTop, lineOf(30), 3);
  check('①滚Word左→区域1右列 按内容对齐', r1.rbTop, lineOf(rightParaOf(30)), 3);
  check('①滚Word左→编辑区左 对齐行', r1.cmTop, lineOf(30), 3);

  // ---------- 5. 探针②：滚编辑区左到 Line 025 所在行 → 两侧 Word 面板都跟到 Line 025 ----------
  await evaluate('(function(){' + HELPERS +
    'scL.scrollTop=cmL.heightAtLine(' + (lineOf(25) - 1) + ',"local");return 1;})()');
  await wait(500);
  var r2 = JSON.parse(await evaluate('(function(){' + HELPERS + 'return snap();})()'));
  check('②滚编辑区左→Word左 按内容对齐', r2.docxL, 25, 1);
  check('②滚编辑区左→Word右 按内容对齐（右第 35 段）', r2.docxR, 25, 1);

  // ---------- 6. 探针③：滚 Word 右面板到 Line 045（跳过被删的 036..040）----------
  await evaluate('(function(){' + HELPERS +
    'pr2.scrollTop=DocxView.lineOffset("R",' + lineOf(rightParaOf(45)) + ');return 1;})()');
  await wait(500);
  var r3 = JSON.parse(await evaluate('(function(){' + HELPERS + 'return snap();})()'));
  check('③滚Word右→Word左 按内容对齐（删段后不错位）', r3.docxL, 45, 1);
  check('③滚Word右→区域1左列 按内容对齐', r3.lbTop, lineOf(45), 3);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
})().catch(function (e) {
  console.log('FAIL  ' + (e && e.message));
  process.exitCode = 1;
}).then(function () { cleanup(); setTimeout(function () { process.exit(process.exitCode || 0); }, 500); });
