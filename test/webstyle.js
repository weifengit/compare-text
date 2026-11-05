'use strict';
/**
 * webstyle.js 单元测试：原稿样式解析与比对。
 * 运行：node test/webstyle.js
 *
 * 夹具是真东西，不是手搓样例：
 *   test/fixtures/gdherb-std.html  广东省药检所「麸炒泽泻 GDPG-308A-2026」正文页原文快照
 *   test/fixtures/gdherb-std.docx  由它还原出来的 Word（assemble 261104_GDherb 产出）
 * 于是第 4 组用例能做一件最有意义的事：**拿还原出来的 docx 与原稿声明直接对，
 * 差异必须为 0**——这一条过了，才说明"格式完全保留"不是嘴上说说。
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var JSZip = require(path.join(__dirname, '..', 'lib', 'jszip.min.js'));
var W = require(path.join(__dirname, '..', 'src', 'webstyle.js'));

var HTML = fs.readFileSync(path.join(__dirname, 'fixtures', 'gdherb-std.html'), 'utf8');
var DOCX = fs.readFileSync(path.join(__dirname, 'fixtures', 'gdherb-std.docx'));

var passed = 0, failed = 0;
var tests = [];
function check(name, fn) { tests.push([name, fn]); }

function findVector(vectors, needle) {
  for (var i = 0; i < vectors.length; i++) {
    if (String(vectors[i].text).indexOf(needle) >= 0) return vectors[i];
  }
  throw new Error('找不到包含「' + needle + '」的段落');
}

// ---------------------------------------------------------------- 值解析
check('吞键声明：:12px;: 10pt 取 pt 不取 px', function () {
  var decls = W.parseDecls('font-family:宋体;:12px;: 10pt;color:#00000a');
  assert.strictEqual(decls.sizePt, 10, '原稿字号应为 10pt');
  assert.strictEqual(decls['font-family'], '宋体');
  assert.strictEqual(W.hexColor(decls.color), '00000A');
});

check('单位换算：px 按 96dpi、in/pt/cm 归一到英寸', function () {
  assert.strictEqual(W.toPt('12px'), 9);
  assert.strictEqual(W.toPt('10pt'), 10);
  assert.strictEqual(W.toInches('0.29in'), 0.29);
  assert.strictEqual(W.toInches('21.5pt'), 0.2986);
  assert.strictEqual(W.toPt('garbage'), null);
});

check('坏键行距 l=:150% → 1.5 倍', function () {
  assert.strictEqual(W.lineSpacingOf('150%'), 1.5);
  assert.strictEqual(W.lineSpacingOf('100%'), 1);
  assert.strictEqual(W.lineSpacingOf('1.5'), 1.5);
  assert.strictEqual(W.lineSpacingOf('24pt'), null);
});

check('字体族分槽：中西文各取一个，serif 回退丢掉', function () {
  assert.deepStrictEqual(W.pickFamily('Times New Roman, serif'), { cjk: null, latin: 'Times New Roman' });
  assert.deepStrictEqual(W.pickFamily('宋体'), { cjk: '宋体', latin: null });
  assert.strictEqual(W.pickFamily('黑体').cjk, '黑体');
});

// ---------------------------------------------------------------- HTML 侧
var htmlVectors = W.htmlVectors(HTML, { containerId: 'content_zw' });

check('网页正文解析：站点外壳不进向量', function () {
  assert.ok(htmlVectors.length > 20, '段落数应 >20，实际 ' + htmlVectors.length);
  var all = htmlVectors.map(function (fp) { return fp.text; }).join('\n');
  assert.ok(!/信息来源：/.test(all), '「信息来源」是站点外壳，不该进正文');
  assert.ok(!/请输入您要查询的内容/.test(all), '搜索框占位符不该进正文');
  assert.ok(!/replace\({"font-size"\)/.test(all), 'HTML 注释里的模板说明不该当正文');
});

check('原稿字号取回来了：标准号 14pt、品种名 16pt 黑体居中、正文 10pt', function () {
  var number = findVector(htmlVectors, 'GDPG-308A-2026');
  assert.strictEqual(number.sizePt, 14);
  var title = findVector(htmlVectors, '麸炒泽泻');
  assert.strictEqual(title.sizePt, 16, '品种名应为 16pt');
  assert.strictEqual(title.family, '黑体');
  assert.strictEqual(title.align, 'center', '标题居中写在旧属性 align 上');
  var body = findVector(htmlVectors, '本品为泽泻的炮制品');
  assert.strictEqual(body.sizePt, 10, '正文应为 10pt（不是浏览器渲染的 18px）');
  assert.strictEqual(body.family, '宋体');
  assert.strictEqual(body.lineSpacing, 1.5);
  assert.strictEqual(body.indentIn, 0.29);
});

check('表格单元格按原稿 9pt 解析', function () {
  var cell = findVector(htmlVectors, '时间（分钟）');
  assert.strictEqual(cell.kind, 'table');
  assert.strictEqual(cell.sizePt, 9);
});

check('上下标不丢：化学式下标与附录罗马数字上标', function () {
  var sub = findVector(htmlVectors, '的总量不得少于');
  assert.ok(sub.subChars > 0, 'C32H50O5 这类化学式应带下标字符，实际 ' + sub.subChars);
});

// ---------------------------------------------------------------- docx 侧
function readDocxVectors(buffer) {
  return JSZip.loadAsync(buffer).then(function (zip) {
    var doc = zip.file('word/document.xml');
    var styles = zip.file('word/styles.xml');
    if (!doc) throw new Error('document.xml 缺失');
    return Promise.all([doc.async('string'), styles ? styles.async('string') : '']);
  }).then(function (parts) {
    return W.docxVectors(parts[0], parts[1]);
  });
}

var docxVectors = null;
check('docx 解析：段落数与字号分布合理', function () {
  return readDocxVectors(DOCX).then(function (vectors) {
    docxVectors = vectors;
    assert.ok(vectors.length >= htmlVectors.length - 4,
      'docx 段落数不应明显少于原稿（' + vectors.length + ' vs ' + htmlVectors.length + '）');
    var body = findVector(vectors, '本品为泽泻的炮制品');
    assert.strictEqual(body.sizePt, 10);
    assert.strictEqual(body.family, '宋体');
    assert.strictEqual(body.lineSpacing, 1.5);
    var title = findVector(vectors, '麸炒泽泻');
    assert.strictEqual(title.sizePt, 16);
    assert.strictEqual(title.align, 'center');
  });
});

check('docx 样式表继承被读进来（Normal 样式不再是空白）', function () {
  assert.ok(docxVectors, '依赖上一组的解析结果');
  var cell = findVector(docxVectors, '时间（分钟）');
  assert.strictEqual(cell.sizePt, 9, '表格字号应从 rPr 读到 9pt');
});

// ---------------------------------------------------------------- 比对
check('★ 还原验收：docx vs 原稿声明，差异必须为 0', function () {
  var result = W.compareVectors(docxVectors, htmlVectors);
  var summary = W.summarize(result);
  assert.strictEqual(summary.total, 0,
    '应无版式差异，实际 ' + summary.total + ' 处：' +
    result.diffs.slice(0, 6).map(function (d) {
      return '第' + d.para + '段 ' + d.prop + ' 期望' + d.expect + ' 实际' + d.actual;
    }).join(' / '));
  assert.ok(summary.aligned >= htmlVectors.length - 4, '段落对齐数应接近全量：' + summary.aligned);
});

check('故意做坏：某段字号改成 12pt，必须被点名到段落号', function () {
  var broken = docxVectors.map(function (fp) {
    if (String(fp.text).indexOf('本品为泽泻的炮制品') >= 0) {
      return Object.assign({}, fp, { sizePt: 12 });
    }
    return fp;
  });
  var result = W.compareVectors(broken, htmlVectors);
  assert.strictEqual(result.diffs.length, 1, '应恰好报 1 处，实际 ' + result.diffs.length);
  var diff = result.diffs[0];
  assert.strictEqual(diff.prop, '字号');
  assert.strictEqual(diff.expect, '10pt');
  assert.strictEqual(diff.actual, '12pt');
  assert.ok(diff.text.indexOf('本品为泽泻') === 0, '差异要能定位到具体段落文本');
});

check('故意做坏：上下标被抹平，必须报「下标字数」', function () {
  var flattened = docxVectors.map(function (fp) {
    return Object.assign({}, fp, { subChars: 0 });
  });
  var result = W.compareVectors(flattened, htmlVectors);
  assert.ok(result.diffs.some(function (d) { return d.prop === '下标字数'; }),
    '抹平下标属于内容级损坏，必须被抓出来');
});

check('期望样式表生效：defaults 覆盖后按新基准报差异', function () {
  var spec = { name: '我司口径（假设正文要小四）', defaults: { sizePt: 12 } };
  var expected = W.specVectors(spec, htmlVectors);
  var result = W.compareVectors(docxVectors, expected);
  assert.ok(result.diffs.length > 0, '按 12pt 口径应报差异');
  assert.ok(result.diffs.every(function (d) { return d.prop === '字号'; }),
    '差异应全部落在字号上');
});

check('真实期望表（specs/gdherb-2026.json）：按我司口径也应零差异', function () {
  var spec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'specs', 'gdherb-2026.json'), 'utf8'));
  var expected = W.specVectors(spec, htmlVectors);
  var result = W.compareVectors(docxVectors, expected);
  var summary = W.summarize(result);
  assert.strictEqual(summary.total, 0,
    '按期望样式表核对应无差异，实际 ' + summary.total + ' 处：' +
    result.diffs.slice(0, 6).map(function (d) {
      return '第' + d.para + '段 ' + d.prop + ' 基准' + d.expect + ' 实际' + d.actual;
    }).join(' / '));
});

check('期望表规则：只覆盖命中的段落，其余退回原稿', function () {
  var spec = { rules: [{ match: { textStarts: '【标准号】' }, set: { sizePt: 16 } }] };
  var expected = W.specVectors(spec, htmlVectors);
  assert.strictEqual(expected[0].sizePt, 16, '命中的段落应被改成 16pt');
  var untouched = findVector(expected, '本品为泽泻的炮制品');
  assert.strictEqual(untouched.sizePt, 10, '没命中的段落保持原稿 10pt');
});

check('缩进两种写法等价：0.29in ≈ 2 字符（10pt）', function () {
  var a = [{ i: 0, text: '甲', sizePt: 10, indentIn: 0.29, indentChars: null }];
  var b = [{ i: 0, text: '甲', sizePt: 10, indentIn: null, indentChars: 2 }];
  assert.strictEqual(W.compareVectors(a, b).diffs.length, 0,
    '同一缩进的不同表达不该报成版式差异');
});

check('段落数不等时按文本对齐，不整体错位', function () {
  var a = [{ i: 0, text: '第一段', sizePt: 10 }, { i: 1, text: '第二段', sizePt: 10 },
    { i: 2, text: '第三段', sizePt: 10 }];
  var b = [{ i: 0, text: '第一段', sizePt: 10 }, { i: 1, text: '第三段', sizePt: 12 }];
  var result = W.compareVectors(a, b);
  assert.strictEqual(result.onlyActual, 1, '多出的段落要单独计数');
  assert.strictEqual(result.diffs.length, 1);
  assert.strictEqual(result.diffs[0].para, 2, '差异要落在真正的第三段，而不是错位到第二段');
});

check('vectorsText 与段落序列一致（可直接喂现有文本对比管线）', function () {
  var text = W.vectorsText(htmlVectors);
  assert.ok(text.split('\n\n').length === htmlVectors.length, '段落间应以空行分隔，与 mammoth 同构');
  assert.ok(text.indexOf('【炮制】') > 0);
});

// ---------------------------------------------------------------- 跑起来
var chain = Promise.resolve();
tests.forEach(function (t) {
  chain = chain.then(function () { return t[1](); }).then(
    function () { passed++; console.log('  ok  ' + t[0]); },
    function (e) { failed++; console.log('FAIL  ' + t[0] + '\n      ' + (e && e.message)); }
  );
});
chain.then(function () {
  console.log('\n' + passed + ' 通过 / ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
});
