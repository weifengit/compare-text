'use strict';
/**
 * render.js — 无头渲染通道：一条命令产出一份对比报告（阶段 B：单对最小闭环）。
 * 从 tools/spike-capture.js 起步（CDP 连接、超时、看门狗、逐页滚动收敛等基础设施直接复用），
 * 驱动真实页面复用 src/ 同一套模块（Pipeline.loadSide / compare / DocxView / PdfView），不重写渲染逻辑。
 *
 * 用法：node tools/render.js --task demo.json
 *   task = { title, pairs:[{left,right}], options:{ignoreCase,ignoreEol,ignoreWhitespace,
 *           ignoreNewline,ignoreWidth,ignorePunct}, output }   （options 缺省与页面默认一致：全开）
 *
 * 标准输出（stdout）为一行结构化 JSON；日志走 stderr，不污染 stdout：
 *   { ok, output, stats:{pairs,added,removed,changed}, warnings:[] }
 * 退出码：0 成功；非 0 任务错误（1 常规失败，2 环境不可用，3 看门狗超时）。
 *
 * ── "已知的坑"逐条落实 ──
 *   1. 负/零高度 clip 会让 captureScreenshot 永久挂起 → capture() 带超时 + 调用前校验 clipH/clipW > 2
 *   2. 协同滚动会把 scrollTop 拉回 0 → 先 SyncScroll.rebind([]) 再覆盖 rebind 为空函数
 *   3. scrollTop 要"写到稳定"（写→等→校验→再确认），末页目标值 clamp 到 scrollHeight-clientHeight
 *   4. 默认布局下面板只有约 186px 高 → 注入无头布局：隐藏主区域1/2、.pdfarea 撑满
 *   5. console 走管道会缓冲 → 日志写 stderr，并带看门狗
 *   6. 协同滚动解除后面板状态与交互态不同 → 不依赖界面滚动联动（只截面板）
 *   另外：页几何必须在滚动到该页之后量（scrollTop=0 时第 2 页起都在视口外，clipH 为负）
 */
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var Report = require(path.join(__dirname, '..', 'src', 'report.js'));

var ROOT = path.join(__dirname, '..');
var HTTP_PORT = 4310 + (process.pid % 200);
var DBG_PORT = 9410 + (process.pid % 200);

function log(s) { process.stderr.write(s + '\n'); }

// ---------- 浏览器定位：EDGE_PATH → Edge 默认路径 → Chrome 兜底，都找不到明确报错 ----------
function resolveBrowser() {
  var cands = [];
  if (process.env.EDGE_PATH) cands.push(process.env.EDGE_PATH);
  if (process.platform === 'darwin') {
    cands.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    cands.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  } else {
    cands.push('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
    cands.push('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe');
    cands.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  }
  for (var i = 0; i < cands.length; i++) {
    try { if (fs.existsSync(cands[i])) return cands[i]; } catch (e) { /* 继续 */ }
  }
  return null;
}
var BROWSER = resolveBrowser();

// ---------- 参数 ----------
function parseArgs(argv) {
  var task = null;
  for (var i = 2; i < argv.length; i++) {
    if (argv[i] === '--task' && i + 1 < argv.length) task = argv[i + 1];
  }
  return task;
}

// ---------- 基础设施（复用 spike-capture.js） ----------
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
// 坑 1：captureScreenshot 带超时；负/零 clip 高度会静默挂起，调用方必须先校验 clipH/clipW
function capture(clip, scale) {
  return cdpSend('Page.captureScreenshot', {
    format: 'png',
    clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: scale || 1 },
    captureBeyondViewport: true,
    fromSurface: true
  }, 60000).then(function (r) { return Buffer.from(r.data, 'base64'); });
}
function pngSize(buf) { return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }; }
function cleanup() {
  clearTimeout(WATCHDOG);
  try { if (ws) ws.close(); } catch (e) {}
  try {
    if (edgeProc) {
      if (process.platform === 'win32') cp.execSync('taskkill /PID ' + edgeProc.pid + ' /T /F 2>nul');
      else { try { process.kill(-edgeProc.pid, 'SIGKILL'); } catch (e0) {} edgeProc.kill(); }
    }
  } catch (e2) {}
  try { if (serverProc) serverProc.kill(); } catch (e3) {}
}
// 坑 5：看门狗，卡住时给出失败 JSON 而非静默挂死
var WATCHDOG = setTimeout(function () {
  process.stderr.write('!! 看门狗触发：240s 未完成，强制退出\n');
  process.stdout.write(JSON.stringify({ ok: false, output: null, stats: { pairs: 0, added: 0, removed: 0, changed: 0 }, warnings: ['看门狗超时'] }) + '\n');
  try { process.exit(3); } catch (e) {}
}, 240000);

