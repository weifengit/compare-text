/**
 * make-icon.js — 生成应用图标源文件 icon.png（1024×1024，零依赖手写 PNG 编码器）。
 * 用法：node make-icon.js && npx tauri icon icon.png
 * 设计：深色背景 + 左右两份"文档"，左侧红色行=删除，右侧绿色行=新增（diff 主题）。
 * 想换成自己的图标：准备一张 ≥512×512 的 PNG，直接执行 npx tauri icon 你的图.png 即可。
 */
'use strict';
var fs = require('fs');
var zlib = require('zlib');
var path = require('path');

var SIZE = 1024;

/* ---------- 极简 PNG 编码器（RGBA8，无滤波） ---------- */
var CRC_TABLE = (function () {
  var t = new Int32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  var c = -1;
  for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  var out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.slice(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodePng(width, height, rgba) {
  var stride = width * 4 + 1;                     // 每行 = 1 字节滤波器标志 + RGBA 像素
  var raw = Buffer.alloc(stride * height);
  for (var y = 0; y < height; y++) {
    raw[y * stride] = 0;                          // 滤波器：None
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth = 8
  ihdr[9] = 6;   // color type = RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------- 画布（纯矩形拼贴） ---------- */
var px = Buffer.alloc(SIZE * SIZE * 4);
function rect(x, y, w, h, rgb) {
  for (var yy = Math.max(0, y); yy < Math.min(SIZE, y + h); yy++) {
    for (var xx = Math.max(0, x); xx < Math.min(SIZE, x + w); xx++) {
      var i = (yy * SIZE + xx) * 4;
      px[i] = rgb[0]; px[i + 1] = rgb[1]; px[i + 2] = rgb[2]; px[i + 3] = 255;
    }
  }
}

var BG = [15, 23, 42];        // #0f172a 深蓝黑背景
var PAPER = [226, 232, 240];  // #e2e8f0 文档底色
var LINE = [148, 163, 184];   // #94a3b8 普通文本行
var RED = [239, 68, 68];      // #ef4444 删除行
var GREEN = [34, 197, 94];    // #22c55e 新增行

rect(0, 0, SIZE, SIZE, BG);

var DOC_W = 268, DOC_H = 576, DOC_Y = 224;
var LEFT_X = 168, RIGHT_X = 588;
rect(LEFT_X, DOC_Y, DOC_W, DOC_H, PAPER);
rect(RIGHT_X, DOC_Y, DOC_W, DOC_H, PAPER);

// 文档内的"文本行"：6 行；左侧第 3 行标红（删除），右侧第 2 行标绿（新增）
var LINE_W = 172, LINE_H = 36, LINE_X_OFF = 48;
for (var row = 0; row < 6; row++) {
  var ly = 296 + row * 88;
  rect(LEFT_X + LINE_X_OFF, ly, LINE_W, LINE_H, row === 2 ? RED : LINE);
  rect(RIGHT_X + LINE_X_OFF, ly, LINE_W, LINE_H, row === 1 ? GREEN : LINE);
}

fs.writeFileSync(path.join(__dirname, 'icon.png'), encodePng(SIZE, SIZE, px));
console.log('[make-icon] icon.png 已生成（' + SIZE + 'x' + SIZE + '），接下来执行：npx tauri icon icon.png');
