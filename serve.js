/**
 * serve.js — 零依赖本地静态服务器（离线可用，无需 npm install）。
 * 用法：
 *   node serve.js            # 监听 0.0.0.0:3000，局域网内其他人可访问
 *   node serve.js 8080       # 自定义端口
 *   HOST=127.0.0.1 node serve.js   # 仅本机可访问
 *   node serve.js build      # 重建 Tauri 打包用的前端目录 dist/（等价旧 build-web.js）
 *
 * 附加文件 API（供页面"对比源"读取本地文件系统，按绝对路径）：
 *   GET /api/list?path=<绝对路径>   → { ok, path, dirs:[name...], files:[{name,size,ext}] }
 *   GET /api/file?path=<绝对路径>   → 文件字节流
 *   GET  /api/ocr-cache?path=<绝对路径>   → OCR 结果缓存查询（{ ok, hit, text?, items? }）
 *   POST /api/ocr-cache             → 写 OCR 结果缓存（body={ path, text, items }）
 * OCR 缓存键 = sha1(path+size+mtime)，文件变化自动失效；缓存目录默认 ~/.compare-text/ocr-cache
 * （可用环境变量 DSH_OCR_CACHE 覆盖），供扫描版 PDF 识别结果跨运行复用、避免重复 OCR。
 *
 * ⚠️ 安全提示：API 不限制读取路径。监听 0.0.0.0 时局域网内任何人可枚举/读取本机任意文件，
 * 仅供本机/可信环境使用，建议 `HOST=127.0.0.1 node serve.js`。
 */
'use strict';
var http = require('http');
var fs = require('fs');
var path = require('path');
var os = require('os');
var crypto = require('crypto');

var PORT = parseInt(process.argv[2] || process.env.PORT || '3000', 10);
var HOST = process.argv[3] || process.env.HOST || '0.0.0.0';
var ROOT = __dirname;

/** 取本机局域网 IPv4 地址（供打印，方便分享给他人） */
var IS_WIN = process.platform === 'win32';

function isDriveRoot(p) {
  return IS_WIN && /^[A-Za-z]:[\\/]?$/.test(p);
}

/** 列出某目录下的子文件夹（带完整路径），按名称排序 */
function listDirs(p, cb) {
  fs.readdir(p, { withFileTypes: true }, function (err, entries) {
    if (err) return cb(err);
    var out = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!e.isDirectory()) continue;
      if (IS_WIN && (e.name === 'System Volume Information' || e.name === '$RECYCLE.BIN')) continue;
      out.push({ name: e.name, path: path.join(p, e.name) });
    }
    out.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    cb(null, out);
  });
}

/** Windows 盘符列表（fs.access 逐个字母探测，避免外调 WMI） */
function listDrives(cb) {
  if (!IS_WIN) return cb(null, [{ name: '/', path: '/' }]);
  var letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  var out = [];
  var idx = 0;
  (function step() {
    var L = letters[idx++];
    if (!L) { out.sort(function (a, b) { return a.name < b.name ? -1 : 1; }); return cb(null, out); }
    fs.access(L + ':\\', function (err) { if (!err) out.push({ name: L + ':', path: L + ':\\' }); step(); });
  })();
}

/** 上一级目录；'' 表示无上级（盘符根 / 系统根），此时由 browse 回退到盘符列表 */
function parentOf(bp) {
  var resolved = path.resolve(bp);
  if (IS_WIN) {
    if (isDriveRoot(resolved)) return '';                              // C:\ → 上级是盘符列表
    var dir = path.dirname(resolved);
    return dir.replace(/[\\/]+$/, '');
  }
  if (resolved === '/') return '';
  return path.dirname(resolved);
}

