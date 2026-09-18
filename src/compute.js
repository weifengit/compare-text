/**
 * compute.js — diff 计算管线（纯逻辑，无 DOM，可在 Worker / 主线程 / Node 运行）。
 * 依赖全局 diff（jsdiff）与 Norm（normalize.js）。
 * 全局暴露：Compute
 *
 * computeDiff(payload) -> { mode:'grid'|'flow', ... }
 *   payload = { left, right, options:{ ignoreCase, ignoreEol, ignoreWhitespace, ignoreNewline, ignoreWidth, ignorePunct } }
 */
(function (root, factory) {
  'use strict';
  var Norm, Diff;
  if (typeof module === 'object' && module.exports) {
    Norm = require('./normalize.js');
    try { Diff = root.diff; } catch (e) { Diff = null; }
    if (!Diff) {
      try { Diff = require('../lib/diff.min.js'); } catch (e2) { Diff = null; }
    }
    module.exports = factory(Norm, Diff);
  } else {
    // 浏览器/Worker：jsdiff 的 UMD 挂载全局名为大写 Diff（部分构建为小写 diff，兼容两者）
    var D = root.Diff || root.diff;
    root.Compute = factory(root.Norm, D);
  }
})(typeof self !== 'undefined' ? self : this, function (Norm, Diff) {
  'use strict';

  // 单字符/字符流 diff 的最坏代价上限（kept 长度乘积），超过则降级为整行标注，避免卡死
  var PRODUCT_LIMIT = 50000000;

  /** 宽松归一化（仅用于相似度配对）：小写 + 折叠空白，避免大小写/多余空格导致配对失败 */
  function loose(s) {
    return (s || '').toLowerCase().replace(/[\t ]+/g, ' ');
  }

  /** 相似度：两字符串宽松归一化后的匹配占比（diffChars 统计） */
  function similarity(a, b) {
    if (a === b) return 1;
    var la = loose(a), lb = loose(b);
    if (la === lb) return 1;
    if (la === '' && lb === '') return 1;
    if (!la || !lb) return 0;
    var d = Diff.diffChars(la, lb);
    var eq = 0, total = 0, i;
    for (i = 0; i < d.length; i++) {
      if (!d[i].added && !d[i].removed) eq += d[i].count;
      total += d[i].count;
    }
    return total ? eq / total : 1;
  }

  /**
   * 带原始偏移的字符流：与 Norm.charStream 完全一致地归一化，但额外记录每个保留字符
   * 在原文中的起始偏移（供字符级协同滚动构表：字符偏移 → 行号 互译）。
   * 返回 { kept: [归一化字符], offs: [原始偏移] }，两数组长度相同、一一对应。
   */
  function streamWithOffsets(text, o) {
    var kept = [], offs = [];
    var i = 0;
    while (i < text.length) {
      var code = text.codePointAt(i);
      var span = code > 0xFFFF ? 2 : 1;
      var norm = Norm.normalizeChar(text.slice(i, i + span), o);
      if (norm !== '') { kept.push(norm); offs.push(i); }
      i += span;
    }
    return { kept: kept, offs: offs };
  }

  /**
   * 行级对齐锚表：对两侧文本做行 diff，把“相等”行的行号配成锚点对（1 基）。
   * 行结构化内容（代码、PDF 文本项）行级锚定精确无漂移；段落重排时相等行稀疏。
   * coverage = 锚定行数 / 较短侧总行数，供调用方判断“行级是否可信”（稀疏 → 改用字符级）。
   * 零相等行 → null。
   */
  function buildLineAnchors(leftText, rightText, o) {
    var L = Norm.splitLines(leftText), R = Norm.splitLines(rightText);
    var i;
    var compL = new Array(L.length), compR = new Array(R.length);
    for (i = 0; i < L.length; i++) compL[i] = Norm.normalizeLine(L[i], o);
    for (i = 0; i < R.length; i++) compR[i] = Norm.normalizeLine(R[i], o);
    var l2r = [], r2l = [];
    var diffs = Diff.diffArrays(compL, compR);
    var li = 0, ri = 0, k, n;
    for (i = 0; i < diffs.length; i++) {
      var p = diffs[i];
      n = p.value.length;
      if (p.added) { ri += n; continue; }
      if (p.removed) { li += n; continue; }
      for (k = 0; k < n; k++) {
        l2r.push([li + k + 1, ri + k + 1]);
        r2l.push([ri + k + 1, li + k + 1]);
      }
      li += n; ri += n;
    }
    if (!l2r.length) return null;
    return { l2r: l2r, r2l: r2l, coverage: l2r.length / Math.max(1, Math.min(L.length, R.length)) };
  }

  /**
   * 字符级对齐锚表：对两侧文本做字符 diff，把“相等”字符的原始偏移配成锚点对。
   * l2r 按左侧偏移升序、r2l 按右侧偏移升序（均严格递增），供 interpAnchor 二分插值。
   * 文本过大（kept 乘积超限）或零相等字符 → null，调用方降级为行级对齐。
   */
  function buildCharAnchors(leftText, rightText, o) {
    var sL = streamWithOffsets(leftText, o);
    var sR = streamWithOffsets(rightText, o);
    if (sL.kept.length * sR.kept.length > PRODUCT_LIMIT) return null;
    var l2r = [], r2l = [];
    var diffs = Diff.diffArrays(sL.kept, sR.kept);
    var iL = 0, iR = 0, i, k, n;
    for (i = 0; i < diffs.length; i++) {
      var p = diffs[i];
      n = p.value.length;
      if (p.added) { iR += n; continue; }
      if (p.removed) { iL += n; continue; }
      for (k = 0; k < n; k++) {
        l2r.push([sL.offs[iL + k], sR.offs[iR + k]]);
        r2l.push([sR.offs[iR + k], sL.offs[iL + k]]);
      }
      iL += n; iR += n;
    }
    return l2r.length ? { l2r: l2r, r2l: r2l } : null;
  }

  /**
   * 同时构建行级与字符级锚表（PDF↔PDF 协同滚动用）。返回 { line, char }，两者各自可为 null。
   * 调用方优先行级（覆盖高时精确），稀疏则用字符级（段落重排场景更平滑）。
   */
  function buildAnchors(leftText, rightText, o) {
    return { line: buildLineAnchors(leftText, rightText, o), char: buildCharAnchors(leftText, rightText, o) };
  }

  /** 字符级 diff：整行文本 → 两边的渲染片段 */
  function diffCharsInLine(textL, textR, o) {
    var keptL = Norm.charStream(textL, o);
    var keptR = Norm.charStream(textR, o);
    if (keptL.length * keptR.length > PRODUCT_LIMIT) {
      // 行过大，降级：整行标注为变更
      return { segsL: [{ text: textL, cls: 'rm' }], segsR: [{ text: textR, cls: 'ad' }] };
    }
    var clsL = [], clsR = [];
    var diffs = Diff.diffArrays(keptL, keptR);
    for (var i = 0; i < diffs.length; i++) {
      var p = diffs[i];
      var k, n = p.value.length;
      if (p.added) { for (k = 0; k < n; k++) clsR.push('ad'); }
      else if (p.removed) { for (k = 0; k < n; k++) clsL.push('rm'); }
      else { for (k = 0; k < n; k++) { clsL.push('eq'); clsR.push('eq'); } }
    }
    return {
      segsL: Norm.classifySegs(textL, clsL, o),
      segsR: Norm.classifySegs(textR, clsR, o)
    };
  }

  /** 变更区行配对：先按相似度贪婪配对，未配对的在“小块”内按顺序兜底 1:1（避免逐字节全改导致拆成整段删+增） */
  function pairChanged(rem, add, o) {
    var pairs = [];
    if (!rem.length || !add.length) return pairs;
    var usedL = {}, usedR = {};
    if (rem.length * add.length <= 600) {
      var matches = [];
      for (var a = 0; a < rem.length; a++) {
        for (var b = 0; b < add.length; b++) {
          var s = similarity(rem[a].comp, add[b].comp);
          if (s >= 0.25) matches.push({ s: s, a: a, b: b });
        }
      }
      matches.sort(function (x, y) { return y.s - x.s; });
      for (var m = 0; m < matches.length; m++) {
        var mt = matches[m];
        if (usedL[mt.a] || usedR[mt.b]) continue;
        usedL[mt.a] = true;
        usedR[mt.b] = true;
        pairs.push({ li: rem[mt.a].li, ri: add[mt.b].ri });
      }
    }
    // 兜底：未配对且总行数不大的区域，按原始顺序 1:1 配对
    var remLeft = [], addLeft = [];
    for (var i = 0; i < rem.length; i++) if (!usedL[i]) remLeft.push(i);
    for (var j = 0; j < add.length; j++) if (!usedR[j]) addLeft.push(j);
    if (remLeft.length + addLeft.length <= 6) {
      var n2 = Math.min(remLeft.length, addLeft.length);
      for (var q = 0; q < n2; q++) {
        var li0 = rem[remLeft[q]].li, ri0 = add[addLeft[q]].ri;
        pairs.push({ li: li0, ri: ri0 });
        usedL[remLeft[q]] = true;
        usedR[addLeft[q]] = true;
      }
    }
    return pairs;
  }

  var K_EQUAL = 'equal', K_CHANGE = 'change', K_REMOVE = 'remove', K_ADD = 'add';

  /**
   * 行级对齐：
   *   equal 行逐行配对；
   *   变更区（连续的 removed+added part）用相似度把对应的删除行/新增行配成 change 行，
   *   剩余的行分别作为 remove / add。
   * rows[i] = { type, li, ri , segL?, segR? }，li/ri 为原始行下标（-1 表示无）。
   */
  function alignRows(diffs, L, R, compL, compR, o) {
    var rows = [];
    var li = 0, ri = 0;
    var pending = null;
    var i, k;

    function makeChangeRow(li0, ri0) {
      var seg = diffCharsInLine(L[li0], R[ri0], o);
      return { type: K_CHANGE, li: li0, ri: ri0, segL: seg.segsL, segR: seg.segsR };
    }
    function flushChange() {
      if (!pending) return;
      var rem = pending.rem, add = pending.add;
      pending = null;
      var pairs = pairChanged(rem, add, o);
      var usedL = {}, usedR = {};
      for (var p = 0; p < pairs.length; p++) {
        rows.push(makeChangeRow(pairs[p].li, pairs[p].ri));
        usedL[pairs[p].li] = true;
        usedR[pairs[p].ri] = true;
      }
      for (var a = 0; a < rem.length; a++) {
        if (!usedL[rem[a].li]) rows.push({ type: K_REMOVE, li: rem[a].li, ri: -1 });
      }
      for (var b = 0; b < add.length; b++) {
        if (!usedR[add[b].ri]) rows.push({ type: K_ADD, li: -1, ri: add[b].ri });
      }
    }

    for (i = 0; i < diffs.length; i++) {
      var part = diffs[i];
      var isRem = !!(part.removed) && !part.added;
      var isAdd = !!(part.added) && !part.removed;
      if (!isRem && !isAdd) {
        flushChange();
        for (k = 0; k < part.value.length; k++) {
          rows.push({ type: K_EQUAL, li: li + k, ri: ri + k });
        }
        li += part.value.length;
        ri += part.value.length;
      } else if (isRem) {
        if (!pending) pending = { rem: [], add: [] };
        for (k = 0; k < part.value.length; k++) {
          pending.rem.push({ li: li + k, text: L[li + k], comp: compL[li + k] });
        }
        li += part.value.length;
      } else {
        if (!pending) pending = { rem: [], add: [] };
        for (k = 0; k < part.value.length; k++) {
          pending.add.push({ ri: ri + k, text: R[ri + k], comp: compR[ri + k] });
        }
        ri += part.value.length;
      }
    }
    flushChange();
    return rows;
  }

  function computeStats(rows) {
    var st = { modified: 0, added: 0, removed: 0, equal: 0 };
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i].type;
      if (r === K_CHANGE) st.modified++;
      else if (r === K_ADD) st.added++;
      else if (r === K_REMOVE) st.removed++;
      else st.equal++;
    }
    return st;
  }

  /** 基于行级结果生成 unified diff 文本（hunk 3 行上下文） */
  function buildUnified(rows, L, R) {
    var n = rows.length;
    var changed = new Array(n);
    var hasAny = false;
    var i;
    for (i = 0; i < n; i++) {
      changed[i] = rows[i].type !== K_EQUAL;
      if (changed[i]) hasAny = true;
    }
    if (!hasAny) return '';
    // 找出变更区间并加 3 行上下文，重叠则合并
    var intervals = [];
    var s = -1, e = -1;
    for (i = 0; i < n; i++) {
      if (changed[i]) { if (s < 0) s = i; e = i; }
      else if (s >= 0) { intervals.push([s, e]); s = -1; }
    }
    if (s >= 0) intervals.push([s, e]);
    var list = [];
    for (var k = 0; k < intervals.length; k++) {
      var a = Math.max(0, intervals[k][0] - 3);
      var b = Math.min(n - 1, intervals[k][1] + 3);
      if (list.length && a <= list[list.length - 1][1] + 1) {
        list[list.length - 1][1] = Math.max(list[list.length - 1][1], b);
      } else {
        list.push([a, b]);
      }
    }
    // 累计左右出现行数，便于计算 hunk 首行号
    var before = new Array(n + 1);
    before[0] = 0;
    for (i = 0; i < n; i++) {
      before[i + 1] = before[i] + (rows[i].li >= 0 ? 1 : 0);
    }
    var beforeR = new Array(n + 1);
    beforeR[0] = 0;
    for (i = 0; i < n; i++) {
      beforeR[i + 1] = beforeR[i] + (rows[i].ri >= 0 ? 1 : 0);
    }
    var out = ['--- a/原文', '+++ b/修改后'];
    function hdr(field, cnt) { return field + ',' + cnt; }
    for (var h = 0; h < list.length; h++) {
      var ia = list[h][0], ib = list[h][1];
      var lCount = before[ib + 1] - before[ia];
      var rCount = beforeR[ib + 1] - beforeR[ia];
      var lStart = before[ia] + 1;
      var rStart = beforeR[ia] + 1;
      var lS = lCount === 1 ? String(lStart) : hdr(lStart, lCount);
      var rS = rCount === 1 ? String(rStart) : hdr(rStart, rCount);
      out.push('@@ -' + lS + ' +' + rS + ' @@');
      for (var p = ia; p <= ib; p++) {
        var rw = rows[p];
        if (rw.type === K_EQUAL) out.push(' ' + L[rw.li]);
        else if (rw.type === K_CHANGE) {
          out.push('-' + L[rw.li]);
          out.push('+' + R[rw.ri]);
        } else if (rw.type === K_REMOVE) out.push('-' + L[rw.li]);
        else out.push('+' + R[rw.ri]);
      }
    }
    return out.join('\n');
  }

  /** 忽略换行 → 整篇流水字符 diff（换行归一化为空、不参与比较与高亮）。同时产出字符级对齐锚表 charAnchors */
  function computeFlow(leftText, rightText, o) {
    var sL = streamWithOffsets(leftText, o);
    var sR = streamWithOffsets(rightText, o);
    if (sL.kept.length * sR.kept.length > PRODUCT_LIMIT) {
      return { mode: 'flow', skipped: true, leftLen: leftText.length, rightLen: rightText.length };
    }
    var clsL = [], clsR = [], l2r = [], r2l = [];
    var diffs = Diff.diffArrays(sL.kept, sR.kept);
    var iL = 0, iR = 0;
    for (var i = 0; i < diffs.length; i++) {
      var p = diffs[i];
      var k, n = p.value.length;
      if (p.added) { for (k = 0; k < n; k++) clsR.push('ad'); iR += n; }
      else if (p.removed) { for (k = 0; k < n; k++) clsL.push('rm'); iL += n; }
      else {
        for (k = 0; k < n; k++) {
          clsL.push('eq'); clsR.push('eq');
          l2r.push([sL.offs[iL + k], sR.offs[iR + k]]);
          r2l.push([sR.offs[iR + k], sL.offs[iL + k]]);
        }
        iL += n; iR += n;
      }
    }
    var removedChars = 0, addedChars = 0;
    for (var a = 0; a < clsL.length; a++) if (clsL[a] === 'rm') removedChars++;
    for (var b = 0; b < clsR.length; b++) if (clsR[b] === 'ad') addedChars++;
    return {
      mode: 'flow',
      segsL: Norm.classifySegs(leftText, clsL, o),
      segsR: Norm.classifySegs(rightText, clsR, o),
      removedChars: removedChars,
      addedChars: addedChars,
      charAnchors: l2r.length ? { l2r: l2r, r2l: r2l } : null,
      lineAnchors: buildLineAnchors(leftText, rightText, o)
    };
  }

  function optionsFrom(o) {
    return {
      ignoreCase: !!(o && o.ignoreCase),
      ignoreEol: o && 'ignoreEol' in o ? !!o.ignoreEol : true,
      ignoreWhitespace: !!(o && o.ignoreWhitespace),
      ignoreNewline: !!(o && o.ignoreNewline),
      ignoreWidth: !!(o && o.ignoreWidth),
      ignorePunct: !!(o && o.ignorePunct)
    };
  }

  function computeDiff(payload) {
    var left = (payload && payload.left) || '';
    var right = (payload && payload.right) || '';
    var o = optionsFrom(payload && payload.options);

    if (o.ignoreNewline) return computeFlow(left, right, o);

    var L = Norm.splitLines(left);
    var R = Norm.splitLines(right);
    var i;
    var compL = new Array(L.length), compR = new Array(R.length);
    for (i = 0; i < L.length; i++) compL[i] = Norm.normalizeLine(L[i], o);
    for (i = 0; i < R.length; i++) compR[i] = Norm.normalizeLine(R[i], o);

    var diffs = Diff.diffArrays(compL, compR);
    var rows = alignRows(diffs, L, R, compL, compR, o);
    var stats = computeStats(rows);
    var unified = buildUnified(rows, L, R);
    return {
      mode: 'grid',
      rows: rows,
      leftLines: L,
      rightLines: R,
      stats: stats,
      unified: unified
    };
  }

  return {
    computeDiff: computeDiff, similarity: similarity,
    buildCharAnchors: buildCharAnchors, buildLineAnchors: buildLineAnchors, buildAnchors: buildAnchors
  };
});