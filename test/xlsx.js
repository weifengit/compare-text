/**
 * xlsx.js — Excel 对比专项测试：读取层 / 对比算法 / 报告生成 / 三视图渲染。
 * 运行：node test/xlsx.js
 *
 * 覆盖重点（都是实际踩过或验证过的坑）：
 *   1. definedNames 预清洗：超宽 _FilterDatabase 必须收窄，否则真实文件会吃 3GB 内存
 *   2. 日期跨类型比较：ExcelJS 读出的 Date 与字符串日期必须判等
 *   3. 多行表头合并：父/子列名拼接
 *   4. 表头以上内容保留
 *   5. 多 sheet 对比：只在一侧存在的 sheet 要整表记新增/删除
 *   6. 报告格式还原：列宽、表头样式、冻结窗格
 */
'use strict';
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var XlsxIO = require('../src/xlsx-io.js');
var XlsxCompare = require('../src/xlsx-compare.js');
var XlsxReport = require('../src/xlsx-report.js');
var ExcelJS = require('../lib/exceljs.min.js');

var passed = 0, failed = 0;
function check(name, fn) {
  try {
    var r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(function () { passed++; console.log('  ok  ' + name); },
        function (e) { failed++; console.log('FAIL  ' + name + '\n      ' + (e && e.message)); });
    }
    passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL  ' + name + '\n      ' + (e && e.message));
  }
}

var TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-xlsx-'));

// ---------- 造测试用 xlsx ----------

/** 生成一个工作簿，返回 Buffer。spec = { sheetName: { headerRows:[[...]], data:[[...]] } } */
function makeWorkbook(spec, opts) {
  opts = opts || {};
  var wb = new ExcelJS.Workbook();
  Object.keys(spec).forEach(function (name) {
    var d = spec[name];
    var ws = wb.addWorksheet(name);
    (d.headerRows || []).forEach(function (r) { ws.addRow(r); });
    (d.data || []).forEach(function (r) { ws.addRow(r); });
    if (d.colWidths) d.colWidths.forEach(function (w, i) { ws.getColumn(i + 1).width = w; });
    if (d.freeze) ws.views = [d.freeze];
  });
  if (opts.wideFilterName) {
    // 直接注入超宽定义名：模拟 WPS 把 _FilterDatabase 写到整张表的极端情况
    wb._definedNames = wb._definedNames || {};
  }
  return wb.xlsx.writeBuffer().then(function (b) { return Buffer.from(b); });
}

/** 往 workbook.xml 里注入一个超宽 _FilterDatabase（模拟 WPS 的坏定义名） */
function injectWideDefinedName(buf, sheetName, range) {
  var JSZip = require('../lib/jszip.min.js');
  return JSZip.loadAsync(buf).then(function (zip) {
    return zip.file('xl/workbook.xml').async('string').then(function (xml) {
      var add = '<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">' +
        sheetName + '!' + range + '</definedName></definedNames>';
      // 插在 </workbook> 前
      var out = xml.replace('</workbook>', add + '</workbook>');
      zip.file('xl/workbook.xml', out);
      return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    });
  });
}

function tmpFile(name) { return path.join(TMP, name); }

// ---------- 用例 ----------

console.log('xlsx tests\n');

var A = tmpFile('old.xlsx');
var B = tmpFile('new.xlsx');

// 数据设计得能同时覆盖：新增 / 修改 / 删除 / 多行表头 / 表头以上内容
var HDR1 = ['公共列', '公共列', '公共列', '公共列', '公共列'];
var HDR2 = ['提取方式', '执行标准', '生产日期', '提取物批号', '指标成分'];
var OLD_ROWS = [
  ['罐提', '国标', '2024-05-01', 'P001', '98.5'],
  ['罐提', '国标', '2024-05-02', 'P002', '97.0'],
  ['逆流', '省标', '2024-05-03', 'P003', '96.5']
];
var NEW_ROWS = [
  ['罐提', '国标', '2024-05-01', 'P001', '98.5'],   // 完全相同
  ['罐提', '国标', '2024-05-02', 'P002', '97.5'],   // 修改：指标成分 97.0 → 97.5
  ['逆流', '省标', '2024-05-04', 'P004', '95.0']    // 新增 P004，删除 P003
];

var ready = makeWorkbook({
  '生产数据': { headerRows: [HDR1, HDR2], data: OLD_ROWS, colWidths: [16, 12, 14, 18, 9], freeze: { state: 'frozen', ySplit: 2 } }
}).then(function (b) { fs.writeFileSync(A, b); })
  .then(function () {
    return makeWorkbook({
      '生产数据': { headerRows: [HDR1, HDR2], data: NEW_ROWS, colWidths: [16, 12, 14, 18, 9], freeze: { state: 'frozen', ySplit: 2 } },
      '新增表': { headerRows: [['批号', '数值']], data: [['N001', 1]] }
    });
  })
  .then(function (b) { fs.writeFileSync(B, b); });

// ---- 1. 工具函数 ----
function t1() {
  assert.strictEqual(XlsxIO.colIndex('A'), 1);
  assert.strictEqual(XlsxIO.colIndex('Z'), 26);
  assert.strictEqual(XlsxIO.colIndex('AA'), 27);
  assert.strictEqual(XlsxIO.colIndex('XFC'), 16383);
  assert.strictEqual(XlsxIO.colLetter(1), 'A');
  assert.strictEqual(XlsxIO.colLetter(27), 'AA');

  var ref = XlsxIO.parseAreaRef('生产数据!$A$2:$XFC$2025');
  assert.strictEqual(ref.cols, 16383);
  assert.strictEqual(ref.rows, 2024);
  assert.strictEqual(ref.sheetPrefix, '生产数据!');
  assert.strictEqual(ref.normalized, '$A$2:$XFC$2025');
}

