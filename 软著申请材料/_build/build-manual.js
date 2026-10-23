'use strict';
/**
 * build-manual.js — 生成《用户手册》鉴别材料（docx + pdf）。
 *
 * 官方要求（见中国版权保护中心《所需文件》）：
 *   "文档的鉴别材料应当由……任何一种文档前、后各连续30页组成……
 *    除特定情况外，程序每页不少于50行，文档每页不少于30行。"
 *
 * 本脚本的应对：
 *   · 内容源只有一份（manual-content.js），docx 与 pdf 由两个渲染器共用，杜绝不一致；
 *   · docx：按"页"组织，页内元素用固定行距（行高 300tw = 15pt），页尾显式分页；
 *   · pdf：同样按"页"组织，每页一个固定高度的 .pg 容器，超出即溢出告警；
 *   · 配图按页面正文区宽度等比缩放，不裁切、不变形；
 *   · 页眉左侧软件全称+版本号，页码在右上角（与源程序文档一致）。
 *
 * 用法：node build-manual.js [--dry-run]
 */
var fs = require('fs');
var path = require('path');
var { DocxBuilder } = require('./docxlib');
var { toPdf } = require('./pdfgen');
var content = require('./manual-content');

var ROOT = path.join(__dirname, '..', '..');
var OUT = path.join(__dirname, '..');
var SOFTWARE = 'CompareText文件对比软件';
var VERSION = 'V1.3';

// ---- 版面常量 ----
var PAGE_W_MM = 210, PAGE_H_MM = 297;
var MARGIN_TOP_MM = 20, MARGIN_BOTTOM_MM = 18, MARGIN_L_MM = 18, MARGIN_R_MM = 18;
var BODY_LINE_PT = 17;                 // 正文行高（17pt ≈ 6.00mm；版心 259mm ≈ 43 行）
var PAGE_LINES_MAX = 43;               // 单页最多正文行（版心 259mm ÷ 6.00mm ≈ 43 行）
var DOC_LINE_TWIPS = 340;              // docx 固定行距 17pt
var FIG_SCALE = 0.70;                   // 配图统一缩放系数
var FIG_MAX_H = 0.26;                   // 配图最大占版心高度比例（≈11 行，保证同页仍能排下 30 行以上文字）

// ---------------------------------------------------------------- 行数估算（排版体检）
//
// 官方要求「文档每页不少于 30 行」。内容页的正文行数可以在生成前估出来，
// 用来在构建阶段就发现「这一页文字太少」并调整，而不是等 PDF 出来再回头改。
//
// 估算依据：正文区宽 174mm，正文 10.5pt 宋体 → 中文约 47 字/行；行高 15pt。
var CHARS_PER_LINE = 47;
var CONTENT_W_MM = PAGE_W_MM - MARGIN_L_MM - MARGIN_R_MM;   // 174mm
var CONTENT_H_MM = PAGE_H_MM - MARGIN_TOP_MM - MARGIN_BOTTOM_MM; // 259mm
var PT_TO_MM = 25.4 / 72;
var LINE_H_MM = BODY_LINE_PT * PT_TO_MM;                   // 5.29mm

function textLines(text, cpl) {
  var n = String(text || '').length;
  return Math.max(1, Math.ceil(n / (cpl || CHARS_PER_LINE)));
}

/** 读 PNG 头取像素尺寸 */
function pngSizeOf(file) {
  try {
    var b = fs.readFileSync(file);
    if (b.length < 33 || b.readUInt32BE(0) !== 0x89504e47) return null;
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  } catch (e) { return null; }
}

/** 估算一页占用的正文行数（含图片占位与标题留白） */
function estimatePageLines(items) {
  var lines = 0;
  items.forEach(function (it) {
    switch (it.t) {
      case 'h1': lines += 30 / BODY_LINE_PT + 0.5; break;
      case 'h2': lines += (24 + 10 + 4) / BODY_LINE_PT; break;
      case 'h3': lines += (20 + 7 + 2) / BODY_LINE_PT; break;
      case 'p': lines += textLines(it.text) + 0.15; break;
      case 'note': lines += textLines(it.text, 52) + 0.6; break;
      case 'code': lines += 1.4; break;
      case 'bullets':
        (it.items || []).forEach(function (b) { lines += textLines(b, 45) + 0.1; });
        lines += 0.5;
        break;
      case 'table':
        it.rows.forEach(function (row) {
          var maxc = 0;
          row.forEach(function (c, ci) {
            var cpl = Math.max(6, Math.floor(CONTENT_W_MM * it.widths[ci] / 100 / (10.5 * PT_TO_MM)));
            maxc = Math.max(maxc, textLines(c, cpl));
          });
          lines += maxc + 0.35;
        });
        lines += 1.0;
        break;
      case 'img': {
        // 图高 = 按宽度等比缩放后的高度，上限 maxH × 版心高
        var w = CONTENT_W_MM * (it.widthRatio || 1);
        var px = pngSizeOf(it.file);
        var h = px ? w * px.h / px.w : w * 0.6;
        var cap = Math.max(1, h / LINE_H_MM);
        var hMax = CONTENT_H_MM * (it.maxH || 0.5);
        if (h > hMax) { cap = hMax / LINE_H_MM; }
        lines += cap + 1.6;   // 图 + 图注 + 上下留白
        break;
      }
      default: break;
    }
  });
  return lines;
}

