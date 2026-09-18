/**
 * ui-init.js — 用 DOM/浏览器 API 桩驱动 src/app.js：初始化 + 首次对比，
 * 再通过桩 Worker 回报结果，覆盖 renderGrid / renderFlow / 折叠点击 / PDF 缩放 / 多标签页。
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
  var el = {
    id: id, checked: false, textContent: '', value: '', style: {},
    scrollTop: 0, scrollHeight: 0, clientHeight: 0,   // 供协同滚动用例
    classList: mkClassList(),
    children: [],
    _listeners: {},
    addEventListener: function (type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    dispatch: function (type, ev) { (this._listeners[type] || []).forEach(function (f) { f(ev || {}); }); },
    getAttribute: function () { return null; },
    closest: function () { return null; },
    appendChild: function (el2) { this.children.push(el2); },
    remove: function () {}, select: function () {}, setAttribute: function () {}
  };
  // innerHTML 赋值同时清空 children，保证重渲染后 children 反映最新结构
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
    removeEventListener: function () {},
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
  fetch: function () {
    return Promise.resolve({
      json: function () {
        return Promise.resolve({ ok: true, dirs: ['子文件夹1'], files: [
          { name: 'a.txt', size: 3, ext: 'txt' }, { name: 'b.txt', size: 3, ext: 'txt' }
        ] });
      },
      text: function () { return Promise.resolve('非PDF文件文本'); }
    });
  },
  pdfjsLib: { getDocument: function () { return { promise: Promise.reject(new Error('stub pdf')) }; } },
  setTimeout: setTimeout, clearTimeout: clearTimeout,
  // 浏览器主线程真实挂载方式：jsdiff 挂到大写 Diff
  Diff: require('../lib/diff.min.js')
};

vm.createContext(sandbox);
// 与 index.html 相同的脚本加载顺序
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/normalize.js'), 'utf8'), sandbox, { filename: 'normalize.js' });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/compute.js'), 'utf8'), sandbox, { filename: 'compute.js' });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/source-api.js'), 'utf8'), sandbox, { filename: 'source-api.js' });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/picker.js'), 'utf8'), sandbox, { filename: 'picker.js' });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/filterbar.js'), 'utf8'), sandbox, { filename: 'filterbar.js' });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/pdfview.js'), 'utf8'), sandbox, { filename: 'pdfview.js' });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/syncscroll.js'), 'utf8'), sandbox, { filename: 'syncscroll.js' });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/tabs.js'), 'utf8'), sandbox, { filename: 'tabs.js' });
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
check('PDF 标注：grid 结果把变更行映射到两侧行号', function () {
  var res = Compute.computeDiff({ left: 'a\nb\nc', right: 'a\nX\nc' });
  res._options = { ignoreCase: false, ignoreEol: true };
  editors[0].setValue('a\nb\nc');   // 编辑器非空，跳过占位符分支，真正进入渲染
  editors[1].setValue('a\nX\nc');
  var id = posted[posted.length - 1].id;
  workers[0].onmessage({ data: { id: id, result: res } });
  var Pdf = sandbox.PdfView;
  if (!Pdf || !Pdf.getHighlight) throw new Error('PdfView 应暴露 getHighlight');
  var mL = Pdf.getHighlight('L'), mR = Pdf.getHighlight('R');
  if (mL[2] !== 'ch') throw new Error('左侧第 2 行应为 ch，实际 ' + JSON.stringify(mL));
  if (mR[2] !== 'ch') throw new Error('右侧第 2 行应为 ch');
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
check('PDF 缩放：四个按钮接线且高亮互斥', function () {
  var Pdf = sandbox.PdfView;
  if (!Pdf || !Pdf.getMode) throw new Error('PdfView 应已加载');
  if (Pdf.getMode() !== 'auto') throw new Error('初始模式应为 auto，实际 ' + Pdf.getMode());
  if (!els['pdfAuto'].classList.contains('active')) throw new Error('初始自动缩放应高亮');
  els['pdfFitW'].dispatch('click');
  if (Pdf.getMode() !== 'width') throw new Error('点击适应宽度后模式应变 width');
  if (!els['pdfFitW'].classList.contains('active')) throw new Error('适应宽度按钮应高亮');
  if (els['pdfAuto'].classList.contains('active')) throw new Error('自动缩放应取消高亮');
  els['pdfActual'].dispatch('click');
  if (Pdf.getMode() !== 'actual') throw new Error('点击实际大小后模式应变 actual');
  if (els['pdfFitW'].classList.contains('active')) throw new Error('适应宽度应取消高亮');
  els['pdfAuto'].dispatch('click');
  if (Pdf.getMode() !== 'auto') throw new Error('点击自动缩放后模式应变 auto');
});
check('点 ＋ 新建空白对比窗口', function () {
  var T = sandbox.Tabs;
  if (!T || !T.getActive) throw new Error('Tabs 应已加载');
  if (T.getActive() !== 1) throw new Error('初始激活 tab 应为 1，实际 ' + T.getActive());
  if (T.getList().length !== 1) throw new Error('初始应有 1 个 tab');
  els['tabAdd'].dispatch('click');
  if (T.getList().length !== 2) throw new Error('点击 ＋ 后应有 2 个 tab');
  if (T.getActive() === 1) throw new Error('应切到新 tab');
  if (editors[0].getValue() !== '' || editors[1].getValue() !== '') throw new Error('新 tab 编辑器应为空');
});
check('tab 切换：各自保存/恢复编辑内容', function () {
  var T = sandbox.Tabs;
  var tab0 = T.getActive();
  if (tab0 !== 2) throw new Error('当前激活应为 2（上个用例新建），实际 ' + tab0);
  editors[0].setValue('AAAA');
  editors[1].setValue('BBBB');
  els['tabAdd'].dispatch('click');          // 新 tab3（空白）
  var tab1 = T.getActive();
  if (tab1 === tab0) throw new Error('应切到新 tab');
  editors[0].setValue('1111');
  editors[1].setValue('2222');
  T.setActive(tab0);                        // 切回 tab0
  if (editors[0].getValue() !== 'AAAA') throw new Error('tab0 左侧应恢复 AAAA，实际 ' + JSON.stringify(editors[0].getValue()));
  if (editors[1].getValue() !== 'BBBB') throw new Error('tab0 右侧应恢复 BBBB');
  T.setActive(tab1);                        // 切回 tab1
  if (editors[0].getValue() !== '1111') throw new Error('tab1 左侧应恢复 1111');
  if (editors[1].getValue() !== '2222') throw new Error('tab1 右侧应恢复 2222');
});
check('关闭 tab：激活的关后选邻居 / 非激活直接移除 / 最后一个拒绝', function () {
  var T = sandbox.Tabs;
  // 前置：上个用例结束后有 tab1/tab2/tab3，激活 tab3（下标 2）
  if (T.getList().length !== 3) throw new Error('前置应有 3 个 tab，实际 ' + T.getList().length);
  var tabsEl = els['tabs'];
  var stopEv = { stopPropagation: function () {} };
  // 关闭激活中的 tab3 → 应切到邻居 tab2
  tabsEl.children[2].children[1].dispatch('click', stopEv);
  if (T.getList().length !== 2) throw new Error('关闭后应有 2 个 tab，实际 ' + T.getList().length);
  if (T.getActive() !== 2) throw new Error('关闭激活 tab 后应激活邻居 tab2，实际 ' + T.getActive());
  // 关闭非激活 tab1 → 仅移除，激活不变
  tabsEl.children[0].children[1].dispatch('click', stopEv);
  if (T.getList().length !== 1) throw new Error('关闭非激活 tab 后应有 1 个 tab');
  if (T.getActive() !== 2) throw new Error('关闭非激活 tab 不应改变激活');
  // 最后一个 tab 拒绝关闭
  tabsEl.children[0].children[1].dispatch('click', stopEv);
  if (T.getList().length !== 1) throw new Error('最后一个 tab 应拒绝关闭');
  if (T.getActive() !== 2) throw new Error('拒绝关闭后激活不变');
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
check('清除按钮清空两侧编辑器', function () {
  editors[0].setValue('aaa');
  editors[1].setValue('bbb');
  els['clearBtn'].dispatch('click');
  if (editors[0].getValue() !== '') throw new Error('清除后左侧应为空');
  if (editors[1].getValue() !== '') throw new Error('清除后右侧应为空');
});
check('PDF 全屏：点击后在 appRoot 加 pdf-focus 且按钮变“还原”', function () {
  els['pdfFullscreen'].dispatch('click');
  if (!els['appRoot'].classList.contains('pdf-focus')) throw new Error('点击全屏后 appRoot 应含 pdf-focus');
  if (els['pdfFullscreen'].textContent !== '还原') throw new Error('全屏后按钮文字应变“还原”');
  els['pdfFullscreen'].dispatch('click');
  if (els['appRoot'].classList.contains('pdf-focus')) throw new Error('再次点击应移除 pdf-focus');
  if (els['pdfFullscreen'].textContent !== '全屏') throw new Error('还原后按钮文字应变“全屏”');
});
check('对比源：加载路径后 FilterBar 刷新不抛错（fetch 桩）', function () {
  els['srcPathInput'].value = '/tmp/对比源';
  els['srcLoadBtn'].dispatch('click');
  if (els['srcPathCur'].textContent !== '/tmp/对比源') throw new Error('当前路径应显示');
});
check('对比源：点击路径输入框弹出文件夹选择弹层', function () {
  els['srcPathInput'].dispatch('click');
  if (els['pickerMask'].hidden !== false) throw new Error('点击输入框应移除 hidden 属性打开弹层，实际=' + els['pickerMask'].hidden);
  els['pickCloseBtn'].dispatch('click');
  if (els['pickerMask'].hidden !== true) throw new Error('关闭后应重新置 hidden 属性');
});
check('文件夹选择：输入路径点击“加载”进入浏览不报错', function () {
  els['srcPathInput'].dispatch('click');            // 打开弹层
  els['pickerPath'].value = '/tmp/对比源/子文件夹';
  els['pickerGo'].dispatch('click');                // 点击“加载”
  if (!els['pickerErr'].classList.contains('hidden')) throw new Error('加载后不应报错');
  els['pickCancelBtn'].dispatch('click');           // 关闭，避免影响后续用例
});
check('隐藏/显示编辑区按钮切换', function () {
  els['toggleEditorsBtn'].dispatch('click');
  if (!els['editors'].classList.contains('hidden')) throw new Error('点击后编辑区应隐藏');
  if (els['toggleEditorsBtn'].textContent !== '显示编辑区') throw new Error('按钮文字应变“显示编辑区”');
  els['toggleEditorsBtn'].dispatch('click');
  if (els['editors'].classList.contains('hidden')) throw new Error('再次点击应显示编辑区');
  if (els['toggleEditorsBtn'].textContent !== '隐藏编辑区') throw new Error('按钮文字应变“隐藏编辑区”');
});
check('折叠/展开按钮：切换后 grid 渲染的折叠条随之变化', function () {
  // 用 5 行相同 → 折叠键 '0:4'（避开前面折叠行点击用例已展开的 '0:3'）
  var res = Compute.computeDiff({ left: 'x\nx\nx\nx\nx\ny', right: 'x\nx\nx\nx\nx\nz' });
  res._options = { ignoreCase: false, ignoreEol: true };
  editors[0].setValue('x\nx\nx\nx\nx\ny');     // 编辑器非空，跳过占位符分支
  editors[1].setValue('x\nx\nx\nx\nx\nz');
  var seqId = posted[posted.length - 1].id;   // 当前 seq，保证 onmessage 真正渲染
  workers[0].onmessage({ data: { id: seqId, result: res } });
  if (els['results'].innerHTML.indexOf('fold-bar') === -1) throw new Error('默认折叠态应含 fold-bar');
  els['foldBtn'].dispatch('click');           // 折叠 → 展开相同行
  if (els['foldBtn'].textContent !== '展开相同行') throw new Error('按钮文字应变“展开相同行”');
  if (els['results'].innerHTML.indexOf('fold-bar') !== -1) throw new Error('展开态不应含 fold-bar');
  els['foldBtn'].dispatch('click');           // 恢复折叠
  if (els['results'].innerHTML.indexOf('fold-bar') === -1) throw new Error('重新折叠后应含 fold-bar');
});
check('跨区域协同滚动：rebind 绑定桩元素不抛错', function () {
  var Sync = sandbox.SyncScroll;
  if (!Sync || !Sync.rebind) throw new Error('SyncScroll 应已加载');
  Sync.rebind([els['pdfLeft'], els['pdfRight']]);   // 桩元素无 removeEventListener，应被忽略
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
      // 文件选择立即响应：选非 PDF 文件 → fetch 微任务写入编辑区，再等一帧汇总
      els['fileSelL'].value = '/tmp/测试文档.txt';
      els['fileSelL'].dispatch('change');   // FilterBar change → onFileChange('L', path) → loadFileToSide
      setTimeout(function () {
        try {
          if (editors[0].getValue() !== '非PDF文件文本') {
            throw new Error('非 PDF 文件文本应进左侧编辑区，实际 ' + JSON.stringify(editors[0].getValue()));
          }
          passed++;
          console.log('  ok  文件选择：非 PDF 文本立即进编辑区');
        } catch (e2) {
          failed++;
          console.log('FAIL  文件选择立即响应\n      ' + e2.message);
        }
        // 选中子文件夹 → 默认填充 原始=第一个 / 修改=第二个 文件并自动渲染主区域
        els['fileSelL'].value = '';
        els['fileSelR'].value = '';
        els['dirSel'].value = '/tmp/对比源/子文件夹1';
        els['dirSel'].dispatch('change');
        setTimeout(function () {
          try {
            if (els['fileSelL'].value !== '/tmp/对比源/子文件夹1/a.txt' ||
                els['fileSelR'].value !== '/tmp/对比源/子文件夹1/b.txt') {
              throw new Error('原始/修改文件应默认成对填充，实际 L=' + els['fileSelL'].value + ' R=' + els['fileSelR'].value);
            }
            if (editors[0].getValue() !== '非PDF文件文本' || editors[1].getValue() !== '非PDF文件文本') {
              throw new Error('选中子文件夹后两侧应自动渲染，实际 L=' + JSON.stringify(editors[0].getValue())
                + ' R=' + JSON.stringify(editors[1].getValue()));
            }
            passed++;
            console.log('  ok  子文件夹：默认填充原始/修改文件并立即渲染');
          } catch (e3) {
            failed++;
            console.log('FAIL  子文件夹自动渲染\n      ' + e3.message);
          }
          // 主区域1 左右列协同滚动（flow 视图 leftBody/rightBody）
          var lb = els['leftBody'], rb = els['rightBody'];
          lb.scrollHeight = 200; lb.clientHeight = 100; lb.scrollTop = 0;
          rb.scrollHeight = 200; rb.clientHeight = 100; rb.scrollTop = 0;
          lb.scrollTop = 50;
          lb.dispatch('scroll');
          setTimeout(function () {
            try {
              if (Math.abs(rb.scrollTop - 50) > 0.5) {
                throw new Error('右列应同步到 50，实际 ' + rb.scrollTop);
              }
              passed++;
              console.log('  ok  协同滚动：区域1 左列滚动带动右列');
            } catch (e4) {
              failed++;
              console.log('FAIL  区域1 协同滚动\n      ' + e4.message);
            }
            console.log('\n' + passed + ' passed, ' + failed + ' failed');
            process.exit(failed ? 1 : 0);
          }, 40);
        }, 40);
      }, 0);
    }, 600);
  } catch (e) {
    failed++;
    console.log('FAIL  端到端忽略换行链路（外层）\n      ' + e.message);
    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    process.exit(1);
  }
}, 0);