function t2() {
  // 非 xlsx 字节必须给出可读的错误，而不是让 ExcelJS 抛 "Corrupted zip"
  var e1 = XlsxIO.zipHeadError(new Uint8Array(0), 'a.xlsx');
  assert.ok(e1 && e1.indexOf('为空') >= 0, '空文件应提示为空：' + e1);
  var e2 = XlsxIO.zipHeadError(new Uint8Array([1, 2, 3, 4, 5]), 'b.xlsx');
  assert.ok(e2 && e2.indexOf('不是有效的 .xlsx') >= 0, '非 ZIP 应提示格式：' + e2);
  assert.strictEqual(XlsxIO.zipHeadError(new Uint8Array([0x50, 0x4B, 3, 4]), 'c.xlsx'), null);
}

function t3() {
  // 单元格取值：富文本展开、公式取 result、日期不带时区偏移
  assert.strictEqual(XlsxIO.cellText({ richText: [{ text: 'a' }, { text: 'b' }] }), 'ab');
  assert.strictEqual(XlsxIO.cellText({ formula: 'B2*2', result: 197 }), '197');
  assert.strictEqual(XlsxIO.cellText({ formula: 'A1' }), '=A1');   // 无缓存结果时退化
  assert.strictEqual(XlsxIO.cellText(0), '0');
  assert.strictEqual(XlsxIO.cellText(0.0), '0');
  assert.strictEqual(XlsxIO.cellText(new Date(Date.UTC(2024, 4, 1))), '2024-05-01');
  assert.strictEqual(XlsxIO.cellText(null), '');
}

// ---- 2. 定义名清洗 ----
function t4() {
  var xml = '<workbook><sheets><sheet name="生产数据" sheetId="1"/></sheets>' +
    '<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">' +
    '生产数据!$A$2:$XFC$2025</definedName></definedNames></workbook>';
  var dims = { 'xl/worksheets/sheet1.xml': 'A1:E4' };
  var nameToFile = { '生产数据': 'xl/worksheets/sheet1.xml' };
  var r = XlsxIO.cleanDefinedNamesXml(xml, dims, nameToFile);
  assert.strictEqual(r.changed, 1, '应改写 1 条定义名');
  assert.ok(r.xml.indexOf('$A$2:$E$4') >= 0, '应收窄到实际数据区：' + r.xml);
  assert.ok(r.xml.indexOf('$XFC$2025') < 0, '超宽范围应被移除');
}

function t5() {
  // 已经不比数据区宽的，不该被改动（幂等）
  var xml = '<workbook><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0">' +
    'S!$A$1:$B$2</definedName></definedNames></workbook>';
  var r = XlsxIO.cleanDefinedNamesXml(xml, { 'xl/worksheets/sheet1.xml': 'A1:E10' }, { 'S': 'xl/worksheets/sheet1.xml' });
  assert.strictEqual(r.changed, 0, '范围本来就小 → 不应改写');
}

// ---- 3. valuesEqual ----
function t6() {
  var v = XlsxCompare.valuesEqual;
  assert.strictEqual(v(new Date(Date.UTC(2024, 4, 1)), '2024-05-01'), true, '日期跨类型应相等');
  assert.strictEqual(v(new Date(Date.UTC(2024, 4, 1)), '2024-05-02'), false);
  assert.strictEqual(v(0, 0.0), true);
  assert.strictEqual(v('0', 0), true);
  assert.strictEqual(v(98.5, 98.5000000000001), true, '浮点容差内应相等');
  assert.strictEqual(v('', null), true, '空值之间应相等');
  assert.strictEqual(v('', 'x'), false, '空与非空不相等');
  assert.strictEqual(v('98.5%', '98.5'), false, '带单位不应按数值宽松比较');
  assert.strictEqual(v(' A ', 'A'), true, '首尾空白应忽略');
}

function t7() {
  assert.strictEqual(XlsxCompare.detectKeyColumn(['提取物批号', 'x'], ['提取物批号', 'x']), '提取物批号');
  assert.strictEqual(XlsxCompare.detectKeyColumn(['a'], ['b']), null);
  // 优先级：提取物批号 排在 批号 前面
  assert.strictEqual(XlsxCompare.detectKeyColumn(['批号', '提取物批号'], ['批号', '提取物批号']), '提取物批号');
}

// ---- 4. 端到端读取 + 对比 ----
var shared = {};

function t8() {
  return XlsxIO.load(fs.readFileSync(A), A).then(function (wb) {
    assert.deepStrictEqual(wb.sheetNames, ['生产数据']);
    var ws = wb.sheet('生产数据');
    var s = XlsxIO.extractSheet(ws, { headerStart: 2, headerEnd: 2 });
    // 多行表头：这里只取第 2 行，所以列名就是 HDR2
    assert.deepStrictEqual(s.headers, HDR2);
    // 表头以上保留
    assert.strictEqual(s.above.length, 1);
    assert.deepStrictEqual(s.above[0], HDR1);
    assert.strictEqual(s.rows.length, 3);
    assert.deepStrictEqual(s.rowNumbers, [3, 4, 5]);
    shared.old = s;
    wb.dispose();
  });
}

function t9() {
  return XlsxIO.load(fs.readFileSync(A), A).then(function (wb) {
    var ws = wb.sheet('生产数据');
    var s = XlsxIO.extractSheet(ws, { headerStart: 1, headerEnd: 2 });   // 两行表头
    // 父/子拼接
    assert.strictEqual(s.headers[0], '公共列 / 提取方式');
    assert.strictEqual(s.headers[3], '公共列 / 提取物批号');
    assert.strictEqual(s.above.length, 0, '表头从第 1 行起 → 上方无内容');
    assert.strictEqual(s.rows.length, 3, '第 2 行是表头，数据从第 3 行开始');
    wb.dispose();
  });
}

