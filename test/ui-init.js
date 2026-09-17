/**
 * ui-init.js — 用 DOM/浏览器 API 桩驱动 src/app.js：初始化 + 首次对比，
 * 再通过桩 Worker 回报结果，覆盖 renderGrid / renderFlow / renderInline / 折叠点击。
 * 运行：node -e "require('./test/ui-init.js')"
 */
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');

function mkClassList() {
  return { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } };
}
function mkEl(id) {
  return {
    id: id, checked: false, textContent: '', innerHTML: '', value: '', style: {},
    classList: mkClassList(),
    _listeners: {},
    addEventListener: function (type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    dispatch: function (type, ev) { (this._listeners[type] || []).forEach(function (f) { f(ev || {}); }); },
    getAttribute: function () { return null; },
    closest: function () { return null; },
    appendChild: function () {}, remove: function () {}, select: function () {}, setAttribute: function () {}
  };
}
var mkEditor = function () {
  return { getValue: function () { return ''; }, setValue: function () {}, on: function () {} };
};

var workers = [];
var els = {};

var sandbox = {
  console: console,
  document: {
    body: { appendChild: function () {} },
    getElementById: function (id) { return els[id] || (els[id] = mkEl(id)); },
    createElement: function () { return mkEl('created'); },
    addEventListener: function () {},
    execCommand: function () { return false; }
  },
  navigator: { clipboard: undefined },
  localStorage: { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} },
  CodeMirror: { fromTextArea: function () { return mkEditor(); } },
  Worker: function () { var w = { onmessage: null, onerror: null, postMessage: function () {} }; workers.push(w); return w; },
  setTimeout: setTimeout, clearTimeout: clearTimeout,
  // 浏览器主线程真实挂载方式：jsdiff 挂到大写 Diff
  Diff: require('../lib/diff.min.js')
};

vm.createContext(sandbox);
// 与 index.html 相同的脚本加载顺序
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/normalize.js'), 'utf8'), sandbox, { filename: 'normalize.js' });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/compute.js'), 'utf8'), sandbox, { filename: 'compute.js' });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8'), sandbox, { filename: 'app.js' });
var Compute = sandbox.Compute;

var passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}
console.log('ui init + render\n');

check('初始化完成且启动了 Worker', function () {
  if (!(workers.length >= 1)) throw new Error('应有 worker 实例，实际 ' + workers.length);
});

check('grid 结果渲染不抛错', function () {
  var res = Compute.computeDiff({ left: 'a\nb\nc', right: 'a\nX\nc' });
  res._options = { ignoreCase: false, ignoreEol: true };
  workers[0].onmessage({ data: { id: 1, result: res } });
});
check('flow 结果渲染不抛错', function () {
  var res = Compute.computeDiff({ left: '一\n二', right: '一 二', options: { ignoreNewline: true } });
  res._options = { ignoreNewline: true, ignoreCase: false, ignoreEol: true };
  workers[0].onmessage({ data: { id: 2, result: res } });
});
check('折叠行点击（grid）不抛错', function () {
  var grid = Compute.computeDiff({
    left: 'x\nx\nx\nx\n' + 'changedA', right: 'x\nx\nx\nx\n' + 'changedB'
  });
  grid._options = { ignoreCase: false, ignoreEol: true };
  workers[0].onmessage({ data: { id: 3, result: grid } });
  var resultsEl = els['results'];
  resultsEl.dispatch('click', {
    target: { closest: function (sel) { return sel === '.fold-row' ? { getAttribute: function () { return '0:3'; } } : null; } }
  });
});
check('内联视图切换后重新渲染不抛错', function () {
  var grid = Compute.computeDiff({ left: 'a\nb', right: 'a\nX' });
  grid._options = { ignoreCase: false, ignoreEol: true };
  workers[0].onmessage({ data: { id: 4, result: grid } });
  els['viewToggle'].dispatch('click');   // side -> inline
  els['viewToggle'].dispatch('click');   // inline -> side
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);