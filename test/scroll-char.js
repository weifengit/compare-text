/**
 * scroll-char.js — 字符级协同滚动（worklist 192）：6 区协同在默认“忽略换行”（flow）下
 * 也按字符级对齐，而非降级为比例同步。
 * 构造与 e2e-scroll-anchor 相同的场景：左 80 行 / 右 85 行（中段插 10 删 5），
 * 用 vm 沙箱走真实 app.js 的 crossTranslate（经 SyncScroll 驱动）：
 *   ① 滚左到行 60 → 右应到行 65（字符级互译，不是比例）；
 *   ② 滚右到行 40 → 左应到行 30。
 * 同时直接校验 Compute.buildCharAnchors 的锚表一致性。
 * 运行：node test/scroll-char.js
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
['normalize', 'compute', 'source-api', 'picker', 'filterbar', 'pdfview', 'docxview', 'syncscroll', 'tabs', 'pipeline', 'app'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/' + f + '.js'), 'utf8'), sandbox, { filename: f + '.js' });
});
var Compute = sandbox.Compute;

var passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ok  ' + name + (extra ? '（' + extra + '）' : '')); }
  else { failed++; console.log('FAIL  ' + name + (extra ? '：' + extra : '')); }
}
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// 与 e2e-scroll-anchor 相同的夹具：左 80 行；右 85 行（行20后插10、删左 46–50 行）
function linesL() {
  var a = [];
  for (var i = 1; i <= 80; i++) a.push('Line ' + ('00' + i).slice(-3) + ' shared content alpha beta');
  return a.join('\n');
}
function linesR() {
  var l = [];
  for (var i = 1; i <= 80; i++) l.push('Line ' + ('00' + i).slice(-3) + ' shared content alpha beta');
  var extra = [];
  for (var k = 1; k <= 10; k++) extra.push('Inserted extra line ' + k + ' of ten');
  return l.slice(0, 20).concat(extra).concat(l.slice(20, 45)).concat(l.slice(50)).join('\n');
}
function rightLineOf(l) { return l <= 20 ? l : l <= 45 ? l + 10 : l + 5; }

// 简易行坐标系适配器（1 行 = 20px），space:'text' → 走编辑区字符级互译路径
function lineAdapter(side) {
  var H = 20;
  return {
    side: side, space: 'text',
    lineAt: function (px) { return Math.floor(px / H) + 1; },
    offsetOf: function (line) { return Math.max(0, Math.round(line - 1) * H); },
    lineH: function () { return H; }
  };
}

var TL = linesL(), TR = linesR();

// ① 直接校验锚表：行结构化内容行级锚表应精确（左60→右65、左40→右50），
//    字符级锚表作为段落重排时的兜底也应存在。
var anchors = Compute.buildAnchors(TL, TR, { ignoreNewline: true });
function interp(arr, x) {
  if (!arr || !arr.length) return null;
  var lo = 0, hi = arr.length - 1;
  while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (arr[mid][0] <= x) lo = mid; else hi = mid - 1; }
  return arr[lo][1] + (x - arr[lo][0]);
}
function lineOf(l2r, n) { return Math.round(interp(l2r, n)); }
check('行级锚表：左行60 → 右行65', lineOf(anchors.line.l2r, 60) === 65, '实际 60→' + lineOf(anchors.line.l2r, 60));
check('行级锚表：左行40 → 右行50', lineOf(anchors.line.l2r, 40) === 50, '实际 40→' + lineOf(anchors.line.l2r, 40));
check('行级锚表覆盖高（>0.8）', anchors.line.coverage > 0.8, 'coverage=' + anchors.line.coverage.toFixed(3));
check('字符级锚表存在（重排兜底）', !!(anchors.char && anchors.char.l2r.length > 0));

// ② 走真实链路：flow 对比 → crossTranslate（编辑区字符级）→ SyncScroll 驱动
function driveCompare() {
  editors[0].setValue(TL);
  editors[1].setValue(TR);
  editors[0].fire('change');
  editors[1].fire('change');
  return wait(500).then(function () {
    var last = posted[posted.length - 1];
    if (!last) throw new Error('防抖后应已向 worker 发送对比请求');
    var res = Compute.computeDiff(last.payload);
    res._options = last.payload.options;
    workers[0].onmessage({ data: { id: last.id, result: res } });
    return res;
  });
}

driveCompare().then(function (res) {
  if (res.mode !== 'flow') throw new Error('默认忽略换行应为 flow 模式，实际 ' + res.mode);
  if (!res.charAnchors) throw new Error('flow 结果应携带 charAnchors');

  var Sync = sandbox.SyncScroll;
  var mL = mkEl('mockL'), mR = mkEl('mockR');
  mL.scrollHeight = 5000; mL.clientHeight = 100;
  mR.scrollHeight = 5000; mR.clientHeight = 100;
  Sync.setAdapter(mL, lineAdapter('L'));
  Sync.setAdapter(mR, lineAdapter('R'));
  Sync.rebind([mL, mR]);

  mL.scrollTop = (60 - 1) * 20;              // 左行 60
  mL.dispatch('scroll');
  return wait(300).then(function () {
    var gotR = Math.round(mR.scrollTop / 20) + 1;
    check('滚动左→右 字符级对齐到行65（flow 非比例）', gotR === 65, '左60→右' + gotR + '（期望 65）');
    mR.scrollTop = (40 - 1) * 20;            // 右行 40
    mR.dispatch('scroll');
    return wait(300);
  }).then(function () {
    var gotL = Math.round(mL.scrollTop / 20) + 1;
    check('滚动右→左 字符级对齐到行30', gotL === 30, '右40→左' + gotL + '（期望 30）');
  });
}).then(function () {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}).catch(function (e) {
  console.log('FAIL  ' + (e && e.message));
  process.exit(1);
});
