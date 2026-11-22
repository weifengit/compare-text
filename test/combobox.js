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
    appendChild: function (el2) { el2.parentNode = this; this.children.push(el2); },
    insertBefore: function (el2, ref) {
      el2.parentNode = this;
      var i = this.children.indexOf(ref);
      if (i < 0) this.children.push(el2); else this.children.splice(i, 0, el2);
    },
    removeChild: function (el2) {
      var i = this.children.indexOf(el2);
      if (i >= 0) { this.children.splice(i, 1); el2.parentNode = null; }
    },
    querySelectorAll: function (sel) {
      var cls = sel.replace(/^\./, '');
      var out = [];
      (function walk(node) {
        var kids = node.children || [];
        for (var i = 0; i < kids.length; i++) {
          if (kids[i].className === cls) out.push(kids[i]);
          walk(kids[i]);
        }
      })(this);
      return out;
    },
    setAttribute: function (k, v) { this._attrs[k] = v; },
    getAttribute: function (k) { return k in this._attrs ? this._attrs[k] : null; },
    select: function () {},
    remove: function () {
      if (this.parentNode && this.parentNode.removeChild) this.parentNode.removeChild(this);
    }
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
// 按 class 找（胶囊模式下 input 被包在 .cb-box 里，不能按 children 下标取）
function inputOf(h) { return findByClass(h, 'cb-input'); }
function rowsOf(h) { var l = findByClass(h, 'cb-list'); return l ? l.children : []; }
function chipsOf(h) { return h.querySelectorAll ? h.querySelectorAll('.cb-chip') : []; }
function chipLabels(h) {
  return chipsOf(h).map(function (c) {
    var lb = c.querySelectorAll('.cb-chip-label')[0];
    return lb ? lb.textContent : '';
  });
}

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

check('空格分词 = 逻辑 AND：多词同时命中才列入', function () {
  var h = makeHost();
  Combobox.attach(h);
  h._setOpts([
    { value: 's/1.docx', label: '1：当归药材上海标准.docx' },
    { value: 's/2.docx', label: '2：酒当归药材湖南标准.docx' },
    { value: 's/3.docx', label: '3：当归药材上海团标.docx' }
  ]);
  var inp = inputOf(h);
  fire(inp, 'focus');
  inp.value = '上海';
  fire(inp, 'input');
  var rows = rowsOf(h);
  if (rows.length !== 2) throw new Error('“上海”应命中 2 项，实际 ' + rows.length);

  inp.value = '上海 团';            // 两个词各自命中即可，不要求连在一起
  fire(inp, 'input');
  rows = rowsOf(h);
  if (rows.length !== 1) throw new Error('“上海 团”应命中 1 项，实际 ' + rows.length);
  if (rows[0].textContent.indexOf('团标') === -1) throw new Error('应命中“团标”那份，实际 ' + rows[0].textContent);

  inp.value = '当归 湖南';          // 词序无关
  fire(inp, 'input');
  rows = rowsOf(h);
  if (rows.length !== 1) throw new Error('“当归 湖南”应命中 1 项，实际 ' + rows.length);

  inp.value = '上海 \u3000 药材';    // 全角空格同样算分隔符
  fire(inp, 'input');
  rows = rowsOf(h);
  if (rows.length !== 2) throw new Error('全角空格应同样分隔，应命中 2 项，实际 ' + rows.length);
});

check('回车：有命中选高亮项，无命中则提交输入原文（网址）', function () {
  var h = makeHost();
  Combobox.attach(h);
  var changed = [];
  h.addEventListener('change', function () { changed.push(h.value); });
  h._setOpts([{ value: 'p/a.docx', label: 'a.docx' }]);
  // 网址是否算合法源由宿主判定（控件不管语义）
  h._setFreeText(function (raw) { return /^https?:/.test(raw) ? raw : ''; });
  var inp = inputOf(h);
  fire(inp, 'focus');
  inp.value = 'https://example.com/x.html';
  fire(inp, 'input');
  var rows = rowsOf(h);
  if (rows.length !== 1 || rows[0].className !== 'cb-empty') throw new Error('网址不应命中任何文件');
  fire(inp, 'keydown', { key: 'Enter', preventDefault: function () {} });
  if (h.value !== 'https://example.com/x.html') throw new Error('回车应提交输入原文，实际 ' + h.value);
  if (changed.length !== 1) throw new Error('应派发一次 change，实际 ' + changed.length);
  if (inp.value !== 'https://example.com/x.html') throw new Error('输入框应保留网址，实际 ' + inp.value);

  // 自由文本要能挺过选项重建（切子文件夹会重建 files 列表）
  h._setOpts([{ value: 'p/b.docx', label: 'b.docx' }]);
  if (h.value !== 'https://example.com/x.html') throw new Error('选项重建后网址不应被抹掉，实际 ' + h.value);
  // 不在选项里、又不合法的文本不当成源
  inp.value = '随便写的词';
  fire(inp, 'focus'); fire(inp, 'input');
  fire(inp, 'keydown', { key: 'Enter', preventDefault: function () {} });
  if (h.value !== 'https://example.com/x.html') throw new Error('非法自由文本不应改变选中值，实际 ' + h.value);
});

