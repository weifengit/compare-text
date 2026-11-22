/**
 * mdrender.js —— Markdown → HTML 渲染（纯逻辑，无 DOM，浏览器 / Node 共用）。
 *
 * 定位：为 Markdown 查看器（src/mdview.js）提供排版 HTML，并保证「源码行号 ↔ 输出元素」一一对应——
 * 每个源码行都被包进一个带 data-line="N" 的 .md-line 元素，于是差异标注（行号 → DOM）与
 * 行锚定协同滚动都能直接按元素测量定位，无需逐字符几何推算。
 *
 * 为什么自己写而不引第三方库：项目完全离线、lib/ 里的库都是自打包的；主流 Markdown 库也不暴露
 * 「输出元素 ↔ 源码行号」的映射，而对比工具必须按源码行标注与滚动，自写反而更贴合契约。
 *
 * 支持的语法（常见子集）：ATX 标题、段落、粗体/斜体/行内代码/删除线、链接/图片/自动链接、
 * 围栏代码块、引用、无序/有序列表、水平线、GFM 表格。原始 HTML 一律转义，避免注入。
 *
 * 全局暴露：MdRender
 *   MdRender.render(mdText)     → { html, lineCount }
 *   MdRender.renderInline(text) → html（行内语法，供测试与复用）
 *   MdRender.splitLines(text)   → string[]（统一 CRLF/LF）
 */
