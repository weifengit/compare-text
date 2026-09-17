/**
 * worker.js — Web Worker：接收 { id, payload }，在后台执行 diff，返回 { id, result }。
 */
'use strict';

importScripts('../lib/diff.min.js', 'normalize.js', 'compute.js');

self.onmessage = function (e) {
  var msg = e.data;
  try {
    var result = Compute.computeDiff(msg.payload);
    self.postMessage({ id: msg.id, result: result });
  } catch (err) {
    self.postMessage({ id: msg.id, error: (err && err.stack) ? String(err.stack) : String(err) });
  }
};