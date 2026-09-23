'use strict';
/**
 * dsh-report.js — deepseek harness（dsh）插件薄层：一份任务 JSON 进，一份或多份报告出。
 * 自然语言 → 任务 JSON 由 dsh 的 LLM 完成（schema 与范例见 .dsh/skills/compare-report/SKILL.md），
 * 本脚本只做机械活：文件夹自动配对、规则化目录遍历（walk）、分卷、逐卷子进程调用
 * tools/render.js 并聚合结果。与 render.js 的交互只走标准输出 / 退出码，不碰其内部。
 *
 * 用法：node tools/dsh-report.js --task task.json
 * 任务 JSON（render.js 任务的超集）：
 *   { title, options: { ignoreCase, ignoreEol, ignoreWhitespace,   // 缺省与页面默认一致：全开
 *                       ignoreNewline, ignoreWidth, ignorePunct },
 *     output: "/abs/path/report.html" 或目录（walk 模式必须是目录），
 *     maxPairsPerReport: 10,          // 可选：每卷最多对数（缺省 10 或环境变量 DSH_MAX_PAIRS_PER_REPORT）
 *     pairs: [{ left, right }, …]                                  // 模式一：显式列出每一对
 *     | source: { leftDir, rightDir,                               // 模式二：两文件夹按同文件名自动配对
 *                 glob: "*.docx",                                  //   可选，默认 *.{pdf,docx,txt,md}
 *                 list: ["a.docx", { left, right }] }              //   可选名单：字符串=两侧同名，对象=显式相对/绝对路径
 *     | source: { walk: {                                          // 模式三：规则化目录遍历（推荐批量场景）
 *                 root: "<文档树根>",                              //   必需：遍历起点（如 A）
 *                 files: "*.{pdf,docx,txt,md}",                    //   可选：文档扩展名；html 永远排除
 *                 left: "广东确定",                                 //   可选：基准/原文文件名规则（子串 | glob | re:正则）；
 *                                                                  //   缺省="广东"省份判断（取最后一个 - 后的片段，见下）
 *                 right: "",                                       //   可选：对比文件名规则；缺省=同文件夹不含 left 的文件
 *                 volume: "folder" | <数字>                        //   可选：'folder'=每个文档文件夹一份报告（缺省）；
 *                                                                  //   数字=每卷最多 N 对（多卷加 -1/-2 后缀）
 *               } } }
 *
 * walk 模式的设计意图（省 token / 省步骤）：
 *   大模型不需要逐个列目录、也不需要枚举每一对 —— 只给 root + 规则，代码遍历整棵树：
 *   每个"直接含文档的子文件夹"（C）自动成为一个卷（一份报告），输出放到
 *   <output>/<B>/<C>.html（B = root 下第一层文件夹名；文档直接在某 B 下时 <output>/<B>.html）。
 *   left 缺省规则 = "广东"省份版：取文件名最后一个 '-' 后片段判断是否含"广东"，
 *   避免药材名本身含"广东"（如"广东土牛膝-江西确定.pdf"）被误判为广东省份版。
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
// 每卷默认最多对数；可被任务字段 maxPairsPerReport 覆盖（walk volume:'folder' 时该上限不生效）
var MAX_PER_REPORT = parseInt(process.env.DSH_MAX_PAIRS_PER_REPORT || '10', 10);
// 并行卷数：1=串行（缺省，最稳）；>1 同时跑多个 render.js（省时但吃内存，如 DSH_PARALLEL=3）
var PARALLEL = parseInt(process.env.DSH_PARALLEL || '1', 10);

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
  if (task.source && task.source.walk) throw new Error('source.walk 请用 resolveWalk（模式三）');

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

// ---------- 模式三：walk 规则化目录遍历 ----------

/** 名称匹配器：'re:正则' → 正则；含 glob 元字符 → glob；否则子串（大小写不敏感） */
function makeMatcher(rule) {
  var src = String(rule);
  if (src.slice(0, 3) === 're:') {
    var re = new RegExp(src.slice(3), 'i');
    return function (n) { return re.test(n); };
  }
  if (/[*?{}]/.test(src)) return function (n) { return globMatch(src, n); };
  var low = src.toLowerCase();
  return function (n) { return n.toLowerCase().indexOf(low) !== -1; };
}

