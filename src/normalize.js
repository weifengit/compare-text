/**
 * normalize.js — 文本归一化与分字符逻辑（纯逻辑，无 DOM）。
 * 供浏览器 <script>、Web Worker、Node 测试共用。
 * 全局暴露：Norm
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Norm = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 全/半角标点（覆盖成对排列），用于“忽略标点”。
  var PUNCT_CHARS = [
    '(', ')', '（', '）', '[', ']', '【', '】', '{', '}', '｛', '｝',
    '<', '>', '《', '》', '「', '」', '『', '』',
    "'", '"', '‘', '’', '“', '”', '«', '»',
    '„', '‹', '›', '、', '、',
    ',', '，', '.', '。', '．', '…', '‥', '·', '・',
    ';', '；', ':', '：',
    '?', '？', '!', '！',
    '%', '％', '*', '＊', '+', '＋', '-', '－', '=', '＝',
    '~', '～', '_', '＿', '/', '／', '\\', '＼', '|', '｜',
    '&', '＆', '#', '＃', '@', '＠', '$', '＄', '^', '＾', '`', '｀', '¥', '￥'
  ];
  var PUNCT_SET = {};
  for (var i = 0; i < PUNCT_CHARS.length; i++) PUNCT_SET[PUNCT_CHARS[i]] = true;

  /**
   * 归一化单个字符。
   * 返回 '' 表示该字符从“比较流”中剔除（渲染时仍会显示，但不参与比较、不高亮）。
   * options: { ignoreCase, ignoreEol, ignoreWhitespace, ignoreNewline, ignoreWidth, ignorePunct }
   */
  function normalizeChar(ch, o) {
    o = o || {};
    if (ch === '\r') return (o.ignoreEol || o.ignoreNewline) ? '' : '\r';
    if (ch === '\n') return (o.ignoreNewline || o.ignoreWhitespace) ? '' : '\n';
    // 忽略换行：同步忽略空白字符（含半/全角空格、tab），实现“段落重排”语义
    if (o.ignoreNewline && /\s/.test(ch)) return '';
    var c = ch;
    if (o.ignoreCase) c = c.toLowerCase();
    // 全角(punct范围 FF01–FF5E 及空格 U+3000) → 半角
    if (c.length === 1) {
      var code = c.charCodeAt(0);
      if (code >= 0xFF01 && code <= 0xFF5E) c = String.fromCharCode(code - 0xFEE0);
      else if (code === 0x3000) c = ' ';
    }
    if (o.ignorePunct && PUNCT_SET[c]) return '';
    if (o.ignoreWhitespace && /\s/.test(c)) return '';
    return c;
  }

  /** 单行归一化（用于行级 diff 的比较串） */
  function normalizeLine(text, o) {
    var out = '';
    var i = 0;
    while (i < text.length) {
      var code = text.codePointAt(i);
      var span = code > 0xFFFF ? 2 : 1;
      out += normalizeChar(text.slice(i, i + span), o);
      i += span;
    }
    return out;
  }

  /** 按行拆分（处理 \r\n / \r / \n）；空文本返回空数组 */
  function splitLines(text) {
    if (text === '') return [];
    return text.split(/\r\n|\r|\n/);
  }

  /**
   * 修整文本：清除全部空白字符——含字符串内部空格、全角空格、换行符、制表符与空行，
   * 最终所有文字整理为一行。用于"修整"功能。
   */
  function tidyText(text) {
    return String(text || '').replace(/[\s　]+/g, '');
  }

  /**
   * 字符流：返回比较流中保留的归一化字符数组。
   * 与 classifySegs 使用同一个 normalizeChar，保证映射一致。
   */
  function charStream(text, o) {
    var kept = [];
    var i = 0;
    while (i < text.length) {
      var code = text.codePointAt(i);
      var span = code > 0xFFFF ? 2 : 1;
      var norm = normalizeChar(text.slice(i, i + span), o);
      if (norm !== '') kept.push(norm);
      i += span;
    }
    return kept;
  }

  /**
   * 将 diff 得到的逐字符类别（平行于 charStream 的 kept）映射回原文，得到渲染片段。
   * seg: { text, cls }，cls ∈ 'eq' | 'rm' | 'ad'
   */
  function classifySegs(text, clsStream, o) {
    var segs = [];
    var k = 0;
    var i = 0;
    var cur = null;
    while (i < text.length) {
      var code = text.codePointAt(i);
      var span = code > 0xFFFF ? 2 : 1;
      var ch = text.slice(i, i + span);
      var norm = normalizeChar(ch, o);
      var cls = norm === '' ? 'eq' : (k < clsStream.length ? clsStream[k] : 'eq');
      if (norm !== '') k++;
      if (cur && cur.cls === cls) {
        cur.text += ch;
      } else {
        cur = { text: ch, cls: cls };
        segs.push(cur);
      }
      i += span;
    }
    return segs;
  }

  return {
    PUNCT_SET: PUNCT_SET,
    normalizeChar: normalizeChar,
    normalizeLine: normalizeLine,
    splitLines: splitLines,
    tidyText: tidyText,
    charStream: charStream,
    classifySegs: classifySegs
  };
});