'use strict';
/**
 * 复现：多页 PDF，在 collectItems（文本收集）未完成时快速切换 4 种视图，检查是否变空白。
 * 用真实 pdf.js + Proxy 桩 canvas 跑 pdfview.js。
 * 运行：node test/pdf-multipage-switch.js
 */
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var pdfjs = require('../lib/pdf.min.js');
pdfjs.GlobalWorkerOptions.workerSrc = path.join(__dirname, '../lib/pdf.worker.min.js');

// 构造 N 页 PDF
function buildPdf(n) {
  var objs = ['%PDF-1.4\n'];
  objs.push('1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n');
  var kids = [];
  for (var i = 0; i < n; i++) kids.push((3 + i) + ' 0 R');
  objs.push('2 0 obj << /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + n + ' >> endobj\n');
  for (var p = 0; p < n; p++) {
    objs.push((3 + p) + ' 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ' + (3 + n) + ' 0 R >> >> /Contents ' + (4 + n + p) + ' 0 R >> endobj\n');
  }
  objs.push((3 + n) + ' 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n');
  for (var c = 0; c < n; c++) {
    var st = 'BT /F1 24 Tf 72 700 Td (Page ' + (c + 1) + ' text) Tj ET\n';
    var len = st.length;
    objs.push((4 + n + c) + ' 0 obj << /Length ' + len + ' >> stream\n' + st + 'endstream endobj\n');
  }
  var offs = [];
  var x = 0;
  var lines = objs.join('');
  // xref 用近似偏移即可（pdf.js 能容忍不精确的 startxref）
  objs.push('xref\n0 ' + (5 + n) + '\n0000000000 65535 f \n');
  for (var k = 0; k < 4 + n; k++) objs.push('0000000009 00000 n \n');
  objs.push('trailer << /Size ' + (5 + n) + ' /Root 1 0 R >>\nstartxref\n9\n%%EOF\n');
  return Buffer.from(objs.join(''), 'latin1');
}

function mkCanvas() {
  var ops = 0;
  var ID = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  var ctx = new Proxy({}, {
    get: function (t, prop) {
      if (prop === '_ops') return ops;
      if (prop === 'getTransform') return function () { return ID; };
      if (typeof prop === 'symbol') return undefined;
      return function () { ops++; };
    },
    set: function () { return true; }
  });
  Object.defineProperty(ctx, '_ops', { get: function () { return ops; } });
  return {
    width: 0, height: 0, style: {},
    getContext: function (type) { return type === '2d' ? ctx : null; },
    _drawOps: function () { return ops; }
  };
}

var els = {};
function mkEl(id) {
  var el = {
    id: id, className: '', style: {}, children: [],
    _pageNum: undefined, _hlLayer: null, clientWidth: 800, clientHeight: 600,
    appendChild: function (c) { this.children.push(c); },
    remove: function () {},
    innerHTML: ''
  };
  Object.defineProperty(el, 'innerHTML', {
    get: function () { return this._html || ''; },
    set: function (v) { this._html = v; this.children.length = 0; }
  });
  return el;
}
function flat(el, acc) {
  acc = acc || [];
  if (!el.children) return acc;
  for (var i = 0; i < el.children.length; i++) { acc.push(el.children[i]); flat(el.children[i], acc); }
  return acc;
}

var sandbox = {
  console: console,
  document: {
    body: { appendChild: function () {} },
    getElementById: function (id) { return els[id] || (els[id] = mkEl(id)); },
    createElement: function (tag) { return tag === 'canvas' ? mkCanvas() : mkEl(tag); },
    addEventListener: function () {}, removeEventListener: function () {}
  },
  self: undefined, window: undefined,
  pdfjsLib: pdfjs,
  setTimeout: setTimeout, clearTimeout: clearTimeout
};
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/pdfview.js'), 'utf8'), sandbox, { filename: 'pdfview.js' });
var PdfView = sandbox.PdfView;

function panelEl(side) { return sandbox.document.getElementById(side === 'L' ? 'pdfLeft' : 'pdfRight'); }
function canvases(side) { return flat(panelEl(side)).filter(function (e) { return e._drawOps; }); }
function drawnPages(side) {
  var n = 0;
  canvases(side).forEach(function (c) { if (c._drawOps() > 0) n++; });
  return n;
}

PdfView.init({ left: panelEl('L'), right: panelEl('R') });

var N = 25;
var url = { data: new Uint8Array(buildPdf(N)) };
var started = Date.now();

PdfView.load('L', url).then(function () {
  // 立即（不等渲染完成）连续快速切换 4 种视图，模拟 collectItems 尚未完成
  var MODES = ['auto', 'width', 'page', 'actual', 'auto', 'width', 'page', 'actual'];
  MODES.forEach(function (m) { PdfView.setMode(m); });
  // 再等所有渲染稳定
  return new Promise(function (res) {
    (function tick() {
      var c = canvases('L');
      var done = c.length >= N && drawnPages('L') >= N;
      if (done || Date.now() - started > 30000) return res();
      setTimeout(tick, 50);
    })();
  });
}).then(function () {
  var total = canvases('L').length;
  var drawn = drawnPages('L');
  console.log('总 canvas=' + total + ' 已绘制=' + drawn + ' (期望 ' + N + ')');
  if (total !== N || drawn !== N) {
    console.log('FAIL  切换后有页面空白：canvas=' + total + ' 绘制=' + drawn);
    process.exitCode = 1;
  } else {
    console.log('  ok  快速切换 4 种视图后所有页面仍可见');
  }
  process.exit(process.exitCode || 0);
}).catch(function (e) {
  console.log('FAIL  ' + (e && e.message));
  process.exit(1);
});
