'use strict';
/**
 * gen-demo.js — 生成《用户手册》图文示例用的演示文档（真实中文内容）。
 *
 * 为什么需要：手册要求"举例说明"。示例文件内容如果是一串占位英文，
 * 截图里的差异就看不出软件在做什么。这里造两对真实形态的中文文档：
 *   01-文档对比/合同-草案.pdf  ↔ 合同-修订.pdf     （PDF 对比：文字版，可直接提取比对）
 *   01-文档对比/说明书-草案.docx ↔ 说明书-修订.docx （Word 对比）
 *
 * PDF 由 headless Edge 的 Page.printToPDF 生成（无需额外依赖）；
 * DOCX 由 docx 包生成（仅本脚本在 _build 内使用，不进软件本身）。
 *
 * 用法：node 软著申请材料/_build/gen-demo.js
 */
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');

var ROOT = path.join(__dirname, '..', '..');
var DEMO = path.join(__dirname, '..', '演示文件', '01-文档对比');
var SCAN = path.join(__dirname, '..', '演示文件', '05-扫描件对比');
var TMP = path.join(os.tmpdir(), 'gen-demo-' + process.pid);
var HTTP_PORT = 4810 + (process.pid % 200);
var DBG_PORT = 9810 + (process.pid % 200);
var BROWSER = process.env.EDGE_PATH ||
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';

var serverProc = null, edgeProc = null, ws = null, msgId = 0, pending = {};
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function cdpSend(method, params, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var id = ++msgId;
    var t = setTimeout(function () { delete pending[id]; reject(new Error('CDP 超时 ' + method)); }, timeoutMs || 60000);
    pending[id] = {
      resolve: function (v) { clearTimeout(t); resolve(v); },
      reject: function (e) { clearTimeout(t); reject(e); }
    };
    ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
  });
}

// ---------------------------------------------------------------- 合同正文
var CONTRACT_DRAFT = [
  ['h1', '技术服务合同（草案）'],
  ['meta', '合同编号：JSFW-2026-0117　　签订地点：北京市海淀区'],
  ['h2', '第一条　服务内容'],
  ['p', '乙方为甲方提供文件对比工具的技术支持服务，具体包括环境部署、参数调优与使用培训三项。'],
  ['p', '服务期间，乙方应按甲方要求提供不少于两次的现场支持。'],
  ['h2', '第二条　服务期限'],
  ['p', '本合同服务期限自 2026 年 1 月 1 日起至 2026 年 12 月 31 日止。'],
  ['h2', '第三条　服务费用与支付'],
  ['p', '本合同服务费用总额为人民币 80,000 元（含税）。'],
  ['p', '甲方应在合同签订后 10 个工作日内支付合同总额的 50%，余款于验收合格后支付。'],
  ['h2', '第四条　验收标准'],
  ['p', '乙方交付的工具应支持 PDF、Word 与 Excel 三类文件的对比，差异应以颜色区分。'],
  ['p', '甲方应在收到交付物后 15 个工作日内完成验收，逾期未提出异议视为验收合格。'],
  ['h2', '第五条　违约责任'],
  ['p', '任何一方违约，应向对方支付合同总额 10% 的违约金。'],
  ['p', '因不可抗力导致合同无法履行的，双方互不承担违约责任。'],
  ['h2', '第六条　争议解决'],
  ['p', '双方在履行本合同过程中发生争议的，应友好协商解决；协商不成的，提交北京仲裁委员会仲裁。'],
  ['h2', '第七条　其他'],
  ['p', '本合同一式两份，甲乙双方各执一份，自双方签字盖章之日起生效。']
];

var CONTRACT_REVISED = [
  ['h1', '技术服务合同（修订稿）'],
  ['meta', '合同编号：JSFW-2026-0117　　签订地点：北京市海淀区'],
  ['h2', '第一条　服务内容'],
  ['p', '乙方为甲方提供文件对比工具的技术支持服务，具体包括环境部署、参数调优、使用培训与年度巡检四项。'],
  ['p', '服务期间，乙方应按甲方要求提供不少于四次的现场支持。'],
  ['h2', '第二条　服务期限'],
  ['p', '本合同服务期限自 2026 年 1 月 1 日起至 2027 年 12 月 31 日止。'],
  ['h2', '第三条　服务费用与支付'],
  ['p', '本合同服务费用总额为人民币 96,000 元（含税）。'],
  ['p', '甲方应在合同签订后 15 个工作日内支付合同总额的 50%，余款于验收合格后支付。'],
  ['h2', '第四条　验收标准'],
  ['p', '乙方交付的工具应支持 PDF、Word、Excel 与扫描件四类文件的对比，差异应以颜色区分。'],
  ['p', '扫描件应能自动识别文字后参与对比，识别过程应全程在本机完成。'],
  ['p', '甲方应在收到交付物后 15 个工作日内完成验收，逾期未提出异议视为验收合格。'],
  ['h2', '第五条　违约责任'],
  ['p', '任何一方违约，应向对方支付合同总额 15% 的违约金。'],
  ['p', '因不可抗力导致合同无法履行的，双方互不承担违约责任。'],
  ['h2', '第六条　争议解决'],
  ['p', '双方在履行本合同过程中发生争议的，应友好协商解决；协商不成的，提交上海仲裁委员会仲裁。'],
  ['h2', '第七条　其他'],
  ['p', '本合同一式两份，甲乙双方各执一份，自双方签字盖章之日起生效。'],
  ['p', '本合同附件与正文具有同等法律效力。']
];

