'use strict';
/**
 * e2e-webview.js — 端到端：网页源（URL 直连）+ docx 的样式核对。
 * 运行：node test/e2e-webview.js   （需要本机装有 Edge / Chrome）
 *
 * 这条链路要证明的是整个功能的**最终命题**，不是某个函数的自洽：
 *   浏览器里加载真实网页 → 面板渲染出正文（外壳被剥掉、脚本被剥掉）
 *   → 提词进编辑器 → 与同源的 docx 做样式核对 → **差异必须为 0**。
 * 前面单测（test/webstyle.js）证的是解析与比对；这里证的是接线：
 * Pipeline 分支、WebView 契约、iframe 沙箱、行锚定、差异标注，任何一环没接上都会在这里露出来。
 *
 * 夹具是真页面：test/fixtures/gdherb-std.html（广东省药检所「麸炒泽泻」正文页原文快照）
 * 与它还原出的 test/fixtures/gdherb-std.docx。
 */
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');

var ROOT = path.join(__dirname, '..');
var HTTP_PORT = 3461 + (process.pid % 200);
var DBG_PORT = 9671 + (process.pid % 200);

/** 浏览器路径按平台找；找不到就跳过（不算失败，与项目里其它 e2e 的处理一致） */
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

var PAGE = 'http://127.0.0.1:' + HTTP_PORT + '/';
var HTML_URL = PAGE + 'test/fixtures/gdherb-std.html';
var DOCX_PATH = (ROOT + '/test/fixtures/gdherb-std.docx').replace(/\\/g, '/');

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

var passed = 0, failed = 0, skipped = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (extra ? '：' + String(extra).slice(0, 300) : '')); }
}

function cleanup() {
  try { if (ws) ws.close(); } catch (e) {}
  try { if (edgeProc) edgeProc.kill(); } catch (e2) {}
  try { if (serverProc) serverProc.kill(); } catch (e3) {}
  try { fs.rmSync(path.join(os.tmpdir(), 'edge-e2e-webview-' + process.pid), { recursive: true, force: true }); } catch (e4) {}
}

