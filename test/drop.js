/**
 * drop.js — 拖入文件对比（src/local-file.js + src/dropzone.js + source-api 的钩子）。
 * 运行：node test/drop.js
 *
 * 这条链路要证的是三个"接口处"，而不是某个函数自洽：
 *   ① 拖入的 File 没有磁盘路径，但必须能和磁盘文件一样被装载 —— LocalFile 登记成引用，
 *      Source.fileUrl / readBytes 认出引用并给 Blob URL（且不能去请求 /api/file）；
 *   ② 落点判定：压在某侧文件框上算该侧，否则算主区域左右半区；
 *   ③ 一次拖两个文件不猜落点：第 1 个原文、第 2 个修改后，三个以上只取前两个并提示。
 * 另外覆盖桌面端那条原生通路（Tauri 物理像素 → CSS 像素、真实路径）。
 */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var passed = 0, failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL  ' + name + '\n      ' + (e && e.message));
  }
}
async function acheck(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL  ' + name + '\n      ' + (e && e.message));
  }
}

// ---------- DOM 桩（够 dropzone 与遮罩用；遮罩本身是普通 div）----------

function mkClassList() {
  var s = [];
  return {
    add: function (c) { if (s.indexOf(c) === -1) s.push(c); },
    remove: function (c) { var i = s.indexOf(c); if (i !== -1) s.splice(i, 1); },
    contains: function (c) { return s.indexOf(c) !== -1; },
    toggle: function (c, force) {
      var on = force === undefined ? s.indexOf(c) === -1 : !!force;
      if (on) { if (s.indexOf(c) === -1) s.push(c); }
      else { var i = s.indexOf(c); if (i !== -1) s.splice(i, 1); }
      return on;
    }
  };
}

function mkEl(tag, attrs) {
  var el = {
    tagName: tag, className: '', hidden: false, textContent: '', children: [], parentNode: null,
    _attrs: attrs || {}, classList: mkClassList(),
    setAttribute: function (k, v) { this._attrs[k] = v; },
    getAttribute: function (k) { return k in this._attrs ? this._attrs[k] : null; },
    appendChild: function (c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild: function (c) {
      var i = this.children.indexOf(c);
      if (i !== -1) this.children.splice(i, 1);
      c.parentNode = null;
    }
  };
  return el;
}

var byId = {};
var hitEl = null;                      // elementFromPoint 的返回值（模拟指针下的元素）
var doc = {
  body: mkEl('body'),
  createElement: function (tag) { return mkEl(tag); },
  getElementById: function (id) { return byId[id] || null; },
  elementFromPoint: function () { return hitEl; }
};

var listeners = {};
function on(type, fn) { (listeners[type] = listeners[type] || []).push(fn); }
function off(type, fn) {
  var l = listeners[type] || [];
  var i = l.indexOf(fn);
  if (i !== -1) l.splice(i, 1);
}
function fire(type, ev) { (listeners[type] || []).slice().forEach(function (f) { f(ev); }); }

var fetchCalls = [];
var sandbox = {
  console: console,
  document: doc,
  Blob: Blob, File: File, URL: URL,
  fetch: function (url) {
    fetchCalls.push(String(url));
    return fetch(url);
  },
  devicePixelRatio: 1,
  addEventListener: on,
  removeEventListener: off,
  setTimeout: setTimeout
};
sandbox.window = sandbox;
vm.createContext(sandbox);

/** 与 index.html 相同的顺序（只装本次要测的两个模块） */
function load(file) {
  return vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8'),
    sandbox, { filename: file });
}
load('local-file.js');
load('source-api.js');
load('dropzone.js');

var LocalFile = sandbox.LocalFile;
var SourceApi = sandbox.Source;
var DropZone = sandbox.DropZone;

function mkFile(name, text) { return new File([text], name, { type: 'text/plain' }); }

function dragEvent(files, x, y) {
  var ev = {
    dataTransfer: { types: ['Files'], files: files, dropEffect: '' },
    clientX: x, clientY: y, defaultPrevented: false,
    preventDefault: function () { this.defaultPrevented = true; }
  };
  return ev;
}

console.log('drop tests\n');

// ---------- ① LocalFile：File → 可装载的引用 ----------

check('1-1. 引用保留原文件名与扩展名，且带自增号互不顶替', function () {
  var a = LocalFile.refFor(mkFile('报告 v1.txt', 'x'));
  var b = LocalFile.refFor(mkFile('报告 v1.txt', 'y'));
  assert.ok(/^blobdrop\/\d+\/报告 v1\.txt$/.test(a), '引用格式应为 blobdrop/<号>/<文件名>，实际 ' + a);
  assert.notStrictEqual(a, b, '同名文件也应得到不同引用');
  assert.strictEqual(LocalFile.name(a), '报告 v1.txt');
  assert.ok(LocalFile.isRef(a), 'isRef 应认出自己发出的引用');
});

