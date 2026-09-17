/**
 * api-test.js — serve.js 的 /api/list 与 /api/file 单元测试。
 * 直接调用导出的 handleApi（mock req/res），不占用真实端口。
 * 运行：node test/api-test.js
 */
'use strict';
var fs = require('fs');
var os = require('os');
var path = require('path');
var Writable = require('stream').Writable;
var serve = require('../serve.js');

// 真实 Writable：serve.js 的 createReadStream().pipe(res) 需要流的 on/write/end 语义
function mockRes() {
  var chunks = [];
  var res = new Writable({
    write: function (chunk, enc, cb) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      cb();
    }
  });
  res._code = 0; res._headers = null; res._chunks = chunks; res._done = false;
  res.writeHead = function (c, h) { res._code = c; res._headers = h || {}; };
  res.on('finish', function () { res._done = true; });
  return res;
}

function callApi(req) {
  return new Promise(function (resolve) {
    var res = mockRes();
    serve.handleApi(req, res);
    var iv = setInterval(function () {
      if (res._done) { clearInterval(iv); resolve(res); }
    }, 5);
  });
}

function bodyOf(res) { return res._chunks.map(String).join(''); }

var passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (extra ? '\n      ' + extra : '')); }
}

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diffchecker-api-'));
fs.mkdirSync(path.join(tmp, '子文件夹'));
fs.writeFileSync(path.join(tmp, '子文件夹', '原始文件.pdf'), Buffer.from('%PDF-1.4 test pdf bytes'));
fs.writeFileSync(path.join(tmp, '说明.txt'), 'hello\nworld');

(async function main() {
  console.log('api list + file\n');

  // /api/list 正常
  var res = await callApi({ url: '/api/list?path=' + encodeURIComponent(tmp) });
  var data = JSON.parse(bodyOf(res));
  check('/api/list 返回 ok:true 且列出目录/文件',
    data.ok === true && data.dirs.indexOf('子文件夹') !== -1
    && data.files.some(function (f) { return f.name === '说明.txt'; }));
  check('/api/list 列出文件扩展名与大小',
    data.files.some(function (f) { return f.name === '说明.txt' && f.ext === 'txt' && f.size === 11; }));

  // 缺少 path
  res = await callApi({ url: '/api/list' });
  check('/api/list 缺 path → 400 {ok:false}', res._code === 400 && JSON.parse(bodyOf(res)).ok === false);

  // 无效路径
  res = await callApi({ url: '/api/list?path=' + encodeURIComponent('/no/such/dir-xyz') });
  check('/api/list 无效路径 → 400 {ok:false}', res._code === 400 && JSON.parse(bodyOf(res)).ok === false);

  // /api/file PDF：字节 + Content-Type
  var pdfPath = path.join(tmp, '子文件夹', '原始文件.pdf');
  res = await callApi({ url: '/api/file?path=' + encodeURIComponent(pdfPath) });
  check('/api/file 返回 200 且 Content-Type=application/pdf',
    res._code === 200 && res._headers['Content-Type'] === 'application/pdf');
  check('/api/file 字节与原文件一致', Buffer.concat(res._chunks).equals(fs.readFileSync(pdfPath)));

  // /api/file 不存在
  res = await callApi({ url: '/api/file?path=' + encodeURIComponent(path.join(tmp, '不存在.pdf')) });
  check('/api/file 不存在 → 404 {ok:false}', res._code === 404 && JSON.parse(bodyOf(res)).ok === false);

  // 未知 API
  res = await callApi({ url: '/api/other' });
  check('未知 API → 404 {ok:false}', res._code === 404 && JSON.parse(bodyOf(res)).ok === false);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
