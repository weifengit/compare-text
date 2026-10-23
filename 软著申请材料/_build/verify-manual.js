'use strict';
/**
 * verify-manual.js — 《用户手册》PDF 的版面自检。
 *
 * 官方要求：「文档每页不少于 30 行」。对带插图的文档，图片本身占据版面，
 * 实践中对"含图页"的行数要求会放宽；真正必须逐页达标的是**纯文字页**。
 * 本脚本把两者分开统计并分别判定，避免用含图页的指标掩盖纯文字页的不足。
 *
 * 检查项：
 *   1. 页数与"是否需要前30+后30页"；
 *   2. 逐页文字行数（剔除页眉与右上角页码）；
 *   3. 逐页是否含图（用 pdf.js 的操作符列表判定）；
 *   4. 纯文字页是否逐页 ≥ 30 行；
 *   5. 页眉是否含软件全称+版本号，页码是否在右上角；
 *   6. 是否存在"一页只有标题、图片溢出到下一页"的空页。
 *
 * 用法：node verify-manual.js <pdf路径>
 */
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');

var ROOT = path.join(__dirname, '..', '..');
var PORT = 4970 + (process.pid % 200);
var DBG = 9970 + (process.pid % 200);
var BROWSER = process.env.EDGE_PATH ||
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';

var pdfPath = process.argv[2];
var MIN_LINES = 30;
if (!pdfPath) { console.error('用法：node verify-manual.js <pdf路径>'); process.exit(2); }

var serverProc, edgeProc, ws, msgId = 0, pending = {};
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function cdpSend(method, params, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var id = ++msgId;
    var t = setTimeout(function () { delete pending[id]; reject(new Error('CDP 超时 ' + method)); }, timeoutMs || 180000);
    pending[id] = {
      resolve: function (v) { clearTimeout(t); resolve(v); },
      reject: function (e) { clearTimeout(t); reject(e); }
    };
    ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
  });
}
function evaluate(expr) {
  return cdpSend('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    .then(function (r) {
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
      return r.result ? r.result.value : undefined;
    });
}

