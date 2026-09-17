/**
 * syncscroll.js — 跨区域垂直协同滚动。
 * 职责：把一组可滚动元素绑定为同一纵向进度（按各自可滚高度比例同步），
 * 任一元素滚动时带动其余元素。用于 主区域1(标注) / 主区域2(编辑) / 主区域3(PDF) 联动。
 * 不依赖具体页面结构；元素由调用方（app.js 协调）提供。全局暴露：SyncScroll
 *
 * SyncScroll.rebind([el, el, ...])   // 重新绑定；旧的自动解绑（无 removeEventListener 的桩元素忽略）
 */
(function (root) {
  'use strict';

  var bound = [];   // [{el, fn}] 已绑定，便于解绑
  var els = [];     // 当前分组（handler 闭包共享，避免旧监听引用过期数组）
  var syncing = false;

  function makeHandler(el) {
    return function () {
      if (syncing) return;
      var max = el.scrollHeight - el.clientHeight;
      var ratio = max > 0 ? el.scrollTop / max : 0;
      syncing = true;
      for (var i = 0; i < els.length; i++) {
        var o = els[i];
        if (o === el) continue;
        var omax = o.scrollHeight - o.clientHeight;
        o.scrollTop = omax > 0 ? ratio * omax : 0;
      }
      syncing = false;
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