// ---------- 胶囊模式（原始文件 / 修改文件：空格把关键词固化成可删除的标签） ----------
function makeChipHost() {
  var h = makeHost('文件 / 网址（空格分词）…');
  Combobox.attach(h, { chips: true });
  return h;
}

check('胶囊模式：按空格把已输入的词固化成胶囊，输入框清空', function () {
  var h = makeChipHost();
  h._setOpts([
    { value: 's/1.docx', label: '1：当归药材上海标准.docx' },
    { value: 's/2.docx', label: '2：酒当归药材湖南标准.docx' },
    { value: 's/3.docx', label: '3：当归药材上海团标.docx' }
  ]);
  var inp = inputOf(h);
  fire(inp, 'focus');
  inp.value = '上海';
  fire(inp, 'input');
  fire(inp, 'keydown', { key: ' ', preventDefault: function () {} });
  var labels = chipLabels(h);
  if (labels.length !== 1 || labels[0] !== '上海') {
    throw new Error('应生成一枚“上海”胶囊，实际 ' + JSON.stringify(labels));
  }
  if (inp.value !== '') throw new Error('固化后输入框应清空，实际 ' + JSON.stringify(inp.value));
});

check('胶囊模式：多枚胶囊一起参与过滤（逻辑 AND）', function () {
  var h = makeChipHost();
  h._setOpts([
    { value: 's/1.docx', label: '1：当归药材上海标准.docx' },
    { value: 's/2.docx', label: '2：酒当归药材湖南标准.docx' },
    { value: 's/3.docx', label: '3：当归药材上海团标.docx' }
  ]);
  var inp = inputOf(h);
  fire(inp, 'focus');
  inp.value = '上海';
  fire(inp, 'input');
  fire(inp, 'keydown', { key: ' ', preventDefault: function () {} });
  inp.value = '团';
  fire(inp, 'input');
  fire(inp, 'keydown', { key: ' ', preventDefault: function () {} });
  var labels = chipLabels(h);
  if (labels.length !== 2 || labels.join(',') !== '上海,团') {
    throw new Error('应有两枚胶囊，实际 ' + JSON.stringify(labels));
  }
  var rows = rowsOf(h);
  if (rows.length !== 1) throw new Error('两枚胶囊应共同过滤出 1 项，实际 ' + rows.length);
  if (rows[0].textContent.indexOf('团标') === -1) {
    throw new Error('应命中“团标”那份，实际 ' + rows[0].textContent);
  }
});

check('胶囊模式：删除按钮能去掉一枚胶囊并重算过滤', function () {
  var h = makeChipHost();
  h._setOpts([
    { value: 's/1.docx', label: '1：当归药材上海标准.docx' },
    { value: 's/2.docx', label: '2：酒当归药材湖南标准.docx' },
    { value: 's/3.docx', label: '3：当归药材上海团标.docx' }
  ]);
  var inp = inputOf(h);
  fire(inp, 'focus');
  inp.value = '上海';
  fire(inp, 'input');
  fire(inp, 'keydown', { key: ' ', preventDefault: function () {} });
  inp.value = '团';
  fire(inp, 'input');
  fire(inp, 'keydown', { key: ' ', preventDefault: function () {} });
  var chips = chipsOf(h);
  var x = chips[0].querySelectorAll('.cb-chip-x')[0];
  if (!x) throw new Error('胶囊应带删除按钮');
  fire(x, 'click');
  var labels = chipLabels(h);
  if (labels.length !== 1 || labels[0] !== '团') {
    throw new Error('删掉第一枚后应只剩“团”，实际 ' + JSON.stringify(labels));
  }
  var rows = rowsOf(h);
  if (rowsOf(h).length !== 1) throw new Error('只剩一枚“团”应命中 1 项（团标那份），实际 ' + rowsOf(h).length);
});

