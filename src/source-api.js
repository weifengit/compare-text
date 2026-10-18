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
    // 表格：Blob 的 type 决定后续怎么被解读，给错会让 .text() 解出乱码
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
    '.xls': 'application/vnd.ms-excel',
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

  /**
   * 写文本文件（UTF-8）：导出报告用。
   * Tauri：Rust 命令写入（自动建父目录）——调用方先经 Picker 选定绝对路径再传入。
   * 浏览器：网页 JS 无权写任意磁盘路径，这里改用 File System Access API
   * （window.showSaveFilePicker）弹系统保存对话框让用户选真实位置；旧浏览器回退 Blob 下载。
   */
  function writeFile(absPath, content) {
    if (isTauri) {
      return tauriCore.invoke('api_write_file', { path: absPath, content: content });
    }
    var blob = new Blob([content], { type: 'text/html; charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = absPath.split('/').pop() || 'report.html';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
    return Promise.resolve();
  }

  /**
   * 浏览器模式：弹出系统"另存为"对话框，返回可写的文件句柄（需在用户手势窗口内调用）。
   * 报告生成耗时可观，故把"弹框取句柄"与"写入"拆开：先弹框捕获手势，生成后再写。
   * 不支持 File System Access API 时返回 null（调用方回退 Blob 下载）。
   * 运行在（可能跨源的）内嵌 frame 里时也返回 null：浏览器禁止跨源子 frame 弹文件选择框
   * （showSaveFilePicker 抛 "Cross origin sub frames aren't allowed to show a file picker"），
   * 调用方应回退为直接下载。Tauri 模式不适用（返回 null，调用方走 Picker + writeFile 流程）。
   */
  function inEmbeddedFrame() {
    try { return !!(root.self !== root.top); } catch (e) { return true; }
  }
  function saveAsHandle(name) {
    if (isTauri || inEmbeddedFrame() || !root.showSaveFilePicker) return Promise.resolve(null);
    var types = [{ description: 'HTML 报告', accept: { 'text/html': ['.html'] } }];
    return root.showSaveFilePicker({ suggestedName: name, types: types })
      .then(function (handle) { return handle; })
      .catch(function (e) {
        if (e && e.name === 'AbortError') throw new Error('已取消保存');
        throw e;
      });
  }

  /** 浏览器模式：把内容写入 saveAsHandle 拿到的句柄（返回写入的文件名）。 */
  function writeHandle(handle, content) {
    if (!handle || !handle.createWritable) return Promise.reject(new Error('无效的文件句柄'));
    return handle.createWritable()
      .then(function (w) { return w.write(content).then(function () { return w.close(); }); })
      .then(function () { return handle.name || 'report.html'; });
  }

  /** 二进制写文件：Excel 报告导出用（xlsx 不能走 writeFile 的字符串通道）。
   *  Tauri：传 base64 给 Rust 命令（比 number[] 快一个量级，也避免 IPC 体积膨胀）。
   *  浏览器：Blob 下载（同 writeFile 的降级路径）。
   */
  function writeBinary(absPath, bytes, mime) {
    if (isTauri) {
      return tauriCore.invoke('api_write_file_binary', {
        path: absPath,
        base64: bytesToBase64(bytes)
      });
    }
    var blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = String(absPath).split('/').pop() || 'report.xlsx';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
    return Promise.resolve();
  }

  /** 取文件原始字节（Excel 对比读表用，比 fileUrl 少一步 Blob URL 中转）。 */
  function readBytes(absPath) {
    if (isTauri) {
      return tauriCore.invoke('api_read_file', { path: absPath }).then(function (arr) {
        // Rust 返回 Vec<u8> → JSON 数字数组；转成 Uint8Array 便于下游处理
        return new Uint8Array(arr);
      });
    }
    return fetch('/api/file?path=' + encodeURIComponent(absPath)).then(function (r) {
      if (!r.ok) throw new Error('读取失败：HTTP ' + r.status);
      return r.arrayBuffer();
    });
  }

  /** Uint8Array → base64（分块避免超大数组一次展开导致栈溢出）。 */
  function bytesToBase64(bytes) {
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var CH = 0x8000, parts = [];
    for (var i = 0; i < u8.length; i += CH) {
      var chunk = u8.subarray(i, i + CH);
      var s = '';
      for (var j = 0; j < chunk.length; j++) s += String.fromCharCode(chunk[j]);
      parts.push(s);
    }
    return root.btoa(parts.join(''));
  }

  root.Source = { list: list, browse: browse, fileUrl: fileUrl, writeFile: writeFile,
    writeBinary: writeBinary, readBytes: readBytes,
    saveAsHandle: saveAsHandle, writeHandle: writeHandle, isTauri: isTauri };
})(typeof self !== 'undefined' ? self : this);
