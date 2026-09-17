/**
 * integration.js — 模拟浏览器/Web Worker 的脚本加载方式（不经过 Node require），
 * 验证 UMD 全局挂载 + worker.js 桥接 + 计算链路端到端。
 * 运行：node -e "require('./test/integration.js')"   （或 node test/integration.js）
 *
 * 重点：jsdiff 的 UMD 在浏览器/Worker 里挂载的是全局 Diff（大写），
 * 本测试必须让 compute.js 走全局路径，确保 computeDiff 能拿到 Diff。
 */
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var assert = require('assert');

// ---- 构造 worker 环境（等价于 importScripts 加载后的全局） ----
var received = [];
var ctx = {
  console: console,
  // jsdiff@5.2.0 的 UMD 在浏览器/Worker 中挂载到根对象的大写 Diff 上：
  Diff: require('../lib/diff.min.js'),
  importScripts: function () { /* 各脚本已按顺序源码注入 vm */ },
  postMessage: function (m) { received.push(m); }
};
ctx.self = ctx;
vm.createContext(ctx);
// 按真实加载顺序执行源码：diff(min) -> normalize -> compute -> worker
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/normalize.js'), 'utf8'), ctx, { filename: 'normalize.js' });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/compute.js'), 'utf8'), ctx, { filename: 'compute.js' });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/worker.js'), 'utf8'), ctx, { filename: 'worker.js' });

assert.strictEqual(typeof ctx.Compute.computeDiff, 'function', 'compute.js 应通过全局路径挂载 Compute');

function post(payload) {
  ctx.onmessage({ data: { id: (received.length + 1), payload: payload } });
  return received[received.length - 1].result;
}

var passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

console.log('integration (browser/worker global path)\n');

check('compute.js 通过全局 Diff 找到 jsdiff', function () {
  assert.ok(ctx.Diff && typeof ctx.Diff.diffArrays === 'function', '全局 Diff.diffArrays 应可用');
  assert.strictEqual(typeof ctx.Compute.computeDiff, 'function');
});

check('worker 桥接：行级 diff 返回 rows', function () {
  var r = post({ left: 'a\nb\nc', right: 'a\nX\nc' });
  assert.strictEqual(r.mode, 'grid');
  assert.ok(Array.isArray(r.rows) && r.rows.length >= 3);
});

check('worker 桥接：忽略换行返回 flow', function () {
  var r = post({ left: '一\n二', right: '一 二', options: { ignoreNewline: true } });
  assert.strictEqual(r.mode, 'flow');
  assert.strictEqual(r.addedChars + r.removedChars, 0);
});

check('worker 桥接：null payload 优雅返回空结果', function () {
  var r = post({ left: '', right: '' });
  assert.strictEqual(r.mode, 'grid');
  assert.strictEqual(r.rows.length, 0);
});

check('worker 桥接：计算异常会回传 error 而非挂起', function () {
  var orig = ctx.Compute.computeDiff;
  ctx.Compute.computeDiff = function () { throw new Error('boom'); };
  try {
    ctx.onmessage({ data: { id: 999, payload: { left: 'a', right: 'b' } } });
    var m = received[received.length - 1];
    assert.strictEqual(m.id, 999);
    assert.ok(m.error && /boom/.test(m.error), '应回传 error 字段');
  } finally {
    ctx.Compute.computeDiff = orig;
  }
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);