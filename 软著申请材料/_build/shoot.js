'use strict';
/**
 * shoot.js — 软著《用户手册》配图采集器（真实运行页面 + headless Edge + CDP）。
 *
 * 为什么要有它：手册要求"图文结合"，图必须来自软件真实界面。
 * 本脚本启动 serve.js → 无头 Edge → CDP 驱动页面（设置编辑器文本、切换选项、
 * 加载 PDF/Word/Excel 对比源、开合弹层、切窄屏），逐场景截图落盘。
 *
 * 用法：
 *   node 软著申请材料/_build/shoot.js            # 全部场景
 *   node 软著申请材料/_build/shoot.js 01 05      # 只跑编号前缀匹配的场景
 *
 * 产物：软著申请材料/界面截图-CompareText/NN-名称.png
 */
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');

var ROOT = path.join(__dirname, '..', '..');
var OUT = path.join(__dirname, '..', '界面截图-CompareText');
var DEMO = path.join(__dirname, '..', '演示文件');
var DEMO_DOC = path.join(DEMO, '01-文档对比');
var DEMO_XLSX = path.join(DEMO, '03-表格对比');
var DEMO_SCAN = path.join(DEMO, '05-扫描件对比');
var DEMO_TXT = path.join(DEMO);
var HTTP_PORT = 4610 + (process.pid % 200);
var DBG_PORT = 9710 + (process.pid % 200);
var W = 1440, H = 900;

var BROWSER = process.env.EDGE_PATH ||
  (process.platform === 'darwin'
    ? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');

var serverProc = null, edgeProc = null, ws = null, msgId = 0, pending = {};

function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function fetchJson(url) { return fetch(url).then(function (r) { return r.json(); }); }
function cdpSend(method, params, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var id = ++msgId;
    var t = setTimeout(function () { delete pending[id]; reject(new Error('CDP 超时: ' + method)); }, timeoutMs || 30000);
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
      if (res.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(res.exceptionDetails).slice(0, 400));
      return res.result ? res.result.value : undefined;
    });
}
async function poll(expr, pred, tries, label) {
  for (var n = 0; n < (tries || 50); n++) {
    var v = await evaluate(expr);
    if (pred(v)) return v;
    await wait(250);
  }
  throw new Error('等待超时: ' + label);
}

// ---------------------------------------------------------------- 截图
async function shot(name, clip) {
  var params = { format: 'png' };
  if (clip) params.clip = clip;
  var r = await cdpSend('Page.captureScreenshot', params, 60000);
  var buf = Buffer.from(r.data, 'base64');
  var file = path.join(OUT, name + '.png');
  fs.writeFileSync(file, buf);
  console.log('  截图 ' + path.basename(file) + '  ' + (buf.length / 1024).toFixed(0) + 'KB' +
    (clip ? '  ' + clip.width + 'x' + clip.height : ''));
}

/** 取某元素（或某选择器首元素）的矩形，作为截图裁剪区；返回 null 表示元素不存在 */
async function rectOf(selector, pad) {
  var js = '(function(){var el=document.querySelector(' + JSON.stringify(selector) + ');' +
    'if(!el)return null;var r=el.getBoundingClientRect();' +
    'return JSON.stringify({x:r.left,y:r.top,width:r.width,height:r.height});})()';
  var s = await evaluate(js);
  if (!s) return null;
  var r = JSON.parse(s);
  if (r.width < 4 || r.height < 4) return null;
  var p = pad == null ? 0 : pad;
  return {
    x: Math.max(0, r.x - p),
    y: Math.max(0, r.y - p),
    width: Math.min(W - Math.max(0, r.x - p), r.width + p * 2),
    height: Math.min(H - Math.max(0, r.y - p), r.height + p * 2),
    scale: 2
  };
}

/** 全窗口截图 */
function fullClip() { return { x: 0, y: 0, width: W, height: H, scale: 2 }; }

