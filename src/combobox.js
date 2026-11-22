/**
 * combobox.js — 可搜索下拉选择框（Searchable Combobox）。
 * 职责：替代原生 <select> 在选项极多时的慢渲染——输入框实时过滤，
 * 下拉列表只渲染命中项（上限 MAX 行，超出仅提示），点击 / 回车选中，↑/↓ 可导航，Esc 关闭。
 * 挂载后宿主元素保留 .value / .options / _setOpts 契约，用户选中时派发可冒泡 change，
 * 使 filterbar.js / app.js / 既有测试无需改动即可继续工作。
 * 不依赖 app.js / filterbar（低耦合，按需引入）。
 * 全局暴露：Combobox
 *
 * Combobox.attach(hostEl, settings) → boolean
 *   hostEl 形如 <span class="cb" id="..." data-placeholder="搜索…"></span>，
 *   挂载后内部生成 <input class="cb-input"> + <ul class="cb-list">。
 *   选项格式 {value, label}：value 为绝对路径等唯一键，label 为显示名。
 *   settings.chips = true 时启用「胶囊」模式：每按一次空格，输入框里已输入的词就固化成
 *   一个可删除的小标签（胶囊），胶囊与正在输入的词一起参与过滤（逻辑 AND）。
 */
(function (root) {
  'use strict';

  var MAX = 100;   // 列表最多渲染行数：超过只提示，靠输入继续过滤（避免巨量 DOM 拖慢渲染）

  /**
   * @param {Element} host  目标容器（含 .cb 类）
   * @returns {boolean} 是否成功挂载（重复挂载 / 非容器返回 false）
   */
  function attach(host, settings) {
    if (!host || host._setOpts) return false;
    settings = settings || {};
    var useChips = !!settings.chips;   // 胶囊模式：空格把已输入的关键词固化下来

    var opts = [];          // [{value,label,text?}]
    var value = '';         // 当前选中 value
    var q = '';             // 过滤关键字（独立于输入框显示文本）
    var chips = [];         // 已固化的过滤关键词（胶囊），与 q 一起参与匹配
    var userTyped = false;   // 输入框里当前内容是否为用户敲的（而非选中的文件名）
    var composing = false;   // 输入法是否正在组字（compositionstart ~ compositionend 之间）
    var hi = 0;             // 键盘高亮索引（相对当前渲染行）
    var stickyFree = '';    // 自由文本提交后的“不在选项里”的 value（网址/快照路径）
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
    // 胶囊模式：输入框与已固化的关键词放在同一个可换行的盒子里（共用一条边框）
    var box = null;
    if (useChips) {
      if (host.classList && host.classList.add) host.classList.add('cb-chips');
      box = document.createElement('span');
      box.className = 'cb-box';
      host.appendChild(box);
      box.appendChild(input);
    } else {
      host.appendChild(input);
    }
    var list = document.createElement('ul');
    list.className = 'cb-list';
    list.hidden = true;
    host.appendChild(list);

    function labelOf(v) {
      if (v && v === stickyFree) return stickyFree;
      for (var i = 0; i < opts.length; i++) if (opts[i].value === v) return opts[i].label;
      return '';
    }
    /** 输入框显示当前选中项名称（无选中为空，占位符兜底） */
    function refreshInput() {
      input.value = labelOf(value);
      userTyped = false;      // 显示的是选中的文件名，不是用户敲的过滤词
    }

    /**
     * 空格分词 = 逻辑 AND：多个词全部命中才保留。
     * 为什么不做“整串子串匹配”：文件名往往带“品种 + 产地 + 标准类型”，
     * 用户能记住的是零散关键词（“上海 团”），整串匹配会一个都命中不了。
     */
    function terms() {
      var out = chips.map(function (c) { return String(c).toLowerCase(); });
      var t = String(q || '').toLowerCase();
      if (t) out = out.concat(t.split(/\s+/).filter(Boolean));
      return out;
    }

    /** 渲染胶囊：已固化的关键词各一个标签，带删除按钮 */
    function renderChips() {
      if (!useChips || !box) return;
      var old = box.querySelectorAll ? box.querySelectorAll('.cb-chip') : [];
      for (var i = 0; i < old.length; i++) {
        if (old[i].remove) old[i].remove();
        else if (old[i].parentNode && old[i].parentNode.removeChild) old[i].parentNode.removeChild(old[i]);
      }
      chips.forEach(function (word, idx) {
        var chip = document.createElement('span');
        chip.className = 'cb-chip';
        var label = document.createElement('span');
        label.className = 'cb-chip-label';
        label.textContent = word;
        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'cb-chip-x';
        del.title = '删除该关键词';
        del.textContent = '×';
        del.setAttribute('aria-label', '删除关键词 ' + word);
        // mousedown preventDefault：避免点击删除时输入框失焦导致列表关闭
        del.addEventListener('mousedown', function (ev) { if (ev && ev.preventDefault) ev.preventDefault(); });
        del.addEventListener('click', function () { removeChip(idx); });
        chip.appendChild(label);
        chip.appendChild(del);
        if (box.insertBefore) box.insertBefore(chip, input);
        else box.appendChild(chip);
      });
    }

    /** 删掉一个胶囊并重新过滤 */
    function removeChip(idx) {
      chips.splice(idx, 1);
      q = '';
      input.value = '';
      renderChips();
      hi = 0;
      render();
      if (list.hidden) list.hidden = false;
    }

    /**
     * 空格：把当前输入框里的内容固化成胶囊（胶囊模式）。
     * 为什么这样切：文件名往往带“品种 + 产地 + 标准类型”，用户能记住的是零散关键词；
     * 把已输入的词固化成胶囊，既看得见已经加了哪几个条件（可逐个删），
     * 又不影响继续输入下一个词。
     */
    function commitChip() {
      var word = String(input.value || '').trim();
      if (!word) return false;
      // 一次可能敲进多个词（粘贴含空格的内容）：逐个拆成胶囊
      var parts = word.split(/\s+/).filter(Boolean);
      for (var i = 0; i < parts.length; i++) {
        if (chips.indexOf(parts[i]) === -1) chips.push(parts[i]);
      }
      input.value = '';
      q = '';
      renderChips();
      hi = 0;
      render();
      if (list.hidden) list.hidden = false;
      return true;
    }

    function hit(opt, word) {
      return (opt.label && opt.label.toLowerCase().indexOf(word) !== -1) ||
             (opt.value && opt.value.toLowerCase().indexOf(word) !== -1);
    }

    function matched() {
      var list = terms();
      if (!list.length) return opts;
      return opts.filter(function (o) {
        for (var i = 0; i < list.length; i++) if (!hit(o, list[i])) return false;
        return true;
      });
    }

    /** 当前输入框里正在输入的原文（未选中时就是过滤词） */
    function typed() { return String(input.value || '').trim(); }

    /**
     * 自由文本提交：没有命中项时，把输入原文当 value 提交。
     * 过滤词不认网址语义——该不该算“可加载的源”由宿主注入的 host._freeText 判定，
     * 否则模块会为了一个正则把 Pipeline 的职责搬到这里。
     */
    function commitTyped() {
      if (typeof host._freeText !== 'function') return false;
      var raw = typed();
      if (!raw) return false;
      var ref = host._freeText(raw);
      if (!ref) return false;
      stickyFree = String(ref);          // 不在选项里，但要挺过 _setOpts 重建
      select({ value: stickyFree, label: stickyFree });
      return true;
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
      q = '';      // 聚焦即浏览全部：清空上次过滤（胶囊保留：那才是用户要的条件）
      hi = 0;
      renderChips();
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
      chips = [];          // 已选中的文件不再需要过滤条件
      hi = 0;
      renderChips();
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
      userTyped = true;
      if (list.hidden) { hi = 0; render(); list.hidden = false; }
      else { hi = 0; render(); }
    });
    // ---------- 输入法（IME）组字 ----------
    // 拼音输入法用空格选字：组字期间 input.value 还是拼音串，必须让空格原样过去，
    // 否则会把拼音当成关键词固化成胶囊（“guang'dong”而不是“广东”）。
    input.addEventListener('compositionstart', function () { composing = true; });
    input.addEventListener('compositionend', function () {
      composing = false;
      // 选字完成：此时拿到的才是真实文字（如「广东」），重新过滤一次
      q = input.value;
      userTyped = true;
      if (list.hidden) { hi = 0; render(); list.hidden = false; }
      else { hi = 0; render(); }
    });
    input.addEventListener('keydown', function (ev) {
      var key = ev.key;
      if (key === 'ArrowDown') { ev.preventDefault(); move(1); }
      else if (key === 'ArrowUp') { ev.preventDefault(); move(-1); }
      else if (key === ' ' || key === 'Spacebar' || key === '\u3000') {
        // 胶囊模式：空格 = 把已输入的词固化成胶囊（而不是普通分隔符）
        // ⚠️ 输入法组字期间必须把空格让给输入法：拼音输入法用空格选字，
        //    这时 input.value 还是拼音串（如 guang'dong），若此时固化胶囊就会把拼音当关键词。
        //    两个信号一起看：ev.isComposing 是 keydown 自带的组字标记，
        //    composing 是 compositionstart/end 维护的状态（兼容 isComposing 不可靠的浏览器）。
        var imeComposing = !!(ev && ev.isComposing) || composing;
        if (useChips && userTyped && !imeComposing && String(input.value || '').trim()) {
          ev.preventDefault();
          commitChip();
        }
      }
      else if (key === 'Enter') {
        ev.preventDefault();
        if (!list.hidden && rows[hi]) select(rows[hi].opt);
        else commitTyped();   // 无命中/列表未开：输入原文就当网址/路径提交
      }
      else if (key === 'Escape') {
        ev.preventDefault();
        q = ''; hi = 0; refreshInput(); close();
      }
      else if (key === 'Tab') {
        if (!list.hidden && rows[hi]) { ev.preventDefault(); select(rows[hi].opt); }
      }
      else if (key === 'Backspace' && useChips && !input.value && chips.length) {
        // 输入框空了再按退格：删掉最后一个胶囊（比逐个删更快）
        ev.preventDefault();
        removeChip(chips.length - 1);
      }
    });
    input.addEventListener('blur', function () {
      composing = false;   // 组字中途失焦可能收不到 compositionend，兜底复位，否则空格永远被当成选字
      scheduleClose();
    });

    // ---- 宿主契约（对齐原生 <select> 的读取方式）----
    Object.defineProperty(host, 'value', {
      get: function () { return value; },
      /**
       * 直接赋值（宿主恢复标签页、左右互换时用）：落在选项里就正常显示 label；
       * 落在选项外（网址 / 快照路径）就登记为自由文本并原样显示，
       * 否则输入框会变成空的——用户看到的是“网址丢了”，而实际还在 value 里。
       */
      set: function (v) {
        value = v || '';
        if (value && !opts.some(function (o) { return o.value === value; })) stickyFree = value;
        else if (!value || value !== stickyFree) stickyFree = '';
        refreshInput();
      },
      configurable: true
    });
    Object.defineProperty(host, 'options', {
      get: function () { return opts; },
      configurable: true
    });
    host._setOpts = function (items) {
      opts = (items || []).map(function (it) { return { value: it.value, label: it.label, text: it.text }; });
      // 当前选中若已不在列表中则清空（与原生 select 重建行为一致）；在列表中则保留。
      // 自由文本选中的网址不在列表里，但它是用户刚输入的意图，不能因列表重建被抹掉。
      if (value && value !== stickyFree && !opts.some(function (o) { return o.value === value; })) {
        value = '';
        stickyFree = '';
      }
      refreshInput();
      if (!list.hidden) render();
    };
    /** 注入“自由文本是否算合法源”的判定（宿主决定语义，控件只负责拿原文） */
    host._setFreeText = function (fn) {
      host._freeText = typeof fn === 'function' ? fn : null;
    };

    return true;
  }

  root.Combobox = { attach: attach };
})(typeof self !== 'undefined' ? self : this);
