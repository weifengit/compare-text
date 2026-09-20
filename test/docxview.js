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

// ---- 富 DOM 桩（仅差异标注用例使用）----
// 标注要动 DOM（childNodes/文本节点/splitText/classList/normalize），mkEl 的"只有 children 数组"
// 撑不住，故另建一套；与上面那套互不干扰，避免动到已有用例的桩行为。
function Txt(v) { this.nodeType = 3; this.nodeValue = v; this.parentNode = null; }
Txt.prototype.splitText = function (off) {
  var rest = new Txt(this.nodeValue.slice(off));
  this.nodeValue = this.nodeValue.slice(0, off);
  var par = this.parentNode;
  if (par) {
    var i = par.childNodes.indexOf(this);
    rest.parentNode = par;
    par.childNodes.splice(i + 1, 0, rest);
  }
  return rest;
};

function El(tag) {
  this.nodeType = 1; this.tagName = String(tag).toUpperCase(); this.className = '';
  this.childNodes = []; this.parentNode = null; this.style = {};
}
El.prototype.hasClass = function (c) { return (' ' + this.className + ' ').indexOf(' ' + c + ' ') >= 0; };
// 同真实 DOM：插入/追加一律先把节点从原父节点摘下来（否则 unwrap 的 "边搬边取 firstChild" 会死循环）
El.prototype.appendChild = function (c) {
  if (c.parentNode) c.parentNode.removeChild(c);
  c.parentNode = this;
  this.childNodes.push(c);
  return c;
};
El.prototype.insertBefore = function (c, ref) {
  if (c.parentNode) c.parentNode.removeChild(c);
  var i = this.childNodes.indexOf(ref);
  c.parentNode = this;
  if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c);
  return c;
};
El.prototype.removeChild = function (c) {
  var i = this.childNodes.indexOf(c);
  if (i >= 0) { this.childNodes.splice(i, 1); c.parentNode = null; }
  return c;
};
El.prototype.querySelector = function () { return null; };
var SEL_OK = { 'p': 1, 'span.docx-hl': 1 };
El.prototype.querySelectorAll = function (sel) {
  if (!SEL_OK[sel]) throw new Error('桩未实现的选择器：' + sel);
  var out = [];
  (function walk(n) {
    for (var i = 0; i < n.childNodes.length; i++) {
      var c = n.childNodes[i];
      if (c.nodeType !== 1) continue;
      if (sel === 'p' ? c.tagName === 'P' : (c.tagName === 'SPAN' && c.hasClass('docx-hl'))) out.push(c);
      walk(c);
    }
  })(this);
  return out;
};
// 与规范一致：合并相邻文本节点并移除空文本节点
El.prototype.normalize = function () {
  var out = [];
  for (var i = 0; i < this.childNodes.length; i++) {
    var c = this.childNodes[i];
    if (c.nodeType === 3) {
      if (!c.nodeValue) continue;
      var prev = out[out.length - 1];
      if (prev && prev.nodeType === 3) { prev.nodeValue += c.nodeValue; continue; }
    } else if (c.nodeType === 1) {
      c.normalize();
    }
    out.push(c);
  }
  for (i = 0; i < out.length; i++) out[i].parentNode = this;
  this.childNodes = out;
  return this;
};
Object.defineProperty(El.prototype, 'classList', {
  get: function () {
    var el = this;
    return {
      add: function () {
        for (var i = 0; i < arguments.length; i++) {
          if (!el.hasClass(arguments[i])) el.className = el.className ? el.className + ' ' + arguments[i] : arguments[i];
        }
      },
      remove: function () {
        for (var i = 0; i < arguments.length; i++) {
          el.className = el.className.split(' ').filter(function (c) { return c && c !== arguments[i]; }).join(' ');
        }
      },
      contains: function (c) { return el.hasClass(c); }
    };
  }
});
Object.defineProperty(El.prototype, 'firstChild', { get: function () { return this.childNodes[0] || null; } });
Object.defineProperty(El.prototype, 'textContent', {
  get: function () {
    var s = '';
    for (var i = 0; i < this.childNodes.length; i++) {
      var c = this.childNodes[i];
      s += c.nodeType === 3 ? c.nodeValue : c.textContent;
    }
    return s;
  }
});
Object.defineProperty(El.prototype, 'innerHTML', {
  get: function () { return ''; },
  set: function (v) { if (v === '') this.childNodes = []; }   // 桩不解析 HTML，只支持清空
});
// 行位索引要量 rect：桩给出 {top, height}（top 为视口坐标 = 内容坐标 − 面板 scrollTop，与真实浏览器一致）
El.prototype.getBoundingClientRect = function () {
  var st = this._scrollOf ? this._scrollOf() : 0;
  return { top: (this._contentTop || 0) - st, height: this._h || 0 };
};

