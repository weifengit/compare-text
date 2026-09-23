#!/usr/bin/env node
/**
 * bump-version.js — 统一版本号脚本（自动发布工作流与手动发布共用）。
 *
 * 同步更新 5 个文件中的版本号，保证处处一致：
 *   - package.json
 *   - package-lock.json（顶层 version + packages[""].version）
 *   - src-tauri/tauri.conf.json
 *   - src-tauri/Cargo.toml（[package] 段的 version）
 *   - src-tauri/Cargo.lock（仅根包 name = "app" 条目，勿动依赖版本）
 *
 * 用法：
 *   node scripts/bump-version.js current         # 仅打印当前版本
 *   node scripts/bump-version.js patch           # 1.2.0 -> 1.2.1（补丁号 +1）
 *   node scripts/bump-version.js minor           # 1.2.0 -> 1.3.0
 *   node scripts/bump-version.js major           # 1.2.0 -> 2.0.0
 *   node scripts/bump-version.js 1.3.0           # 显式指定具体版本号
 *   node scripts/bump-version.js patch --dry-run # 只打印不写文件
 *
 * 约定：新版本号打印到 stdout（供工作流 `NEW=$(node scripts/bump-version.js ...)` 捕获），
 * 其余提示信息一律输出到 stderr，避免污染 stdout。
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var PKG = path.join(ROOT, 'package.json');
var LOCK = path.join(ROOT, 'package-lock.json');
var CONF = path.join(ROOT, 'src-tauri', 'tauri.conf.json');
var CTOML = path.join(ROOT, 'src-tauri', 'Cargo.toml');
var CLOCK = path.join(ROOT, 'src-tauri', 'Cargo.lock');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, o) { fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n', 'utf8'); }

// ---------- 参数解析 ----------
var args = process.argv.slice(2);
var DRY = args.indexOf('--dry-run') !== -1;
args = args.filter(function (a) { return a !== '--dry-run'; });
var mode = args[0] || '';

function bump(from, arg) {
  var m = /^(\d+)\.(\d+)\.(\d+)$/.exec(from);
  if (!m) throw new Error('无法解析语义化版本号: ' + from);
  var ma = +m[1], mi = +m[2], pa = +m[3];
  if (/^\d+\.\d+\.\d+$/.test(arg)) return arg;      // 显式版本
  if (arg === 'patch') { pa++; }
  else if (arg === 'minor') { mi++; pa = 0; }
  else if (arg === 'major') { ma++; mi = 0; pa = 0; }
  else throw new Error('无效参数: ' + arg + '（支持 patch|minor|major|X.Y.Z|current）');
  return ma + '.' + mi + '.' + pa;
}

// ---------- 读取当前版本（以 package.json 为基准） ----------
var current = readJson(PKG).version;

if (!mode) {
  console.error('用法: node scripts/bump-version.js <patch|minor|major|X.Y.Z|current> [--dry-run]');
  process.exit(2);
}
if (mode === 'current') { console.log(current); process.exit(0); }

var next = bump(current, mode);
if (next === current) { console.log(next); process.exit(0); }   // 幂等

// ---------- 生成 5 个文件的新内容 ----------
var updates = [];   // [相对路径, 新内容]

var pkg = readJson(PKG); pkg.version = next;
updates.push(['package.json', JSON.stringify(pkg, null, 2) + '\n']);

var lock = readJson(LOCK); lock.version = next;
if (lock.packages && lock.packages['']) lock.packages[''].version = next;
updates.push(['package-lock.json', JSON.stringify(lock, null, 2) + '\n']);

var conf = readJson(CONF); conf.version = next;
updates.push(['src-tauri/tauri.conf.json', JSON.stringify(conf, null, 2) + '\n']);

var toml = fs.readFileSync(CTOML, 'utf8');
var newToml = toml.replace(/^version\s*=\s*"[^"]*"/m, 'version = "' + next + '"');
if (newToml === toml) throw new Error('Cargo.toml 中未找到 [package] 的 version 行');
updates.push(['src-tauri/Cargo.toml', newToml]);

var clock = fs.readFileSync(CLOCK, 'utf8');
var re = new RegExp('(name = "app"\r?\nversion = )"' + current.replace(/\./g, '\\.') + '"');
if (!re.test(clock)) {
  console.error('警告: Cargo.lock 中未找到根包 name = "app" 条目，跳过该文件');
} else {
  updates.push(['src-tauri/Cargo.lock', clock.replace(re, '$1"' + next + '"')]);
}

// ---------- 写盘 / 预览 ----------
if (DRY) {
  console.error('[dry-run] 版本: ' + current + ' -> ' + next + '，将更新以下文件（未写入）:');
  updates.forEach(function (u) { console.error('  - ' + u[0]); });
} else {
  updates.forEach(function (u) { fs.writeFileSync(path.join(ROOT, u[0]), u[1], 'utf8'); });
  console.error('版本已更新: ' + current + ' -> ' + next);
  updates.forEach(function (u) { console.error('  已更新: ' + u[0]); });
}
console.log(next);   // stdout 只输出新版本号
