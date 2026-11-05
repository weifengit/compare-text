/**
 * 程序化体检一张纵向拼接的长截图：接缝重复 / 缝隙 / 右侧裁边。
 *
 * 为什么不用 PIL/numpy：本机没装。PNG 解码 + 行剖面全用 Node 内置 zlib，
 * 不引入任何运行时依赖（与项目“零新增依赖”约束一致）。
 *
 * 用法：node tools/analyze-seams.js <长图.png> [--control 参照图.png]
 * 输出：尺寸、逐行墨迹剖面、疑似接缝（整段行完全重复=重复；突变空白带=缝隙）、
 *      右侧列墨迹分布（与参照图比，判断内容是否被面板可视宽裁掉）。
 */
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');

/** PNG → { width, height, data } 其中 data 为 RGBA 展开 */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('只支持 8bit');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('不支持的颜色类型 ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * channels);
  const prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = raw.slice(p, p + stride);
    p += stride;
    const cur = out.slice(y * stride, y * stride + stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v;
      if (filter === 0) v = line[x];
      else if (filter === 1) v = line[x] + a;
      else if (filter === 2) v = line[x] + b;
      else if (filter === 3) v = line[x] + ((a + b) >> 1);
      else {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
        v = line[x] + pr;
      }
      cur[x] = v & 0xff;
    }
    prev.set(cur);
  }
  return { width, height, channels, data: out };
}

/** 每行的“墨迹率”：非白像素占比（阈值 200 让浅灰也算了，用于抓接缝空白带） */
function rowInk(img) {
  const { width, height, channels, data } = img;
  const rows = new Float64Array(height);
  for (let y = 0; y < height; y++) {
    let ink = 0;
    const base = y * width * channels;
    for (let x = 0; x < width; x++) {
      const o = base + x * channels;
      const lum = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
      if (lum < 200) ink++;
    }
    rows[y] = ink / width;
  }
  return rows;
}

/** 每列的墨迹率：判断右侧内容是否被裁（被裁则最右若干列墨迹会异常密集/截断） */
function colInk(img) {
  const { width, height, channels, data } = img;
  const cols = new Float64Array(width);
  for (let x = 0; x < width; x++) {
    let ink = 0;
    for (let y = 0; y < height; y++) {
      const o = y * width * channels + x * channels;
      const lum = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
      if (lum < 200) ink++;
    }
    cols[x] = ink / height;
  }
  return cols;
}

/**
 * 找纵向接缝：拼接是把“上一段的尾部”与“下一段的开头”叠在一起裁的，
 * 裁错了会出现连续多行像素完全相同（内容重复）或一段全白（缝隙）。
 *
 * 重复判定必须用**整行像素哈希**而不是墨迹率：正文行距均匀时，相邻空白行的
 * 墨迹率全部相等（都是 0），拿率序列比会在正常页面上报出一百多个假阳性（实测踩过）。
 * 真重复的门槛：连续 ≥16 行像素相同 且 该块含墨（纯空白行重复 = 正常行距）。
 */
function findSeams(rows, hashes, minBlank = 6) {
  const seams = [];
  // 空白带：连续 ≥minBlank 行几乎无墨
  let run = 0, start = 0;
  for (let y = 0; y < rows.length; y++) {
    if (rows[y] < 0.002) {
      if (run === 0) start = y;
      run++;
    } else {
      if (run >= minBlank && start > 0 && y < rows.length) seams.push({ kind: 'blank', y0: start, y1: y, len: run });
      run = 0;
    }
  }
  // 内容重复块：连续 ≥16 行像素哈希完全一致，且块内有墨
  const WIN = 16;
  for (let y = 0; y + 2 * WIN < rows.length; y++) {
    let same = true;
    for (let k = 0; k < WIN; k++) if (hashes[y + k] !== hashes[y + WIN + k]) { same = false; break; }
    if (!same) continue;
    let inkSum = 0;
    for (let k = 0; k < WIN; k++) inkSum += rows[y + k];
    if (inkSum > 0.02) seams.push({ kind: 'dup', y0: y, y1: y + WIN, len: WIN, ink: +inkSum.toFixed(3) });
    y += WIN;
  }
  return seams;
}

/** 每行的像素哈希（接缝重复判定的依据） */
function rowHashes(img) {
  const { width, height, channels, data } = img;
  const stride = width * channels;
  const out = new Array(height);
  for (let y = 0; y < height; y++) {
    out[y] = crypto.createHash('md5').update(data.slice(y * stride, (y + 1) * stride)).digest('hex');
  }
  return out;
}

/** 墨迹剖面分段摘要（每 N 行一档，便于看整体分布） */
function profileBands(rows, band = 200) {
  const out = [];
  for (let y = 0; y < rows.length; y += band) {
    let sum = 0, n = 0;
    for (let k = y; k < Math.min(rows.length, y + band); k++) { sum += rows[k]; n++; }
    out.push({ y, ink: +(sum / n).toFixed(4) });
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const target = args[0];
  const ci = args.indexOf('--control');
  const control = ci >= 0 ? args[ci + 1] : null;
  if (!target) { console.error('用法: node tools/analyze-seams.js <长图.png> [--control 参照.png]'); process.exit(2); }

  const img = decodePng(fs.readFileSync(target));
  const rows = rowInk(img);
  const seams = findSeams(rows, rowHashes(img));
  const report = {
    file: target,
    width: img.width,
    height: img.height,
    totalInk: +(rows.reduce((a, b) => a + b, 0) / rows.length).toFixed(4),
    bands: profileBands(rows),
    seams,
    rightEdge: {}
  };

  // 右侧裁边判断：最右 3% 列若与中段同量级，说明内容顶到边缘被截；
  // 正常版心两侧留白，边缘列墨迹应远低于中段
  const cols = colInk(img);
  const edgeN = Math.max(1, Math.floor(img.width * 0.03));
  const mid = cols.slice(Math.floor(img.width * 0.4), Math.floor(img.width * 0.6));
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  report.rightEdge = {
    lastColsInk: +avg(Array.from(cols.slice(img.width - edgeN))).toFixed(4),
    midColsInk: +avg(mid).toFixed(4),
    likelyCropped: avg(Array.from(cols.slice(img.width - edgeN))) > avg(mid) * 0.5
  };

  if (control) {
    const c = decodePng(fs.readFileSync(control));
    const cc = colInk(c);
    const ce = Math.max(1, Math.floor(c.width * 0.03));
    const cm = cc.slice(Math.floor(c.width * 0.4), Math.floor(c.width * 0.6));
    const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
    report.control = {
      file: control, width: c.width, height: c.height,
      lastColsInk: +avg(Array.from(cc.slice(c.width - ce))).toFixed(4),
      midColsInk: +avg(cm).toFixed(4)
    };
  }

  console.log(JSON.stringify(report, null, 1));
}

main();
