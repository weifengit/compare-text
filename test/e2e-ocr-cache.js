'use strict';
/**
 * e2e-ocr-cache.js — 端到端验证「扫描版 PDF OCR 结果缓存」：
 *   首次对比（冷缓存）真实 OCR 并把结果写入磁盘缓存；
 *   再次对比（热缓存）直接复用缓存（跳过 OCR Worker 加载与逐页识别），
 *   且两次报告中被缓存侧的文本内容完全一致。
 * 运行：node test/e2e-ocr-cache.js   （需要本机装有 Edge/Chrome；自动起 serve.js）
 * 缓存目录通过 DSH_OCR_CACHE 隔离到临时目录，不污染真实缓存。
 */
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');

var ROOT = path.join(__dirname, '..');
var TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-cache-e2e-'));
var CACHE_DIR = path.join(TMP, 'ocr-cache');
var SAMPLE_JPG = path.join(ROOT, 'test', 'fixtures', 'ch_en_num.jpg');

// ---------- 夹具：扫描版 PDF（单页 JPEG、无文字层）与文字版 PDF ----------
function buildScannedPdf(jpegBytes, w, h, pageW, pageH) {
  var objs = [];
  objs.push('%PDF-1.4\n');
  objs.push('1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n');
  objs.push('2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n');
  objs.push('3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pageW + ' ' + pageH
    + '] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >> endobj\n');
  objs.push('4 0 obj << /Type /XObject /Subtype /Image /Width ' + w + ' /Height ' + h
    + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpegBytes.length + ' >> stream\n');
  objs.push(jpegBytes.toString('latin1'));
  objs.push('\nendstream endobj\n');
  var content = 'q ' + pageW + ' 0 0 ' + pageH + ' 0 0 cm /Im1 Do Q\n';
  objs.push('5 0 obj << /Length ' + content.length + ' >> stream\n' + content + 'endstream endobj\n');
  var n = 6;
  objs.push('xref\n0 ' + n + '\n0000000000 65535 f \n');
  for (var k = 0; k < n - 1; k++) objs.push('0000000009 00000 n \n');
  objs.push('trailer << /Size ' + n + ' /Root 1 0 R >>\nstartxref\n9\n%%EOF\n');
  return Buffer.from(objs.join(''), 'latin1');
}
function buildTextPdf(text) {
  var esc = function (s) { return s.replace(/[()\\]/g, ''); };
  var lines = text.split('\n');
  var objs = ['%PDF-1.4\n'];
  objs.push('1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n');
  objs.push('2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n');
  objs.push('3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj\n');
  objs.push('4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n');
  var st = 'BT /F1 16 Tf 72 740 Td 22 TL ';
  lines.forEach(function (ln, i) { st += (i ? 'T* ' : '') + '(' + esc(ln) + ') Tj '; });
  st += 'ET\n';
  objs.push('5 0 obj << /Length ' + st.length + ' >> stream\n' + st + 'endstream endobj\n');
  var n = 6;
  objs.push('xref\n0 ' + n + '\n0000000000 65535 f \n');
  for (var k = 0; k < n - 1; k++) objs.push('0000000009 00000 n \n');
  objs.push('trailer << /Size ' + n + ' /Root 1 0 R >>\nstartxref\n9\n%%EOF\n');
  return Buffer.from(objs.join(''), 'latin1');
}

// ---------- 跑一份报告（dsh-report.js 无头通道），返回 { json, seconds, output } ----------
function runReport(taskPath) {
  return new Promise(function (resolve) {
    var t0 = Date.now();
    var child = cp.spawn(process.execPath, [path.join(ROOT, 'tools', 'dsh-report.js'), '--task', taskPath],
      { stdio: ['ignore', 'pipe', 'inherit'], env: Object.assign({}, process.env, { DSH_OCR_CACHE: CACHE_DIR }) });
    var out = '';
    child.stdout.on('data', function (d) { out += d; });
    child.on('close', function () {
      var line = out.trim().split('\n').pop(), json = null;
      try { json = JSON.parse(line); } catch (e) { /* 无 JSON */ }
      resolve({ json: json, seconds: (Date.now() - t0) / 1000 });
    });
  });
}

function cacheFiles() {
  try { return fs.readdirSync(CACHE_DIR); } catch (e) { return []; }
}

var passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (extra ? '\n      ' + extra : '')); }
}

(async function main() {
  var jpeg = fs.readFileSync(SAMPLE_JPG);
  var scanned = path.join(TMP, 'scan.pdf');
  fs.writeFileSync(scanned, buildScannedPdf(jpeg, 323, 430, 612, 792));  // 只生成一次：两次运行共享同一 size/mtime → 命中
  var textPdf = path.join(TMP, 'text.pdf');
  fs.writeFileSync(textPdf, buildTextPdf('This is a normal text PDF\nSecond line content\nThird line shared'));

  function makeTask(output) {
    var task = {
      title: 'ocr-cache-e2e', output: output,
      pairs: [{ left: scanned, right: textPdf }]
    };
    var p = path.join(TMP, 'task-' + path.basename(output) + '.json');
    fs.writeFileSync(p, JSON.stringify(task));
    return p;
  }

  // ---------- 第一遍：冷缓存，应真实 OCR 并写缓存 ----------
  var r1 = await runReport(makeTask('report-1.html'));
  check('第一遍（冷缓存）报告成功', !!(r1.json && r1.json.ok), JSON.stringify(r1.json));
  var files1 = cacheFiles();
  check('第一遍后写入 1 个缓存文件', files1.length === 1, '实际 ' + files1.length + '：' + files1.join(','));

  // ---------- 第二遍：热缓存，应命中（复用识别结果，跳过 OCR） ----------
  var r2 = await runReport(makeTask('report-2.html'));
  check('第二遍（热缓存）报告成功', !!(r2.json && r2.json.ok), JSON.stringify(r2.json));
  var files2 = cacheFiles();
  check('第二遍后缓存仍为 1 个文件（命中复用，未新增）', files2.length === 1, '实际 ' + files2.length);
  console.log('  信息：冷缓存 ' + r1.seconds.toFixed(1) + 's / 热缓存 ' + r2.seconds.toFixed(1) + 's'
    + '（总耗时含报告快照；OCR 提速在真实多页扫描件上更显著，见 SKILL.md 实测）');

  // ---------- 内容一致性：两遍报告中被缓存侧（扫描 PDF 侧）文本一致 ----------
  function extractSide(fn) {
    var html = fs.readFileSync(fn, 'utf8');
    var m = html.match(/data-side="L"([\s\S]*?)data-side="R"/);
    if (!m) return '';
    return m[1].replace(/<[^>]+>/g, '');
  }
  var t1 = extractSide(r1.json.reports[0].output), t2 = extractSide(r2.json.reports[0].output);
  check('两次报告扫描侧文本一致（OCR 结果 = 缓存结果）', t1 === t2 && t1.length > 20,
    'len1=' + t1.length + ' len2=' + t2.length);

  // ---------- 清理 ----------
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
})().catch(function (e) {
  console.log('FAIL  ' + (e && e.message));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e2) {}
  process.exitCode = 1;
});
