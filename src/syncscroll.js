/**
 * syncscroll.js — 跨区域垂直协同滚动（内容锚定 · 多层面控制）。
 * 职责：把一组可滚动元素绑定为内容对齐的纵向联动。用于 主区域1(标注) / 主区域2(编辑) / 主区域3(PDF)。
 *
 * 定位原则（文字内容才是定位的关键）：
 *  - 公共坐标系 = 连续行位 e（行号 + 行内比例，浮点）。每个元素可注册适配器：
 *      { side:'L'|'R', lineAt(px)→行号, offsetOf(e)→px, lineH(line)→px }
 *    滚动时把驱动区视口顶部换算成连续行位 e，其余各区滚到同一内容行；左右行号体系不同由
 *    setTranslator 注册的换算函数互译（返回连续行位）。页数/字号/版式差异不影响对照；
 *    无适配器/行号不可得时降级为比例同步。
 *
 * 多层面控制（杜绝跳页/抖动/回弹/卡死，worklist 144）：
 *  ① 连续行位：锚点与像素互转全程不取整（offsetOf 接受浮点行位），消除双重取整造成的 1 行级跳变抖动。
 *  ② 手势模型：driving/driven —— 被驱动方整个手势内不反客为主，杜绝 A↔B 震荡与“往下滚另一边往回弹”；
 *     idle 超时 / pointerdown / keydown 结束手势并重建基线。
 *  ③ 弹性跟随：目标单步推进 ≤ max(MIN, |源Δ行|×RATIO)，且方向单调（容差 TOL）——
 *     小滚不跳页（页眉/稀疏锚点错映射被截断为缓慢跟随），滚动条/翻页大跳完整跟随。
 *  ④ 边界滚轮：源贴边时用虚拟位置（可越过边界）继续驱动其它区，解决“一边到底另一边还剩内容却滚不动”。
 *
 * SyncScroll.rebind([el, ...])                            // 重新绑定（旧监听自动解绑）
 * SyncScroll.setAdapter(el, {side,lineAt,offsetOf,lineH}) // 注册内容锚适配器（全部可选）
 * SyncScroll.setTranslator(fn(srcA, oA, e))               // 左右互译：入参连续行位 e；返回 e'（浮点）/ {line,frac} / 行号 / null
 */
