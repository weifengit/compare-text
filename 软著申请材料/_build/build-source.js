'use strict';
/**
 * build-source.js — 生成软著《源程序》鉴别材料（docx + pdf）。
 *
 * 官方要求（见中国版权保护中心《所需文件》）：
 *   "源程序的连续的前30页和连续的后30页……除特定情况外，程序每页不少于50行。"
 * 本脚本的应对：
 *   · 每页固定 60 行（比 50 行下限多 20% 余量），页页满行，末页也不留空；
 *   · 超宽行按"显示宽度"硬折行（中文按 2 列），保证打印时 Word 不会再软换行
 *     —— 这是"每页行数"可预测的前提；
 *   · 页眉左侧「软件全称 版本号 源程序」，页码在右上角（官方 FAQ 明确要求右上角）；
 *   · 自检：解压回读逐页数字数，并核验页眉与页码字段。
 *
 * 用法：
 *   node 软著申请材料/_build/build-source.js
 *   node 软著申请材料/_build/build-source.js --dry-run
 */

var fs = require('fs');
var path = require('path');
var { DocxBuilder } = require('./docxlib');
var { toPdf } = require('./pdfgen');

var ROOT = path.join(__dirname, '..', '..');
var OUT = path.join(__dirname, '..');
var SOFTWARE = 'CompareText文件对比软件';
var VERSION = 'V1.3';

// ---- 排版常量（页面高度账）----
var PAGE_LINES = 64;         // 每页行数（官方下限 50，留 28% 余量）
// 固定行距 11.5pt：64 × 230 = 14720tw ≤ 14854tw 可用高（再满就溢出到下一页，页数会漂）
var LINE_TWIPS = 230;
var MAXW = 98;               // 每行最大显示宽度（正文区约容 105 列，留 7 列抗字体替换）
var FONT_SZ = 16;            // 8pt（half-points）
var HEADER_SZ = 18;          // 页眉 9pt





// ---- 收集"本人编写"的源文件（剔除第三方与产物）----
var INCLUDE_DIRS = ['src', 'src-tauri/src', 'plugins/dsh-compare-text', 'scripts'];
var INCLUDE_FILES = ['serve.js', 'index.html', 'styles.css', 'tools/render.js', 'tools/dsh-report.js'];
var EXCLUDE_PARTS = ['node_modules', 'dist', 'vendor', 'target', '.git'];
var EXCLUDE_SUFFIX = ['.min.js'];

function collect() {
  var files = [];
  INCLUDE_DIRS.forEach(function (d) {
    var base = path.join(ROOT, d);
    if (!fs.existsSync(base)) return;
    (function walk(dir) {
      fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
        var p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (EXCLUDE_PARTS.indexOf(e.name) >= 0) return;
          walk(p);
          return;
        }
        var ext = path.extname(e.name);
        if (['.js', '.mjs', '.rs', '.html', '.css', '.yml', '.json', '.sh', '.ps1'].indexOf(ext) < 0) return;
        if (EXCLUDE_SUFFIX.indexOf(e.name) >= 0) return;
        if (/package-lock/.test(e.name)) return;
        files.push(path.relative(ROOT, p));
      });
    })(base);
  });
  INCLUDE_FILES.forEach(function (f) {
    if (fs.existsSync(path.join(ROOT, f))) files.push(f);
  });
  return files.sort(function (a, b) { return a.split(path.sep).join('/') < b.split(path.sep).join('/') ? -1 : 1; });
}

function readLines(rel) {
  var raw = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  var out = raw.split('\n').map(function (line) {
    return line.replace(/\t/g, '  ').replace(/\s+$/, '');
  });
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

// ---- 显示宽度与折行 ----
function dw(s) {
  var w = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    w += (c >= 0x1100 && (c <= 0x115f || c === 0x2329 || c === 0x232a ||
      (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) ||
      (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6))) ? 2 : 1;
  }
  return w;
}
function wrap(line, maxw) {
  if (maxw == null) maxw = MAXW;   // 缺省宽度必须显式给：undefined 会让比较恒为 false，折叠永不推进

  if (dw(line) <= maxw) return [line];
  var out = [], rest = line;
  while (rest.length) {
    if (dw(rest) <= maxw) { out.push(rest); break; }
    var w = 0, cut = 0;
    for (var i = 0; i < rest.length; i++) {
      var cw = dw(rest[i]);
      if (w + cw > maxw) break;
      w += cw; cut = i + 1;
    }
    var window = rest.slice(0, cut);
    var brk = window.lastIndexOf(' ');
    if (brk < maxw * 0.5) {
      ['，', '。', '、', '；', '：', ')', '）', ', ', ' && ', ' || '].some(function (sep) {
        var j = window.lastIndexOf(sep);
        if (j >= maxw * 0.5) { brk = j + sep.length - 1; return true; }
        return false;
      });
    }
    if (brk >= maxw * 0.5) {
      out.push(rest.slice(0, brk).replace(/\s+$/, ''));
      rest = '    ' + rest.slice(brk + 1).replace(/^\s+/, '');
    } else {
      out.push(window);
      rest = '    ' + rest.slice(cut);
    }
  }
  return out;
}

function buildListing(files) {
  var full = [], stats = [];
  files.forEach(function (rel, idx) {
    var banner = /\.(html|css|json|yml)$/i.test(rel) ? '#' : '//';
    if (idx) full.push('');
    full.push(banner + ' ========== 文件：' + rel.split(path.sep).join('/') + ' ==========');
    var n0 = full.length;
    var lines = readLines(rel);
    // 源码里连续多个空行会拉低"非空行"密度。空行在审查时同样成行（官方无扣行规定），
    // 但为稳妥起见，把连续 2 个以上的空行压成 1 个 —— 一行代码都不丢，只去掉多余留白。
    var blank = 0;
    lines.forEach(function (l) {
      if (!l.trim()) {
        blank++;
        if (blank > 1) return;
        full.push('');
        return;
      }
      blank = 0;
      full = full.concat(wrap(l));
    });
    stats.push({ rel: rel, raw: lines.length, printed: full.length - n0 });
  });
  return { full: full, stats: stats };
}

