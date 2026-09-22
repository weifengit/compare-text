/**
 * combobox.js — 可搜索下拉选择框（Searchable Combobox）。
 * 职责：替代原生 <select> 在选项极多时的慢渲染——输入框实时过滤，
 * 下拉列表只渲染命中项（上限 MAX 行，超出仅提示），点击 / 回车选中，↑/↓ 可导航，Esc 关闭。
 * 挂载后宿主元素保留 .value / .options / _setOpts 契约，用户选中时派发可冒泡 change，
 * 使 filterbar.js / app.js / 既有测试无需改动即可继续工作。
 * 不依赖 app.js / filterbar（低耦合，按需引入）。
 * 全局暴露：Combobox
 *
 * Combobox.attach(hostEl) → boolean
 *   hostEl 形如 <span class="cb" id="..." data-placeholder="搜索…"></span>，
 *   挂载后内部生成 <input class="cb-input"> + <ul class="cb-list">。
 *   选项格式 {value, label}：value 为绝对路径等唯一键，label 为显示名。
 */
(function (root) {
  'use strict';

  var MAX = 100;   // 列表最多渲染行数：超过只提示，靠输入继续过滤（避免巨量 DOM 拖慢渲染）

  /**
   * @param {Element} host  目标容器（含 .cb 类）
   * @returns {boolean} 是否成功挂载（重复挂载 / 非容器返回 false）
   */
  function attach(host) {
    if (!host || host._setOpts) return false;

    var opts = [];          // [{value,label,text?}]
    var value = '';         // 当前选中 value
    var q = '';             // 过滤关键字（独立于输入框显示文本）
    var hi = 0;             // 键盘高亮索引（相对当前渲染行）
    var rows = [];          // 当前渲染行 [{opt, el}]
    var closeTimer = null;

    // ---- 内部 DOM ----
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'cb-input';
    input.autocomplete = 'off';
    input.spellcheck = false;
    var ph = host.getAttribute && host.getAttribute('data-placeholder');
    if (ph) input.placeholder = ph;
    host.appendChild(input);

    var list = document.createElement('ul');
    list.className = 'cb-list';
    list.hidden = true;
    host.appendChild(list);

    function labelOf(v) {
      for (var i = 0; i < opts.length; i++) if (opts[i].value === v) return opts[i].label;
      return '';
    }
    /** 输入框显示当前选中项名称（无选中为空，占位符兜底） */
    function refreshInput() {
      input.value = labelOf(value);
    }

    function matched() {
      var t = q.toLowerCase();
      if (!t) return opts;
      return opts.filter(function (o) {
        return (o.label && o.label.toLowerCase().indexOf(t) !== -1) ||
               (o.value && o.value.toLowerCase().indexOf(t) !== -1);
      });
    }

    function applyActive() {
      for (var i = 0; i < rows.length; i++) rows[i].el.classList.toggle('active', i === hi);
    }

    function render() {
      list.textContent = '';
      rows = [];
      var m = matched();
      var shown = m.slice(0, MAX);
      for (var i = 0; i < shown.length; i++) {
        (function (opt, idx) {
          var li = document.createElement('li');
          li.className = 'cb-row';
          li.textContent = opt.label;
          // mousedown preventDefault：避免点击项时输入框失焦导致 blur 关闭列表
          li.addEventListener('mousedown', function (ev) { if (ev && ev.preventDefault) ev.preventDefault(); });
          li.addEventListener('click', function () { select(opt); });
          list.appendChild(li);
          rows.push({ opt: opt, el: li });
        })(shown[i], i);
      }
      if (!shown.length) {
        var empty = document.createElement('li');
        empty.className = 'cb-empty';
        empty.textContent = '（无匹配项）';
        list.appendChild(empty);
      } else if (m.length > MAX) {
        var more = document.createElement('li');
        more.className = 'cb-more';
        more.textContent = '… 共 ' + m.length + ' 项，继续输入过滤';
        list.appendChild(more);
      }
      if (hi >= shown.length) hi = Math.max(0, shown.length - 1);
      if (hi < 0) hi = 0;
      applyActive();
    }

    function open() {
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
      q = '';      // 聚焦即浏览全部：清空上次过滤
      hi = 0;
      render();
      list.hidden = false;
      if (value && input.select) input.select();   // 已有选中：全选文本，输入即替换
    }

    function close() {
      list.hidden = true;
    }
    function scheduleClose() {
      if (closeTimer) clearTimeout(closeTimer);
      closeTimer = setTimeout(close, 150);   // 延迟关闭，让列表项 click 先完成
    }

    function select(opt) {
      value = opt.value;
      q = '';
      hi = 0;
      refreshInput();
      close();
      // 派发可冒泡 change：filterbar 通过 addEventListener('change') 接收
      var ev;
      try { ev = new CustomEvent('change', { bubbles: true }); }
      catch (e) { ev = { type: 'change', bubbles: true }; }
      if (host.dispatchEvent) host.dispatchEvent(ev);
      else if (host.dispatch) host.dispatch('change');
    }

    function move(delta) {
      if (list.hidden || !rows.length) return;
      hi = Math.max(0, Math.min(rows.length - 1, hi + delta));
      applyActive();
      if (rows[hi].el.scrollIntoView) rows[hi].el.scrollIntoView({ block: 'nearest' });
    }

    input.addEventListener('focus', open);
    input.addEventListener('input', function () {
      q = input.value;
      if (list.hidden) { hi = 0; render(); list.hidden = false; }
      else { hi = 0; render(); }
    });
    input.addEventListener('keydown', function (ev) {
      var key = ev.key;
      if (key === 'ArrowDown') { ev.preventDefault(); move(1); }
      else if (key === 'ArrowUp') { ev.preventDefault(); move(-1); }
      else if (key === 'Enter') {
        ev.preventDefault();
        if (!list.hidden && rows[hi]) select(rows[hi].opt);
      }
      else if (key === 'Escape') {
        ev.preventDefault();
        q = ''; hi = 0; refreshInput(); close();
      }
      else if (key === 'Tab') {
        if (!list.hidden && rows[hi]) { ev.preventDefault(); select(rows[hi].opt); }
      }
    });
    input.addEventListener('blur', scheduleClose);

    // ---- 宿主契约（对齐原生 <select> 的读取方式）----
    Object.defineProperty(host, 'value', {
      get: function () { return value; },
      set: function (v) { value = v || ''; refreshInput(); },
      configurable: true
    });
    Object.defineProperty(host, 'options', {
      get: function () { return opts; },
      configurable: true
    });
    host._setOpts = function (items) {
      opts = (items || []).map(function (it) { return { value: it.value, label: it.label, text: it.text }; });
      // 当前选中若已不在列表中则清空（与原生 select 重建行为一致）；在列表中则保留
      if (value && !opts.some(function (o) { return o.value === value; })) value = '';
      refreshInput();
      if (!list.hidden) render();
    };

    return true;
  }

  root.Combobox = { attach: attach };
})(typeof self !== 'undefined' ? self : this);
