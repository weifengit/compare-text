/**
 * dsh-report.js — tools/dsh-report.js 插件薄层测试（阶段 D：glob / 配对 / 分卷 / 输入校验）。
 * 纯逻辑测试，不起浏览器、不调 render.js。运行：node test/dsh-report.js
 */
'use strict';
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var D = require('../tools/dsh-report.js');

var passed = 0, failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL  ' + name + '\n      ' + e.message);
  }
}

// 临时夹具：两个文件夹，x/y 同名可配对，only-l/only-r 单边多余，垃圾扩展名应被默认 glob 排除
var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-report-test-'));
var LD = path.join(tmp, 'left'), RD = path.join(tmp, 'right');
fs.mkdirSync(LD); fs.mkdirSync(RD);
['x.docx', 'y.pdf', 'only-l.docx', 'junk.html'].forEach(function (n) { fs.writeFileSync(path.join(LD, n), 'l'); });
['x.docx', 'y.pdf', 'only-r.docx', 'note.json'].forEach(function (n) { fs.writeFileSync(path.join(RD, n), 'r'); });

console.log('dsh-report tests\n');

// ---------- glob ----------
check('glob：* 与 ? 匹配，大小写不敏感', function () {
  assert.ok(D.globMatch('*.docx', 'a.docx'));
  assert.ok(D.globMatch('*.docx', 'A.DOCX'));
  assert.ok(!D.globMatch('*.docx', 'a.pdf'));
  assert.ok(D.globMatch('合同?.pdf', '合同1.pdf'));
  assert.ok(!D.globMatch('合同?.pdf', '合同12.pdf'));
});

check('glob：{a,b} 展开', function () {
  assert.ok(D.globMatch('*.{pdf,docx}', 'a.pdf'));
  assert.ok(D.globMatch('*.{pdf,docx}', 'a.docx'));
  assert.ok(!D.globMatch('*.{pdf,docx}', 'a.txt'));
});

// ---------- source 配对 ----------
check('source：两文件夹按同文件名配对，单边多余进 warnings，垃圾扩展名被默认 glob 排除', function () {
  var r = D.resolvePairs({ source: { leftDir: LD, rightDir: RD } });
  assert.strictEqual(r.pairs.length, 2, 'x/y 应配成 2 对');
  assert.strictEqual(path.basename(r.pairs[0].left), 'x.docx');
  assert.strictEqual(path.basename(r.pairs[0].right), 'x.docx');
  assert.ok(r.warnings.some(function (w) { return w.indexOf('only-l.docx') >= 0; }), '左侧多余应有 warning');
  assert.ok(r.warnings.some(function (w) { return w.indexOf('only-r.docx') >= 0; }), '右侧多余应有 warning');
  assert.ok(!r.warnings.some(function (w) { return w.indexOf('junk.html') >= 0 || w.indexOf('note.json') >= 0; }),
    'html/json 不应进入配对');
});

check('source：glob 限定类型', function () {
  var r = D.resolvePairs({ source: { leftDir: LD, rightDir: RD, glob: '*.pdf' } });
  assert.strictEqual(r.pairs.length, 1);
  assert.strictEqual(path.basename(r.pairs[0].left), 'y.pdf');
});

check('source：list 名单（字符串=两侧同名）', function () {
  var r = D.resolvePairs({ source: { leftDir: LD, rightDir: RD, list: ['x.docx', 'missing.docx'] } });
  assert.strictEqual(r.pairs.length, 1, '只有 x.docx 能配上');
  assert.ok(r.warnings.some(function (w) { return w.indexOf('missing.docx') >= 0; }), '缺失文件应有 warning');
});

check('source：list 名单（{left,right} 显式路径，可跨名配对）', function () {
  var r = D.resolvePairs({ source: { leftDir: LD, rightDir: RD, list: [{ left: 'x.docx', right: 'y.pdf' }] } });
  assert.strictEqual(r.pairs.length, 1);
  assert.strictEqual(path.basename(r.pairs[0].left), 'x.docx');
  assert.strictEqual(path.basename(r.pairs[0].right), 'y.pdf');
});

check('source：同目录报错，引导用 pairs/list', function () {
  assert.throws(function () { D.resolvePairs({ source: { leftDir: LD, rightDir: LD } }); }, /相同/);
});

check('source：文件夹不存在报错', function () {
  assert.throws(function () { D.resolvePairs({ source: { leftDir: '/nonexistent-zzz', rightDir: RD } }); }, /不存在/);
});

// ---------- pairs 模式与互斥 ----------
check('pairs：显式路径解析为绝对路径', function () {
  var r = D.resolvePairs({ pairs: [{ left: 'a.docx', right: 'b.docx' }] });
  assert.strictEqual(r.pairs.length, 1);
  assert.ok(path.isAbsolute(r.pairs[0].left) && path.isAbsolute(r.pairs[0].right));
});

check('pairs 与 source 互斥；空任务报错', function () {
  assert.throws(function () { D.resolvePairs({ pairs: [{ left: 'a', right: 'b' }], source: { leftDir: LD, rightDir: RD } }); }, /二选一/);
  assert.throws(function () { D.resolvePairs({}); }, /pairs/);
  assert.throws(function () { D.resolvePairs({ pairs: [{ left: 'a' }] }); }, /left\/right/);
});

// ---------- 分卷 ----------
check('分卷：25 对 → 10/10/5（验收标准）', function () {
  var pairs = [];
  for (var i = 0; i < 25; i++) pairs.push({ left: 'l' + i, right: 'r' + i });
  var vols = D.splitVolumes(pairs);
  assert.deepStrictEqual(vols.map(function (v) { return v.length; }), [10, 10, 5]);
  assert.strictEqual(D.splitVolumes([{ left: 'a', right: 'b' }]).length, 1);
});

check('分卷命名：单卷原名，多卷加 -1/-2 后缀', function () {
  assert.strictEqual(D.volumeOutput('/r/out.html', 0, 1), '/r/out.html');
  assert.strictEqual(D.volumeOutput('/r/out.html', 0, 3), path.join('/r', 'out-1.html'));
  assert.strictEqual(D.volumeOutput('/r/out.html', 2, 3), path.join('/r', 'out-3.html'));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
