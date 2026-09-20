'use strict';
/**
 * dsh-report.js — deepseek harness（dsh）插件薄层：一份任务 JSON 进，一份或多份报告出。
 * 自然语言 → 任务 JSON 由 dsh 的 LLM 完成（schema 与范例见 .dsh/skills/compare-report/SKILL.md），
 * 本脚本只做三件事：文件夹自动配对、超过 10 对自动分卷、逐卷子进程调用 tools/render.js 并聚合结果。
 * 与 render.js 的交互只走标准输出 / 退出码（提示词 5 第 5 条），不碰其内部。
 *
 * 用法：node tools/dsh-report.js --task task.json
 * 任务 JSON（render.js 任务的超集）：
 *   { title, options: { ignoreCase, ignoreEol, ignoreWhitespace,   // 缺省与页面默认一致：全开
 *                       ignoreNewline, ignoreWidth, ignorePunct },
 *     output: "/abs/path/report.html",
 *     pairs: [{ left, right }, …]                                  // 模式一：显式列出每一对
 *     | source: { leftDir, rightDir,                               // 模式二：两文件夹按同文件名自动配对
 *                 glob: "*.docx",                                  //   可选，默认 *.{pdf,docx,txt,md}
 *                 list: ["a.docx", { left, right }] } }            //   可选名单：字符串=两侧同名，对象=显式相对/绝对路径
 *
 * 标准输出一行结构化 JSON（日志走 stderr）：
 *   { ok, reports: [{ output, stats, warnings }], stats, warnings }
 * 退出码：0 全部成功；1 任务错误（含部分对失败）；2 环境不可用（缺 render.js / 浏览器）。
 */
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');

var RENDER = path.join(__dirname, 'render.js');
var MAX_PER_REPORT = 10;   // 与 render.js 的 C3 约定一致：一份报告最多 10 对

function log(s) { process.stderr.write(s + '\n'); }

// ---------- glob（* ? 与 {a,b} 展开，大小写不敏感） ----------
function expandBraces(glob) {
  var m = /\{([^{}]+)\}/.exec(glob);
  if (!m) return [glob];
  var before = glob.slice(0, m.index), after = glob.slice(m.index + m[0].length);
  var out = [];
  m[1].split(',').forEach(function (alt) {
    expandBraces(before + alt + after).forEach(function (g) { out.push(g); });
  });
  return out;
}
function globMatch(glob, name) {
  return expandBraces(glob).some(function (g) {
    var re = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp('^' + re + '$', 'i').test(name);
  });
}

// ---------- 配对 ----------
function listFiles(dir, glob) {
  return fs.readdirSync(dir).filter(function (n) {
    return fs.statSync(path.join(dir, n)).isFile() && globMatch(glob, n);
  }).sort();
}

/** 任务 → { pairs, warnings }；输入非法直接 throw（由调用方转结构化错误） */
function resolvePairs(task) {
  if (!task || typeof task !== 'object') throw new Error('任务不是合法的 JSON 对象');
  if (task.pairs && task.source) throw new Error('pairs 与 source 只能二选一');

  if (task.source) {
    var src = task.source;
    if (!src.leftDir || !src.rightDir) throw new Error('source 需要 leftDir 与 rightDir');
    var ld = path.resolve(src.leftDir), rd = path.resolve(src.rightDir);
    if (!fs.existsSync(ld)) throw new Error('左侧文件夹不存在：' + ld);
    if (!fs.existsSync(rd)) throw new Error('右侧文件夹不存在：' + rd);
    var warnings = [], pairs = [];

    if (Array.isArray(src.list)) {
      src.list.forEach(function (item) {
        var l, r;
        if (typeof item === 'string') { l = path.join(ld, item); r = path.join(rd, item); }
        else if (item && item.left && item.right) {
          l = path.resolve(ld, item.left); r = path.resolve(rd, item.right);
        } else { warnings.push('名单条目无法识别（需为文件名或 {left,right}）：' + JSON.stringify(item)); return; }
        if (!fs.existsSync(l)) { warnings.push('名单文件在左侧不存在：' + l); return; }
        if (!fs.existsSync(r)) { warnings.push('名单文件在右侧不存在：' + r); return; }
        pairs.push({ left: l, right: r });
      });
      return { pairs: pairs, warnings: warnings };
    }

    if (ld === rd) throw new Error('leftDir 与 rightDir 相同：同目录配对请改用 pairs 或 source.list 明确指定每一对');
    var glob = src.glob || '*.{pdf,docx,txt,md}';
    var lefts = listFiles(ld, glob);
    var rightByKey = {};   // 小写文件名 → 实际文件名
    listFiles(rd, glob).forEach(function (n) { rightByKey[n.toLowerCase()] = n; });
    var matched = {};
    lefts.forEach(function (n) {
      var r = rightByKey[n.toLowerCase()];
      if (r) { matched[r.toLowerCase()] = true; pairs.push({ left: path.join(ld, n), right: path.join(rd, r) }); }
      else warnings.push('仅左侧存在，未配对：' + n);
    });
    Object.keys(rightByKey).forEach(function (k) {
      if (!matched[k]) warnings.push('仅右侧存在，未配对：' + rightByKey[k]);
    });
    return { pairs: pairs, warnings: warnings };
  }

  if (!Array.isArray(task.pairs) || !task.pairs.length) {
    throw new Error('任务需要非空 pairs 数组，或 source 文件夹配对');
  }
  task.pairs.forEach(function (p, i) {
    if (!p || typeof p.left !== 'string' || typeof p.right !== 'string') {
      throw new Error('第 ' + (i + 1) + ' 对缺少 left/right 路径');
    }
  });
  return {
    pairs: task.pairs.map(function (p) { return { left: path.resolve(p.left), right: path.resolve(p.right) }; }),
    warnings: []
  };
}

