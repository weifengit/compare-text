/**
 * local-file.js — 拖入文件的注册表。
 *
 * 为什么需要它：浏览器的 File 对象没有磁盘路径，而整条装载链路
 * （Pipeline.loadSide → Source.fileUrl → pdf.js / docx / 文本 / Excel 对比）
 * 只认"一个能 fetch 的引用"。这里把拖入的 File 登记成 ref，由 source-api
 * 换成 blob: URL，于是拖入的文件与磁盘上的文件走完全相同的下游代码。
 *
 * ref 形如 blobdrop/<自增号>/<原文件名>：
 *   ① 末段是真实文件名与扩展名 —— 下游按 .pdf/.docx/.xlsx/文本 的分支判定、
 *      标签页标题的 baseName() 取文件名，都不必改动；
 *   ② 带自增号 —— 同名不同目录的两个文件不会互相顶掉。
 *
 * 生命周期：只活在当前会话。File 背后是磁盘句柄，页面刷新即失效，
 * 这与浏览器给普通文件的语义一致，不额外做持久化。
 * 纯逻辑 + 一个 object URL，无 DOM 依赖，浏览器/Node 共用。
 * 全局暴露：LocalFile
 *
 * LocalFile.refFor(file)  → string（登记并返回引用，同一 file 重复调用得到新引用）
 * LocalFile.isRef(ref)    → boolean
 * LocalFile.url(ref)      → string（blob: URL，惰性创建并缓存；未登记返回 ''）
 * LocalFile.file(ref)     → File|null
 * LocalFile.name(ref)     → string（引用里的文件名）
 * LocalFile.release(ref)  → 释放该引用的 object URL
 */
(function (root) {
'use strict';

var PREFIX = 'blobdrop/';

/**
 * MIME 表与 serve.js 的 API_MIME 保持一致：拖入文件与磁盘文件必须被下游
 * 同样地解读（尤其 .xlsx 这类 ZIP 二进制，给成 text/plain 会读成乱码）。
 */
var MIME = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.xls': 'application/vnd.ms-excel',
  '.txt': 'text/plain; charset=utf-8',
  '.text': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

var seq = 0;
var entries = {};   // ref → { file, url }

function nameOf(ref) {
  return String(ref || '').replace(/^.*[\\/]/, '');
}

function refFor(file) {
  if (!file) return '';
  var ref = PREFIX + (++seq) + '/' + String(file.name || '拖入的文件');
  entries[ref] = { file: file, url: '' };
  return ref;
}

function isRef(ref) {
  return String(ref || '').indexOf(PREFIX) === 0;
}

function entryOf(ref) {
  return isRef(ref) ? (entries[ref] || null) : null;
}

function file(ref) {
  var e = entryOf(ref);
  return e ? e.file : null;
}

function url(ref) {
  var e = entryOf(ref);
  if (!e) return '';
  if (!e.url) {
    var m = /\.[A-Za-z0-9]+$/.exec(nameOf(ref));
    var ext = m ? m[0].toLowerCase() : '';
    // 扩展名认不出时退回 File 自带的 type（系统按内容/后缀给的），再兜底二进制
    var type = MIME[ext] || e.file.type || 'application/octet-stream';
    e.url = URL.createObjectURL(new Blob([e.file], { type: type }));
  }
  return e.url;
}

function release(ref) {
  var e = entryOf(ref);
  if (!e) return;
  if (e.url) URL.revokeObjectURL(e.url);
  delete entries[ref];
}

function count() {
  var n = 0;
  for (var k in entries) if (Object.prototype.hasOwnProperty.call(entries, k)) n++;
  return n;
}

root.LocalFile = {
  refFor: refFor, isRef: isRef, url: url, file: file,
  name: nameOf, release: release, count: count
};
})(typeof self !== 'undefined' ? self : this);
