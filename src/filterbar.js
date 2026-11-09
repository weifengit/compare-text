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

  var MAX_EXTRA = 20;   // 拖入文件的选项上限：下拉是给人看的，不做无限堆积

  var cfg = { getRoot: null, onFileChange: null, onFieldPick: null, onDirChange: null };
  var els = { dir: null, field: null, fileL: null, fileR: null };
  var currentDir = null;   // 当前子文件夹绝对路径
  var files = [];          // 当前文件列表 [{name,size,ext}]
  var extras = { L: [], R: [] };   // 不在对比源里的文件（拖入的文件），按侧各留一份

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

  /** 当前目录的文件名 → 文件下拉选项 */
  function dirItems(dirPath) {
    if (!dirPath) return [];
    return files.map(function (f) { return { value: dirPath + '/' + f.name, label: f.name }; });
  }

  /**
   * 登记一个不在对比源里的文件选项（当前只有拖入的文件）。
   * 不登记的话，组合框只能用一段内部引用（blobdrop/…）当显示文本，
   * 而用户需要看到的是自己拖进来的文件名；登记后它就与普通文件一样躺在下拉里。
   * 同名视为同一个文件：重复拖入只留最新那份，不把下拉堆成一堆同名项。
   */
  function addExtraOption(side, item) {
    if (!item || !item.value || (side !== 'L' && side !== 'R')) return;
    var label = item.label || item.value;
    var list = extras[side].filter(function (it) { return it.label !== label; });
    list.push({ value: item.value, label: label });
    while (list.length > MAX_EXTRA) list.shift();
    extras[side] = list;
    var sel = side === 'L' ? els.fileL : els.fileR;
    if (sel) fillSel(sel, dirItems(currentDir).concat(list));
  }

  function loadDir(dirPath) {
    if (!dirPath) return Promise.resolve();
    currentDir = dirPath;
    return Source.list(dirPath).then(function (data) {
      files = data.files;
      fillSel(els.fileL, dirItems(dirPath).concat(extras.L));
      fillSel(els.fileR, dirItems(dirPath).concat(extras.R));
      // 不自动填充前两个文件：默认文件可能很大，自动选中并加载会造成明显卡顿；
      // 保持两侧留空，由用户手动从下拉选择后再触发加载。
    }).catch(function () { files = []; });
  }

  function reload() {
    if (!els.dir || !cfg.getRoot) return Promise.resolve();
    var rootPath = cfg.getRoot();
    if (!rootPath) return Promise.resolve();
    return Source.list(rootPath).then(function (data) {
      var dirOpts = data.dirs.map(function (d) { return { value: rootPath + '/' + d, label: d }; });
      if (dirOpts.length === 0) {
        fillSel(els.dir, [{ value: rootPath, label: '（根）' }]);
        return loadDir(rootPath);
      }
      var keep = els.dir.value;
      fillSel(els.dir, dirOpts);
      if (!keep || !dirOpts.some(function (d) { return d.value === keep; })) els.dir.value = dirOpts[0].value;
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

  /**
   * 两个文件选择框直接接受网址 / 本地 HTML 快照路径：
   * 以前“网页对比”是顶部一个单独按钮 + 弹层，每换一次地址就要重新开弹窗；
   * 输入框本来就是“这一侧装什么”的唯一入口，把网址并进来后语义才一致。
   * 判定放在这里而不在 combobox：什么算网页源属于 Pipeline 的口径，不属于输入控件。
   */
  function freeTextRef(raw) {
    var t = String(raw || '').trim();
    if (!t) return '';
    if (/^\/\//.test(t)) return 'https:' + t;          // //host/path 省略协议
    if (/^https?:/i.test(t)) return t;
    if (/^\/.*\.html?$/i.test(t)) return t;           // 本地 HTML 快照绝对路径
    return '';
  }

  /** 给某个文件选择框接上自由文本提交（回车直接加载网址） */
  function wireFreeText(sel) {
    if (!sel || typeof sel._setFreeText !== 'function') return;
    sel._setFreeText(freeTextRef);
  }

  /** 把含 .cb 类的元素挂载为可搜索组合框；非组合框（如测试桩 / 原生字段下拉）保持原样 */
  function mountCombo(el, allowFreeText) {
    if (!el || !el.classList || !el.classList.contains('cb')) return;
    if (root.Combobox && root.Combobox.attach) {
      root.Combobox.attach(el);
      if (allowFreeText) wireFreeText(el);
    }
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
    mountCombo(els.fileL, true);   // 两个文件框额外接受网址/快照路径（回车即加载）
    mountCombo(els.fileR, true);
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
    selectDir: selectDir, selectFile: selectFile, addExtraOption: addExtraOption,
    freeTextRef: freeTextRef
  };
})(typeof self !== 'undefined' ? self : this);