function html(title, blocks) {
  var body = blocks.map(function (b) {
    var tag = b[0], text = b[1];
    if (tag === 'h1') return '<h1>' + text + '</h1>';
    if (tag === 'h2') return '<h2>' + text + '</h2>';
    if (tag === 'meta') return '<p class="meta">' + text + '</p>';
    return '<p>' + text + '</p>';
  }).join('\n');
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>' + title + '</title>' +
    '<style>' +
    '@page{size:A4;margin:22mm 20mm 20mm 20mm}' +
    'body{font-family:"Songti SC","STSong","SimSun",serif;font-size:11.5pt;line-height:1.9;color:#111}' +
    'h1{font-size:17pt;text-align:center;font-weight:700;margin:0 0 6mm}' +
    'h2{font-size:12.5pt;font-weight:700;margin:7mm 0 2mm}' +
    'p{margin:0 0 2.2mm;text-indent:2em;text-align:justify}' +
    'p.meta{text-indent:0;text-align:center;color:#555;font-size:9.5pt;margin-bottom:8mm}' +
    '.foot{position:fixed;bottom:0;left:0;right:0;text-align:center;font-size:9pt;color:#777}' +
    '</style></head><body>' + body +
    '<div class="foot">文件对比工具演示件 · 仅用于软件功能示例</div></body></html>';
}

// ---------------------------------------------------------------- PDF（CDP printToPDF）
async function pdfFromHtml(srcHtml, outPdf) {
  var file = path.join(TMP, 'p' + Math.random().toString(36).slice(2) + '.html');
  fs.writeFileSync(file, srcHtml);
  await cdpSend('Page.navigate', { url: 'file://' + file }, 20000);
  await wait(900);
  var r = await cdpSend('Page.printToPDF', {
    printBackground: true,
    paperWidth: 8.27, paperHeight: 11.69,
    marginTop: 0.87, marginBottom: 0.79, marginLeft: 0.79, marginRight: 0.79,
    preferCSSPageSize: false
  }, 60000);
  fs.writeFileSync(outPdf, Buffer.from(r.data, 'base64'));
  console.log('  ' + path.basename(outPdf) + '  ' + (fs.statSync(outPdf).size / 1024).toFixed(0) + 'KB');
}

// ---------------------------------------------------------------- 扫描件 PDF（无文字层）
var minipdf = require('./minipdf');

/**
 * 造一份"扫描件"：先把票据 HTML 用 headless 渲染并截整页图，再把 JPEG 包进 PDF。
 * 产出的 PDF 不含任何文字层（pdf.js 提不到文本）——软件据此判定为扫描件并提示 OCR。
 */
async function scanPdfFromHtml(srcHtml, outPdf) {
  var file = path.join(TMP, 's' + Math.random().toString(36).slice(2) + '.html');
  fs.writeFileSync(file, srcHtml);
  await cdpSend('Page.navigate', { url: 'file://' + file }, 20000);
  await wait(1200);
  var metrics = await cdpSend('Page.getLayoutMetrics');
  var cw = metrics.cssContentSize || metrics.contentSize;
  var shot = await cdpSend('Page.captureScreenshot', {
    format: 'jpeg', quality: 92,
    clip: { x: 0, y: 0, width: cw.width, height: cw.height, scale: 2 },
    captureBeyondViewport: true
  }, 60000);
  var jpeg = Buffer.from(shot.data, 'base64');
  var pdf = minipdf.fromJpeg(jpeg, Math.round(cw.width * 2), Math.round(cw.height * 2));
  fs.writeFileSync(outPdf, pdf);
  console.log('  ' + path.basename(outPdf) + '  ' + (pdf.length / 1024).toFixed(0) + 'KB（扫描件·无文字层）');
}

