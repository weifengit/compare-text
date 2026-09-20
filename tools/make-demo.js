'use strict';
/**
 * make-demo.js — 生成 demo/ 下的无头渲染夹具（docx 一对 + pdf 一对）与对应 task JSON。
 * 运行：node tools/make-demo.js
 * 产物：demo/a.docx demo/b.docx demo/a.pdf demo/b.pdf demo.json demo-pdf.json
 *   demo.json      → 单对 docx（阶段 B 完成标志用的"单对报告"）
 *   demo-pdf.json  → 单对 pdf（验证 PDF 快照路径）
 */
var fs = require('fs');
var path = require('path');
var JSZip = require(path.join(__dirname, '..', 'lib', 'jszip.min.js'));

var DEMO = path.join(__dirname, '..', 'demo');
fs.mkdirSync(DEMO, { recursive: true });

function escXml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function buildDocx(paras) {
  var body = '';
  for (var i = 0; i < paras.length; i++) {
    body += '<w:p><w:pPr><w:spacing w:before="60" w:after="200"/></w:pPr>'
      + '<w:r><w:t xml:space="preserve">' + escXml(paras[i]) + '</w:t></w:r></w:p>';
    if (i === 14 || i === 29 || i === 44) body += '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  }
  var doc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + body
    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
    + '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>'
    + '</w:body></w:document>';
  var zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>');
  zip.folder('_rels').file('.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>');
  zip.folder('word').file('document.xml', doc);
  return zip.generateAsync({ type: 'nodebuffer' });
}

function escPdf(s) { return String(s).replace(/[()\\]/g, ''); }
function buildPdf(pages, fontSize, leading) {
  var n = pages.length;
  var objs = ['%PDF-1.4\n'];
  objs.push('1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n');
  var kids = [];
  for (var i = 0; i < n; i++) kids.push((3 + i) + ' 0 R');
  objs.push('2 0 obj << /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + n + ' >> endobj\n');
  for (var p = 0; p < n; p++) {
    objs.push((3 + p) + ' 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 ' + (3 + n) + ' 0 R >> >> /Contents ' + (4 + n + p) + ' 0 R >> endobj\n');
  }
  objs.push((3 + n) + ' 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n');
  for (var c = 0; c < n; c++) {
    var st = 'BT /F1 ' + fontSize + ' Tf 72 740 Td ' + leading + ' TL ';
    pages[c].forEach(function (ln, k) { st += (k ? 'T* ' : '') + '(' + escPdf(ln) + ') Tj '; });
    st += 'ET\n';
    objs.push((4 + n + c) + ' 0 obj << /Length ' + st.length + ' >> stream\n' + st + 'endstream endobj\n');
  }
  objs.push('xref\n0 ' + (5 + n) + '\n0000000000 65535 f \n');
  for (var k2 = 0; k2 < 4 + n; k2++) objs.push('0000000009 00000 n \n');
  objs.push('trailer << /Size ' + (5 + n) + ' /Root 1 0 R >>\nstartxref\n9\n%%EOF\n');
  return Buffer.from(objs.join(''), 'latin1');
}
function chunk(arr, n) { var out = []; for (var i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

// ---- docx：左 60 段（4 页），右修改第 1 段、第 4 段后插 2 段、删 1 段（差异集中第 1 页） ----
var docxL = [], i;
for (i = 1; i <= 60; i++) docxL.push('第 ' + ('0' + i).slice(-2) + ' 条 共享内容 alpha beta gamma delta');
var docxR = docxL.slice(0, 3)
  .concat(['插入段落 A（右侧新增）', '插入段落 B（右侧新增）'])
  .concat(docxL.slice(3, 5))
  .concat(docxL.slice(6));
docxR[0] = '第 01 条 已被修改的内容 alpha beta gamma delta';

// ---- pdf：左 8 页（每页 20 行），右差异压在前两页 ----
var pdfL = [], pdfR = [];
for (i = 1; i <= 160; i++) pdfL.push('Line ' + ('000' + i).slice(-3) + ' shared content alpha beta gamma');
pdfR = pdfL.slice(0, 4)
  .concat(['Inserted extra line A', 'Inserted extra line B'])
  .concat(pdfL.slice(4, 30))
  .concat(pdfL.slice(33));
pdfR[0] = 'Line 001 MODIFIED content alpha beta gamma';

Promise.all([
  buildDocx(docxL).then(function (b) { fs.writeFileSync(path.join(DEMO, 'a.docx'), b); }),
  buildDocx(docxR).then(function (b) { fs.writeFileSync(path.join(DEMO, 'b.docx'), b); })
]).then(function () {
  fs.writeFileSync(path.join(DEMO, 'a.pdf'), buildPdf(chunk(pdfL, 20), 16, 22));
  fs.writeFileSync(path.join(DEMO, 'b.pdf'), buildPdf(chunk(pdfR, 20), 16, 22));

  function task(title, left, right, out) {
    return {
      title: title,
      pairs: [{ left: left, right: right }],
      options: { ignoreCase: true, ignoreEol: true, ignoreWhitespace: true, ignoreNewline: true, ignoreWidth: true, ignorePunct: true },
      output: out
    };
  }
  var d = path.join(__dirname, '..', 'demo');
  fs.writeFileSync(path.join(__dirname, '..', 'demo.json'), JSON.stringify(
    task('文档修订对比（docx）', path.join(d, 'a.docx'), path.join(d, 'b.docx'), path.join(d, 'report-docx.html')), null, 2));
  fs.writeFileSync(path.join(DEMO, 'demo-pdf.json'), JSON.stringify(
    task('文档修订对比（pdf）', path.join(d, 'a.pdf'), path.join(d, 'b.pdf'), path.join(d, 'report-pdf.html')), null, 2));
  console.log('demo 夹具已生成：demo/{a,b}.{docx,pdf}，任务：demo.json（docx）、demo/demo-pdf.json（pdf）');
}).catch(function (e) { console.error('生成失败：' + (e && e.message)); process.exit(1); });
