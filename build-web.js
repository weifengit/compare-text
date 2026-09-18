/**
 * build-web.js — 把运行所需的前端文件复制到 dist/（Tauri 只打包这个目录）。
 * 由 tauri.conf.json 的 beforeDevCommand / beforeBuildCommand 自动调用，一般无需手动执行。
 * 手动执行：node build-web.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = __dirname;
var DIST = path.join(ROOT, 'dist');
var ENTRIES = ['index.html', 'styles.css', 'lib', 'src'];

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });
ENTRIES.forEach(function (name) {
  fs.cpSync(path.join(ROOT, name), path.join(DIST, name), { recursive: true });
});
console.log('[build-web] dist/ 已生成：' + ENTRIES.join(', '));