/** 票据单据的 HTML（扫描件内容）：两张单据只改几处信息，OCR 后能对比出差异 */
function receiptHtml(no, date, qty, amount, name) {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">' +
    '<style>@page{size:A4;margin:0}body{margin:0;padding:40px 46px;' +
    'font-family:"Songti SC","STSong",serif;background:#fff;color:#1b1b1b}' +
    '.sheet{border:2px solid #333;padding:26px 30px}' +
    'h1{text-align:center;font-size:26px;letter-spacing:6px;margin:0 0 6px}' +
    '.sub{text-align:center;font-size:13px;color:#666;margin-bottom:18px}' +
    'table{border-collapse:collapse;width:100%;font-size:15px}' +
    'td,th{border:1px solid #444;padding:8px 10px}' +
    'th{background:#eee;font-weight:700}' +
    '.kv{font-size:15px;line-height:2.2}' +
    '.sign{margin-top:26px;font-size:15px;display:flex;justify-content:space-between}' +
    '</style></head><body><div class="sheet">' +
    '<h1>物资验收单</h1>' +
    '<div class="sub">单据编号：' + no + '　　开具日期：' + date + '</div>' +
    '<div class="kv">供货单位：北京示例供应链有限公司<br>收货单位：产品研发中心　　验收人：张工</div>' +
    '<table><tr><th>序号</th><th>物资名称</th><th>规格</th><th>数量</th><th>单价（元）</th><th>金额（元）</th></tr>' +
    '<tr><td>1</td><td>' + name + '</td><td>A4·70g</td><td>' + qty + ' 箱</td><td>120.00</td><td>' + amount + '</td></tr>' +
    '<tr><td>2</td><td>中性笔</td><td>0.5mm 黑</td><td>20 盒</td><td>35.00</td><td>700.00</td></tr>' +
    '</table>' +
    '<div class="kv" style="margin-top:16px">合计金额（大写）：人民币壹仟贰佰柒拾元整</div>' +
    '<div class="sign"><span>验收结论：数量与规格相符，同意入库</span><span>（盖章处）</span></div>' +
    '</div></body></html>';
}

// ---------------------------------------------------------------- DOCX（自带的零依赖生成器）
var DocxBuilder = require('./docxlib').DocxBuilder;

/**
 * 生成 .docx 演示件。
 * 用本目录自带的 docxlib（零依赖 OOXML 生成器），不引入第三方包 ——
 * 申报材料的所有生成脚本都只用 Node 标准库，换台电脑就能重跑。
 */
function docxFromBlocks(title, blocks, outDocx) {
  var b = new DocxBuilder({
    headerLeft: title,
    fontSize: 23,               // 11.5pt
    fontName: '宋体',
    fontEastAsia: '宋体',
    bodySize: 23,
    title: title,
    creator: '文件对比工具演示件'
  });
  var items = [];
  blocks.forEach(function (blk) {
    if (blk[0] === 'h1') items.push({ t: 'h1', text: blk[1] });
    else if (blk[0] === 'h2') items.push({ t: 'h3', text: blk[1] });
    else if (blk[0] === 'meta') items.push({ t: 'note', text: blk[1] });
    else items.push({ t: 'p', text: blk[1] });
  });
  b.addFlowPage(items);
  var buf = b.build();
  fs.writeFileSync(outDocx, buf);
  console.log('  ' + path.basename(outDocx) + '  ' + (buf.length / 1024).toFixed(0) + 'KB');
}

