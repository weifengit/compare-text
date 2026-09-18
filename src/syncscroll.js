/**
 * syncscroll.js — 跨区域垂直协同滚动（内容锚定版）。
 * 职责：把一组可滚动元素绑定为内容对齐的纵向联动。用于 主区域1(标注) / 主区域2(编辑) / 主区域3(PDF)。
 *
 * 定位原则（文字内容才是定位的关键）：
 *  - 以“文本行号”为公共坐标系。每个元素可注册适配器：
 *      { side:'L'|'R', lineAt(px)→行号, offsetOf(line)→px, lineH(line)→px }
 *    滚动时先把驱动区视口顶部换算为「锚定行 + 行内偏移比例」，
 *    再把其余各区滚动到同一行 —— 页数不同、字号/版式不同、PDF 与文本高度无关，均不影响对照。
 *  - 左右两侧（原文/修改）行号体系不同，由 setTranslator 注册的换算函数互译
 *    （app.js 用 diff 对齐行(li,ri)构表，线性插值 + 端点斜率1外推）。
 *  - 无适配器/行号不可得（flow 跨侧、PDF 未加载、桩测试环境）时自动降级为比例同步。
 *
 * 防抖动/防回环：
 *  - rAF 合并：同帧多次 scroll 只同步一次（无 rAF 回退 setTimeout）；
 *  - 幂等设置：|Δ|<0.5 跳过；
 *  - 写入抑制：程序化写 scrollTop 后 90ms 内忽略该元素的 scroll 事件，
 *    避免锚定行号取整造成的 1 行级回声抖动（A→B→A）；
 *  - 无可滚范围(max<=0)的元素跳过。
 *
 * SyncScroll.rebind([el, ...])                       // 重新绑定（旧监听自动解绑）
 * SyncScroll.setAdapter(el, {side,lineAt,offsetOf,lineH})   // 注册内容锚适配器（全部可选）
 * SyncScroll.setTranslator(fn(fromSide,toSide,line))        // 左右行号互译（返回 null → 比例兜底）
 */
(function (root) {
  'use strict';

  var bound = [];      // [{el, fn}] 已绑定，便于解绑
  var els = [];        // 当前分组（handler 闭包共享，避免旧监听引用过期数组）
  var adapters = [];   // [{el, a}] 元素 → 内容锚适配器
  var translator = null;
  var syncing = false;
  var rafPending = false;
  var rafSrc = null;
  var suppress = [];   // [{el, t}] 程序化写入后短暂抑制该元素的 scroll 事件

  var raf = (typeof window !== 'undefined' && window.requestAnimationFrame)
    ? function (fn) { return window.requestAnimationFrame(fn); }
    : function (fn) { return setTimeout(fn, 16); };

  function adapterOf(el) {
    for (var i = 0; i < adapters.length; i++) {
      if (adapters[i].el === el) return adapters[i].a;
    }
    return null;
  }

  function isSuppressed(el) {
    var now = Date.now();
    for (var i = suppress.length - 1; i >= 0; i--) {
      if (suppress[i].t < now) { suppress.splice(i, 1); continue; }
      if (suppress[i].el === el) return true;
    }
    return false;
  }

  /** 驱动区当前视口顶部 → {line, frac}；不可得 → null（整体走比例兜底） */
  function anchorOf(src, srcA, px) {
    if (!srcA || !srcA.lineAt) return null;
    var line = null;
    try { line = srcA.lineAt(px); } catch (e) { line = null; }
    if (line == null) return null;
    var frac = 0;
    if (srcA.offsetOf) {
      var off = null, h = null;
      try { off = srcA.offsetOf(line); } catch (e2) { /* 忽略 */ }
      if (srcA.lineH) { try { h = srcA.lineH(line); } catch (e3) { /* 忽略 */ } }
      if (off != null && h > 0) frac = Math.max(0, Math.min(1, (px - off) / h));
    }
    return { line: line, frac: frac };
  }

  /** 目标区应滚到的像素：行号（必要时跨侧互译）→ 像素 + 行内偏移；不可得 → null */
  function targetOf(oA, srcSide, anchor) {
    if (!oA || !oA.offsetOf) return null;
    var line = anchor.line;
    if (oA.side && srcSide && oA.side !== srcSide) {
      line = translator ? translator(srcSide, oA.side, anchor.line) : null;
      if (line == null) return null;
    }
    var off = null, h = null;
    try { off = oA.offsetOf(line); } catch (e) { /* 忽略 */ }
    if (off == null) return null;
    if (oA.lineH) { try { h = oA.lineH(line); } catch (e2) { /* 忽略 */ } }
    return off + anchor.frac * (h || 0);
  }

  function applySync(src) {
    if (!src) return;
    var max = src.scrollHeight - src.clientHeight;
    if (max <= 0) return;                       // 驱动元素本身无可滚范围
    var px = src.scrollTop;
    var ratio = px / max;
    var srcA = adapterOf(src);
    var anchor = anchorOf(src, srcA, px);
    var srcSide = srcA ? srcA.side : null;
    syncing = true;
    for (var i = 0; i < els.length; i++) {
      var o = els[i];
      if (o === src) continue;
      var omax = o.scrollHeight - o.clientHeight;
      if (omax <= 0) continue;                  // 目标元素无可滚范围，跳过
      var target = anchor ? targetOf(adapterOf(o), srcSide, anchor) : null;
      if (target == null) target = ratio * omax;    // 无锚信息 → 比例兜底
      target = Math.max(0, Math.min(omax, target));
      if (Math.abs(o.scrollTop - target) < 0.5) continue;   // 已到位则跳过，终止级联
      o.scrollTop = target;
      suppress.push({ el: o, t: Date.now() + 90 });         // 抑制程序化写入引发的回声事件
    }
    syncing = false;
  }

  function makeHandler(el) {
    return function () {
      if (syncing || rafPending || isSuppressed(el)) return;
      rafSrc = el;
      rafPending = true;
      raf(function () {
        rafPending = false;
        applySync(rafSrc);
        rafSrc = null;
      });
    };
  }

  function rebind(list) {
    for (var i = 0; i < bound.length; i++) {
      if (bound[i].el.removeEventListener) bound[i].el.removeEventListener('scroll', bound[i].fn);
    }
    bound = [];
    els = (list || []).filter(Boolean);
    for (var j = 0; j < els.length; j++) {
      var fn = makeHandler(els[j]);
      els[j].addEventListener('scroll', fn);
      bound.push({ el: els[j], fn: fn });
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
