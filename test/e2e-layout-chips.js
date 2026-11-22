/**
 * e2e-layout-chips.js — 端到端验证三件事（真实浏览器量真实布局）：
 *   ① 三个主区域（结果区 / 编辑区 / PDF 区）任选隐藏时，剩下的区域铺满可用高度；
 *   ② 原始文件 / 修改文件框里按空格，输入的关键词固化成胶囊（可逐个删除）；
 *   ③ 两边都选好 .xlsx 后自动弹出表格对比设置浮层。
 *
 * 运行：node test/e2e-layout-chips.js   （需要本机装有 Edge / Chrome；找不到则跳过，不算失败）
 */
'use strict';
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');

var ROOT = path.join(__dirname, '..');
var HTTP_PORT = 3700 + (process.pid % 200);
var DBG_PORT = 9900 + (process.pid % 200);
var FIX = path.join(os.tmpdir(), 'compare-layout-' + process.pid);

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
var EDGE = findBrowser();
if (!EDGE) {
  console.log('跳过：未找到 Edge / Chrome');
  process.exit(0);
}

function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function fetchJson(url) { return fetch(url).then(function (r) { return r.json(); }); }

var serverProc = null, edgeProc = null, ws = null, msgId = 0, pending = {};
function cdpSend(method, params) {
  return new Promise(function (resolve, reject) {
    var id = ++msgId;
    var timer = setTimeout(function () {
      delete pending[id];
      reject(new Error('CDP 调用超时：' + method));
    }, 30000);
    pending[id] = {
      resolve: function (v) { clearTimeout(timer); resolve(v); },
      reject: function (e) { clearTimeout(timer); reject(e); }
    };
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
      if (n <= 0) throw new Error('等待超时：' + label + '，最后值 ' + JSON.stringify(v).slice(0, 200));
      return wait(300).then(function () { return loop(n - 1); });
    });
  })(tries == null ? 40 : tries);
}

var passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok  ' + name + (detail ? '（' + detail + '）' : '')); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '：' + detail : '')); }
}
function cleanup() {
  try { if (ws) ws.close(); } catch (e) {}
  try { if (edgeProc) cp.execSync('taskkill /PID ' + edgeProc.pid + '/T /F 2>nul'); } catch (e2) {}
  try { if (serverProc) serverProc.kill(); } catch (e3) {}
  try { fs.rmSync(FIX, { recursive: true, force: true }); } catch (e4) {}
  try { fs.rmSync(path.join(os.tmpdir(), 'edge-layout-profile-' + process.pid), { recursive: true, force: true }); } catch (e5) {}
}

