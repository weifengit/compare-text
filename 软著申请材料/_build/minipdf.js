'use strict';
/**
 * minipdf.js — 把一张 JPEG 包成单页 A4 PDF（纯 Node，零依赖）。
 *
 * 为什么需要它：软著手册要演示「扫描版 PDF（无文字层）→ 内置 OCR」这条链路，
 * 就必须造一份**真的没有文字层**的 PDF。把渲染好的页面截成 JPEG、再当作整页图片装进
 * PDF（/DCTDecode），pdf.js 的 getTextContent 会拿到空结果 —— 正是扫描件的判定条件。
 *
 * 用法：
 *   var minipdf = require('./minipdf');
 *   fs.writeFileSync('scan.pdf', minipdf.fromJpeg(jpegBuffer, w, h));
 */

var A4_W = 595.28, A4_H = 841.89;   // A4 点尺寸（1pt = 1/72in）

/** 把 JPEG 嵌入 A4 页面，等比缩放到页宽并居中（上下各留 2% 白边） */
function fromJpeg(jpeg, imgW, imgH, opts) {
  opts = opts || {};
  var pageW = opts.pageW || A4_W;
  var pageH = opts.pageH || A4_H;
  var margin = opts.margin == null ? 12 : opts.margin;   // 四周白边（点）

  var availW = pageW - margin * 2, availH = pageH - margin * 2;
  var k = Math.min(availW / imgW, availH / imgH);
  var drawW = imgW * k, drawH = imgH * k;
  var x = (pageW - drawW) / 2, y = (pageH - drawH) / 2;

  var content = 'q\n' + drawW.toFixed(2) + ' 0 0 ' + drawH.toFixed(2) + ' ' +
    x.toFixed(2) + ' ' + y.toFixed(2) + ' cm\n/Im0 Do\nQ\n';
  var contentBuf = Buffer.from(content, 'latin1');

  var objs = [];
  objs[1] = Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1');
  objs[2] = Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'latin1');
  objs[3] = Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' +
    pageW.toFixed(2) + ' ' + pageH.toFixed(2) + '] ' +
    '/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>', 'latin1');
  objs[4] = Buffer.concat([
    Buffer.from('<< /Length ' + contentBuf.length + ' >>\nstream\n', 'latin1'),
    contentBuf,
    Buffer.from('endstream', 'latin1')
  ]);
  objs[5] = Buffer.concat([
    Buffer.from('<< /Type /XObject /Subtype /Image /Width ' + imgW + ' /Height ' + imgH +
      ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpeg.length + ' >>\nstream\n', 'latin1'),
    jpeg,
    Buffer.from('\nendstream', 'latin1')
  ]);

  var chunks = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  var offset = chunks[0].length;
  var offsets = [0];
  for (var i = 1; i < objs.length; i++) {
    var head = Buffer.from(i + ' 0 obj\n', 'latin1');
    var tail = Buffer.from('\nendobj\n', 'latin1');
    offsets[i] = offset;
    chunks.push(head, objs[i], tail);
    offset += head.length + objs[i].length + tail.length;
  }

  var xrefStart = offset;
  var xref = 'xref\n0 ' + objs.length + '\n0000000000 65535 f \n';
  for (var j = 1; j < objs.length; j++) {
    xref += String(offsets[j]).padStart(10, '0') + ' 00000 n \n';
  }
  chunks.push(Buffer.from(xref, 'latin1'));
  chunks.push(Buffer.from('trailer\n<< /Size ' + objs.length + ' /Root 1 0 R >>\nstartxref\n' +
    xrefStart + '\n%%EOF\n', 'latin1'));
  return Buffer.concat(chunks);
}

module.exports = { fromJpeg: fromJpeg, A4_W: A4_W, A4_H: A4_H };
