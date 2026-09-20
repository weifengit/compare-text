/**
 * report.js — src/report.js 报告模板测试（阶段 C：批量总览 / Redline 合并视图）。
 * 运行：node test/report.js
 */
'use strict';
var assert = require('assert');
var Compute = require('../src/compute.js');
var Report = require('../src/report.js');

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

function gridPair(l, r, lName, rName) {
  return { leftName: lName, rightName: rName, result: Compute.computeDiff({ left: l, right: r, options: {} }), shots: { L: [], R: [] } };
}

console.log('report tests\n');

// ---------- C1 批量总览 ----------
check('C1-1. 多对报告开头有总览，含锚点超链接', function () {
  var html = Report.build({
    title: 't', time: 'now',
    pairs: [gridPair('a\nb', 'a\nB', '甲v1.docx', '甲v2.docx'), gridPair('x', 'y', '乙v1.docx', '乙v2.docx')]
  });
  assert.ok(html.indexOf('class="rep-toc"') >= 0, '应有总览区块');
  assert.ok(html.indexOf('<a href="#pair-1">甲v1.docx ↔ 甲v2.docx</a>') >= 0, '总览第 1 行应为锚点链接');
  assert.ok(html.indexOf('<a href="#pair-2">乙v1.docx ↔ 乙v2.docx</a>') >= 0, '总览第 2 行应为锚点链接');
  assert.ok(html.indexOf('id="pair-1"') >= 0 && html.indexOf('id="pair-2"') >= 0, '正文每对应有锚点 id');
  assert.ok(html.indexOf('修改 <span class="bad">1</span>') >= 0, '总览行应含差异统计');
});

check('C1-2. 单对报告不出总览', function () {
  var html = Report.build({ title: 't', time: 'now', pairs: [gridPair('a', 'b', 'l', 'r')] });
  assert.ok(html.indexOf('class="rep-toc"') < 0, '单对不应有总览');
  assert.ok(html.indexOf('class="rep-floatnav"') < 0, '单对不应有悬浮导航');
  assert.ok(html.indexOf('id="pair-1"') >= 0, '锚点 id 仍应存在（不妨碍多对拼接）');
});

check('C1-3. 多对报告有右侧悬浮导航：顶部 / 各对文件名缩写 / 底部', function () {
  var html = Report.build({
    title: 't', time: 'now',
    pairs: [gridPair('a\nb', 'a\nB', '合同甲方终版.docx', '合同乙方终版.docx'),
            gridPair('x', 'y', 'a.pdf', 'b.pdf')]
  });
  assert.ok(html.indexOf('class="rep-floatnav"') >= 0, '应有悬浮导航');
  assert.ok(html.indexOf('<a href="#top">顶部</a>') >= 0, '应有去顶部链接');
  // #top 锚点必须是独立静态元素，不能放在 sticky 头部上（否则浏览器认为已在视口内，点击不滚动）
  assert.ok(html.indexOf('<div id="top"></div>') >= 0, '顶部锚点应为独立静态元素');
  assert.ok(html.indexOf('class="rep-head" id="top"') < 0, '顶部锚点不应放在 sticky 头部上');
  assert.ok(html.indexOf('<a href="#rep-bottom">底部</a>') >= 0 && html.indexOf('id="rep-bottom"') >= 0,
    '应有去底部链接及底部锚点');
  // 导航文案：去后缀、超过 5 字截前 5 字、不足全显，格式"左VS右"
  assert.ok(html.indexOf('title="合同甲方终版.docx ↔ 合同乙方终版.docx">合同甲方终VS合同乙方终</a>') >= 0,
    '长文件名应截前 5 字并保留完整名悬停提示');
  assert.ok(html.indexOf('title="a.pdf ↔ b.pdf">aVSb</a>') >= 0, '短文件名应全显');
  assert.ok(html.indexOf('position:fixed;right:15px;top:50%') >= 0, '应为右侧中部固定定位');
  assert.ok(html.indexOf('scroll-margin-top') >= 0, '锚点跳转应避开吸顶头部遮挡');
});

// ---------- C2 Redline 合并视图 ----------
check('C2-1. grid 模式：change 行红删除线 + 蓝下划线交错合并', function () {
  var html = Report.build({ title: 't', time: 'now', pairs: [gridPair('a\nb\nc', 'a\nB\nc\nd', 'l', 'r')] });
  assert.ok(html.indexOf('rep-view-redline') >= 0, '应有 Redline 视图容器');
  // change 行 b→B：删除的 b 划线、新增的 B 下划线
  assert.ok(/<span class="rl-del">b<\/span><span class="rl-ins">B<\/span>/.test(html),
    'change 行应为 删除划线+新增下划线 交错');
  // add 行 d：整行下划线
  assert.ok(html.indexOf('<span class="rl-ins">d</span>') >= 0, 'add 行应整行下划线');
  // 未变行 a/c：黑色原样（不带 rl 标记）
  assert.ok(/<div class="rl-line">a<\/div>/.test(html), 'equal 行应原样输出');
});

check('C2-2. grid 模式：remove 行整行划线', function () {
  var html = Report.build({ title: 't', time: 'now', pairs: [gridPair('a\ndel\nc', 'a\nc', 'l', 'r')] });
  assert.ok(html.indexOf('<div class="rl-line"><span class="rl-del">del</span></div>') >= 0,
    'remove 行应整行红色删除线');
});

check('C2-3. flow 模式（忽略换行）：整篇合并后按行拆', function () {
  var r = Compute.computeDiff({ left: '第一行\n旧词', right: '第一行\n新词', options: { ignoreNewline: true } });
  assert.strictEqual(r.mode, 'flow');
  var html = Report.build({ title: 't', time: 'now',
    pairs: [{ leftName: 'l', rightName: 'r', result: r, shots: { L: [], R: [] } }] });
  assert.ok(/<span class="rl-del">旧<\/span><span class="rl-ins">新<\/span>/.test(html),
    'flow 的 change 也应交错合并（删除划线 + 新增下划线）');
});

check('C2-4. 报告内一键切换：按钮 + 切换脚本 + 记忆', function () {
  var html = Report.build({ title: 't', time: 'now', pairs: [gridPair('a', 'b', 'l', 'r')] });
  assert.ok(html.indexOf('data-view="split"') >= 0 && html.indexOf('data-view="redline"') >= 0, '应有切换按钮');
  assert.ok(html.indexOf('localStorage') >= 0, '应记住上次选择的视图');
  assert.ok(html.indexOf('.rep-view[hidden]{display:none}') >= 0, '隐藏视图样式应内联');
});

check('C2-5. 失败/跳过的对：Redline 视图同样给出说明', function () {
  var html = Report.build({ title: 't', time: 'now',
    pairs: [{ leftName: 'l', rightName: 'r', result: { error: 'x' }, shots: { L: [], R: [] } }] });
  assert.ok(html.indexOf('对比失败') >= 0, '错误信息应出现在报告中');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