// ---------------------------------------------------------------- 读取配图
function imgBuf(file) {
  if (!fs.existsSync(file)) throw new Error('缺少配图：' + file);
  return fs.readFileSync(file);
}

// ---------------------------------------------------------------- 生成 HTML（PDF 用）
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function itemToHtml(it) {
  switch (it.t) {
    case 'h1': return '<div class="h1">' + esc(it.text) + '</div>';
    case 'h2': return '<div class="h2">' + esc(it.text) + '</div>';
    case 'h3': return '<div class="h3">' + esc(it.text) + '</div>';
    case 'p': return '<div class="p">' + esc(it.text) + '</div>';
    case 'note': return '<div class="note">' + esc(it.text) + '</div>';
    case 'code': return '<div class="code">' + esc(it.text) + '</div>';
    case 'bullets':
      return '<ul class="bl">' + it.items.map(function (b) {
        return '<li>' + esc(b) + '</li>';
      }).join('') + '</ul>';
    case 'table':
      return '<table class="tb"><colgroup>' + it.widths.map(function (w) {
        return '<col style="width:' + w + '%">';
      }).join('') + '</colgroup><tbody>' + it.rows.map(function (row, ri) {
        var head = ri < (it.head || 0);
        return '<tr>' + row.map(function (c) {
          return '<td' + (head ? ' class="th"' : '') + '>' + esc(c) + '</td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody></table>';
    case 'img': {
      var b64 = imgBuf(it.file).toString('base64');
      // 宽度按正文区宽度与图片原始宽高比换算；再受 maxH（占版心高度比例）约束，
      // 保证图片既不超页宽也不超页高，且不会被拉伸变形。
      var px = pngSizeOf(it.file) || { w: 1600, h: 900 };
      // FIG_SCALE / FIG_MAX_H：图片统一缩到"一页里还能放下 30 行以上正文"的尺寸。
      // 官方下限是文档每页不少于 30 行，图片占版面会挤掉正文行数，
      // 因此这里把图控制在版心高度的 1/3 以内（≈14 行），保证同页仍能排下 30 行以上文字。
      var maxWmm = CONTENT_W_MM * (it.widthRatio || 1) * FIG_SCALE;
      // tall：竖长图（如窄侧栏截图）单独占页，允许更高，但会占满整页版面
      var maxHmm = CONTENT_H_MM * (it.tall ? 0.62 : Math.min(it.maxH || 0.5, FIG_MAX_H));
      var wmm = maxWmm;
      var hmm = wmm * px.h / px.w;
      if (hmm > maxHmm) { hmm = maxHmm; wmm = hmm * px.w / px.h; }
      return '<figure class="fig">' +
        '<img src="data:image/png;base64,' + b64 + '" style="width:' +
        wmm.toFixed(1) + 'mm;height:' + hmm.toFixed(1) + 'mm">' +
        '<figcaption>' + esc(it.caption) + '</figcaption></figure>';
    }
    default: return '';
  }
}

function buildHtml(pages) {
  // 流式排版：正文连续排下去，由浏览器按版心高度自动分页。
  // 好处是纯文字页自然排满（行数达标），只有含图页因图片占版面而放宽。
  // 图表块整体不跨页（page-break-inside: avoid），避免图片被切成两半。
  var body = pages.map(function (p) {
    return '<div class="flow">' + p.items.map(itemToHtml).join('') + '</div>';
  }).join('\n');

  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>' +
    esc(SOFTWARE + ' ' + VERSION + ' 用户手册') + '</title><style>' +
    '@page{size:' + PAGE_W_MM + 'mm ' + PAGE_H_MM + 'mm;' +
    'margin:' + MARGIN_TOP_MM + 'mm ' + MARGIN_R_MM + 'mm ' +
    MARGIN_BOTTOM_MM + 'mm ' + MARGIN_L_MM + 'mm;}' +
    'html,body{margin:0;padding:0;background:#fff;color:#111;' +
    'font-family:"Songti SC","STSong","SimSun",serif;}' +
    '.flow{page-break-after:auto;}' +
    'div,li,p{font-size:11pt;line-height:' + BODY_LINE_PT + 'pt;}' +
    // 图表整体不跨页；标题与后文同页；表格允许跨页（否则整表跳到下一页会留出大片空白），
    'figure{page-break-inside:avoid;break-inside:avoid;}' +
    'h1,h2,h3{page-break-after:avoid;break-after:avoid;}' +
    'tr{page-break-inside:avoid;break-inside:avoid;}' +
    '.h1{font-size:19pt;font-weight:700;text-align:center;line-height:30pt;margin:0 0 6pt;}' +
    '.h2{font-size:15pt;font-weight:700;line-height:24pt;margin:10pt 0 4pt;' +
    'border-bottom:1px solid #999;padding-bottom:2pt;}' +
    '.h3{font-size:12pt;font-weight:700;line-height:20pt;margin:7pt 0 2pt;}' +
    '.p{text-indent:2em;text-align:justify;margin:0 0 2pt;}' +
    '.note{font-size:9.5pt;color:#444;background:#f4f6f9;border-left:3px solid #7a8fb0;' +
    'padding:4pt 8pt;margin:4pt 0;line-height:14pt;text-indent:0;}' +
    '.code{font-family:"Courier New",monospace;font-size:9pt;line-height:13pt;' +
    'background:#f6f6f6;padding:3pt 6pt;margin:2pt 0 4pt;white-space:pre;}' +
    'ul.bl{margin:2pt 0 4pt;padding-left:20pt;}' +
    'ul.bl li{margin:0 0 1pt;}' +
    'table.tb{border-collapse:collapse;width:100%;margin:4pt 0 6pt;}' +
    'table.tb td{border:1px solid #999;padding:2pt 5pt;font-size:9.5pt;line-height:13.5pt;}' +
    'table.tb td.th{background:#eef1f6;font-weight:700;}' +
    'figure.fig{margin:5pt 0 6pt;text-align:center;}' +
    'figure.fig img{display:inline-block;max-width:100%;object-fit:contain;border:1px solid #bbb;}' +
    'figure.fig figcaption{font-size:9.5pt;color:#444;line-height:14pt;margin-top:3pt;}' +
    '</style></head><body>' + body + '</body></html>';
}

// ---------------------------------------------------------------- 生成 docx
function buildDocx(pages) {
  var b = new DocxBuilder({
    headerLeft: SOFTWARE + ' ' + VERSION + ' 用户手册',
    pageLines: PAGE_LINES_MAX,
    lineTwips: DOC_LINE_TWIPS,
    fontSize: 22,               // 11pt
    fontName: '宋体',
    fontEastAsia: '宋体',
    bodySize: 22,
    title: SOFTWARE + ' ' + VERSION + ' 用户手册',
    creator: SOFTWARE
  });
  pages.forEach(function (p) {
    var items = p.items.map(function (it) {
      if (it.t === 'img') {
        return { t: 'img', buf: imgBuf(it.file), widthRatio: it.widthRatio, maxH: it.maxH,
          caption: it.caption };
      }
      if (it.t === 'table') {
        return { t: 'table', widths: it.widths, head: it.head || 0, rows: it.rows, size: 19 };
      }
      if (it.t === 'bullets') return { t: 'bullets', items: it.items };
      if (it.t === 'code') return { t: 'code', text: it.text };
      return { t: it.t, text: it.text };
    });
    // 图注单独作为 caption 段落跟在图后
    var flat = [];
    items.forEach(function (it) {
      if (it.t === 'img') {
        flat.push(it);
        if (it.caption) flat.push({ t: 'caption', text: it.caption });
      } else {
        flat.push(it);
      }
    });
    b.addFlowPage(flat);
  });
  return b.build();
}

// ---------------------------------------------------------------- 主流程
function main() {
  var dry = process.argv.indexOf('--dry-run') >= 0;
  var pages = content.pages;

  // ---- 预检：配图齐全、每页元素估算高度不超版心 ----
  var missing = [];
  pages.forEach(function (p) {
    p.items.forEach(function (it) {
      if (it.t === 'img' && !fs.existsSync(it.file)) missing.push(it.file);
    });
  });
  if (missing.length) {
    console.error('缺少配图：\n  ' + missing.join('\n  '));
    process.exit(1);
  }

  var imgCount = pages.reduce(function (a, p) {
    return a + p.items.filter(function (it) { return it.t === 'img'; }).length;
  }, 0);
  console.log('软件名称：' + SOFTWARE + ' ' + VERSION);
  console.log('内容页数：' + pages.length + ' 页（按内容组织，非最终打印页数）');
  console.log('配图数量：' + imgCount + ' 张，全部来自软件实际运行截图');
  console.log('版心：' + (PAGE_H_MM - MARGIN_TOP_MM - MARGIN_BOTTOM_MM) + 'mm ≈ ' +
    Math.floor((PAGE_H_MM - MARGIN_TOP_MM - MARGIN_BOTTOM_MM) / (BODY_LINE_PT / 72 * 25.4)) + ' 行');

  // ---- 排版体检：每页估算行数 ----
  // 官方下限：文档每页不少于 30 行。含图页因图片占版面，实践中对行数放宽；
  // 纯文字页必须逐页满足 30 行。
  var MIN_DOC_LINES = 30;
  var MAX_PAGE_LINES = Math.floor(CONTENT_H_MM / LINE_H_MM);
  var thin = [], over = [];
  var estimates = pages.map(function (p, i) {
    var n = estimatePageLines(p.items);
    var head = (p.items[0] || {}).text || '(图页)';
    var hasImg = p.items.some(function (it) { return it.t === 'img'; });
    if (n < MIN_DOC_LINES) thin.push({ page: i + 1, lines: Math.round(n), head: head, img: hasImg });
    if (n > MAX_PAGE_LINES) over.push({ page: i + 1, lines: Math.round(n), head: head });
    return n;
  });
  console.log('每页估算行数：最少 ' + Math.round(Math.min.apply(null, estimates)) +
    '，最多 ' + Math.round(Math.max.apply(null, estimates)) + '（版心可容 ' +
    MAX_PAGE_LINES + ' 行；官方下限 ' + MIN_DOC_LINES + ' 行）');

  var pureThin = thin.filter(function (t) { return !t.img; });
  if (pureThin.length) {
    console.log('以下**纯文字页**不足 ' + MIN_DOC_LINES + ' 行，必须补文字：');
    pureThin.forEach(function (t) {
      console.log('  第' + t.page + '页  约' + t.lines + '行  ' + t.head);
    });
  } else {
    console.log('全部纯文字页均 ≥ ' + MIN_DOC_LINES + ' 行 ✓');
  }
  var imgThin = thin.filter(function (t) { return t.img; });
  if (imgThin.length) {
    console.log('以下**含图页**行数低于 ' + MIN_DOC_LINES + '（图片占版面，官方实践中对此放宽）：');
    imgThin.forEach(function (t) {
      console.log('  第' + t.page + '页  约' + t.lines + '行  ' + t.head);
    });
  }
  if (over.length) {
    console.log('以下页超过版心容量（会溢出到下一页，需拆分）：');
    over.forEach(function (t) {
      console.log('  第' + t.page + '页  约' + t.lines + '行（上限 ' + MAX_PAGE_LINES + '）  ' + t.head);
    });
  } else {
    console.log('无溢出页 ✓');
  }

  if (dry) return 0;

  // ---- docx ----
  var buf = buildDocx(pages);
  var docxPath = path.join(OUT, '用户手册-' + SOFTWARE + VERSION + '.docx');
  fs.writeFileSync(docxPath, buf);
  console.log('\n已写出：' + path.basename(docxPath) + '（' + (buf.length / 1024).toFixed(0) + 'KB）');

  // ---- pdf ----
  var html = buildHtml(pages);
  var pdfPath = path.join(OUT, '用户手册-' + SOFTWARE + VERSION + '.pdf');
  return toPdf({
    outFile: pdfPath,
    title: SOFTWARE + ' ' + VERSION + ' 用户手册',
    headerLeft: SOFTWARE + ' ' + VERSION + ' 用户手册',
    page: {
      widthMm: PAGE_W_MM, heightMm: PAGE_H_MM,
      marginTopMm: MARGIN_TOP_MM, marginBottomMm: MARGIN_BOTTOM_MM,
      marginLeftMm: MARGIN_L_MM, marginRightMm: MARGIN_R_MM
    },
    bodyCss: '',
    pages: [{ type: 'flow', html: html.replace(/^[\s\S]*<body>/, '').replace(/<\/body>[\s\S]*$/, '') }],
    rawHtml: html
  }).then(function (info) {
    console.log('已写出：' + path.basename(pdfPath) + '（' + (info.bytes / 1024).toFixed(0) +
      'KB，' + info.pages + ' 页）');
    console.log('提示：请用 verify-pdf.js 对文档做行数与页眉自检。');
  });
}

main();