check('胶囊模式：输入框空时按退格删掉最后一枚胶囊', function () {
  var h = makeChipHost();
  h._setOpts([{ value: 's/1.docx', label: '1：上海.docx' }]);
  var inp = inputOf(h);
  fire(inp, 'focus');
  inp.value = '上海';
  fire(inp, 'input');
  fire(inp, 'keydown', { key: ' ', preventDefault: function () {} });
  inp.value = '团';
  fire(inp, 'input');
  fire(inp, 'keydown', { key: ' ', preventDefault: function () {} });
  if (chipLabels(h).length !== 2) throw new Error('应有两枚胶囊');
  inp.value = '';
  fire(inp, 'keydown', { key: 'Backspace', preventDefault: function () {} });
  var labels = chipLabels(h);
  if (labels.length !== 1 || labels[0] !== '上海') {
    throw new Error('退格应删掉最后一枚，实际 ' + JSON.stringify(labels));
  }
});

check('胶囊模式：选中文件后清空胶囊（不再需要过滤条件）', function () {
  var h = makeChipHost();
  h._setOpts([{ value: 's/1.docx', label: '1：上海.docx' }]);
  var inp = inputOf(h);
  fire(inp, 'focus');
  inp.value = '上海';
  fire(inp, 'input');
  fire(inp, 'keydown', { key: ' ', preventDefault: function () {} });
  if (chipLabels(h).length !== 1) throw new Error('应有一枚胶囊');
  var rows = rowsOf(h);
  if (rows.length !== 1) throw new Error('应命中 1 项');
  fire(rows[0], 'click');
  if (chipLabels(h).length !== 0) throw new Error('选中后应清空胶囊');
  if (h.value !== 's/1.docx') throw new Error('应选中该项，实际 ' + h.value);
});

check('非胶囊模式：空格仍是普通分隔符（子文件夹下拉不受影响）', function () {
  var h = makeHost();
  Combobox.attach(h);
  h._setOpts([
    { value: 'd/1', label: '子夹一' },
    { value: 'd/2', label: '子夹二' }
  ]);
  var inp = inputOf(h);
  fire(inp, 'focus');
  inp.value = '子夹 一';
  fire(inp, 'input');
  if (chipsOf(h).length !== 0) throw new Error('非胶囊模式不应生成胶囊');
  if (rowsOf(h).length !== 1) throw new Error('空格仍应作分词符（“子夹 一”只命中“子夹一”）');
});



check('胶囊模式：输入法组字期间的空格不形成胶囊（等选字之后的那次空格）', function () {
  var h = makeChipHost();
  h._setOpts([{ value: 's/1.docx', label: '1：广东标准.docx' }]);
  var inp = inputOf(h);
  fire(inp, 'focus');
  // 组字开始：拼音串进入输入框
  fire(inp, 'compositionstart', {});
  inp.value = 'guangdong';
  fire(inp, 'input');
  // 选字那一次空格：isComposing = true → 必须放行给输入法，不能固化胶囊
  var prevented = false;
  fire(inp, 'keydown', { key: ' ', isComposing: true, preventDefault: function () { prevented = true; } });
  if (prevented) throw new Error('输入法选字的空格不应被拦截');
  if (chipsOf(h).length !== 0) throw new Error('组字期间不应生成胶囊（拼音不能当关键词）');
  // 选字完成：拼音变成真实文字
  inp.value = '广东';
  fire(inp, 'compositionend', { data: '广东' });
  fire(inp, 'input');
  if (chipsOf(h).length !== 0) throw new Error('compositionend 本身不应生成胶囊');
  // 选字完成后再按一次空格：这时才是真正的分词空格
  fire(inp, 'keydown', { key: ' ', isComposing: false, preventDefault: function () {} });
  var labels = chipLabels(h);
  if (labels.length !== 1 || labels[0] !== '广东') {
    throw new Error('应生成一枚“广东”胶囊（而不是拼音），实际 ' + JSON.stringify(labels));
  }
});

check('胶囊模式：浏览器不报 isComposing 时也能靠 composition 事件挡住选字空格', function () {
  var h = makeChipHost();
  h._setOpts([{ value: 's/1.docx', label: '1：当归.docx' }]);
  var inp = inputOf(h);
  fire(inp, 'focus');
  fire(inp, 'compositionstart', {});
  inp.value = 'danggui';
  fire(inp, 'input');
  // 关键：keydown 上没有 isComposing（部分输入法/浏览器不填），只能靠 compositionstart 维护的状态
  fire(inp, 'keydown', { key: ' ', preventDefault: function () {} });
  if (chipsOf(h).length !== 0) throw new Error('组字未结束时不应生成胶囊');
  inp.value = '当归';
  fire(inp, 'compositionend', { data: '当归' });
  fire(inp, 'input');
  fire(inp, 'keydown', { key: ' ', preventDefault: function () {} });
  var labels = chipLabels(h);
  if (labels.length !== 1 || labels[0] !== '当归') {
    throw new Error('选字完成后应固化“当归”，实际 ' + JSON.stringify(labels));
  }
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
