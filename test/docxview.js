'use strict';
/**
 * docxview.js 单元测试：vm 沙箱注入源码，桩掉 docx-preview / mammoth / DOM，
 * 验证加载、过期令牌丢弃、清空、互换、提词、缺库报错。
 * 运行：node test/docxview.js
 */
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var passed = 0, failed = 0;
var tests = [];
// 用例共享沙箱状态，必须串行执行（并行会互相 clear/覆盖加载）
function check(name, fn) { tests.push([name, fn]); }
function runAll() {
  var chain = Promise.resolve();
  tests.forEach(function (t) {
    chain = chain.then(t[1]).then(
      function () { passed++; console.log('  ok  ' + t[0]); },
      function (e) { failed++; console.log('FAIL  ' + t[0] + '\n      ' + e.message); }
    );
  });
  return chain;
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert failed'); }

// ---- 最小 DOM 桩 ----
function mkEl(tag) {
  var html = '';
  var el = {
    tagName: tag, className: '', style: {}, children: [],
    firstChild: null,
    clientWidth: 600,
    appendChild: function (c) { el.children.push(c); el.firstChild = el.children[0]; return c; },
    querySelector: function () { return null; }
  };
  // 仿真 DOM：innerHTML='' 会清空子节点
  Object.defineProperty(el, 'innerHTML', {
    get: function () { return html; },
    set: function (v) { html = v; if (v === '') { el.children = []; el.firstChild = null; } }
  });
  return el;
}
function mkSandbox(opts) {
  opts = opts || {};
  var renderCalls = [];
  var sandbox = {
    document: { createElement: function (tag) { return mkEl(tag); } },
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    Promise: Promise, Error: Error, Math: Math, JSON: JSON,
    console: console
  };
  if (!opts.noDocx) {
    sandbox.docx = {
      renderAsync: function (buf, host) {
        renderCalls.push(buf);
        host.rendered = buf;                       // 标记：渲染结果挂在容器上
        return Promise.resolve();
      }
    };
  }
  if (!opts.noMammoth) {
    sandbox.mammoth = {
      extractRawText: function (o) {
        return Promise.resolve({ value: '提取文本:' + o.arrayBuffer.len });
      }
    };
  }
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/docxview.js'), 'utf8'), sandbox, { filename: 'docxview.js' });
  return { sandbox: sandbox, renderCalls: renderCalls };
}
function mkPanels(DocxView) {
  var left = mkEl('div'), right = mkEl('div');
  DocxView.init({ left: left, right: right });
  return { L: left, R: right };
}
var buf1 = { len: 1, byteLength: 100 }, buf2 = { len: 2, byteLength: 200 };

console.log('docxview\n');

var t1 = mkSandbox();
var D1 = t1.sandbox.DocxView;
var p1 = mkPanels(D1);

check('加载成功：渲染挂载到面板，isLoaded=true', function () {
  return D1.load('L', buf1).then(function () {
    assert(D1.isLoaded('L') === true, 'L 应为已加载');
    assert(D1.isLoaded('R') === false, 'R 不应已加载');
    assert(p1.L.children.length === 1, '面板应有 1 个子节点');
    assert(p1.L.children[0].className === 'docx-host', '子节点应为 .docx-host');
    assert(p1.L.children[0].rendered === buf1, '渲染内容应为传入的 buffer');
  });
});

check('过期令牌丢弃：同侧两次加载只保留后者', function () {
  var r1 = D1.load('L', buf1, 1);
  var r2 = D1.load('L', buf2, 2);
  return Promise.all([r1, r2]).then(function () {
    assert(p1.L.children[0].rendered === buf2, '面板应为第二次加载的内容');
  });
});

check('清空：isLoaded=false，面板清空', function () {
  D1.clear('L');
  assert(D1.isLoaded('L') === false, 'L 应为未加载');
  assert(p1.L.innerHTML === '', '面板应已清空');
});

check('互换：两侧内容对调并重渲染，不重新取文件', function () {
  return D1.load('L', buf1).then(function () {
    return D1.load('R', buf2);
  }).then(function () {
    var n = t1.renderCalls.length;
    D1.swap();
    assert(t1.renderCalls.length === n + 2, 'swap 应重渲染两侧（不重新取文件）');
    // swap 后：L 面板渲染的是原 R 的 buffer
    return new Promise(function (res) { setTimeout(res, 0); });
  }).then(function () {
    assert(p1.L.children[0].rendered === buf2, 'L 面板应为原 R 内容');
    assert(p1.R.children[0].rendered === buf1, 'R 面板应为原 L 内容');
  });
});

check('提词：extractText 透传 mammoth 结果', function () {
  return D1.extractText(buf1).then(function (text) {
    assert(text === '提取文本:1', '应返回 mammoth 的 value，实际：' + text);
  });
});

check('缺少 docx-preview 全局时给出明确错误', function () {
  var t = mkSandbox({ noDocx: true });
  mkPanels(t.sandbox.DocxView);
  return t.sandbox.DocxView.load('L', buf1).then(
    function () { throw new Error('不应成功'); },
    function (e) { assert(/docx-preview 未加载/.test(e.message), '错误信息不符：' + e.message); }
  );
});

check('缺少 mammoth 全局时给出明确错误', function () {
  var t = mkSandbox({ noMammoth: true });
  return t.sandbox.DocxView.extractText(buf1).then(
    function () { throw new Error('不应成功'); },
    function (e) { assert(/mammoth 未加载/.test(e.message), '错误信息不符：' + e.message); }
  );
});

runAll().then(function () {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
});