function t10() {
  return XlsxIO.load(fs.readFileSync(B), B).then(function (wb) {
    var s = XlsxIO.extractSheet(wb.sheet('生产数据'), { headerStart: 2, headerEnd: 2 });
    shared.new = s;
    // 对比
    var r = XlsxCompare.compareSheet(shared.old, s, {});
    assert.strictEqual(r.compareMode, 'key');
    assert.deepStrictEqual(r.keyNames, ['提取物批号']);
    assert.strictEqual(r.added.length, 1, '应新增 1 行');
    assert.strictEqual(r.added[0].newRow, 5);
    assert.strictEqual(r.modified.length, 1, '应修改 1 行');
    assert.strictEqual(r.modified[0].newRow, 4);
    assert.strictEqual(r.modified[0].oldRow, 4);
    assert.deepStrictEqual(r.modified[0].changedCols, ['指标成分']);
    assert.strictEqual(r.modified[0].cells['指标成分'], '97.5');
    // 测试数据里 97.0 是字符串字面量，Excel 原样保存 → 旧值仍是 '97.0'
    assert.strictEqual(r.modified[0].oldValues['指标成分'], '97.0');
    assert.strictEqual(r.deleted.length, 1, '应删除 1 行');
    assert.strictEqual(r.deleted[0].oldRow, 5);
    shared.result = r;
    wb.dispose();
  });
}

function t11() {
  // 无键列时退化为哈希模式：只能判整行增删，判不出修改
  var oldS = {
    headers: ['a', 'b'], oldHeaders: ['a', 'b'],
    rows: [['1', '2'], ['3', '4']], rowNumbers: [2, 3]
  };
  var newS = {
    headers: ['a', 'b'], oldHeaders: ['a', 'b'],
    rows: [['1', '2'], ['3', '9']], rowNumbers: [2, 3]
  };
  var r = XlsxCompare.compareSheet(oldS, newS, {});
  assert.strictEqual(r.compareMode, 'hash');
  assert.strictEqual(r.added.length, 1);
  assert.strictEqual(r.deleted.length, 1);
  assert.strictEqual(r.modified.length, 0, '哈希模式不判修改');
}

function t12() {
  // 显式指定的键列在两侧都不存在时，降级到自动检测
  var r = XlsxCompare.compareSheet(shared.old, shared.new, { keyColumns: ['不存在的列'] });
  assert.strictEqual(r.compareMode, 'key');
  assert.deepStrictEqual(r.keyNames, ['提取物批号'], '应回退到自动识别');
}

function t13() {
  // 列结构变化要单独记录
  var oldS = { headers: ['a', 'b'], oldHeaders: ['a', 'b'], rows: [['1', '2']], rowNumbers: [2] };
  var newS = { headers: ['a', 'c'], oldHeaders: ['a', 'c'], rows: [['1', '9']], rowNumbers: [2] };
  var r = XlsxCompare.compareSheet(oldS, newS, { keyColumns: ['a'] });
  assert.deepStrictEqual(r.structural.newColumns, ['c']);
  assert.deepStrictEqual(r.structural.deletedColumns, ['b']);
}

// ---- 5. 多 sheet 编排 ----
function t14() {
  return XlsxIO.load(fs.readFileSync(A), A).then(function (oldWb) {
    return XlsxIO.load(fs.readFileSync(B), B).then(function (newWb) {
      var oldData = { '生产数据': XlsxIO.extractSheet(oldWb.sheet('生产数据'), { headerStart: 2, headerEnd: 2 }) };
      var newData = {
        '生产数据': XlsxIO.extractSheet(newWb.sheet('生产数据'), { headerStart: 2, headerEnd: 2 }),
        '新增表': XlsxIO.extractSheet(newWb.sheet('新增表'), { headerStart: 1, headerEnd: 1 })
      };
      function book(names, data) {
        return {
          sheetNames: names,
          sheet: function (n) { return data[n] || null; },
          _extract: function (n) { return data[n] || { name: n, headers: [], oldHeaders: [], rows: [], rowNumbers: [], above: [], meta: null }; }
        };
      }
      var r = XlsxCompare.compareWorkbook(
        book(['生产数据'], oldData),
        book(['生产数据', '新增表'], newData),
        { '生产数据': { enabled: true, headerStart: 2, headerEnd: 2 }, '新增表': { enabled: true, headerStart: 1, headerEnd: 1 } }
      );
      assert.strictEqual(r.sheets.length, 2, '两个 sheet 都应参与');
      var onlyNew = r.sheets.filter(function (x) { return x.sheet === '新增表'; })[0];
      assert.ok(onlyNew, '新增表应出现在结果里');
      assert.strictEqual(onlyNew.added.length, 1, '只在新文件里 → 整表记新增');
      assert.ok(r.missing.onlyNew.indexOf('新增表') >= 0);
      shared.wbResult = r;
      oldWb.dispose(); newWb.dispose();
    });
  });
}

function t15() {
  // enabled:false 的 sheet 被跳过
  return XlsxIO.load(fs.readFileSync(A), A).then(function (wb) {
    var s = XlsxIO.extractSheet(wb.sheet('生产数据'), { headerStart: 2, headerEnd: 2 });
    function book(names, data) {
      return {
        sheetNames: names, sheet: function (n) { return data[n] || null; },
        _extract: function (n) { return data[n]; }
      };
    }
    var r = XlsxCompare.compareWorkbook(book(['生产数据'], { '生产数据': s }), book(['生产数据'], { '生产数据': s }),
      { '生产数据': { enabled: false } });
    assert.strictEqual(r.sheets.length, 0, 'enabled:false 应跳过');
    wb.dispose();
  });
}

// ---- 6. 报告生成 ----
function t16() {
  var oldMeta = { '生产数据': shared.old.meta };
  var newMeta = { '生产数据': shared.new.meta };
  var res = { sheets: [shared.result], summary: { added: 1, modified: 1, deleted: 1, sheetsCompared: 1, sheetsWithDiff: 1 }, missing: { onlyOld: [], onlyNew: [] } };
  return XlsxReport.build(res, {
    oldMeta: oldMeta, newMeta: newMeta,
    oldAbove: { '生产数据': shared.old.above },
    newAbove: { '生产数据': shared.new.above }
  }).then(function (bytes) {
    assert.ok(bytes && bytes.length > 0, '应产出非空字节');
    // 校验是合法 xlsx（ZIP 头）
    assert.strictEqual(bytes[0], 0x50);
    assert.strictEqual(bytes[1], 0x4B);
    fs.writeFileSync(tmpFile('report.xlsx'), Buffer.from(bytes));
    return true;
  });
}

