'use strict';
/**
 * fetch-api.js — /api/fetch 网页抓取代理测试（零依赖，不起浏览器）。
 * 运行：node test/fetch-api.js
 *
 * 用一个进程内 HTTP 源站验证真实出站链路（重定向 / 字节透传 / 缓存命中零出站），
 * 因此本测试必须放开内网拦截（ALLOW_PRIVATE_FETCH=1）；
 * 「默认拒绝内网」单独用不带该变量的子进程验证。
 */
var assert = require('assert');
var cp = require('child_process');
var http = require('http');
var os = require('os');
var path = require('path');
var fs = require('fs');
var Writable = require('stream').Writable;

process.env.ALLOW_PRIVATE_FETCH = '1';
// 缓存写到临时目录，避免污染用户真实缓存，也便于验证"命中零出站"
var CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-fetch-'));
process.env.DSH_WEB_CACHE = CACHE;

var serve = require('../serve.js');

var passed = 0, failed = 0;
var tests = [];
function check(name, fn) { tests.push([name, fn]); }

function mockRes() {
  var chunks = [];
  var res = new Writable({
    write: function (chunk, enc, cb) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); cb(); }
  });
  res._code = 0; res._headers = null; res._chunks = chunks; res._body = function () { return Buffer.concat(chunks); };
  res.writeHead = function (c, h) { res._code = c; res._headers = h || {}; };
  return res;
}

function callApi(url, method) {
  return new Promise(function (resolve) {
    var res = mockRes();
    var settled = false;
    function done() { if (!settled) { settled = true; resolve(res); } }
    res.on('finish', done);
    res.on('error', done);
    serve.handleApi({ url: url, method: method || 'GET' }, res);
    setTimeout(done, 8000);                     // 兜底：网络异常时不要让测试挂死
  });
}

// ---------- 源站 ----------
var hits = 0;
var server = http.createServer(function (req, res) {
  hits++;
  if (req.url === '/page.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><title>麸炒泽泻</title></head>'
      + '<body><div id="content_zw"><p>本品为泽泻的炮制品。</p></div></body></html>');
  } else if (req.url === '/gbk.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=gbk' });
    res.end(Buffer.from([0xc4, 0xe3, 0xba, 0xc3]));   // GBK「你好」两字节，服务端不得改动
  } else if (req.url === '/go') {
    res.writeHead(302, { Location: '/page.html' });
    res.end();
  } else if (req.url === '/boom') {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('上游炸了');
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('nope');
  }
});

function base() { return 'http://127.0.0.1:' + server.address().port; }

// ---------- 纯函数：内网判定 ----------
check('isPrivateAddress 覆盖 v4/v6 与映射地址', function () {
  var f = serve.isPrivateAddress;
  assert.strictEqual(f('127.0.0.1'), true);
  assert.strictEqual(f('10.1.2.3'), true);
  assert.strictEqual(f('192.168.1.1'), true);
  assert.strictEqual(f('172.16.0.1'), true);
  assert.strictEqual(f('172.15.0.1'), false);
  assert.strictEqual(f('169.254.1.1'), true);
  assert.strictEqual(f('8.8.8.8'), false);
  assert.strictEqual(f('::1'), true);
  assert.strictEqual(f('fd00::1'), true);
  assert.strictEqual(f('fe80::1'), true);
  assert.strictEqual(f('::ffff:127.0.0.1'), true);
  assert.strictEqual(f('2400:3200::1'), false);
});

// ---------- 抓取 ----------
check('正常抓取：200 + 字节 + miss', async function () {
  var before = hits;
  var res = await callApi('/api/fetch?url=' + encodeURIComponent(base() + '/page.html'));
  assert.strictEqual(res._code, 200);
  assert.strictEqual(res._headers['X-Fetch-Cache'], 'miss');
  assert.ok(/麸炒泽泻/.test(res._body().toString('utf8')), '正文应原样透传');
  assert.strictEqual(hits, before + 1, '应发生一次出站');
});

