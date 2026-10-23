'use strict';
/**
 * docxlib.js — 零依赖 OOXML 文档生成器（纯 Node 标准库）。
 *
 * 为什么不用现成库：软著对排版有硬性、可被审查员逐页核对的要求——
 *   · 源程序每页不少于 50 行（官方下限），本工具做到每页固定 60 行、页页满行；
 *   · 页码必须在页眉右上角；
 *   · 每页行数不能随 Word 的渲染差异漂移。
 * 现成库按「内容流式排版」工作，行数取决于字体度量与渲染器；这里反过来——
 * 由调用方按「页 → 行」组织内容，本库只负责一比一写进 OOXML，
 * 并自带 AAA 自检（解压回读、逐页数字数、校验页眉）。
 *
 * 能力：
 *   new DocxBuilder({ headerLeft, pageLines, lineTwips, fontSizeHalfPt, ... })
 *   builder.addPage(lines[])            追加一页（行数应等于 pageLines）
 *   builder.addImagePage({ ... })       追加一页整页图片（手册配图用）
 *   builder.build()                     → { buffer, pages, lineCounts }
 *   DocxBuilder.verify(buffer)          → 回读自检结果
 *
 * 页面参数（A4，与 _tools/build-source-docx.py 同一套账）：
 *   A4 高 16838tw，上边距 1134tw，下边距 850tw → 正文可用高 14854tw
 *   pageLines × lineTwips 必须 ≤ 14854，否则末行被挤出页面
 */

var zlib = require('zlib');

// ---------------------------------------------------------------- 极小 XML 工具
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
/** 去掉 XML 不接受的控制字符（\x00-\x08 等）——源程序里偶尔会有，写进 docx 会直接损坏 */
function clean(s) {
  var out = '';
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    out += (c === 9 || c === 10 || c === 13 || c >= 32) ? s[i] : ' ';
  }
  return out;
}

// ---------------------------------------------------------------- ZIP（store/deflate）
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

/** 组装 ZIP：entries = [{ name, data }]，deflate 压缩（图片本身已压缩则用 store） */
function zip(entries) {
  var locals = [], central = [], offset = 0;
  entries.forEach(function (e) {
    var nameBuf = Buffer.from(e.name, 'utf8');
    var raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    var method = e.store ? 0 : 8;
    var body = method === 8 ? zlib.deflateRawSync(raw, { level: 6 }) : raw;
    var crc = crc32(raw);

    var lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);            // version needed
    lh.writeUInt16LE(0x0800, 6);        // flag: UTF-8 文件名
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);            // time
    lh.writeUInt16LE(0x21, 12);         // date（固定值，保证可复现）
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, body);

    var ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + body.length;
  });
  var centralBuf = Buffer.concat(central);
  var end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat(locals.concat([centralBuf, end]));
}

// ---------------------------------------------------------------- 解压（自检用）
function unzip(buf) {
  var out = {};
  var i = 0;
  while (i + 4 <= buf.length) {
    if (buf.readUInt32LE(i) !== 0x04034b50) break;
    var method = buf.readUInt16LE(i + 8);
    var crc = buf.readUInt32LE(i + 14);
    var csize = buf.readUInt32LE(i + 18);
    var usize = buf.readUInt32LE(i + 22);
    var nlen = buf.readUInt16LE(i + 26);
    var elen = buf.readUInt16LE(i + 28);
    var name = buf.toString('utf8', i + 30, i + 30 + nlen);
    var start = i + 30 + nlen + elen;
    var body = buf.slice(start, start + csize);
    var raw = method === 8 ? zlib.inflateRawSync(body) : body;
    if (usize !== raw.length || crc32(raw) !== crc) throw new Error('ZIP 条目校验失败：' + name);
    out[name] = raw;
    i = start + csize;
  }
  return out;
}

