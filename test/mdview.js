'use strict';
/**
 * mdview.js / mdrender.js 单元测试：vm 沙箱注入源码，桩掉 DOM，
 * 验证渲染、加载、清空、互换、提词、差异标注（整行 + 行内片段）、行锚定协同滚动。
 * 运行：node test/mdview.js
 */
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var passed = 0, failed = 0;
var tests = [];
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
  this._attrs = {};
}
El.prototype.hasClass = function (c) { return (' ' + this.className + ' ').indexOf(' ' + c + ' ') >= 0; };
El.prototype.setAttribute = function (k, v) { this._attrs[k] = String(v); };
El.prototype.getAttribute = function (k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; };
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

var SEL_OK = { 'span.md-hl': 1, '.md-line': 1 };
function matchesSel(el, sel) {
  if (sel === '.md-line') return el.hasClass('md-line');
  if (sel === 'span.md-hl') return el.tagName === 'SPAN' && el.hasClass('md-hl');
  return false;
}
El.prototype.querySelectorAll = function (sel) {
  if (!SEL_OK[sel]) throw new Error('桩未实现的选择器：' + sel);
  var out = [];
  (function walk(n) {
    for (var i = 0; i < n.childNodes.length; i++) {
      var c = n.childNodes[i];
      if (c.nodeType !== 1) continue;
      if (matchesSel(c, sel)) out.push(c);
      walk(c);
    }
  })(this);
  return out;
};
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
        var names = Array.prototype.slice.call(arguments);
        el.className = el.className.split(' ').filter(function (c) { return c && names.indexOf(c) < 0; }).join(' ');
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
  set: function (v) {
    this.childNodes = [];
    if (v) {
      var root = parseHTML(v);
      while (root.childNodes.length) this.appendChild(root.childNodes[0]);
    }
  }
});
El.prototype.getBoundingClientRect = function () {
  var st = this._scrollOf ? this._scrollOf() : 0;
  return { top: (this._contentTop || 0) - st, height: this._h || 0 };
};

/** mdrender 输出的 HTML 子集解析：div/pre/code/table/thead/tbody/tr/th/td/span/strong/em/del/a/img */
var VOID = { img: 1, br: 1, hr: 1 };
function parseHTML(html) {
  var root = new El('div');
  var stack = [root];
  var re = /<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^>]*)?)>|<\/([a-zA-Z][a-zA-Z0-9]*)>|([^<]+)/g;
  var m;
  while ((m = re.exec(html))) {
    if (m[1]) {
      var tag = m[1].toLowerCase();
      var attrs = m[2] || '';
      var el = new El(tag);
      var cm = /class="([^"]*)"/.exec(attrs);
      if (cm) el.className = cm[1];
      var dm = /data-line="([^"]*)"/.exec(attrs);
      if (dm) el.setAttribute('data-line', dm[1]);
      var hm = /href="([^"]*)"/.exec(attrs);
      if (hm) el.setAttribute('href', hm[1]);
      var sm = /src="([^"]*)"/.exec(attrs);
      if (sm) el.setAttribute('src', sm[1]);
      var lm = /data-lang="([^"]*)"/.exec(attrs);
      if (lm) el.setAttribute('data-lang', lm[1]);
      stack[stack.length - 1].appendChild(el);
      if (!VOID[tag]) stack.push(el);
    } else if (m[3]) {
      for (var i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName.toLowerCase() === m[3].toLowerCase()) { stack.length = i; break; }
      }
    } else if (m[4]) {
      stack[stack.length - 1].appendChild(new Txt(m[4]));
    }
  }
  return root;
}

