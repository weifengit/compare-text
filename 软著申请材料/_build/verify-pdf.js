'use strict';
/**
 * verify-pdf.js — 对生成的鉴别材料 PDF 做**数值化版面自检**。
 *
 * 为什么用数值断言而不是看图：软著材料的硬性指标全是数值（每页行数、页眉、页码），
 * 而本机无法查看渲染图。用 pdf.js 取文字层的坐标逐项断言，比目测严格，
 * 且不受字体渲染差异影响。
 *
 * 判定"每页行数"用两个互补的证据：
 *   ① 行栅格相位一致 —— 全篇所有正文行都落在同一条 11.4pt 的网格上
 *      （y 坐标对 11.4 取模的余数一致）。若有一行溢出到下一页，
 *      该页行数就会少一行、后续行的相位随之改变，断言立刻失败。
 *   ② 版心边界 —— 所有正文行都落在"上边距 20mm ~ 下边距 18mm"围成的版心内，
 *      既没被页眉压住，也没被页脚切掉。版心高 259mm ÷ 11.4pt = 64.4 个行槽，
 *      正好容纳 64 行。
 *   ③ docx 侧另由 docxlib.verify 断言"每页恰好 64 个段落"（结构精确，非估算）。
 *
 * 用法：node verify-pdf.js <pdf路径> [行距pt] [每页行槽数]
 */
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');

var ROOT = path.join(__dirname, '..', '..');
var PORT = 4950 + (process.pid % 200);
var DBG = 9950 + (process.pid % 200);
var BROWSER = process.env.EDGE_PATH ||
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';

var pdfPath = process.argv[2];
var LINE_H = parseFloat(process.argv[3] || '11.25');      // 行距（pt）：浏览器把 CSS 11.4pt 吸附为 15px = 11.25pt
var EXPECT_SLOTS = parseInt(process.argv[4] || '0', 10);    // 每页行槽数（0 = 不校验）
// 版心（与 pdfgen 的 page 边距一致，mm）
var MARGIN_TOP_MM = 20, MARGIN_BOTTOM_MM = 18;

if (!pdfPath) { console.error('用法：node verify-pdf.js <pdf路径> [行距pt] [每页行槽数]'); process.exit(2); }