/** 目录浏览：供页面"对比源"文件夹选择弹层使用 */
function browse(bp, cb) {
  bp = String(bp || '').trim();
  if (bp === '' || bp === '/' || bp === '\\') {
    if (IS_WIN) listDrives(function (err, drives) {
      if (err) return cb(err);
      cb(null, { path: '', parent: '', kind: 'drives', dirs: drives });
    });
    else listDirs('/', function (err, ds) {
      if (err) return cb(err);
      cb(null, { path: '/', parent: '', kind: 'dir', dirs: ds });
    });
    return;
  }
  fs.stat(bp, function (err, st) {
    if (err || !st.isDirectory()) return cb(new Error('目录不存在：' + bp));
    var abs = path.resolve(bp);
    listDirs(abs, function (err2, ds) {
      if (err2) return cb(err2);
      cb(null, { path: abs, parent: parentOf(abs), kind: 'dir', dirs: ds });
    });
  });
}

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
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg'
};
var API_MIME = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
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

// ---------- OCR 结果磁盘缓存（扫描版 PDF 识别结果复用） ----------
// 缓存键 = sha1(绝对路径 + 文件大小 + mtimeMs)：文件一变键即变，天然失效。
// 缓存目录自动降级：$DSH_OCR_CACHE → ~/.compare-text/ocr-cache（首选，持久）→ os.tmpdir()
// （写不进去时的兜底，如受限沙箱）。进程内解析一次，保证 GET/POST 用同一目录。
var ocrCacheDirResolved = null;
function ocrCacheDir() {
  if (ocrCacheDirResolved) return ocrCacheDirResolved;
  var cands = [];
  if (process.env.DSH_OCR_CACHE) cands.push(process.env.DSH_OCR_CACHE);
  cands.push(path.join(os.homedir(), '.compare-text', 'ocr-cache'));
  cands.push(path.join(os.tmpdir(), 'compare-text-ocr-cache'));
  for (var i = 0; i < cands.length; i++) {
    try {
      fs.mkdirSync(cands[i], { recursive: true });
      var probe = path.join(cands[i], '.probe-' + process.pid);
      fs.writeFileSync(probe, '1');
      fs.unlinkSync(probe);
      ocrCacheDirResolved = cands[i];
      try { fs.writeFileSync('/tmp/ocr-cache-debug.log', 'dir=' + cands[i] + '\n', { flag: 'a' }); } catch (e3) {}
      return ocrCacheDirResolved;
    } catch (e) { try { fs.writeFileSync('/tmp/ocr-cache-debug.log', 'cand fail: ' + cands[i] + ' ' + e.message + '\n', { flag: 'a' }); } catch (e3) {} }
  }
  ocrCacheDirResolved = cands[cands.length - 1];
  return ocrCacheDirResolved;
}
function ocrCacheKey(absPath, st) {
  return crypto.createHash('sha1').update(absPath + '|' + st.size + '|' + st.mtimeMs).digest('hex');
}
function ocrCacheFile(absPath, st) {
  return path.join(ocrCacheDir(), ocrCacheKey(absPath, st) + '.json');
}

/** 读缓存：命中且结构合法 → { text, items }；未命中/损坏 → null（调用方回退 OCR） */
function ocrCacheRead(absPath, st, cb) {
  fs.readFile(ocrCacheFile(absPath, st), 'utf8', function (err, raw) {
    if (err) return cb(null);
    var obj = null;
    try { obj = JSON.parse(raw); } catch (e) { /* 损坏 */ }
    if (!obj || typeof obj.text !== 'string' || !obj.text || !Array.isArray(obj.items) || !obj.items.length) {
      try { fs.unlinkSync(ocrCacheFile(absPath, st)); } catch (e2) { /* 忽略 */ }
      return cb(null);
    }
    cb({ text: obj.text, items: obj.items });
  });
}