// ---------- 逐页快照采集（B4） ----------
/** 坑 3：把某页滚到面板顶部并确认"稳住了"；末页目标值 clamp 到 scrollHeight-clientHeight */
function scrollPageToTop(pid, sel, k) {
  var target = -1;
  return (async function () {
    for (var attempt = 1; attempt <= 6; attempt++) {
      target = await evaluate('(function(){var p=document.getElementById(' + JSON.stringify(pid) + ');' +
        'var el=p.querySelectorAll(' + JSON.stringify(sel) + ')[' + k + '];' +
        'var want=Math.min(Math.max(0,el.getBoundingClientRect().top-p.getBoundingClientRect().top+p.scrollTop-4),' +
        'p.scrollHeight-p.clientHeight);p.scrollTop=want;return Math.round(want);})()');
      await wait(220);
      var now = await evaluate('document.getElementById(' + JSON.stringify(pid) + ').scrollTop');
      if (Math.abs(now - target) < 2) {
        await wait(180);   // 再观察一次：确认没被后续帧拉回
        var again = await evaluate('document.getElementById(' + JSON.stringify(pid) + ').scrollTop');
        if (Math.abs(again - target) < 2) return { ok: true, target: target, attempts: attempt };
      }
    }
    return { ok: false, target: target, attempts: 6 };
  })();
}

/** 页几何必须滚动到该页之后量（scrollTop=0 时第 2 页起都在视口外） */
function pageGeom(pid, sel, k) {
  return evalJson('JSON.stringify((function(){var p=document.getElementById(' + JSON.stringify(pid) + ');' +
    'var secs=p.querySelectorAll(' + JSON.stringify(sel) + ');' +
    'var er=secs[' + k + '].getBoundingClientRect(),pr=p.getBoundingClientRect();' +
    'var top=Math.max(pr.top,er.top),bot=Math.min(pr.bottom,er.bottom);' +
    'return {clipX:er.left+window.scrollX,clipY:top+window.scrollY,clipW:er.width,' +
    'clipH:bot-top,pageH:er.height,visible:bot-top};})())');
}

/** 逐页快照（scale=2 保证放大清晰）：返回 [{data,w,h}]；任何一页失败即抛错（该对计入 warning） */
async function snapSide(pid, sel, label) {
  var n = await evaluate('document.getElementById(' + JSON.stringify(pid) + ').querySelectorAll(' + JSON.stringify(sel) + ').length');
  var pages = [];
  for (var k = 0; k < n; k++) {
    var sc = await scrollPageToTop(pid, sel, k);
    await wait(120);
    var g = await pageGeom(pid, sel, k);
    // 坑 1：负/零高度 clip 会永久挂起，先校验
    if (!(g.clipH > 2) || !(g.clipW > 2)) {
      throw new Error(label + ' 第 ' + (k + 1) + ' 页不在视口内（clipH=' + g.clipH.toFixed(1) +
        '，scrollTop 目标 ' + sc.target + '，稳定=' + sc.ok + '）');
    }
    var buf = await capture({ x: g.clipX, y: g.clipY, width: g.clipW, height: g.clipH }, 2);
    var s = pngSize(buf);
    pages.push({ data: 'data:image/png;base64,' + buf.toString('base64'), w: s.w, h: s.h });
    log('      ' + label + ' 第 ' + (k + 1) + '/' + n + ' 页：scrollTop ' + sc.target +
      '（第' + sc.attempts + '次稳住），' + s.w + '×' + s.h + '，' + (buf.length / 1024).toFixed(0) + 'KB');
  }
  return pages;
}

