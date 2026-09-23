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

check('分卷：maxPairsPerReport 参数自由化', function () {
  var pairs = [];
  for (var i = 0; i < 25; i++) pairs.push({ left: 'l' + i, right: 'r' + i });
  assert.deepStrictEqual(D.splitVolumes(pairs, 6).map(function (v) { return v.length; }), [6, 6, 6, 6, 1]);
});

check('分卷命名：单卷原名，多卷加 -1/-2 后缀', function () {
  assert.strictEqual(D.volumeOutput('/r/out.html', 0, 1), '/r/out.html');
  assert.strictEqual(D.volumeOutput('/r/out.html', 0, 3), path.join('/r', 'out-1.html'));
  assert.strictEqual(D.volumeOutput('/r/out.html', 2, 3), path.join('/r', 'out-3.html'));
});

// ---------- walk 模式（模式三） ----------
var WT = path.join(tmp, 'walk');
var B1 = path.join(WT, 'B-甲'), B2 = path.join(WT, 'B-乙');
var C1 = path.join(B1, '0001 当归'), C2 = path.join(B1, '0002 黄芪'), C3 = path.join(B2, '0003 甘草');
[C1, C2, C3].forEach(function (d) { fs.mkdirSync(d, { recursive: true }); });
// C1：广东 vs 内蒙古/山东；C2：广东 vs 云南 + 一个 html 应被忽略；C3：药材名含"广东"的陷阱
[
  ['当归-广东确定.pdf', '当归-内蒙古确定.pdf', '当归-山东确定.pdf'],
  ['黄芪-广东确定.pdf', '黄芪-云南确定.pdf', '黄芪-云南确定.html'],
  ['广东土牛膝-广东确定.pdf', '广东土牛膝-江西确定.pdf']
].forEach(function (files, i) {
  var dir = [C1, C2, C3][i];
  files.forEach(function (f) { fs.writeFileSync(path.join(dir, f), 'x'); });
});
fs.writeFileSync(path.join(WT, 'B-甲', '直接文档-广东.pdf'), 'x');   // B 下直接放文档（depth=1）
fs.writeFileSync(path.join(WT, 'B-甲', '直接文档-山东.pdf'), 'x');

check('walk：每文档文件夹一卷，广东基准 vs 其它，html 排除，输出 <out>/<B>/<C>.html', function () {
  var r = D.resolveWalk({ output: path.join(tmp, 'docs'), source: { walk: { root: WT } } });
  assert.strictEqual(r.warnings.length, 0, JSON.stringify(r.warnings));
  assert.strictEqual(r.volumes.length, 4, 'C1/C2/C3 + B-甲 直接文档 = 4 卷');
  var v1 = r.volumes.find(function (v) { return v.name === '0001 当归'; });
  assert.strictEqual(v1.pairs.length, 2, '当归：广东 vs 内蒙古/山东');
  assert.strictEqual(path.basename(v1.pairs[0].left), '当归-广东确定.pdf');
  assert.strictEqual(path.basename(v1.pairs[0].right), '当归-内蒙古确定.pdf');
  assert.strictEqual(v1.output, path.join(tmp, 'docs', 'B-甲', '0001 当归.html'));
  var v2 = r.volumes.find(function (v) { return v.name === '0002 黄芪'; });
  assert.strictEqual(v2.pairs.length, 1, 'html 不应参与配对');
  var v3 = r.volumes.find(function (v) { return v.name === '0003 甘草'; });
  assert.strictEqual(v3.output, path.join(tmp, 'docs', 'B-乙', '0003 甘草.html'));
  var vb = r.volumes.find(function (v) { return v.pairs.length === 1 && v.output.indexOf(path.join('docs', 'B-甲', 'B-甲.html')) >= 0; });
  assert.ok(vb, 'B 下直接文档也应成卷');
  assert.strictEqual(vb.output, path.join(tmp, 'docs', 'B-甲', 'B-甲.html'));
  assert.strictEqual(path.basename(vb.pairs[0].left), '直接文档-广东.pdf');
});

check('walk：药材名含"广东"不被误判（取最后一段判断省份）', function () {
  var r = D.resolveWalk({ output: path.join(tmp, 'docs'), source: { walk: { root: WT } } });
  var v3 = r.volumes.find(function (v) { return v.name === '0003 甘草'; });
  assert.strictEqual(v3.pairs.length, 1);
  assert.strictEqual(path.basename(v3.pairs[0].left), '广东土牛膝-广东确定.pdf');
  assert.strictEqual(path.basename(v3.pairs[0].right), '广东土牛膝-江西确定.pdf');
});

check('walk：left 支持子串/glob/re:正则，right 可显式指定', function () {
  var r = D.resolveWalk({ output: path.join(tmp, 'docs2'), source: { walk: { root: WT, left: 're:广东确定', right: 're:(内蒙古|山东)' } } });
  var v1 = r.volumes.find(function (v) { return v.name === '0001 当归'; });
  assert.strictEqual(v1.pairs.length, 2, 'right 限定 内蒙古/山东');
  var r2 = D.resolveWalk({ output: path.join(tmp, 'docs3'), source: { walk: { root: WT, left: '*广东*' } } });
  var v1b = r2.volumes.find(function (v) { return v.name === '0001 当归'; });
  assert.strictEqual(v1b.pairs.length, 2, 'glob left *广东* 同样命中');
});

check('walk：volume 数字 = 每卷最多 N 对，输出加 -1/-2 后缀', function () {
  // 构造 5 对的 C：临时再放 3 个省份
  ['当归-四川确定.pdf', '当归-湖北确定.pdf', '当归-湖南确定.pdf'].forEach(function (f) {
    fs.writeFileSync(path.join(C1, f), 'x');
  });
  var r = D.resolveWalk({ output: path.join(tmp, 'docs4'), source: { walk: { root: WT, volume: 3 } } });
  var v1s = r.volumes.filter(function (v) { return v.name === '0001 当归'; });
  assert.strictEqual(v1s.length, 2, '5 对 / 3 → 2 卷');
  assert.deepStrictEqual(v1s.map(function (v) { return v.pairs.length; }), [3, 2]);
  assert.ok(v1s[1].output.indexOf('-2.html') >= 0, '第二卷应带 -2 后缀');
});

check('walk：root 不存在/无文档文件夹报错', function () {
  assert.throws(function () { D.resolveWalk({ output: tmp, source: { walk: { root: '/nonexistent-zzz' } } }); }, /不存在/);
  fs.mkdirSync(path.join(tmp, 'empty-walk'), { recursive: true });
  assert.throws(function () { D.resolveWalk({ output: tmp, source: { walk: { root: path.join(tmp, 'empty-walk') } } }); }, /没有任何包含文档/);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