// ---------- 分卷 ----------
function splitVolumes(pairs) {
  var vols = [];
  for (var i = 0; i < pairs.length; i += MAX_PER_REPORT) vols.push(pairs.slice(i, i + MAX_PER_REPORT));
  return vols;
}
/** 单卷用原输出名；多卷在扩展名前加 -1、-2… */
function volumeOutput(output, idx, total) {
  if (total <= 1) return output;
  var ext = path.extname(output);
  return path.join(path.dirname(output), path.basename(output, ext) + '-' + (idx + 1) + ext);
}

// ---------- 调用 render.js（只走 stdout / 退出码） ----------
function runRender(subTask) {
  return new Promise(function (resolve) {
    var tmp = path.join(os.tmpdir(), 'dsh-report-' + process.pid + '-' + Date.now() + '.json');
    fs.writeFileSync(tmp, JSON.stringify(subTask), 'utf8');
    var out = '';
    var child = cp.spawn(process.execPath, [RENDER, '--task', tmp], { stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.on('data', function (d) { out += d; });
    child.on('error', function (e) {
      try { fs.unlinkSync(tmp); } catch (e0) {}
      resolve({ code: 2, json: { ok: false, output: null, warnings: ['启动 render.js 失败：' + e.message] } });
    });
    child.on('close', function (code) {
      try { fs.unlinkSync(tmp); } catch (e0) {}
      var json = null, line = out.trim().split('\n').pop();
      try { json = JSON.parse(line); } catch (e) { /* render.js 崩溃无 JSON */ }
      resolve({ code: code, json: json });
    });
  });
}

// ---------- 主流程 ----------
function fail(msg, code) {
  process.stderr.write(msg + '\n');
  process.stdout.write(JSON.stringify({
    ok: false, reports: [], stats: { pairs: 0, added: 0, removed: 0, changed: 0 }, warnings: [msg]
  }) + '\n');
  process.exit(code || 1);
}

async function main() {
  if (!fs.existsSync(RENDER)) fail('找不到 tools/render.js：' + RENDER, 2);
  var taskPath = null;
  for (var i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--task' && i + 1 < process.argv.length) taskPath = process.argv[i + 1];
  }
  if (!taskPath) fail('用法：node tools/dsh-report.js --task <task.json>');
  var task;
  try { task = JSON.parse(fs.readFileSync(taskPath, 'utf8')); }
  catch (e) { fail('任务文件读取/解析失败：' + e.message); }

  var resolved;
  try { resolved = resolvePairs(task); }
  catch (e) { fail(e.message); }
  if (!resolved.pairs.length) {
    process.stdout.write(JSON.stringify({
      ok: false, reports: [], stats: { pairs: 0, added: 0, removed: 0, changed: 0 },
      warnings: resolved.warnings.concat(['没有可对比的文件对'])
    }) + '\n');
    process.exit(1);
  }

  var vols = splitVolumes(resolved.pairs);
  var output = path.resolve(task.output || 'report.html');
  var title = task.title || '文本对比报告';
  log('共 ' + resolved.pairs.length + ' 对，分 ' + vols.length + ' 卷渲染');
  resolved.warnings.forEach(function (w) { log('  !! ' + w); });

  var reports = [], warnings = resolved.warnings.slice();
  var stats = { pairs: 0, added: 0, removed: 0, changed: 0 };
  var ok = true, exitCode = 0;

  for (i = 0; i < vols.length; i++) {
    var out = volumeOutput(output, i, vols.length);
    var volTitle = vols.length > 1 ? title + '（' + (i + 1) + '/' + vols.length + '）' : title;
    log('── 卷 ' + (i + 1) + '/' + vols.length + '：' + vols[i].length + ' 对 → ' + out);
    var r = await runRender({ title: volTitle, pairs: vols[i], options: task.options, output: out });
    if (r.code === 2 || !r.json) {   // 环境不可用或 render.js 崩溃：后续卷不必再跑
      var envMsg = r.json && r.json.warnings ? r.json.warnings.join('；')
        : 'render.js 异常退出（退出码 ' + r.code + '），未产出结构化结果';
      warnings.push('卷 ' + (i + 1) + '：' + envMsg);
      ok = false; exitCode = 2;
      break;
    }
    reports.push({ output: r.json.output, stats: r.json.stats, warnings: r.json.warnings });
    stats.pairs += r.json.stats.pairs; stats.added += r.json.stats.added;
    stats.removed += r.json.stats.removed; stats.changed += r.json.stats.changed;
    r.json.warnings.forEach(function (w) { warnings.push('卷 ' + (i + 1) + '：' + w); });
    if (!r.json.ok) { ok = false; exitCode = 1; }
  }

  process.stdout.write(JSON.stringify({ ok: ok, reports: reports, stats: stats, warnings: warnings }) + '\n');
  process.exit(exitCode);
}

if (require.main === module) {
  main().catch(function (e) { fail('未预期错误：' + ((e && e.message) || e)); });
}

module.exports = { globMatch: globMatch, resolvePairs: resolvePairs, splitVolumes: splitVolumes, volumeOutput: volumeOutput };
