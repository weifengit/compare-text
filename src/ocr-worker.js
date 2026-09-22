/**
 * ocr-worker.js — OCR Web Worker：把 PP-OCR (onnxruntime-web wasm) 推理放后台，避免卡 UI。
 * 与 src/worker.js 同款经典 Worker（importScripts），不依赖构建。
 *
 * 消息协议（主线程 → Worker）：
 *   { type:'load',   baseUrl }                         → { type:'loaded' } | { type:'error', message }
 *   { type:'recognize', id, data:ArrayBuffer(transfer), byteOffset, byteLength,
 *     width, height, stride, pageW, pageH, scale, pageNum, startLine }
 *     → { type:'result', id, result:{ text, lines, items } } | { type:'error', id, message }
 *   { type:'ping' }                                    → { type:'pong' }
 *
 * result.items = Ocr.linesToTextItems 输出（pdf.js textItems 同构，跨页行号连续）。
 * 图片数据用 transferable 传输（data.buffer 转移所有权，主线程不再持有）。
 */
'use strict';

importScripts('../lib/onnxruntime/ort.wasm.min.js', 'ocr.js');

var runtimeReady = false;
var runtimeError = null;
var pendingId = 0;

/** Worker 内资源加载器：fetch 相对 baseUrl，无 document（不走 loadScript） */
function workerAssetLoader(baseUrl) {
  return {
    loadScript: function () { return Promise.reject(new Error('worker 环境不支持 loadScript')); },
    getBytes: function (rel) {
      return fetch(baseUrl + rel).then(function (r) {
        if (!r.ok) throw new Error('获取资源失败：' + rel + ' (HTTP ' + r.status + ')');
        return r.arrayBuffer();
      });
    },
    getText: function (rel) {
      return fetch(baseUrl + rel).then(function (r) {
        if (!r.ok) throw new Error('获取资源失败：' + rel + ' (HTTP ' + r.status + ')');
        return r.text();
      });
    }
  };
}

function post(msg) {
  self.postMessage(msg);
}

self.onmessage = function (e) {
  var msg = e.data || {};
  try {
    if (msg.type === 'ping') { post({ type: 'pong' }); return; }

    if (msg.type === 'load') {
      if (runtimeReady) { post({ type: 'loaded' }); return; }
      var baseUrl = msg.baseUrl || '';
      if (baseUrl && baseUrl[baseUrl.length - 1] !== '/') baseUrl += '/';
      if (!self.ort) throw new Error('ort 未就绪（importScripts 失败？）');
      if (!self.Ocr) throw new Error('Ocr 模块未就绪（importScripts 失败？）');
      Ocr.createRuntime({
        ort: self.ort,
        baseUrl: baseUrl,                     // 显式给绝对 URL 基准（ocr.js 内 new URL 解析资源路径用）
        assetLoader: workerAssetLoader(baseUrl),
        numThreads: 1
      }).then(function () {
        runtimeReady = true;
        post({ type: 'loaded' });
      }).catch(function (err) {
        runtimeError = (err && err.message) || String(err);
        post({ type: 'error', message: runtimeError });
      });
      return;
    }

    if (msg.type === 'recognize') {
      if (!runtimeReady) { post({ type: 'error', id: msg.id, message: runtimeError || 'OCR 运行时未就绪' }); return; }
      var data = new Uint8ClampedArray(msg.data, msg.byteOffset || 0, msg.byteLength || (msg.width * msg.height * 4));
      Ocr.recognize({ data: data, width: msg.width, height: msg.height, stride: msg.stride || msg.width * 4 })
        .then(function (res) {
          var items = Ocr.linesToTextItems(res.lines, msg.pageW, msg.pageH, msg.scale || 1, msg.pageNum || 1, msg.startLine || 0);
          post({ type: 'result', id: msg.id, result: { text: res.text, lines: res.lines, items: items } });
        })
        .catch(function (err) {
          post({ type: 'error', id: msg.id, message: (err && err.message) || String(err) });
        });
      return;
    }

    post({ type: 'error', id: msg.id, message: '未知消息类型：' + msg.type });
  } catch (err) {
    post({ type: 'error', id: msg.id, message: (err && err.message) || String(err) });
  }
};

// 预热：Worker 启动即 ping 一次（可选，便于主线程探测就绪）
post({ type: 'pong' });
