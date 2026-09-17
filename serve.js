/**
 * serve.js — 零依赖本地静态服务器（离线可用，无需 npm install）。
 * 用法：
 *   node serve.js            # 监听 0.0.0.0:3000，局域网内其他人可访问
 *   node serve.js 8080       # 自定义端口
 *   HOST=127.0.0.1 node serve.js   # 仅本机可访问
 *
 * 附加文件 API（供页面"对比源"读取本地文件系统，按绝对路径）：
 *   GET /api/list?path=<绝对路径>   → { ok, path, dirs:[name...], files:[{name,size,ext}] }
 *   GET /api/file?path=<绝对路径>   → 文件字节流
 *
 * ⚠️ 安全提示：API 不限制读取路径。监听 0.0.0.0 时局域网内任何人可枚举/读取本机任意文件，
 * 仅供本机/可信环境使用，建议 `HOST=127.0.0.1 node serve.js`。
 */
'use strict';
var http = require('http');
var fs = require('fs');
var path = require('path');
var os = require('os');

var PORT = parseInt(process.argv[2] || process.env.PORT || '3000', 10);
var HOST = process.argv[3] || process.env.HOST || '0.0.0.0';
var ROOT = __dirname;

/** 取本机局域网 IPv4 地址（供打印，方便分享给他人） */
function lanIPv4() {
  var nets = os.networkInterfaces();
  var out = [];
  Object.keys(nets).forEach(function (name) {
    (nets[name] || []).forEach(function (iface) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    });
  });
  return out;
}
var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};
var API_MIME = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.text': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

function sendJson(res, code, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/** 处理 /api/* 请求（导出便于 test/api-test.js 直接调用） */
function handleApi(req, res) {
  var u = new URL(req.url, 'http://localhost');
  var q = u.searchParams;
  if (u.pathname === '/api/list') {
    var lp = q.get('path');
    if (!lp) return sendJson(res, 400, { ok: false, error: '缺少 path 参数' });
    fs.readdir(lp, { withFileTypes: true }, function (err, entries) {
      if (err) return sendJson(res, 400, { ok: false, error: String((err && err.code) || err) });
      var dirs = [], files = [];
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (e.isDirectory()) {
          dirs.push(e.name);
        } else if (e.isFile()) {
          var st = null;
          try { st = fs.statSync(path.join(lp, e.name)); } catch (e2) { /* 忽略 */ }
          files.push({ name: e.name, size: st ? st.size : 0, ext: path.extname(e.name).toLowerCase().replace(/^\./, '') });
        }
      }
      dirs.sort();
      files.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
      sendJson(res, 200, { ok: true, path: lp, dirs: dirs, files: files });
    });
    return;
  }
  if (u.pathname === '/api/file') {
    var fp = q.get('path');
    if (!fp) return sendJson(res, 400, { ok: false, error: '缺少 path 参数' });
    fs.stat(fp, function (err, st) {
      if (err || !st.isFile()) return sendJson(res, 404, { ok: false, error: '文件不存在' });
      var ext = path.extname(fp).toLowerCase();
      res.writeHead(200, { 'Content-Type': API_MIME[ext] || 'application/octet-stream', 'Content-Length': st.size });
      fs.createReadStream(fp).on('error', function () { res.end(); }).pipe(res);
    });
    return;
  }
  sendJson(res, 404, { ok: false, error: '未知 API' });
}

function start() {
  var server = http.createServer(function (req, res) {
    if (req.url.indexOf('/api/') === 0) { handleApi(req, res); return; }
    var urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';
    var file = path.normalize(path.join(ROOT, urlPath));
    if (file.indexOf(ROOT) !== 0) { res.writeHead(403); res.end('forbidden'); return; }
    fs.readFile(file, function (err, buf) {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      var ext = path.extname(file).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(buf);
    });
  });

  server.listen(PORT, HOST, function () {
    var urls = ['http://localhost:' + PORT];
    if (HOST === '0.0.0.0' || HOST === '::') {
      urls.push('http://' + HOST + ':' + PORT);
      lanIPv4().forEach(function (ip) { urls.push('http://' + ip + ':' + PORT); });
      console.log('⚠️  注意：当前监听 0.0.0.0，/api 可读取任意绝对路径，建议 `HOST=127.0.0.1 node serve.js` 仅本机使用');
    } else {
      urls.push('http://' + HOST + ':' + PORT);
    }
    console.log('文本对比工具已启动：');
    urls.forEach(function (u) { console.log('  ' + u); });
  });
  return server;
}

if (require.main === module) start();

module.exports = { handleApi: handleApi, start: start, MIME: MIME, API_MIME: API_MIME };
