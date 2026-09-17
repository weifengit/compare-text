/**
 * syncscroll.js — 跨区域垂直协同滚动。
 * 职责：把一组可滚动元素绑定为同一纵向进度（按各自可滚高度比例同步），
 * 任一元素滚动时带动其余元素。用于 主区域1(标注) / 主区域2(编辑) / 主区域3(PDF) 联动。
 * 不依赖具体页面结构；元素由调用方（app.js 协调）提供。全局暴露：SyncScroll
 *
 * 实现要点（避免“拖不动/卡住”）：
 *  - rAF 合并：同一帧内多次 scroll 事件只同步一次（无 rAF 环境回退 setTimeout），降低抖动；
 *  - 幂等设置：目标已到位(|Δ|<0.5)则跳过，终止程序化赋值引发的级联回环；
 *  - 无可滚范围(max<=0)的元素跳过，既不写 0 也不误带动。
 * SyncScroll.rebind([el, el, ...])   // 重新绑定；旧的自动解绑（无 removeEventListener 的桩元素忽略）
 */
(function (root) {
  'use strict';

  var bound = [];   // [{el, fn}] 已绑定，便于解绑
  var els = [];     // 当前分组（handler 闭包共享，避免旧监听引用过期数组）
  var syncing = false;
  var rafPending = false;
  var rafSrc = null;

  var raf = (typeof window !== 'undefined' && window.requestAnimationFrame)
    ? function (fn) { return window.requestAnimationFrame(fn); }
    : function (fn) { return setTimeout(fn, 16); };

  function applySync(src) {
    if (!src) return;
    var max = src.scrollHeight - src.clientHeight;
    if (max <= 0) return;                     // 驱动元素本身无可滚范围
    var ratio = src.scrollTop / max;
    syncing = true;
    for (var i = 0; i < els.length; i++) {
      var o = els[i];
      if (o === src) continue;
      var omax = o.scrollHeight - o.clientHeight;
      if (omax <= 0) continue;                // 目标元素无可滚范围，跳过
      var target = ratio * omax;
      if (Math.abs(o.scrollTop - target) < 0.5) continue;   // 已到位则跳过，终止级联
      o.scrollTop = target;
    }
    syncing = false;
  }

  function makeHandler(el) {
    return function () {
      if (syncing || rafPending) return;
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

  root.SyncScroll = { rebind: rebind };
})(typeof self !== 'undefined' ? self : this);