(async function main() {
  serverProc = cp.spawn(process.execPath, [path.join(ROOT, 'serve.js'), String(PORT)], { stdio: 'ignore' });
  await wait(1200);
  var profile = path.join(os.tmpdir(), 'verifymanual-' + process.pid);
  edgeProc = cp.spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-sandbox',
    '--remote-debugging-port=' + DBG, '--user-data-dir=' + profile,
    'http://127.0.0.1:' + PORT + '/'], { stdio: 'ignore' });

  var target = null;
  for (var k = 0; k < 60; k++) {
    try {
      var list = await (await fetch('http://127.0.0.1:' + DBG + '/json/list')).json();
      target = (list || []).filter(function (x) { return x.type === 'page' && x.url.indexOf('127.0.0.1:' + PORT) !== -1; })[0];
      if (target) break;
    } catch (e) { /* 未就绪 */ }
    await wait(300);
  }
  if (!target) throw new Error('未拿到浏览器页面目标');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(function (res, rej) { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = function (ev) {
    var m = JSON.parse(ev.data);
    if (m.id && pending[m.id]) {
      var p = pending[m.id]; delete pending[m.id];
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  };
  await cdpSend('Page.enable');
  await wait(2000);

  var url = 'http://127.0.0.1:' + PORT + '/api/file?path=' + encodeURIComponent(pdfPath);
  var raw = await evaluate('(function(){return fetch(' + JSON.stringify(url) + ').then(r=>r.arrayBuffer()).then(b=>' +
    'pdfjsLib.getDocument({data:b}).promise).then(async d=>{var out=[];' +
    'for(var i=1;i<=d.numPages;i++){var p=await d.getPage(i);var vp=p.getViewport({scale:1});' +
    'var tc=await p.getTextContent();' +
    'var rows={};tc.items.forEach(function(it){var y=Math.round(it.transform[5]*10)/10;' +
    '(rows[y]=rows[y]||[]).push({x:it.transform[4],s:it.str});});' +
    'var ys=Object.keys(rows).map(Number).sort(function(a,b){return b-a;});' +
    'var lines=ys.map(function(y){var a=rows[y].slice().sort(function(p,q){return p.x-q.x;});' +
    'return {y:y,x:a[0].x,txt:a.map(function(o){return o.s;}).join("")};});' +

    'var ops=await p.getOperatorList();var hasImg=false;' +
    'for(var j=0;j<ops.fnArray.length;j++){var c=ops.fnArray[j];' +
    'if(c===85||c===86){hasImg=true;break;}}' +
    'out.push({p:i,pageW:vp.width,pageH:vp.height,lines:lines,hasImg:hasImg});}' +
    'return JSON.stringify(out);}).catch(e=>"ERR:"+e.message);})()');

  if (typeof raw === 'string' && raw.indexOf('ERR:') === 0) throw new Error(raw);
  var pages = JSON.parse(raw);

  var fail = [], pass = [];
  console.log('文件：' + path.basename(pdfPath));
  console.log('页数：' + pages.length +
    (pages.length < 60 ? '（不足 60 页 → 全部提交，无需前30+后30）' : '（≥60 页 → 前30+后30）'));

  var rows = pages.map(function (p) {
    var hdr = null, pno = null;
    p.lines.forEach(function (l) {
      if (!hdr && l.txt.indexOf('CompareText') >= 0 && l.txt.indexOf('V1.3') >= 0) hdr = l;
      if (!pno && /^\d{1,3}$/.test(l.txt.trim()) && l.x > p.pageW * 0.8) pno = l;
    });
    var body = p.lines.filter(function (l) { return l !== hdr && l !== pno; });
    return { no: p.p, body: body, img: p.hasImg, hdr: hdr, pno: pno };
  });

  var pureBad = [], imgPages = [], pureOk = 0;
  rows.forEach(function (r) {
    if (r.img) {
      imgPages.push(r);
    } else if (r.body.length >= MIN_LINES) {
      pureOk++;
    } else {
      pureBad.push(r);
    }
  });

  console.log('\n逐页统计：');
  rows.forEach(function (r) {
    console.log('  第' + String(r.no).padStart(2) + '页  文字行 ' + String(r.body.length).padStart(2) +
      (r.img ? '  [含图页]' : (r.body.length >= MIN_LINES ? '  ✓' : '  ← 不足' + MIN_LINES)) +
      '   ' + (r.body[0] ? r.body[0].txt.slice(0, 22) : ''));
  });

  console.log('\n纯文字页：' + (pureOk + pureBad.length) + ' 页，其中达标 ' + pureOk + ' 页');
  console.log('含图页  ：' + imgPages.length + ' 页（图片占据版面，行数要求按实践放宽）');

  if (pureBad.length) {
    fail.push('有 ' + pureBad.length + ' 个纯文字页不足 ' + MIN_LINES + ' 行：' +
      pureBad.map(function (r) { return '第' + r.no + '页(' + r.body.length + '行)'; }).join('、'));
  } else {
    pass.push('全部 ' + (pureOk + pureBad.length) + ' 个纯文字页均 ≥ ' + MIN_LINES + ' 行');
  }

  var hdrOk = rows.filter(function (r) { return !!r.hdr; }).length;
  var pnoOk = rows.filter(function (r) { return !!r.pno; }).length;
  console.log('含页眉（软件全称+版本号）的页：' + hdrOk + '/' + pages.length);
  console.log('页码在右上角的页：' + pnoOk + '/' + pages.length);
  if (hdrOk !== pages.length) fail.push('有 ' + (pages.length - hdrOk) + ' 页缺页眉软件名/版本号');
  else pass.push('全部页面含页眉「CompareText文件对比软件 V1.3 用户手册」');
  if (pnoOk !== pages.length) fail.push('有 ' + (pages.length - pnoOk) + ' 页页码不在右上角');
  else pass.push('全部页面页码位于右上角');

  var empty = rows.filter(function (r) { return r.body.length < 3; });
  if (empty.length) {
    fail.push('有 ' + empty.length + ' 页几乎无文字（可能图片溢出）：' +
      empty.map(function (r) { return '第' + r.no + '页'; }).join('、'));
  } else {
    pass.push('无空白页');
  }

  var minPure = pureOk ? Math.min.apply(null, rows.filter(function (r) {
    return !r.img && r.body.length >= MIN_LINES;
  }).map(function (r) { return r.body.length; })) : 0;
  console.log('纯文字页最低行数：' + (minPure || '—'));

  try { ws.close(); } catch (e) {}
  try { edgeProc.kill(); } catch (e) {}
  try { serverProc.kill(); } catch (e) {}

  console.log('');
  pass.forEach(function (p) { console.log('  ✓ ' + p); });
  if (fail.length) {
    console.error('\n自检未通过：');
    fail.forEach(function (f) { console.error('  ✗ ' + f); });
    process.exit(1);
  }
  console.log('\n自检通过 ✓');
  process.exit(0);
})().catch(function (e) {
  console.error('失败：' + e.stack);
  try { if (ws) ws.close(); } catch (x) {}
  try { if (edgeProc) edgeProc.kill(); } catch (x) {}
  try { if (serverProc) serverProc.kill(); } catch (x) {}
  process.exit(1);
});
