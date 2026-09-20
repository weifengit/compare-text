'use strict';
/**
 * spike-capture.js — 验证钉子 + 无头截图驱动层的最小可用样板。
 *
 * 这是 docs/feature-dev-prompts.md「提示词 4：无头渲染通道」的验证产物，
 * 已实机跑通全链路：启动 serve.js → headless Edge + CDP → 应用加载 PDF → 逐页截图（含差异标注）。
 * **开发该功能时从这个脚本起步，不要从零重写驱动层。**
 *
 * ── 验证结论（2026-09-20，Windows + Edge headless，8 页 A4 PDF 夹具）──
 *   ✅ 差异标注能被截进图里：标注是叠在 canvas 之上的 DOM 层（.pdf-hl），
 *      Page.captureScreenshot 连 canvas 一起拍，像素级等于用户所见。
 *      （对照实验：清空标注后同区域再截，md5 不同 → 证明标注确实在渲染图里）
 *   ✅ 逐页滚动 + 逐页截图：8/8 页成功，每页内容完整、体积均 >40KB、md5 互不相同。
 *   ❌ 一次截完整篇：不可靠。即使把面板 height 设为内容总高 + overflow:visible，
 *      截图高度对得上（6416px）但只有前 2 页有内容，其余 6 页空白
 *      （像素密度 23 字节/千像素，对比逐页截图的 86）→ **逐页是唯一可靠路线**。
 *   ⚠️ docx 面板未验证（夹具只有 PDF）。docx 是纯 DOM 无 canvas，机制上应同样成立，
 *      但 docx-preview 的"页"由 breakPages 生成，分页边界与跨页表现和 PDF 不同，开发前应补验证。
 *
 * ── 实测数据 ──
 *   体积：scale=1 约 42KB/页；scale=2 约 202KB/页（1224×1584）
 *         → 10 页一对（左右）≈ 3.9MB → 一份 10 对报告 ≈ 39MB
 *   速度：约 815ms/页（含滚动收敛等待），100 页约 80 秒 → 批量场景需进度提示
 *
 * ── 踩过的坑（每条都有对应措施，勿删）──
 *   1. 负/零高度的 clip 会让 Page.captureScreenshot **永久静默挂起**（不报错，就是卡死）。
 *      目标页不在滚动视口内时 bot-top 会算出负数 → 见 capture() 的超时 + 调用前的 clipH 校验。
 *   2. 协同滚动会把 scrollTop 拉回 0：只调一次 SyncScroll.rebind([]) 不够，
 *      app 在布局变化时会重绑 → 见下方"协同滚动绑定解除"处的 rebind 覆盖为空函数。
 *   3. scrollTop 要"写到稳定"（写 → 等 → 校验 → 再确认），且**末页目标值必须 clamp 到
 *      scrollHeight-clientHeight**，否则永远判定没收敛，白跑多轮重试 → 见 scrollPageToTop()。
 *   4. 默认布局下 PDF 面板只有约 186px 高（.pdfarea 有 max-height:65vh 且被主区域 1/2 挤压），
 *      一页都放不下 → 见"注入无头布局"处隐藏主区域 1/2 并覆盖 max-height。
 *   5. console 走管道会缓冲，看不到实时进度 → 本脚本同时写 .spike-out/run.log，并带看门狗。
 *
 * 运行：node tools/spike-capture.js   （需要本机装有 Edge；可用 EDGE_PATH 覆盖路径）
 * 产物：.spike-out/（已加入 .gitignore）
 *   t6-page1..8.png        逐页截图（推荐路线）
 *   t6-page1-scale2.png    scale=2 高分辨率样例
 *   t5-unclipped-whole.png 一次截完整篇的反例（可见大面积空白）
 *   fixtures/ run.log
 */
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var crypto = require('crypto');