// ---------- 单对处理 ----------
/** 页面内驱动：加载两侧 → 比较 → 取结果 → 逐页快照。返回 {leftName,rightName,result,shots} */
async function renderPair(pair, opts, idx) {
  var left = path.resolve(pair.left), right = path.resolve(pair.right);
  if (!fs.existsSync(left)) throw new Error('左侧文件不存在：' + left);
  if (!fs.existsSync(right)) throw new Error('右侧文件不存在：' + right);
  var kindL = /\.docx$/i.test(left) ? 'docx' : /\.pdf$/i.test(left) ? 'pdf' : 'none';
  var kindR = /\.docx$/i.test(right) ? 'docx' : /\.pdf$/i.test(right) ? 'pdf' : 'none';
  log('  [对 ' + (idx + 1) + '] ' + path.basename(left) + ' ↔ ' + path.basename(right) + '（L=' + kindL + ' R=' + kindR + '）');

  // 选项先设好（页面自动对比会按当前选项跑），再加载。缺省与页面默认一致（全开）
  var M = { optIgnoreCase: 1, optIgnoreEol: 1, optIgnoreWhitespace: 1, optIgnoreNewline: 1, optIgnoreWidth: 1, optIgnorePunct: 1 };
  if (opts) {
    if ('ignoreCase' in opts) M.optIgnoreCase = opts.ignoreCase ? 1 : 0;
    if ('ignoreEol' in opts) M.optIgnoreEol = opts.ignoreEol ? 1 : 0;
    if ('ignoreWhitespace' in opts) M.optIgnoreWhitespace = opts.ignoreWhitespace ? 1 : 0;
    if ('ignoreNewline' in opts) M.optIgnoreNewline = opts.ignoreNewline ? 1 : 0;
    if ('ignoreWidth' in opts) M.optIgnoreWidth = opts.ignoreWidth ? 1 : 0;
    if ('ignorePunct' in opts) M.optIgnorePunct = opts.ignorePunct ? 1 : 0;
  }
  await evaluate('(function(){var M=' + JSON.stringify(M) + ';for(var id in M)' +
    'document.getElementById(id).checked=!!M[id];return 1;})()');
  await evaluate('Pipeline.loadSide("L", ' + JSON.stringify(left.replace(/\\/g, '/')) + ')');
  await evaluate('Pipeline.loadSide("R", ' + JSON.stringify(right.replace(/\\/g, '/')) + ')');

  // 等两侧渲染完成：PDF 等画布、docx 等 renderAsync + 文本提取
  function loadedExpr(side, kind) {
    var pid = side === 'L' ? 'pdfLeft' : 'pdfRight';
    if (kind === 'pdf') {
      return 'JSON.stringify({ok:(function(){var p=document.getElementById(' + JSON.stringify(pid) + ');' +
        'var c=p?p.querySelectorAll(".pdf-page canvas"):[];' +
        'return c.length>0&&Array.prototype.every.call(c,function(x){return x.width>0&&x.height>0;});})()})';
    }
    if (kind === 'docx') {
      return 'JSON.stringify({ok:(function(){var d=typeof DocxView!=="undefined"?DocxView._debug("' + side + '"):null;' +
        'return !!(d&&d.loaded&&d.hasText);})()})';
    }
    // 纯文本：无面板，等编辑区写入文本即可（.CodeMirror 按 DOM 顺序 = L、R）
    return 'JSON.stringify({ok:(function(){var eds=document.querySelectorAll(".CodeMirror");' +
      'return eds.length>1&&eds[' + (side === 'L' ? 0 : 1) + '].CodeMirror.getValue().length>0;})()})';
  }
  await poll(loadedExpr('L', kindL), function (v) { return JSON.parse(v).ok; }, 60, 'L 面板渲染');
  await poll(loadedExpr('R', kindR), function (v) { return JSON.parse(v).ok; }, 60, 'R 面板渲染');
  await evaluate('document.fonts.ready.then(function(){return 1})');

  // 报告默认执行一遍"修整"（同界面"修整"按钮：Norm.tidyText 去全部空白整理为单行），缩小报告空间占用。
  // 先等编辑器写入面板原文——PDF 提词晚于画布渲染，否则修整会被随后到来的原文覆盖。
  // 面板标注不受影响：编辑器文本与面板原文不一致时，Pipeline.syncPanelTextAnnotations 按面板原文另算标注。
  await poll('(function(){var eds=document.querySelectorAll(".CodeMirror");' +
    'return eds.length>1&&eds[0].CodeMirror.getValue().length>0&&eds[1].CodeMirror.getValue().length>0;})()',
    function (v) { return v === true; }, 60, '编辑器文本就绪');
  await evaluate('(function(){var eds=document.querySelectorAll(".CodeMirror");' +
    'var L=eds[0].CodeMirror,R=eds[1].CodeMirror;' +
    'L.setValue(Norm.tidyText(L.getValue()));R.setValue(Norm.tidyText(R.getValue()));return 1;})()');

  // 显式再算一次（上面自动对比已按同样选项跑过，这里保证拿到确定的最新结果）
  await evaluate('Pipeline.compare()');
  var rpoll = await poll('(function(){var r=Pipeline.getResult();if(!r)return "{\\"done\\":false}";' +
    'if(r.error)return JSON.stringify({done:true,err:String(r.error).slice(0,300)});' +
    'return JSON.stringify({done:true,mode:r.mode});})()',
    function (v) { var s = JSON.parse(v); return s.done; }, 80, '对比结果');
  var rinfo = JSON.parse(rpoll);
  if (rinfo.err) throw new Error('对比失败：' + rinfo.err);
  // 标注在 render() 内同步上色，但编辑器变更触发的防抖对比可能晚到，等它落定
  await wait(1200);

  // 诊断：docx 的 fitWidth 是否生效（scrollWidth≈面板宽 说明 zoom 已把页面收进面板，未被截断）
  if (kindL === 'docx' || kindR === 'docx') {
    var zinfo = await evalJson('JSON.stringify((function(){var out={};["pdfLeft","pdfRight"].forEach(function(id){' +
      'var p=document.getElementById(id);var h=p.querySelector(".docx-host");if(!h)return;' +
      'var sec=p.querySelector(".docx-wrapper section.docx");' +
      'out[id]={zoom:h.style.zoom||"1",secW:sec?Math.round(sec.offsetWidth):0,panelW:p.clientWidth,scrollW:p.scrollWidth};});' +
      'return out;})())');
    log('  docx fitWidth：' + JSON.stringify(zinfo));
  }

  // 取结果（只取报告需要的字段，避免把超大 charAnchors 等一起拉回）
  var result = await evalJson('(function(){var r=Pipeline.getResult();' +
    'if(!r)return "null";if(r.error)return JSON.stringify({error:r.error});' +
    'if(r.mode==="grid")return JSON.stringify({mode:"grid",rows:r.rows,leftLines:r.leftLines,' +
    'rightLines:r.rightLines,stats:r.stats});' +
    'if(r.mode==="flow"){if(r.skipped)return JSON.stringify({mode:"flow",skipped:true,leftLen:r.leftLen,rightLen:r.rightLen});' +
    'return JSON.stringify({mode:"flow",segsL:r.segsL,segsR:r.segsR,addedChars:r.addedChars,removedChars:r.removedChars});}' +
    'return "null";})()');

  // 逐侧快照（面板里真正渲染的是什么就按什么截）
  var kinds = await evalJson('(function(){function k(id){var p=document.getElementById(id);' +
    'if(p&&p.querySelector(".docx-host"))return "docx";if(p&&p.querySelectorAll(".pdf-page").length)return "pdf";return "none";}' +
    'return JSON.stringify({L:k("pdfLeft"),R:k("pdfRight")});})()');
  var shots = { L: [], R: [] };
  if (kinds.L === 'docx') shots.L = await snapSide('pdfLeft', '.docx-wrapper section.docx', 'L(docx)');
  else if (kinds.L === 'pdf') shots.L = await snapSide('pdfLeft', '.pdf-page', 'L(pdf)');
  if (kinds.R === 'docx') shots.R = await snapSide('pdfRight', '.docx-wrapper section.docx', 'R(docx)');
  else if (kinds.R === 'pdf') shots.R = await snapSide('pdfRight', '.pdf-page', 'R(pdf)');

  return { leftName: path.basename(left), rightName: path.basename(right), result: result, shots: shots };
}

