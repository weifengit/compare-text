/**
 * xlsxconfig.js — Excel 对比配置弹窗（多 sheet 勾选 + 表头行范围 + 键列 + 预览）。
 * 交互骨架沿用 aibg 的 renderSheetConfig：每个 sheet 一张卡片，顶部一条 sheet 开关栏。
 * 相对 aibg 的改进：
 *   - 表头是**行号范围**（起止两格），对齐"多行表头"的真实报表；
 *   - 每张卡片的预览同时显示新旧两侧，便于确认"这份表头对不对";
 *   - 键列按当前表头行实时重算（改表头行 → 列名跟着变）。
 *
 * 全局暴露：XlsxConfig
 * XlsxConfig.open({ config, onConfirm })   config = XlsxFlow.configure() 的返回
 * XlsxConfig.close()
 * XlsxConfig.isOpen()
 */
(function (root) {
  'use strict';

  var cfg = { onConfirm: null };
  var els = { mask: null, body: null, ok: null, cancel: null, close: null, title: null };
  var current = null;      // 当前编辑中的配置（深拷贝，取消不改原对象）
  var open = false;

  function $(id) { return document.getElementById(id); }

  function escHtml(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function init() {
    els.mask = $('xlsxCfgMask');
    els.body = $('xlsxCfgBody');
    els.ok = $('xlsxCfgOk');
    els.cancel = $('xlsxCfgCancel');
    els.close = $('xlsxCfgClose');
    els.title = $('xlsxCfgTitle');
    if (!els.mask) return;

    if (els.cancel) els.cancel.addEventListener('click', close);
    if (els.close) els.close.addEventListener('click', close);
    if (els.ok) els.ok.addEventListener('click', confirm);
    // 点遮罩关闭（但点弹窗本体不关）
    els.mask.addEventListener('click', function (ev) {
      if (ev.target === els.mask) close();
    });
    document.addEventListener('keydown', function (ev) {
      if (!open) return;
      if (ev.key === 'Escape') close();
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) confirm();
    });
  }

  function isOpen() { return open; }

  /** 打开配置弹窗：config 是 XlsxFlow.configure() 的结果 */
  function openWith(config, onConfirm) {
    if (!els.mask) init();
    if (!els.mask) return;
    current = deepClone(config) || {};
    cfg.onConfirm = onConfirm || null;
    open = true;
    els.mask.hidden = false;
    // 先建顶部开关栏，再渲染每张卡片
    var names = Object.keys(current);
    if (els.title) els.title.textContent = '表格对比配置（' + names.length + ' 个 Sheet）';
    els.body.innerHTML = '';

    var head = document.createElement('div');
    head.className = 'xc-sheetbar';
    head.innerHTML = '<span class="xc-bar-label">参与对比：</span>' +
      '<button type="button" class="btn xc-all" data-act="all">全选</button>' +
      '<button type="button" class="btn xc-all" data-act="none">全不选</button>';
    var bar = document.createElement('div');
    bar.className = 'xc-bar-items';
    names.forEach(function (n) {
      var c = current[n] || {};
      var on = c.enabled !== false;
      var lbl = document.createElement('label');
      lbl.className = 'xc-bar-item' + (on ? '' : ' off');
      lbl.innerHTML = '<input type="checkbox" data-sheet="' + escHtml(n) + '"' + (on ? ' checked' : '') + '> ' +
        '<span>' + escHtml(n) + '</span>';
      bar.appendChild(lbl);
    });
    head.appendChild(bar);
    els.body.appendChild(head);

    var cards = document.createElement('div');
    cards.className = 'xc-cards';
    els.body.appendChild(cards);

    names.forEach(function (name) {
      cards.appendChild(cardHtml(name, current[name] || {}));
    });

    bind();
    return open;
  }

  function deepClone(o) {
    try { return JSON.parse(JSON.stringify(o)); } catch (e) { return o; }
  }

  /** 从预览里按表头行取列名（去重、去空） */
  function columnsOf(preview, headerStart, headerEnd) {
    if (!preview || !preview.length) return [];
    var hs = Math.max(1, headerStart || 1);
    var he = Math.max(hs, headerEnd || hs);
    var maxCol = 0;
    preview.forEach(function (r) { if (r.length > maxCol) maxCol = r.length; });
    var out = [], seen = {};
    for (var c = 0; c < maxCol; c++) {
      var parts = [];
      for (var r = hs - 1; r < he && r < preview.length; r++) {
        var v = preview[r] && preview[r][c];
        if (v === null || v === undefined) continue;
        var t = String(v).trim();
        if (t) parts.push(t);
      }
      var name = parts.length ? parts.join(' / ') : '';
      if (!name || seen[name]) continue;
      seen[name] = true;
      out.push(name);
    }
    return out;
  }

  /** 渲染一张 sheet 的配置卡片 */
  function cardHtml(name, c) {
    var on = c.enabled !== false;
    var hs = c.headerStart || 1;
    var he = c.headerEnd || hs;
    var preview = c._preview || c._oldPreview || [];
    var oldPreview = c._oldPreview || [];
    var cols = columnsOf(preview, hs, he);
    var keyCols = c.keyColumns || [];

    var rowCount = c._rowCount || 0;
    var colCount = c._columnCount || 0;
    var onlyOld = !!c._onlyOld;

    var card = document.createElement('div');
    card.className = 'xc-card' + (on ? '' : ' disabled');
    card.setAttribute('data-sheet', name);
    card.innerHTML =
      '<div class="xc-cardhead">' +
        '<label class="xc-en"><input type="checkbox" class="xc-en-cb"' + (on ? ' checked' : '') + '> ' +
          '<strong class="xc-title">' + escHtml(name) + '</strong></label>' +
        (onlyOld ? '<span class="xc-onlyold" title="该 Sheet 只存在于旧文件，将整表记为删除">仅旧文件有</span>' : '') +
        '<span class="xc-dim">' + rowCount + ' 行 × ' + colCount + ' 列</span>' +
        '<span class="xc-hdr">表头行 <input type="number" class="xc-num xc-hs" min="1" step="1" value="' + hs + '">' +
          ' <span class="xc-to">至</span> ' +
          '<input type="number" class="xc-num xc-he" min="1" step="1" value="' + he + '"></span>' +
      '</div>' +
      '<div class="xc-cardbody">' +
        '<div class="xc-section">' +
          '<div class="xc-hint">键列（可多选 → 拼成复合键；全不选则自动识别，识别不到退化为整行哈希）：</div>' +
          '<div class="xc-keys">' + keyColsHtml(cols, keyCols) + '</div>' +
        '</div>' +
        '<div class="xc-section">' +
          '<div class="xc-hint">预览（新文件前 6 行）：</div>' +
          '<div class="xc-preview">' + previewHtml(preview, hs, he, 6) + '</div>' +
        '</div>' +
        (oldPreview.length ? '<div class="xc-section">' +
          '<div class="xc-hint">预览（旧文件前 3 行）：</div>' +
          '<div class="xc-preview">' + previewHtml(oldPreview, hs, he, 3) + '</div>' +
        '</div>' : '') +
      '</div>';
    return card;
  }

  function keyColsHtml(cols, selected) {
    if (!cols.length) return '<span class="xc-empty">该表头行没有可用列名，请调整表头行</span>';
    var h = '';
    cols.forEach(function (col) {
      var on = selected.indexOf(col) >= 0;
      h += '<label class="xc-key' + (on ? ' on' : '') + '">' +
        '<input type="checkbox" class="xc-key-cb" value="' + escHtml(col) + '"' + (on ? ' checked' : '') + '> ' +
        '<span>' + escHtml(col) + '</span></label>';
    });
    return h;
  }

  function previewHtml(preview, hs, he, maxRows) {
    if (!preview || !preview.length) return '<span class="xc-empty">（无预览数据）</span>';
    var rows = preview.slice(0, Math.min(maxRows, preview.length));
    var maxCol = 0;
    rows.forEach(function (r) { if (r.length > maxCol) maxCol = r.length; });
    // 列多时截断展示，避免横向撑爆弹窗
    var showCols = Math.min(maxCol, 14);
    var h = '<table class="xc-table"><tbody>';
    rows.forEach(function (r, ri) {
      var rowNo = ri + 1;
      var isHdr = rowNo >= hs && rowNo <= he;
      var above = rowNo < hs;
      var cls = isHdr ? ' class="xc-tr-hd"' : (above ? ' class="xc-tr-above"' : '');
      h += '<tr' + cls + '>';
      h += '<td class="xc-rownum">' + rowNo + '</td>';
      for (var c = 0; c < showCols; c++) {
        var v = r[c];
        var t = v === null || v === undefined ? '' : String(v);
        if (t.length > 24) t = t.slice(0, 24) + '…';
        h += '<td title="' + escHtml(v === null || v === undefined ? '' : String(v)) + '">' + escHtml(t) + '</td>';
      }
      if (maxCol > showCols) h += '<td class="xc-more">…共 ' + maxCol + ' 列</td>';
      h += '</tr>';
    });
    h += '</tbody></table>';
    if (preview.length > rows.length) {
      h += '<div class="xc-more-rows">… 仅显示前 ' + rows.length + ' 行</div>';
    }
    return h;
  }

  /** 绑定卡片内的事件（表头行改 → 键列重算；勾选 → 启用态） */
  function bind() {
    var body = els.body;
    if (!body) return;

    // 顶部全选/全不选
    var acts = body.querySelectorAll('[data-act]');
    for (var i = 0; i < acts.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var want = btn.getAttribute('data-act') === 'all';
          var bars = body.querySelectorAll('.xc-bar-item input');
          for (var k = 0; k < bars.length; k++) {
            bars[k].checked = want;
            syncEnabled(bars[k].getAttribute('data-sheet'), want);
          }
        });
      })(acts[i]);
    }

    // 顶部开关栏
    var barCbs = body.querySelectorAll('.xc-bar-item input');
    for (var j = 0; j < barCbs.length; j++) {
      (function (cb) {
        cb.addEventListener('change', function () {
          syncEnabled(cb.getAttribute('data-sheet'), cb.checked);
        });
      })(barCbs[j]);
    }

    // 卡片头开关
    var enCbs = body.querySelectorAll('.xc-en-cb');
    for (var m = 0; m < enCbs.length; m++) {
      (function (cb) {
        cb.addEventListener('change', function () {
          var card = cb.closest('.xc-card');
          var name = card.getAttribute('data-sheet');
          syncEnabled(name, cb.checked);
        });
      })(enCbs[m]);
    }

    // 表头行范围 → 重算键列
    var cards = body.querySelectorAll('.xc-card');
    for (var n = 0; n < cards.length; n++) {
      (function (card) {
        var name = card.getAttribute('data-sheet');
        var hsEl = card.querySelector('.xc-hs');
        var heEl = card.querySelector('.xc-he');
        function onHdrChange() {
          var c = current[name] || {};
          var hs = Math.max(1, parseInt(hsEl.value, 10) || 1);
          var he = Math.max(hs, parseInt(heEl.value, 10) || hs);
          hsEl.value = hs; heEl.value = he;
          c.headerStart = hs; c.headerEnd = he;
          var cols = columnsOf(c._preview || c._oldPreview || [], hs, he);
          // 保留仍然存在的已选键列
          c.keyColumns = (c.keyColumns || []).filter(function (x) { return cols.indexOf(x) >= 0; });
          var box = card.querySelector('.xc-keys');
          box.innerHTML = keyColsHtml(cols, c.keyColumns);
          bindKeys(card, name);
        }
        if (hsEl) hsEl.addEventListener('change', onHdrChange);
        if (heEl) heEl.addEventListener('change', onHdrChange);
        bindKeys(card, name);
      })(cards[n]);
    }
  }

  function bindKeys(card, name) {
    var cbs = card.querySelectorAll('.xc-key-cb');
    for (var i = 0; i < cbs.length; i++) {
      (function (cb) {
        cb.addEventListener('change', function () {
          var c = current[name] || (current[name] = {});
          if (!c.keyColumns) c.keyColumns = [];
          var v = cb.getAttribute('value') || cb.value;
          var at = c.keyColumns.indexOf(v);
          if (cb.checked && at < 0) c.keyColumns.push(v);
          if (!cb.checked && at >= 0) c.keyColumns.splice(at, 1);
          var lbl = cb.closest('.xc-key');
          if (lbl) lbl.classList.toggle('on', cb.checked);
        });
      })(cbs[i]);
    }
  }

  /** 同步"启用/禁用"到卡片、顶部栏与配置对象 */
  function syncEnabled(name, on) {
    if (!current[name]) return;
    current[name].enabled = !!on;
    var card = els.body.querySelector('.xc-card[data-sheet="' + cssEscape(name) + '"]');
    // querySelector 的属性选择器对中文没问题，但含引号/方括号的 sheet 名需要转义
    if (!card) {
      var all = els.body.querySelectorAll('.xc-card');
      for (var i = 0; i < all.length; i++) {
        if (all[i].getAttribute('data-sheet') === name) { card = all[i]; break; }
      }
    }
    if (card) {
      card.classList.toggle('disabled', !on);
      var title = card.querySelector('.xc-title');
      if (title) title.style.opacity = on ? '1' : '0.4';
      var en = card.querySelector('.xc-en-cb');
      if (en) en.checked = !!on;
    }
    var bars = els.body.querySelectorAll('.xc-bar-item input');
    for (var k = 0; k < bars.length; k++) {
      if (bars[k].getAttribute('data-sheet') === name) {
        bars[k].checked = !!on;
        var item = bars[k].closest('.xc-bar-item');
        if (item) item.classList.toggle('off', !on);
      }
    }
  }

  /** 属性选择器转义（sheet 名里可能有引号、方括号等） */
  function cssEscape(s) {
    return String(s).replace(/["\\]/g, '\\$&');
  }

  function confirm() {
    if (!current) { close(); return; }
    // 只把业务字段交出去，去掉 _preview 这类临时数据
    var out = {};
    Object.keys(current).forEach(function (n) {
      var c = current[n] || {};
      out[n] = {
        enabled: c.enabled !== false,
        headerStart: c.headerStart || 1,
        headerEnd: c.headerEnd || c.headerStart || 1,
        keyColumns: (c.keyColumns || []).slice()
      };
    });
    var cb = cfg.onConfirm;
    close();
    if (typeof cb === 'function') cb(out);
  }

  function close() {
    open = false;
    cfg.onConfirm = null;
    if (els.mask) els.mask.hidden = true;
  }

  root.XlsxConfig = {
    init: init,
    open: openWith,
    close: close,
    isOpen: isOpen,
    // 供测试
    _columnsOf: columnsOf
  };
})(typeof self !== 'undefined' ? self : this);