/** 缺省 left 规则："广东"省份版。取文件名最后一个 '-'（或 '－'/空格）后的片段判断，
 *  避免药材名本身含"广东"（广东土牛膝-江西确定.pdf）被误判。 */
function defaultLeftMatch(name) {
  var base = String(name).replace(/\.[^.]+$/, '');
  var parts = base.split(/[-－\s]+/).filter(Boolean);
  var seg = parts.length > 1 ? parts[parts.length - 1] : base;
  return seg.indexOf('广东') !== -1;
}

/**
 * walk 模式：遍历 root 下所有子文件夹，每个"直接含匹配文档"的子文件夹成为一个卷。
 * 返回 { volumes: [{ pairs, output, title, name }], warnings }；输入非法直接 throw。
 */
function resolveWalk(task) {
  if (!task || typeof task !== 'object') throw new Error('任务不是合法的 JSON 对象');
  var w = task.source && task.source.walk;
  if (!w || typeof w !== 'object') throw new Error('source.walk 需要对象 { root, ... }');
  var root = path.resolve(w.root);
  if (!fs.existsSync(root)) throw new Error('walk 根目录不存在：' + root);
  if (!fs.statSync(root).isDirectory()) throw new Error('walk root 不是目录：' + root);

  var glob = w.files || '*.{pdf,docx,txt,md}';
  var leftMatcher = w.left ? makeMatcher(w.left) : defaultLeftMatch;
  var rightMatcher = w.right ? makeMatcher(w.right) : null;
  var outputRoot = path.resolve(task.output || 'report.html');
  var warnings = [];
  var volumes = [];

  // 遍历 root 下所有子目录（任意深度），记录 { path, name, relSegs }
  var dirs = [];
  (function walkDirs(dir, relSegs) {
    var entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    entries.forEach(function (en) {
      if (!en.isDirectory()) return;
      var full = path.join(dir, en.name);
      var segs = relSegs.concat(en.name);
      dirs.push({ path: full, name: en.name, segs: segs });
      walkDirs(full, segs);
    });
  })(root, []);
  dirs.sort(function (a, b) { return a.path < b.path ? -1 : a.path > b.path ? 1 : 0; });

  var docFolders = 0;
  dirs.forEach(function (d) {
    var files = listFiles(d.path, glob).filter(function (n) { return !/\.html?$/i.test(n); });
    if (!files.length) return;                       // 该文件夹没有文档 → 不是文档文件夹
    var lefts = files.filter(leftMatcher);
    var rights = files.filter(function (n) {
      if (leftMatcher(n)) return false;              // 基准文件不做对比对象
      return rightMatcher ? rightMatcher(n) : true;
    });
    docFolders++;
    if (!lefts.length) { warnings.push('文件夹无基准文件（left 匹配不到）：' + d.path); return; }
    if (!rights.length) { warnings.push('文件夹无对比文件（right 为空）：' + d.path); return; }
    var pairs = [];
    lefts.forEach(function (l) {
      rights.forEach(function (r) {
        pairs.push({ left: path.join(d.path, l), right: path.join(d.path, r) });
      });
    });
    // 输出路径：<outputRoot>/<B>/<C>.html；B=root 下第一层，C=该文件夹名（多级用空格连接）
    var bName = d.segs[0];
    var outName = d.segs.length === 1 ? bName + '.html' : d.segs.slice(1).join(' ') + '.html';
    var output = path.join(outputRoot, bName, outName);
    // 标题：任务标题（可选）作为前缀，正文用文档文件夹名
    var title = task.title ? task.title + '（' + d.name + '）' : d.name;

    // 卷切分：volume:'folder'（缺省）= 整文件夹一卷；数字 = 每卷最多 N 对
    var cap = (typeof w.volume === 'number' && w.volume > 0) ? w.volume : Infinity;
    for (var i = 0; i < pairs.length; i += cap) {
      var chunk = pairs.slice(i, i + cap);
      var out = (chunk.length < pairs.length)
        ? output.replace(/\.html?$/i, function (ext) { return '-' + (i / cap + 1) + ext; })
        : output;
      // 卷内最大对数：整文件夹一卷时 = 本文件夹实际对数（让 render.js 放行，不再卡 10 对）；
      // volume 为数字时 = 该数字。
      var capForRender = (cap === Infinity) ? chunk.length : cap;
      volumes.push({ pairs: chunk, output: out, title: title, name: d.name, maxPairsPerReport: capForRender });
    }
  });

  if (!docFolders) throw new Error('walk：root 下没有任何包含文档的子文件夹（root=' + root + '）');
  return { volumes: volumes, warnings: warnings };
}