/** 元素裁剪截图：元素不存在则退回全窗口 */
async function shotOf(name, selector, pad) {
  var clip = await rectOf(selector, pad);
  if (!clip) { console.log('  !! 未找到 ' + selector + '，退回全窗口'); clip = fullClip(); }
  await shot(name, clip);
}

// ---------------------------------------------------------------- 场景辅助
function setText(l, r) {
  return evaluate('(function(){var cm=document.querySelectorAll(".CodeMirror");' +
    'if(cm.length<2)return "no-cm";' +
    'cm[0].CodeMirror.setValue(' + JSON.stringify(l) + ');' +
    'cm[1].CodeMirror.setValue(' + JSON.stringify(r) + ');return "ok";})()');
}
function setOpt(id, on) {
  return evaluate('(function(){var e=document.getElementById(' + JSON.stringify(id) + ');' +
    'if(!e)return "no-el";if(e.checked!==' + (on ? 'true' : 'false') + '){e.checked=' + (on ? 'true' : 'false') +
    ';e.dispatchEvent(new Event("change",{bubbles:true}));}return e.checked;})()');
}
function click(selector) {
  return evaluate('(function(){var e=document.querySelector(' + JSON.stringify(selector) + ');' +
    'if(!e)return "no-el";e.click();return "ok";})()');
}
function clearStorage() {
  return evaluate('(function(){try{localStorage.clear();}catch(e){}return "ok";})()');
}

// 演示文本：一段"合同条款修订"式的对比，覆盖修改 / 新增 / 删除三类差异
var DEMO_L = [
  '技术服务合同（草案）',
  '',
  '第一条 服务内容',
  '乙方为甲方提供文件对比工具的技术支持服务，',
  '包括环境部署、参数调优与使用培训。',
  '',
  '第二条 服务期限',
  '自 2026 年 1 月 1 日起至 2026 年 12 月 31 日止。',
  '',
  '第三条 服务费用',
  '本合同服务费用为人民币 80,000 元（含税）。',
  '甲方应在合同签订后 10 个工作日内支付 50%。',
  '',
  '第四条 验收标准',
  '乙方交付的工具应支持 PDF、Word 与 Excel 文件的对比。',
  '',
  '第五条 违约责任',
  '任何一方违约，应向对方支付合同总额 10% 的违约金。',
  '',
  '第六条 争议解决',
  '双方协商不成的，提交北京仲裁委员会仲裁。'
].join('\n');

var DEMO_R = [
  '技术服务合同（修订稿）',
  '',
  '第一条 服务内容',
  '乙方为甲方提供文件对比工具的技术支持服务，',
  '包括环境部署、参数调优、使用培训与年度巡检。',
  '',
  '第二条 服务期限',
  '自 2026 年 1 月 1 日起至 2027 年 12 月 31 日止。',
  '',
  '第三条 服务费用',
  '本合同服务费用为人民币 96,000 元（含税）。',
  '甲方应在合同签订后 15 个工作日内支付 50%。',
  '',
  '第四条 验收标准',
  '乙方交付的工具应支持 PDF、Word、Excel 与扫描件的对比。',
  '扫描件应能自动识别文字。',
  '',
  '第五条 违约责任',
  '任何一方违约，应向对方支付合同总额 15% 的违约金。',
  '',
  '第六条 争议解决',
  '双方协商不成的，提交上海仲裁委员会仲裁。'
].join('\n');

// ---------------------------------------------------------------- 页面 / UI 驱动
/** 重载页面并等就绪（清掉 localStorage，避免上一次场景的历史与标签串场） */
async function freshPage() {
  await evaluate('(function(){try{localStorage.clear();}catch(e){}location.reload();return "1";})()');
  await wait(2200);
  await poll('(typeof Pipeline!=="undefined")&&(typeof FilterBar!=="undefined")&&!!document.querySelector(".CodeMirror")',
    function (v) { return v === true; }, 80, '重载就绪');
  await wait(400);
}