(async function main() {
  var browser = findBrowser();
  if (!browser) {
    console.log('未找到 Edge / Chrome，跳过 e2e-webview（不算失败）');
    process.exit(0);
  }

  // 代理要能访问 127.0.0.1 上的夹具页面，测试环境显式放开内网拦截
  var env = Object.assign({}, process.env, { ALLOW_PRIVATE_FETCH: '1', HOST: '127.0.0.1' });
  serverProc = cp.spawn(process.execPath, [path.join(ROOT, 'serve.js'), String(HTTP_PORT)],
    { stdio: 'ignore', env: env });
  var i;
  for (i = 0; i < 40; i++) {
    try { await fetchJson('http://127.0.0.1:' + HTTP_PORT + '/api/list?path=' + encodeURIComponent(ROOT)); break; }
    catch (e) { await wait(250); }
  }

  var prof = path.join(os.tmpdir(), 'edge-e2e-webview-' + process.pid);
  edgeProc = cp.spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--window-size=1400,1000', '--remote-debugging-port=' + DBG_PORT, '--user-data-dir=' + prof, PAGE],
    { stdio: 'ignore' });

  var target = null;
  for (i = 0; i < 80; i++) {
    try {
      var targets = await fetchJson('http://127.0.0.1:' + DBG_PORT + '/json/list');
      target = (targets || []).filter(function (t) { return t.type === 'page' && t.url.indexOf('127.0.0.1:' + HTTP_PORT) !== -1; })[0];
      if (target) break;
    } catch (e) { /* 未就绪 */ }
    await wait(250);
  }
  if (!target) { console.log('FAIL  没连上浏览器调试端口'); cleanup(); process.exit(1); }

  if (!target || !target.webSocketDebuggerUrl) throw new Error('未拿到浏览器页面目标');
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

  // 页面脚本就绪：新模块没进 index.html 或加载顺序错，这里就会先失败，
  // 而不是让后面每条断言都因为 WebView undefined 而莫名报错。
  var boot = false;
  for (i = 0; i < 40; i++) {
    boot = await evaluate('(typeof WebView!=="undefined")&&(typeof WebStyle!=="undefined")'
      + '&&!!(Pipeline&&Pipeline.styleCheck)&&!!document.querySelector("#editors .CodeMirror")');
    if (boot) break;
    await wait(300);
  }
  if (!boot) throw new Error('页面脚本未就绪（WebView / WebStyle 没加载？）');



  // ---------- ① 加载网页侧（URL 直连，走 /api/fetch 代理） ----------
  await evaluate('Pipeline.loadSide("L", ' + JSON.stringify(HTML_URL) + '); 1');
  for (i = 0; i < 60; i++) {
    var ready = await evaluate('!!(typeof WebView !== "undefined" && WebView.isLoaded("L"))');
    if (ready) break;
    await wait(300);
  }

  var panel = await evaluate('(function(){'
    + 'var pl=document.getElementById("pdfLeft");'
    + 'var f=pl&&pl.querySelector("iframe.web-frame");'
    + 'var d=f&&f.contentDocument;'
    + 'var page=d&&d.querySelector(".web-page");'
    + 'return JSON.stringify({'
    + '  hasFrame:!!f,'
    + '  sameOrigin:!!d,'
    + '  hasPage:!!page,'
    + '  scripts:d?d.querySelectorAll("script").length:-1,'
    + '  text:page?page.textContent.slice(0,4000):"",'
    + '  frameHeight:f?f.getBoundingClientRect().height:0,'
    + '  panelScroll:pl?pl.scrollHeight-pl.clientHeight:0,'
    + '  vectors:(WebView._debug("L")||{}).vectors,'
    + '  blocks:(WebView._debug("L")||{}).blocks,'
    + '  aligned:(WebView._debug("L")||{}).aligned,'
    + '  warnings:(WebView._debug("L")||{}).warnings,'
    + '  contentHeight:(WebView._debug("L")||{}).contentHeight'
    + '});})()').then(JSON.parse);

  check('网页面板出现同源 iframe', panel.hasFrame && panel.sameOrigin, JSON.stringify(panel).slice(0, 200));
  check('只渲染正文容器（.web-page 存在）', panel.hasPage);
  check('站点外壳不进面板：面包屑与字体按钮都被排除',
    panel.text.indexOf('请输入您要查询的内容') < 0 && panel.text.indexOf('无障碍浏览') < 0,
    (panel.text || '').slice(0, 80));
  check('脚本被剥掉（手机版跳转脚本与 jQuery 不进沙箱）', panel.scripts === 0, panel.scripts);
  check('正文段落解析出来了', panel.vectors > 20, 'vectors=' + panel.vectors);
  check('面板 DOM 段与样式向量全部对上', panel.blocks > 0 && panel.aligned === panel.blocks,
    'blocks=' + panel.blocks + ' aligned=' + panel.aligned);
  // iframe 要撑到正文全高，面板才是唯一滚动容器。判据是「元素高度 ≥ 实测内容高度」
  // （小于则正文被 iframe 自己滚走）+ 面板确实可滚，不写死像素阈值：
  // 站点 CSS 生效后 zoom 把可视高度压小，内容全高不再超过 1200。
  check('iframe 撑到内容全高（面板成为唯一滚动容器）',
    panel.frameHeight > 0 && panel.frameHeight >= panel.contentHeight - 2 && panel.panelScroll > 0,
    'frameHeight=' + Math.round(panel.frameHeight) + ' contentHeight=' + Math.round(panel.contentHeight)
      + ' 可滚=' + Math.round(panel.panelScroll));

  // ---------- ② 编辑器文本与向量一致 ----------
  var editor = await evaluate('(function(){'
    + 'var cm=document.querySelectorAll("#editors .CodeMirror")[0].CodeMirror;'
    + 'var v=WebStyle.htmlVectors(document.querySelector("#pdfLeft iframe").srcdoc,'
    + '  {containerId:"content_zw"});'
    + 'return JSON.stringify({edLines:cm.getValue().split("\\n").length, expect:v.length,'
    + '  head:cm.getValue().slice(0,40)});})()').then(JSON.parse);
  check('编辑器文本按段落成行（与 mammoth 同构）', editor.edLines >= editor.expect * 2 - 1,
    JSON.stringify(editor));

  // ---------- ③ 加载 docx 侧并做样式核对 ----------
  await evaluate('Pipeline.loadSide("R", ' + JSON.stringify(DOCX_PATH) + '); 1');
  for (i = 0; i < 60; i++) {
    var docReady = await evaluate('!!(typeof DocxView !== "undefined" && DocxView.isLoaded("R"))');
    if (docReady) break;
    await wait(300);
  }
  var kinds = await evaluate('JSON.stringify(Pipeline.styleState())').then(JSON.parse);
  check('两侧类型被正确登记（L=web / R=docx）',
    kinds.kinds.L === 'web' && kinds.kinds.R === 'docx', JSON.stringify(kinds.kinds));

  var result = await evaluate('Pipeline.styleCheck().then(function(r){'
    + 'return JSON.stringify({ok:r.ok, error:r.error||"", basis:r.basisName, summary:r.summary,'
    + 'diffs:(r.diffs||[]).slice(0,8)});})').then(JSON.parse);
  check('样式核对跑通（基准=原稿声明）', result.ok && /原稿/.test(result.basis), JSON.stringify(result).slice(0, 200));
  check('★ 端到端还原验收：docx 与网页原稿声明差异为 0',
    result.ok && result.summary && result.summary.total === 0,
    JSON.stringify(result.diffs || result.error).slice(0, 300));

  // ---------- ④ 行锚定：差异点能跳到面板里的段落 ----------
  var anchor = await evaluate('(function(){'
    + 'var line=WebView.lineForText("L","本品为泽泻的炮制品");'
    + 'if(line==null) return JSON.stringify({found:false});'
    + 'var top=WebView.lineOffset("L",line);'
    + 'var back=WebView.lineAtOffset("L",top);'
    + 'var pl=document.getElementById("pdfLeft"); pl.scrollTop=Math.max(0,top-20);'
    + 'return JSON.stringify({found:true,line:line,top:top,back:back,'
    + '  scrolled:pl.scrollTop>0, h:WebView.lineHeight("L",line)});})()').then(JSON.parse);
  check('段落摘要能定位到编辑器行号', anchor.found, JSON.stringify(anchor));
  check('行号→像素→行号 往返一致（协同滚动不抖）',
    anchor.found && Math.abs(anchor.back - anchor.line) <= 1, JSON.stringify(anchor));

  // ---------- ⑤ 差异标注落进面板 ----------
  var paint = await evaluate('(function(){'
    + 'var line=WebView.lineForText("L","本品为泽泻的炮制品");'
    + 'WebView.setHighlight("L", (function(o){ o[line]="rm"; return o; })({}));'
    + 'var d=document.querySelector("#pdfLeft iframe").contentDocument;'
    + 'var para=d.querySelectorAll(".web-hl-para").length;'
    + 'WebView.setHighlight("L",{});'
    + 'var after=d.querySelectorAll(".web-hl-para").length;'
    + 'return JSON.stringify({para:para, after:after});})()').then(JSON.parse);
  check('差异标注能涂到网页面板上', paint.para >= 1, JSON.stringify(paint));
  check('清空标注不留残余（重算不叠加）', paint.after === 0, JSON.stringify(paint));

  // ---------- ⑥ 字符集：gbk 页面不乱码（代理字节透传 + TextDecoder） ----------
  var decode = await evaluate('(function(){'
    + 'var bytes=new Uint8Array([0xc4,0xe3,0xba,0xc3]);'
    + 'var buf=bytes.buffer;'
    + 'return Pipeline.decodeHtmlBytes(buf, "text/html; charset=gbk");})()');
  check('gbk 页面按声明字符集解码（不在服务端解坏）', decode === '你好', JSON.stringify(decode));

  // ---------- ⑦ 外链 CSS：内联成功 + 资源解码口径 ----------
  // 外链样式抓不到时，WebView 会在面板顶部写 .web-page-note；有样式就不会有这条提示。
  var cssState = await evaluate('(function(){'
    + 'var d=WebView._debug("L");'
    + 'var f=document.querySelector("#pdfLeft iframe.web-frame");'
    + 'var idoc=f&&f.contentDocument;'
    + 'var styles=idoc?idoc.querySelectorAll("style").length:0;'
    + 'var note=idoc?idoc.querySelector(".web-page-note"):null;'
    + 'var pg=idoc?idoc.querySelector(".web-page"):null;'
    + 'return JSON.stringify({warnings:(d&&d.warnings)||[],styles:styles,'
    + '  note:note?note.textContent:null,'
    + '  pageScrollW:pg?pg.scrollWidth:0,'
    + '  assetDecode:Pipeline.decodeAssetBytes(new Uint8Array([0xc4,0xe3,0xba,0xc3]).buffer, "text/css; charset=gbk")});})()');
  var cssParsed = JSON.parse(cssState);
  check('外链样式成功内联（无“未内联”提示）',
    !cssParsed.note && cssParsed.styles >= 2, JSON.stringify(cssParsed));
  // 站点真实 CSS 里有版心宽约束；默认样式（无 CSS）时正文会窄很多。
  check('站点真实 CSS 生效（正文版心被撑开）', cssParsed.pageScrollW > 400,
    'pageScrollW=' + cssParsed.pageScrollW);
  check('外链资源按 @charset/响应头解码（不走 HTML 的 meta 嗅探）',
    cssParsed.assetDecode === '你好', JSON.stringify(cssParsed.assetDecode));


  console.log('\n' + passed + ' 通过 / ' + failed + ' 失败' + (skipped ? ' / ' + skipped + ' 跳过' : ''));
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch(function (err) {
  console.log('FAIL  用例执行异常：' + (err && err.stack || err));
  cleanup();
  process.exit(1);
});
