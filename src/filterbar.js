/**
 * filterbar.js — 顶部第二行"对比源筛选区"。
 * 职责：子文件夹下拉、字段下拉、左右文件下拉 的 DOM 与数据加载。
 * 依赖 source-api（window.Source）做目录/文件列表；不依赖 app.js（低耦合）。
 * 全局暴露：FilterBar
 *
 * FilterBar.init({ getRoot, onFileChange, onFieldPick })
 *   getRoot() → string          // 当前对比源绝对路径（来自侧边栏"对比源"）
 *   onFileChange(side, absPath) // side:'L'|'R'，用户选定文件
 *   onFieldPick(text)           // 用户选定某个字段（章节文本）
 * FilterBar.reload()            // 从 getRoot() 重新加载子文件夹与文件
 * FilterBar.setFields([{label,text}])  // 由 app 填充字段下拉
 * FilterBar.getSelected(side)   // 当前所选文件绝对路径（'' 表示未选）
 */
(function (root) {
  'use strict';

  var cfg = { getRoot: null, onFileChange: null, onFieldPick: null };
  var els = { dir: null, field: null, fileL: null, fileR: null };
  var currentDir = null;   // 当前子文件夹绝对路径
  var files = [];          // 当前文件列表 [{name,size,ext}]

  function $(id) { return document.getElementById(id); }

  function fillSel(sel, items) {
    var keep = sel.value;
    sel.innerHTML = '';
    for (var i = 0; i < items.length; i++) {
      var o = document.createElement('option');
      o.value = items[i].value;
      o.textContent = items[i].label;
      if (items[i].text) o._text = items[i].text; // 字段文本，非 DOM 属性，沙箱兼容
      sel.appendChild(o);
    }
    if (keep && items.some(function (it) { return it.value === keep; })) sel.value = keep;
  }

  function loadDir(dirPath) {
    if (!dirPath) return;
    currentDir = dirPath;
    Source.list(dirPath).then(function (data) {
      files = data.files;
      var items = files.map(function (f) { return { value: dirPath + '/' + f.name, label: f.name }; });
      fillSel(els.fileL, items);
      fillSel(els.fileR, items);
    }).catch(function () { files = []; });
  }

  function reload() {
    if (!els.dir || !cfg.getRoot) return;
    var rootPath = cfg.getRoot();
    if (!rootPath) return;
    Source.list(rootPath).then(function (data) {
      var dirItems = data.dirs.map(function (d) { return { value: rootPath + '/' + d, label: d }; });
      if (dirItems.length === 0) {
        fillSel(els.dir, [{ value: rootPath, label: '（根）' }]);
        loadDir(rootPath);
      } else {
        var keep = els.dir.value;
        fillSel(els.dir, dirItems);
        if (!keep || !dirItems.some(function (d) { return d.value === keep; })) els.dir.value = dirItems[0].value;
        loadDir(els.dir.value);
      }
    }).catch(function () { /* 路径无效等，静默 */ });
  }

  function setFields(fields) {
    if (!els.field) return;
    var items = [{ value: '', label: '（选择字段复制到编辑区）' }];
    (fields || []).forEach(function (f) { items.push({ value: f.label, label: f.label, text: f.text }); });
    fillSel(els.field, items);
  }

  function getSelected(side) {
    return (side === 'L' ? els.fileL : els.fileR).value || '';
  }

  function init(c) {
    cfg.getRoot = c.getRoot || null;
    cfg.onFileChange = c.onFileChange || null;
    cfg.onFieldPick = c.onFieldPick || null;
    els.dir = $('dirSel');
    els.field = $('fieldSel');
    els.fileL = $('fileSelL');
    els.fileR = $('fileSelR');
    if (els.dir) els.dir.addEventListener('change', function () { loadDir(els.dir.value); });
    if (els.field) els.field.addEventListener('change', function () {
      var opts = els.field.options || [];
      var t = '';
      for (var i = 0; i < opts.length; i++) {
        if (opts[i].value === els.field.value) { t = opts[i]._text || ''; break; }
      }
      if (t && cfg.onFieldPick) cfg.onFieldPick(t);
    });
    if (els.fileL) els.fileL.addEventListener('change', function () { if (cfg.onFileChange) cfg.onFileChange('L', els.fileL.value); });
    if (els.fileR) els.fileR.addEventListener('change', function () { if (cfg.onFileChange) cfg.onFileChange('R', els.fileR.value); });
  }

  root.FilterBar = { init: init, reload: reload, setFields: setFields, getSelected: getSelected };
})(typeof self !== 'undefined' ? self : this);