function mkSandbox() {
  var sandbox = {
    document: { createElement: function (t) { return new El(t); } },
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    Promise: Promise, Error: Error, Math: Math, JSON: JSON,
    console: console,
    Diff: require(path.join(__dirname, '../lib/diff.min.js'))
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/mdrender.js'), 'utf8'), sandbox, { filename: 'mdrender.js' });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/mdview.js'), 'utf8'), sandbox, { filename: 'mdview.js' });
  return sandbox;
}
function mkPanels(MdView) {
  var left = new El('div'), right = new El('div');
  MdView.init({ left: left, right: right });
  return { L: left, R: right };
}
/** 行位索引用例：给面板及其 .md-line 补上可测量尺寸（面板 padding 10，行高 lineH）。 */
function layout(panel, lineH, clientH) {
  panel.clientHeight = (clientH === undefined) ? 400 : clientH;
  panel.clientWidth = 600;
  if (panel.scrollTop == null) panel.scrollTop = 0;
  panel.getBoundingClientRect = function () { return { top: 0, height: panel.clientHeight }; };
  var lines = panel.firstChild.querySelectorAll('.md-line');
  for (var i = 0; i < lines.length; i++) {
    lines[i]._contentTop = 10 + i * lineH;
    lines[i]._h = lineH;
    lines[i]._scrollOf = (function (p) { return function () { return p.scrollTop || 0; }; })(panel);
  }
  return lines;
}

console.log('mdview / mdrender\n');

var RP = mkSandbox().MdRender;      // 纯函数无需 DOM

// ---------- mdrender 纯函数 ----------
check('splitLines：统一 CRLF/LF', function () {
  assert(JSON.stringify(RP.splitLines('a\r\nb\rc\n')) === JSON.stringify(['a', 'b', 'c', '']),
    '实际 ' + JSON.stringify(RP.splitLines('a\r\nb\rc\n')));
});

check('renderInline：粗体/斜体/行内代码/删除线', function () {
  assert(RP.renderInline('**b**') === '<strong>b</strong>', RP.renderInline('**b**'));
  assert(RP.renderInline('*i*') === '<em>i</em>', RP.renderInline('*i*'));
  assert(RP.renderInline('`c`') === '<code>c</code>', RP.renderInline('`c`'));
  assert(RP.renderInline('~~d~~') === '<del>d</del>', RP.renderInline('~~d~~'));
});

check('renderInline：下划线斜体要求词边界，snake_case 不误判', function () {
  assert(RP.renderInline('_i_') === '<em>i</em>', RP.renderInline('_i_'));
  assert(RP.renderInline('snake_case_name') === 'snake_case_name', RP.renderInline('snake_case_name'));
});

check('renderInline：链接/图片/自动链接，原始 HTML 转义', function () {
  assert(RP.renderInline('[t](http://a)') === '<a href="http://a" target="_blank" rel="noopener">t</a>',
    RP.renderInline('[t](http://a)'));
  assert(RP.renderInline('![a](b.png)') === '<img src="b.png" alt="a">', RP.renderInline('![a](b.png)'));
  assert(RP.renderInline('<https://x>') === '<a href="https://x" target="_blank" rel="noopener">https://x</a>',
    RP.renderInline('<https://x>'));
  assert(RP.renderInline('<b>') === '&lt;b&gt;', RP.renderInline('<b>'));
});

check('render：标题/段落/列表/代码块/引用/水平线都带 data-line 且行号连续', function () {
  var md = '# H1\n\npara one\n\n- a\n- b\n\n```js\nx=1\n```\n\n> q\n\n---\n';
  var r = RP.render(md);
  assert(r.html.indexOf('class="md-line md-h1" data-line="1"') >= 0, '标题行号不对：' + r.html);
  assert(r.html.indexOf('class="md-line md-p" data-line="3"') >= 0, '段落行号不对：' + r.html);
  assert(r.html.indexOf('class="md-line md-li" data-line="5"') >= 0, '列表行号不对：' + r.html);
  assert(r.html.indexOf('class="md-line md-li" data-line="6"') >= 0, '列表第二行号不对：' + r.html);
  assert(r.html.indexOf('class="md-line md-codeline" data-line="9"') >= 0, '代码行号不对：' + r.html);
  assert(r.html.indexOf('class="md-line md-quote" data-line="12"') >= 0, '引用行号不对：' + r.html);
  assert(r.html.indexOf('class="md-line md-hr" data-line="14"') >= 0, '水平线行号不对：' + r.html);
});

