/**
 * serve.js — 零依赖本地静态服务器（离线可用，无需 npm install）。
 * 用法：
 *   node serve.js            # 监听 0.0.0.0:3000，局域网内其他人可访问
 *   node serve.js 8080       # 自定义端口
 *   HOST=127.0.0.1 node serve.js   # 仅本机访问
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

var server = http.createServer(function (req, res) {
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
    lanIPv4().forEach(function (ip) { urls.push('http://' + ip + ':' + PORT); });
  } else {
    urls.push('http://' + HOST + ':' + PORT);
  }
  console.log('文本对比工具已启动：');
  urls.forEach(function (u) { console.log('  ' + u); });
  if (HOST === '0.0.0.0' || HOST === '::') {
    console.log('（局域网内其他设备访问上面的局域网地址；如无法访问，请放行 Windows 防火墙对 Node.js 的连接）');
  }
});