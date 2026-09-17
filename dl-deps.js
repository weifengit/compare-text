// One-off dependency downloader for vendoring jsdiff/CodeMirror into lib/.
// Uses Node's built-in https (no curl dependency). Safe to delete after use.
const https = require('https');
const fs = require('fs');
const path = require('path');

const FILES = [
  ['https://cdn.jsdelivr.net/npm/diff@5.2.0/dist/diff.min.js', 'diff.min.js'],
  ['https://cdn.jsdelivr.net/npm/codemirror@5.65.16/lib/codemirror.min.js', 'codemirror.min.js'],
  ['https://cdn.jsdelivr.net/npm/codemirror@5.65.16/lib/codemirror.css', 'codemirror.css'],
  // pdf.js legacy 构建（UMD 全局 window.pdfjsLib，兼容旧浏览器与无构建场景）
  ['https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.min.js', 'pdf.min.js'],
  ['https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.worker.min.js', 'pdf.worker.min.js'],
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      const maxAge = res.headers['cache-control'];
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(url + ' -> HTTP ' + res.statusCode + ' (cache-control: ' + maxAge + ')'));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        fs.writeFileSync(dest, Buffer.concat(chunks));
        resolve(fs.statSync(dest).size);
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(new Error('timeout ' + url)); });
  });
}

(async () => {
  const dir = path.join(__dirname, 'lib');
  for (const [url, name] of FILES) {
    const dest = path.join(dir, name);
    try {
      const size = await download(url, dest);
      console.log('OK', name, size + ' bytes');
    } catch (e) {
      console.error('FAIL', name, e.message);
      process.exitCode = 1;
    }
  }
})();