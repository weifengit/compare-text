/**
 * ui-init.js — 用 DOM/浏览器 API 桩驱动 src/app.js：初始化 + 首次对比，
 * 再通过桩 Worker 回报结果，覆盖 renderGrid / renderFlow / renderInline / 折叠点击。
 * 运行：node -e "require('./test/ui-init.js')"
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
  return {
    _value: '', _handlers: {},
    getValue: function () { return this._value; },
    setValue: function (v) { this._value = v; },
    on: function (type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
    fire: function (type, ev) { (this._handlers[type] || []).forEach(function (f) { f(ev || {}); }); }
  };
};

var workers = [];
var els = {};
var editors = [];
var posted = [];   // worker 收到的 {id,payload}

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
  CodeMirror: { fromTextArea: function () { var ed = mkEditor(); editors.push(ed); return ed; } },
  Worker: function () {
    var w = { onmessage: null, onerror: null, postMessage: function (m) { posted.push(m); } };
    workers.push(w);
    return w;
  },
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
check('flow 结果渲染不抛错且含行号列', function () {
  var res = Compute.computeDiff({ left: '一\n二', right: '一 二', options: { ignoreNewline: true } });
  res._options = { ignoreNewline: true, ignoreCase: false, ignoreEol: true };
  editors[0].setValue('一\n二');   // 编辑器非空，跳过占位符分支，真正进入 renderFlow
  editors[1].setValue('一 二');
  var last = posted[posted.length - 1];
  if (!last) throw new Error('尚无 worker 消息');
  workers[0].onmessage({ data: { id: last.id, result: res } }); // 真实 seq，确保真正渲染
  if (els['results'].innerHTML.indexOf('<span class="ln">') === -1) {
    throw new Error('flow 模式左右栏应包含行号列');
  }
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
check('修整：清除多余空格/制表符/换行/空行并合并为一行', function () {
  var dirtyL = '  hello\t\tworld  \n\n   \nfoo\nbar\n';
  var dirtyR = '\n 苹果 , 香蕉  \t \n\n梨子\n\n';
  editors[0].setValue(dirtyL);
  editors[1].setValue(dirtyR);
  els['tidyBtn'].dispatch('click');
  if (editors[0].getValue() !== 'hello world foo bar') {
    throw new Error('左侧修整结果异常: ' + JSON.stringify(editors[0].getValue()));
  }
  if (editors[1].getValue() !== '苹果 , 香蕉 梨子') {
    throw new Error('右侧修整结果异常: ' + JSON.stringify(editors[1].getValue()));
  }
  if (editors[0].getValue().indexOf('\n') !== -1) {
    throw new Error('左侧修整后不应含换行符');
  }
});
check('修整按钮一键切换：修整→撤销修整（换字换色）→恢复', function () {
  if (els['tidyBtn'].textContent !== '修整') els['tidyBtn'].dispatch('click'); // 兜底回到修整态
  var L = 'a  b\n\n c\n', R = '  x\ty\n';
  editors[0].setValue(L);
  editors[1].setValue(R);
  els['tidyBtn'].dispatch('click');
  if (els['tidyBtn'].textContent !== '撤销修整') throw new Error('修整后按钮文字应变“撤销修整”，实际 ' + els['tidyBtn'].textContent);
  els['tidyBtn'].dispatch('click');
  if (els['tidyBtn'].textContent !== '修整') throw new Error('撤销后按钮应恢复为“修整”');
  if (editors[0].getValue() !== L) throw new Error('撤销后左侧未恢复: ' + JSON.stringify(editors[0].getValue()));
  if (editors[1].getValue() !== R) throw new Error('撤销后右侧未恢复');
});
check('内联视图切换后重新渲染不抛错', function () {
  var grid = Compute.computeDiff({ left: 'a\nb', right: 'a\nX' });
  grid._options = { ignoreCase: false, ignoreEol: true };
  workers[0].onmessage({ data: { id: 4, result: grid } });
  els['viewToggle'].dispatch('click');   // side -> inline
  els['viewToggle'].dispatch('click');   // inline -> side
});
check('侧边栏：宽屏沙箱默认展开', function () {
  if (els['sidebar'].classList.contains('collapsed')) throw new Error('宽屏（无 window）下侧边栏应默认展开');
});
check('侧边栏：点击 ☰ 切换收起/展开', function () {
  els['sidebarToggle'].dispatch('click');
  if (!els['sidebar'].classList.contains('collapsed')) throw new Error('点击后应收起');
  els['sidebarToggle'].dispatch('click');
  if (els['sidebar'].classList.contains('collapsed')) throw new Error('再次点击应展开');
});

// ---- 端到端：勾选“忽略换行”→ change 事件 → 防抖 → worker 收到 ignoreNewline:true → flow ----
setTimeout(function () {
  try {
    var LEFT = '   我是谁 我是%（）我是。   我是';
    var RIGHT = '  我是 谁\n我是%()我是.我是';
    var beforeCount = posted.length;
    // 填入两段文本并勾选“忽略换行”
    editors[0].setValue(LEFT);
    editors[1].setValue(RIGHT);
    els['optIgnoreCase'].checked = true;
    els['optIgnoreEol'].checked = true;
    els['optIgnoreWhitespace'].checked = true;
    els['optIgnoreNewline'].checked = true;
    els['optIgnoreWidth'].checked = true;
    els['optIgnorePunct'].checked = true;
    editors[0].fire('change');
    editors[1].fire('change');
    setTimeout(function () {
      try {
        var lastMsg = posted[posted.length - 1];
        if (!lastMsg) throw new Error('防抖后未向 worker 发送对比请求');
        if (lastMsg.payload.options.ignoreNewline !== true) {
          throw new Error('worker 收到的 options.ignoreNewline 应为 true，实际 ' + lastMsg.payload.options.ignoreNewline);
        }
        // 用收到的 payload 实际计算结果并喂回 worker.onmessage（走 flow 渲染）
        var res = Compute.computeDiff(lastMsg.payload);
        if (res.mode !== 'flow') throw new Error('应进入 flow 模式，实际 ' + res.mode);
        if (res.removedChars + res.addedChars !== 0) {
          throw new Error('该文本在忽略换行下应有 0 差异，实际 增' + res.addedChars + ' 删' + res.removedChars);
        }
        workers[0].onmessage({ data: { id: lastMsg.id, result: res } }); // flow 渲染路径
        passed++;
        console.log('  ok  端到端：勾选忽略换行 → worker 收到 ignoreNewline → flow 且 0 差异');
      } catch (e) {
        failed++;
        console.log('FAIL  端到端忽略换行链路\n      ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 6).join('\n'));
      }
      console.log('\n' + passed + ' passed, ' + failed + ' failed');
      process.exit(failed ? 1 : 0);
    }, 600);
  } catch (e) {
    failed++;
    console.log('FAIL  端到端忽略换行链路（外层）\n      ' + e.message);
    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    process.exit(1);
  }
}, 0);