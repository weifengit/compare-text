/**
 * web-entry.js — 网址能不能直接粘进「原始文件 / 修改文件」输入框。
 *
 * 这两条是上一版被否掉的设计留下的缺口：
 *   ① 网页对比曾是顶部一个独立按钮 + 弹层（选侧、填容器 id、勾内联），
 *      每换一次地址就要重新开弹窗；现在并进文件框，换址只是改一次输入。
 *   ② 文件框只能整体子串匹配，文件名带“品种 + 产地 + 标准类型”时，
 *      用户记得住的是零散关键词，所以改成空格分词的 AND 匹配 + 回车直选。
 *
 * 这里用真实 filterbar + combobox + pipeline，把「输入 → 过滤 → 回车 → 落到哪侧」整条链走一遍，
 * 不桩掉任何一环；只在 Pipeline 出口装探针，确认真走到了网页分支。
 * 运行：node test/web-entry.js
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
    autocomplete: '', spellcheck: false,
    classList: mkClassList(classes),
    children: [], _listeners: {}, _attrs: {},
    addEventListener: function (t, f) { (this._listeners[t] = this._listeners[t] || []).push(f); },
    dispatchEvent: function (ev) { (this._listeners[ev.type] || []).forEach(function (f) { f(ev || {}); }); },
    dispatch: function (t, ev) { (this._listeners[t] || []).forEach(function (f) { f(ev || {}); }); },
    appendChild: function (e) { this.children.push(e); },
    setAttribute: function (k, v) { this._attrs[k] = v; },
    getAttribute: function (k) { return k in this._attrs ? this._attrs[k] : null; },
    select: function () {}, remove: function () {}, scrollIntoView: function () {}
  };
  Object.defineProperty(el, 'textContent', {
    get: function () { return this._text || ''; },
    set: function (v) { this._text = v; this.children.length = 0; }
  });
  Object.defineProperty(el, 'innerHTML', {
    get: function () { return this._html || ''; },
    set: function (v) { this._html = v; this.children.length = 0; }
  });
  return el;
}

var els = {};
var loads = [];          // Pipeline.loadSide 出口探针
var sandbox = {
  console: console,
  document: {
    body: { appendChild: function () {} },
    getElementById: function (id) { return els[id] || (els[id] = mkEl(id)); },
    createElement: function (tag) { return mkEl('created-' + tag); },
    addEventListener: function () {}, removeEventListener: function () {}
  },
  CustomEvent: (typeof CustomEvent !== 'undefined') ? CustomEvent : undefined,
  setTimeout: setTimeout, clearTimeout: clearTimeout,
  Source: {
    list: function (dir) {
      return Promise.resolve({
        dirs: ['子文件夹1'],
        files: [
          { name: '1：当归药材上海标准.docx', size: 1, ext: 'docx' },
          { name: '2：酒当归药材湖南标准.docx', size: 1, ext: 'docx' },
          { name: '3：当归药材上海团标.docx', size: 1, ext: 'docx' }
        ]
      });
    },
    fileUrl: function (p) { return Promise.resolve('/api/file?path=' + encodeURIComponent(p)); }
  },
  // 真 pipeline 会用到 WebView/WebStyle；web-entry 只验证“路由到网页分支”，
  // 这两个查看器由 test/e2e-webview.js 在真浏览器里验，这里给最小桩即可。
  WebView: { load: function () { return Promise.resolve(); }, clear: function () {} },
  WebStyle: { htmlVectors: function () { return []; }, vectorsText: function () { return ''; } },
  Promise: Promise,
  URL: URL, TextDecoder: TextDecoder
};
sandbox.self = sandbox;
vm.createContext(sandbox);

['normalize', 'compute', 'combobox', 'filterbar'].forEach(function (m) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/' + m + '.js'), 'utf8'),
    sandbox, { filename: m + '.js' });
});

var Combobox = sandbox.Combobox;
var FilterBar = sandbox.FilterBar;

// 装探针：Pipeline 在 filterbar 里并不直接调用（由 app 的 onFileChange 承接），
// 所以这里只需断言 filterbar 把 change 正确派发出来、值就是网址。
var changes = [];
var L = (els['fileSelL'] = els['fileSelL'] || mkEl('fileSelL', ['cb']));
var R = (els['fileSelR'] = els['fileSelR'] || mkEl('fileSelR', ['cb']));
var dir = (els['dirSel'] = els['dirSel'] || mkEl('dirSel', ['cb']));

FilterBar.init({
  getRoot: function () { return '/tmp/对比源'; },
  onFileChange: function (side, absPath) { changes.push({ side: side, ref: absPath }); },
  onFieldPick: function () {},
  onDirChange: function () {}
});

// init 不自动拉列表（app 在侧边栏设好对比源后才调 reload），测试也得显式跟一遍
FilterBar.reload();

var passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + (e && e.message)); }
}
function fire(el, type, ev) { (el._listeners[type] || []).forEach(function (f) { f(ev || {}); }); }
function findByClass(el, cls) {
  if (!el) return null;
  if (el.className === cls) return el;
  var kids = el.children || [];
  for (var i = 0; i < kids.length; i++) {
    var hit = findByClass(kids[i], cls);
    if (hit) return hit;
  }
  return null;
}
// 输入框与列表按 class 找（文件框是胶囊模式：input 被包在 .cb-box 里，不能按 children 下标取）
function inputOf(h) { return findByClass(h, 'cb-input'); }
function rowsOf(h) { var l = findByClass(h, 'cb-list'); return l ? l.children : []; }
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

console.log('web entry / 文件框即网址入口\n');

check('两个文件框都挂上了自由文本判定', function () {
  if (typeof L._setFreeText !== 'function') throw new Error('左侧文件框应支持自由文本');
  if (typeof R._setFreeText !== 'function') throw new Error('右侧文件框应支持自由文本');
  if (!L._freeText) throw new Error('左侧文件框应已注入 freeTextRef');
});

check('freeTextRef 认网址与快照路径，不认普通文件', function () {
  var f = FilterBar.freeTextRef;
  if (f('https://gdidc.gd.gov.cn/zwfw/x.html') !== 'https://gdidc.gd.gov.cn/zwfw/x.html') {
    throw new Error('https 网址应原样返回');
  }
  if (f('//gdidc.gd.gov.cn/x.html') !== 'https://gdidc.gd.gov.cn/x.html') {
    throw new Error('协议相对 // 应补成 https');
  }
  if (f('/tmp/快照.html') !== '/tmp/快照.html') throw new Error('本地 .html 绝对路径应认');
  if (f('/tmp/a.docx') !== '') throw new Error('普通文件路径不应被当成网页源');
  if (f('随便写的词') !== '') throw new Error('散词不应被当成网页源');
});

check('顶部不再有独立的「网页对比」按钮（已并入文件框）', function () {
  var html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  if (html.indexOf('id="webBtn"') >= 0) throw new Error('index.html 不应再有 webBtn');
  if (html.indexOf('id="webMask"') >= 0) throw new Error('index.html 不应再有网页弹层');
  if (html.indexOf('id="webUrl"') >= 0) throw new Error('index.html 不应再有独立地址输入框');
  if (html.indexOf('src/webview.js') < 0) throw new Error('webview.js 仍应被引入');
});

wait(60).then(function () {
  check('文件列表加载完成后仍不自动选中（保持既有行为）', function () {
    if (L.value !== '' || R.value !== '') {
      throw new Error('不应自动选中文件，实际 L=' + L.value + ' R=' + R.value);
    }
  });

  check('空格分词：只输“上海”命中 2 份', function () {
    var inp = inputOf(L);
    fire(inp, 'focus');
    inp.value = '上海';
    fire(inp, 'input');
    if (rowsOf(L).length !== 2) throw new Error('应命中 2 项，实际 ' + rowsOf(L).length);
  });

  check('空格分词：输“上海 团”命中 1 份（词序/连续性都无关）', function () {
    var inp = inputOf(L);
    inp.value = '上海 团';
    fire(inp, 'input');
    var rows = rowsOf(L);
    if (rows.length !== 1) throw new Error('应命中 1 项，实际 ' + rows.length);
    if (rows[0].textContent.indexOf('团标') === -1) throw new Error('应命中“团标”那份，实际 ' + rows[0].textContent);
  });

  check('回车直选：不点鼠标也能选中所选文件并派发 change', function () {
    var before = changes.length;
    var inp = inputOf(L);
    fire(inp, 'keydown', { key: 'Enter', preventDefault: function () {} });
    if (!/团标/.test(L.value)) throw new Error('回车应选中团标那份，实际 ' + L.value);
    if (changes.length !== before + 1) throw new Error('应派发一次 onFileChange');
    if (changes[changes.length - 1].side !== 'L') throw new Error('应落在左侧');
    if (!/团标/.test(changes[changes.length - 1].ref)) throw new Error('onFileChange 应收到该文件绝对路径');
  });

  check('网址：无文件命中时回车把原文当源提交到该侧', function () {
    var before = changes.length;
    var inp = inputOf(R);
    fire(inp, 'focus');
    inp.value = 'https://gdidc.gd.gov.cn/zwfw/dfbz/bz2025/content/post_1.html';
    fire(inp, 'input');
    var rows = rowsOf(R);
    if (rows.length !== 1 || rows[0].className !== 'cb-empty') throw new Error('网址不应命中任何文件');
    fire(inp, 'keydown', { key: 'Enter', preventDefault: function () {} });
    if (R.value !== 'https://gdidc.gd.gov.cn/zwfw/dfbz/bz2025/content/post_1.html') {
      throw new Error('右侧 value 应为网址，实际 ' + R.value);
    }
    if (changes.length !== before + 1) throw new Error('应派发一次 onFileChange');
    if (changes[changes.length - 1].side !== 'R') throw new Error('应落在右侧');
    if (!/^https:/.test(changes[changes.length - 1].ref)) throw new Error('onFileChange 应收到网址');
  });

  check('网址粘进原始文件框：回车后 FilterBar.getSelected 直接给出网址', function () {
    var inp = inputOf(L);
    fire(inp, 'focus');
    inp.value = '//gdidc.gd.gov.cn/x.html';      // 省略协议
    fire(inp, 'input');
    fire(inp, 'keydown', { key: 'Enter', preventDefault: function () {} });
    if (L.value !== 'https://gdidc.gd.gov.cn/x.html') throw new Error('协议相对应补成 https，实际 ' + L.value);
    if (FilterBar.getSelected('L') !== 'https://gdidc.gd.gov.cn/x.html') {
      throw new Error('getSelected 应返回网址，实际 ' + FilterBar.getSelected('L'));
    }
  });

  check('再次切换子文件夹：已输入的网址不被选项重建抹掉', function () {
    dir.value = '/tmp/对比源';
    fire(dir, 'change');
    return wait(60).then(function () {
      if (FilterBar.getSelected('L') !== 'https://gdidc.gd.gov.cn/x.html') {
        throw new Error('选项重建后网址不应丢失，实际 ' + FilterBar.getSelected('L'));
      }
    });
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
});