function t17() {
  // 回读报告：sheet 结构 + 格式还原
  var ExcelJS2 = require('../lib/exceljs.min.js');
  var wb = new ExcelJS2.Workbook();
  return wb.xlsx.load(fs.readFileSync(tmpFile('report.xlsx'))).then(function () {
    var names = wb.worksheets.map(function (w) { return w.name; });
    assert.ok(names.indexOf('对比总览') >= 0, '应有总览：' + names.join(','));
    assert.ok(names.indexOf('生产数据_新增') >= 0, '应有新增分表');
    assert.ok(names.indexOf('生产数据_修改') >= 0, '应有修改分表');
    assert.ok(names.indexOf('生产数据_删除') >= 0, '应有删除分表');
    assert.ok(names.indexOf('生产数据_新_源表头以上') >= 0, '应保留表头以上内容');

    var wsNew = wb.getWorksheet('生产数据_新增');
    // 列布局已统一为「数据列在前、行号列在后」（与修改表同构）
    assert.strictEqual(wsNew.getCell('A1').value, '提取方式', '第 1 列应是源表首列（第 2 行表头）');
    var lastCol = wsNew.columnCount;
    assert.strictEqual(wsNew.getRow(1).getCell(lastCol).value, '新文件行号', '行号列应在最后');
    // 列宽还原（源 A 列 16）——数据列不再有左侧偏移，所以直接对 A 列
    assert.ok(Math.abs(wsNew.getColumn(1).width - 16) < 1, '列宽应还原 16，实际 ' + wsNew.getColumn(1).width);
    // 冻结窗格还原
    assert.ok(wsNew.views && wsNew.views[0] && wsNew.views[0].state === 'frozen', '冻结窗格应还原');

    // 修改表：新值/旧值成对出现
    var wsMod = wb.getWorksheet('生产数据_修改');
    var hdrs = [];
    for (var c = 1; c <= wsMod.columnCount; c++) hdrs.push(wsMod.getRow(1).getCell(c).value);
    assert.ok(hdrs.indexOf('指标成分') >= 0, '修改表应含新值列');
    assert.ok(hdrs.indexOf('旧_指标成分') >= 0, '修改表应含旧值列');
    var newIdx = hdrs.indexOf('指标成分') + 1;
    var oldIdx = hdrs.indexOf('旧_指标成分') + 1;
    assert.strictEqual(String(wsMod.getRow(2).getCell(newIdx).value), '97.5');
    assert.strictEqual(String(wsMod.getRow(2).getCell(oldIdx).value), '97.0');
  });
}

function t18b() {
  // 每张分表的列数必须等于表头实际列数。
  // 回归点：applyMeta 如果按源文件列数（含偏移）写列宽/表头样式，会把
  // "修改"这类只输出部分列的分表撑出尾部空列（曾出现 columnCount=8 而表头只有 5 列）。
  var ExcelJS2 = require('../lib/exceljs.min.js');
  var wb = new ExcelJS2.Workbook();
  return wb.xlsx.load(fs.readFileSync(tmpFile('report.xlsx'))).then(function () {
    wb.worksheets.forEach(function (w) {
      var vals = (w.getRow(1).values || []).slice(1).filter(function (v) {
        return v !== null && v !== undefined;
      });
      assert.strictEqual(w.columnCount, vals.length,
        w.name + ' 列数虚高：columnCount=' + w.columnCount + ' 表头列=' + vals.length);
    });
  });
}

function t18() {
  // 超长 / 含非法字符的 sheet 名要安全截断，且保留 _新增 这类后缀
  assert.strictEqual(XlsxReport.trimSheetName('a/b:c'), 'a_b_c');
  var long = '这是一个非常非常非常非常非常非常长的表格名称_新增';
  var t = XlsxReport.trimSheetName(long);
  assert.ok(t.length <= 31, '截断后应 ≤31：' + t.length);
  assert.ok(t.indexOf('_新增') >= 0, '应保留后缀：' + t);
}

// ---- 7. 真实文件（若存在） ----
function t19() {
  var real = '/Users/sonoma/Desktop/aibg/static/uploads/factory_data/陇西_20260330_222725_171.xlsx';
  if (!fs.existsSync(real)) {
    console.log('      （跳过：真实样本文件不存在）');
    return true;
  }
  return XlsxIO.load(fs.readFileSync(real), real).then(function (wb) {
    // 这个文件的 _FilterDatabase 写到 $XFC$2025（16384 列 × 2025 行），不清洗会吃 3GB 内存
    assert.strictEqual(wb.cleaned, 1, '应改写 1 条超宽定义名');
    var s = XlsxIO.extractSheet(wb.sheet('生产数据收集表'), { headerStart: 2, headerEnd: 2 });
    assert.ok(s.rows.length > 1000, '应读到大量数据行');
    assert.ok(s.headers[0].indexOf('提取方式') >= 0, '表头应正确');
    wb.dispose();
  });
}

// ---- 8. 三视图渲染（XlsxView 只拼 HTML，用最小 mount 桩即可） ----

