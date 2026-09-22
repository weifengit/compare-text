'use strict';
/**
 * e2e-ocr.js — 端到端验证「扫描版 PDF → OCR → 文本进对比 → 标注在原扫描页」整条链路。
 * 运行：node test/e2e-ocr.js   （需要本机装有 Edge；自动起 serve.js）
 *
 * 流程：
 *   1. 生成「扫描版」PDF 夹具（纯图片页、无文字层），以及一份对照的普通文本 PDF；
 *   2. 浏览器加载扫描版 PDF → 断言 OCR 确认弹窗出现；
 *   3. 点击「OCR 识别」→ 等待完成 → 断言：编辑区出现非空中文文本、PDF 面板有 OCR textItems、
 *      差异标注落在原扫描页上；
 *   4. 另一侧加载文本 PDF → 正常对比无弹窗。
 */
var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var ROOT = path.join(__dirname, '..');
var FIX = path.join(__dirname, 'fixtures-e2e-ocr');
var HTTP_PORT = 4400 + (process.pid % 200);
var DBG_PORT = 9900 + (process.pid % 200);
var EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

// ---------- 夹具：内嵌 JPEG 的扫描版 PDF（无文字层） ----------
var SAMPLE_JPG = path.join(ROOT, 'test', 'fixtures', 'ch_en_num.jpg');   // 323x430 RGB

/** 单页扫描版 PDF：整页铺一张 JPEG（DCTDecode），无任何文本运算符 */
function buildScannedPdf(jpegBytes, w, h, pageW, pageH) {
  var objs = [];
  objs.push('%PDF-1.4\n');
  objs.push('1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n');
  objs.push('2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n');
  objs.push('3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pageW + ' ' + pageH
    + '] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >> endobj\n');
  objs.push('4 0 obj << /Type /XObject /Subtype /Image /Width ' + w + ' /Height ' + h
    + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpegBytes.length + ' >> stream\n');
  objs.push(jpegBytes.toString('latin1'));
  objs.push('\nendstream endobj\n');
  var content = 'q ' + pageW + ' 0 0 ' + pageH + ' 0 0 cm /Im1 Do Q\n';
  objs.push('5 0 obj << /Length ' + content.length + ' >> stream\n' + content + 'endstream endobj\n');
  var n = 6;
  objs.push('xref\n0 ' + n + '\n0000000000 65535 f \n');
  for (var k = 0; k < n - 1; k++) objs.push('0000000009 00000 n \n');
  objs.push('trailer << /Size ' + n + ' /Root 1 0 R >>\nstartxref\n9\n%%EOF\n');
  return Buffer.from(objs.join(''), 'latin1');
}

/** 普通文字版 PDF（可提取文本层） */
function buildTextPdf(text) {
  var esc = function (s) { return s.replace(/[()\\]/g, ''); };
  var lines = text.split('\n');
  var objs = ['%PDF-1.4\n'];
  objs.push('1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n');
  objs.push('2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n');
  objs.push('3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj\n');
  objs.push('4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n');
  var st = 'BT /F1 16 Tf 72 740 Td 22 TL ';
  lines.forEach(function (ln, i) { st += (i ? 'T* ' : '') + '(' + esc(ln) + ') Tj '; });
  st += 'ET\n';
  objs.push('5 0 obj << /Length ' + st.length + ' >> stream\n' + st + 'endstream endobj\n');
  var n = 6;
  objs.push('xref\n0 ' + n + '\n0000000000 65535 f \n');
  for (var k = 0; k < n - 1; k++) objs.push('0000000009 00000 n \n');
  objs.push('trailer << /Size ' + n + ' /Root 1 0 R >>\nstartxref\n9\n%%EOF\n');
  return Buffer.from(objs.join(''), 'latin1');
}

// ---------- CDP 基础设施（照搬 e2e-pdf-fixes） ----------
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
      if (n <= 0) throw new Error('等待超时：' + label + '（最后值 ' + JSON.stringify(last) + '）');
      return wait(400).then(function () { return loop(n - 1); });
    });
  })(tries || 40);
}
function cleanup() {
  try { if (ws) ws.close(); } catch (e0) {}
  try { if (edgeProc) edgeProc.kill(); } catch (e1) {}
  try { if (serverProc) serverProc.kill(); } catch (e3) {}
  try { fs.rmSync(FIX, { recursive: true, force: true }); } catch (e4) {}
  try { fs.rmSync(path.join(require('os').tmpdir(), 'edge-ocr-profile-' + process.pid), { recursive: true, force: true }); } catch (e5) {}
}
var passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

