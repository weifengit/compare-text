/**
 * ocr.js — Node 测试：验证 PP-OCR (onnxruntime-web wasm) 识别管线。
 * 运行：node test/ocr.js
 *
 * 依赖：
 *   - lib/onnxruntime/（ort.wasm.min.js + ort-wasm-simd-threaded.wasm，已 vendor）
 *   - models/（ch_PP-OCRv4_det/rec_infer.onnx + cls + ppocr_keys_v1.txt，已 vendor）
 *   - test/fixtures/ch_en_num.rgba（323x430 32bpp ARGB 样例，已生成）
 *
 * 识别是真实推理（非桩），耗时数秒~十几秒，属预期。
 */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var Ocr = require('../src/ocr.js');

var passed = 0, failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL  ' + name + '\n      ' + e.message);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL  ' + name + '\n      ' + e.message);
  }
}

/** fs 资源加载器：Node 下不 fetch，直接读文件（测试注入） */
function fsLoader() {
  return {
    loadScript: function () { return Promise.reject(new Error('Node 测试不走 loadScript')); },
    getBytes: function (rel) { return Promise.resolve(fs.readFileSync(path.join(ROOT, rel)).buffer.slice(0)); },
    getText: function (rel) { return Promise.resolve(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
  };
}

// 样例图像元数据（与 fixtures/*.json 一致）
var FIX = { w: 323, h: 430 };

console.log('ocr tests\n');

check('0. 模块导出形状', function () {
  assert.strictEqual(typeof Ocr.createRuntime, 'function');
  assert.strictEqual(typeof Ocr.recognize, 'function');
  assert.strictEqual(typeof Ocr.linesToTextItems, 'function');
  assert.strictEqual(typeof Ocr.RUNTIME_FILES.det, 'string');
});

check('1. 工具函数：rgbaToRgb 白底去 alpha', function () {
  var rgba = new Uint8Array(2 * 2 * 4);
  // 画布 RGBA 布局：byte0=R, byte1=G, byte2=B, byte3=A
  // 像素0: 半透明蓝 R=0,G=0,B=255,A=128 → 混合白底 → B=255, R=G=127（0*0.5+255*0.5）
  rgba[0] = 0; rgba[1] = 0; rgba[2] = 255; rgba[3] = 128;
  // 像素1: 不透明蓝
  rgba[4] = 0; rgba[5] = 0; rgba[6] = 255; rgba[7] = 255;
  var rgb = Ocr._internal.rgbaToRgb(rgba, 2, 2, 8);
  assert.strictEqual(rgb.w, 2); assert.strictEqual(rgb.h, 2);
  // 像素0（半透明蓝混合白底）
  assert.strictEqual(rgb.data[0], 127, '像素0 R=127（蓝对白底混合）');
  assert.strictEqual(rgb.data[1], 127, '像素0 G=127');
  assert.strictEqual(rgb.data[2], 255, '像素0 B=255');
  // 像素1: 不透明蓝 → R=0, G=0, B=255
  assert.strictEqual(rgb.data[3], 0, '像素1 R=0');
  assert.strictEqual(rgb.data[4], 0, '像素1 G=0');
  assert.strictEqual(rgb.data[5], 255, '像素1 B=255');
});

check('2. 工具函数：warpQuad 恒等（矩形→矩形，最小尺寸钳制 8）', function () {
  var w = 10, h = 5;
  var data = new Uint8Array(w * h * 3);
  for (var i = 0; i < w * h; i++) { data[i * 3] = 200; data[i * 3 + 1] = 100; data[i * 3 + 2] = 50; }
  var out = Ocr._internal.warpQuad({ w: w, h: h, data: data },
    [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }]);
  assert.strictEqual(out.w, 10);
  assert.strictEqual(out.h, 8, '高度 5 被钳制到最小 8（rec 需要最小高度）');
  assert.strictEqual(out.data[0], 200);
});

check('3. 工具函数：ctcDecode 去重与去 blank', function () {
  var dict = ['', '你', '好', '世', '界'];
  var probs = [
    [0.1, 0.9, 0.0, 0.0, 0.0],   // 你
    [0.9, 0.0, 0.0, 0.0, 0.0],   // blank
    [0.1, 0.0, 0.9, 0.0, 0.0],   // 好
    [0.0, 0.0, 0.0, 0.9, 0.0],   // 世
    [0.0, 0.9, 0.0, 0.0, 0.0],   // 你（间隔后重现 → 保留）
    [0.1, 0.0, 0.0, 0.0, 0.9]    // 界
  ];
  var r = Ocr._internal.ctcDecode(probs, dict);
  assert.strictEqual(r.text, '你好世你界');
  assert.ok(r.conf > 0.8);
});

check('4. 阅读顺序排序（多行 y 分桶 + 行内 x）', function () {
  var items = [
    { box: [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 110 }, { x: 100, y: 110 }], text: 'A' },
    { box: [{ x: 10, y: 100 }, { x: 90, y: 100 }, { x: 90, y: 110 }, { x: 10, y: 110 }], text: 'B' },
    { box: [{ x: 10, y: 200 }, { x: 90, y: 200 }, { x: 90, y: 210 }, { x: 10, y: 210 }], text: 'C' }
  ];
  var sorted = Ocr.sortReadingOrder(items);
  assert.strictEqual(sorted[0].text, 'B');   // 第一行（y=100）内 x 小者先
  assert.strictEqual(sorted[1].text, 'A');
  assert.strictEqual(sorted[2].text, 'C');
});

