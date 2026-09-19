/**
 * source-api.js — 对比源文件系统 API 客户端（纯逻辑，无 DOM、无状态）。
 * 浏览器模式：走 serve.js 的 /api/list、/api/browse、/api/file。
 * Tauri 桌面模式：走同名 Rust 命令（src-tauri/src/lib.rs），不依赖 Node 服务器。
 * 全局暴露：Source
 *
 * Source.list(absPath)    → Promise<{ ok, path, dirs:[name], files:[{name,size,ext}] }>
 * Source.browse(path)     → Promise<{ ok, path, parent, kind, dirs:[{name,path}] }>
 * Source.fileUrl(absPath) → Promise<URL>（Tauri 下为 Blob URL；浏览器下为 /api/file URL）
 */
(function (root) {
  'use strict';

  var tauriCore = root.__TAURI__ && root.__TAURI__.core;
  var isTauri = !!(tauriCore && tauriCore.invoke);

  function checkOk(data, fallback) {
    if (!data || data.ok !== true) throw new Error((data && data.error) || fallback);
    return data;
  }

  function list(absPath) {
    if (isTauri) {
      return tauriCore.invoke('api_list', { path: absPath })
        .then(function (d) { return checkOk(d, '列表获取失败'); });
    }
    return fetch('/api/list?path=' + encodeURIComponent(absPath))
      .then(function (res) { return res.json(); })
      .then(function (d) { return checkOk(d, '列表获取失败'); });
  }

  function browse(p) {
    if (isTauri) {
      return tauriCore.invoke('api_browse', { path: p || '' })
        .then(function (d) { return checkOk(d, '目录读取失败'); });
    }
    return fetch('/api/browse?path=' + encodeURIComponent(p || ''))
      .then(function (res) { return res.json(); })
      .then(function (d) { return checkOk(d, '目录读取失败'); });
  }

  var MIME = {
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/plain; charset=utf-8',
    '.csv': 'text/plain; charset=utf-8',
    '.json': 'application/json; charset=utf-8'
  };

  /**
   * 取文件的可加载 URL（统一返回 Promise）。
   * Tauri：Rust 命令读出字节 → Blob URL（pdf.js 与 fetch 都能直接用）。
   * 浏览器：/api/file 的 URL 字符串（同步可得，包一层 Promise 统一签名）。
   */
  function fileUrl(absPath) {
    if (isTauri) {
      return tauriCore.invoke('api_read_file', { path: absPath }).then(function (bytes) {
        var m = /\.[A-Za-z0-9]+$/.exec(absPath);
        var type = (m && MIME[m[0].toLowerCase()]) || 'application/octet-stream';
        return URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: type }));
      });
    }
    return Promise.resolve('/api/file?path=' + encodeURIComponent(absPath));
  }

  root.Source = { list: list, browse: browse, fileUrl: fileUrl, isTauri: isTauri };
})(typeof self !== 'undefined' ? self : this);