/** 造两个最小 .xlsx（ZIP + 极简工作簿），只要能被 XlsxFlow 读到 sheet 名即可 */
function buildXlsx(sheetName) {
  var zlib = require('zlib');
  function crc32(buf) {
    var c, crc = 0xFFFFFFFF;
    for (var n = 0; n < buf.length; n++) {
      c = (crc ^ buf[n]) & 0xFF;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      crc = c ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function zip(files) {
    var chunks = [], central = [], offset = 0;
    files.forEach(function (f) {
      var nameBuf = Buffer.from(f.name, 'utf8');
      var data = Buffer.from(f.data, 'utf8');
      var crc = crc32(data);
      var local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0, 6);
      local.writeUInt16LE(0, 8);          // 无压缩
      local.writeUInt16LE(0, 10);
      local.writeUInt16LE(0, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);
      chunks.push(local, nameBuf, data);
      var cen = Buffer.alloc(46);
      cen.writeUInt32LE(0x02014b50, 0);
      cen.writeUInt16LE(20, 4);
      cen.writeUInt16LE(20, 6);
      cen.writeUInt16LE(0, 8);
      cen.writeUInt16LE(0, 10);
      cen.writeUInt16LE(0, 12);
      cen.writeUInt16LE(0, 14);
      cen.writeUInt32LE(crc, 16);
      cen.writeUInt32LE(data.length, 20);
      cen.writeUInt32LE(data.length, 24);
      cen.writeUInt16LE(nameBuf.length, 28);
      cen.writeUInt32LE(offset, 42);
      central.push(cen, nameBuf);
      offset += local.length + nameBuf.length + data.length;
    });
    var cdBuf = Buffer.concat(central);
    var end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(cdBuf.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat(chunks.concat([cdBuf, end]));
  }
  var sheetXml = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
    + '<row r="1"><c r="A1" t="inlineStr"><is><t>编号</t></is></c><c r="B1" t="inlineStr"><is><t>名称</t></is></c></row>'
    + '<row r="2"><c r="A2" t="inlineStr"><is><t>001</t></is></c><c r="B2" t="inlineStr"><is><t>测试</t></is></c></row>'
    + '</sheetData></worksheet>';
  var wbXml = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<sheets><sheet name="' + sheetName + '" sheetId="1" r:id="rId1"/></sheets></workbook>';
  var relXml = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Target="worksheets/sheet1.xml" '
    + 'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/></Relationships>';
  var rootXml = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Target="xl/workbook.xml" '
    + 'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"/></Relationships>';
  var ctXml = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    + '</Types>';
  return zip([
    { name: '[Content_Types].xml', data: ctXml },
    { name: '_rels/.rels', data: rootXml },
    { name: 'xl/workbook.xml', data: wbXml },
    { name: 'xl/_rels/workbook.xml.rels', data: relXml },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml }
  ]);
}

(async function main() {
  fs.mkdirSync(FIX, { recursive: true });
  fs.writeFileSync(path.join(FIX, 'old.xlsx'), buildXlsx('旧表'));
  fs.writeFileSync(path.join(FIX, 'new.xlsx'), buildXlsx('新表'));

  serverProc = cp.spawn(process.execPath, [path.join(ROOT, 'serve.js'), String(HTTP_PORT)], { stdio: 'ignore' });
  var i;
  for (i = 0; i < 40; i++) {
    try { await fetchJson('http://127.0.0.1:' + HTTP_PORT + '/api/list?path=' + encodeURIComponent(FIX)); break; }
    catch (e) { await wait(250); }
  }

  edgeProc = cp.spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--window-size=1400,1000',
    '--remote-debugging-port=' + DBG_PORT, '--user-data-dir=' + path.join(os.tmpdir(), 'edge-layout-profile-' + process.pid),
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

  await poll('(typeof FilterBar!=="undefined")&&!!document.querySelector(".CodeMirror")',
    function (v) { return v === true; }, 40, '页面脚本就绪');

  // ================= ① 区域高度自适应 =================
  console.log('\n区域高度自适应');

  // 量一次：布局容器高度 + 各区域可见性与高度
  var measure = '(function(){'
    + 'var lay=document.getElementById("layout");'
    + 'var res=document.getElementById("results"),ed=document.getElementById("editors"),pa=document.getElementById("pdfarea");'
    + 'function vis(el){return !el.classList.contains("hidden");}'
    + 'return JSON.stringify({lay:lay.getBoundingClientRect().height,'
    + 'res:res.getBoundingClientRect().height,ed:ed.getBoundingClientRect().height,pa:pa.getBoundingClientRect().height,'
    + 'visRes:vis(res),visEd:vis(ed),visPa:vis(pa),'
    + 'resBottom:res.getBoundingClientRect().bottom,layBottom:lay.getBoundingClientRect().bottom});})()';

  // 情形 A：只留主区域1（隐藏编辑区 + 主区域3 未加载 → 本来就隐藏）
  await evaluate('document.getElementById("toggleEditorsBtn").click()');
  await wait(500);
  var a = JSON.parse(await evaluate(measure));
  check('只有主区域1 时它铺满布局高度', a.visRes && !a.visEd && !a.visPa && a.res >= a.lay - 30,
    '结果区=' + Math.round(a.res) + ' 布局=' + Math.round(a.lay));
  check('只有主区域1 时结果区底边贴近布局底边', Math.abs(a.resBottom - a.layBottom) <= 30,
    '结果区底=' + Math.round(a.resBottom) + ' 布局底=' + Math.round(a.layBottom));

  // 情形 B：主区域1 + 编辑区
  await evaluate('document.getElementById("toggleEditorsBtn").click()');
  await wait(500);
  var b = JSON.parse(await evaluate(measure));
  check('主区域1 与编辑区都在时各自占位（不再被 65vh 上限卡死）',
    b.visRes && b.visEd && b.res > 150 && b.ed > 150,
    '结果区=' + Math.round(b.res) + ' 编辑区=' + Math.round(b.ed));
  check('两区高度之和不超过布局高度（不互相撑破）', b.res + b.ed <= b.lay + 40,
    '和=' + Math.round(b.res + b.ed) + ' 布局=' + Math.round(b.lay));

  // 情形 C：主区域1 + 主区域3（隐藏编辑区，再让主区域3 有内容）
  await evaluate('document.getElementById("toggleEditorsBtn").click()');
  await wait(300);
  await evaluate('(function(){var i=document.getElementById("srcPathInput");i.value='
    + JSON.stringify(FIX.replace(/\\/g, '/')) + ';document.getElementById("srcLoadBtn").click();return 1;})()');
  await wait(800);
  var c = JSON.parse(await evaluate(measure));
  check('主区域3 隐藏时主区域1 仍然铺满', !c.visPa && c.res >= c.lay - 30,
    '结果区=' + Math.round(c.res) + ' 布局=' + Math.round(c.lay));


  // ================= ② 胶囊关键词 =================
  console.log('\n空格分词 → 胶囊');

  await evaluate('(function(){'
    + 'var f=document.getElementById("fileSelL");var inp=f.querySelector(".cb-input");'
    + 'inp.focus();inp.value="当归";'
    + 'inp.dispatchEvent(new Event("input",{bubbles:true}));'
    + 'inp.dispatchEvent(new KeyboardEvent("keydown",{key:" ",bubbles:true}));'
    + 'inp.value="上海";'
    + 'inp.dispatchEvent(new Event("input",{bubbles:true}));'
    + 'inp.dispatchEvent(new KeyboardEvent("keydown",{key:" ",bubbles:true}));'
    + 'return 1;})()');
  await wait(300);
  var chips = JSON.parse(await evaluate('(function(){'
    + 'var f=document.getElementById("fileSelL");'
    + 'var cs=f.querySelectorAll(".cb-chip");'
    + 'var labels=[];for(var i=0;i<cs.length;i++){labels.push(cs[i].querySelector(".cb-chip-label").textContent);}'
    + 'var inp=f.querySelector(".cb-input");'
    + 'var rows=f.querySelectorAll(".cb-list .cb-row");'
    + 'return JSON.stringify({count:cs.length,labels:labels,input:inp.value,rows:rows.length});})()'));
  check('每按一次空格固化成一枚胶囊', chips.count === 2, '胶囊数=' + chips.count + ' 标签=' + JSON.stringify(chips.labels));
  check('胶囊内容就是输入过的关键词', chips.labels.join(',') === '当归,上海', JSON.stringify(chips.labels));
  check('固化后输入框已清空（可以继续输入下一个词）', chips.input === '', JSON.stringify(chips.input));

  // 删除一枚胶囊（此时胶囊是 ["当归","上海"]）
  await evaluate('(function(){var f=document.getElementById("fileSelL");'
    + 'f.querySelectorAll(".cb-chip .cb-chip-x")[0].click();return 1;})()');
  await wait(200);
  var afterDel = JSON.parse(await evaluate('(function(){'
    + 'var f=document.getElementById("fileSelL");'
    + 'var cs=f.querySelectorAll(".cb-chip");'
    + 'var labels=[];for(var i=0;i<cs.length;i++){labels.push(cs[i].querySelector(".cb-chip-label").textContent);}'
    + 'return JSON.stringify({count:cs.length,labels:labels});})()'));
  check('胶囊可逐个删除', afterDel.count === 1 && afterDel.labels[0] === '上海', JSON.stringify(afterDel.labels));

  // ---------- 输入法（IME）组字：选字的空格不能形成胶囊 ----------
  // 拼音输入法的真实事件序列：
  //   keydown(空格, isComposing=true) → compositionupdate → compositionend → input
  // 选字那次空格必须让给输入法，否则会把拼音串当成关键词（guang'dong 而不是 广东）。
  var ime = JSON.parse(await evaluate([
    '(function(){',
    'var f=document.getElementById("fileSelL");',
    'var inp=f.querySelector(".cb-input");',
    // 先清掉上一轮用例留下的胶囊，让断言只看本次输入法行为
    'var xs=f.querySelectorAll(".cb-chip .cb-chip-x");',
    'for(var i=xs.length-1;i>=0;i--){xs[i].click();}',
    'inp.focus();',
    'inp.value="";',
    // 组字开始：拼音串进入输入框
    'inp.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true,data:""}));',
    'inp.value="guangdong";',
    'inp.dispatchEvent(new CompositionEvent("compositionupdate",{bubbles:true,data:"guangdong"}));',
    'inp.dispatchEvent(new Event("input",{bubbles:true}));',
    // 选字那一次空格：keydown 带 isComposing=true，必须放行给输入法
    'var ev=new KeyboardEvent("keydown",{key:" ",bubbles:true,cancelable:true,isComposing:true});',
    'inp.dispatchEvent(ev);',
    'var prevented=ev.defaultPrevented;',
    // 选字完成：拼音变成真实文字
    'inp.value="广东";',
    'inp.dispatchEvent(new CompositionEvent("compositionend",{bubbles:true,data:"广东"}));',
    'inp.dispatchEvent(new Event("input",{bubbles:true}));',
    'var afterIme={chips:f.querySelectorAll(".cb-chip").length,value:inp.value,prevented:prevented};',
    // 选字完成后再按一次空格：这时才是真正的分词空格，应该形成胶囊
    'var ev2=new KeyboardEvent("keydown",{key:" ",bubbles:true,cancelable:true,isComposing:false});',
    'inp.dispatchEvent(ev2);',
    'var cs=f.querySelectorAll(".cb-chip");',
    'var labels=[];for(var i=0;i<cs.length;i++){labels.push(cs[i].querySelector(".cb-chip-label").textContent);}',
    'return JSON.stringify({afterIme:afterIme,labels:labels,value:inp.value});})()'
  ].join('')));
  check('输入法选字的空格不会形成胶囊（拼音不被当成关键词）',
    ime.afterIme.chips === 0 && ime.afterIme.value === '广东',
    JSON.stringify(ime.afterIme));
  check('输入法选字那一次空格没有被拦截（让给输入法选字）', ime.afterIme.prevented === false);
  check('选字完成后再按空格，胶囊内容是选好的中文而非拼音',
    ime.labels.length === 1 && ime.labels[0] === '广东',
    JSON.stringify(ime.labels));

  // 清掉胶囊与下拉状态，避免影响后面的 Excel 选文件用例
  await evaluate('(function(){'
    + 'var f=document.getElementById("fileSelL");'
    + 'var xs=f.querySelectorAll(".cb-chip .cb-chip-x");'
    + 'for(var i=xs.length-1;i>=0;i--){xs[i].click();}'
    + 'var inp=f.querySelector(".cb-input");inp.value="";'
    + 'inp.dispatchEvent(new Event("input",{bubbles:true}));'
    + 'return 1;})()');
    await wait(300);

  // ================= ③ Excel 自动弹层 =================
  console.log('\nExcel 两文件选好后自动弹设置浮层');
  // 用下拉点选（等价用户点选文件）
  var picked = await evaluate('(function(){'
    + 'function setSel(id,label){'
    + '  var host=document.getElementById(id);'
    + '  var inp=host.querySelector(".cb-input");'
    + '  inp.focus();'
    + '  inp.value="";'
    + '  inp.dispatchEvent(new Event("input",{bubbles:true}));'
    + '  var rows=host.querySelectorAll(".cb-list .cb-row");'
    + '  for(var i=0;i<rows.length;i++){ if(rows[i].textContent===label){ rows[i].click(); return 1; } }'
    + '  return 0;}'
    + 'var a=setSel("fileSelL","old.xlsx");'
    + 'var b=setSel("fileSelR","new.xlsx");'
    + 'return JSON.stringify({a:a,b:b});})()');
  check('两侧 .xlsx 都能从下拉选中', JSON.parse(picked).a === 1 && JSON.parse(picked).b === 1, picked);

  var opened = await poll('(function(){var m=document.getElementById("xlsxCfgMask");'
    + 'return m && !m.hidden ? 1 : 0;})()', function (v) { return v === 1; }, 30, '表格对比设置浮层自动弹出');
  check('两侧选好后自动弹出表格对比设置浮层', opened === 1);

  var title = await evaluate('(document.getElementById("xlsxCfgTitle")||{}).textContent||""');
  check('浮层标题是表格对比配置', /表格对比配置/.test(title), title);

  // 关闭浮层后不应立刻重复弹（防抖标记生效）
  await evaluate('document.getElementById("xlsxCfgCancel").click()');
  await wait(1200);
  var reopened = await evaluate('(function(){var m=document.getElementById("xlsxCfgMask");return m && !m.hidden ? 1 : 0;})()');
  check('关掉后不会立刻重复弹（同一轮选择只弹一次）', reopened === 0);

  // ---------- ④ 主区域3 有内容时的高度分配 ----------
  console.log('\n主区域3 显示后的高度分配');
  // 重新打开浮层并确认对比 → 主区域3 渲染出两侧原表
  await evaluate('document.getElementById("xlsxCfgBtn").click()');
  await poll('(function(){var m=document.getElementById("xlsxCfgMask");'
    + 'return m && !m.hidden ? 1 : 0;})()', function (v) { return v === 1; }, 30, '浮层再次打开');
  await evaluate('document.getElementById("xlsxCfgOk").click()');
  await poll('(function(){var p=document.getElementById("pdfarea");'
    + 'return p && !p.classList.contains("hidden") ? 1 : 0;})()',
    function (v) { return v === 1; }, 40, '主区域3 显示');
  await wait(800);
  var d = JSON.parse(await evaluate(measure));
  check('主区域3 可见时它拿到与主区域1 相当的高度（不再被 65vh 卡成固定值）',
    d.visPa && d.pa > 120 && Math.abs(d.res - d.pa) < 60,
    '结果区=' + Math.round(d.res) + ' 主区域3=' + Math.round(d.pa) + ' 布局=' + Math.round(d.lay));
  check('主区域3 可见时主区域1 不再铺满（两个区平分）', d.res < d.lay - 60,
    '结果区=' + Math.round(d.res) + ' 布局=' + Math.round(d.lay));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  cleanup();
  if (failed) process.exit(1);
})().catch(function (e) {
  console.error('e2e 失败：', e && (e.stack || e.message));
  cleanup();
  process.exit(1);
});