check('render：GFM 表格行号连续，单元格内容渲染', function () {
  var r = RP.render('| a | b |\n|---|---|\n| 1 | 2 |\n');
  assert(r.html.indexOf('<tr class="md-line md-trow" data-line="1">') >= 0, r.html);
  assert(r.html.indexOf('<tr class="md-line md-trow" data-line="3">') >= 0, r.html);
  assert(r.html.indexOf('<th>a</th>') >= 0 && r.html.indexOf('<td>1</td>') >= 0, r.html);
});

// ---------- MdView 基础 ----------
var t1 = mkSandbox();
var M1 = t1.MdView;
var p1 = mkPanels(M1);

check('加载成功：渲染挂载到面板，isLoaded=true，原文即源码', function () {
  return M1.load('L', '# 标题\n\n正文').then(function () {
    assert(M1.isLoaded('L') === true, 'L 应为已加载');
    assert(M1.isLoaded('R') === false, 'R 不应已加载');
    assert(p1.L.firstChild.className === 'md-view', '子节点应为 .md-view，实际 ' + p1.L.firstChild.className);
    assert(p1.L.firstChild.querySelectorAll('.md-line').length === 2, '应有 2 个 .md-line（标题+正文）');
    return M1.extractPanel('L').then(function (text) {
      assert(text === '# 标题\n\n正文', '原文应为源码，实际 ' + JSON.stringify(text));
    });
  });
});

check('过期令牌丢弃：同侧两次加载只保留后者', function () {
  var r1 = M1.load('L', '# 一', 1);
  var r2 = M1.load('L', '# 二', 2);
  return Promise.all([r1, r2]).then(function () {
    return M1.extractPanel('L');
  }).then(function (text) {
    assert(text === '# 二', '应保留第二次加载，实际 ' + JSON.stringify(text));
  });
});

check('清空：isLoaded=false，面板清空', function () {
  M1.clear('L');
  assert(M1.isLoaded('L') === false, 'L 应为未加载');
  assert(p1.L.innerHTML === '', '面板应已清空');
});

check('互换：两侧内容对调并重渲染，不重新取文件', function () {
  return M1.load('L', '# 左').then(function () {
    return M1.load('R', '# 右');
  }).then(function () {
    M1.swap();
    return new Promise(function (res) { setTimeout(res, 0); });
  }).then(function () {
    return Promise.all([M1.extractPanel('L'), M1.extractPanel('R')]);
  }).then(function (ts) {
    assert(ts[0] === '# 右', 'L 应为原 R 内容，实际 ' + JSON.stringify(ts[0]));
    assert(ts[1] === '# 左', 'R 应为原 L 内容，实际 ' + JSON.stringify(ts[1]));
  });
});

check('缺少 mdrender 全局时给出明确错误', function () {
  var sb = { document: { createElement: function (t) { return new El(t); } }, Promise: Promise, Error: Error };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/mdview.js'), 'utf8'), sb, { filename: 'mdview.js' });
  var p = new El('div');
  sb.MdView.init({ left: p, right: p });
  return sb.MdView.load('L', 'x').then(
    function () { throw new Error('不应成功'); },
    function (e) { assert(/mdrender\.js 未加载/.test(e.message), '错误信息不符：' + e.message); }
  );
});

// ---------- 差异标注 ----------
check('标注：字符串映射整行涂色（段落级类）', function () {
  var M = mkSandbox().MdView, pn = mkPanels(M);
  return M.load('L', '删掉的一行\n新增的一行').then(function () {
    M.setSourceText('L', '删掉的一行\n新增的一行');
    M.setHighlight('L', { 1: 'rm', 2: 'ad' });
    var lines = pn.L.firstChild.querySelectorAll('.md-line');
    assert(lines[0].hasClass('md-hl-para') && lines[0].hasClass('md-hl-rm'), '第 1 行应整行 rm，实际类=' + lines[0].className);
    assert(lines[1].hasClass('md-hl-ad'), '第 2 行应整行 ad，实际类=' + lines[1].className);
  });
});