var ROOT = path.join(__dirname, '..');
var OUT = path.join(ROOT, '.spike-out');
var FIX = path.join(OUT, 'fixtures');
var LOG = path.join(OUT, 'run.log');
var HTTP_PORT = 4210 + (process.pid % 200);
var DBG_PORT = 9310 + (process.pid % 200);
var EDGE = process.env.EDGE_PATH ||
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

fs.mkdirSync(OUT, { recursive: true });
try { fs.unlinkSync(LOG); } catch (e) { /* 首次运行 */ }
function log(s) {
  console.log(s);
  try { fs.appendFileSync(LOG, s + '\n'); } catch (e) { /* 忽略 */ }
}
// 看门狗：卡住时至少把已完成的结论吐出来，而不是静默挂死
var WATCHDOG = setTimeout(function () {
  log('\n!! 看门狗触发：150s 未完成，强制退出（上方日志是已完成的部分）');
  process.exit(3);
}, 150000);

// ---------- 夹具：两份 8 页 PDF，差异刻意压在前两页 ----------
function esc(s) { return s.replace(/[()\\]/g, ''); }
function buildPdf(pages, fontSize, leading) {
  var n = pages.length;
  var objs = ['%PDF-1.4\n'];
  objs.push('1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n');
  var kids = [];
  for (var i = 0; i < n; i++) kids.push((3 + i) + ' 0 R');
  objs.push('2 0 obj << /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + n + ' >> endobj\n');
  for (var p = 0; p < n; p++) {
    objs.push((3 + p) + ' 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 ' + (3 + n) + ' 0 R >> >> /Contents ' + (4 + n + p) + ' 0 R >> endobj\n');
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
var LINES = [];
for (var i = 1; i <= 160; i++) LINES.push('Line ' + ('000' + i).slice(-3) + ' shared content alpha beta gamma');
var linesL = LINES.slice();
var linesR = LINES.slice(0, 4)
  .concat(['Inserted extra line A', 'Inserted extra line B'])
  .concat(LINES.slice(4, 30))
  .concat(LINES.slice(33));
linesR[0] = 'Line 001 MODIFIED content alpha beta gamma';

// ---------- CDP 基础设施 ----------
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function fetchJson(url) { return fetch(url).then(function (r) { return r.json(); }); }
var serverProc = null, edgeProc = null, ws = null, msgId = 0, pending = {};
function cdpSend(method, params, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var id = ++msgId;
    var t = setTimeout(function () {
      delete pending[id];
      reject(new Error('CDP 调用超时 ' + timeoutMs + 'ms: ' + method));
    }, timeoutMs || 30000);
    pending[id] = {
      resolve: function (v) { clearTimeout(t); resolve(v); },
      reject: function (e) { clearTimeout(t); reject(e); }
    };
    ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
  });
}
function evaluate(expr) {
  return cdpSend('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    .then(function (res) {
      if (res.exceptionDetails) throw new Error('页面内执行异常: ' + JSON.stringify(res.exceptionDetails).slice(0, 300));
      return res.result ? res.result.value : undefined;
    });
}
function evalJson(expr) { return evaluate(expr).then(function (v) { return JSON.parse(v); }); }
function poll(expr, pred, tries, label) {
  return (function loop(n) {
    return evaluate(expr).then(function (v) {
      if (pred(v)) return v;
      if (n <= 0) throw new Error('等待超时：' + label + '，最后值 ' + JSON.stringify(v).slice(0, 200));
      return wait(300).then(function () { return loop(n - 1); });
    });
  })(tries == null ? 40 : tries);
}
function capture(clip, scale) {
  return cdpSend('Page.captureScreenshot', {
    format: 'png',
    clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: scale || 1 },
    captureBeyondViewport: true,
    fromSurface: true
  }, 60000).then(function (r) { return Buffer.from(r.data, 'base64'); });
}
function pngSize(buf) { return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }; }
function md5(buf) { return crypto.createHash('md5').update(buf).digest('hex'); }
function save(name, buf) { var f = path.join(OUT, name); fs.writeFileSync(f, buf); return f; }

var passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; log('  ok  ' + name + (detail ? '（' + detail + '）' : '')); }
  else { failed++; log('FAIL  ' + name + (detail ? '：' + detail : '')); }
}
function cleanup() {
  clearTimeout(WATCHDOG);
  try { if (ws) ws.close(); } catch (e) {}
  try { if (edgeProc) cp.execSync('taskkill /PID ' + edgeProc.pid + ' /T /F 2>nul'); } catch (e2) {}
  try { if (serverProc) serverProc.kill(); } catch (e3) {}
}

(async function main() {
  fs.mkdirSync(FIX, { recursive: true });
  fs.writeFileSync(path.join(FIX, 'a.pdf'), buildPdf(chunk(linesL, 20), 16, 22));
  fs.writeFileSync(path.join(FIX, 'b.pdf'), buildPdf(chunk(linesR, 20), 16, 22));
  log('夹具：a.pdf / b.pdf 各 8 页（差异在第 1、2 页）\n');

  serverProc = cp.spawn(process.execPath, [path.join(ROOT, 'serve.js'), String(HTTP_PORT)], { stdio: 'ignore' });
  var i;
  for (i = 0; i < 40; i++) {
    try { await fetchJson('http://127.0.0.1:' + HTTP_PORT + '/api/list?path=' + encodeURIComponent(FIX)); break; }
    catch (e) { await wait(250); }
  }
  log('serve.js 就绪 :' + HTTP_PORT);

  var profile = path.join(os.tmpdir(), 'edge-spike-' + process.pid);
  edgeProc = cp.spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    '--window-size=1600,1400',
    '--remote-debugging-port=' + DBG_PORT, '--user-data-dir=' + profile,
    'http://127.0.0.1:' + HTTP_PORT + '/'], { stdio: 'ignore' });

  var pg = null;
  for (i = 0; i < 60; i++) {
    try {
      var list = await fetchJson('http://127.0.0.1:' + DBG_PORT + '/json/list');
      pg = (list || []).filter(function (t) {
        return t.type === 'page' && t.url.indexOf('127.0.0.1:' + HTTP_PORT) !== -1;
      })[0];
      if (pg) break;
    } catch (e) { /* 未就绪 */ }
    await wait(300);
  }
  if (!pg) throw new Error('未拿到 Edge 页面目标');
  ws = new WebSocket(pg.webSocketDebuggerUrl);
  await new Promise(function (res, rej) { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = function (ev) {
    var m = JSON.parse(ev.data);
    if (m.id && pending[m.id]) {
      var p = pending[m.id]; delete pending[m.id];
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  };
  log('CDP 已连接');

  // ---------- 加载 PDF ----------
  await poll('(typeof PdfView!=="undefined")&&!!document.querySelector(".CodeMirror")',
    function (v) { return v === true; }, 40, '页面脚本就绪');
  await evaluate('(function(){document.getElementById("srcPathInput").value=' +
    JSON.stringify(FIX.replace(/\\/g, '/')) + ';document.getElementById("srcLoadBtn").click();return 1;})()');
  await poll('JSON.stringify({l:PdfView.isLoaded("L"),r:PdfView.isLoaded("R"),hl:Object.keys(PdfView.getHighlight("L")).length})',
    function (v) { var s = JSON.parse(v); return s.l && s.r && s.hl > 0; }, 60, 'PDF 加载与标注');
  await poll('(function(){var c=document.querySelectorAll("#pdfLeft .pdf-page canvas");' +
    'return c.length>0&&Array.prototype.every.call(c,function(x){return x.width>0&&x.height>0;});})()',
    function (v) { return v === true; }, 30, 'PDF 画布渲染完成');
  await evaluate('document.fonts.ready.then(function(){return 1})');
  log('PDF 加载完成，标注已上色');

  // ---------- 无头布局：让 PDF 区独占窗口 ----------
  log('\n[准备] 注入无头布局：隐藏主区域1/2，PDF 区撑满窗口（要去掉 .pdfarea 的 max-height:65vh）');
  await evaluate('(function(){var s=document.createElement("style");s.id="spike-css";' +
    's.textContent="#results,#resultsResize,#editors,#editorsResize{display:none !important}"+' +
    '"#pdfarea{flex:1 1 auto !important;max-height:none !important;margin-top:0 !important}"+' +
    '"#pdfarea .pdf-controls{display:none !important}";' +
    'document.head.appendChild(s);return 1;})()');
  await wait(600);
  var layout = await evalJson(
    'JSON.stringify((function(){var p=document.getElementById("pdfLeft");' +
    'var pages=document.querySelectorAll("#pdfLeft .pdf-page");var sum=0,mx=0;' +
    'for(var i=0;i<pages.length;i++){var h=pages[i].getBoundingClientRect().height;sum+=h;if(h>mx)mx=h;}' +
    'return {pages:pages.length,clientH:p.clientHeight,scrollH:p.scrollHeight,sumPageH:Math.round(sum),maxPageH:Math.round(mx),winH:window.innerHeight};})())');
  log('     面板可见高=' + layout.clientH + 'px，最高页=' + layout.maxPageH +
    'px，内容合计=' + layout.sumPageH + 'px，视口高=' + layout.winH + 'px');
  check('面板被撑高到能容纳一整页', layout.clientH >= layout.maxPageH,
    '可见 ' + layout.clientH + 'px vs 最高页 ' + layout.maxPageH + 'px');

  // ---------- T6：逐页滚动 + 逐页截图 ----------
  // 关键：先解除协同滚动绑定。否则写 scrollTop 会被 syncscroll 按另一侧的位置拉回去
  //（v2 里"滚动不生效"就是这个原因：面板始终停在顶部，第 3 页起完全在视口外）
  var unbound = await evaluate('(function(){try{if(typeof SyncScroll!=="undefined"&&SyncScroll.rebind){' +
    'SyncScroll.rebind([]);' +
    'SyncScroll.rebind=function(){return;};' +   // 掐死重绑：app 布局变化时会把监听器绑回去
    'return "unbound+locked";}}catch(e){return "err:"+e.message;}return "absent";})()');
  log('     协同滚动绑定解除：' + unbound);

  /**
   * 把某页滚到面板顶部，并确认滚动"稳住了"。
   * 只写一次 scrollTop 不够：app 的协同滚动会在随后的帧里把它拉回 0。
   */
  async function scrollPageToTop(k) {
    var target = -1;
    for (var attempt = 1; attempt <= 6; attempt++) {
      // 注意：末页的目标值会超过滚动上限，必须取 min，否则永远收敛不了（会白跑 6 轮重试）
      target = await evaluate('(function(){var p=document.getElementById("pdfLeft");' +
        'var el=p.querySelectorAll(".pdf-page")[' + k + '];' +
        'var want=Math.min(Math.max(0,el.offsetTop-10), p.scrollHeight-p.clientHeight);' +
        'p.scrollTop=want;return Math.round(want);})()');
      await wait(220);
      var now = await evaluate('document.getElementById("pdfLeft").scrollTop');
      if (Math.abs(now - target) < 2) {
        await wait(180);   // 再观察一次：确认没被后续帧拉回
        var again = await evaluate('document.getElementById("pdfLeft").scrollTop');
        if (Math.abs(again - target) < 2) return { ok: true, target: target, attempts: attempt };
      }
    }
    return { ok: false, target: target, attempts: 6 };
  }

  log('\n[T6] 逐页滚动 + 逐页截图（通用方案，docx 也走这条）');
  var t6bytes = [], t6hashes = [], t6geom = [], t0 = Date.now();
  for (var k = 0; k < layout.pages; k++) {
    var sc = await scrollPageToTop(k);
    await wait(120);
    var g = await evalJson('JSON.stringify((function(){var p=document.getElementById("pdfLeft");' +
      'var el=p.querySelectorAll(".pdf-page")[' + k + '];var pr=p.getBoundingClientRect(),er=el.getBoundingClientRect();' +
      'var top=Math.max(pr.top,er.top),bot=Math.min(pr.bottom,er.bottom);' +
      'return {clipX:er.left+window.scrollX,clipY:top+window.scrollY,clipW:er.width,' +
      'clipH:bot-top,pageH:er.height,visible:bot-top,scrollTop:p.scrollTop,' +
      'offsetTop:Math.round(el.offsetTop),' +
      'trueOffset:Math.round(er.top-p.getBoundingClientRect().top+p.scrollTop),' +
      'contentH:p.scrollHeight,' +
      'hl:el.querySelectorAll(".pdf-hl").length};})())');
    t6geom.push(g);
    // clip 高度必须为正：负/零高度的 clip 会让 Page.captureScreenshot 永久挂起（v2 的卡死原因）
    if (!(g.clipH > 2) || !(g.clipW > 2)) {
      log('     第 ' + (k + 1) + ' 页：视口内不可见（clipH=' + g.clipH.toFixed(1) +
        '，目标 scrollTop=' + sc.target + '，稳定=' + sc.ok + '，实际 ' + Math.round(g.scrollTop) +
        '）→ 跳过，不调用截图');
      t6bytes.push(0); t6hashes.push('skip:' + k); t6geom[k].skipped = true;
      continue;
    }
    var buf = await capture({ x: g.clipX, y: g.clipY, width: g.clipW, height: g.clipH }, 1);
    t6bytes.push(buf.length); t6hashes.push(md5(buf));
    save('t6-page' + (k + 1) + '.png', buf);
    log('     第 ' + (k + 1) + ' 页：scrollTop 目标' + sc.target + '（第' + sc.attempts + '次稳住）' +
      '，实测 ' + Math.round(g.scrollTop) +
      '，offsetTop ' + g.offsetTop + ' 实际 ' + g.trueOffset +
      '，可见 ' + Math.round(g.visible) + '/' + Math.round(g.pageH) +
      'px，标注 ' + g.hl + ' 个 → ' + (buf.length / 1024).toFixed(1) + 'KB');
  }
  check('T6 没有页面因滚动失效而落在视口外',
    t6geom.every(function (p) { return !p.skipped; }),
    '跳过 ' + t6geom.filter(function (p) { return p.skipped; }).length + ' 页');
  var elapsed = Date.now() - t0;
  log('     8 页耗时 ' + elapsed + 'ms（' + Math.round(elapsed / layout.pages) + 'ms/页）');
  check('T6 每页可见高度=整页高度（一页能完整放进视口）',
    t6geom.every(function (p) { return p.skipped || p.visible >= p.pageH - 2; }),
    t6geom.map(function (p) { return Math.round(p.visible) + '/' + Math.round(p.pageH); }).join(' '));
  check('T6 每页都拿到了非空内容（体积均高于空白基线 6KB）',
    t6bytes.every(function (b) { return b > 6000; }),
    '最小 ' + (Math.min.apply(null, t6bytes) / 1024).toFixed(1) + 'KB，最大 ' +
    (Math.max.apply(null, t6bytes) / 1024).toFixed(1) + 'KB');
  check('T6 各页互不相同（证明截的是不同页，不是同一块）',
    new Set(t6hashes).size === t6hashes.length, t6hashes.length + ' 页 / ' + new Set(t6hashes).size + ' 种');
  check('T6 第 1 页含差异标注（承重墙验证）', t6geom[0].hl > 0, '标注 ' + t6geom[0].hl + ' 个');

  // scale=2 体积外推
  var t61 = await capture({ x: t6geom[0].clipX, y: t6geom[0].clipY, width: t6geom[0].clipW, height: t6geom[0].clipH }, 2);
  save('t6-page1-scale2.png', t61);
  var s2 = pngSize(t61);
  log('\n[体积外推]');
  log('     scale=1 单页平均 ' + (t6bytes.reduce(function (a, b) { return a + b; }, 0) / layout.pages / 1024).toFixed(0) + 'KB');
  log('     scale=2 单页 ' + (t61.length / 1024).toFixed(0) + 'KB（' + s2.w + '×' + s2.h + '）');
  log('     → 10 页一对（左右）scale=2 ≈ ' + (t61.length * 20 / 1048576).toFixed(1) + 'MB');
  log('     → 一份 10 对（每对 10 页）报告 ≈ ' + (t61.length * 200 / 1048576).toFixed(0) + 'MB');

  // ---------- T5：解除滚动裁剪后一次截完整篇（有风险，放最后） ----------
  log('\n[T5] 解除滚动裁剪 → 一次截完整篇（短文档的简化路线，放最后验证）');
  log('     注入：面板高度设为内容总高（明确像素值，不用 auto，避免病态布局）');
  await evaluate('(function(){var p=document.getElementById("pdfLeft");var pages=p.querySelectorAll(".pdf-page");' +
    'var last=pages[pages.length-1].getBoundingClientRect();' +
    'var total=Math.ceil(last.bottom-p.getBoundingClientRect().top+10);' +
    'var s=document.createElement("style");s.id="spike-css3";' +
    's.textContent="#pdfLeft{height:"+total+"px !important;overflow:visible !important}"+' +
    '".pdf-panels{height:auto !important;grid-template-rows:auto !important}"+' +
    '".pdfarea{flex:0 0 auto !important;height:auto !important;max-height:none !important}"+' +
    '".layout{flex:0 0 auto !important;height:auto !important;overflow:visible !important}";' +
    'document.head.appendChild(s);return total;})()');
  await wait(700);
  var raw = await evalJson('JSON.stringify((function(){var p=document.getElementById("pdfLeft");' +
    'var r=p.getBoundingClientRect();var pages=p.querySelectorAll(".pdf-page");' +
    'var last=pages[pages.length-1].getBoundingClientRect();' +
    'return {left:r.left+window.scrollX,top:r.top+window.scrollY,width:r.width,' +
    'contentH:Math.round(last.bottom-r.top),panelH:Math.round(r.height),docH:document.documentElement.scrollHeight};})())');
  log('     面板高=' + raw.panelH + 'px，内容高=' + raw.contentH + 'px，文档高=' + raw.docH + 'px');
  var t5 = await capture({ x: raw.left, y: raw.top, width: raw.width, height: raw.contentH }, 1);
  var t5f = save('t5-unclipped-whole.png', t5);
  var t5s = pngSize(t5);
  log('     → 截图 ' + t5s.w + '×' + t5s.h + '，' + (t5.length / 1024).toFixed(1) + 'KB');
  check('T5 一次截到整篇内容（高≈内容高，而非视口高）',
    Math.abs(t5s.h - raw.contentH) <= 4, '截图高 ' + t5s.h + ' vs 内容高 ' + raw.contentH);
  // 非空白判据：v1 的整面板空白图是 39.4KB/666×6436 ≈ 9 字节/千像素；有内容应显著更高
  var bpk = t5.length / (t5s.w * t5s.h / 1000);
  check('T5 内容非空白（像素密度远高于空白基线）', bpk > 20,
    bpk.toFixed(1) + ' 字节/千像素（v1 空白图约 9）');

  log('\n产物：' + OUT + '\\  t6-page1..8.png, t6-page1-scale2.png, t5-unclipped-whole.png');
  log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
})().catch(function (e) {
  log('FAIL  ' + (e && e.message));
  process.exitCode = 1;
}).then(function () { cleanup(); setTimeout(function () { process.exit(process.exitCode || 0); }, 500); });