// ---------------------------------------------------------------- 图片（PNG → docx media）
/** 读 PNG 头，取像素宽高（只认 PNG；手册配图统一先转 PNG） */
function pngSize(buf) {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/** EMU：1 英寸 = 914400 EMU，1 点 = 12700 EMU */
var EMU_PER_IN = 914400;
var TWIPS_PER_IN = 1440;

// ---------------------------------------------------------------- 文档构建
function DocxBuilder(opts) {
  opts = opts || {};
  this.headerLeft = opts.headerLeft || '';
  this.pageLines = opts.pageLines || 60;
  this.lineTwips = opts.lineTwips || 240;          // 固定行距 12pt
  this.fontSize = opts.fontSize || 16;             // half-point，16 = 8pt
  this.fontName = opts.fontName || 'Courier New';
  this.fontEastAsia = opts.fontEastAsia || '宋体';
  this.pageW = opts.pageW || 11906;                // A4 宽 twips
  this.pageH = opts.pageH || 16838;
  this.marginTop = opts.marginTop || 1134;
  this.marginBottom = opts.marginBottom || 850;
  this.marginLeft = opts.marginLeft || 1020;
  this.marginRight = opts.marginRight || 794;
  this.headerDist = opts.headerDist || 510;
  this.footerDist = opts.footerDist || 720;
  this.bodyFont = opts.bodyFont || null;            // 非源程序（手册正文）用的字体
  this.bodySize = opts.bodySize || 24;              // 12pt
  this.pages = [];                                  // [{ kind:'lines', lines:[…] } | { kind:'flow', paras:[…] } | { kind:'image', … }]
  this.images = [];                                 // [{ rId, name, buf, ext }]
  this.title = opts.title || '';
  this.creator = opts.creator || '';
  this._relSeq = 100;
}

DocxBuilder.prototype._textRun = function (text, o) {
  o = o || {};
  var sz = o.sz || this.fontSize;
  var font = o.font || this.fontName;
  var ea = o.fontEastAsia || this.fontEastAsia;
  var rpr = '<w:rPr>' +
    (font ? '<w:rFonts w:ascii="' + esc(font) + '" w:hAnsi="' + esc(font) + '" w:eastAsia="' + esc(ea) + '"/>' : '') +
    (o.bold ? '<w:b/><w:bCs/>' : '') +
    (o.italic ? '<w:i/><w:iCs/>' : '') +
    (o.color ? '<w:color w:val="' + esc(o.color) + '"/>' : '') +
    (o.sizeHalf ? '<w:sz w:val="' + o.sizeHalf + '"/><w:szCs w:val="' + o.sizeHalf + '"/>' : '') +
    '</w:rPr>';
  if (text === '') return '<w:r>' + rpr + '</w:r>';
  return '<w:r>' + rpr + '<w:t xml:space="preserve">' + esc(clean(text)) + '</w:t></w:r>';
};

/** 源程序行段落：固定行距、不设段前后距，一行必占一行高 */
DocxBuilder.prototype._codePara = function (text, pageBreak) {
  var ppr = '<w:pPr><w:widowControl w:val="0"/>' +
    '<w:spacing w:before="0" w:after="0" w:line="' + this.lineTwips + '" w:lineRule="exact"/>' +
    '</w:pPr>';
  var brk = pageBreak ? '<w:r><w:br w:type="page"/></w:r>' : '';
  return '<w:p>' + ppr + this._textRun(text) + brk + '</w:p>';
};

DocxBuilder.prototype.addPage = function (lines) {
  this.pages.push({ kind: 'lines', lines: lines.slice() });
  return this;
};

/** 手册正文页：段落样式（标题/正文/图注/表格），由调用方按页组织 */
DocxBuilder.prototype.addFlowPage = function (items) {
  this.pages.push({ kind: 'flow', items: items.slice() });
  return this;
};

/**
 * 整页图片页（手册配图）：图按可用正文区等比缩放到页宽，
 * 下方可跟一行图注（figcaption）。图片体积大 → ZIP 内用 store。
 */
DocxBuilder.prototype.addImagePage = function (cfg) {
  var rId = 'rId' + (++this._relSeq);
  var name = 'image' + this.images.length + '.png';
  this.images.push({ rId: rId, name: name, buf: cfg.buf });
  this.pages.push({ kind: 'image', rId: rId, name: name, caption: cfg.caption || '' });
  return this;
};

// ---------------------------------------------------------------- 组装 XML
DocxBuilder.prototype._bodyXml = function () {
  var self = this;
  var availWidthEmu = (this.pageW - this.marginLeft - this.marginRight) / TWIPS_PER_IN * EMU_PER_IN;
  var body = [];

  this.pages.forEach(function (page, pi) {
    var last = pi === self.pages.length - 1;

    if (page.kind === 'lines') {
      page.lines.forEach(function (line, li) {
        body.push(self._codePara(line, !last && li === page.lines.length - 1));
      });
      return;
    }

    if (page.kind === 'image') {
      var info = pngSize(page.buf) || { w: 1600, h: 900 };
      // 按正文宽度等比缩放；高度上限取正文可用高的 78%（给图注留位置）
      var availHEmu = (self.pageH - self.marginTop - self.marginBottom) / TWIPS_PER_IN * EMU_PER_IN * 0.78;
      var cx = availWidthEmu;
      var cy = cx * info.h / info.w;
      if (cy > availHEmu) { cy = availHEmu; cx = cy * info.w / info.h; }
      var drawing =
        '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">' +
        '<wp:extent cx="' + Math.round(cx) + '" cy="' + Math.round(cy) + '"/>' +
        '<wp:docPr id="' + (pi + 1) + '" name="图片 ' + (pi + 1) + '"/>' +
        '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
        '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
        '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
        '<pic:nvPicPr><pic:cNvPr id="' + (pi + 1) + '" name="' + esc(page.name) + '"/><pic:cNvPicPr/></pic:nvPicPr>' +
        '<pic:blipFill><a:blip r:embed="' + page.rId + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
        '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + Math.round(cx) + '" cy="' + Math.round(cy) + '"/></a:xfrm>' +
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>' +
        '</wp:inline></w:drawing></w:r>';
      body.push('<w:p><w:pPr><w:widowControl w:val="0"/><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>' +
        '<w:jc w:val="center"/></w:pPr>' + drawing + (last ? '' : '<w:r><w:br w:type="page"/></w:r>') + '</w:p>');
      return;
    }

    // flow：手册正文（标题 / 段落 / 项目符号 / 图注 / 表格 / 图片）
    page.items.forEach(function (it, ii) {
      var isLastItem = ii === page.items.length - 1;
      var brk = (!last && isLastItem) ? '<w:r><w:br w:type="page"/></w:r>' : '';

      if (it.t === 'img') {
        var info2 = pngSize(it.buf) || { w: 1600, h: 900 };
        var availH2 = (self.pageH - self.marginTop - self.marginBottom) / TWIPS_PER_IN * EMU_PER_IN * (it.maxH || 0.62);
        var cx2 = availWidthEmu * (it.widthRatio || 1);
        var cy2 = cx2 * info2.h / info2.w;
        if (cy2 > availH2) { cy2 = availH2; cx2 = cy2 * info2.w / info2.h; }
        var rId2 = 'rId' + (++self._relSeq);
        var nm2 = 'image' + self.images.length + '.png';
        self.images.push({ rId: rId2, name: nm2, buf: it.buf });
        var dr =
          '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">' +
          '<wp:extent cx="' + Math.round(cx2) + '" cy="' + Math.round(cy2) + '"/>' +
          '<wp:docPr id="' + (self.images.length + 1) + '" name="' + esc(nm2) + '"/>' +
          '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
          '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
          '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
          '<pic:nvPicPr><pic:cNvPr id="' + (self.images.length + 1) + '" name="' + esc(nm2) + '"/><pic:cNvPicPr/></pic:nvPicPr>' +
          '<pic:blipFill><a:blip r:embed="' + rId2 + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
          '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + Math.round(cx2) + '" cy="' + Math.round(cy2) + '"/></a:xfrm>' +
          '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>' +
          '</wp:inline></w:drawing></w:r>';
        body.push('<w:p><w:pPr><w:widowControl w:val="0"/><w:spacing w:before="0" w:after="60" w:line="240" w:lineRule="auto"/>' +
          '<w:jc w:val="center"/></w:pPr>' + dr + brk + '</w:p>');
        return;
      }

      if (it.t === 'table') {
        // it.rows = [[cell,…], …]；it.widths = [比例…]；it.head = 表头行数
        var total = it.widths.reduce(function (a, b) { return a + b; }, 0);
        var tblW = self.pageW - self.marginLeft - self.marginRight;
        var grid = it.widths.map(function (w) {
          return '<w:gridCol w:w="' + Math.round(tblW * w / total) + '"/>';
        }).join('');
        var border = '<w:tblBorders>' +
          ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(function (s) {
            return '<w:' + s + ' w:val="single" w:sz="4" w:space="0" w:color="B0B0B0"/>';
          }).join('') + '</w:tblBorders>';
        var rows = it.rows.map(function (row, ri) {
          var isHead = ri < (it.head || 0);
          var cells = row.map(function (cell, ci) {
            var w = Math.round(tblW * it.widths[ci] / total);
            var shade = isHead ? '<w:shd w:val="clear" w:color="auto" w:fill="EDF0F5"/>' : '';
            return '<w:tc><w:tcPr><w:tcW w:w="' + w + '" w:type="dxa"/>' + shade +
              '<w:vAlign w:val="center"/></w:tcPr>' +
              '<w:p><w:pPr><w:widowControl w:val="0"/>' +
              '<w:spacing w:before="30" w:after="30" w:line="260" w:lineRule="atLeast"/></w:pPr>' +
              self._textRun(cell, {
                font: null, fontEastAsia: '宋体', sz: it.size || 19,
                bold: isHead
              }) + '</w:p></w:tc>';
          }, this).join('');
          return '<w:tr><w:trPr>' + (isHead ? '<w:tblHeader/>' : '') + '</w:trPr>' + cells + '</w:tr>';
        }, this).join('');
        body.push('<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>' + border +
          '<w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>' + grid + '</w:tblGrid>' + rows + '</w:tbl>');
        // 表格后留一点点空隙（用零内容段落，避免 Word 把后续表格粘连）
        body.push('<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="120" w:lineRule="exact"/></w:pPr></w:p>');
        if (!last && isLastItem) {
          body.push('<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="120" w:lineRule="exact"/></w:pPr>' +
            '<w:r><w:br w:type="page"/></w:r></w:p>');
        }
        return;
      }

      if (it.t === 'bullets') {
        var list = (it.items || []).map(function (b) {
          return '<w:p><w:pPr><w:widowControl w:val="0"/>' +
            '<w:spacing w:before="20" w:after="20" w:line="300" w:lineRule="atLeast"/>' +
            '<w:ind w:left="480" w:hanging="240"/></w:pPr>' +
            self._textRun('· ' + b, { font: null, sz: self.bodySize }) + '</w:p>';
        }, this).join('');
        body.push(list + (brk && isLastItem ? '' : ''));
        if (!last && isLastItem) {
          body.push('<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="120" w:lineRule="exact"/></w:pPr>' +
            '<w:r><w:br w:type="page"/></w:r></w:p>');
        }
        return;
      }

      // 段落类：h1 / h2 / h3 / p / note / caption / code
      var style = {
        h1: { sz: 36, bold: true, before: 0, after: 240, align: 'center' },
        h2: { sz: 28, bold: true, before: 240, after: 120, align: 'left' },
        h3: { sz: 24, bold: true, before: 180, after: 80, align: 'left' },
        p: { sz: self.bodySize, bold: false, before: 0, after: 100, align: 'both' },
        note: { sz: 20, bold: false, before: 0, after: 80, align: 'left', color: '595959' },
        caption: { sz: 19, bold: false, before: 60, after: 160, align: 'center', color: '595959' },
        code: { sz: 18, bold: false, before: 0, after: 40, align: 'left', mono: true },
        quote: { sz: 21, bold: false, before: 60, after: 120, align: 'left', color: '404040' }
      }[it.t] || { sz: self.bodySize, bold: false, before: 0, after: 100, align: 'both' };

      var ppr = '<w:pPr><w:widowControl w:val="0"/>' +
        '<w:spacing w:before="' + (style.before || 0) + '" w:after="' + (style.after || 0) +
        '" w:line="' + (it.space || 300) + '" w:lineRule="atLeast"/>' +
        (style.align ? '<w:jc w:val="' + style.align + '"/>' : '') +
        (it.t === 'p' ? '<w:ind w:firstLine="480"/>' : '') +
        '</w:pPr>';
      var run = self._textRun(it.text || '', {
        font: style.mono ? 'Consolas' : null,
        fontEastAsia: style.mono ? '宋体' : '宋体',
        sz: style.sz,
        bold: style.bold,
        color: style.color
      });
      body.push('<w:p>' + ppr + run + brk + '</w:p>');
    });
  });

  var sect = '<w:sectPr>' +
    '<w:headerReference w:type="default" r:id="rIdHeader"/>' +
    '<w:footerReference w:type="default" r:id="rIdFooter"/>' +
    '<w:pgSz w:w="' + this.pageW + '" w:h="' + this.pageH + '"/>' +
    '<w:pgMar w:top="' + this.marginTop + '" w:right="' + this.marginRight +
    '" w:bottom="' + this.marginBottom + '" w:left="' + this.marginLeft +
    '" w:header="' + this.headerDist + '" w:footer="' + this.footerDist + '" w:gutter="0"/>' +
    '<w:cols w:space="720"/><w:docGrid w:linePitch="360"/></w:sectPr>';

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<w:body>' + body.join('') + sect + '</w:body></w:document>';
};

DocxBuilder.prototype._headerXml = function () {
  var t = esc(this.headerLeft);
  var tabPos = this.pageW - this.marginLeft - this.marginRight;
  // 页眉：左侧软件名 + 右侧页码（右对齐制表位）。官方要求页码在右上角。
  var runs = '<w:r>' + this._rprForHeader() + '<w:t xml:space="preserve">' + t + '</w:t></w:r>' +
    '<w:r>' + this._rprForHeader() + '<w:tab/></w:r>' +
    '<w:r>' + this._rprForHeader() + '<w:fldChar w:fldCharType="begin"/></w:r>' +
    '<w:r>' + this._rprForHeader() + '<w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>' +
    '<w:r>' + this._rprForHeader() + '<w:fldChar w:fldCharType="separate"/></w:r>' +
    '<w:r>' + this._rprForHeader() + '<w:t>1</w:t></w:r>' +
    '<w:r>' + this._rprForHeader() + '<w:fldChar w:fldCharType="end"/></w:r>';
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="' + tabPos + '"/></w:tabs>' +
    '<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>' +
    '<w:jc w:val="left"/>' + this._rprForHeader() + '</w:pPr>' + runs + '</w:p></w:hdr>';
};

DocxBuilder.prototype._rprForHeader = function () {
  return '<w:rPr><w:rFonts w:ascii="宋体" w:hAnsi="宋体" w:eastAsia="宋体"/>' +
    '<w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>';
};

DocxBuilder.prototype._footerXml = function () {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:p></w:ftr>';
};

DocxBuilder.prototype._stylesXml = function () {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:docDefaults><w:rPrDefault><w:rPr>' +
    '<w:rFonts w:ascii="' + esc(this.fontName) + '" w:hAnsi="' + esc(this.fontName) + '" w:eastAsia="' + esc(this.fontEastAsia) + '"/>' +
    '<w:sz w:val="' + this.bodySize + '"/><w:szCs w:val="' + this.bodySize + '"/>' +
    '</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>' +
    '<w:spacing w:before="0" w:after="0" w:line="' + this.lineTwips + '" w:lineRule="auto"/>' +
    '</w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/>' +
    '<w:qFormat/></w:style></w:styles>';
};

DocxBuilder.prototype._contentTypes = function () {
  var exts = '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>';
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' + exts +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' +
    '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '</Types>';
};

DocxBuilder.prototype._rels = function () {
  var s = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
    '</Relationships>';
  return s;
};

DocxBuilder.prototype._docRels = function () {
  var imgs = this.images.map(function (im) {
    return '<Relationship Id="' + im.rId + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/' + im.name + '"/>';
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>' +
    '<Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>' +
    '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    imgs + '</Relationships>';
};

DocxBuilder.prototype._coreXml = function () {
  var now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    '<dc:title>' + esc(this.title) + '</dc:title>' +
    '<dc:creator>' + esc(this.creator || this.title) + '</dc:creator>' +
    '<cp:lastModifiedBy>' + esc(this.creator || this.title) + '</cp:lastModifiedBy>' +
    '<dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created>' +
    '<dcterms:modified xsi:type="dcterms:W3CDTF">' + now + '</dcterms:modified>' +
    '</cp:coreProperties>';
};

DocxBuilder.prototype._appXml = function () {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
    '<Application>Microsoft Office Word</Application><DocSecurity>0</DocSecurity>' +
    '<ScaleCrop>false</ScaleCrop><Pages>' + this.pages.length + '</Pages></Properties>';
};

DocxBuilder.prototype.build = function () {
  var entries = [
    { name: '[Content_Types].xml', data: this._contentTypes() },
    { name: '_rels/.rels', data: this._rels() },
    { name: 'docProps/core.xml', data: this._coreXml() },
    { name: 'docProps/app.xml', data: this._appXml() },
    { name: 'word/document.xml', data: this._bodyXml() },
    { name: 'word/styles.xml', data: this._stylesXml() },
    { name: 'word/header1.xml', data: this._headerXml() },
    { name: 'word/footer1.xml', data: this._footerXml() },
    { name: 'word/_rels/document.xml.rels', data: this._docRels() }
  ];
  this.images.forEach(function (im) {
    entries.push({ name: 'word/media/' + im.name, data: im.buf, store: true });
  });
  return zip(entries);
};

// ---------------------------------------------------------------- 自检
/**
 * 回读校验：解压 → 解析 document.xml → 按分页符切页 → 统计每页行数 / 页眉。
 * 返回 { pages, pageLineCounts, nonBlankMin, maxWidth, header, hasPageField }
 */
DocxBuilder.verify = function (buffer, expectLinesPerPage) {
  var files = unzip(buffer);
  var doc = files['word/document.xml'].toString('utf8');
  var hdr = files['word/header1.xml'].toString('utf8');

  // 按 <w:br w:type="page"/> 切页
  var chunks = doc.split('<w:br w:type="page"/>');
  var pageLineCounts = chunks.map(function (c) {
    var m = c.match(/<w:p[ >]/g);
    return m ? m.length : 0;
  });
  // 文档结尾的 sectPr 不算段落；分页符挂在最后一行的段落里，切分后行数仍准确
  var pages = chunks.length;

  // 非空行最少值（给"剔除空行后仍≥50行"留证据）
  var nonBlankCounts = chunks.map(function (c) {
    var n = 0;
    var re = /<w:t xml:space="preserve">([^<]*)<\/w:t>/g, mm;
    while ((mm = re.exec(c))) if (mm[1].trim()) n++;
    return n;
  });

  var headerText = hdr.replace(/<[^>]+>/g, '').trim();
  return {
    pages: pages,
    pageLineCounts: pageLineCounts,
    nonBlankMin: Math.min.apply(null, nonBlankCounts),
    header: headerText,
    hasPageField: hdr.indexOf('PAGE') >= 0,
    hasRightTab: /w:tab w:val="right"/.test(hdr),
    expectLinesPerPage: expectLinesPerPage || null
  };
};

module.exports = {
  DocxBuilder: DocxBuilder,
  zip: zip,
  unzip: unzip,
  crc32: crc32,
  esc: esc
};