/** 侧边栏对比源：填路径 → 点「加载」（真实 UI 链路） */
async function setSrc(p) {
  await evaluate('(function(){var el=document.getElementById("srcPathInput");' +
    'el.value=' + JSON.stringify(p) + ';' +
    'el.dispatchEvent(new Event("input",{bubbles:true}));return "ok";})()');
  await click('#srcLoadBtn');
  await wait(1600);
}

/** 选子文件夹（写 .cb 组合框的值并派发 change，等价用户在下拉里点选） */
async function pickDir(label) {
  var r = await evaluate('(function(){var host=document.getElementById("dirSel");' +
    'if(!host)return "no-host";var opts=host.options||[];' +
    'for(var i=0;i<opts.length;i++){if(opts[i].label===' + JSON.stringify(label) + '){' +
    'host.value=opts[i].value;host.dispatchEvent(new Event("change",{bubbles:true}));return "ok";}}' +
    'return "not-found";})()');
  if (r !== 'ok') console.log('  !! 子文件夹 ' + label + ' → ' + r);
  await wait(1400);
}

/** 走真实 UI 链路跑一次 Excel 对比：选对比源 → 选表头/键列确认 → 渲染三视图 + 两侧原表 */
async function driveXlsx(oldName, newName) {
  await setSrc(DEMO_XLSX);
  await pickFile('L', oldName);
  await pickFile('R', newName);
  await wait(2500);
  await click('#xlsxCfgBtn');
  // 配置弹窗要先把两边 sheet 清单读出来再渲染，字节大的表更慢 → 等它真的可见再确认
  await poll('(function(){var m=document.getElementById("xlsxCfgMask");' +
    'return !!(m&&!m.hidden&&m.offsetHeight>0);})()',
    function (v) { return v === true; }, 80, '配置弹窗可见');
  await poll('(function(){var b=document.getElementById("xlsxCfgOk");' +
    'return !!(b&&!b.disabled);})()', function (v) { return v === true; }, 40, '开始对比按钮可用');
  await wait(600);
  await click('#xlsxCfgOk');
  await poll('document.querySelectorAll("#results .xv-sheet, #results .xc-tab, #results [class*=sheet]").length',
    function (v) { return v > 0; }, 80, '三视图渲染');
  return 'xlsx-ok';
}

/** 选左右文件（同理） */
async function pickFile(side, name) {
  var r = await evaluate('(function(){var host=document.getElementById(' + JSON.stringify(side === 'L' ? 'fileSelL' : 'fileSelR') + ');' +
    'if(!host)return "no-host";var opts=host.options||[];' +
    'for(var i=0;i<opts.length;i++){if(opts[i].label===' + JSON.stringify(name) + '){' +
    'host.value=opts[i].value;host.dispatchEvent(new Event("change",{bubbles:true}));return "ok";}}' +
    'return "not-found";})()');
  if (r !== 'ok') console.log('  !! 文件 ' + name + ' → ' + r);
}