/** paras: [[run 文本, ...], ...] → docx-preview 的 <section class="docx"> 下每段一个 <p>、每 run 一个 <span> */
function mkRich(paras) {
  var sandbox = {
    document: { createElement: function (t) { return new El(t); } },
    Diff: require(path.join(__dirname, '../lib/diff.min.js')),
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    Promise: Promise, Error: Error, Math: Math, JSON: JSON, console: console
  };
  sandbox.docx = {
    renderAsync: function (buf, host) {
      var wrap = host.appendChild(new El('div'));
      wrap.className = 'docx-wrapper';
      var sec = wrap.appendChild(new El('section'));
      sec.className = 'docx';
      for (var i = 0; i < paras.length; i++) {
        var p = sec.appendChild(new El('p'));
        for (var j = 0; j < paras[i].length; j++) p.appendChild(new El('span')).appendChild(new Txt(paras[i][j]));
      }
      return Promise.resolve();
    }
  };
  sandbox.mammoth = { extractRawText: function () { return Promise.resolve({ value: '' }); } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/docxview.js'), 'utf8'), sandbox, { filename: 'docxview.js' });
  return sandbox;
}
function mkRichPanels(DocxView) {
  var left = new El('div'), right = new El('div');
  DocxView.init({ left: left, right: right });
  return { L: left, R: right };
}
/** 与 mammoth 同构的原文：每段各以 "\n\n" 收尾 */
function rawOf(paras) {
  var s = '';
  for (var i = 0; i < paras.length; i++) s += paras[i].join('') + '\n\n';
  return s;
}
var RP = mkRich([]).DocxView._pure;      // 纯函数无需 DOM，取一份复用

/**
 * 布局仿真（行位索引用例）：给面板及其 <p> 补上可测量尺寸 —— 面板 padding 10，段落自上而下各高 lineH，
 * 段落 rect.top 随面板 scrollTop 平移（与真实浏览器一致）。返回段落数组，供用例改坐标（模拟缩放/重排）。
 */
function layout(panel, lineH, clientH) {
  panel.clientHeight = (clientH === undefined) ? 400 : clientH;
  panel.clientWidth = 600;
  if (panel.scrollTop == null) panel.scrollTop = 0;
  panel.getBoundingClientRect = function () { return { top: 0, height: panel.clientHeight }; };
  var ps = panel.firstChild.querySelectorAll('p');
  for (var i = 0; i < ps.length; i++) {
    ps[i]._contentTop = 10 + i * lineH;
    ps[i]._h = lineH;
    ps[i]._scrollOf = (function (p) { return function () { return p.scrollTop || 0; }; })(panel);
  }
  return ps;
}

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

check('错误提示 showError：面板红框统一带"Word 文档加载失败："前缀（供 app.js 复用，文案与 toast 一致）', function () {
  var t = mkSandbox();
  var P = mkPanels(t.sandbox.DocxView);
  t.sandbox.DocxView.showError('L', '文件为空（0 字节）：a.docx —— 请确认文件已完整保存到本地');
  assert(P.L.innerHTML.indexOf('pdf-error') >= 0, '应使用错误样式，实际：' + P.L.innerHTML);
  assert(P.L.innerHTML.indexOf('Word 文档加载失败：文件为空（0 字节）：a.docx') >= 0, '文案不符：' + P.L.innerHTML);
  t.sandbox.DocxView.showError('R', new Error('Corrupted zip'));      // Error 对象取 message
  assert(P.R.innerHTML.indexOf('Word 文档加载失败：Corrupted zip') >= 0, 'Error 应取 message：' + P.R.innerHTML);
  t.sandbox.DocxView.showError('L', '第二次覆盖');                     // 覆盖上一次，不叠加
  assert(P.L.innerHTML.indexOf('第二次覆盖') >= 0 && P.L.innerHTML.indexOf('文件为空') < 0, '应覆盖旧提示：' + P.L.innerHTML);
});

// ---------- 差异标注 ----------

check('纯函数 splitParas：按 \\n\\n 还原段落，行号把空段落也算上', function () {
  var ps = RP.splitParas('First paragraph\n\nSecond\n\n\n\nAfter empty para\n\n');
  assert(ps.length === 4, '应还原 4 段，实际 ' + ps.length);
  assert(ps[0].text === 'First paragraph' && ps[0].line === 1, '段 0 应为第 1 行');
  assert(ps[1].line === 3, '段 1 应为第 3 行，实际 ' + ps[1].line);
  assert(ps[2].text === '' && ps[2].line === 5, '空段落应为第 5 行，实际 ' + JSON.stringify(ps[2]));
  assert(ps[3].text === 'After empty para' && ps[3].line === 7, '段 3 应为第 7 行，实际 ' + ps[3].line);
  assert(RP.splitParas('').length === 0, '空文本应无段落');
  assert(RP.splitParas('only\n\n').length === 1, '单段文本应只有 1 段');
});

check('纯函数 alignParas：逐条一致时走恒等快路径', function () {
  var m = RP.splitParas('A\n\nB\n\nC\n\n');
  var r = RP.alignParas(['A', 'B', 'C'], m);
  assert(JSON.stringify(r) === '[[0,0],[1,1],[2,2]]', '应为恒等映射，实际 ' + JSON.stringify(r));
});

check('纯函数 alignParas：一方多出段落时各自归位、后续不错位', function () {
  var m = RP.splitParas('A\n\nB\n\nC\n\n');
  var r = RP.alignParas(['A', 'C'], m);          // DOM 少一段：C 仍须落到第 3 行
  assert(JSON.stringify(r) === '[[0,0],[1,2]]', '实际 ' + JSON.stringify(r));
  var r2 = RP.alignParas(['A', 'X', 'B', 'C'], m);   // DOM 多一段：X 不参与，其余归位
  assert(JSON.stringify(r2) === '[[0,0],[2,1],[3,2]]', '实际 ' + JSON.stringify(r2));
});

check('纯函数 mapInlineOffsets：DOM 缺字符时偏移折到同一点且不倒退', function () {
  var to = RP.mapInlineOffsets('aXb', 'ab');     // mammoth 有 X，DOM 没有
  assert(JSON.stringify(to) === '[0,1,1,2]', '实际 ' + JSON.stringify(to));
  var same = RP.mapInlineOffsets('abc', 'abc');
  assert(JSON.stringify(same) === '[0,1,2,3]', '相等时应逐字符对齐，实际 ' + JSON.stringify(same));
});

check('纯函数 normTab：emsp（docx-preview 的制表符）归一为 \\t 且字符数不变', function () {
  var emsp = String.fromCharCode(0x2003);
  var s = 'a' + emsp + 'b';
  var n = RP.normTab(s);
  assert(n === 'a\tb', '实际 ' + JSON.stringify(n));
  assert(n.length === s.length, '一对一替换不应改变字符数，便于沿用同一套字符偏移');
});

check('纯函数 segRanges：只取非 eq 片段，偏移含 eq 片段累计，配色逐片段取', function () {
  var r = RP.segRanges([{ text: 'ab', cls: 'eq' }, { text: 'CD', cls: 'rm' },
    { text: 'e', cls: 'eq' }, { text: 'F', cls: 'ad' }], 'ch');
  var got = r.map(function (x) { return [x.s, x.e, x.cls]; });
  assert(JSON.stringify(got) === '[[2,4,"rm"],[5,6,"ad"]]', '实际 ' + JSON.stringify(got));
  // 片段未带 rm/ad 时退回映射自身的 t
  var fb = RP.segRanges([{ text: 'XY', cls: 'ch' }], 'rm');
  assert(fb.length === 1 && fb[0].cls === 'rm', '应退回 t=rm，实际 ' + JSON.stringify(fb));
});

check('标注：字符串映射整段涂色（段落级类）', function () {
  var D = mkRich([['删掉的一行'], ['新增的一行']]).DocxView, pn = mkRichPanels(D);
  return D.load('L', buf1).then(function () {
    D.setSourceText('L', rawOf([['删掉的一行'], ['新增的一行']]));
    D.setHighlight('L', { 1: 'rm', 3: 'ad' });
    var ps = pn.L.firstChild.querySelectorAll('p');
    assert(ps[0].hasClass('docx-hl-para') && ps[0].hasClass('docx-hl-rm'), '第 1 段应整段 rm，实际类=' + ps[0].className);
    assert(ps[1].hasClass('docx-hl-ad'), '第 2 段应整段 ad，实际类=' + ps[1].className);
  });
});

check('标注：change 片段按字符涂色，且不改变段落文字', function () {
  var D = mkRich([['hello world']]).DocxView, pn = mkRichPanels(D);
  return D.load('L', buf1).then(function () {
    D.setSourceText('L', rawOf([['hello world']]));
    D.setHighlight('L', { 1: { t: 'ch', segs: [{ text: 'hello ', cls: 'eq' }, { text: 'world', cls: 'rm' }] } });
    var p = pn.L.firstChild.querySelectorAll('p')[0];
    var sp = p.querySelectorAll('span.docx-hl');
    assert(sp.length === 1, '应产生 1 个标注 span，实际 ' + sp.length);
    assert(sp[0].hasClass('docx-hl-rm'), '应为 rm，实际 ' + sp[0].className);
    assert(sp[0].textContent === 'world', '应恰好覆盖 world，实际 ' + JSON.stringify(sp[0].textContent));
    assert(p.textContent === 'hello world', '段落文字不得改变，实际 ' + JSON.stringify(p.textContent));
  });
});

check('标注：跨 run 的区间按文本节点分别涂色，文字仍可拼回', function () {
  // 两个 run（"hel" / "lo world"）→ 两个文本节点；标 [1,9) 必跨节点边界
  var D = mkRich([['hel', 'lo world']]).DocxView, pn = mkRichPanels(D);
  return D.load('L', buf1).then(function () {
    D.setSourceText('L', rawOf([['hel', 'lo world']]));
    D.setHighlight('L', { 1: { t: 'ch', segs: [{ text: 'h', cls: 'eq' }, { text: 'ello wor', cls: 'rm' }, { text: 'ld', cls: 'eq' }] } });
    var p = pn.L.firstChild.querySelectorAll('p')[0];
    var sp = p.querySelectorAll('span.docx-hl');
    assert(sp.length === 2, '跨两个文本节点应各产生 1 个 span，实际 ' + sp.length);
    assert(sp[0].textContent === 'el' && sp[1].textContent === 'lo wor',
      '标注文字应为 el / "lo wor"，实际 ' + JSON.stringify(sp[0].textContent) + ' / ' + JSON.stringify(sp[1].textContent));
    assert(sp[0].hasClass('docx-hl-rm') && sp[1].hasClass('docx-hl-rm'), '两段都应是 rm 配色');
    assert(p.textContent === 'hello world', '段落文字不得改变，实际 ' + JSON.stringify(p.textContent));
  });
});

check('标注：同一段里删标红、增标绿（逐片段配色，与区域1 一致）', function () {
  var D = mkRich([['hello world']]).DocxView, pn = mkRichPanels(D);
  return D.load('L', buf1).then(function () {
    D.setSourceText('L', rawOf([['hello world']]));
    D.setHighlight('L', {
      1: {
        t: 'ch', segs: [{ text: 'hello', cls: 'rm' }, { text: ' ', cls: 'eq' }, { text: 'world', cls: 'ad' }]
      }
    });
    var p = pn.L.firstChild.querySelectorAll('p')[0];
    var sp = p.querySelectorAll('span.docx-hl');
    assert(sp.length === 2, '应产生 2 个标注 span，实际 ' + sp.length);
    assert(sp[0].textContent === 'hello' && sp[0].hasClass('docx-hl-rm'),
      'hello 应为 rm（红），实际 ' + sp[0].className + ' / ' + JSON.stringify(sp[0].textContent));
    assert(sp[1].textContent === 'world' && sp[1].hasClass('docx-hl-ad'),
      'world 应为 ad（绿），实际 ' + sp[1].className + ' / ' + JSON.stringify(sp[1].textContent));
    assert(p.textContent === 'hello world', '段落文字不得改变');
  });
});

check('标注：二次重绘先清后画，不残留也不失效', function () {
  var D = mkRich([['hello world']]).DocxView, pn = mkRichPanels(D);
  return D.load('L', buf1).then(function () {
    D.setSourceText('L', rawOf([['hello world']]));
    D.setHighlight('L', { 1: { t: 'ch', segs: [{ text: 'hello ', cls: 'eq' }, { text: 'world', cls: 'rm' }] } });
    var p = pn.L.firstChild.querySelectorAll('p')[0];
    assert(p.querySelectorAll('span.docx-hl').length === 1, '首次应有 1 个标注 span');
    D.setHighlight('L', {});                       // 清空映射 → 重绘应把标注全部拆掉
    assert(p.querySelectorAll('span.docx-hl').length === 0, '重绘后不应残留标注 span');
    assert(p.textContent === 'hello world', '拆色后文字应与原文一致，实际 ' + JSON.stringify(p.textContent));
    // 再标一次（另一侧片段）：验证 normalize 合并回的文本节点偏移仍然可靠
    D.setHighlight('L', { 1: { t: 'ch', segs: [{ text: 'hello', cls: 'ad' }, { text: ' world', cls: 'eq' }] } });
    var sp = p.querySelectorAll('span.docx-hl');
    assert(sp.length === 1 && sp[0].textContent === 'hello',
      '二次标注应命中 hello，实际 ' + (sp[0] ? JSON.stringify(sp[0].textContent) : '无'));
    assert(p.textContent === 'hello world', '二次标注后文字仍应一致');
  });
});

check('标注：段落与原文对不上时不乱标（宁可漏标）', function () {
  var D = mkRich([['完全不同的内容']]).DocxView, pn = mkRichPanels(D);
  return D.load('L', buf1).then(function () {
    D.setSourceText('L', rawOf([['别的段落']]));      // 与 DOM 中的段落对不上
    D.setHighlight('L', { 1: 'rm' });
    var p = pn.L.firstChild.querySelectorAll('p')[0];
    assert(!p.hasClass('docx-hl-para'), '对不上就不该标注，实际类=' + p.className);
  });
});

check('标注：未登记原文时标注为空操作，不抛错', function () {
  var D = mkRich([['一段文字']]).DocxView, pn = mkRichPanels(D);
  return D.load('L', buf1).then(function () {
    D.setHighlight('L', { 1: 'rm' });             // texts 尚未登记
    var p = pn.L.firstChild.querySelectorAll('p')[0];
    assert(!p.hasClass('docx-hl-para'), '未登记原文不应标注');
    D.setSourceText('L', rawOf([['一段文字']]));      // 登记后同一映射应补上标注
    assert(p.hasClass('docx-hl-rm'), '登记原文后应补上标注，实际类=' + p.className);
  });
});

check('标注：swap 后两侧标注随文档一起对调', function () {
  var D = mkRich([['左文档'], ['共用段']]).DocxView;
  var pn = { L: new El('div'), R: new El('div') };
  D.init({ left: pn.L, right: pn.R });
  return D.load('L', buf1).then(function () {
    D.setSourceText('L', rawOf([['左文档'], ['共用段']]));
    D.setHighlight('L', { 1: 'rm' });
    assert(pn.L.firstChild.querySelectorAll('p')[0].hasClass('docx-hl-rm'), '互换前左侧应有标注');
    D.swap();
    return new Promise(function (res) { setTimeout(res, 0); });
  }).then(function () {
    // 左侧换成右侧文档（未加载 → 空面板），右侧接管原左侧文档与标注
    assert(pn.R.firstChild, '互换后右侧应有渲染内容');
    assert(pn.R.firstChild.querySelectorAll('p')[0].hasClass('docx-hl-rm'), '互换后标注应跟到右侧');
  });
});

// ---------- 行号 ↔ 滚动像素（内容锚定协同滚动） ----------

check('行位索引：段号 ↔ 像素互逆（含行内比例），顶部为虚拟第 0 行位', function () {
  var D = mkRich([['A'], ['B'], ['C']]).DocxView, pn = mkRichPanels(D);
  return D.load('L', buf1).then(function () {
    D.setSourceText('L', rawOf([['A'], ['B'], ['C']]));   // 段落在第 1/3/5 行（段间空行）
    layout(pn.L, 30);                                     // 面板 padding 10，段高 30 → 段顶 10/40/70
    assert(D.lineOffset('L', 0) === 0, '文档边界（第 0 行位）应在 0px，实际 ' + D.lineOffset('L', 0));
    assert(D.lineOffset('L', 1) === 10, '行 1（首段顶）应为 10px，实际 ' + D.lineOffset('L', 1));
    assert(D.lineOffset('L', 3) === 40, '行 3（第 2 段顶）应为 40px，实际 ' + D.lineOffset('L', 3));
    assert(D.lineOffset('L', 5) === 70, '行 5（第 3 段顶）应为 70px，实际 ' + D.lineOffset('L', 5));
    assert(D.lineOffset('L', 1.5) === 25, '行内比例应线性插值（1.5 → 25px），实际 ' + D.lineOffset('L', 1.5));
    assert(D.lineAtOffset('L', 0) === 0, '首段之上应为第 0 行位，实际 ' + D.lineAtOffset('L', 0));
    assert(D.lineAtOffset('L', 10) === 1, '首段顶应为行 1，实际 ' + D.lineAtOffset('L', 10));
    assert(D.lineAtOffset('L', 39) === 1, '第 2 段上一像素仍是行 1（空行只是行位占位），实际 ' + D.lineAtOffset('L', 39));
    assert(D.lineAtOffset('L', 40) === 3, '第 2 段顶应为行 3，实际 ' + D.lineAtOffset('L', 40));
    assert(D.lineAtOffset('L', 9999) === 5, '末尾以下应停在最后一段，实际 ' + D.lineAtOffset('L', 9999));
    assert(D.lineHeight('L', 1) === 30, '行高应为下一段顶 − 本段顶 = 30，实际 ' + D.lineHeight('L', 1));
    assert(D.nextLineOffset('L', 1) === 40, '下一段顶应为 40，实际 ' + D.nextLineOffset('L', 1));
    assert(D.nextLineOffset('L', 5) === null, '末段无下一段 → null，实际 ' + D.nextLineOffset('L', 5));
    assert(D.lineHeight('L', 5) === 30, '末段行高回退到段高，实际 ' + D.lineHeight('L', 5));
  });
});

check('行位索引：像素随面板滚动平移（往返一致，不受 scrollTop 影响）', function () {
  var D = mkRich([['A'], ['B']]).DocxView, pn = mkRichPanels(D);
  return D.load('L', buf1).then(function () {
    D.setSourceText('L', rawOf([['A'], ['B']]));
    layout(pn.L, 30);
    var off = D.lineOffset('L', 3);
    pn.L.scrollTop = 25;                                  // 用户滚动后：rect 整体上移 25px
    assert(D.lineOffset('L', 3) === off, '内容坐标不应随滚动变化：' + D.lineOffset('L', 3) + ' vs ' + off);
    assert(D.lineAtOffset('L', 25) === 1, '滚动 25px 后视口顶仍是行 1（段顶 10 → 屏上 -15），实际 ' + D.lineAtOffset('L', 25));
    assert(D.lineAtOffset('L', 40) === 3, '内容坐标 40 处应为行 3，实际 ' + D.lineAtOffset('L', 40));
  });
});

check('行位索引：DOM 多出的段落不参与，后续段落的行号不错位', function () {
  var D = mkRich([['A'], ['文本框里的内容'], ['B']]).DocxView, pn = mkRichPanels(D);
  return D.load('L', buf1).then(function () {
    D.setSourceText('L', rawOf([['A'], ['B']]));          // mammoth 只有 2 段 → 行 1/3
    layout(pn.L, 30);                                     // 段顶 10/40/70（第 2 段 DOM 未被 mammoth 覆盖）
    assert(D.lineOffset('L', 1) === 10, '行 1 应为第 1 段顶，实际 ' + D.lineOffset('L', 1));
    assert(D.lineOffset('L', 3) === 70, '行 3 应对到第 3 个 DOM 段（第 2 段未配对，不占行号），实际 ' + D.lineOffset('L', 3));
    assert(D.lineAtOffset('L', 70) === 3, '实际 ' + D.lineAtOffset('L', 70));
  });
});

check('行位索引：面板隐藏/原文未登记/已清空 → null（降级比例同步）', function () {
  var D = mkRich([['A']]).DocxView, pn = mkRichPanels(D);
  return D.load('L', buf1).then(function () {
    layout(pn.L, 30, 0);                                  // clientHeight = 0：面板隐藏（display:none）
    assert(D.lineOffset('L', 1) === null, '面板隐藏时应为 null，实际 ' + D.lineOffset('L', 1));
    assert(D.lineAtOffset('L', 0) === null, '面板隐藏时应为 null');
    layout(pn.L, 30, 400);                                // 显示出来 → 同一次加载即可量出位置
    assert(D.lineOffset('L', 1) === null, '原文未登记时仍应为 null，实际 ' + D.lineOffset('L', 1));
    D.setSourceText('L', rawOf([['A']]));
    assert(D.lineOffset('L', 1) === 10, '登记原文后应量出段顶，实际 ' + D.lineOffset('L', 1));
    D.clear('L');
    assert(D.lineOffset('L', 1) === null, '清空面板后应为 null，实际 ' + D.lineOffset('L', 1));
  });
});

check('行位索引：标注重绘/换文档后失效重建（量到的是新坐标）', function () {
  var D = mkRich([['hello world']]).DocxView, pn = mkRichPanels(D);
  return D.load('L', buf1).then(function () {
    D.setSourceText('L', rawOf([['hello world']]));
    var ps = layout(pn.L, 30);
    assert(D.lineOffset('L', 1) === 10, '初始段顶应为 10，实际 ' + D.lineOffset('L', 1));
    ps[0]._contentTop = 4;                                // 模拟缩放/重排后段落位置变化
    assert(D.lineOffset('L', 1) === 10, '未失效时沿用旧索引（同一帧内不重复量）');
    D.setHighlight('L', { 1: 'rm' });                     // 标注重绘 → 索引失效
    assert(D.lineOffset('L', 1) === 4, '重绘后应量出新坐标 4，实际 ' + D.lineOffset('L', 1));
    assert(D._debug('L').posEntries === 2, '索引条目数应为 2（虚拟第 0 行位 + 1 段），实际 ' + D._debug('L').posEntries);
  });
});

runAll().then(function () {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
});
