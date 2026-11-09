/**
 * dropzone.js — 接住从系统里拖进来的文件，交给宿主决定放到哪一侧。
 *
 * 与 app.js 解耦：本模块只管"落点算哪一侧"和"拖进来的是什么"，文件怎么装载
 * 由注入的 onDrop 负责。浏览器给的是 File 对象、桌面端给的是真实路径，
 * 两种都原样抛出，由宿主决定登记还是直接用。
 *
 * DropZone.init({
 *   onDrop(items),      // items: [{side:'L'|'R', file?, path?, name, size}]，最多两条
 *   onOverflow(n),      // 一次拖入超过两个文件时回调（只取前两个）
 *   getMeasureEl()      // 落点判定的基准元素，默认 #layout
 * });
 * DropZone.destroy();
 *
 * 落点规则：
 *   ① 指针压在某侧文件框上（带 data-drop-side 的祖先）→ 该侧；
 *   ② 否则按基准元素的左右半区；
 *   ③ 一次拖入 ≥2 个文件 → 不猜落点：第一个当原文、第二个当修改后。
 *
 * 桌面端（Tauri）默认把拖放拦在原生层，WebView 收不到 HTML5 drop 事件，
 * 因此额外挂一条原生事件（拿真实路径）；两条通路共用同一套落点判定与派发。
 * 全局暴露：DropZone
 */
