/**
 * scroll-rebind.js — 回归：折叠/展开按钮点击后，主区域1 重建的 leftBody/rightBody
 * 必须重新绑定协同滚动（旧实现因未 rebind 而失效）。
 * 运行：node test/scroll-rebind.js
 */
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');

function mkClassList(seed) {
  var s = seed ? seed.slice() : [];
  return {
    add: function (c) { if (s.indexOf(c) === -1) s.push(c); },
    remove: function (c) { var i = s.indexOf(c); if (i !== -1) s.splice(i, 1); },
    toggle: function (c, force) {
      var on = force === undefined ? s.indexOf(c) === -1 : !!force;
      if (on) { if (s.indexOf(c) === -1) s.push(c); }
      else { var i = s.indexOf(c); if (i !== -1) s.splice(i, 1); }
      return on;
    },
    contains: function (c) { return s.indexOf(c) !== -1; }
  };
}
function mkEl(id) {
  var el = {
    id: id, checked: false, textContent: '', value: '', style: {},
    scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    classList: mkClassList(), children: [], _listeners: {},
    addEventListener: function (t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    dispatch: function (t, ev) { (this._listeners[t] || []).forEach(function (f) { f(ev || {}); }); },
    getAttribute: function () { return null; },
    closest: function () { return null; },
    appendChild: function (c) { this.children.push(c); },
    remove: function () {}, select: function () {}, setAttribute: function () {}
  };
  Object.defineProperty(el, 'innerHTML', {
    get: function () { return this._html || ''; },
    set: function (v) { this._html = v; this.children.length = 0; }
  });
  return el;
}
var mkEditor = function () {
  return {
    _value: '', _handlers: {},
    getValue: function () { return this._value; },
    setValue: function (v) { this._value = v; },
    on: function (t, fn) { (this._handlers[t] = this._handlers[t] || []).push(fn); },
    fire: function (t, ev) { (this._handlers[t] || []).forEach(function (f) { f(ev || {}); }); }
  };
};

var workers = [], els = {}, editors = [], posted = [];
var sandbox = {
  console: console,
  document: {
    body: { appendChild: function () {} },
    getElementById: function (id) { return els[id] || (els[id] = mkEl(id)); },
    createElement: function () { return mkEl('created'); },
    addEventListener: function () {}, removeEventListener: function () {},
    execCommand: function () { return false; }
  },
  navigator: { clipboard: undefined },
  localStorage: { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} },
  CodeMirror: { fromTextArea: function () { var ed = mkEditor(); editors.push(ed); return ed; } },
  Worker: function () {
    var w = { onmessage: null, onerror: null, postMessage: function (m) { posted.push(m); } };
    workers.push(w);
    return w;
  },
  fetch: function () { return Promise.resolve({ text: function () { return Promise.resolve(''); } }); },
  pdfjsLib: { getDocument: function () { return { promise: Promise.reject(new Error('stub pdf')) }; } },
  setTimeout: setTimeout, clearTimeout: clearTimeout,
  Diff: require('../lib/diff.min.js')
};
vm.createContext(sandbox);
['normalize', 'compute', 'source-api', 'filterbar', 'pdfview', 'syncscroll', 'tabs', 'app'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/' + f + '.js'), 'utf8'), sandbox, { filename: f + '.js' });
});
var Compute = sandbox.Compute;

// 记录每次 rebind 收到的元素列表
var rebindCalls = [];
var origRebind = sandbox.SyncScroll.rebind;
sandbox.SyncScroll.rebind = function (list) { rebindCalls.push((list || []).slice()); if (origRebind) origRebind.call(this, list); };

var passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// 走真实 compare 路径：填入文本并触发 change → 防抖 → worker 收到真实 seq id
function driveCompare(left, right) {
  editors[0].setValue(left);
  editors[1].setValue(right);
  editors[0].fire('change');
  editors[1].fire('change');
  return wait(500).then(function () {
    var last = posted[posted.length - 1];
    if (!last) throw new Error('防抖后应已向 worker 发送对比请求');
    // 强制 grid 模式（折叠逻辑只对 grid 生效）：显式关闭 ignoreNewline，
    // 与应用渲染无关——renderResult 只认 res.mode。
    var opts = { ignoreCase: false, ignoreEol: true, ignoreNewline: false,
                 ignoreWhitespace: false, ignoreWidth: false, ignorePunct: false };
    var res = Compute.computeDiff({ left: left, right: right, options: opts });
    res._options = opts;
    workers[0].onmessage({ data: { id: last.id, result: res } });
    return res;
  });
}

// 桩的 innerHTML 只存字符串、不重建 DOM 节点，因此用“点击后触发了一次 rebind”
// 作为回归判据：旧实现折叠按钮走 renderGrid（不 rebind），新实现 rerenderGridKeepScroll → rebind。
driveCompare('x\nx\nx\nx\nx\ny', 'x\nx\nx\nx\nx\nz').then(function () {
  if (!els['leftBody']) throw new Error('leftBody 应已渲染');
  var rebindsBefore = rebindCalls.length;

  els['foldBtn'].dispatch('click');            // 折叠 → 展开
  check('折叠按钮触发了新的 rebind（协同滚动重新绑定）', function () {
    if (rebindCalls.length <= rebindsBefore) throw new Error('点击折叠按钮后应重新调用 rebindScrollSync');
    if (els['foldBtn'].textContent !== '展开相同行') throw new Error('按钮文字应变“展开相同行”');
  });
  check('最后一次 rebind 已包含当前 leftBody/rightBody', function () {
    var last = rebindCalls[rebindCalls.length - 1];
    if (last.indexOf(els['leftBody']) === -1) throw new Error('当前 leftBody 未重新绑定协同滚动');
    if (last.indexOf(els['rightBody']) === -1) throw new Error('当前 rightBody 未重新绑定协同滚动');
  });

  // 折叠条点击（非按钮）同样触发重新绑定
  return driveCompare('a\na\na\na\na\nb', 'a\na\na\na\na\nc').then(function () {
    var rebindsBefore = rebindCalls.length;
    els['results'].dispatch('click', {
      target: { closest: function (sel) { return sel === '.fold-row' ? { getAttribute: function () { return '0:4'; } } : null; } }
    });
    check('折叠条点击也触发重新绑定', function () {
      if (rebindCalls.length <= rebindsBefore) throw new Error('折叠条点击后应重新调用 rebindScrollSync');
    });
  });
}).then(function () {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}).catch(function (e) {
  console.log('FAIL  ' + (e && e.message));
  process.exit(1);
});
