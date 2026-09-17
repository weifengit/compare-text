/**
 * smoke.js — Node 冒烟测试：验证 normalize.js + compute.js 核心逻辑。
 * 运行：node test/smoke.js
 */
'use strict';
var assert = require('assert');
var Compute = require('../src/compute.js');

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
function diff(left, right, opts) {
  return Compute.computeDiff({ left: left, right: right, options: opts || {} });
}

console.log('smoke tests\n');

check('1. 简单增/删/改行', function () {
  var r = diff('a\nb\nc', 'a\nB\nc\nd');
  assert.strictEqual(r.mode, 'grid');
  var types = r.rows.map(function (x) { return x.type; });
  assert.ok(types.indexOf('change') >= 0, '应出现 change 行，实际 ' + JSON.stringify(types));
  assert.ok(types.indexOf('add') >= 0, '应出现 add 行');
  var chg = r.rows.filter(function (x) { return x.type === 'change'; })[0];
  assert.strictEqual(chg.li, 1);
  assert.strictEqual(chg.ri, 1);
  assert.ok(chg.segL && chg.segL.length, 'change 行应有左侧片段');
  // 片段里有 rm 字符
  var rmText = chg.segL.filter(function (s) { return s.cls === 'rm'; }).map(function (s) { return s.text; }).join('');
  assert.strictEqual(rmText, 'b', '左侧删除片段应为 "b"，实际 "' + rmText + '"');
});

check('2. 忽略大小写', function () {
  var r = diff('Helloworld', 'helloworld'.replace(/el/, 'EL'), { ignoreCase: true });
  // "Helloworld" vs "hELLoworld" 忽略大小写相等（无 diff）
  var r2 = diff('Hello World\nfoo', 'hello world\nfoo', { ignoreCase: true });
  assert.strictEqual(r2.stats.modified + r2.stats.added + r2.stats.removed, 0, '忽略大小写后不应有差异');
  assert.strictEqual(r2.stats.equal, 2);
});

check('3. 忽略空格（含内部空格）', function () {
  var r = diff('hello   world\nkeep', 'hello world\nkeep', { ignoreWhitespace: true });
  assert.strictEqual(r.stats.modified + r.stats.added + r.stats.removed, 0, '忽略空格后不应有差异');
  // 反例：不开忽略空格时应检测到差异
  var r2 = diff('hello world', 'hello   world');
  assert.strictEqual(r2.stats.modified + r2.stats.added + r2.stats.removed, 1, '不忽略时应有差异');
});

check('4. 全/半角识别', function () {
  var r = diff('（测试）：ＡＢＣ', '(测试):ABC', { ignoreWidth: true });
  assert.strictEqual(r.stats.modified + r.stats.added + r.stats.removed, 0, '忽略全半角后不应有差异');
});

check('5. 忽略标点', function () {
  var r = diff('你好，世界', '你好，世界。', { ignorePunct: true });
  assert.strictEqual(r.stats.modified + r.stats.added + r.stats.removed, 0, '忽略标点后不应有差异');
  var r2 = diff('a, b', 'a b', { ignorePunct: true });
  assert.strictEqual(r2.stats.modified + r2.stats.added + r2.stats.removed, 0);
  // 标点影响句式而不影响字词时的真实差异仍应出现
  var r3 = diff('你好，世界', '你好，地球', { ignorePunct: true });
  assert.strictEqual(r3.stats.modified, 1, '真实字词差异应保留');
});

check('6. 忽略换行（段落重排）', function () {
  var r = diff('第一行\n第二行第三行', '第一行 第二行 第三行', { ignoreNewline: true });
  assert.strictEqual(r.mode, 'flow');
  assert.strictEqual(r.removedChars + r.addedChars, 0, '忽略换行后不应有差异');
  // 真正的整段变化仍应检测到
  var r2 = diff('第一行\n第二行', '第一行\n改变的段落', { ignoreNewline: true });
  assert.strictEqual(r2.removedChars, 3); // 第二行 → 改变的段落
  assert.strictEqual(r2.addedChars, 5);
});

check('7. CRLF vs LF 归一', function () {
  var r = diff('a\r\nb\r\nc\r\n', 'a\nb\nc\n');
  assert.strictEqual(r.stats.modified + r.stats.added + r.stats.removed, 0, 'CRLF/LF 差异不应出现');
  assert.strictEqual(r.stats.equal, 4); // 3 行 + 末尾换行带来的 1 个空行
});

check('8. unified diff 输出', function () {
  var r = diff('aa\nbb\ncc\ndd\nee\nff\ngg', 'aa\nbb\ncc\nXX\nee\nff\ngg');
  assert.ok(/^--- a\/原文/m.test(r.unified), '应含文件头');
  assert.ok(/^@@ -\d/m.test(r.unified), '应含 hunk 头');
  assert.ok(/^-dd$/m.test(r.unified), '应含 -dd');
  assert.ok(/^\+XX$/m.test(r.unified), '应含 +XX');
});

check('9. 折叠感知：连续相同行仍为 equal 行（折叠在 UI 层做）', function () {
  var r = diff('x\nx\nx\nx\ny', 'x\nx\nx\nx\nz');
  assert.strictEqual(r.stats.equal, 4);
  assert.strictEqual(r.stats.modified, 1);
});

check('10. 文本完全相同', function () {
  var r = diff('abc\ndef', 'abc\ndef');
  assert.strictEqual(r.stats.equal, 2);
  assert.strictEqual(r.unified, '');
});

check('11. 空两侧 / 一侧为空', function () {
  var r = diff('', 'x\ny');
  assert.strictEqual(r.stats.added, 2);
  var r2 = diff('', '');
  assert.strictEqual(r2.stats.equal, 0);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);