function t20() {
  // 在 Node 里加载 xlsxview.js：它挂在 self 上，这里造一个 self 桩
  var code = fs.readFileSync(path.join(__dirname, '../src/xlsxview.js'), 'utf8');
  var sandbox = { self: null };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  var vm = require('vm');
  vm.runInContext(code, vm.createContext(sandbox), { filename: 'xlsxview.js' });
  var XlsxView = sandbox.XlsxView;
  assert.ok(XlsxView, 'XlsxView 应挂到全局');

  // mount 桩：只记录 innerHTML 与 querySelectorAll
  var mount = {
    _html: '',
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
    querySelectorAll: function () { return []; },
    querySelector: function () { return null; }
  };
  XlsxView.init({ mount: mount });

  var res = {
    sheets: [shared.result, {
      sheet: '无差异表', headers: ['a'], oldHeaders: ['a'],
      added: [], modified: [], deleted: [],
      structural: { newColumns: [], deletedColumns: [], commonColumns: ['a'] },
      compareMode: 'key', keyNames: ['a'], autoKey: null
    }],
    summary: { added: 1, modified: 1, deleted: 1, sheetsCompared: 2, sheetsWithDiff: 1 },
    missing: { onlyOld: [], onlyNew: [] }
  };
  XlsxView.render(res, { sheet: '生产数据', view: 'all' });

  var html = mount.innerHTML;
  assert.ok(html.indexOf('xv-sheetbar') >= 0, '应有 sheet 切换条');
  assert.ok(html.indexOf('xv-viewbar') >= 0, '应有视图切换条');
  assert.ok(html.indexOf('生产数据') >= 0 && html.indexOf('无差异表') >= 0, '两个 sheet 都应列出');
  assert.ok(html.indexOf('新增行') >= 0, '全部视图应含新增分区');
  assert.ok(html.indexOf('修改行') >= 0, '全部视图应含修改分区');
  assert.ok(html.indexOf('删除行') >= 0, '全部视图应含删除分区');
  // 修改行要显示旧值 → 新值
  assert.ok(html.indexOf('xv-old') >= 0 && html.indexOf('xv-new') >= 0, '修改行应含旧值/新值');
  // 跳转按钮带行号
  assert.ok(html.indexOf('data-jump=') >= 0, '应有跳转到表格的按钮');

  // 切到"仅新增"视图：不应出现修改/删除分区
  XlsxView.render(null, { view: 'added' });
  var html2 = mount.innerHTML;
  assert.ok(html2.indexOf('新增行') >= 0, '新增视图应含新增分区');
  assert.ok(html2.indexOf('修改行') < 0, '新增视图不应含修改分区');
  assert.ok(html2.indexOf('删除行') < 0, '新增视图不应含删除分区');

  // 无差异的 sheet：应给出明确提示而不是空白
  XlsxView.render(null, { sheet: '无差异表', view: 'all' });
  assert.ok(mount.innerHTML.indexOf('没有差异') >= 0, '无差异 sheet 应提示没有差异');

  // 状态栏摘要
  var sum = XlsxView.summaryHtml(res);
  assert.ok(sum.indexOf('新增 1 行') >= 0 && sum.indexOf('修改 1 行') >= 0 && sum.indexOf('删除 1 行') >= 0,
    '摘要应含三类计数：' + sum);
  XlsxView.reset();
}

function t21() {
  // SheetView 的列宽换算 / 隐藏列过滤
  var code = fs.readFileSync(path.join(__dirname, '../src/sheetview.js'), 'utf8');
  var sandbox = { self: null };
  sandbox.self = sandbox;
  var vm = require('vm');
  vm.runInContext(code, vm.createContext(sandbox), { filename: 'sheetview.js' });
  var SV = sandbox.SheetView;
  assert.ok(SV, 'SheetView 应挂到全局');

  var data = {
    headers: ['批号', '隐藏列', '数值'],
    rows: [['P1', 'x', '1']],
    rowNumbers: [3],
    meta: { colWidths: [16, 9, 9.0001], colHidden: [false, true, false] }
  };
  // 隐藏列不应出现在可见列里
  // 注意：vm 沙箱里造的数组原型与本上下文不同，deepStrictEqual 会因原型不匹配而失败，
  // 所以这里比较 JSON 序列化结果。
  assert.strictEqual(JSON.stringify(SV._visibleCols(data)), '[0,2]', '应跳过隐藏列');
  // 列宽按字符数换算，且有上下限
  var w0 = SV._colWidth(data, 0);
  assert.ok(w0 > 56 && w0 < 420, '列宽应在合理范围：' + w0);
  // 隐藏列的宽度不应计入总宽
  var withHidden = { headers: data.headers, rowNumbers: [3], colWidths: data.meta.colWidths,
    meta: { colWidths: data.meta.colWidths, colHidden: [false, false, false] } };
  assert.ok(SV._totalWidth(withHidden) > SV._totalWidth(data), '隐藏列被跳过 → 总宽更小');
}

// ---- 9. 浏览器集成回归（这两个 bug 只有真实页面才暴露，Node 单测曾经漏掉） ----

function t22() {
  // 回归点①：index.html 必须引入 lib/exceljs.min.js。
  // 曾漏掉 → 浏览器里 XlsxIO 报"Excel 解析库未加载"，点「表格对比配置」直接报错；
  // 而 Node 单测用 require 加载，完全掩盖了这个问题。
  var html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.ok(/<script src="lib\/exceljs\.min\.js"><\/script>/.test(html),
    'index.html 必须引入 lib/exceljs.min.js');

  // 同理：新增的 xlsx 模块必须都在 index.html 里注册
  ['xlsx-io', 'xlsx-compare', 'xlsx-report', 'xlsxflow', 'xlsxview', 'sheetview', 'xlsxconfig']
    .forEach(function (m) {
      assert.ok(html.indexOf('src/' + m + '.js') >= 0, 'index.html 缺少 src/' + m + '.js');
    });

  // 加载顺序：ExcelJS 与 JSZip 必须在 xlsx-io 之前（后者依赖前两者做预清洗）
  var iExcel = html.indexOf('lib/exceljs.min.js');
  var iZip = html.indexOf('lib/jszip.min.js');
  var iIo = html.indexOf('src/xlsx-io.js');
  assert.ok(iExcel >= 0 && iZip >= 0 && iIo >= 0, '三者都应存在');
  assert.ok(iExcel < iIo, 'ExcelJS 必须在 xlsx-io 之前加载');
  assert.ok(iZip < iIo, 'JSZip 必须在 xlsx-io 之前加载');
}