// ---------- 真实推理（数秒~十几秒） ----------

var runtimeReady = false;
async function ensureRuntime() {
  if (runtimeReady) return;
  await Ocr.createRuntime({ assetLoader: fsLoader(), rootDir: ROOT, numThreads: 1 });
  runtimeReady = true;
}

async function fixtureImage() {
  var rgba = new Uint8Array(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'ch_en_num.rgba')));
  // 夹具由 System.Drawing 生成（BGRA 布局），ocr.js 按画布 RGBA 布局读取 → 交换 R/B
  for (var i = 0; i < rgba.length; i += 4) {
    var b = rgba[i];
    rgba[i] = rgba[i + 2];
    rgba[i + 2] = b;
  }
  return { data: rgba, width: FIX.w, height: FIX.h, stride: FIX.w * 4 };
}

async function run() {
  console.log('\n[真实推理] 加载 ort + 模型 + 字典（首次较慢）…');
  var t0 = Date.now();
  await ensureRuntime();
  console.log('  运行时就绪：' + (Date.now() - t0) + 'ms');

  await checkAsync('5. recognize 全管线：输出非空中文文本', async function () {
    var res = await Ocr.recognize(await fixtureImage());
    assert.ok(res.text && res.text.length > 10, '识别文本过短：' + JSON.stringify(res.text));
    assert.ok(Array.isArray(res.lines) && res.lines.length > 3, '应有多个文本行');
    // 样例图是一张中文商品图，应出现常见词
    var text = res.text.replace(/\s/g, '');
    assert.ok(text.indexOf('去污') >= 0, '应识别出"去污"（强力去污符合国标），实际：' + res.text.slice(0, 80));
    assert.ok(text.indexOf('国标') >= 0, '应识别出"国标"，实际：' + res.text.slice(0, 80));
    // 每行带 box（4 点）与 conf
    var line = res.lines[0];
    assert.ok(Array.isArray(line.box) && line.box.length === 4, 'box 应为 4 点');
    assert.ok(typeof line.conf === 'number' && line.conf > 0, 'conf 应为正数');
  });

  await checkAsync('6. linesToTextItems：生成 pdf.js 同构结构', async function () {
    var res = await Ocr.recognize(await fixtureImage());
    var items = Ocr.linesToTextItems(res.lines, 595, 842, 2);   // A4 @ scale 2
    assert.strictEqual(items.length, 1);
    var boxes = items[0].boxes;
    assert.ok(boxes.length > 0, '应生成 textItems');
    // 逐项校验字段（与 PdfView.collectItems 约定一致）
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      assert.strictEqual(typeof b.str, 'string');
      assert.ok(b.str.length > 0);
      assert.ok(Array.isArray(b.transform) && b.transform.length === 6);
      assert.strictEqual(typeof b.width, 'number');
      assert.strictEqual(typeof b.line, 'number');
      assert.strictEqual(typeof b.col, 'number');
      assert.ok(b.hasEOL, '行末应有 hasEOL');
    }
    // 行号连续 1..N
    for (var j = 0; j < boxes.length; j++) assert.strictEqual(boxes[j].line, j + 1);
    // 坐标应在页面范围内（页面单位 595x842）
    for (var k = 0; k < boxes.length; k++) {
      assert.ok(boxes[k].transform[4] >= 0 && boxes[k].transform[4] < 595, 'x 越界');
      assert.ok(boxes[k].transform[5] > 0 && boxes[k].transform[5] < 842, 'y 越界');
    }
  });

  await checkAsync('7. recognize 结果稳定（同图两次识别行数一致）', async function () {
    var img = await fixtureImage();
    var r1 = await Ocr.recognize(img);
    var r2 = await Ocr.recognize(img);
    assert.strictEqual(r1.lines.length, r2.lines.length, '两次识别行数应一致');
  });

  console.log('\nocr tests: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch(function (e) {
  console.error('ocr tests FAIL: ' + ((e && e.stack) || e));
  process.exit(1);
});
