/**
 * filterbar.js — 顶部第二行"对比源筛选区"。
 * 职责：子文件夹下拉、字段下拉、左右文件下拉 的 DOM 与数据加载。
 * 依赖 source-api（window.Source）做目录/文件列表；不依赖 app.js（低耦合）。
 * 全局暴露：FilterBar
 *
 * FilterBar.init({ getRoot, onFileChange, onFieldPick, onDirChange })
 *   getRoot() → string          // 当前对比源绝对路径（来自侧边栏"对比源"）
 *   onFileChange(side, absPath) // side:'L'|'R'，用户选定文件
 *   onFieldPick(text)           // 用户选定某个字段（章节文本）
 *   onDirChange()               // 用户手动切换子文件夹后回调（加载对比源/恢复 tab 不触发）
 * FilterBar.reload()            // 从 getRoot() 重新加载子文件夹与文件
 * FilterBar.setFields([{label,text}])  // 由 app 填充字段下拉
 * FilterBar.getSelected(side)   // 当前所选文件绝对路径（'' 表示未选）
 */
(function (root) {
  'use strict';

  var cfg = { getRoot: null, onFileChange: null, onFieldPick: null, onDirChange: null };
  var els = { dir: null, field: null, fileL: null, fileR: null };
  var currentDir = null;   // 当前子文件夹绝对路径
  var files = [];          // 当前文件列表 [{name,size,ext}]

  function $(id) { return document.getElementById(id); }

  function fillSel(sel, items) {
    var keep = sel.value;
    if (sel._setOpts) {           // 可搜索组合框（子文件夹 / 原始文件 / 修改文件）：只存选项，实时过滤由 combobox 处理
      sel._setOpts(items);
    } else {                      // 原生 select（字段下拉）
      sel.innerHTML = '';
      for (var i = 0; i < items.length; i++) {
        var o = document.createElement('option');
        o.value = items[i].value;
        o.textContent = items[i].label;
        if (items[i].text) o._text = items[i].text; // 字段文本，非 DOM 属性，沙箱兼容
        sel.appendChild(o);
      }
    }
    if (keep && items.some(function (it) { return it.value === keep; })) sel.value = keep;
  }

  function loadDir(dirPath) {
    if (!dirPath) return Promise.resolve();
    currentDir = dirPath;
    return Source.list(dirPath).then(function (data) {
      files = data.files;
      var items = files.map(function (f) { return { value: dirPath + '/' + f.name, label: f.name }; });
      fillSel(els.fileL, items);
      fillSel(els.fileR, items);
      // 不自动填充前两个文件：默认文件可能很大，自动选中并加载会造成明显卡顿；
      // 保持两侧留空，由用户手动从下拉选择后再触发加载。
    }).catch(function () { files = []; });
  }

  function reload() {
    if (!els.dir || !cfg.getRoot) return Promise.resolve();
    var rootPath = cfg.getRoot();
    if (!rootPath) return Promise.resolve();
    return Source.list(rootPath).then(function (data) {
      var dirItems = data.dirs.map(function (d) { return { value: rootPath + '/' + d, label: d }; });
      if (dirItems.length === 0) {
        fillSel(els.dir, [{ value: rootPath, label: '（根）' }]);
        return loadDir(rootPath);
      }
      var keep = els.dir.value;
      fillSel(els.dir, dirItems);
      if (!keep || !dirItems.some(function (d) { return d.value === keep; })) els.dir.value = dirItems[0].value;
      return loadDir(els.dir.value);
    }).catch(function () { /* 路径无效等，静默 */ });
  }

  /** 选中某个子文件夹（若下拉里有对应选项则同步其显示），并加载其文件列表 */
  function selectDir(absDir) {
    if (!els.dir) return Promise.resolve();
    if (absDir && els.dir.value !== absDir) {
      var opts = els.dir.options || [];
      for (var i = 0; i < opts.length; i++) {
        if (opts[i].value === absDir) { els.dir.value = absDir; break; }
      }
    }
    return loadDir(absDir || els.dir.value);
  }

  /** 设置某侧文件下拉的选中值；silent 时不触发 onFileChange（如 tab 恢复，避免重写编辑区文本） */
  function selectFile(side, absPath, silent) {
    var sel = side === 'L' ? els.fileL : els.fileR;
    if (!sel) return;
    sel.value = absPath || '';
    if (!silent && absPath && cfg.onFileChange) cfg.onFileChange(side, absPath);
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

  /** 把含 .cb 类的元素挂载为可搜索组合框；非组合框（如测试桩 / 原生字段下拉）保持原样 */
  function mountCombo(el) {
    if (!el || !el.classList || !el.classList.contains('cb')) return;
    if (root.Combobox && root.Combobox.attach) root.Combobox.attach(el);
  }

  function init(c) {
    cfg.getRoot = c.getRoot || null;
    cfg.onFileChange = c.onFileChange || null;
    cfg.onFieldPick = c.onFieldPick || null;
    cfg.onDirChange = c.onDirChange || null;
    els.dir = $('dirSel');
    els.field = $('fieldSel');
    els.fileL = $('fileSelL');
    els.fileR = $('fileSelR');
    mountCombo(els.dir);
    mountCombo(els.fileL);
    mountCombo(els.fileR);
    if (els.dir) els.dir.addEventListener('change', function () {
      loadDir(els.dir.value).then(function () { if (cfg.onDirChange) cfg.onDirChange(); });
    });
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

  root.FilterBar = {
    init: init, reload: reload, setFields: setFields, getSelected: getSelected,
    selectDir: selectDir, selectFile: selectFile
  };
})(typeof self !== 'undefined' ? self : this);