function t23() {
  // 回归点②：xlsx 必须给出正确的 MIME，且不能被当文本读。
  // 曾漏掉 → /api/file 按 text/plain 返回，前端 r.text() 把二进制灌进编辑器，
  // 用户看到 "PK...[Content_Types].xml" 乱码。
  var serveSrc = fs.readFileSync(path.join(__dirname, '../serve.js'), 'utf8');
  // 用字面量子串断言，避免多层正则转义写错
  assert.ok(serveSrc.indexOf("'.xlsx'") >= 0, 'serve.js 的 API_MIME 必须包含 .xlsx 条目');
  assert.ok(serveSrc.indexOf('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') >= 0,
    'serve.js 必须把 .xlsx 映射到 Office 表格 MIME');

  var sourceSrc = fs.readFileSync(path.join(__dirname, '../src/source-api.js'), 'utf8');
  assert.ok(sourceSrc.indexOf("'.xlsx'") >= 0, 'source-api.js 的 MIME 表必须包含 .xlsx');

  // Pipeline.loadSide 必须有专门的表格分支，且在 r.text() 分支之前
  var pipe = fs.readFileSync(path.join(__dirname, '../src/pipeline.js'), 'utf8');
  var iXlsx = pipe.indexOf('xlsx|xlsm|xls');
  var iText = pipe.indexOf('return r.text()');
  assert.ok(iXlsx >= 0, 'pipeline.loadSide 必须有 .xlsx 分支');
  assert.ok(iText >= 0, '应当仍存在纯文本分支（给 txt/md 用）');
  assert.ok(iXlsx < iText, 'xlsx 分支必须在纯文本分支之前，否则二进制会被当文本读');
}

function t24() {
  // 回归点③：模板生成器里 sheet 的列宽若恰好是 9 会被 ExcelJS 丢弃，
  // 生成器必须自己抬高（与 xlsx-io 抽元数据时的处理一致）。
  var gen = fs.readFileSync(path.join(__dirname, '../tools/make-xlsx-demo.js'), 'utf8');
  assert.ok(/9\.0001/.test(gen), '模板生成器应把列宽 9 抬成 9.0001，否则导出的模板会丢列宽');
}

// ---- 10. 渲染可用性回归（用户实际看到的两个问题） ----

function t25() {
  // 回归点①：updatePdfArea 必须认 SheetView。
  // 曾经只判 PdfView/DocxView → Excel 对比后主区域3 被判定"无内容"而 hidden，
  // 用户看到的就是"原始文档显示区什么都没有"。
  var appSrc = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  var fnStart = appSrc.indexOf('function updatePdfArea()');
  assert.ok(fnStart >= 0, '应能找到 updatePdfArea');
  var fnBody = appSrc.slice(fnStart, appSrc.indexOf('\n  }', fnStart));
  assert.ok(fnBody.indexOf('SheetView') >= 0, 'updatePdfArea 必须检查 SheetView，否则表格不让主区域3 显示');
  assert.ok(fnBody.indexOf('PdfView') >= 0 && fnBody.indexOf('DocxView') >= 0, '不应丢掉已有查看器');
}

function t26() {
  // 回归点②：三视图必须自己撑满并滚动，否则内容被 .results 的 overflow:hidden 裁掉。
  var css = fs.readFileSync(path.join(__dirname, '../styles.css'), 'utf8');
  var xvBlock = /\.xv\s*\{([^}]*)\}/.exec(css);
  assert.ok(xvBlock, '应有 .xv 样式块');
  assert.ok(/height:\s*100%/.test(xvBlock[1]), '.xv 应撑满高度');
  assert.ok(/min-height:\s*0/.test(xvBlock[1]), '.xv 需要 min-height:0 才能在 flex 里正常收缩');
  assert.ok(/\.xv-rows\s*\{[^}]*overflow:\s*auto/.test(css), '.xv-rows 必须可滚动，否则长列表被裁');
}

function t27() {
  // 回归点③：短列名——多行表头合并出的「公共列 / 提取物批号」这种重复前缀要去掉，
  // 否则 109 列全带同一个前缀，满屏重复，非常难读。
  var code = fs.readFileSync(path.join(__dirname, '../src/xlsxview.js'), 'utf8');
  var sandbox = { self: null };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  var vm = require('vm');
  vm.runInContext(code, vm.createContext(sandbox), { filename: 'xlsxview.js' });
  var XV = sandbox.XlsxView;
  assert.ok(XV._shortName, '应导出 _shortName 供测试');

  // 重复 3 次以上的前缀 → 剥掉
  var headers = ['公共列 / 提取方式', '公共列 / 提取物批号', '公共列 / 指标5', '公共列 / 指标6'];
  assert.strictEqual(XV._shortName('公共列 / 提取物批号', headers), '提取物批号');
  assert.strictEqual(XV._shortName('公共列 / 指标5', headers), '指标5');

  // 只出现 1~2 次的前缀是有意义的分组，必须保留
  var h2 = ['基本信息 / 批号', '基本信息 / 品名', '检验结果 / 水分', '检验结果 / 含量'];
  assert.strictEqual(XV._shortName('基本信息 / 批号', h2), '基本信息 / 批号', '出现 2 次的分组应保留');
  assert.strictEqual(XV._shortName('检验结果 / 水分', h2), '检验结果 / 水分');

  // 没有前缀的原样返回
  assert.strictEqual(XV._shortName('批号', ['批号']), '批号');
}

function t28() {
  // 回归点④：宽表（上百列）不能把每行的所有列都铺出来。
  // 曾把 109 列全渲染成「列名：值」，224 行 × 109 列 → 界面完全没法看。
  var code = fs.readFileSync(path.join(__dirname, '../src/xlsxview.js'), 'utf8');
  var sandbox = { self: null };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  var vm = require('vm');
  vm.runInContext(code, vm.createContext(sandbox), { filename: 'xlsxview.js' });
  var XV = sandbox.XlsxView;

  assert.ok(XV._MAX_CELLS > 0 && XV._MAX_CELLS <= 30, '应限制每行单元格数，实际 ' + XV._MAX_CELLS);

  // 造一个 109 列、1 条新增行的结果
  var headers = [];
  for (var i = 0; i < 109; i++) headers.push('公共列 / 指标' + i);
  var cells = {};
  headers.forEach(function (h, i) { cells[h] = 'v' + i; });
  var r = {
    sheet: '宽表', headers: headers, oldHeaders: headers,
    added: [{ newRow: 2, cells: cells }],
    modified: [], deleted: [],
    structural: { newColumns: [], deletedColumns: [], commonColumns: headers },
    compareMode: 'key', keyNames: ['公共列 / 提取物批号'], autoKey: null
  };
  var res = { sheets: [r], summary: { added: 1, modified: 0, deleted: 0, sheetsCompared: 1, sheetsWithDiff: 1 }, missing: { onlyOld: [], onlyNew: [] } };

  var mount = {
    _h: '', set innerHTML(v) { this._h = v; }, get innerHTML() { return this._h; },
    querySelectorAll: function () { return []; }, querySelector: function () { return null; }
  };
  XV.init({ mount: mount });
  XV.render(res, { sheet: '宽表', view: 'added' });

  var html = mount.innerHTML;
  var cellCount = (html.match(/xv-cell/g) || []).length;
  assert.ok(cellCount <= XV._MAX_CELLS + 2, '每行渲染的单元格数应受限，实际 ' + cellCount);
  assert.ok(/另有 \d+ 列未展开/.test(html), '超出的列应有折叠提示');
  assert.ok(html.indexOf('公共列 / ') < 0, '渲染时不应保留重复的无信息量前缀');
  XV.reset();
}