/** 写缓存：目录已由 ocrCacheDir 确保存在，原子写临时文件后改名（避免半截 JSON 被读到）。失败静默。 */
function ocrCacheWrite(absPath, st, text, items) {
  var file = ocrCacheFile(absPath, st), tmp = file + '.' + process.pid + '.tmp';
  try { fs.writeFileSync('/tmp/ocr-cache-debug.log', 'write entry file=' + file + ' textlen=' + (text && text.length) + '\n', { flag: 'a' }); } catch (e3) {}
  var payload = JSON.stringify({ path: absPath, size: st.size, mtimeMs: st.mtimeMs, cachedAt: Date.now(), text: text, items: items });
  fs.writeFile(tmp, payload, function (err) {
    if (err) { try { fs.writeFileSync('/tmp/ocr-cache-debug.log', 'write fail: ' + err.message + '\n', { flag: 'a' }); } catch (e3) {} return; }
    fs.rename(tmp, file, function () {});
  });
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
  if (u.pathname === '/api/browse') {
    browse(q.get('path') || '', function (err, data) {
      if (err) return sendJson(res, 400, { ok: false, error: String((err && err.message) || err) });
      sendJson(res, 200, Object.assign({ ok: true }, data));
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
  // OCR 结果缓存：GET 查询 / POST 写入（body={ path, text, items }）
  // 服务端按 path+size+mtime 算键；命中返回 { ok:true, hit:true, text, items }，未命中 { ok:true, hit:false }
  if (u.pathname === '/api/ocr-cache') {
    if (req.method === 'POST') {
      try { fs.writeFileSync('/tmp/ocr-cache-debug.log', 'POST arrived cl=' + (req.headers['content-length'] || '?') + '\n', { flag: 'a' }); } catch (e3) {}
      var chunks = [];
      req.on('data', function (c) { chunks.push(c); });
      req.on('end', function () {
        var body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { try { fs.writeFileSync('/tmp/ocr-cache-debug.log', 'body parse fail len=' + Buffer.concat(chunks).length + '\n', { flag: 'a' }); } catch (e3) {} }
        if (!body || typeof body.path !== 'string' || typeof body.text !== 'string' || !body.text || !Array.isArray(body.items) || !body.items.length) {
          try { fs.writeFileSync('/tmp/ocr-cache-debug.log', 'body invalid path=' + (body && body.path) + ' text=' + (body && typeof body.text) + ' items=' + (body && Array.isArray(body.items) ? body.items.length : 'n/a') + '\n', { flag: 'a' }); } catch (e3) {}
          return sendJson(res, 400, { ok: false, error: '请求体需要 { path, text, items }' });
        }
        fs.stat(body.path, function (err, st) {
          if (err || !st.isFile()) { try { fs.writeFileSync('/tmp/ocr-cache-debug.log', 'stat fail ' + err + '\n', { flag: 'a' }); } catch (e3) {} return sendJson(res, 404, { ok: false, error: '文件不存在' }); }
          ocrCacheWrite(body.path, st, body.text, body.items);
          sendJson(res, 200, { ok: true });
        });
      });
      return;
    }
    var oc = q.get('path');
    if (!oc) return sendJson(res, 400, { ok: false, error: '缺少 path 参数' });
    fs.stat(oc, function (err, st) {
      if (err || !st.isFile()) return sendJson(res, 404, { ok: false, error: '文件不存在' });
      ocrCacheRead(oc, st, function (hit) {
        if (!hit) return sendJson(res, 200, { ok: true, hit: false });
        sendJson(res, 200, { ok: true, hit: true, text: hit.text, items: hit.items, pages: hit.items.length });
      });
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

/** 重建 Tauri 打包用的前端目录 dist/（由 tauri.conf.json 的 beforeBuildCommand 自动调用）。用法：node serve.js build */
function buildWeb() {
  var DIST = path.join(ROOT, 'dist');
  var ENTRIES = ['index.html', 'styles.css', 'lib', 'src', 'models'];
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  ENTRIES.forEach(function (name) {
    fs.cpSync(path.join(ROOT, name), path.join(DIST, name), { recursive: true });
  });
  console.log('[build] dist/ 已生成：' + ENTRIES.join(', '));
}

if (require.main === module) {
  if (process.argv[2] === 'build') buildWeb();
  else start();
}

module.exports = { handleApi: handleApi, start: start, MIME: MIME, API_MIME: API_MIME,
  ocrCacheDir: ocrCacheDir, ocrCacheKey: ocrCacheKey, ocrCacheRead: ocrCacheRead, ocrCacheWrite: ocrCacheWrite };
