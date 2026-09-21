'use strict';
/**
 * render.js — 无头渲染通道：一条命令产出一份对比报告（单对 / 批量）。
 * 批量：一份报告最多 10 对（C3），超出请拆成多个任务分别调用，本工具直接报错拒绝。
 * 从 tools/spike-capture.js 起步（CDP 连接、超时、看门狗、逐页滚动收敛等基础设施直接复用），
 * 驱动真实页面复用 src/ 同一套模块（Pipeline.loadSide / compare / DocxView / PdfView），不重写渲染逻辑。
 *
 * 用法：node tools/render.js --task demo.json
 *   task = { title, pairs:[{left,right}], options:{ignoreCase,ignoreEol,ignoreWhitespace,
 *           ignoreNewline,ignoreWidth,ignorePunct}, output }   （options 缺省与页面默认一致：全开）
 *
 * 标准输出（stdout）为一行结构化 JSON；日志走 stderr，不污染 stdout：
 *   { ok, output, stats:{pairs,added,removed,changed}, warnings:[] }
 * 退出码：0 成功；非 0 任务错误（1 常规失败，2 环境不可用，3 看门狗超时）。
 *
 * ── "已知的坑"逐条落实 ──
 *   1. 负/零高度 clip 会让 captureScreenshot 永久挂起 → capture() 带超时 + 调用前校验 clipH/clipW > 2
 *   2. 协同滚动会把 scrollTop 拉回 0 → 先 SyncScroll.rebind([]) 再覆盖 rebind 为空函数
 *   3. scrollTop 要"写到稳定"（写→等→校验→再确认），末页目标值 clamp 到 scrollHeight-clientHeight
 *   4. 默认布局下面板只有约 186px 高 → 注入无头布局：隐藏主区域1/2、.pdfarea 撑满
 *   5. console 走管道会缓冲 → 日志写 stderr，并带看门狗
 *   6. 协同滚动解除后面板状态与交互态不同 → 不依赖界面滚动联动（只截面板）
 *   7. 面板可视高度有限：一次截只能拿到可见部分（长页必被截断）；而"把面板撑高再一次截整篇"
 *      已被 spike 证伪（视口外内容整片空白）→ 一页按可视高度分多次滚动切片，在 Node 内拼成
 *      整页一张图：每次切片都落在"内容确实在视口内"的已验证区间，与页高无关。
 *
 * 快照一律"按页"出图（PDF 取 .pdf-page、docx 取分页块）：只按页元素矩形与面板可视内容盒求交，
 * 不做字符级/段落级的锚点对齐——报告里的图是给人看的整页视觉记录，不需要像素级对齐文字锚点。
 */
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var zlib = require('zlib');
var Report = require(path.join(__dirname, '..', 'src', 'report.js'));

var ROOT = path.join(__dirname, '..');
var HTTP_PORT = 4310 + (process.pid % 200);
var DBG_PORT = 9410 + (process.pid % 200);

function log(s) { process.stderr.write(s + '\n'); }