function t29() {
  // 回归点：切 sheet 必须通知外部去换主区域3 的原表。
  // 曾经点击 sheet 标签只 render 三视图，没触发任何回调 → 主区域3 停在旧 sheet。
  var code = fs.readFileSync(path.join(__dirname, '../src/xlsxview.js'), 'utf8');
  var sandbox = { self: null };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  var vm = require('vm');
  vm.runInContext(code, vm.createContext(sandbox), { filename: 'xlsxview.js' });
  var XV = sandbox.XlsxView;

  // 造两个 sheet 的结果
  function mkSheet(name, nAdded) {
    var headers = ['批号', '数量'];
    var added = [];
    for (var i = 0; i < nAdded; i++) added.push({ newRow: i + 2, cells: { '批号': 'P' + i, '数量': String(i) } });
    return {
      sheet: name, headers: headers, oldHeaders: headers,
      added: added, modified: [], deleted: [],
      structural: { newColumns: [], deletedColumns: [], commonColumns: headers },
      compareMode: 'key', keyNames: ['批号'], autoKey: null
    };
  }
  var res = {
    sheets: [mkSheet('原料', 2), mkSheet('成品', 3)],
    summary: { added: 5, modified: 0, deleted: 0, sheetsCompared: 2, sheetsWithDiff: 2 },
    missing: { onlyOld: [], onlyNew: [] }
  };

  // 记录 onSheetChange 被调用的参数
  var calls = [];
  var mount = {
    _h: '', set innerHTML(v) { this._h = v; }, get innerHTML() { return this._h; },
    querySelectorAll: function () { return []; }, querySelector: function () { return null; }
  };
  XV.init({
    mount: mount,
    onSheetChange: function (name) { calls.push(name); }
  });
  XV.render(res, { sheet: '原料', view: 'all' });
  assert.strictEqual(calls.length, 0, '首次渲染不应触发 onSheetChange');

  // 模拟点击「成品」标签：直接调导出的转发函数（等价于点击事件里的那次调用）
  XV._onSheetChange('成品');
  assert.deepStrictEqual(calls, ['成品'], '切 sheet 必须触发 onSheetChange，实际 ' + JSON.stringify(calls));
  XV.reset();

  // 反向验证：应用侧确实把这个回调接到了 renderXlsxPanels
  var appSrc = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  var initStart = appSrc.indexOf('XlsxView.init({');
  assert.ok(initStart >= 0, 'app.js 应有 XlsxView.init');
  var initBody = appSrc.slice(initStart, appSrc.indexOf('XlsxView.render', initStart));
  assert.ok(initBody.indexOf('onSheetChange') >= 0, 'app.js 必须传 onSheetChange');
  assert.ok(/onSheetChange:\s*function[\s\S]{0,200}renderXlsxPanels/.test(initBody),
    'onSheetChange 里必须调用 renderXlsxPanels 换主区域3');
}

