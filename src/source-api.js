/**
 * source-api.js — 对比源文件系统 API 客户端（纯 fetch，无 DOM、无状态）。
 * 依赖 serve.js 的 /api/list 与 /api/file。
 * 全局暴露：Source
 *
 * Source.list(absPath)   → Promise<{ ok, path, dirs:[name], files:[{name,size,ext}] }>
 * Source.fileUrl(absPath)→ /api/file?path=... 的 URL（供 PDF 面板 / 提取文本用）
 */
(function (root) {
  'use strict';

  function list(absPath) {
    return fetch('/api/list?path=' + encodeURIComponent(absPath))
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data || data.ok !== true) throw new Error((data && data.error) || '列表获取失败');
        return data;
      });
  }

  function fileUrl(absPath) {
    return '/api/file?path=' + encodeURIComponent(absPath);
  }

  root.Source = { list: list, fileUrl: fileUrl };
})(typeof self !== 'undefined' ? self : this);
