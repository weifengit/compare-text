/**
 * tabs.js — 顶部第一行多标签页（多开对比窗口）。
 * 职责：只管理标签栏 DOM 与 增/删/切换 的用户操作，把事件转成回调交给 app.js；
 * 每个标签要保存/恢复的状态由 app.js 通过回调维护（低耦合）。
 * 不依赖 app.js / filterbar / pdfview。全局暴露：Tabs
 *
 * Tabs.init({ listEl, addBtn, onAdd, onSwitch, onClose })
 *   listEl/addBtn   标签容器 / “＋”按钮
 *   onSwitch(id)    切到某标签（id 与当前激活不同才触发；程序化 setActive 同样触发）
 *   onAdd()         点“＋”
 *   onClose(id)     点某标签的 ×
 * Tabs.setList([{id,title}])   // 渲染标签列表（不含 ＋，＋ 挂在 addBtn 上）
 * Tabs.setActive(id)           // 激活标签（id 变化时触发 onSwitch）—— 切换逻辑的单一入口
 * Tabs.getActive()/getList()   // 供断言 / 外部读取
 */
(function (root) {
  'use strict';

  var els = { list: null, add: null };
  var handlers = { onAdd: null, onSwitch: null, onClose: null };
  var tabs = [];        // [{id, title}]
  var activeId = null;

  function render() {
    if (!els.list) return;
    els.list.innerHTML = '';
    for (var i = 0; i < tabs.length; i++) {
      (function (t) {
        var el = document.createElement('div');
        el.className = 'tab' + (t.id === activeId ? ' active' : '');
        el.setAttribute('data-id', t.id);
        var title = document.createElement('span');
        title.className = 'tab-title';
        title.textContent = t.title;
        el.appendChild(title);
        var close = document.createElement('button');
        close.className = 'tab-close';
        close.type = 'button';
        close.textContent = '×';
        close.title = '关闭此对比';
        close.addEventListener('click', function (ev) {
          ev.stopPropagation();
          if (handlers.onClose) handlers.onClose(t.id);
        });
        el.appendChild(close);
        el.addEventListener('click', function () { setActive(t.id); });
        els.list.appendChild(el);
      })(tabs[i]);
    }
  }

  function setActive(id) {
    if (id === activeId) return;
    activeId = id;
    render();
    if (handlers.onSwitch) handlers.onSwitch(id);
  }

  function init(c) {
    els.list = (c && c.listEl) || null;
    els.add = (c && c.addBtn) || null;
    handlers.onAdd = (c && c.onAdd) || null;
    handlers.onSwitch = (c && c.onSwitch) || null;
    handlers.onClose = (c && c.onClose) || null;
    if (els.add) els.add.addEventListener('click', function () { if (handlers.onAdd) handlers.onAdd(); });
  }

  function setList(list) { tabs = (list || []).slice(); render(); }
  function getActive() { return activeId; }
  function getList() {
    return tabs.map(function (t) { return { id: t.id, title: t.title }; });
  }

  root.Tabs = { init: init, setList: setList, setActive: setActive, getActive: getActive, getList: getList };
})(typeof self !== 'undefined' ? self : this);