(async function main() {
  fs.mkdirSync(FIX, { recursive: true });
  var jpeg = fs.readFileSync(SAMPLE_JPG);
  var scanned = path.join(FIX, 'scan.pdf');
  fs.writeFileSync(scanned, buildScannedPdf(jpeg, 323, 430, 612, 792));
  var textPdf = path.join(FIX, 'text.pdf');
  fs.writeFileSync(textPdf, buildTextPdf('This is a normal text PDF\nSecond line content\nThird line shared'));

  serverProc = cp.spawn(process.execPath, [path.join(ROOT, 'serve.js'), String(HTTP_PORT)], { stdio: 'ignore' });
  var i;
  for (i = 0; i < 40; i++) { try { await fetchJson('http://127.0.0.1:' + HTTP_PORT + '/api/list?path=' + encodeURIComponent(FIX)); break; } catch (e) { await wait(250); } }

  edgeProc = cp.spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--window-size=1400,1000',
    '--remote-debugging-port=' + DBG_PORT, '--user-data-dir=' + path.join(require('os').tmpdir(), 'edge-ocr-profile-' + process.pid),
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

  await poll('(typeof PdfView!=="undefined")&&(typeof Pipeline!=="undefined")&&!!document.querySelector(".CodeMirror")', function (v) { return v === true; }, 40, '页面脚本就绪');

  // 编辑器内容读取：app.js 的 editorL/editorR 是闭包变量，DOM 上挂 .CodeMirror 的原 textarea
  // 可能被 tab 渲染替换（leftEd.CodeMirror 为 undefined），但实例仍渲染在 .CodeMirror-code。
  // 读取第 0 个（左侧）编辑器的可见文本行内容。
  var leftEditorText = 'document.querySelectorAll(".CodeMirror")[0].querySelector(".CodeMirror-code").textContent';
  var rightEditorText = 'document.querySelectorAll(".CodeMirror")[1].querySelector(".CodeMirror-code").textContent';

  // ---------- ① 加载扫描版 PDF：应弹 OCR 确认框 ----------
  var scanPath = scanned.replace(/\\/g, '/');
  await evaluate('Pipeline.loadSide("L", ' + JSON.stringify(scanPath) + ')');
  await poll('!document.getElementById("ocrMask").hidden', function (v) { return v === true; }, 40, 'OCR 弹窗出现');
  check('加载扫描版 PDF 后 OCR 确认弹窗出现', true);
  var fileNameShown = await evaluate('document.getElementById("ocrFile").textContent');
  check('弹窗显示文件名', fileNameShown === 'scan.pdf', '实际 "' + fileNameShown + '"');

  // ---------- ② 点击 OCR：等待识别完成 ----------
  await evaluate('document.getElementById("ocrGoBtn").click()');
  // 等待：PDF 面板出现 OCR 文本项（setOcrResult 写入）→ 再断言编辑器文本
  await poll('JSON.stringify(PdfView._debug("L"))', function (v) { var s = JSON.parse(v); return s.boxes && s.boxes.reduce(function (a, b) { return a + b; }, 0) > 0; }, 240, 'OCR textItems 进入面板');
  await poll(leftEditorText, function (v) { return /[\u4e00-\u9fff]/.test(v); }, 40, 'OCR 文本写入编辑区');
  var got = await evaluate(leftEditorText);
  check('OCR 完成后编辑区出现非空文本', true);
  check('OCR 文本含中文', /[\u4e00-\u9fff]/.test(got), '实际文本：' + got.slice(0, 60));
  check('OCR 文本识别出样例图关键词"去污"', got.indexOf('去污') >= 0, '实际：' + got.slice(0, 80));
  check('OCR 文本识别出"国标"', got.indexOf('国标') >= 0, '实际：' + got.slice(0, 80));
  var maskHiddenAfter = await poll('document.getElementById("ocrMask").hidden', function (v) { return v === true; }, 20, '弹窗关闭');
  check('OCR 完成后弹窗关闭', maskHiddenAfter === true);

  // ---------- ③ 扫描页上应有 OCR 高亮标注（diff 已基于 OCR 文本跑通） ----------
  // 两侧文本就绪后自动对比 → buildAnnotMaps → computeHlBoxes 在扫描页上画标注
  var hlN = await poll('document.querySelectorAll("#pdfLeft .pdf-hl").length', function (v) { return v > 0; }, 60, '扫描页出现差异标注');
  check('扫描页（PDF 面板）存在差异高亮标注', hlN > 0, '高亮数=' + hlN);

  // 另一侧（R）加载普通文字版 PDF：不应弹 OCR，正常对比
  var textPath = textPdf.replace(/\\/g, '/');
  await evaluate('Pipeline.loadSide("R", ' + JSON.stringify(textPath) + ')');
  await poll(rightEditorText, function (v) { return v.indexOf('normal text PDF') >= 0; }, 30, '右侧文字版 PDF 文本就绪');
  check('右侧加载文字版 PDF 正常提取文本（不弹 OCR）', true);
  await wait(600);
  var maskHidden = await evaluate('document.getElementById("ocrMask").hidden');
  check('加载文字版 PDF 不触发 OCR 弹窗', maskHidden === true);

  // 统计区应有对比结果（两侧文本都就绪后自动对比；扫描版 OCR 文本 vs 文字版 → 必有差异）
  await poll('(function(){var r=Pipeline.getResult();return r&&!r.error&&((r.stats&&r.stats.added+r.stats.removed+r.stats.modified>0)||(r.addedChars&&r.addedChars+r.removedChars>0));})()', function (v) { return v === true; }, 40, '自动对比完成');
  check('扫描版 OCR 文本与文字版对比出差异', true);
  var statsText = await evaluate('document.getElementById("stats").textContent');
  check('统计区显示对比结果', (statsText || '').length > 0, 'stats="' + statsText + '"');

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
})().catch(function (e) {
  console.log('FAIL  ' + (e && e.message));
  process.exitCode = 1;
}).then(function () { cleanup(); setTimeout(function () { process.exit(process.exitCode || 0); }, 500); });