// ---------- 分卷（模式一/二） ----------
function splitVolumes(pairs, max) {
  var cap = (typeof max === 'number' && max > 0) ? max : MAX_PER_REPORT;
  var vols = [];
  for (var i = 0; i < pairs.length; i += cap) vols.push(pairs.slice(i, i + cap));
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
    var tmp = path.join(os.tmpdir(), 'dsh-report-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.json');
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

/** 并发池跑卷：n 个同时跑，结果按输入顺序返回。 */
async function runVolumes(volumes, taskOptions, onLog) {
  var n = Math.max(1, Math.min(PARALLEL, volumes.length));
  var results = new Array(volumes.length);
  var next = 0;
  async function worker() {
    while (true) {
      var i = next++;
      if (i >= volumes.length) return;
      var v = volumes[i];
      if (onLog) onLog(i, v);
      results[i] = await runRender({ title: v.title, pairs: v.pairs, options: taskOptions, output: v.output,
        maxPairsPerReport: v.maxPairsPerReport });
    }
  }
  var workers = [];
  for (var k = 0; k < n; k++) workers.push(worker());
  await Promise.all(workers);
  return results;
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

  var volumes = null, warnings0 = [];
  var title = task.title || '文本对比报告';
  var output = path.resolve(task.output || 'report.html');

  if (task.source && task.source.walk) {
    // 模式三：walk 直接产出卷（每文档文件夹一卷）
    try {
      var wk = resolveWalk(task);
      volumes = wk.volumes;
      warnings0 = wk.warnings;
    } catch (e) { fail(e.message); }
  } else {
    // 模式一/二：pairs / source 文件夹配对 → 分卷
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
    var vols = splitVolumes(resolved.pairs, task.maxPairsPerReport);
    volumes = vols.map(function (v, i) {
      return {
        pairs: v,
        output: volumeOutput(output, i, vols.length),
        title: vols.length > 1 ? title + '（' + (i + 1) + '/' + vols.length + '）' : title
      };
    });
    warnings0 = resolved.warnings;
  }

  var pairCount = volumes.reduce(function (s, v) { return s + v.pairs.length; }, 0);
  log('共 ' + pairCount + ' 对，分 ' + volumes.length + ' 卷渲染（并行 ' + PARALLEL + '）');
  warnings0.forEach(function (w) { log('  !! ' + w); });

  var reports = [], warnings = warnings0.slice();
  var stats = { pairs: 0, added: 0, removed: 0, changed: 0 };
  var ok = true, exitCode = 0;

  var results = await runVolumes(volumes, task.options, function (idx, v) {
    log('── 卷 ' + (idx + 1) + '/' + volumes.length + '：' + v.pairs.length + ' 对 → ' + v.output);
  });
  var envBreak = false;
  results.forEach(function (r, i) {
    if (envBreak) return;
    if (r.code === 2 || !r.json) {   // 环境不可用或 render.js 崩溃：后续卷不必再跑
      var envMsg = r.json && r.json.warnings ? r.json.warnings.join('；')
        : 'render.js 异常退出（退出码 ' + r.code + '），未产出结构化结果';
      warnings.push('卷 ' + (i + 1) + '：' + envMsg);
      ok = false; exitCode = 2;
      envBreak = true;
      return;
    }
    reports.push({ output: r.json.output, stats: r.json.stats, warnings: r.json.warnings });
    stats.pairs += r.json.stats.pairs; stats.added += r.json.stats.added;
    stats.removed += r.json.stats.removed; stats.changed += r.json.stats.changed;
    r.json.warnings.forEach(function (w) { warnings.push('卷 ' + (i + 1) + '：' + w); });
    if (!r.json.ok) { ok = false; exitCode = 1; }
  });

  process.stdout.write(JSON.stringify({ ok: ok, reports: reports, stats: stats, warnings: warnings }) + '\n');
  process.exit(exitCode);
}

if (require.main === module) {
  main().catch(function (e) { fail('未预期错误：' + ((e && e.message) || e)); });
}

module.exports = {
  globMatch: globMatch, resolvePairs: resolvePairs, splitVolumes: splitVolumes,
  volumeOutput: volumeOutput, resolveWalk: resolveWalk, makeMatcher: makeMatcher
};