check('1-2. 非引用（磁盘路径 / 网址）一律不认', function () {
  assert.strictEqual(LocalFile.isRef('/tmp/报告.txt'), false);
  assert.strictEqual(LocalFile.isRef('https://example.com/a.txt'), false);
  assert.strictEqual(LocalFile.url('/tmp/报告.txt'), '', '未登记过的路径不应凭空给出 URL');
  assert.strictEqual(LocalFile.file('/tmp/报告.txt'), null);
});

check('1-3. url() 给出 blob: URL 并缓存（拖动多次不重复建对象）', function () {
  var ref = LocalFile.refFor(mkFile('a.txt', 'hello'));
  var u1 = LocalFile.url(ref);
  var u2 = LocalFile.url(ref);
  assert.ok(/^blob:/.test(u1), '应为 blob: URL，实际 ' + u1);
  assert.strictEqual(u1, u2, '同一引用的 URL 应缓存');
  assert.strictEqual(LocalFile.file(ref).name, 'a.txt');
});

// ---------- ② source-api 的钩子：拖入文件与磁盘文件同一条下游 ----------

(async function main() {
  await acheck('2-1. Source.fileUrl 对引用给 Blob URL，不去请求 /api/file', async function () {
    var ref = LocalFile.refFor(mkFile('b.txt', 'hi'));
    fetchCalls.length = 0;
    var url = await SourceApi.fileUrl(ref);
    assert.ok(/^blob:/.test(url), '引用应解析成 blob: URL，实际 ' + url);
    assert.deepStrictEqual(fetchCalls, [], '取 URL 不该产生任何网络请求');
  });

  await acheck('2-2. Source.fileUrl 对普通磁盘路径行为不变（仍走 /api/file）', async function () {
    var url = await SourceApi.fileUrl('/tmp/磁盘文件.txt');
    assert.strictEqual(url, '/api/file?path=' + encodeURIComponent('/tmp/磁盘文件.txt'));
  });

  await acheck('2-3. Source.readBytes 对引用能读出真实字节（Excel 对比读表走它）', async function () {
    var ref = LocalFile.refFor(mkFile('表.csv', '列A,列B\n1,2\n'));
    var buf = await SourceApi.readBytes(ref);
    var text = Buffer.from(new Uint8Array(buf)).toString('utf8');
    assert.strictEqual(text, '列A,列B\n1,2\n');
  });

  // ---------- ③ 落点判定 ----------

  check('3-1. 压在某侧文件框上 → 该侧（含祖先链查找）', function () {
    var labelR = mkEl('label', { 'data-drop-side': 'R' });
    var inner = mkEl('span');
    labelR.appendChild(inner);
    hitEl = inner;
    assert.strictEqual(DropZone.sideAt(100, 100), 'R', '应认出祖先 label 上的 data-drop-side');
  });

  check('3-2. 不在文件框上 → 按主区域左右半区', function () {
    hitEl = null;
    byId.layout = mkEl('div');
    byId.layout.getBoundingClientRect = function () { return { left: 0, width: 1000, top: 0, height: 500 }; };
    assert.strictEqual(DropZone.sideAt(100, 100), 'L');
    assert.strictEqual(DropZone.sideAt(900, 100), 'R');
  });

  // ---------- ④ 派发：几个文件，落到哪几侧 ----------

  var got = [];
  var overflow = 0;
  DropZone.init({
    onDrop: function (items) { got.push(items); },
    onOverflow: function (n) { overflow = n; }
  });

  check('4-1. 拖一个文件 → 按落点落该侧', function () {
    hitEl = null; got = [];
    fire('drop', dragEvent([mkFile('新.txt', 'b')], 900, 300));
    assert.strictEqual(got.length, 1);
    assert.strictEqual(got[0].length, 1);
    assert.strictEqual(got[0][0].side, 'R');
    assert.strictEqual(got[0][0].name, '新.txt');
    assert.ok(got[0][0].file, '浏览器支应带上 File 对象');
  });

  check('4-2. 拖两个文件 → 不猜落点：第 1 个左、第 2 个右', function () {
    got = [];
    fire('drop', dragEvent([mkFile('旧.txt', 'a'), mkFile('新.txt', 'b')], 100, 300));
    assert.strictEqual(got[0].length, 2);
    assert.deepStrictEqual([got[0][0].side, got[0][1].side], ['L', 'R']);
    assert.deepStrictEqual([got[0][0].name, got[0][1].name], ['旧.txt', '新.txt']);
  });

  check('4-3. 拖三个以上 → 只取前两个并提示', function () {
    got = []; overflow = 0;
    fire('drop', dragEvent([mkFile('1.txt', 'a'), mkFile('2.txt', 'b'), mkFile('3.txt', 'c')], 100, 300));
    assert.strictEqual(got[0].length, 2, '只应派发两个');
    assert.strictEqual(overflow, 3, '应回调实际拖入数量');
  });

  check('4-4. 编辑器内拖文字（非文件）不接管', function () {
    got = [];
    var ev = dragEvent([], 900, 300);
    ev.dataTransfer.types = ['text/plain'];
    fire('dragover', ev);
    fire('drop', ev);
    assert.strictEqual(got.length, 0, '非文件拖拽不应触发装载');
    assert.ok(doc.body.children.indexOf(maskEl()) === -1 || maskEl().hidden, '遮罩不应显示');
  });

  // ---------- ⑤ 遮罩：告诉用户松手会落到哪 ----------

  function maskEl() {
    for (var i = 0; i < doc.body.children.length; i++) {
      if (doc.body.children[i].className === 'drop-mask') return doc.body.children[i];
    }
    return null;
  }

  check('5-1. 拖一个文件：遮罩亮起目标侧，并写明松手结果', function () {
    hitEl = null;
    fire('dragover', dragEvent([mkFile('报告.txt', 'x')], 900, 300));
    var m = maskEl();
    assert.ok(m, 'dragover 应创建遮罩');
    assert.strictEqual(m.hidden, false, '遮罩应显示');
    assert.strictEqual(m.children[1].classList.contains('on'), true, '右侧应高亮');
    assert.strictEqual(m.children[0].classList.contains('on'), false, '左侧不应高亮');
    assert.ok(m._hint.textContent.indexOf('修改后') >= 0, '提示应写明落到修改后：' + m._hint.textContent);
  });

  check('5-2. 拖两个文件：两侧同时亮，提示成对', function () {
    fire('dragover', dragEvent([mkFile('旧.txt', 'a'), mkFile('新.txt', 'b')], 100, 300));
    var m = maskEl();
    assert.strictEqual(m.children[0].classList.contains('on'), true);
    assert.strictEqual(m.children[1].classList.contains('on'), true);
    assert.ok(m._hint.textContent.indexOf('旧.txt') >= 0 && m._hint.textContent.indexOf('新.txt') >= 0,
      '提示应带上两个文件名：' + m._hint.textContent);
  });

  check('5-3. 拖出窗口 / 拖拽结束：遮罩收起', function () {
    var ev = dragEvent([mkFile('a.txt', 'a')], 100, 300);
    fire('dragenter', ev);
    fire('dragleave', ev);
    assert.strictEqual(maskEl().hidden, true, 'dragleave 后应收起');
    fire('dragover', dragEvent([mkFile('a.txt', 'a')], 100, 300));
    fire('dragend', {});
    assert.strictEqual(maskEl().hidden, true, 'dragend 后应收起');
  });

  check('5-4. 拖出窗口（relatedTarget 为 null）→ 立即收起，不等计数配平', function () {
    fire('dragenter', dragEvent([mkFile('a.txt', 'a')], 100, 300));
    fire('dragenter', dragEvent([mkFile('a.txt', 'a')], 120, 300));
    fire('dragenter', dragEvent([mkFile('a.txt', 'a')], 140, 300));
    assert.strictEqual(maskEl().hidden, false, '多次 dragenter 后遮罩应还在');
    var out = dragEvent([mkFile('a.txt', 'a')], -1, -1);
    out.relatedTarget = null;
    fire('dragleave', out);
    assert.strictEqual(maskEl().hidden, true, '拖出窗口应立即收起遮罩');
  });

  // ---------- ⑥ 桌面端：Tauri 原生拖放（真实路径 + 物理像素）----------

  await acheck('6-1. Tauri 原生通路：路径当引用、物理像素折算成 CSS 像素', async function () {
    var nativeHandler = null;
    sandbox.__TAURI__ = {
      webviewWindow: {
        getCurrentWebviewWindow: function () {
          return {
            onDragDropEvent: function (fn) { nativeHandler = fn; return Promise.resolve(function () {}); }
          };
        }
      }
    };
    sandbox.devicePixelRatio = 2;              // 原生给物理像素：x=1800 → CSS 900 → 右半区
    var got2 = [];
    DropZone.destroy();
    DropZone.init({ onDrop: function (items) { got2.push(items); } });
    await Promise.resolve();
    assert.ok(nativeHandler, '应挂上原生拖放监听');

    nativeHandler({ payload: { type: 'enter', paths: ['/Users/me/旧.docx'] } });
    nativeHandler({ payload: { type: 'over', position: { x: 1800, y: 600 } } });
    assert.strictEqual(maskEl().hidden, false, '原生 over 也应显示遮罩');
    assert.strictEqual(maskEl().children[1].classList.contains('on'), true, '应算出右半区');

    nativeHandler({ payload: { type: 'drop', paths: ['/Users/me/旧.docx', '/Users/me/新.docx'],
      position: { x: 1800, y: 600 } } });
    assert.strictEqual(got2.length, 1);
    assert.deepStrictEqual([got2[0][0].side, got2[0][1].side], ['L', 'R']);
    assert.strictEqual(got2[0][0].path, '/Users/me/旧.docx', '桌面端应把真实路径原样抛出');
    assert.strictEqual(got2[0][0].name, '旧.docx');
    assert.strictEqual(maskEl().hidden, true, '落定后应收起遮罩');
    sandbox.devicePixelRatio = 1;
  });

  await acheck('6-2. 没有 Tauri 时不挂原生通路（浏览器模式不受影响）', async function () {
    delete sandbox.__TAURI__;
    DropZone.destroy();
    DropZone.init({ onDrop: function () {} });
    assert.strictEqual(maskEl(), null, 'destroy 应把遮罩一并摘掉');
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