function addStats(stats, result) {
  if (!result) return;
  if (result.mode === 'grid' && result.stats) {
    stats.added += result.stats.added;
    stats.removed += result.stats.removed;
    stats.changed += result.stats.modified;
  } else if (result.mode === 'flow') {
    stats.added += result.addedChars || 0;
    stats.removed += result.removedChars || 0;
  }
}

// ---------- 主流程 ----------
(async function main() {
  if (!BROWSER) {
    process.stderr.write('找不到浏览器：请安装 Edge，或用 EDGE_PATH 指定浏览器可执行文件路径\n');
    process.stdout.write(JSON.stringify({ ok: false, output: null, stats: { pairs: 0, added: 0, removed: 0, changed: 0 },
      warnings: ['找不到可用的浏览器（Edge/Chrome）'] }) + '\n');
    process.exit(2);
  }
  var taskPath = parseArgs(process.argv);
  if (!taskPath) {
    process.stderr.write('用法：node tools/render.js --task <task.json>\n');
    process.stdout.write(JSON.stringify({ ok: false, output: null, stats: { pairs: 0, added: 0, removed: 0, changed: 0 },
      warnings: ['缺少 --task 参数'] }) + '\n');
    process.exit(1);
  }
  var task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
  if (!task || !Array.isArray(task.pairs) || !task.pairs.length) {
    process.stdout.write(JSON.stringify({ ok: false, output: null, stats: { pairs: 0, added: 0, removed: 0, changed: 0 },
      warnings: ['任务缺少非空 pairs 数组'] }) + '\n');
    process.exit(1);
  }
  var output = path.resolve(task.output || 'report.html');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  var warnings = [];
  var stats = { pairs: task.pairs.length, added: 0, removed: 0, changed: 0 };

  // 临时静态服务
  serverProc = cp.spawn(process.execPath, [path.join(ROOT, 'serve.js'), String(HTTP_PORT)], { stdio: 'ignore' });
  var i, up = false;
  for (i = 0; i < 40; i++) {
    try { await fetchJson('http://127.0.0.1:' + HTTP_PORT + '/api/list?path=' + encodeURIComponent(process.cwd())); up = true; break; }
    catch (e) { await wait(250); }
  }
  if (!up) throw new Error('serve.js 启动失败');

  // headless Edge + CDP
  var profile = path.join(os.tmpdir(), 'edge-render-' + process.pid);
  edgeProc = cp.spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    '--window-size=1600,1400', '--remote-debugging-port=' + DBG_PORT, '--user-data-dir=' + profile,
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
  if (!pg) throw new Error('未拿到浏览器页面目标');
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

  await poll('(typeof Pipeline!=="undefined")&&(typeof PdfView!=="undefined")&&!!document.querySelector(".CodeMirror")',
    function (v) { return v === true; }, 40, '页面脚本就绪');
  // 坑 2：先解除协同滚动并掐死重绑（布局变化会重绑回监听器，把 scrollTop 拉回 0）
  await evaluate('(function(){try{if(typeof SyncScroll!=="undefined"&&SyncScroll.rebind){' +
    'SyncScroll.rebind([]);SyncScroll.rebind=function(){return;};return "unbound+locked";}}' +
    'catch(e){return "err:"+e.message;}return "absent";})()');
  // 坑 4：注入无头布局，主区域 3 撑满窗口（必须在加载 docx 之前：fitWidth 按最终面板宽度算 zoom）
  await evaluate('(function(){var s=document.createElement("style");s.id="render-css";' +
    's.textContent="#results,#resultsResize,#editors,#editorsResize{display:none !important}"+' +
    '"#pdfarea{flex:1 1 auto !important;max-height:none !important;margin-top:0 !important}"+' +
    '"#pdfarea .pdf-controls{display:none !important}";document.head.appendChild(s);return 1;})()');
  await wait(500);
  // 首屏 updatePdfArea() 会给 #pdfarea 加 hidden（无文件时不显示主区域3）；docx 的 fitWidth 在
  // load 时量面板宽算 zoom，此刻尚未有任何 onPanelsChanged 解除 hidden → clientWidth=0 → zoom
  // 退化为 1，页面按 A4 原大渲染、超出面板被截断。加载前先解除，与真实界面"有文件后显示主区域3"一致。
  await evaluate('(function(){var el=document.getElementById("pdfarea");if(el)el.classList.remove("hidden");return 1;})()');

  // 逐对处理：单对失败只记 warning 继续
  var pairs = [];
  for (i = 0; i < task.pairs.length; i++) {
    try {
      var p = await renderPair(task.pairs[i], task.options, i);
      pairs.push(p);
      addStats(stats, p.result);
    } catch (e) {
      var msg = '第 ' + (i + 1) + ' 对失败：' + ((e && e.message) || e);
      log('  !! ' + msg);
      warnings.push(msg);
      stats.pairs--;   // 成功的对数才计入
    }
  }
  if (!pairs.length) {
    process.stdout.write(JSON.stringify({ ok: false, output: null, stats: stats, warnings: warnings }) + '\n');
    process.exit(1);
  }

  // 组装报告并落盘
  var html = Report.build({
    title: task.title || '文本对比报告',
    time: new Date().toLocaleString('zh-CN'),
    pairs: pairs
  });
  fs.writeFileSync(output, html, 'utf8');
  log('报告已写入：' + output + '（' + (html.length / 1024).toFixed(0) + 'KB，' + pairs.length + ' 对）');

  process.stdout.write(JSON.stringify({ ok: warnings.length === 0, output: output, stats: stats, warnings: warnings }) + '\n');
  process.exit(warnings.length ? 1 : 0);
})().catch(function (e) {
  process.stderr.write('FAIL  ' + ((e && e.message) || e) + '\n');
  try {
    process.stdout.write(JSON.stringify({ ok: false, output: null, stats: { pairs: 0, added: 0, removed: 0, changed: 0 },
      warnings: [String((e && e.message) || e)] }) + '\n');
  } catch (e2) {}
  process.exit(1);
}).then(function () { cleanup(); });

// 保证退出前清理子进程
process.on('exit', cleanup);
