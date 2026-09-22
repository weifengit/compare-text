/**
 * combobox.js — 用轻量 DOM 桩驱动 src/combobox.js：挂载、选项填充、输入过滤、
 * 点击选中派发 change、100 项上限截断、键盘导航。
 * 运行：node -e "require('./test/combobox.js')"
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
function mkEl(id, classes) {
  var el = {
    id: id || '', className: '', type: '', value: '', placeholder: '', hidden: false,
    autocomplete: '', spellcheck: false, scrollIntoView: function () {},
    classList: mkClassList(classes),
    children: [],
    _listeners: {},
    _attrs: {},
    addEventListener: function (type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    dispatchEvent: function (ev) { (this._listeners[ev.type] || []).forEach(function (f) { f(ev || {}); }); },
    dispatch: function (type, ev) { (this._listeners[type] || []).forEach(function (f) { f(ev || {}); }); },
    appendChild: function (el2) { this.children.push(el2); },
    setAttribute: function (k, v) { this._attrs[k] = v; },
    getAttribute: function (k) { return k in this._attrs ? this._attrs[k] : null; },
    select: function () {},
    remove: function () {}
  };
  // textContent 赋值同时清空 children，保证重渲染后 children 反映最新结构
  Object.defineProperty(el, 'textContent', {
    get: function () { return this._text || ''; },
    set: function (v) { this._text = v; this.children.length = 0; }
  });
  return el;
}

var passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + (e && e.stack || e)); }
}

var sandbox = {
  console: console,
  document: {
    createElement: function (tag) { return mkEl('created-' + tag); }
  },
  CustomEvent: (typeof CustomEvent !== 'undefined') ? CustomEvent : undefined,
  setTimeout: setTimeout, clearTimeout: clearTimeout
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/combobox.js'), 'utf8'), sandbox, { filename: 'combobox.js' });
var Combobox = sandbox.Combobox;

function makeHost(ph) {
  var h = mkEl('dirSel', ['cb']);
  if (ph) h.setAttribute('data-placeholder', ph);
  return h;
}
function fire(el, type, ev) { (el._listeners[type] || []).forEach(function (f) { f(ev || {}); }); }
function inputOf(h) { return h.children[0]; }
function rowsOf(h) { return h.children[1].children; }

console.log('combobox\n');

check('attach 生成 input + list 并返回 true', function () {
  var h = makeHost('搜索…');
  if (Combobox.attach(h) !== true) throw new Error('attach 应返回 true');
  if (h.children.length !== 2) throw new Error('应有 input + list，实际 ' + h.children.length);
  var inp = inputOf(h);
  if (!inp) throw new Error('缺 input');
  if (inp.placeholder !== '搜索…') throw new Error('placeholder 应来自 data-placeholder，实际 ' + inp.placeholder);
});

check('重复 attach 返回 false', function () {
  var h = makeHost();
  Combobox.attach(h);
  if (Combobox.attach(h) !== false) throw new Error('重复挂载应返回 false');
});

check('_setOpts 后 value 读写、options 与输入框显示', function () {
  var h = makeHost();
  Combobox.attach(h);
  var inp = inputOf(h);
  h._setOpts([{ value: 'a/1.txt', label: '1.txt' }, { value: 'a/2.txt', label: '2.txt' }]);
  h.value = 'a/2.txt';
  if (h.value !== 'a/2.txt') throw new Error('value 读取应为 a/2.txt，实际 ' + h.value);
  if (inp.value !== '2.txt') throw new Error('输入框应显示 label 2.txt，实际 ' + inp.value);
  if (!h.options || h.options.length !== 2) throw new Error('options 应暴露 2 项');
  h.value = '';
  if (inp.value !== '') throw new Error('清空后输入框应为空');
});

check('输入过滤 + 点击选中派发 change', function () {
  var h = makeHost();
  Combobox.attach(h);
  var changed = [];
  h.addEventListener('change', function () { changed.push(h.value); });
  h._setOpts([
    { value: 'p/a.txt', label: 'a.txt' },
    { value: 'p/bbb.txt', label: 'bbb.txt' },
    { value: 'p/c-dir/x.txt', label: 'x.txt' }
  ]);
  var inp = inputOf(h);
  fire(inp, 'focus');            // 弹开列表
  inp.value = 'a.txt';
  fire(inp, 'input');            // 过滤
  var rows = rowsOf(h);
  if (rows.length !== 1 || rows[0].textContent !== 'a.txt') {
    throw new Error('过滤 a.txt 应只剩 1 项，实际 ' + rows.map(function (r) { return r.textContent; }).join(','));
  }
  fire(rows[0], 'click');        // 选中
  if (h.value !== 'p/a.txt') throw new Error('选中后 value 应为 p/a.txt，实际 ' + h.value);
  if (changed.length !== 1) throw new Error('应派发一次 change，实际 ' + changed.length);
  if (inp.value !== 'a.txt') throw new Error('选中后输入框应显示 a.txt，实际 ' + inp.value);
});

check('按完整路径过滤（value 匹配）', function () {
  var h = makeHost();
  Combobox.attach(h);
  h._setOpts([{ value: '/root/子夹/报告.pdf', label: '报告.pdf' }, { value: '/root/其他/a.txt', label: 'a.txt' }]);
  var inp = inputOf(h);
  fire(inp, 'focus');
  inp.value = '子夹';
  fire(inp, 'input');
  var rows = rowsOf(h);
  if (rows.length !== 1 || rows[0].textContent !== '报告.pdf') throw new Error('按路径过滤应命中 报告.pdf');
});

check('无匹配显示提示行', function () {
  var h = makeHost();
  Combobox.attach(h);
  h._setOpts([{ value: 'a.txt', label: 'a.txt' }]);
  var inp = inputOf(h);
  fire(inp, 'focus');
  inp.value = 'zzz';
  fire(inp, 'input');
  var rows = rowsOf(h);
  if (rows.length !== 1 || rows[0].className !== 'cb-empty') throw new Error('应显示无匹配项提示');
});

check('空查询渲染被 100 项上限截断并提示', function () {
  var h = makeHost();
  Combobox.attach(h);
  var items = [];
  for (var i = 0; i < 150; i++) items.push({ value: 'v' + i, label: '项' + i });
  h._setOpts(items);
  var inp = inputOf(h);
  fire(inp, 'focus');
  var rows = rowsOf(h);
  if (rows.length !== 101) throw new Error('应渲染 100 项 + 1 提示行，实际 ' + rows.length);
  var more = rows[rows.length - 1];
  if (more.className !== 'cb-more') throw new Error('末行应为 cb-more 提示行');
});

check('键盘 ↑/↓/Enter 选中', function () {
  var h = makeHost();
  Combobox.attach(h);
  var changed = [];
  h.addEventListener('change', function () { changed.push(h.value); });
  h._setOpts([{ value: 'x/1.txt', label: '1.txt' }, { value: 'x/2.txt', label: '2.txt' }]);
  var inp = inputOf(h);
  fire(inp, 'focus');
  var rows = rowsOf(h);
  if (!rows[0].classList.contains('active')) throw new Error('默认高亮第一项');
  fire(inp, 'keydown', { key: 'ArrowDown', preventDefault: function () {} });
  if (!rows[1].classList.contains('active')) throw new Error('↓ 应高亮第二项');
  fire(inp, 'keydown', { key: 'Enter', preventDefault: function () {} });
  if (h.value !== 'x/2.txt') throw new Error('Enter 应选中高亮项，实际 ' + h.value);
  if (changed.length !== 1) throw new Error('应派发 change');
});

check('Esc 关闭并恢复输入框显示', function () {
  var h = makeHost();
  Combobox.attach(h);
  h._setOpts([{ value: 'x/1.txt', label: '1.txt' }]);
  var inp = inputOf(h);
  h.value = 'x/1.txt';
  fire(inp, 'focus');
  inp.value = 'zzz';
  fire(inp, 'input');
  fire(inp, 'keydown', { key: 'Escape', preventDefault: function () {} });
  if (inp.value !== '1.txt') throw new Error('Esc 后输入框应恢复选中 label，实际 ' + inp.value);
  if (h.children[1].hidden !== true) throw new Error('Esc 应关闭列表');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