(function (root) {
  'use strict';

  var bound = [];        // [{el, onScroll, onWheel, onPointer}] 已绑定监听，便于解绑
  var els = [];          // 当前分组（handler 闭包共享，避免旧监听引用过期数组）
  var adapters = [];     // [{el, a}] 元素 → 内容锚适配器
  var translator = null;
  var syncing = false;
  var rafPending = false;
  var rafSrc = null;
  var rafPx = null;      // 显式源像素（边界滚轮的虚拟位置覆盖 scrollTop）

  // —— 手势状态（层2）——
  var driving = null;    // 当前驱动元素
  var driven = [];       // 本手势内被写入的目标元素：其 scroll 事件视为 echo，忽略
  var gestureTimer = null;
  // 元素态统一用 Map（对象键）：普通对象键会坍缩成 "[object Object]" 使 6 区共享同一槽位
  var lastKnownE = new Map();   // el → 最近一次同步所见连续行位（源与目标都更新，跨手势持久 → 手势首步增量可靠）
  var lastTgtE = new Map();     // el → 目标最近一次被写入后的连续行位（钳制基线兜底）
  var pendingVirtual = new Map(); // el → {px, t, dir} 边界滚轮产生的虚拟位置（TTL 内防原生回写覆写）
  var keyHooked = false;   // 文档级 keydown 已挂过一次

  // 弹性跟随参数（层3）。单位均为“连续行”。
  var RATIO = 1.25;      // 目标单步可推进的上限倍数（相对源 Δ 行）
  var MIN_LINES = 0.15;  // 每步最小推进（吸收亚行取整噪声）
  var TOL = 0.2;         // 方向单调容差（允许的小幅回退/前进，吸收取整）
  var JUMP_LINES = 10;   // 源单次移动超过该行数视为大跳（滚动条/翻页/程序化归位）→ 完整跟随不钳制
  var GESTURE_IDLE = 200;// 手势空闲判定（ms）
  var VIRTUAL_TTL = 200; // 边界虚拟位置有效时长（ms）

  var raf = (typeof window !== 'undefined' && window.requestAnimationFrame)
    ? function (fn) { return window.requestAnimationFrame(fn); }
    : function (fn) { return setTimeout(fn, 16); };

  function adapterOf(el) {
    for (var i = 0; i < adapters.length; i++) {
      if (adapters[i].el === el) return adapters[i].a;
    }
    return null;
  }

  // ---------- 层1：连续行位互转 ----------

  /** 元素视口顶部像素 → 连续行位 e（行号 + 行内比例）；不可得 → null。
   *  适配器可提供 nextOffset(line)（下一行条目的顶部像素）：
   *  行位在“本行顶 → 下一行顶”区间内线性插值，绝不越过下一行 —— 消除 PDF 页间/大空白区
   *  造成的行位不单调（源滚过空白时 e 不应反跳，见 worklist 145 抖动根因）。
   *  末行无 nextOffset → 按行高外推（供层4 边界滚轮虚拟位置继续驱动）。 */
  function anchorOf(el, a, px) {
    if (!a || !a.lineAt) return null;
    var line = null;
    try { line = a.lineAt(px); } catch (e) { line = null; }
    if (line == null) return null;
    var off = null, h = null;
    if (a.offsetOf) { try { off = a.offsetOf(line); } catch (e2) { /* 忽略 */ } }
    if (a.lineH) { try { h = a.lineH(line); } catch (e3) { /* 忽略 */ } }
    var frac = 0;
    if (off != null && h > 0) {
      frac = (px - off) / h;
      if (a.nextOffset) {
        var no = null;
        try { no = a.nextOffset(line); } catch (e4) { /* 忽略 */ }
        if (no != null && no > off) {
          var f2 = (px - off) / (no - off);
          if (f2 < frac) frac = f2;         // 取更小者：间隙区按下一行顶插值，不越界
        }
      }
    }
    return line + Math.max(0, frac);
  }

  /** 连续行位 e → 目标像素（跨侧经 translator 互译）；不可得 → null */
  function targetOf(oA, srcA, e) {
    if (!oA || !oA.offsetOf) return null;
    var e2 = e;
    var srcSide = srcA ? srcA.side : null;
    if (oA.side && srcSide && oA.side !== srcSide) {
      var tr = translator ? translator(srcA, oA, e) : null;
      if (tr == null) return null;
      if (typeof tr === 'number') e2 = tr;
      else if (tr && typeof tr === 'object' && typeof tr.line === 'number') e2 = tr.line + (typeof tr.frac === 'number' ? tr.frac : 0);
      else return null;
    }
    try { var px = oA.offsetOf(e2); return (px == null) ? null : px; } catch (e3) { return null; }
  }

  // ---------- 手势（层2）----------

  function clearGesture() {
    driving = null;
    driven = [];
    pendingVirtual = new Map();
    if (gestureTimer) { clearTimeout(gestureTimer); gestureTimer = null; }
  }
  function touchGesture() {
    if (gestureTimer) clearTimeout(gestureTimer);
    gestureTimer = setTimeout(clearGesture, GESTURE_IDLE);
  }
  /** 手势开始：登记驱动源、清空被驱动集合。行位基线（lastKnownE/lastTgtE）跨手势持久，
   *  不在此重置 —— 一次性程序化跳转/返回原位的首个事件才能算出真实增量。 */
  function initGesture(el) {
    driving = el;
    driven = [];
    touchGesture();
  }

  // ---------- 层3：弹性钳制 ----------

  /** 目标理想行位 → 钳制到 [方向单调 + 弹性步长] 区间内的连续行位；不可得 → null。
   *  基线取目标“当前实际行位”（被外部滚动后也正确），而非记忆里的旧值。 */
  function clampTarget(o, oA, idealPx, srcDelta) {
    var cur = anchorOf(o, oA, o.scrollTop);
    if (cur == null) { cur = lastTgtE.has(o) ? lastTgtE.get(o) : 0; }
    else { lastTgtE.set(o, cur); }
    var eIdeal = anchorOf(o, oA, idealPx);
    if (eIdeal == null) return null;
    // 大跳（滚动条/翻页/程序化归位）：单次移动远超手势步长，弹性钳制反而把目标
    // 卡在半路（如重置到顶后右面板停在中间），此时信任源直接完整跟随理想行位。
    if (Math.abs(srcDelta) >= JUMP_LINES) return eIdeal;
    var step = Math.max(MIN_LINES, Math.abs(srcDelta) * RATIO);
    var lo, hi;
    if (srcDelta > 0) { lo = cur - TOL; hi = cur + step; }          // 下滚：只许小幅回退
    else if (srcDelta < 0) { lo = cur - step; hi = cur + TOL; }     // 上滚：只许小幅前进
    else { lo = cur - TOL; hi = cur + TOL; }
    return Math.max(lo, Math.min(hi, eIdeal));
  }

  // ---------- 同步核心 ----------

  function applySync(src, pxOverride) {
    if (!src) return;
    var max = src.scrollHeight - src.clientHeight;
    if (max <= 0) return;                            // 驱动元素本身无可滚范围
    var px = (pxOverride != null) ? pxOverride : src.scrollTop;
    var ratio = max > 0 ? px / max : 0;              // 比例兜底（虚拟 px 可 >1 → 目标随之越过自身 max）
    var srcA = adapterOf(src);
    var e = anchorOf(src, srcA, px);
    var srcDelta = 0;
    var clamp = false;                               // 无历史基线（首帧）→ 完整对齐，不钳制
    if (e != null) {
      if (lastKnownE.has(src)) { srcDelta = e - lastKnownE.get(src); clamp = true; }
      lastKnownE.set(src, e);
    }
    syncing = true;
    for (var i = 0; i < els.length; i++) {
      var o = els[i];
      if (o === src) continue;
      var omax = o.scrollHeight - o.clientHeight;
      if (omax <= 0) continue;                       // 目标元素无可滚范围，跳过
      var oA = adapterOf(o);
      var ideal = (e != null) ? targetOf(oA, srcA, e) : null;
      if (ideal == null) ideal = ratio * omax;       // 无锚信息 → 比例兜底
      var target = Math.max(0, Math.min(omax, ideal));
      if (clamp && e != null && oA && oA.offsetOf) { // 弹性钳制：有行位信息时覆盖理想位置
        var tgtE = clampTarget(o, oA, ideal, srcDelta);
        if (tgtE != null) {
          var t2 = oA.offsetOf(tgtE);
          if (t2 != null) target = Math.max(0, Math.min(omax, t2));
        }
      }
      if (Math.abs(o.scrollTop - target) < 0.5) continue;   // 已到位则跳过，终止级联
      o.scrollTop = target;
      if (driven.indexOf(o) === -1) driven.push(o);          // 标记被驱动：其 echo scroll 不反驱
      var oe2 = oA ? anchorOf(o, oA, o.scrollTop) : null;
      lastKnownE.set(o, (oe2 != null) ? oe2 : e);            // 目标也记最后位置（跨手势）
      lastTgtE.set(o, (oe2 != null) ? oe2 : (lastTgtE.has(o) ? lastTgtE.get(o) : 0));
    }
    syncing = false;
  }

  function scheduleSync(src, px) {
    rafSrc = src;
    if (px != null) rafPx = px;
    if (rafPending) return;                          // 同帧合并：只同步一次
    rafPending = true;
    raf(function () {
      rafPending = false;
      applySync(rafSrc, rafPx);
      rafSrc = null; rafPx = null;
    });
  }

  // ---------- 监听（scroll / wheel / pointerdown）----------

  function makeScrollHandler(el) {
    return function () {
      if (syncing) return;
      var now = Date.now();
      var pv = pendingVirtual.get(el);
      var max = el.scrollHeight - el.clientHeight;
      var pinned = pv && now < pv.t && ((pv.dir > 0 && el.scrollTop >= max - 1) || (pv.dir < 0 && el.scrollTop <= 1));
      if (pv) {
        if (pinned) { scheduleSync(el, pv.px); return; }   // 仍贴边 → 用虚拟位置，防止回写覆写
        pendingVirtual.delete(el);
      }
      if (driven.indexOf(el) !== -1) return;        // 本手势内被我们写入的目标：echo，忽略
      if (driving !== el) initGesture(el);          // 新驱动源 → 重建基线
      else touchGesture();
      scheduleSync(el, null);
    };
  }

  function makeWheelHandler(el) {
    return function (ev) {
      if (syncing) return;
      var max = el.scrollHeight - el.clientHeight;
      if (max <= 0) return;
      var dy = ev.deltaY;
      if (ev.deltaMode === 1) dy *= 16;             // 行 → 像素
      else if (ev.deltaMode === 2) dy *= (el.clientHeight || 600);  // 页 → 像素
      if (!dy) return;
      var atBottom = el.scrollTop >= max - 1 && dy > 0;
      var atTop = el.scrollTop <= 1 && dy < 0;
      if (!atBottom && !atTop) {                    // 在范围内：交给原生滚动，scroll 事件驱动
        if (pendingVirtual.has(el)) pendingVirtual.delete(el);
        return;
      }
      // 推越边界：用虚拟位置（可越过 max / 0）继续驱动，源自身保持贴边。
      // TTL 内后续滚轮基于上次虚拟位置累积，持续越过边界直至目标各自到 max
      var now = Date.now();
      var pv = pendingVirtual.get(el);
      var base = (pv && now < pv.t) ? pv.px : (atBottom ? max : el.scrollTop);
      var pxV = base + dy;
      pendingVirtual.set(el, { px: pxV, t: now + VIRTUAL_TTL, dir: dy > 0 ? 1 : -1 });
      if (driving !== el) initGesture(el);
      else touchGesture();
      scheduleSync(el, pxV);
    };
  }

  function makePointerHandler(el) {
    return function () { clearGesture(); };        // 用户直接点击/拖拽该元素 → 结束旧手势
  }
  function onKeydown() { clearGesture(); }         // 键盘滚动同样结束旧手势

  function rebind(list) {
    for (var i = 0; i < bound.length; i++) {
      var b = bound[i];
      if (b.el.removeEventListener) {
        if (b.onScroll) b.el.removeEventListener('scroll', b.onScroll);
        if (b.onWheel) b.el.removeEventListener('wheel', b.onWheel);
        if (b.onPointer) b.el.removeEventListener('pointerdown', b.onPointer);
      }
    }
    bound = [];
    els = (list || []).filter(Boolean);
    clearGesture();
    // 初始行位基线：以当前各元素位置起算（首个手势的增量由此而来，而非“未知→完整对齐”）
    for (var k = 0; k < els.length; k++) {
      var a0 = adapterOf(els[k]);
      var ae = a0 ? anchorOf(els[k], a0, els[k].scrollTop) : null;
      if (ae != null) { lastKnownE.set(els[k], ae); lastTgtE.set(els[k], ae); }
    }
    for (var j = 0; j < els.length; j++) {
      var h = {
        onScroll: makeScrollHandler(els[j]),
        onWheel: makeWheelHandler(els[j]),
        onPointer: makePointerHandler(els[j])
      };
      els[j].addEventListener('scroll', h.onScroll);
      els[j].addEventListener('wheel', h.onWheel, { passive: true });
      els[j].addEventListener('pointerdown', h.onPointer);
      bound.push({ el: els[j], onScroll: h.onScroll, onWheel: h.onWheel, onPointer: h.onPointer });
    }
    if (root.document && root.document.addEventListener && !keyHooked) {
      root.document.addEventListener('keydown', onKeydown);
      keyHooked = true;
    }
  }

  function setAdapter(el, a) {
    if (!el || !a) return;
    for (var i = 0; i < adapters.length; i++) {
      if (adapters[i].el === el) { adapters[i].a = a; return; }
    }
    adapters.push({ el: el, a: a });
  }

  function setTranslator(fn) { translator = fn; }

  root.SyncScroll = { rebind: rebind, setAdapter: setAdapter, setTranslator: setTranslator };
})(typeof self !== 'undefined' ? self : this);
