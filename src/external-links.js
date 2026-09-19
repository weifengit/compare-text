/**
 * external-links.js — 桌面（Tauri）模式下，把 target="_blank" 的外部链接交给系统默认浏览器。
 * WebView 不会像浏览器那样自动开新标签（Tauri 里点了要么没反应要么空白页）。
 * 检测到 __TAURI__.core.invoke 时拦截并调 Rust 侧 open_url 命令；浏览器模式不介入，走默认跳转。
 */
(function (root) {
  'use strict';
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    var a = (t && t.closest) ? t.closest('a[target="_blank"]') : null;
    if (!a || !a.href) return;
    var core = root.__TAURI__ && root.__TAURI__.core;
    if (!core || !core.invoke) return;   // 浏览器模式：默认行为
    ev.preventDefault();
    core.invoke('open_url', { url: a.href }).catch(function () {});
  });
})(typeof self !== 'undefined' ? self : this);