// ---------------------------------------------------------------- 主流程
(async function main() {
  fs.mkdirSync(TMP, { recursive: true });
  fs.mkdirSync(DEMO, { recursive: true });

  // 本地静态服务：给 PDF 生成页留一个同源环境（file:// 也能打印，但统一走它更稳）
  serverProc = cp.spawn(process.execPath, [path.join(ROOT, 'serve.js'), String(HTTP_PORT)], { stdio: 'ignore' });
  await wait(1200);

  var profile = path.join(os.tmpdir(), 'edge-demo-' + process.pid);
  edgeProc = cp.spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-sandbox',
    '--remote-debugging-port=' + DBG_PORT, '--user-data-dir=' + profile,
    'http://127.0.0.1:' + HTTP_PORT + '/'], { stdio: 'ignore' });
  var target = null;
  for (var k = 0; k < 60; k++) {
    try {
      var list = await (await fetch('http://127.0.0.1:' + DBG_PORT + '/json/list')).json();
      target = (list || []).filter(function (x) { return x.type === 'page'; })[0];
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

  console.log('生成 PDF 演示件：');
  await pdfFromHtml(html('技术服务合同（草案）', CONTRACT_DRAFT), path.join(DEMO, '合同-草案.pdf'));
  await pdfFromHtml(html('技术服务合同（修订稿）', CONTRACT_REVISED), path.join(DEMO, '合同-修订.pdf'));

  console.log('生成 Word 演示件：');
  var MANUAL_DRAFT = [
    ['h1', '文件对比工具使用说明书'],
    ['meta', '版本：草案　　编制日期：2026-03-02　　编制：技术部'],
    ['h2', '一、概述'],
    ['p', '本文档说明文件对比工具的安装、启动与基本操作。'],
    ['p', '该工具用于比较两份文本或文档之间的差异，并以颜色标注差异位置。'],
    ['h2', '二、运行环境'],
    ['p', '浏览器模式：Node.js 22 及以上版本，任意主流浏览器。'],
    ['p', '桌面模式：macOS 12 及以上、Windows 10 及以上、主流 64 位 Linux。'],
    ['h2', '三、主要功能'],
    ['p', '1. 文本对比：粘贴两段文字，逐行与逐字符高亮差异。'],
    ['p', '2. 文件对比：支持 PDF 与 Word 文件的读取、渲染与差异标注。'],
    ['p', '3. 导出报告：将当前对比结果导出为自包含 HTML 报告。'],
    ['h2', '四、操作步骤'],
    ['p', '第一步，启动服务并在浏览器打开页面。'],
    ['p', '第二步，在侧边栏设置对比源文件夹。'],
    ['p', '第三步，在顶部下拉框选择原始文件与修改文件。'],
    ['p', '第四步，查看结果区差异并根据需要导出报告。'],
    ['h2', '五、注意事项'],
    ['p', '所有对比均在本机完成，文件不会上传到任何服务器。']
  ];
  var MANUAL_REVISED = [
    ['h1', '文件对比工具使用说明书'],
    ['meta', '版本：修订稿　　编制日期：2026-03-18　　编制：技术部'],
    ['h2', '一、概述'],
    ['p', '本文档说明文件对比工具的安装、启动与各项操作。'],
    ['p', '该工具用于比较两份文本或文档之间的差异，并以颜色标注差异位置，支持跨区域协同滚动。'],
    ['h2', '二、运行环境'],
    ['p', '浏览器模式：Node.js 22 及以上版本，任意主流浏览器。'],
    ['p', '桌面模式：macOS 12 及以上、Windows 10 及以上、主流 64 位 Linux。'],
    ['p', '扫描件识别：无需安装额外组件，模型随软件内置。'],
    ['h2', '三、主要功能'],
    ['p', '1. 文本对比：粘贴两段文字，逐行与逐字符高亮差异。'],
    ['p', '2. 文件对比：支持 PDF、Word 与 Excel 文件的读取、渲染与差异标注。'],
    ['p', '3. 扫描件识别：扫描版 PDF 可启用内置文字识别后参与对比。'],
    ['p', '4. 导出报告：将当前对比结果导出为自包含 HTML 报告，或导出带格式还原的 Excel 报告。'],
    ['h2', '四、操作步骤'],
    ['p', '第一步，启动服务并在浏览器打开页面。'],
    ['p', '第二步，在侧边栏设置对比源文件夹，可点击路径框浏览选择。'],
    ['p', '第三步，在顶部下拉框选择原始文件与修改文件。'],
    ['p', '第四步，查看结果区差异，必要时切换忽略选项。'],
    ['p', '第五步，导出报告并发送给相关人员。'],
    ['h2', '五、注意事项'],
    ['p', '所有对比均在本机完成，文件不会上传到任何服务器。'],
    ['p', '忽略选项默认全部勾选，取消勾选可获得更严格的差异结果。']
  ];
  console.log('生成扫描件演示件（无文字层 PDF）：');
  fs.mkdirSync(SCAN, { recursive: true });
  await scanPdfFromHtml(receiptHtml('YS-2026-0311', '2026-03-11', '30', '3,600.00', '复印纸'),
    path.join(SCAN, '票据-扫描件A.pdf'));
  await scanPdfFromHtml(receiptHtml('YS-2026-0311', '2026-03-11', '36', '4,320.00', '复印纸'),
    path.join(SCAN, '票据-扫描件B.pdf'));

  docxFromBlocks('文件对比工具使用说明书（草案）', MANUAL_DRAFT, path.join(DEMO, '说明书-草案.docx'));
  docxFromBlocks('文件对比工具使用说明书（修订稿）', MANUAL_REVISED, path.join(DEMO, '说明书-修订.docx'));

  try { ws.close(); } catch (e) {}
  try { edgeProc.kill(); } catch (e) {}
  try { serverProc.kill(); } catch (e) {}
  console.log('完成 → ' + DEMO);
  process.exit(0);
})().catch(function (e) {
  console.error('失败：' + e.stack);
  try { if (ws) ws.close(); } catch (x) {}
  try { if (edgeProc) edgeProc.kill(); } catch (x) {}
  try { if (serverProc) serverProc.kill(); } catch (x) {}
  process.exit(1);
});