function t30() {
  // 只在一侧存在的 sheet：另一侧要给出明确提示，且保留白底（不能被 PDF 的深灰盖住看不清）
  var appSrc = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  assert.ok(appSrc.indexOf('sv-missing') >= 0, '应在面板里渲染 .sv-missing 提示');
  assert.ok(/SheetView\.clear\(side,\s*true\)/.test(appSrc),
    '清空该侧时应保留 sv-host（白底），否则提示文字压在深灰上看不清');

  var css = fs.readFileSync(path.join(__dirname, '../styles.css'), 'utf8');
  assert.ok(/\.sv-missing\s*\{/.test(css), '应有 .sv-missing 样式');

  // SheetView.clear 的第二个参数要真的生效
  var code = fs.readFileSync(path.join(__dirname, '../src/sheetview.js'), 'utf8');
  assert.ok(/function clear\(side,\s*keepHost\)/.test(code), 'clear 应支持 keepHost 参数');
  assert.ok(/if\s*\(!keepHost\)\s*host\.classList\.remove/.test(code),
    'keepHost=true 时不应移除 sv-host 类');
}

function t31() {
  // 改「修改」分表的列布局（对齐 aibg 今日关注监控对比的输出习惯）：
  //   全部原始列按源表顺序保留（未变的列也要在）
  //   → 变化列的「旧_xxx」紧跟在它自己原列后面
  //   → [变化情况][新文件行号][旧文件行号] 放在最后
  // 旧实现只输出变化列、且把行号列放最前，脱离上下文认不出是哪条记录。
  var ExcelJS2 = require('../lib/exceljs.min.js');
  var wb = new ExcelJS2.Workbook();
  return wb.xlsx.load(fs.readFileSync(tmpFile('report.xlsx'))).then(function () {
    var ws = wb.getWorksheet('生产数据_修改');
    assert.ok(ws, '应有 生产数据_修改');

    var hdrs = [];
    for (var c = 1; c <= ws.columnCount; c++) hdrs.push(ws.getRow(1).getCell(c).value);

    // ① 全部源表列都在（源表 5 列：提取方式/执行标准/生产日期/提取物批号/指标成分）
    ['提取方式', '执行标准', '生产日期', '提取物批号', '指标成分'].forEach(function (h) {
      assert.ok(hdrs.indexOf(h) >= 0, '修改表应保留未变化的列「' + h + '」，实际列: ' + JSON.stringify(hdrs));
    });

    // ② 元信息三列必须在最后，且顺序为 变化情况 → 新文件行号 → 旧文件行号
    var n = hdrs.length;
    assert.strictEqual(hdrs[n - 3], '变化情况', '倒数第 3 列应是 变化情况，实际 ' + hdrs[n - 3]);
    assert.strictEqual(hdrs[n - 2], '新文件行号', '倒数第 2 列应是 新文件行号，实际 ' + hdrs[n - 2]);
    assert.strictEqual(hdrs[n - 1], '旧文件行号', '倒数第 1 列应是 旧文件行号，实际 ' + hdrs[n - 1]);

    // ③ 旧_xxx 紧跟对应列
    var iNew = hdrs.indexOf('指标成分');
    assert.ok(iNew >= 0, '应有 指标成分 列');
    assert.strictEqual(hdrs[iNew + 1], '旧_指标成分',
      '旧_指标成分 应紧跟在 指标成分 之后，实际下一个是 ' + hdrs[iNew + 1]);

    // ④ 数值正确：新值在 指标成分，旧值在 旧_指标成分
    assert.strictEqual(String(ws.getRow(2).getCell(iNew + 1).value), '97.5');
    assert.strictEqual(String(ws.getRow(2).getCell(iNew + 2).value), '97.0');

    // ⑤ 未变化的列也要有值（说明取的是整行快照，而不是只取变化列）
    var iBatch = hdrs.indexOf('提取物批号');
    assert.ok(iBatch >= 0, '应有 提取物批号 列');
    assert.strictEqual(String(ws.getRow(2).getCell(iBatch + 1).value), 'P002',
      '未变化的列也要输出值，实际 ' + ws.getRow(2).getCell(iBatch + 1).value);

    // ⑥ 变化情况只列真正变化的列名（不含 旧_ 标记）
    var iChg = hdrs.indexOf('变化情况');
    var chg = String(ws.getRow(2).getCell(iChg + 1).value);
    assert.ok(chg.indexOf('指标成分') >= 0, '变化情况应含 指标成分，实际 ' + chg);
    assert.ok(chg.indexOf('旧_') < 0, '变化情况不应含 旧_ 标记，实际 ' + chg);

    // ⑦ 新增 / 删除 分表也必须是「数据列在前、行号列在后」的同构布局
    var wsAdd = wb.getWorksheet('生产数据_新增');
    var addLast = wsAdd.getRow(1).getCell(wsAdd.columnCount).value;
    assert.strictEqual(addLast, '新文件行号', '新增分表的行号列应在最后，实际 ' + addLast);
    assert.strictEqual(wsAdd.getCell('A1').value, '提取方式', '新增分表第 1 列应是源表首列');

    var wsDel = wb.getWorksheet('生产数据_删除');
    var delLast = wsDel.getRow(1).getCell(wsDel.columnCount).value;
    assert.strictEqual(delLast, '旧文件行号', '删除分表的行号列应在最后，实际 ' + delLast);
    assert.strictEqual(wsDel.getCell('A1').value, '提取方式', '删除分表第 1 列应是源表首列');
  });
}

// ---- 跑 ----
// 用 check() 统一串起来：每个用例独立记 ok/FAIL，任何一个失败不影响后面的用例继续跑
// （早期版本把所有用例串成一条 Promise 链，第一个失败就会中断，看不到后续结果）。
var CASES = [
  ['colIndex / colLetter / parseAreaRef', t1],
  ['zipHeadError：空文件与非 ZIP 给出可读提示', t2],
  ['cellText：富文本展开 / 公式取 result / 日期不带时区偏移', t3],
  ['定义名清洗：超宽 _FilterDatabase 按 dimension 收窄', t4],
  ['定义名清洗：范围本来就小则不改写（幂等）', t5],
  ['valuesEqual：日期跨类型 / 浮点容差 / 空值', t6],
  ['detectKeyColumn：按优先级自动识别键列', t7],
  ['读取：单行表头 + 表头以上内容保留', t8],
  ['读取：多行表头合并为「父 / 子」', t9],
  ['对比：新增 / 修改 / 删除 三分类正确', t10],
  ['对比：无键列退化为哈希模式', t11],
  ['对比：显式键列不存在时回退自动识别', t12],
  ['对比：列结构增删单独记录', t13],
  ['多 sheet：只在新文件里的 sheet 整表记新增', t14],
  ['多 sheet：enabled:false 的 sheet 被跳过', t15],
  ['报告：生成合法的 xlsx 字节', t16],
  ['报告：结构完整 + 列宽/冻结/新旧值列还原', t17],
  ['报告：超长 sheet 名截断并保留后缀', t18],
  ['报告：各分表列数等于表头列数（无尾部空列）', t18b],
  ['真实文件：坏定义名被清洗且数据可读', t19],
  ['三视图：sheet/视图切换 + 三类分区 + 跳转按钮', t20],
  ['SheetView：列宽换算与隐藏列过滤', t21],
  ['集成：index.html 引入 ExcelJS 且顺序正确', t22],
  ['集成：xlsx 的 MIME 与 loadSide 分支正确', t23],
  ['模板生成器：列宽 9 的保存处理', t24],
  ['回归：updatePdfArea 认 SheetView（主区域3 能显示表格）', t25],
  ['回归：三视图撑满高度且可滚动（内容不被裁）', t26],
  ['回归：短列名剥掉重复前缀', t27],
  ['回归：宽表每行列数受限 + 折叠提示', t28],
  ['回归：切 sheet 联动主区域3（onSheetChange）', t29],
  ['回归：仅单侧存在的 sheet 有明确提示', t30],
  ['报告：修改表保留全部列，旧值紧随原列，行号置末', t31]
];

// ★ 先等 ready（造临时 xlsx）落地，否则后面的读取用例会 ENOENT
var chain = ready;
CASES.forEach(function (c) {
  chain = chain.then(function () { return check(c[0], c[1]); });
});

chain.then(function () {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
}).catch(function (e) {
  console.error('测试准备失败：', e && e.stack);
  process.exit(1);
});
