/**
 * picker.js — 对比源文件夹选择弹层。
 * 职责：点击路径输入框弹出目录浏览器（浏览 / 直达），确认后回填输入框并触发回调。
 * 依赖 Source.browse（source-api.js，浏览器模式走 /api/browse，Tauri 模式走 Rust 命令）；
 * 未引入 source-api.js 时回退直接 fetch /api/browse；不依赖 app.js / filterbar（低耦合，按需引入）。
 * 全局暴露：Picker
 *
 * Picker.init({ input, onPick })
 *   input   路径输入框（页面 srcPathInput）
 *   onPick(absPath)  确认某文件夹后回调（app 负责 loadSrcPath → 加载子文件夹并渲染）
 */
(function (root) {
  'use strict';

  var cfg = { input: null, onPick: null };
  var els = {};
  var cur = null;        // 当前浏览位置 {path, parent, kind:'dir'|'drives', dirs}
  var navTok = 0;        // 导航令牌：丢弃过期 browse 响应

  function $(id) { return document.getElementById(id); }

  function browse(p) {
    // 优先 Source.browse（自动适配 Tauri / 浏览器）；未引入时回退 serve.js 的 /api/browse
    if (root.Source && root.Source.browse) return root.Source.browse(p || '');
    return fetch('/api/browse?path=' + encodeURIComponent(p || ''))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || d.ok !== true) throw new Error((d && d.error) || '目录读取失败');
        return d;
      });
  }

  function setErr(msg) {
    if (els.err) { els.err.textContent = msg || ''; els.err.classList.toggle('hidden', !msg); }
  }
  function showLoading(on) { if (els.mask) els.mask.classList.toggle('busy', on); }

  function setRowsActive(el) {
    var rows = els.body.querySelectorAll('.picker-row');
    for (var k = 0; k < rows.length; k++) rows[k].classList.remove('active');
    if (el) el.classList.add('active');
  }

  function rowHtml(d) {
    var row = document.createElement('div');
    row.className = 'picker-row';
    row.textContent = d.name;
    row.title = d.path;
    row.addEventListener('click', function () {
      els.path.value = d.path;              // 单点：预览候选路径（回填输入框）
      setRowsActive(row);
    });
    row.addEventListener('dblclick', function () { navigate(d.path); });   // 双击：进入目录
    return row;
  }

  function render() {
    els.body.innerHTML = '';
    els.up.disabled = true;
    if (!cur) return;
    els.path.value = cur.path;
    setRowsActive(null);
    els.up.disabled = !canUp();
    var head = document.createElement('div');
    head.className = 'picker-cur';
    head.textContent = cur.kind === 'drives' ? '选择磁盘（盘符列表）' : '当前：' + cur.path;
    els.body.appendChild(head);
    if (!cur.dirs.length) {
      var empty = document.createElement('div');
      empty.className = 'picker-empty';
      empty.textContent = cur.kind === 'drives' ? '未发现可用磁盘' : '（没有子文件夹）';
      els.body.appendChild(empty);
      return;
    }
    for (var i = 0; i < cur.dirs.length; i++) els.body.appendChild(rowHtml(cur.dirs[i]));
  }

  /** 能否"上一级"：盘符列表不可；系统根 / 盘符根不可（盘符根的上级是盘符列表，但需 kind 为 dir 且非根路径） */
  function canUp() {
    if (!cur || cur.kind === 'drives') return false;
    if (cur.parent) return true;
    return cur.path !== '' && cur.path !== '/' && cur.path !== '\\';
  }

  function navigate(p) {
    var my = ++navTok;
    showLoading(true);
    setErr('');
    browse(p).then(function (d) {
      if (my !== navTok) return;
      cur = d; render();
    }).catch(function (e) {
      if (my !== navTok) return;
      setErr((e && e.message) || '读取失败');
      if (!cur && p !== '') navigate('');   // 起始路径不可用 → 退回根 / 盘符列表
    }).then(function () { if (my === navTok) showLoading(false); });
  }

  function goUp() {
    if (!canUp()) return;
    navigate(cur.parent || '');
  }

  /** 加载路径输入框中的路径：浏览其子文件夹（停留在弹层内，未选择） */
  function onGo() {
    var p = String((els.path && els.path.value) || '').trim();
    if (!p) { setErr('请输入文件夹路径'); return; }
    navigate(p);
  }

  function open() {
    var src = String((cfg.input && cfg.input.value) || '').trim();
    // 未完成浏览时保留现场：来源路径没变就接着上次位置浏览（避免误关/关闭后重头再来）；变了才从新路径开始
    if (!cur || !cur.path || cur.path !== src) {
      cur = null;
      els.path.value = '';
    }
    setErr('');
    render();
    els.mask.hidden = false;                    // markup 用 hidden 属性控制显示，须移除属性
    els.mask.classList.remove('hidden');        // 兜底清理可能残留的 hidden class
    navigate(src);
    if (els.path && els.path.focus) els.path.focus();
  }

  function close() {
    setErr('');
    els.mask.hidden = true;
    els.mask.classList.add('hidden');
  }

  function confirm() {
    var p = String((els.path && els.path.value) || '').trim();
    if (!p) { setErr('请输入或选择文件夹路径'); return; }
    showLoading(true);
    setErr('');
    browse(p).then(function (d) {
      if (cfg.input) cfg.input.value = d.path;
      close();
      if (cfg.onPick) cfg.onPick(d.path);
    }).catch(function (e) {
      setErr((e && e.message) || '该路径不可用');
    }).then(function () { showLoading(false); });
  }

  function init(c) {
    cfg.input = (c && c.input) || null;
    cfg.onPick = (c && c.onPick) || null;
    els.mask = $('pickerMask');
    els.body = $('pickerBody');
    els.path = $('pickerPath');
    els.err = $('pickerErr');
    els.up = $('pickerUp');
    if (!els.mask || !els.body || !els.path) return;
    els.up.addEventListener('click', goUp);
    els.path.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); onGo(); }   // 与"加载"按钮一致：进入该路径浏览
    });
    // 注意：不监听背景点击关闭——弹层居中小、四周是大块暗色背景，误点一下就丢掉正在配置的进度。
    // 关闭只通过面板自身按钮（× / 取消 / 选择此文件夹）或 Esc 完成。
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape' || els.mask.hidden) return;
      // 正在输入路径时 Esc 只取消输入焦点，避免误按把整个面板关掉
      var ae = root.document && root.document.activeElement;
      if (ae && ae === els.path) { if (ae.blur) ae.blur(); return; }
      close();
    });
    var bind = function (id, fn) { var b = $(id); if (b) b.addEventListener('click', fn); };
    bind('pickerGo', onGo);          // “加载”按钮：浏览输入框中的路径
    bind('pickCloseBtn', close);
    bind('pickCancelBtn', close);
    bind('pickOkBtn', confirm);
    if (cfg.input) cfg.input.addEventListener('click', open);
  }

  root.Picker = { init: init, open: open, close: close };
})(typeof self !== 'undefined' ? self : this);