(function (root) {
'use strict';

var cfg = { onDrop: null, onOverflow: null, getMeasureEl: null };
var attached = false;
var unlistenTauri = null;
var mask = null;          // 拖拽遮罩（惰性创建）
var lastNames = [];       // 最近一次拖拽里的文件名（原生 over 事件不带文件名，沿用上一次）
var dragDepth = 0;        // dragenter/dragleave 成对计数：跨子元素时不闪遮罩

function doc() { return root.document; }

/** 只接管"拖的是文件"——编辑器内拖动选中的文字、页面内其它拖拽一律放行 */
function hasFiles(dt) {
  if (!dt) return false;
  var types = dt.types || [];
  for (var i = 0; i < types.length; i++) {
    if (String(types[i]).toLowerCase() === 'files') return true;
  }
  // 某些环境（含部分 WebView）拖入时 types 为空，但 files 已有内容
  return !!(dt.files && dt.files.length);
}

function namesOf(list, limit) {
  var out = [];
  for (var i = 0; i < list.length && i < limit; i++) {
    out.push(String(list[i] && list[i].name ? list[i].name : list[i] || ''));
  }
  return out;
}

/** 指针落在哪一侧：显式的 data-drop-side 优先，其次基准元素的左右半区 */
function sideAt(x, y) {
  var d = doc();
  if (!d) return 'L';
  var hit = (d.elementFromPoint && typeof x === 'number' && typeof y === 'number')
    ? d.elementFromPoint(x, y) : null;
  while (hit) {
    if (hit.getAttribute) {
      var s = hit.getAttribute('data-drop-side');
      if (s === 'L' || s === 'R') return s;
    }
    hit = hit.parentNode || null;
  }
  var base = (cfg.getMeasureEl && cfg.getMeasureEl()) || d.getElementById('layout');
  if (base && base.getBoundingClientRect) {
    var r = base.getBoundingClientRect();
    if (r && r.width) return x < r.left + r.width / 2 ? 'L' : 'R';
  }
  return 'L';
}

// ---------- 遮罩 ----------

function ensureMask() {
  if (mask) return mask;
  var d = doc();
  if (!d || !d.body) return null;
  mask = d.createElement('div');
  mask.className = 'drop-mask';
  mask.hidden = true;
  ['L', 'R'].forEach(function (side) {
    var half = d.createElement('div');
    half.className = 'drop-half drop-half-' + side.toLowerCase();
    half.setAttribute('data-drop-side', side);
    var lab = d.createElement('div');
    lab.className = 'drop-half-label';
    lab.textContent = side === 'L' ? '原文' : '修改后';
    half.appendChild(lab);
    mask.appendChild(half);
  });
  var hint = d.createElement('div');
  hint.className = 'drop-hint';
  mask.appendChild(hint);
  mask._hint = hint;
  mask._halves = { L: mask.children[0], R: mask.children[1] };
  d.body.appendChild(mask);
  return mask;
}

function hideMask() {
  if (mask) mask.hidden = true;
}

/**
 * 刷新遮罩：涂亮将接收文件的那一侧，并写清"松开会发生什么"。
 * side 为 null 表示两侧都亮（一次拖两个文件，分别落左右）。
 */
function showMask(side, names) {
  var m = ensureMask();
  if (!m) return;
  if (names && names.length) lastNames = names;
  var two = lastNames.length >= 2;
  if (two) side = null;                       // ≥2 个文件：左右各一个，不按落点
  m._halves.L.classList.toggle('on', !side || side === 'L');
  m._halves.R.classList.toggle('on', !side || side === 'R');
  m._hint.textContent = two
    ? ('松开即对比：第 1 个「' + (lastNames[0] || '') + '」→ 原文，第 2 个「' + (lastNames[1] || '') + '」→ 修改后')
    : ('松开即载入到「' + (side === 'R' ? '修改后' : '原文') + '」' +
       (lastNames[0] ? '：' + lastNames[0] : ''));
  m.hidden = false;
}

// ---------- 派发 ----------

/** 把拖入的文件分派到两侧：≥2 个按顺序配左右，1 个按落点 */
function deliver(items, x, y) {
  if (!items || !items.length) return;
  var out;
  if (items.length >= 2) {
    out = [{ side: 'L', item: items[0] }, { side: 'R', item: items[1] }];
    if (items.length > 2 && cfg.onOverflow) cfg.onOverflow(items.length);
  } else {
    out = [{ side: sideAt(x, y), item: items[0] }];
  }
  if (!cfg.onDrop) return;
  cfg.onDrop(out.map(function (o) {
    var it = o.item;
    return { side: o.side, file: it.file || null, path: it.path || '',
             name: it.name || '', size: it.size || 0 };
  }));
}

// ---------- HTML5 拖放（浏览器 / 未拦原生拖放的 WebView）----------

function onDragEnter(ev) {
  if (!hasFiles(ev.dataTransfer)) return;
  dragDepth++;
  showMask(sideAt(ev.clientX, ev.clientY), namesOf(ev.dataTransfer.files || [], 2));
}

function onDragOver(ev) {
  if (!hasFiles(ev.dataTransfer)) return;
  if (ev.preventDefault) ev.preventDefault();     // 不阻止默认行为就收不到 drop
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
  showMask(sideAt(ev.clientX, ev.clientY), namesOf(ev.dataTransfer.files || [], 2));
}

function onDragLeave(ev) {
  if (!hasFiles(ev.dataTransfer)) return;
  dragDepth--;
  // 拖出窗口时 relatedTarget 为 null：不必等计数配平，直接收起，否则遮罩会留在界面上
  if (ev.relatedTarget === null) dragDepth = 0;
  if (dragDepth <= 0) { dragDepth = 0; hideMask(); }
}

function onDragEnd() { dragDepth = 0; hideMask(); }

function onDrop(ev) {
  if (!hasFiles(ev.dataTransfer)) return;
  if (ev.preventDefault) ev.preventDefault();
  dragDepth = 0;
  hideMask();
  var list = ev.dataTransfer.files || [];
  var items = [];
  for (var i = 0; i < list.length; i++) {
    items.push({ file: list[i], name: list[i].name || '拖入的文件', size: list[i].size || 0 });
  }
  deliver(items, ev.clientX, ev.clientY);
}

// ---------- 桌面端原生拖放（Tauri）----------

function attachTauri() {
  var t = root.__TAURI__;
  var wv = t && t.webviewWindow;
  if (!wv || typeof wv.getCurrentWebviewWindow !== 'function') return;
  var win = null;
  try { win = wv.getCurrentWebviewWindow(); } catch (e) { return; }
  if (!win || typeof win.onDragDropEvent !== 'function') return;

  // 原生坐标为物理像素，落点判定用的是 CSS 像素
  function cssPos(p) {
    var dpr = root.devicePixelRatio || 1;
    var pos = p && p.position;
    return pos ? { x: pos.x / dpr, y: pos.y / dpr } : { x: 0, y: 0 };
  }

  try {
    var p = win.onDragDropEvent(function (ev) {
      var payload = (ev && ev.payload) || {};
      var pos = cssPos(payload);
      if (payload.type === 'enter' || payload.type === 'over') {
        // over 事件只带坐标不带路径，文件名沿用 enter 时的
        showMask(sideAt(pos.x, pos.y),
          payload.paths && payload.paths.length ? namesOf(payload.paths, 2) : null);
        return;
      }
      if (payload.type === 'leave') { hideMask(); return; }
      if (payload.type !== 'drop') return;
      hideMask();
      var paths = payload.paths || [];
      deliver(paths.map(function (p2) {
        var s = String(p2);
        return { path: s, name: s.replace(/^.*[\\/]/, ''), size: 0 };
      }), pos.x, pos.y);
    });
    if (p && p.then) p.then(function (fn) { unlistenTauri = fn; }, function () {});
  } catch (e) { /* 原生能力不可用时静默退回 HTML5 通路 */ }
}

// ---------- 生命周期 ----------

function init(c) {
  cfg.onDrop = (c && c.onDrop) || null;
  cfg.onOverflow = (c && c.onOverflow) || null;
  cfg.getMeasureEl = (c && c.getMeasureEl) || null;
  if (!attached && root.addEventListener) {
    // 捕获阶段挂 window：拖到任意位置都算数，不必给每个容器加监听
    root.addEventListener('dragenter', onDragEnter, true);
    root.addEventListener('dragover', onDragOver, true);
    root.addEventListener('dragleave', onDragLeave, true);
    root.addEventListener('drop', onDrop, true);
    root.addEventListener('dragend', onDragEnd, true);
    attached = true;
  }
  attachTauri();
}

function destroy() {
  if (attached && root.removeEventListener) {
    root.removeEventListener('dragenter', onDragEnter, true);
    root.removeEventListener('dragover', onDragOver, true);
    root.removeEventListener('dragleave', onDragLeave, true);
    root.removeEventListener('drop', onDrop, true);
    root.removeEventListener('dragend', onDragEnd, true);
  }
  attached = false;
  if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
  mask = null;
  if (unlistenTauri) { try { unlistenTauri(); } catch (e) {} unlistenTauri = null; }
}

root.DropZone = { init: init, destroy: destroy, sideAt: sideAt };
})(typeof self !== 'undefined' ? self : this);