(function (root) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function splitLines(text) {
    return String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  }

  // ------------------------------------------------------------------ 行内
  var ESCAPE_CHARS = '\\`*_{}[]()#+-.!~<>';

  /**
   * 行内渲染。扫描字符串，逐段识别语法；未识别的字符一律转义。
   * 转义符 `\` 只对 Markdown 语法字符生效，其余情况原样输出。
   */
  function renderInline(s) {
    var src = String(s == null ? '' : s);
    var out = '';
    var i = 0, n = src.length;

    /** 从 from 起找下一个未转义的分隔符 ch 的下标，找不到返回 -1 */
    function findDelim(from, ch) {
      var j = from;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === ch) return j;
        j++;
      }
      return -1;
    }

    while (i < n) {
      var c = src[i];

      // 转义：\ 后的语法字符原样输出
      if (c === '\\' && i + 1 < n && ESCAPE_CHARS.indexOf(src[i + 1]) >= 0) {
        out += esc(src[i + 1]); i += 2; continue;
      }

      // 行内代码：反引号串，首尾各去一个空格
      if (c === '`') {
        var cm = /^(`+)/.exec(src.slice(i));
        var fence = cm[1];
        var cend = src.indexOf(fence, i + fence.length);
        if (cend >= 0) {
          var code = src.slice(i + fence.length, cend).replace(/^ | $/g, '');
          out += '<code>' + esc(code) + '</code>';
          i = cend + fence.length;
          continue;
        }
      }

      // 图片 ![alt](src)
      if (c === '!' && src[i + 1] === '[') {
        var im = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(src.slice(i));
        if (im) {
          out += '<img src="' + esc(im[2]) + '" alt="' + esc(im[1]) + '">';
          i += im[0].length;
          continue;
        }
      }

      // 链接 [text](href)
      if (c === '[') {
        var lk = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(src.slice(i));
        if (lk) {
          out += '<a href="' + esc(lk[2]) + '" target="_blank" rel="noopener">' + renderInline(lk[1]) + '</a>';
          i += lk[0].length;
          continue;
        }
      }

      // 粗体 ** / __
      if ((c === '*' || c === '_') && src[i + 1] === c) {
        var cclose = findDelim(i + 2, c);
        if (cclose > i + 2 && src[cclose + 1] === c) {
          out += '<strong>' + renderInline(src.slice(i + 2, cclose)) + '</strong>';
          i = cclose + 2;
          continue;
        }
      }

      // 斜体 * / _（_ 要求词边界，避免 snake_case 误判）
      if (c === '*' || c === '_') {
        var cclose2 = findDelim(i + 1, c);
        if (cclose2 > i + 1 && src[cclose2 + 1] !== c) {
          var innerOk = src[i + 1] !== ' ' && src[cclose2 - 1] !== ' ';
          var boundaryOk = c === '*'
            || ((i === 0 || !/[\w]/.test(src[i - 1])) && (cclose2 + 1 >= n || !/[\w]/.test(src[cclose2 + 1])));
          if (innerOk && boundaryOk) {
            out += '<em>' + renderInline(src.slice(i + 1, cclose2)) + '</em>';
            i = cclose2 + 1;
            continue;
          }
        }
      }

      // 删除线 ~~
      if (c === '~' && src[i + 1] === '~') {
        var sd = src.indexOf('~~', i + 2);
        if (sd > i + 2) {
          out += '<del>' + renderInline(src.slice(i + 2, sd)) + '</del>';
          i = sd + 2;
          continue;
        }
      }

      // 自动链接 <https://…>
      if (c === '<') {
        var au = /^<(https?:\/\/[^>\s]+)>/.exec(src.slice(i));
        if (au) {
          out += '<a href="' + esc(au[1]) + '" target="_blank" rel="noopener">' + esc(au[1]) + '</a>';
          i += au[0].length;
          continue;
        }
      }

      out += esc(c);
      i++;
    }
    return out;
  }

  // ------------------------------------------------------------------ 块级
  function lineHtml(cls, lineNo, inner) {
    return '<div class="md-line ' + cls + '" data-line="' + lineNo + '">' + inner + '</div>';
  }

  function isBlank(l) { return /^\s*$/.test(l); }
  function isFence(l) { return /^\s*(`{3,}|~{3,})\s*[^\s`]*\s*$/.test(l); }
  function isHeading(l) { return /^#{1,6}(\s+|$)/.test(l); }
  function isHr(l) { return /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(l); }
  function isQuote(l) { return /^\s{0,3}>/.test(l); }
  function isListItem(l) { return /^\s{0,3}([-*+]|\d{1,9}[.)])\s+/.test(l); }
  function isTableRow(l) { return l.indexOf('|') >= 0; }
  function isTableSep(l) {
    if (l.indexOf('-') < 0) return false;
    return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  }
  function isBlockStart(l) {
    return isFence(l) || isHeading(l) || isHr(l) || isQuote(l) || isListItem(l);
  }

  function splitRow(row) {
    var s = String(row).trim();
    if (s.charAt(0) === '|') s = s.slice(1);
    if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
    return s.split('|').map(function (c) { return c.trim(); });
  }

  function renderTable(header, rows, startLine) {
    var thead = '<tr class="md-line md-trow" data-line="' + startLine + '">' +
      header.map(function (c) { return '<th>' + renderInline(c) + '</th>'; }).join('') + '</tr>';
    var body = rows.map(function (r, k) {
      return '<tr class="md-line md-trow" data-line="' + (startLine + 2 + k) + '">' +
        r.map(function (c) { return '<td>' + renderInline(c) + '</td>'; }).join('') + '</tr>';
    }).join('');
    return '<table class="md-table"><thead>' + thead + '</thead><tbody>' + body + '</tbody></table>';
  }

  /**
   * 渲染整篇 Markdown。
   * 返回 { html, lineCount }：html 中每个源码行都包在 .md-line[data-line=N] 里，
   * 表格行用 tr.md-line 承载（CSS 单独给 tr 还原 table-row 显示）。
   */
  function render(mdText) {
    var lines = splitLines(mdText);
    var out = [];
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];
      var lineNo = i + 1;

      if (isBlank(line)) { i++; continue; }

      // 围栏代码块
      var fence = /^\s*(`{3,}|~{3,})\s*([^\s`]*)\s*$/.exec(line);
      if (fence) {
        var marker = fence[1].charAt(0);
        var lang = fence[2] || '';
        var closeRe = new RegExp('^\\s*' + marker + '{3,}\\s*$');
        var buf = [];
        i++;
        while (i < lines.length && !closeRe.test(lines[i])) { buf.push(lines[i]); i++; }
        if (i < lines.length) i++;                       // 消费结束围栏
        var code = buf.map(function (cl, k) {
          return '<div class="md-line md-codeline" data-line="' + (lineNo + 1 + k) + '">' + esc(cl) + '</div>';
        }).join('');
        out.push('<pre class="md-pre"' + (lang ? ' data-lang="' + esc(lang) + '"' : '') + '><code>' + code + '</code></pre>');
        continue;
      }

      // ATX 标题
      var h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (h) {
        out.push(lineHtml('md-h' + h[1].length, lineNo, renderInline(h[2])));
        i++;
        continue;
      }

      // 水平线
      if (isHr(line)) {
        out.push('<div class="md-line md-hr" data-line="' + lineNo + '"></div>');
        i++;
        continue;
      }

      // 引用（> 行；允许中间夹空行，只要后面仍以 > 续）
      if (isQuote(line)) {
        var q = [];
        while (i < lines.length && (isQuote(lines[i]) || (isBlank(lines[i]) && i + 1 < lines.length && isQuote(lines[i + 1])))) {
          var qc = isQuote(lines[i]) ? lines[i].replace(/^\s{0,3}>\s?/, '') : '';
          q.push(lineHtml('md-quote', i + 1, renderInline(qc)));
          i++;
        }
        out.push('<div class="md-blockquote">' + q.join('') + '</div>');
        continue;
      }

      // 列表（含缩进续行；嵌套仅按缩进加类，不递归解析）
      if (isListItem(line)) {
        var li = [];
        while (i < lines.length && !isBlank(lines[i]) && (isListItem(lines[i]) || /^\s+\S/.test(lines[i]))) {
          var l = lines[i];
          var m = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(l);
          var indent = m ? m[1].length : 0;
          var ordered = !!(m && /\d/.test(m[2]));
          var cls = 'md-li' + (ordered ? ' md-li-ol' : '') + (indent >= 2 ? ' md-li-nested' : '');
          li.push(lineHtml(cls, i + 1, renderInline(m ? m[3] : l.trim())));
          i++;
        }
        out.push('<div class="md-list">' + li.join('') + '</div>');
        continue;
      }

      // GFM 表格：本行含 | 且下一行是分隔行
      if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        var header = splitRow(line);
        i += 2;
        var trows = [];
        while (i < lines.length && !isBlank(lines[i]) && isTableRow(lines[i])) {
          trows.push(splitRow(lines[i]));
          i++;
        }
        out.push(renderTable(header, trows, lineNo));
        continue;
      }

      // 段落：连续非空且非块级起始的行；每行一个 .md-line（行内换行按硬换行呈现）
      var para = [];
      while (i < lines.length && !isBlank(lines[i]) && !isBlockStart(lines[i])) {
        para.push(lineHtml('md-p', i + 1, renderInline(lines[i])));
        i++;
      }
      if (para.length) out.push('<div class="md-para">' + para.join('') + '</div>');
      else i++;                                            // 兜底：避免死循环
    }

    return { html: out.join('\n'), lineCount: lines.length };
  }

  root.MdRender = {
    render: render,
    renderInline: renderInline,
    splitLines: splitLines
  };
})(typeof self !== 'undefined' ? self : this);