check('标注：change 片段按字符涂色，Markdown 语法字符被折叠不错位', function () {
  var M = mkSandbox().MdView, pn = mkPanels(M);
  return M.load('L', '**hello** world').then(function () {
    M.setSourceText('L', '**hello** world');
    M.setHighlight('L', {
      1: { t: 'ch', segs: [{ text: '**hello**', cls: 'rm' }, { text: ' world', cls: 'eq' }] }
    });
    var line = pn.L.firstChild.querySelectorAll('.md-line')[0];
    var sp = line.querySelectorAll('span.md-hl');
    assert(sp.length === 1, '应产生 1 个标注 span，实际 ' + sp.length);
    assert(sp[0].hasClass('md-hl-rm'), '应为 rm，实际 ' + sp[0].className);
    assert(sp[0].textContent === 'hello', '应恰好覆盖渲染后的 hello，实际 ' + JSON.stringify(sp[0].textContent));
    assert(line.textContent === 'hello world', '行文字不得改变，实际 ' + JSON.stringify(line.textContent));
  });
});

check('标注：同一段里删标红、增标绿（逐片段配色，与区域1 一致）', function () {
  var M = mkSandbox().MdView, pn = mkPanels(M);
  return M.load('L', 'hello world').then(function () {
    M.setSourceText('L', 'hello world');
    M.setHighlight('L', {
      1: { t: 'ch', segs: [{ text: 'hello', cls: 'rm' }, { text: ' ', cls: 'eq' }, { text: 'world', cls: 'ad' }] }
    });
    var line = pn.L.firstChild.querySelectorAll('.md-line')[0];
    var sp = line.querySelectorAll('span.md-hl');
    assert(sp.length === 2, '应产生 2 个标注 span，实际 ' + sp.length);
    assert(sp[0].textContent === 'hello' && sp[0].hasClass('md-hl-rm'), 'hello 应为 rm');
    assert(sp[1].textContent === 'world' && sp[1].hasClass('md-hl-ad'), 'world 应为 ad');
    assert(line.textContent === 'hello world', '行文字不得改变');
  });
});

check('标注：二次重绘先清后画，不残留也不失效', function () {
  var M = mkSandbox().MdView, pn = mkPanels(M);
  return M.load('L', 'hello world').then(function () {
    M.setSourceText('L', 'hello world');
    M.setHighlight('L', { 1: { t: 'ch', segs: [{ text: 'hello ', cls: 'eq' }, { text: 'world', cls: 'rm' }] } });
    var line = pn.L.firstChild.querySelectorAll('.md-line')[0];
    assert(line.querySelectorAll('span.md-hl').length === 1, '首次应有 1 个标注 span');
    M.setHighlight('L', {});
    assert(line.querySelectorAll('span.md-hl').length === 0, '重绘后不应残留标注 span');
    assert(line.textContent === 'hello world', '拆色后文字应与原文一致，实际 ' + JSON.stringify(line.textContent));
  });
});

check('标注：未登记原文时标注为空操作，登记后补上', function () {
  var M = mkSandbox().MdView, pn = mkPanels(M);
  return M.load('L', '一段文字').then(function () {
    M.setSourceText('L', null);                 // 模拟原文未登记（面板 DOM 仍在）
    M.setHighlight('L', { 1: 'rm' });
    var line = pn.L.firstChild.querySelectorAll('.md-line')[0];
    assert(!line.hasClass('md-hl-para'), '未登记原文不应标注');
    M.setSourceText('L', '一段文字');           // 登记后同一映射应补上标注
    assert(line.hasClass('md-hl-rm'), '登记原文后应补上标注，实际类=' + line.className);
  });
});