// ---------------------------------------------------------------- 启动 / 关闭
async function boot() {
  serverProc = cp.spawn(process.execPath, [path.join(ROOT, 'serve.js'), String(HTTP_PORT)], { stdio: 'ignore' });
  var up = false;
  for (var i = 0; i < 40; i++) {
    try { await fetchJson('http://127.0.0.1:' + HTTP_PORT + '/api/list?path=' + encodeURIComponent(ROOT)); up = true; break; }
    catch (e) { await wait(250); }
  }
  if (!up) throw new Error('serve.js 启动失败');
  console.log('静态服务已启动 :' + HTTP_PORT);

  var profile = path.join(os.tmpdir(), 'edge-shoot-' + process.pid);
  edgeProc = cp.spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--hide-scrollbars', '--window-size=' + W + ',' + H, '--no-sandbox',
    '--force-device-scale-factor=2', '--font-render-hinting=none',
    '--remote-debugging-port=' + DBG_PORT, '--user-data-dir=' + profile,
    'http://127.0.0.1:' + HTTP_PORT + '/'], { stdio: 'ignore' });

  var target = null;
  for (var k = 0; k < 60; k++) {
    if (edgeProc.exitCode !== null) throw new Error('浏览器进程已退出');
    try {
      var list = await fetchJson('http://127.0.0.1:' + DBG_PORT + '/json/list');
      target = (list || []).filter(function (x) {
        return x.type === 'page' && x.url.indexOf('127.0.0.1:' + HTTP_PORT) !== -1;
      })[0];
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
  await cdpSend('Runtime.enable');
  await cdpSend('Page.navigate', { url: 'http://127.0.0.1:' + HTTP_PORT + '/' }, 15000);
  await wait(900);
  await poll('(typeof Pipeline!=="undefined")&&!!document.querySelector(".CodeMirror")',
    function (v) { return v === true; }, 60, '页面就绪');
  await clearStorage();
  console.log('页面就绪');
}

function shutdown() {
  try { if (ws) ws.close(); } catch (e) {}
  try { if (edgeProc) edgeProc.kill(); } catch (e) {}
  try { if (serverProc) serverProc.kill(); } catch (e) {}
}

// ---------------------------------------------------------------- 场景
var SCENES = [
  {
    id: '01', name: '01-主界面文本对比', desc: '两段合同文本的行级+字符级差异、统计与忽略选项',
    run: async function () {
      await setText(DEMO_L, DEMO_R);
      await wait(1200);
      await shot(this.name, fullClip());
    }
  },
  {
    id: '02', name: '02-差异结果区', desc: '结果区：行级增删改 + 字符级高亮 + 折叠提示',
    run: async function () {
      await shotOf(this.name, '#results', 0);
    }
  },
  {
    id: '03', name: '03-忽略选项与历史', desc: '侧边栏忽略选项与历史记录',
    run: async function () {
      // 再跑两次对比，让历史记录有多条
      await setText(DEMO_L + '\n第七条 附则', DEMO_R + '\n第七条 附则');
      await wait(900);
      await setText(DEMO_L, DEMO_R);
      await wait(900);
      await shotOf(this.name, '#sidebar', 0);
    }
  },
  {
    id: '04', name: '04-忽略标点与全半角', desc: '勾选忽略标点/全半角后差异减少',
    run: async function () {
      await setText('第1条 服务费为 80,000 元（含税）。', '第1条 服务费为 80,000 元(含税)');
      await wait(800);
      await setOpt('optIgnorePunct', false);
      await setOpt('optIgnoreWidth', false);
      await wait(900);
      await shotOf(this.name, '#results', 0);
      await setOpt('optIgnorePunct', true);
      await setOpt('optIgnoreWidth', true);
    }
  },
  {
    id: '05', name: '05-多标签页', desc: '浏览器式多标签，每个窗口独立保存状态',
    run: async function () {
      await click('#tabAdd');
      await wait(400);
      await setText('标签二：独立的对比窗口', '标签二：独立的对比窗口（已修改）');
      await wait(800);
      await click('#tabAdd');
      await wait(400);
      await setText('标签三：再开一个对比窗口', '标签三：再开一个对比窗口');
      await wait(800);
      await shot(this.name, fullClip());
    }
  },
  {
    id: '06', name: '06-PDF对比与差异标注', desc: '两侧 PDF 并排 + 差异标注（红/绿/琥珀）+ 全屏',
    run: async function () {
      await freshPage();
      // 侧边栏对比源 + 子文件夹/文件下拉全部走真实 UI 链路（FilterBar 已在启动时 init 过，
      // 不能再次 init —— 二次 init 会用新回调覆盖 app.js 的回调，加载后编辑区不再回填）
      await setSrc(DEMO_DOC);
      await pickFile('L', '合同-草案.pdf');
      await pickFile('R', '合同-修订.pdf');
      await wait(4000);
      await poll('document.querySelectorAll(".pdf-page canvas").length',
        function (v) { return v > 1; }, 80, 'PDF 渲染');
      await click('#toggleEditorsBtn');      // 隐藏编辑区：把高度让给主区域3（该按钮的用途）
      await wait(2200);
      await shot(this.name, fullClip());
    }
  },
  {
    id: '07', name: '07-PDF差异标注特写', desc: 'PDF 页面上按行着色标注差异（全屏后裁剪 PDF 区）',
    run: async function () {
      await click('#pdfFullscreen');
      await wait(2500);
      await shotOf(this.name, '#pdfarea', 0);
      await click('#pdfFullscreen');
      await wait(1200);
    }
  },
  {
    id: '08', name: '08-Word文档对比', desc: 'Word(.docx) 渲染与差异标注',
    run: async function () {
      await freshPage();
      await setSrc(DEMO_DOC);
      await pickFile('L', '说明书-草案.docx');
      await pickFile('R', '说明书-修订.docx');
      await wait(4000);
      await poll('document.querySelectorAll(".docx-wrapper section").length',
        function (v) { return v > 0; }, 80, 'Word 渲染');
      await click('#toggleEditorsBtn');      // 隐藏编辑区：把高度让给主区域3
      await wait(2200);
      await shot(this.name, fullClip());
      await click('#pdfFullscreen');
      await wait(2500);
      await shot('08b-Word差异标注特写', await rectOf('#pdfarea', 0));
      await click('#pdfFullscreen');
      await wait(1000);
    }
  },
  {
    id: '09', name: '09-Excel对比三视图', desc: 'Excel 对比：新增/修改/删除三视图 + 两侧原表对照',
    run: async function () {
      await freshPage();
      console.log('  ' + await driveXlsx('库存台账-旧.xlsx', '库存台账-新.xlsx'));
      await wait(2500);
      await shot(this.name, fullClip());
    }
  },
  {
    id: '10', name: '10-Excel原表对照', desc: '主区域3 两侧原表（虚拟滚动、按源文件列宽/隐藏列渲染、差异涂色）',
    run: async function () {
      await click('#pdfFullscreen');
      await wait(2500);
      await shotOf(this.name, '#pdfarea', 0);
      await click('#pdfFullscreen');
      await wait(1000);
    }
  },
  {
    id: '11', name: '11-表格对比配置弹窗', desc: '表格对比配置：多 Sheet 勾选 + 表头行范围 + 键列 + 新旧预览',
    run: async function () {
      await freshPage();
      await setSrc(DEMO_XLSX);
      await pickFile('L', '库存台账-旧.xlsx');
      await pickFile('R', '库存台账-新.xlsx');
      await wait(2500);
      await click('#xlsxCfgBtn');
      await wait(2500);
      await wait(1500);
      await shot(this.name, fullClip());
    }
  },
  {
    id: '12', name: '12-对比源文件夹选择', desc: '对比源路径选择弹层（浏览 / 直达）',
    run: async function () {
      await evaluate('(function(){location.reload();return "reload";})()');
      await wait(2500);
      await poll('(typeof Picker!=="undefined")&&!!document.querySelector(".CodeMirror")',
        function (v) { return v === true; }, 60, '重载就绪');
      await evaluate('(function(){var el=document.getElementById("srcPathInput");' +
        'el.value=' + JSON.stringify(path.join(ROOT, 'demo')) + ';el.click();return "ok";})()');
      await wait(1800);
      await shot(this.name, fullClip());
    }
  },
  {
    id: '13', name: '13-自包含对比报告', desc: '无头产出的单文件 HTML 报告（双击即看）',
    run: async function () {
      var report = path.join(__dirname, '..', '演示文件', '04-报告产物', '对比报告-合同.pdf.html');
      if (!fs.existsSync(report)) { console.log('  !! 缺少 ' + report); return; }
      await cdpSend('Page.navigate', {
        url: 'http://127.0.0.1:' + HTTP_PORT + '/%E8%BD%AF%E8%91%97%E7%94%B3%E8%AF%B7%E6%9D%90%E6%96%99/%E6%BC%94%E7%A4%BA%E6%96%87%E4%BB%B6/04-%E6%8A%A5%E5%91%8A%E4%BA%A7%E7%89%A9/' + encodeURIComponent('对比报告-合同.pdf.html')
      }, 20000);
      await wait(3500);
      await shot(this.name, fullClip());
    }
  },
  {
    id: '15', name: '15-扫描版PDF识别', desc: '扫描版 PDF（无文字层）→ 内置离线 OCR → 标注差异',
    run: async function () {
      var scanL = path.join(DEMO_SCAN, '票据-扫描件A.pdf');
      if (!fs.existsSync(scanL)) { console.log('  !! 缺少扫描件演示文件'); return; }
      await freshPage();
      await setSrc(DEMO_SCAN);
      await pickFile('L', '票据-扫描件A.pdf');
      await wait(3500);
      // 加载扫描件 → 弹「检测到扫描版 PDF」确认框（用户确认识别的入口）
      await poll('(function(){var m=document.getElementById("ocrMask");return !!(m&&!m.hidden);})()',
        function (v) { return v === true; }, 100, 'OCR 确认弹窗');
      await wait(800);
      await shot('15-扫描版PDF识别弹窗', fullClip());
      await click('#ocrGoBtn');
      // 首次加载模型 + 逐页识别；等结果落定
      await poll('(function(){var st=document.getElementById("status");' +
        'var t=st?st.textContent:"";return t.indexOf("OCR 识别完成")>=0;})()',
        function (v) { return v === true; }, 240, 'OCR 完成');
      await wait(1500);
      await shot('15-扫描版PDF识别完成', fullClip());
    }
  },
  {
    id: '16', name: '16-对比源选择纯文本文件', desc: '通过对比源选择两个 .txt 文件对比（顶部筛选区联动）',
    run: async function () {
      await freshPage();
      await setSrc(DEMO_TXT);
      await pickDir('02-文本对比');
      await pickFile('L', '技术服务合同-草案.txt');
      await wait(1500);
      await pickFile('R', '技术服务合同-修订.txt');
      await wait(2500);
      await shot(this.name, fullClip());
    }
  },
  {
    id: '14', name: '14-窄屏移动端布局', desc: '900px 断点下的窄屏布局（抽屉式侧栏）',
    run: async function () {
      await cdpSend('Page.navigate', { url: 'http://127.0.0.1:' + HTTP_PORT + '/' }, 20000);
      await wait(2200);
      await poll('(typeof Pipeline!=="undefined")&&!!document.querySelector(".CodeMirror")',
        function (v) { return v === true; }, 60, '就绪');
      await setText(DEMO_L, DEMO_R);
      await wait(1200);
      await cdpSend('Emulation.setDeviceMetricsOverride', {
        width: 760, height: 900, deviceScaleFactor: 2, mobile: false
      });
      await wait(1200);
      await evaluate('(function(){window.dispatchEvent(new Event("resize"));return "ok";})()');
      await wait(1200);
      await shot(this.name, { x: 0, y: 0, width: 760, height: 900, scale: 2 });
      await cdpSend('Emulation.clearDeviceMetricsOverride');
      await wait(600);
    }
  }
];

// ---------------------------------------------------------------- 主流程
(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  var only = process.argv.slice(2);
  var list = SCENES.filter(function (s) {
    return !only.length || only.some(function (o) { return s.id === o || s.name.indexOf(o) === 0; });
  });
  await boot();
  var ok = 0;
  for (var i = 0; i < list.length; i++) {
    var s = list[i];
    console.log('[' + s.id + '] ' + s.desc);
    try { await s.run(); ok++; }
    catch (e) { console.log('  !! 失败：' + e.message); }
  }
  console.log('完成 ' + ok + '/' + list.length + ' 个场景 → ' + OUT);
  shutdown();
  process.exit(ok === list.length ? 0 : 1);
})().catch(function (e) {
  console.error('致命错误：' + e.stack);
  shutdown();
  process.exit(2);
});