// ---------- 浏览器定位：EDGE_PATH → Edge 默认路径 → Chrome 兜底，都找不到明确报错 ----------
function resolveBrowser() {
  var cands = [];
  if (process.env.EDGE_PATH) cands.push(process.env.EDGE_PATH);
  if (process.platform === 'darwin') {
    cands.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    cands.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  } else {
    cands.push('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
    cands.push('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe');
    cands.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  }
  for (var i = 0; i < cands.length; i++) {
    try { if (fs.existsSync(cands[i])) return cands[i]; } catch (e) { /* 继续 */ }
  }
  return null;
}
var BROWSER = resolveBrowser();

// ---------- 参数 ----------
function parseArgs(argv) {
  var task = null;
  for (var i = 2; i < argv.length; i++) {
    if (argv[i] === '--task' && i + 1 < argv.length) task = argv[i + 1];
  }
  return task;
}

// ---------- 基础设施（复用 spike-capture.js） ----------
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function fetchJson(url) { return fetch(url).then(function (r) { return r.json(); }); }
var serverProc = null, edgeProc = null, ws = null, msgId = 0, pending = {};
function cdpSend(method, params, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var id = ++msgId;
    var t = setTimeout(function () {
      delete pending[id];
      reject(new Error('CDP 调用超时 ' + timeoutMs + 'ms: ' + method));
    }, timeoutMs || 30000);
    pending[id] = {
      resolve: function (v) { clearTimeout(t); resolve(v); },
      reject: function (e) { clearTimeout(t); reject(e); }
    };
    ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
  });
}
function evaluate(expr) {
  return cdpSend('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    .then(function (res) {
      if (res.exceptionDetails) throw new Error('页面内执行异常: ' + JSON.stringify(res.exceptionDetails).slice(0, 300));
      return res.result ? res.result.value : undefined;
    });
}
function evalJson(expr) { return evaluate(expr).then(function (v) { return JSON.parse(v); }); }
function poll(expr, pred, tries, label) {
  return (function loop(n) {
    return evaluate(expr).then(function (v) {
      if (pred(v)) return v;
      if (n <= 0) throw new Error('等待超时：' + label + '，最后值 ' + JSON.stringify(v).slice(0, 200));
      return wait(300).then(function () { return loop(n - 1); });
    });
  })(tries == null ? 40 : tries);
}
// 坑 1：captureScreenshot 带超时；负/零 clip 高度会静默挂起，调用方必须先校验 clipH/clipW
// 实测配置锁定（dsf=2 无头 Edge）：clip.scale=1 会在个别页产出确定性的横向撕裂带（同一行位置
// 复现：整行残影 + 贯穿整页的横线，重试无用）；fromSurface=false 直接截出全白图。
// clip.scale=2 + captureBeyondViewport=true + fromSurface=true 是 spike 以来一直验证干净的路径，
// 多出的 2x 像素在 Node 内 box 降采样回 2x（见 capturePage），细节无损、体积可控。
function capture(clip, scale) {
  return cdpSend('Page.captureScreenshot', {
    format: 'png',
    clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: scale || 1 },
    captureBeyondViewport: true,
    fromSurface: true
  }, 60000).then(function (r) { return Buffer.from(r.data, 'base64'); });
}
// ---------- PNG 编解码（拼图用）：切片各自成图，必须能在 Node 内合成整页一张图 ----------
function paeth(a, b, c) {
  var p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** 解码 8bit / 非隔行的 RGB(2) 或 RGBA(6) PNG（Chrome 截图即此二者）→ { w, h, rgba }；
 *  其它格式返回 null（调用方据此判定"截到坏图"）。逐行 unfilter，Sub/Up/Average/Paeth 全支持。 */
function decodePng(buf) {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  var w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  var depth = buf[24], ctype = buf[25], interlace = buf[28];
  if (depth !== 8 || interlace !== 0 || (ctype !== 2 && ctype !== 6)) return null;
  if (w < 1 || h < 1 || w > 20000 || h > 20000) return null;
  var bpp = ctype === 6 ? 4 : 3, stride = w * bpp;
  var off = 8, idat = [];
  while (off + 8 <= buf.length) {
    var len = buf.readUInt32BE(off), type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(buf.slice(off + 8, off + 8 + len));
    off += 12 + len;
    if (type === 'IEND') break;
  }
  var raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch (e) { return null; }
  if (raw.length < (stride + 1) * h) return null;
  var rgba = Buffer.alloc(w * h * 4);
  var prev = Buffer.alloc(stride), cur = Buffer.alloc(stride), pos = 0, x, y;
  for (y = 0; y < h; y++) {
    var f = raw[pos++];
    raw.copy(cur, 0, pos, pos + stride); pos += stride;
    if (f === 1) for (var i = bpp; i < stride; i++) cur[i] = (cur[i] + cur[i - bpp]) & 255;
    else if (f === 2) for (var j = 0; j < stride; j++) cur[j] = (cur[j] + prev[j]) & 255;
    else if (f === 3) for (var k = 0; k < stride; k++) cur[k] = (cur[k] + ((k < bpp ? 0 : cur[k - bpp]) + prev[k]) >> 1) & 255;
    else if (f === 4) for (var m = 0; m < stride; m++) cur[m] = (cur[m] + paeth(m < bpp ? 0 : cur[m - bpp], prev[m], m < bpp ? 0 : prev[m - bpp])) & 255;
    for (x = 0; x < w; x++) {
      var s = x * bpp, d = (y * w + x) * 4;
      rgba[d] = cur[s]; rgba[d + 1] = cur[s + 1]; rgba[d + 2] = cur[s + 2];
      rgba[d + 3] = ctype === 6 ? cur[s + 3] : 255;
    }
    var t = prev; prev = cur; cur = t;
  }
  return { w: w, h: h, rgba: rgba };
}

var CRC_TABLE = (function () {
  var t = new Int32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  var c = -1;
  for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function pngChunk(type, data) {
  var head = Buffer.alloc(8), crc = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  crc.writeUInt32BE(crc32(Buffer.concat([head.slice(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
/** 编码 RGBA → PNG（8bit RGBA、过滤器固定 0，体积交给 zlib） */
function encodePng(w, h, rgba) {
  var stride = w * 4, raw = Buffer.alloc((stride + 1) * h);
  for (var y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/** 整数倍 box 降采样（f=2：2×2 块取均）→ 新对象 {w,h,rgba}；f<=1 原样返回 */
function downscale(img, f) {
  if (!(f > 1)) return img;
  var w = Math.floor(img.w / f), h = Math.floor(img.h / f);
  var out = Buffer.alloc(w * h * 4);
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var r = 0, g = 0, b = 0, a = 0;
      for (var dy = 0; dy < f; dy++) {
        for (var dx = 0; dx < f; dx++) {
          var i = ((y * f + dy) * img.w + (x * f + dx)) * 4;
          r += img.rgba[i]; g += img.rgba[i + 1]; b += img.rgba[i + 2]; a += img.rgba[i + 3];
        }
      }
      var n = f * f, d = (y * w + x) * 4;
      out[d] = Math.round(r / n); out[d + 1] = Math.round(g / n);
      out[d + 2] = Math.round(b / n); out[d + 3] = Math.round(a / n);
    }
  }
  return { w: w, h: h, rgba: out };
}

/** 把切片的 [srcTop, h) 行贴到整页画布的 dstRow（宽度取两者较小值，防越界）；返回写入行数 */
function blit(dst, dstW, src, srcTop, dstRow) {
  var dstH = Math.floor(dst.length / 4 / dstW);
  var rows = Math.max(0, Math.min(src.h - srcTop, dstH - dstRow));
  var cols = Math.min(src.w, dstW);
  for (var y = 0; y < rows; y++) {
    src.rgba.copy(dst, (dstRow + y) * dstW * 4, ((srcTop + y) * src.w) * 4, ((srcTop + y) * src.w + cols) * 4);
  }
  return rows;
}

/** 暗像素占比（%）：抽样步长 32px，用于识别空白图 / 坏帧 */
function darkRatio(rgba, w, h) {
  var dark = 0, tot = 0;
  for (var y = 0; y < h; y += 8) {
    for (var x = 0; x < w; x += 32) {
      var i = (y * w + x) * 4;
      if ((rgba[i] + rgba[i + 1] + rgba[i + 2]) / 3 < 128) dark++;
      tot++;
    }
  }
  return tot ? +(100 * dark / tot).toFixed(2) : 0;
}
function cleanup() {
  clearTimeout(WATCHDOG);
  try { if (ws) ws.close(); } catch (e) {}
  try {
    if (edgeProc) {
      if (process.platform === 'win32') cp.execSync('taskkill /PID ' + edgeProc.pid + ' /T /F 2>nul');
      else { try { process.kill(-edgeProc.pid, 'SIGKILL'); } catch (e0) {} edgeProc.kill(); }
    }
  } catch (e2) {}
  try { if (serverProc) serverProc.kill(); } catch (e3) {}
}
// 坑 5：看门狗，卡住时给出失败 JSON 而非静默挂死
var WATCHDOG = setTimeout(function () {
  process.stderr.write('!! 看门狗触发：240s 未完成，强制退出\n');
  process.stdout.write(JSON.stringify({ ok: false, output: null, stats: { pairs: 0, added: 0, removed: 0, changed: 0 }, warnings: ['看门狗超时'] }) + '\n');
  try { process.exit(3); } catch (e) {}
}, 240000);

// ---------- 逐页快照采集（B4） ----------
/** 坑 3：把面板滚到指定位置并确认"稳住了"；目标值在页面内 clamp 到 scrollHeight-clientHeight
 *  （末页目标会超过滚动上限，不 clamp 会永远判定"没收敛"，白白重试多轮） */
function scrollPanelTo(pid, target) {
  var want = -1;
  return (async function () {
    for (var attempt = 1; attempt <= 6; attempt++) {
      want = await evaluate('(function(){var p=document.getElementById(' + JSON.stringify(pid) + ');' +
        'var want=Math.min(Math.max(0,' + Math.round(target) + '),p.scrollHeight-p.clientHeight);' +
        'p.scrollTop=want;return Math.round(want);})()');
      await wait(220);
      var now = await evaluate('document.getElementById(' + JSON.stringify(pid) + ').scrollTop');
      if (Math.abs(now - want) < 2) {
        await wait(180);   // 再观察一次：确认没被后续帧拉回
        var again = await evaluate('document.getElementById(' + JSON.stringify(pid) + ').scrollTop');
        if (Math.abs(again - want) < 2) return { ok: true, target: want, attempts: attempt };
      }
    }
    return { ok: false, target: want, attempts: 6 };
  })();
}

/**
 * 切片几何：页元素矩形 ∩ 面板可视内容盒，全部视口坐标。
 * 可视内容盒用 clientWidth/clientHeight 推（二者已排除滚动条）：面板是 overflow:auto，
 * 若用 pr.right-border-padding 去算，会把滚动条那一条也算成可视内容，截图右/下边缘
 * 会带上一条面板底色 + 相邻面板的边线（旧实现"左侧截图把右侧也截进来"的来源之一）。
 *   - 纵向求交：一次只截"确实看得见"的那段，长页靠多次滚动切片覆盖
 *   - 横向求交：页比面板宽时（docx 缩放不足，元素矩形会伸出面板）按元素矩形取
 *     会把相邻面板的内容一起截进来，必须夹在可视内容盒内
 *   - offStart/offEnd：该切片对应的"页内像素"纵向范围，供拼回整页
 *   - base：页顶在滚动内容中的坐标（扣掉面板自身 border+padding），滚动定位用
 */
function sliceGeom(pid, sel, k) {
  return evalJson('JSON.stringify((function(){var p=document.getElementById(' + JSON.stringify(pid) + ');' +
    'var el=p.querySelectorAll(' + JSON.stringify(sel) + ')[' + k + '];' +
    'var er=el.getBoundingClientRect(),pr=p.getBoundingClientRect();' +
    'var cs=getComputedStyle(p),q=function(n){return parseFloat(cs[n])||0;};' +
    'var bt=q("borderTopWidth"),bl=q("borderLeftWidth"),pt=q("paddingTop"),pl=q("paddingLeft");' +
    'var vl=pr.left+bl+pl,vr=vl+p.clientWidth-pl-q("paddingRight");' +
    'var vt=pr.top+bt+pt,vb=vt+p.clientHeight-pt-q("paddingBottom");' +
    'var x0=Math.max(er.left,vl),x1=Math.min(er.right,vr);' +
    'var y0=Math.max(er.top,vt),y1=Math.min(er.bottom,vb);' +
    'return {clipX:x0+window.scrollX,clipY:y0+window.scrollY,clipW:x1-x0,clipH:y1-y0,' +
    'pageH:er.height,pageW:er.width,offStart:y0-er.top,offEnd:y1-er.top,' +
    'base:er.top-pr.top+p.scrollTop-(bt+pt),visH:vb-vt,visW:vr-vl};})())');
}

/**
 * 按页出图：一页 = 多次"滚动步进 + 截可视区"，在 Node 内拼成整页一张图。
 * 面板可视高度有限，一次截只能拿到可见部分（长页必被截断）；把面板撑高再一次截整篇又被
 * spike 证伪（视口外内容整片空白）。切片拼图两难皆避：每片都在已验证的"内容确实可见"区间。
 * 返回 { rgba, w, h, filled, dark }（仍未编码，交给调用方校验后再编码）。
 */
async function capturePage(pid, sel, k, scale, label) {
  var g0 = await sliceGeom(pid, sel, k);
  if (!(g0.pageH > 2) || !(g0.clipW > 2)) {
    throw new Error(label + ' 第 ' + (k + 1) + ' 页尺寸异常（页高 ' + g0.pageH.toFixed(1) +
      '，可视宽 ' + g0.clipW.toFixed(1) + '）');
  }
  var canvas = null, W = 0, H = 0, ratio = 0, filled = 0, slices = 0;
  var off = 0, guard = Math.ceil(g0.pageH / Math.max(40, g0.visH)) + 8;
  while (off < g0.pageH - 1 && guard-- > 0) {
    var sc = await scrollPanelTo(pid, g0.base + off);
    var g = await sliceGeom(pid, sel, k);
    // 坑 1：负/零高度 clip 会永久挂起，先校验
    if (!(g.clipH > 2) || !(g.clipW > 2)) {
      throw new Error(label + ' 第 ' + (k + 1) + ' 页 ' + Math.round(off) + 'px 处不在视口内（clipH=' +
        g.clipH.toFixed(1) + '，scrollTop 目标 ' + sc.target + '，稳定=' + sc.ok + '）');
    }
    var buf = await capture({ x: g.clipX, y: g.clipY, width: g.clipW, height: g.clipH }, scale);
    var img = decodePng(buf);
    if (!img) throw new Error(label + ' 第 ' + (k + 1) + ' 页切片解码失败（非 8bit RGB/RGBA PNG）');
    // 截图像素比 = dpr × clip.scale（dpr=2 强制 + scale=2 → 4x）。目标成图固定 2x（与文档约定的
    // 1224×1584/页一致）：高于 2x 的部分 box 降采样回来，细节不变（画布本来就是 2x 光栅化）、
    // 体积只有 4x 直存的 1/4 左右。
    img = downscale(img, Math.max(1, Math.round(img.w / g.clipW / 2)));
    if (!canvas) {
      // 像素比由实拍图反推（dpr × clip.scale ÷ 降采样倍率），不假设 devicePixelRatio 的具体值
      ratio = img.w / g.clipW;
      W = img.w;
      H = Math.max(1, Math.round(g.pageH * ratio));
      canvas = Buffer.alloc(W * H * 4, 255);   // 白底：任何未覆盖的行都是页外空白
    }
    // 滚动到底被 clamp 时，末尾切片会与上一片重叠：必须按"已覆盖到的页内位置"裁掉重叠部分，
    // 否则同一段内容会被当成新内容往后贴（表现为页面内容重复出现一截）
    var coveredCss = filled / ratio;
    var skipCss = Math.max(0, coveredCss - g.offStart);
    var srcTop = Math.round(skipCss * ratio);
    var dstRow = Math.max(filled, Math.min(H - 1, Math.round((g.offStart + skipCss) * ratio)));
    if (img.h - srcTop > 0) filled = Math.min(H, dstRow + blit(canvas, W, img, srcTop, dstRow));
    slices++;
    off = g.offEnd;   // 推进到"本片已覆盖到的页内位置"，被 clamp 时也不会原地打转
  }
  return { rgba: canvas, w: W, h: H, filled: filled, slices: slices, dark: darkRatio(canvas, W, H) };
}

/** 逐页快照：返回 [{data,w,h}]；任何一页失败即抛错（该对计入 warning） */
async function snapSide(side, pid, sel, label) {
  var n = await evaluate('document.getElementById(' + JSON.stringify(pid) + ').querySelectorAll(' + JSON.stringify(sel) + ').length');
  var pages = [];
  var wide = await evalJson('JSON.stringify((function(){var p=document.getElementById(' + JSON.stringify(pid) + ');' +
    'var el=p.querySelectorAll(' + JSON.stringify(sel) + ')[0];if(!el)return {pageW:0,visW:0};' +
    'var cs=getComputedStyle(p),pr=p.getBoundingClientRect();' +
    'return {pageW:el.getBoundingClientRect().width,' +
    'visW:pr.width-(parseFloat(cs.borderLeftWidth)||0)-(parseFloat(cs.borderRightWidth)||0)' +
    '-(parseFloat(cs.paddingLeft)||0)-(parseFloat(cs.paddingRight)||0)};})())');
  if (wide.pageW > wide.visW + 1) {
    log('      ' + label + ' 页宽 ' + Math.round(wide.pageW) + 'px 超出面板可视宽 ' +
      Math.round(wide.visW) + 'px，横向会按可视区裁边（不越界截到另一侧面板）');
  }
  for (var k = 0; k < n; k++) {
    // 坑 6：pdf.js 的 page.render() 是异步的，canvas 尺寸一旦分配 loadedExpr 就返回 true，
    // 但画布可能还没画完（字体/CMap 解析慢或渲染任务排队）。逐页轮询"该页已渲染完成"标记。
    if (typeof PdfView !== 'undefined' && PdfView.isPageRendered) {
      await poll('JSON.stringify({ok:(function(){var r=' +
        'PdfView.isPageRendered(' + JSON.stringify(side) + ',' + (k + 1) + ');' +
        'return r;})()})',
        function (v) { return JSON.parse(v).ok; }, 120, label + ' 第 ' + (k + 1) + ' 页渲染完成');
    }
    await wait(120);
    // 坑 7：滚动+截图组合下 CDP capture 可能拿到几何未稳定/合成未更新的坏帧（随机空白、
    // 偶发 clip 高度错误）。从"结果端"兜底：校验拼图是否覆盖整页、是否有内容，异常重来
    // （最多 3 次），不依赖具体机制。
    var shot = null;
    for (var attempt = 1; attempt <= 3; attempt++) {
      shot = await capturePage(pid, sel, k, 2, label);
      var covered = shot.filled >= shot.h * 0.98;
      if (shot.dark > 0.15 && covered) break;
      log('      ' + label + ' 第 ' + (k + 1) + '/' + n + ' 页截图异常（dark=' + shot.dark + '%，' +
        '覆盖 ' + shot.filled + '/' + shot.h + 'px），第 ' + attempt + ' 次重试');
      await wait(300);
    }
    var buf = encodePng(shot.w, shot.h, shot.rgba);
    pages.push({ data: 'data:image/png;base64,' + buf.toString('base64'), w: shot.w, h: shot.h });
    log('      ' + label + ' 第 ' + (k + 1) + '/' + n + ' 页：' + shot.slices + ' 片拼成 ' +
      shot.w + '×' + shot.h + '（覆盖 ' + shot.filled + '/' + shot.h + 'px，dark=' + shot.dark + '%），' +
      (buf.length / 1024).toFixed(0) + 'KB');
  }
  return pages;
}

// ---------- 单对处理 ----------
/** 页面内驱动：加载两侧 → 比较 → 取结果 → 逐页快照。返回 {leftName,rightName,result,shots} */
async function renderPair(pair, opts, idx) {
  var left = path.resolve(pair.left), right = path.resolve(pair.right);
  if (!fs.existsSync(left)) throw new Error('左侧文件不存在：' + left);
  if (!fs.existsSync(right)) throw new Error('右侧文件不存在：' + right);
  var kindL = /\.docx$/i.test(left) ? 'docx' : /\.pdf$/i.test(left) ? 'pdf' : 'none';
  var kindR = /\.docx$/i.test(right) ? 'docx' : /\.pdf$/i.test(right) ? 'pdf' : 'none';
  log('  [对 ' + (idx + 1) + '] ' + path.basename(left) + ' ↔ ' + path.basename(right) + '（L=' + kindL + ' R=' + kindR + '）');

  // 选项先设好（页面自动对比会按当前选项跑），再加载。缺省与页面默认一致（全开）
  var M = { optIgnoreCase: 1, optIgnoreEol: 1, optIgnoreWhitespace: 1, optIgnoreNewline: 1, optIgnoreWidth: 1, optIgnorePunct: 1 };
  if (opts) {
    if ('ignoreCase' in opts) M.optIgnoreCase = opts.ignoreCase ? 1 : 0;
    if ('ignoreEol' in opts) M.optIgnoreEol = opts.ignoreEol ? 1 : 0;
    if ('ignoreWhitespace' in opts) M.optIgnoreWhitespace = opts.ignoreWhitespace ? 1 : 0;
    if ('ignoreNewline' in opts) M.optIgnoreNewline = opts.ignoreNewline ? 1 : 0;
    if ('ignoreWidth' in opts) M.optIgnoreWidth = opts.ignoreWidth ? 1 : 0;
    if ('ignorePunct' in opts) M.optIgnorePunct = opts.ignorePunct ? 1 : 0;
  }
  await evaluate('(function(){var M=' + JSON.stringify(M) + ';for(var id in M)' +
    'document.getElementById(id).checked=!!M[id];return 1;})()');
  await evaluate('Pipeline.loadSide("L", ' + JSON.stringify(left.replace(/\\/g, '/')) + ')');
  await evaluate('Pipeline.loadSide("R", ' + JSON.stringify(right.replace(/\\/g, '/')) + ')');

  // 等两侧渲染完成：PDF 等画布、docx 等 renderAsync + 文本提取
  function loadedExpr(side, kind) {
    var pid = side === 'L' ? 'pdfLeft' : 'pdfRight';
    if (kind === 'pdf') {
      return 'JSON.stringify({ok:(function(){var p=document.getElementById(' + JSON.stringify(pid) + ');' +
        'var c=p?p.querySelectorAll(".pdf-page canvas"):[];' +
        'return c.length>0&&Array.prototype.every.call(c,function(x){return x.width>0&&x.height>0;});})()})';
    }
    if (kind === 'docx') {
      return 'JSON.stringify({ok:(function(){var d=typeof DocxView!=="undefined"?DocxView._debug("' + side + '"):null;' +
        'return !!(d&&d.loaded&&d.hasText);})()})';
    }
    // 纯文本：无面板，等编辑区写入文本即可（.CodeMirror 按 DOM 顺序 = L、R）
    return 'JSON.stringify({ok:(function(){var eds=document.querySelectorAll(".CodeMirror");' +
      'return eds.length>1&&eds[' + (side === 'L' ? 0 : 1) + '].CodeMirror.getValue().length>0;})()})';
  }
  await poll(loadedExpr('L', kindL), function (v) { return JSON.parse(v).ok; }, 60, 'L 面板渲染');
  await poll(loadedExpr('R', kindR), function (v) { return JSON.parse(v).ok; }, 60, 'R 面板渲染');
  await evaluate('document.fonts.ready.then(function(){return 1})');

  // 报告默认执行一遍"修整"（同界面"修整"按钮：Norm.tidyText 去全部空白整理为单行），缩小报告空间占用。
  // 先等编辑器写入面板原文——PDF 提词晚于画布渲染，否则修整会被随后到来的原文覆盖。
  // 面板标注不受影响：编辑器文本与面板原文不一致时，Pipeline.syncPanelTextAnnotations 按面板原文另算标注。
  await poll('(function(){var eds=document.querySelectorAll(".CodeMirror");' +
    'return eds.length>1&&eds[0].CodeMirror.getValue().length>0&&eds[1].CodeMirror.getValue().length>0;})()',
    function (v) { return v === true; }, 60, '编辑器文本就绪');
  await evaluate('(function(){var eds=document.querySelectorAll(".CodeMirror");' +
    'var L=eds[0].CodeMirror,R=eds[1].CodeMirror;' +
    'L.setValue(Norm.tidyText(L.getValue()));R.setValue(Norm.tidyText(R.getValue()));return 1;})()');

  // 显式再算一次（上面自动对比已按同样选项跑过，这里保证拿到确定的最新结果）
  await evaluate('Pipeline.compare()');
  var rpoll = await poll('(function(){var r=Pipeline.getResult();if(!r)return "{\\"done\\":false}";' +
    'if(r.error)return JSON.stringify({done:true,err:String(r.error).slice(0,300)});' +
    'return JSON.stringify({done:true,mode:r.mode});})()',
    function (v) { var s = JSON.parse(v); return s.done; }, 80, '对比结果');
  var rinfo = JSON.parse(rpoll);
  if (rinfo.err) throw new Error('对比失败：' + rinfo.err);
  // 标注在 render() 内同步上色，但编辑器变更触发的防抖对比可能晚到，等它落定
  await wait(1200);

  // 诊断：docx 的 fitWidth 是否生效（scrollWidth≈面板宽 说明 zoom 已把页面收进面板，未被截断）
  if (kindL === 'docx' || kindR === 'docx') {
    var zinfo = await evalJson('JSON.stringify((function(){var out={};["pdfLeft","pdfRight"].forEach(function(id){' +
      'var p=document.getElementById(id);var h=p.querySelector(".docx-host");if(!h)return;' +
      'var sec=p.querySelector(".docx-wrapper section.docx");' +
      'out[id]={zoom:h.style.zoom||"1",secW:sec?Math.round(sec.offsetWidth):0,panelW:p.clientWidth,scrollW:p.scrollWidth};});' +
      'return out;})())');
    log('  docx fitWidth：' + JSON.stringify(zinfo));
  }

  // 取结果（只取报告需要的字段，避免把超大 charAnchors 等一起拉回）
  var result = await evalJson('(function(){var r=Pipeline.getResult();' +
    'if(!r)return "null";if(r.error)return JSON.stringify({error:r.error});' +
    'if(r.mode==="grid")return JSON.stringify({mode:"grid",rows:r.rows,leftLines:r.leftLines,' +
    'rightLines:r.rightLines,stats:r.stats});' +
    'if(r.mode==="flow"){if(r.skipped)return JSON.stringify({mode:"flow",skipped:true,leftLen:r.leftLen,rightLen:r.rightLen});' +
    'return JSON.stringify({mode:"flow",segsL:r.segsL,segsR:r.segsR,addedChars:r.addedChars,removedChars:r.removedChars});}' +
    'return "null";})()');

  // 逐侧快照（面板里真正渲染的是什么就按什么截）
  var kinds = await evalJson('(function(){function k(id){var p=document.getElementById(id);' +
    'if(p&&p.querySelector(".docx-host"))return "docx";if(p&&p.querySelectorAll(".pdf-page").length)return "pdf";return "none";}' +
    'return JSON.stringify({L:k("pdfLeft"),R:k("pdfRight")});})()');
  var shots = { L: [], R: [] };
  if (kinds.L === 'docx') shots.L = await snapSide('L', 'pdfLeft', '.docx-wrapper section.docx', 'L(docx)');
  else if (kinds.L === 'pdf') shots.L = await snapSide('L', 'pdfLeft', '.pdf-page', 'L(pdf)');
  if (kinds.R === 'docx') shots.R = await snapSide('R', 'pdfRight', '.docx-wrapper section.docx', 'R(docx)');
  else if (kinds.R === 'pdf') shots.R = await snapSide('R', 'pdfRight', '.pdf-page', 'R(pdf)');

  return { leftName: path.basename(left), rightName: path.basename(right), result: result, shots: shots };
}

function addStats(stats, result) {
  if (!result) return;
  if (result.mode === 'grid' && result.stats) {
    stats.added += result.stats.added;
    stats.removed += result.stats.removed;
    stats.changed += result.stats.modified;
  } else if (result.mode === 'flow') {
    stats.added += result.addedChars || 0;
    stats.removed += result.removedChars || 0;
  }
}

// ---------- 主流程 ----------
(async function main() {
  if (!BROWSER) {
    process.stderr.write('找不到浏览器：请安装 Edge，或用 EDGE_PATH 指定浏览器可执行文件路径\n');
    process.stdout.write(JSON.stringify({ ok: false, output: null, stats: { pairs: 0, added: 0, removed: 0, changed: 0 },
      warnings: ['找不到可用的浏览器（Edge/Chrome）'] }) + '\n');
    process.exit(2);
  }
  var taskPath = parseArgs(process.argv);
  if (!taskPath) {
    process.stderr.write('用法：node tools/render.js --task <task.json>\n');
    process.stdout.write(JSON.stringify({ ok: false, output: null, stats: { pairs: 0, added: 0, removed: 0, changed: 0 },
      warnings: ['缺少 --task 参数'] }) + '\n');
    process.exit(1);
  }
  var task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
  if (!task || !Array.isArray(task.pairs) || !task.pairs.length) {
    process.stdout.write(JSON.stringify({ ok: false, output: null, stats: { pairs: 0, added: 0, removed: 0, changed: 0 },
      warnings: ['任务缺少非空 pairs 数组'] }) + '\n');
    process.exit(1);
  }
  // C3 分卷：一份报告最多 10 对，超出由调用方切成多份（本工具不自行分卷，直接拒绝）
  if (task.pairs.length > 10) {
    var mCap = '一份报告最多 10 对（当前 ' + task.pairs.length + ' 对），请将任务拆成多份分别渲染';
    process.stderr.write(mCap + '\n');
    process.stdout.write(JSON.stringify({ ok: false, output: null, stats: { pairs: 0, added: 0, removed: 0, changed: 0 },
      warnings: [mCap] }) + '\n');
    process.exit(1);
  }
  var output = path.resolve(task.output || 'report.html');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  var warnings = [];
  var stats = { pairs: task.pairs.length, added: 0, removed: 0, changed: 0 };

  // 临时静态服务
  serverProc = cp.spawn(process.execPath, [path.join(ROOT, 'serve.js'), String(HTTP_PORT)], { stdio: 'ignore' });
  var i, up = false;
  for (i = 0; i < 40; i++) {
    try { await fetchJson('http://127.0.0.1:' + HTTP_PORT + '/api/list?path=' + encodeURIComponent(process.cwd())); up = true; break; }
    catch (e) { await wait(250); }
  }
  if (!up) throw new Error('serve.js 启动失败');

  // headless Edge + CDP。沙箱环境（如 dsh 执行命令的沙箱）里不带 --no-sandbox 时，
  // CDP 能连上（/json/list、WebSocket 均正常）但页面渲染进程不响应 Runtime.evaluate，
  // 显式 Page.navigate 也可能不提交 → 一律带 --no-sandbox 启动（无头本地渲染的常规做法）。
  // --force-device-scale-factor=2：无头下 devicePixelRatio=1，PdfView 按 dpr 光栅化画布
  // 会把 PDF 页渲染成 1x → 文字发虚。强制 dpr=2 后画布/文字都按 2x 真实光栅化。
  // 截图仍按 clip.scale=2（4x 像素）采集——dsf=2 下 scale=1 会踩 Chromium 确定性撕裂
  // （见 capture() 注释），4x 截回后 Node 内 box 降采样到 2x 成图，细节相同、体积 1/4。
  function launchEdge(extraArgs) {
    var profile = path.join(os.tmpdir(), 'edge-render-' + process.pid + (extraArgs.length ? '-ns' : ''));
    edgeProc = cp.spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
      '--window-size=1600,1400', '--no-sandbox', '--force-device-scale-factor=2',
      '--remote-debugging-port=' + DBG_PORT, '--user-data-dir=' + profile]
      .concat(extraArgs, ['http://127.0.0.1:' + HTTP_PORT + '/']), { stdio: 'ignore' });
    return (async function () {
      for (var k = 0; k < 60; k++) {
        if (edgeProc.exitCode !== null) return null;   // 进程已死（如被沙箱拦），不必干等
        try {
          var list = await fetchJson('http://127.0.0.1:' + DBG_PORT + '/json/list');
          var t = (list || []).filter(function (x) { return x.type === 'page' && x.url.indexOf('127.0.0.1:' + HTTP_PORT) !== -1; })[0];
          if (t) return t;
        } catch (e) { /* 未就绪 */ }
        await wait(300);
      }
      return null;
    })();
  }
  var pg = await launchEdge([]);
  if (!pg) {
    log('浏览器首次启动未拿到页面目标，重试一次（兼容启动抖动）');
    try { if (edgeProc) edgeProc.kill(); } catch (e0) {}
    pg = await launchEdge(['--retry']);
  }
  if (!pg) throw new Error('未拿到浏览器页面目标');
  ws = new WebSocket(pg.webSocketDebuggerUrl);
  await new Promise(function (res, rej) { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = function (ev) {
    var m = JSON.parse(ev.data);
    if (m.id && pending[m.id]) {
      var p = pending[m.id]; delete pending[m.id];
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  };
  log('CDP 已连接');

  // ② 沙箱环境里初始导航可能从未提交（页面目标在但停在 about:blank），显式导航一次确保真正加载
  try {
    await cdpSend('Page.navigate', { url: 'http://127.0.0.1:' + HTTP_PORT + '/' }, 15000);
    await wait(800);
  } catch (e) { log('  !! 显式导航失败（不致命，继续等页面就绪）：' + e.message); }

  await poll('(typeof Pipeline!=="undefined")&&(typeof PdfView!=="undefined")&&!!document.querySelector(".CodeMirror")',
    function (v) { return v === true; }, 40, '页面脚本就绪');
  // 坑 2：先解除协同滚动并掐死重绑（布局变化会重绑回监听器，把 scrollTop 拉回 0）
  await evaluate('(function(){try{if(typeof SyncScroll!=="undefined"&&SyncScroll.rebind){' +
    'SyncScroll.rebind([]);SyncScroll.rebind=function(){return;};return "unbound+locked";}}' +
    'catch(e){return "err:"+e.message;}return "absent";})()');
  // 坑 4：注入无头布局，主区域 3 撑满窗口（必须在加载 docx 之前：fitWidth 按最终面板宽度算 zoom）
  await evaluate('(function(){var s=document.createElement("style");s.id="render-css";' +
    's.textContent="#results,#resultsResize,#editors,#editorsResize{display:none !important}"+' +
    '"#pdfarea{flex:1 1 auto !important;max-height:none !important;margin-top:0 !important}"+' +
    '"#pdfarea .pdf-controls{display:none !important}";document.head.appendChild(s);return 1;})()');
  await wait(500);
  // 首屏 updatePdfArea() 会给 #pdfarea 加 hidden（无文件时不显示主区域3）；docx 的 fitWidth 在
  // load 时量面板宽算 zoom，此刻尚未有任何 onPanelsChanged 解除 hidden → clientWidth=0 → zoom
  // 退化为 1，页面按 A4 原大渲染、超出面板被截断。加载前先解除，与真实界面"有文件后显示主区域3"一致。
  await evaluate('(function(){var el=document.getElementById("pdfarea");if(el)el.classList.remove("hidden");return 1;})()');

  // 逐对处理：单对失败只记 warning 继续
  var pairs = [];
  for (i = 0; i < task.pairs.length; i++) {
    try {
      var p = await renderPair(task.pairs[i], task.options, i);
      pairs.push(p);
      addStats(stats, p.result);
    } catch (e) {
      var msg = '第 ' + (i + 1) + ' 对失败：' + ((e && e.message) || e);
      log('  !! ' + msg);
      warnings.push(msg);
      stats.pairs--;   // 成功的对数才计入
    }
  }
  if (!pairs.length) {
    process.stdout.write(JSON.stringify({ ok: false, output: null, stats: stats, warnings: warnings }) + '\n');
    process.exit(1);
  }

  // 组装报告并落盘
  var html = Report.build({
    title: task.title || '文本对比报告',
    time: new Date().toLocaleString('zh-CN'),
    pairs: pairs
  });
  fs.writeFileSync(output, html, 'utf8');
  log('报告已写入：' + output + '（' + (html.length / 1024).toFixed(0) + 'KB，' + pairs.length + ' 对）');

  process.stdout.write(JSON.stringify({ ok: warnings.length === 0, output: output, stats: stats, warnings: warnings }) + '\n');
  process.exit(warnings.length ? 1 : 0);
})().catch(function (e) {
  process.stderr.write('FAIL  ' + ((e && e.message) || e) + '\n');
  try {
    process.stdout.write(JSON.stringify({ ok: false, output: null, stats: { pairs: 0, added: 0, removed: 0, changed: 0 },
      warnings: [String((e && e.message) || e)] }) + '\n');
  } catch (e2) {}
  process.exit(1);
}).then(function () { cleanup(); });

// 保证退出前清理子进程
process.on('exit', cleanup);