// ---------- 行号 ↔ 滚动像素 ----------
check('行位索引：行号 ↔ 像素互逆（含行内比例），顶部为虚拟第 0 行位', function () {
  var M = mkSandbox().MdView, pn = mkPanels(M);
  return M.load('L', 'A\n\nB\n\nC').then(function () {
    M.setSourceText('L', 'A\n\nB\n\nC');
    layout(pn.L, 30);
    assert(M.lineOffset('L', 0) === 0, '文档边界应在 0px，实际 ' + M.lineOffset('L', 0));
    assert(M.lineOffset('L', 1) === 10, '行 1 应为 10px，实际 ' + M.lineOffset('L', 1));
    assert(M.lineOffset('L', 3) === 40, '行 3 应为 40px，实际 ' + M.lineOffset('L', 3));
    assert(M.lineOffset('L', 5) === 70, '行 5 应为 70px，实际 ' + M.lineOffset('L', 5));
    assert(M.lineOffset('L', 1.5) === 25, '行内比例应线性插值，实际 ' + M.lineOffset('L', 1.5));
    assert(M.lineAtOffset('L', 0) === 0, '首行之上应为第 0 行位，实际 ' + M.lineAtOffset('L', 0));
    assert(M.lineAtOffset('L', 10) === 1, '首行顶应为行 1，实际 ' + M.lineAtOffset('L', 10));
    assert(M.lineAtOffset('L', 39) === 1, '第 2 行上一像素仍是行 1，实际 ' + M.lineAtOffset('L', 39));
    assert(M.lineAtOffset('L', 40) === 3, '第 2 行顶应为行 3，实际 ' + M.lineAtOffset('L', 40));
    assert(M.lineAtOffset('L', 9999) === 5, '末尾以下应停在最后一行，实际 ' + M.lineAtOffset('L', 9999));
    assert(M.lineHeight('L', 1) === 30, '行高应为 30，实际 ' + M.lineHeight('L', 1));
    assert(M.nextLineOffset('L', 1) === 40, '下一行顶应为 40，实际 ' + M.nextLineOffset('L', 1));
    assert(M.nextLineOffset('L', 5) === null, '末行无下一行 → null，实际 ' + M.nextLineOffset('L', 5));
  });
});

check('行位索引：像素随面板滚动平移（往返一致）', function () {
  var M = mkSandbox().MdView, pn = mkPanels(M);
  return M.load('L', 'A\n\nB').then(function () {
    M.setSourceText('L', 'A\n\nB');
    layout(pn.L, 30);
    var off = M.lineOffset('L', 3);
    pn.L.scrollTop = 25;
    assert(M.lineOffset('L', 3) === off, '内容坐标不应随滚动变化：' + M.lineOffset('L', 3) + ' vs ' + off);
    assert(M.lineAtOffset('L', 25) === 1, '滚动 25px 后视口顶仍是行 1，实际 ' + M.lineAtOffset('L', 25));
  });
});

check('行位索引：面板隐藏/原文未登记/已清空 → null（降级比例同步）', function () {
  var M = mkSandbox().MdView, pn = mkPanels(M);
  return M.load('L', 'A').then(function () {
    layout(pn.L, 30, 0);
    assert(M.lineOffset('L', 1) === null, '面板隐藏时应为 null，实际 ' + M.lineOffset('L', 1));
    layout(pn.L, 30, 400);
    M.setSourceText('L', null);                 // 原文未登记 → 无坐标系
    assert(M.lineOffset('L', 1) === null, '原文未登记时仍应为 null，实际 ' + M.lineOffset('L', 1));
    M.setSourceText('L', 'A');
    assert(M.lineOffset('L', 1) === 10, '登记原文后应量出行顶，实际 ' + M.lineOffset('L', 1));
    M.clear('L');
    assert(M.lineOffset('L', 1) === null, '清空面板后应为 null，实际 ' + M.lineOffset('L', 1));
  });
});

check('行位索引：标注重绘后失效重建（量到的是新坐标）', function () {
  var M = mkSandbox().MdView, pn = mkPanels(M);
  return M.load('L', 'hello world').then(function () {
    M.setSourceText('L', 'hello world');
    var lines = layout(pn.L, 30);
    assert(M.lineOffset('L', 1) === 10, '初始行顶应为 10，实际 ' + M.lineOffset('L', 1));
    lines[0]._contentTop = 4;
    assert(M.lineOffset('L', 1) === 10, '未失效时沿用旧索引（同一帧内不重复量）');
    M.setHighlight('L', { 1: 'rm' });
    assert(M.lineOffset('L', 1) === 4, '重绘后应量出新坐标 4，实际 ' + M.lineOffset('L', 1));
    assert(M._debug('L').posEntries === 2, '索引条目数应为 2（虚拟第 0 行位 + 1 行），实际 ' + M._debug('L').posEntries);
  });
});

runAll().then(function () {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
});