// ---- 主流程 ----
function main() {
  var dry = process.argv.indexOf('--dry-run') >= 0;
  var files = collect();
  var built = buildListing(files);
  var full = built.full;

  var totalPages = Math.max(1, Math.ceil(full.length / PAGE_LINES));
  var rawTotal = built.stats.reduce(function (a, s) { return a + s.raw; }, 0);

  console.log('软件名称：' + SOFTWARE + ' ' + VERSION);
  console.log('源文件数：' + files.length + '（已剔除第三方 lib/ 与 node_modules/dist）');
  console.log('原始行数合计：' + rawTotal + ' 行');
  console.log('打印行数（含文件横幅与折行）：' + full.length + ' 行');
  console.log('全本：' + totalPages + ' 页（每页 ' + PAGE_LINES + ' 行）');
  console.log('页面高度账：' + PAGE_LINES + ' × ' + LINE_TWIPS + 'tw = ' + (PAGE_LINES * LINE_TWIPS) +
    'tw ≤ 可用 14854tw');

  // 交存：前 30 页 + 后 30 页
  var submitPages, mode;
  if (totalPages > 60) {
    var end = full.length - (full.length % PAGE_LINES);   // 末尾对齐整页边界
    var trimmed = full.length - end;
    submitPages = full.slice(0, 30 * PAGE_LINES).concat(full.slice(end - 30 * PAGE_LINES, end));
    mode = '前30页 + 后30页（共60页）';
    if (trimmed) console.log('末尾对齐：丢弃尾部不足一页的 ' + trimmed + ' 行，保证 60 页页页满行');
  } else {
    submitPages = full;
    mode = '不足60页，全本提交';
  }
  var pages = [];
  for (var i = 0; i < submitPages.length; i += PAGE_LINES) {
    pages.push(submitPages.slice(i, i + PAGE_LINES));
  }
  console.log('交存方式：' + mode + '，实际 ' + pages.length + ' 页');
  if (dry) return 0;

  // ---- docx ----
  var b = new DocxBuilder({
    headerLeft: SOFTWARE + ' ' + VERSION + ' 源程序',
    pageLines: PAGE_LINES,
    lineTwips: LINE_TWIPS,
    fontSize: FONT_SZ,
    title: SOFTWARE + ' ' + VERSION + ' 源程序',
    creator: SOFTWARE
  });
  pages.forEach(function (p) { b.addPage(p); });
  var buf = b.build();
  var docxPath = path.join(OUT, '源程序-' + SOFTWARE + VERSION + '.docx');
  fs.writeFileSync(docxPath, buf);

  var info = DocxBuilder.verify(buf, PAGE_LINES);
  console.log('\n已写出：' + path.basename(docxPath) + '（' + (buf.length / 1024).toFixed(0) + 'KB）');
  console.log('自检：页数=' + info.pages + '，每页行数=' + info.pageLineCounts.join(',') +
    '，非空行最少=' + info.nonBlankMin);
  console.log('      页眉="' + info.header + '"，页码域=' + info.hasPageField + '，右制表位=' + info.hasRightTab);
  assert(info.pages === pages.length, '页数不符');
  assert(info.pageLineCounts.every(function (c) { return c === PAGE_LINES; }), '每页行数不齐');
  assert(info.nonBlankMin >= 50, '存在非空行不足 50 的页面');
  assert(info.hasPageField && info.hasRightTab, '页眉页码不合规');
  assert(info.header.indexOf(SOFTWARE + ' ' + VERSION) === 0, '页眉软件名不符');

  // ---- pdf ----
  var pdfPath = path.join(OUT, '源程序-' + SOFTWARE + VERSION + '.pdf');
  return toPdf({
    outFile: pdfPath,
    title: SOFTWARE + ' ' + VERSION + ' 源程序',
    headerLeft: SOFTWARE + ' ' + VERSION + ' 源程序',
    page: { widthMm: 210, heightMm: 297, marginTopMm: 20, marginBottomMm: 18, marginLeftMm: 18, marginRightMm: 18 },
    // 源程序：等宽 8pt，固定行距 —— 与 docx 的排版账完全一致
    // 源程序：等宽 8pt，固定行距 —— 与 docx 的排版账完全一致。
    // 行高 11.4pt × 64 行 = 729.6pt ≤ 正文可用高（297 − 20 − 18 = 259mm = 734pt），
    // 再高一行就会溢出到下一页，导致每页行数漂移、页数翻倍。
    bodyCss: 'body{font-family:"Courier New",monospace;font-size:8pt;line-height:11.4pt;margin:0;padding:0;}' +
      '.pg{page-break-after:always;}' +
      '.pg:last-child{page-break-after:auto;}' +
      '.ln{height:11.4pt;overflow:hidden;white-space:pre;}',
    pages: pages.map(function (p) { return { type: 'code', lines: p }; })
  }).then(function (pdfInfo) {
    console.log('已写出：' + path.basename(pdfPath) + '（' + (pdfInfo.bytes / 1024).toFixed(0) + 'KB，' +
      pdfInfo.pages + ' 页）');
    console.log('全部自检通过 ✓');
  });
}

function assert(cond, msg) {
  if (!cond) { console.error('自检失败：' + msg); process.exit(1); }
}

main();