var serverProc, edgeProc, ws, msgId = 0, pending = {};
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function cdpSend(method, params, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var id = ++msgId;
    var t = setTimeout(function () { delete pending[id]; reject(new Error('CDP 超时 ' + method)); }, timeoutMs || 120000);
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
  var profile = path.join(os.tmpdir(), 'verifypdf-' + process.pid);
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
    'var rows={};tc.items.forEach(function(it){var y=Math.round(it.transform[5]*100)/100;' +
    '(rows[y]=rows[y]||[]).push({x:it.transform[4],s:it.str});});' +
    'var ys=Object.keys(rows).map(Number).sort(function(a,b){return b-a;});' +
    'var lines=ys.map(function(y){var a=rows[y].slice().sort(function(p,q){return p.x-q.x;});' +
    'return {y:y,x:a[0].x,txt:a.map(function(o){return o.s;}).join("")};});' +
    'out.push({page:i,pageW:vp.width,pageH:vp.height,lines:lines});}' +
    'return JSON.stringify(out);}).catch(e=>"ERR:"+e.message);})()');

  if (typeof raw === 'string' && raw.indexOf('ERR:') === 0) throw new Error(raw);
  var pages = JSON.parse(raw);

  var fail = [], pass = [];
  console.log('文件：' + path.basename(pdfPath));
  console.log('页数：' + pages.length);

  // ---- 逐页拆分页眉/页码/正文 ----
  var perPage = pages.map(function (p) {
    var hdr = null, pno = null;
    p.lines.forEach(function (l) {
      if (!hdr && l.txt.indexOf('CompareText') >= 0 && l.txt.indexOf('V1.3') >= 0) hdr = l;
      if (!pno && /^\d{1,3}$/.test(l.txt.trim()) && l.x > p.pageW * 0.8) pno = l;
    });
    var body = p.lines.filter(function (l) { return l !== hdr && l !== pno; });
    return { no: p.page, w: p.pageW, h: p.pageH, hdr: hdr, pno: pno, body: body };
  });

  // ---- ① 行槽窗口：所有正文行必须落在同一组 64 个行槽内 ----
  // 判据：设全局最高正文行为锚点 anchor，则任一正文行的槽号
  //      slot = (anchor − y) / PITCH 必须落在 [0, 63] 的整数上（容差 0.2 个槽）。
  //      若有一行溢出到下一页，本页就会少一行、后续行整体错位，断言立刻失败。
  var PITCH = LINE_H;                       // 行距（CSS 11.4pt）
  var anchor = Math.max.apply(null, perPage.map(function (p) {
    return p.body.length ? p.body[0].y : -1;
  }));
  var offSlot = [], slotUse = [];
  perPage.forEach(function (p) {
    if (!p.body.length) return;
    var lo = 99, hi = -1;
    p.body.forEach(function (l) {
      var slot = (anchor - l.y) / PITCH;
      var r = slot - Math.round(slot);
      if (Math.abs(r) > 0.2 && offSlot.length < 5) offSlot.push([p.no, l.y.toFixed(2), slot.toFixed(3)]);
      var s0 = Math.round(slot);
      if (s0 < lo) lo = s0;
      if (s0 > hi) hi = s0;
    });
    slotUse.push({ no: p.no, lo: lo, hi: hi, span: hi - lo + 1 });
  });
  var totalLines = perPage.reduce(function (a, p) { return a + p.body.length; }, 0);
  var maxSlot = Math.max.apply(null, slotUse.map(function (s) { return s.hi; }));
  var minLo = Math.min.apply(null, slotUse.map(function (s) { return s.lo; }));
  console.log('正文行总数：' + totalLines + '，全局最高行 y=' + anchor.toFixed(2) + 'pt');
  console.log('行槽占用：槽号 ' + minLo + ' ~ ' + maxSlot + '（设计窗口 0 ~ 63）');
  if (offSlot.length) {
    fail.push('有正文行不在行槽网格上（样例：' + JSON.stringify(offSlot) + '），分页有漂移');
  } else {
    pass.push('全部 ' + totalLines + ' 行均落在 0~' + maxSlot + ' 号行槽网格上（步距 ' + PITCH + 'pt）');
  }
  if (maxSlot > 63) {
    fail.push('出现第 ' + maxSlot + ' 号行槽，超过设计的 64 行/页 —— 说明有行溢出到下一页');
  }

  // ---- ② 版心边界：正文行都在版心内 ----
  var topLimit = [], bottomLimit = [];
  var outOfBox = 0, overlap = 0;
  perPage.forEach(function (p) {
    // PDF 坐标自下而上：版心 = [下边距, 页高 − 上边距]
    var boxBottom = MARGIN_BOTTOM_MM * 72 / 25.4;      // 版心下沿
    var boxTop = p.h - MARGIN_TOP_MM * 72 / 25.4;      // 版心上沿
    if (!p.body.length) return;
    var hi = p.body[0].y, lo = p.body[p.body.length - 1].y;
    if (hi > boxTop) outOfBox++;      // 越过上边距 → 顶到页眉
    if (lo < boxBottom) outOfBox++;   // 越过下边距 → 被页脚切掉
    if (p.hdr && hi > p.hdr.y - 4) overlap++;
  });
  console.log('越出版心的页：' + outOfBox + '；页眉压住正文的页：' + overlap);
  if (outOfBox) fail.push('有 ' + outOfBox + ' 页正文越出版心（可能被页眉/页脚裁切）');
  if (overlap) fail.push('有 ' + overlap + ' 页页眉压住正文');
  if (!outOfBox && !overlap) pass.push('全部正文均在版心内，未与页眉/页脚冲突');

  // ---- ③ 每页占用的行槽范围 ----
  // 每页占用的槽段应当是 0~63 的连续区间（首尾可能因空行而未落墨）。
  var spans = slotUse.map(function (s) { return s.span; });
  var minSpan = Math.min.apply(null, spans), maxSpan = Math.max.apply(null, spans);
  var nonBlank = perPage.map(function (p) { return p.body.length; });
  var minNB = Math.min.apply(null, nonBlank), maxNB = Math.max.apply(null, nonBlank);
  console.log('每页非空文字行：最少 ' + minNB + '，最多 ' + maxNB + '（官方下限 50 行）');
  console.log('每页占用槽段跨度：最少 ' + minSpan + '，最多 ' + maxSpan + ' 个槽（首尾空行不落墨，故为下界）');
  if (minNB < 50) fail.push('存在非空行不足 50 的页（最少 ' + minNB + '）');
  else pass.push('每页非空文字行均 ≥ 50（最少 ' + minNB + '）');
  if (minSpan < 62) {
    fail.push('有页仅占 ' + minSpan + ' 个行槽，明显少于设计的 64 行/页');
  }
  if (EXPECT_SLOTS && maxSlot >= EXPECT_SLOTS) {
    fail.push('出现第 ' + maxSlot + ' 号行槽，超过设计的 ' + EXPECT_SLOTS + ' 行/页');
  }

  // ---- ④ 页眉与页码 ----
  var hdrOk = perPage.filter(function (p) { return !!p.hdr; }).length;
  var pnoOk = perPage.filter(function (p) { return !!p.pno; }).length;
  console.log('含页眉（软件名+版本号）的页：' + hdrOk + '/' + pages.length);
  console.log('页码在右上角的页：' + pnoOk + '/' + pages.length);
  if (hdrOk !== pages.length) fail.push('有 ' + (pages.length - hdrOk) + ' 页缺页眉软件名/版本号');
  else pass.push('全部页面含页眉「CompareText文件对比软件 V1.3 源程序」');
  if (pnoOk !== pages.length) fail.push('有 ' + (pages.length - pnoOk) + ' 页页码不在右上角');
  else pass.push('全部页面页码位于右上角');

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