check('再抓一次：命中缓存且零出站', async function () {
  var before = hits;
  var res = await callApi('/api/fetch?url=' + encodeURIComponent(base() + '/page.html'));
  assert.strictEqual(res._code, 200);
  assert.strictEqual(res._headers['X-Fetch-Cache'], 'hit');
  assert.strictEqual(hits, before, '命中缓存不得出站');
});

check('nocache=1：强制重新出站', async function () {
  var before = hits;
  var res = await callApi('/api/fetch?url=' + encodeURIComponent(base() + '/page.html') + '&nocache=1');
  assert.strictEqual(res._headers['X-Fetch-Cache'], 'miss');
  assert.strictEqual(hits, before + 1);
});

check('非 utf-8 字符集：字节不被改动（交给前端 TextDecoder）', async function () {
  var res = await callApi('/api/fetch?url=' + encodeURIComponent(base() + '/gbk.html') + '&nocache=1');
  assert.strictEqual(res._code, 200);
  assert.deepStrictEqual(Array.from(res._body()), [0xc4, 0xe3, 0xba, 0xc3]);
  assert.ok(/charset=gbk/i.test(res._headers['Content-Type']), 'Content-Type 需透传');
});

check('重定向：跟随到末跳并回报最终地址', async function () {
  var res = await callApi('/api/fetch?url=' + encodeURIComponent(base() + '/go') + '&nocache=1');
  assert.strictEqual(res._code, 200);
  assert.ok(/\/page\.html$/.test(decodeURIComponent(res._headers['X-Fetch-Url'])), 'X-Fetch-Url 应为末跳');
});

check('上游 5xx：502 + 错误原因', async function () {
  var res = await callApi('/api/fetch?url=' + encodeURIComponent(base() + '/boom') + '&nocache=1');
  assert.strictEqual(res._code, 502);
  assert.strictEqual(JSON.parse(res._body().toString('utf8')).ok, false);
});

check('非 http(s) 协议：400 拒绝', async function () {
  var res = await callApi('/api/fetch?url=' + encodeURIComponent('file:///etc/passwd'));
  assert.strictEqual(res._code, 400);
});

check('缺 url 参数：400', async function () {
  var res = await callApi('/api/fetch');
  assert.strictEqual(res._code, 400);
});

check('默认（未放开内网）拒绝回环地址', function () {
  // 单独起一个子进程：它不继承 ALLOW_PRIVATE_FETCH，才能验到「默认拒绝」这条路。
  // 用临时脚本而不是 -e 拼字符串：嵌套引号写起来容易错，脚本文件可读也能单独跑。
  var script = path.join(CACHE, 'guard-probe.js');
  fs.writeFileSync(script, [
    'var serve = require(' + JSON.stringify(path.join(__dirname, '..', 'serve.js')) + ');',
    'serve.remoteGet("http://127.0.0.1:1/x", 0, function (err) {',
    '  console.log(err ? "e:" + err.message : "ok");',
    '});'
  ].join('\n'));
  var env = Object.assign({}, process.env);
  delete env.ALLOW_PRIVATE_FETCH;
  return new Promise(function (resolve, reject) {
    cp.execFile(process.execPath, [script], { env: env }, function (err, stdout, stderr) {
      if (err && !stdout) return reject(new Error('子进程跑不起来：' + stderr));
      try {
        assert.ok(/e:拒访内网地址/.test(stdout), '应被内网拦截，实际输出：' + stdout.trim());
        resolve();
      } catch (e) { reject(e); }
    });
  });
});

// ---------- 跑起来 ----------
server.listen(0, '127.0.0.1', function () {
  var chain = Promise.resolve();
  tests.forEach(function (t) {
    chain = chain.then(function () { return t[1](); }).then(
      function () { passed++; console.log('  ok  ' + t[0]); },
      function (e) { failed++; console.log('FAIL  ' + t[0] + '\n      ' + (e && e.message)); }
    );
  });
  chain.then(function () {
    server.close();
    try { fs.rmSync(CACHE, { recursive: true, force: true }); } catch (e) { /* 清不掉不影响结论 */ }
    console.log('\n' + passed + ' 通过 / ' + failed + ' 失败');
    process.exit(failed ? 1 : 0);
  });
});
