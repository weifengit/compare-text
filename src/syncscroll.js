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
 * 多层面控制（杜绝跳页/抖动/回弹/卡死）：
 *  ① 连续行位：锚点与像素互转全程不取整。
 *  ② 手势模型：driving/driven —— 被驱动方整个手势内不反客为主。
 *  ③ 弹性跟随：源移动时按步长钳制；源停止时允许目标继续收敛到位（不卡死）。
 *  ④ 边界滚轮：源贴边时用虚拟位置继续驱动其它区。
 *
 * SyncScroll.rebind([el, ...])
 * SyncScroll.setAdapter(el, {side,lineAt,offsetOf,lineH})
 * SyncScroll.setTranslator(fn(srcA, oA, e))
 */
(function (root) {
  'use strict';

  var bound = [];
  var els = [];
  var adapters = [];
  var translator = null;
  var syncing = false;
  var rafPending = false;
  var rafSrc = null;
  var rafPx = null;

  var driving = null;
  var driven = [];
  var gestureTimer = null;
  var lastKnownE = new Map();
  var lastTgtE = new Map();
  var pendingVirtual = new Map();
  var keyHooked = false;

  // 弹性跟随参数（层3）。单位均为“连续行”。
  var RATIO = 1.25;
  var MIN_LINES = 0.15;
  var TOL = 0.2;
  var JUMP_LINES = 10;
  var GESTURE_IDLE = 200;
  var VIRTUAL_TTL = 200;
  // 像素级差距阈值：目标与理想位置像素差距 ≥ 该值 → 直接完整跟随（防卡死/防跳变）。
  var PX_GAP_BYPASS = 200;
  // 源行位变化低于该值视为“源基本停止”——不再钳制，允许目标收敛（关键修复）。
  var IDLE_DELTA = 0.3;

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
          if (f2 < frac) frac = f2;
        }
      }
    }
    return line + Math.max(0, frac);
  }

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
  function initGesture(el) {
    driving = el;
    driven = [];
    touchGesture();
  }

  // ---------- 层3：弹性钳制 ----------

  function clampTarget(o, oA, idealPx, srcDelta) {
    var cur = anchorOf(o, oA, o.scrollTop);
    if (cur == null) { cur = lastTgtE.has(o) ? lastTgtE.get(o) : 0; }
    else { lastTgtE.set(o, cur); }
    var eIdeal = anchorOf(o, oA, idealPx);
    if (eIdeal == null) return null;
    // 大跳（滚动条/翻页/程序化归位）：完整跟随
    if (Math.abs(srcDelta) >= JUMP_LINES) return eIdeal;
    // 像素差距大：完整跟随
    if (Math.abs(idealPx - o.scrollTop) >= PX_GAP_BYPASS) return eIdeal;
    // ★ 关键修复：源基本停止时不做弹性钳制，直接完整跟随。
    //   触发场景：源已到边界（视口不动，srcDelta=0），但目标还没到位——
    //   原逻辑走 else 分支把目标限在 cur±TOL 内，导致目标卡在半路、上不去/下不来，
    //   视觉上就是“抖动”。
    if (Math.abs(srcDelta) < IDLE_DELTA) return eIdeal;
    var step = Math.max(MIN_LINES, Math.abs(srcDelta) * RATIO);
    var lo, hi;
    if (srcDelta > 0) { lo = cur - TOL; hi = cur + step; }
    else { lo = cur - step; hi = cur + TOL; }
    return Math.max(lo, Math.min(hi, eIdeal));
  }

  // ---------- 同步核心 ----------

  function applySync(src, pxOverride) {
    if (!src) return;
    var max = src.scrollHeight - src.clientHeight;
    if (max <= 0) return;
    var px = (pxOverride != null) ? pxOverride : src.scrollTop;
    var ratio = max > 0 ? px / max : 0;
    var srcA = adapterOf(src);
    var e = anchorOf(src, srcA, px);
    var srcDelta = 0;
    var clamp = false;
    if (e != null) {
      if (lastKnownE.has(src)) { srcDelta = e - lastKnownE.get(src); clamp = true; }
      lastKnownE.set(src, e);
    }
    syncing = true;
    for (var i = 0; i < els.length; i++) {
      var o = els[i];
      if (o === src) continue;
      var omax = o.scrollHeight - o.clientHeight;
      if (omax <= 0) continue;
      var oA = adapterOf(o);
      var ideal = (e != null) ? targetOf(oA, srcA, e) : null;
      if (ideal == null) ideal = ratio * omax;
      var target = Math.max(0, Math.min(omax, ideal));
      if (clamp && e != null && oA && oA.offsetOf) {
        var tgtE = clampTarget(o, oA, ideal, srcDelta);
        if (tgtE != null) {
          var t2 = oA.offsetOf(tgtE);
          if (t2 != null) target = Math.max(0, Math.min(omax, t2));
        }
      }
      if (Math.abs(o.scrollTop - target) < 0.5) continue;
      if (driven.indexOf(o) === -1) driven.push(o);
      o.scrollTop = target;
      var oe2 = oA ? anchorOf(o, oA, o.scrollTop) : null;
      lastKnownE.set(o, (oe2 != null) ? oe2 : e);
      lastTgtE.set(o, (oe2 != null) ? oe2 : (lastTgtE.has(o) ? lastTgtE.get(o) : 0));
    }
    syncing = false;
  }

  function scheduleSync(src, px) {
    rafSrc = src;
    rafPx = (px != null) ? px : null;
    if (rafPending) return;
    rafPending = true;
    raf(function () {
      rafPending = false;
      applySync(rafSrc, rafPx);
      rafSrc = null; rafPx = null;
    });
  }

  // ---------- 监听 ----------

  function makeScrollHandler(el) {
    return function () {
      if (syncing) return;
      var now = Date.now();
      var pv = pendingVirtual.get(el);
      var max = el.scrollHeight - el.clientHeight;
      var pinned = pv && now < pv.t && ((pv.dir > 0 && el.scrollTop >= max - 1) || (pv.dir < 0 && el.scrollTop <= 1));
      if (pv) {
        if (pinned) { scheduleSync(el, pv.px); return; }
        pendingVirtual.delete(el);
      }
      if (driven.indexOf(el) !== -1) return;
      if (driving !== el) initGesture(el);
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
      if (ev.deltaMode === 1) dy *= 16;
      else if (ev.deltaMode === 2) dy *= (el.clientHeight || 600);
      if (!dy) return;
      var atBottom = el.scrollTop >= max - 1 && dy > 0;
      var atTop = el.scrollTop <= 1 && dy < 0;
      if (!atBottom && !atTop) {
        if (pendingVirtual.has(el)) pendingVirtual.delete(el);
        return;
      }
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
    return function () { clearGesture(); };
  }
  function onKeydown() { clearGesture(); }

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