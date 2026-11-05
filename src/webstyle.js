/**
 * webstyle.js —— 原稿样式解析与比对（纯文本，不依赖 DOM / 浏览器）。
 *
 * 要回答的问题只有一个：**这份 docx 有没有真正把原稿版式还原出来。**
 * 而"网页上看起来的样子"不能当基准——政务站点是「Word 粘进富文本编辑器」发布的，
 * 编辑器把 ``font-size:10pt`` 写成 ``:10pt``（键名被吞）、行距写成 ``l=:150%``、
 * 字体散在 ``<font face>`` 上。浏览器把这些坏声明全丢掉，整篇压成同一个字号，
 * 所以**照浏览器计算值比，等于要求 docx 复刻一个已经坏掉的版式**。
 * 这里按「就近祖先优先」自行级联，把作者当年真写下的字号/字体/上下标取回来当基准。
 *
 * 两侧统一到同一个形状（段落指纹），才能直接对：
 *   htmlVectors(markup)                 网页原文 → 段落指纹（级联 inline style 与 <font>）
 *   docxVectors(documentXml, stylesXml) docx 的 OOXML → 段落指纹（含样式表继承链）
 *   specVectors(spec, source)           「期望样式表」覆盖原稿声明 → 自定义基准
 *   compareVectors(actual, expected)    逐段逐属性比，差异可定位到段落号
 *
 * 全局暴露 WebStyle；Node（测试与无头通道）走 module.exports，同一份代码。
 *
 * 段落指纹 shape：
 *   { i, kind:'p'|'table', text, align, indentIn, lineSpacing,
 *     sizePt, family, latin, boldRuns, italicRuns, supChars, subChars, runs:[...] }
 * sizePt/family/latin 取**按字符数加权的众数**：一段里混排 10pt 正文与 9pt 上标是常态，
 * 取众数才不会被个别 run 带偏；个别 run 的偏差由 runs 明细承担。
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- 值解析
  var SIZE_RE = /^(\d+(?:\.\d+)?)\s*(pt|px)$/i;
  var LEN_RE = /^(-?\d+(?:\.\d+)?)\s*(in|pt|px|cm|mm)$/i;
  var HEX_RE = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
  var PCT_RE = /^(\d+(?:\.\d+)?)\s*%$/;

  var CJK_FAMILIES = ['宋体', '黑体', '楷体', '仿宋', '等线', '微软雅黑', '雅黑', '新宋体',
    '方正', '华文', '幼圆', '隶书', '舒体', '行楷', 'SimSun', 'SimHei', 'NSimSun', 'FangSong', 'KaiTi'];
  var LATIN_FAMILIES = ['times', 'arial', 'calibri', 'cambria', 'verdana', 'helvetica',
    'georgia', 'courier', 'tahoma', 'segoe', 'consolas'];

  /** Word 导出的 ``<font size="n">`` 对应字号（pt）；样式里带 pt 时以样式为准 */
  var FONT_SIZE_ATTR = { 1: 8, 2: 10, 3: 12, 4: 14, 5: 18, 6: 22, 7: 24 };

  function toPt(value) {
    var m = SIZE_RE.exec(String(value == null ? '' : value).trim());
    if (!m) return null;
    var n = parseFloat(m[1]);
    return Math.round(n * (m[2].toLowerCase() === 'px' ? 0.75 : 1) * 100) / 100;
  }

  function toInches(value) {
    var m = LEN_RE.exec(String(value == null ? '' : value).trim());
    if (!m) return null;
    var n = parseFloat(m[1]);
    var factor = { in: 1, pt: 1 / 72, px: 1 / 96, cm: 1 / 2.54, mm: 1 / 25.4 }[m[2].toLowerCase()];
    return Math.round(n * factor * 10000) / 10000;
  }

  /** ``150%`` / ``1.5`` → 倍数行距；``24pt`` 这类绝对行距不换算（返回 null，不参与比对） */
  function lineSpacingOf(value) {
    var s = String(value == null ? '' : value).trim().toLowerCase();
    if (!s) return null;
    var pct = PCT_RE.exec(s);
    if (pct) return Math.round(parseFloat(pct[1]) * 10) / 1000;
    var n = parseFloat(s);
    return (!isNaN(n) && n > 0 && n <= 10) ? Math.round(n * 1000) / 1000 : null;
  }

  function hexColor(value) {
    var m = HEX_RE.exec(String(value == null ? '' : value).trim());
    if (!m) return null;
    var digits = m[1];
    if (digits.length === 3) digits = digits.split('').map(function (c) { return c + c; }).join('');
    return digits.toUpperCase();
  }

  /** ``font-family`` 列表 → 中文族与西文族各一个（回退项丢掉；未知族按中文处理） */
  function pickFamily(value) {
    var cjk = null, latin = null;
    String(value || '').split(',').forEach(function (raw) {
      var name = raw.trim().replace(/^['"]|['"]$/g, '');
      if (!name) return;
      var low = name.toLowerCase();
      if (CJK_FAMILIES.some(function (h) { return name.indexOf(h) >= 0 || low.indexOf(h.toLowerCase()) >= 0; })) {
        if (!cjk) cjk = name;
      } else if (LATIN_FAMILIES.some(function (h) { return low.indexOf(h) >= 0; })) {
        if (!latin) latin = name;
      } else if (low !== 'serif' && low !== 'sans-serif' && low !== 'monospace' && !cjk) {
        cjk = name;
      }
    });
    return { cjk: cjk, latin: latin };
  }

  /**
   * 拆 ``style`` 属性。键名被吞的声明（``:10pt``）收进 sizePt 提示，
   * 行距的坏键 ``l=`` 归一到 lineHeight——这两条是本模块存在的理由。
   */
  function parseDecls(style) {
    var decls = {}, hints = [];
    String(style || '').split(';').forEach(function (part) {
      var at = part.indexOf(':');
      if (at < 0) return;
      var key = part.slice(0, at).trim().toLowerCase();
      var value = part.slice(at + 1).trim();
      if (!value) return;
      if (!key) {
        var pt = toPt(value);
        if (pt != null) hints.push(pt);
        return;
      }
      if (key === 'l=' || key === 'line-height') decls.lineHeight = value;
      else decls[key] = value;
    });
    if (hints.length) decls.sizePt = hints[hints.length - 1];
    return decls;
  }

  // ---------------------------------------------------------------- 轻节点
  // 标签名**保留原样大小写**：HTML 侧不区分（查表时统一转小写），
  // 而 OOXML 区分——w:rPr / w:pPr / w:eastAsia / w:firstLineChars 转成小写就全读不到。
  var VOID_TAGS = { br: 1, img: 1, hr: 1, input: 1, col: 1, meta: 1, link: 1, base: 1 };
  var SKIP_CONTENT = { script: 1, style: 1, textarea: 1, noscript: 1 };
  var ENTITIES = { nbsp: '\u00a0', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", middot: '·', times: '×' };

  function decodeEntities(text) {
    return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, function (all, body) {
      if (body.charAt(0) === '#') {
        var code = body.charAt(1) === 'x' || body.charAt(1) === 'X'
          ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        return (code > 0 && code < 0x110000) ? String.fromCodePoint(code) : all;
      }
      var key = body.toLowerCase();
      return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : all;
    });
  }

  var TAG_RE = /<(\/?)([a-zA-Z_][\w:.-]*)((?:\s+[^>]*?)?)(\/?)>/g;
  var ATTR_RE = /([a-zA-Z_][\w:.-]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

  function parseAttrs(raw) {
    var attrs = {}, m;
    ATTR_RE.lastIndex = 0;
    while ((m = ATTR_RE.exec(String(raw || '')))) {
      var value = m[3] != null ? m[3] : (m[4] != null ? m[4] : (m[5] != null ? m[5] : ''));
      attrs[m[1]] = decodeEntities(value);
    }
    return attrs;
  }

  /**
   * 容错轻节点解析器 → ``{tag, attrs, children}``（文本节点 ``{tag:'#text', text}``）。
   * 为什么不用浏览器 DOMParser：① 样式比对要在 Node 测试与无头通道跑同一份代码；
   * ② 浏览器会"修正"坏声明与未闭合标签，原文形状拿不回来；③ OOXML 也不归 DOMParser 管。
   * 未闭合标签按栈回退（政务页面的 HTML 常年不闭合），``<!…>`` 壳一律跳过。
   */
  function parseLight(markup) {
    // 先剥掉注释与 CDATA：``<!-- … -->`` 里的内容不是正文。
    // 不剥会被当成普通文本节点收进来（政务页面的正文容器里就夹着模板注释），
    // 于是多出一个假段落、把后面全部段落序号整体抹一位——比对里序号错位比漏一段更难查。
    var source = String(markup == null ? '' : markup)
      .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
      .replace(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g, '');
    var tree = { tag: '#root', attrs: {}, children: [] };
    var stack = [tree];
    var pos = 0, m;
    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(source))) {
      var plain = source.slice(pos, m.index);
      if (plain) {
        var text = decodeEntities(plain);
        if (text) stack[stack.length - 1].children.push({ tag: '#text', text: text, attrs: {}, children: [] });
      }
      pos = TAG_RE.lastIndex;
      var tag = m[2];
      if (tag.charAt(0) === '!') continue;                 // DOCTYPE / 注释 / CDATA 的壳
      var closing = m[1] === '/', selfClose = m[4] === '/';
      var lower = tag.toLowerCase();
      if (closing) {
        for (var k = stack.length - 1; k > 0; k--) {
          var name = stack[k].tag, matched = name === tag ||
            (name.indexOf('w:') !== 0 && name.toLowerCase() === lower);   // XML 严格同形，HTML 忽略大小写
          if (matched) { stack.length = k; break; }
        }
        continue;
      }
      var node = { tag: tag, attrs: parseAttrs(m[3]), children: [] };
      stack[stack.length - 1].children.push(node);
      if (!selfClose && !VOID_TAGS[lower]) stack.push(node);
    }
    var tail = source.slice(pos);
    if (tail) tree.children.push({ tag: '#text', text: decodeEntities(tail), attrs: {}, children: [] });
    return tree;
  }

  /** HTML 侧属性查询：忽略大小写（OOXML 侧直接用 attrs['w:xxx'] 精确取） */
  function attrOf(node, name) {
    var attrs = node.attrs || {};
    if (attrs[name] !== undefined) return attrs[name];
    var low = String(name).toLowerCase();
    if (attrs[low] !== undefined) return attrs[low];
    var keys = Object.keys(attrs);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].toLowerCase() === low) return attrs[keys[i]];
    }
    return undefined;
  }

  function tagOf(node) { return String(node.tag || '').toLowerCase(); }

  // ---------------------------------------------------------------- 级联（HTML）
  var ALIGN_SET = { left: 1, center: 1, right: 1, justify: 1 };
  var BASE_PROPS = { family: null, latin: null, sizePt: null, bold: null,
    italic: null, sup: false, sub: false, underline: null, color: null };

  function cascadeProps(props, node) {
    var out = {
      family: props.family, latin: props.latin, sizePt: props.sizePt,
      bold: props.bold, italic: props.italic, sup: props.sup, sub: props.sub,
      underline: props.underline, color: props.color
    };
    var tag = tagOf(node);
    if (tag === 'b' || tag === 'strong') out.bold = true;
    else if (tag === 'i' || tag === 'em') out.italic = true;
    else if (tag === 'u') out.underline = true;
    else if (tag === 'sup') out.sup = true;
    else if (tag === 'sub') out.sub = true;
    if (tag === 'font') {
      var face = attrOf(node, 'face');
      if (face) {
        var fam = pickFamily(face);
        if (fam.cjk) out.family = fam.cjk;
        if (fam.latin) out.latin = fam.latin;
      }
      var colorAttr = attrOf(node, 'color');
      if (colorAttr) out.color = hexColor(colorAttr) || out.color;
      var sizeAttr = String(attrOf(node, 's') || attrOf(node, 'size') || '').trim();
      if (/^\d$/.test(sizeAttr) && FONT_SIZE_ATTR[+sizeAttr] != null) out.sizePt = FONT_SIZE_ATTR[+sizeAttr];
    }
    var decls = parseDecls(attrOf(node, 'style'));
    Object.keys(decls).forEach(function (key) {
      var value = decls[key], low = String(value).toLowerCase();
      if (key === 'font-family') {
        var fam2 = pickFamily(value);
        if (fam2.cjk) out.family = fam2.cjk;
        if (fam2.latin) out.latin = fam2.latin;
      } else if (key === 'font-size' || key === 'sizePt') {
        var pt = key === 'sizePt' ? value : toPt(value);
        if (pt != null) out.sizePt = parseFloat(pt);
      } else if (key === 'font-weight') {
        out.bold = low === 'bold' || low === 'bolder' || (/^\d+$/.test(low) && +low >= 600);
      } else if (key === 'font-style') {
        out.italic = low === 'italic' || low === 'oblique';
      } else if (key === 'color') {
        var hex = hexColor(value);
        if (hex) out.color = hex;
      } else if (key === 'text-decoration') {
        out.underline = low.indexOf('underline') >= 0;
      }
    });
    return out;
  }

  /** 源码里的换行不是排版换行（HTML 会压成空格），统一成一个空格 */
  function collapseWhitespace(text) {
    return String(text == null ? '' : text).replace(/[ \t\r\n\u00a0]+/g, ' ');
  }

  function runOf(text, props) {
    return { text: text, family: props.family, latin: props.latin, sizePt: props.sizePt,
      bold: props.bold, italic: props.italic, sup: props.sup, sub: props.sub,
      underline: props.underline, color: props.color };
  }

  function collectRuns(node, props, runs) {
    (node.children || []).forEach(function (child) {
      if (child.tag === '#text') {
        var text = collapseWhitespace(child.text);
        if (text) runs.push(runOf(text, props));
        return;
      }
      var tag = tagOf(child);
      if (SKIP_CONTENT[tag]) return;
      if (tag === 'br') { runs.push(runOf('\n', props)); return; }
      if (tag === 'img' || tag === 'hr' || tag === 'input') return;
      collectRuns(child, cascadeProps(props, child), runs);
    });
    return runs;
  }

  function sameStyle(a, b) {
    return a.family === b.family && a.latin === b.latin && a.sizePt === b.sizePt &&
      !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.sup === !!b.sup &&
      !!a.sub === !!b.sub && !!a.underline === !!b.underline && a.color === b.color;
  }

  function mergeRuns(runs) {
    var out = [];
    runs.forEach(function (run) {
      if (!run.text) return;
      var last = out[out.length - 1];
      if (last && sameStyle(last, run)) last.text += run.text;
      else out.push(runOf(run.text, run));
    });
    return out;
  }

  function trimRuns(runs) {
    var out = runs.slice();
    while (out.length && !out[0].text.trim()) out.shift();
    while (out.length && !out[out.length - 1].text.trim()) out.pop();
    if (out.length) {
      out[0] = Object.assign({}, out[0], { text: out[0].text.replace(/^[ \u00a0]+/, '') });
      var lastIdx = out.length - 1;
      out[lastIdx] = Object.assign({}, out[lastIdx], { text: out[lastIdx].text.replace(/[ \u00a0]+$/, '') });
    }
    return out.filter(function (r) { return r.text; });
  }

  function paragraphProps(node, inherited) {
    var decls = parseDecls(attrOf(node, 'style'));
    var align = decls['text-align'] || String(attrOf(node, 'align') || '').toLowerCase() || null;
    if (align && !ALIGN_SET[align]) align = null;
    if (!align) align = (inherited && inherited.align) || null;
    return {
      align: align,
      indentIn: decls['text-indent'] != null ? toInches(decls['text-indent'])
        : (inherited ? inherited.indentIn : null),
      lineSpacing: lineSpacingOf(decls.lineHeight != null ? decls.lineHeight : (inherited && inherited.lineSpacing))
    };
  }

  // ---------------------------------------------------------------- 段落指纹
  /** 按字符数加权的众数（null 不计入）；全为 null 返回 null */
  function modeByChars(runs, pick) {
    var tally = {}, best = null, bestWeight = -1;
    runs.forEach(function (run) {
      var value = pick(run);
      if (value == null) return;
      var weight = (run.text || '').length;
      tally[value] = (tally[value] || 0) + weight;
      if (tally[value] > bestWeight) { bestWeight = tally[value]; best = value; }
    });
    return best;
  }

  function fingerprint(kind, text, props, runs) {
    return {
      kind: kind,
      text: text,
      align: props.align || null,
      indentIn: props.indentIn == null ? null : props.indentIn,
      indentChars: props.indentChars == null ? null : props.indentChars,
      lineSpacing: props.lineSpacing == null ? null : props.lineSpacing,
      sizePt: modeByChars(runs, function (r) { return r.sizePt; }),
      family: modeByChars(runs, function (r) { return r.family; }),
      latin: modeByChars(runs, function (r) { return r.latin; }),
      boldRuns: runs.filter(function (r) { return r.bold; }).length,
      italicRuns: runs.filter(function (r) { return r.italic; }).length,
      supChars: runs.reduce(function (n, r) { return n + (r.sup ? r.text.length : 0); }, 0),
      subChars: runs.reduce(function (n, r) { return n + (r.sub ? r.text.length : 0); }, 0),
      runs: runs
    };
  }

  function makeFingerprint(kind, runs, para) {
    var text = runs.map(function (r) { return r.text; }).join('');
    if (!text.trim()) return null;
    return fingerprint(kind, text, para || {}, runs);
  }

  var BLOCK_TAGS = { p: 1, h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, div: 1,
    center: 1, blockquote: 1, li: 1, section: 1, article: 1, pre: 1, figure: 1 };

  function findById(node, id) {
    if (node.tag !== '#text' && String(attrOf(node, 'id') || '') === id) return node;
    var found = null;
    (node.children || []).some(function (child) {
      if (child.tag === '#text') return false;
      found = findById(child, id);
      return !!found;
    });
    return found;
  }

  /**
   * HTML 原文 → 段落指纹序列。
   * ``containerId`` 只取某个容器的正文（政务站点把正文放在 ``content_zw``），
   * 外面的面包屑、字体按钮、分享打印一律不进向量——它们不属于标准。
   */
  function htmlVectors(markup, opts) {
    var options = opts || {};
    var tree = parseLight(markup);
    var root_ = (options.containerId && findById(tree, options.containerId)) ||
      findById(tree, 'content') || tree;
    var out = [];
    walkHtml(root_, BASE_PROPS, null, out, options.keepEmpty === true);
    out.forEach(function (fp, i) { fp.i = i; });
    return out;
  }

  function walkHtml(node, props, blockProps, out, keepEmpty) {
    var loose = [];
    function flush() {
      if (!loose.length) { loose = []; return; }
      var fp = makeFingerprint('p', trimRuns(mergeRuns(loose)), blockProps);
      if (fp) out.push(fp);
      loose = [];
    }
    (node.children || []).forEach(function (child) {
      if (child.tag === '#text') {
        var text = collapseWhitespace(child.text);
        if (text.trim()) loose.push(runOf(text, props));
        return;
      }
      var tag = tagOf(child);
      if (SKIP_CONTENT[tag]) return;
      if (tag === 'table') {
        flush();
        tableVectors(child, props, out, keepEmpty);
        return;
      }
      if (BLOCK_TAGS[tag]) {
        flush();
        var childProps = cascadeProps(props, child);
        var para = paragraphProps(child, blockProps);
        if (tag === 'center') para.align = 'center';
        var hasBlock = (child.children || []).some(function (grand) {
          return grand.tag !== '#text' && (BLOCK_TAGS[tagOf(grand)] || tagOf(grand) === 'table');
        });
        if (hasBlock) { walkHtml(child, childProps, para, out, keepEmpty); return; }
        var fp = makeFingerprint('p', trimRuns(mergeRuns(collectRuns(child, childProps, []))), para);
        if (fp) out.push(fp);
        return;
      }
      if (tag === 'br') { loose.push(runOf('\n', props)); return; }
      collectRuns(child, props, loose);
    });
    flush();
  }

  /** 表格：每个单元格当一个"段落"进向量（kind:'table'），比对时按单元格文本对齐 */
  function tableVectors(table, props, out, keepEmpty) {
    var rows = [];
    (function collect(node) {
      (node.children || []).forEach(function (child) {
        if (child.tag === '#text') return;
        var tag = tagOf(child);
        if (tag === 'tr') rows.push(child);
        else if (tag === 'tbody' || tag === 'thead' || tag === 'tfoot') collect(child);
      });
    })(table);
    rows.forEach(function (tr) {
      (tr.children || []).forEach(function (td) {
        var tag = tagOf(td);
        if (tag !== 'td' && tag !== 'th') return;
        var runs = trimRuns(mergeRuns(collectRuns(td, props, [])));
        if (!keepEmpty && !runs.length) return;
        var fp = makeFingerprint('table', runs, { align: 'center', indentIn: 0, lineSpacing: 1 });
        if (fp) out.push(fp);
      });
    });
  }

  // ---------------------------------------------------------------- docx 侧
  function OO(tag) { return 'w:' + tag; }

  function eachDescendant(node, tag, fn) {
    (node.children || []).forEach(function (child) {
      if (child.tag === '#text') return;
      if (child.tag === tag) fn(child);
      eachDescendant(child, tag, fn);
    });
  }

  function on(node, tag) {
    var children = node.children || [];
    for (var i = 0; i < children.length; i++) {
      if (children[i].tag === tag) return children[i];
    }
    return null;
  }

  function valOf(node, tag) {
    var found = on(node, tag);
    return found ? found.attrs[OO('val')] : undefined;
  }

  /** 从 ``w:rPr``（或直接在 rPr 节点上）读字符属性 */
  function readDocxRpr(container, target) {
    var rpr = tagOf(container) === 'w:rpr' ? container : on(container, OO('rPr'));
    if (!rpr) return;
    var fonts = on(rpr, OO('rFonts'));
    if (fonts) {
      if (fonts.attrs[OO('eastAsia')]) target.family = fonts.attrs[OO('eastAsia')];
      var ascii = fonts.attrs[OO('ascii')] || fonts.attrs[OO('hAnsi')];
      if (ascii) target.latin = ascii;
    }
    var sz = valOf(rpr, OO('sz'));
    if (sz != null && /^\d+$/.test(sz)) target.sizePt = parseInt(sz, 10) / 2;
    var b = valOf(rpr, OO('b'));
    if (b !== undefined) target.bold = b !== '0' && b !== 'false';
    else if (on(rpr, OO('b'))) target.bold = true;
    var i = valOf(rpr, OO('i'));
    if (i !== undefined) target.italic = i !== '0' && i !== 'false';
    else if (on(rpr, OO('i'))) target.italic = true;
    var vert = valOf(rpr, OO('vertAlign'));
    if (vert === 'superscript') target.sup = true;
    else if (vert === 'subscript') target.sub = true;
    var color = valOf(rpr, OO('color'));
    if (color) target.color = String(color).toUpperCase();
  }

  function readDocxPpr(ppr, target) {
    var jc = valOf(ppr, OO('jc'));
    if (jc) target.align = jc === 'both' ? 'justify' : jc;
    var ind = on(ppr, OO('ind'));
    if (ind) {
      var chars = ind.attrs[OO('firstLineChars')];
      var twips = ind.attrs[OO('firstLine')];
      if (chars != null && +chars > 0) target.indentChars = Math.round(+chars) / 100;
      else if (twips != null) target.indentIn = Math.round((+twips / 1440) * 10000) / 10000;
    }
    var spacing = on(ppr, OO('spacing'));
    if (spacing) {
      var line = spacing.attrs[OO('line')];
      if (line != null && +line > 0) target.lineSpacing = Math.round((+line / 240) * 1000) / 1000;
    }
  }

  /** styles.xml → {styleId: 属性}，用于补齐「段落样式 / 字符样式继承」 */
  function parseDocxStyles(stylesXml) {
    var map = {};
    if (!stylesXml) return map;
    eachDescendant(parseLight(stylesXml), OO('style'), function (node) {
      var id = node.attrs[OO('styleId')];
      if (!id) return;
      var entry = { basedOn: null, family: null, latin: null, sizePt: null, bold: null,
        italic: null, sup: false, sub: false, color: null, align: null,
        indentIn: null, indentChars: null, lineSpacing: null };
      entry.basedOn = valOf(node, OO('basedOn')) || null;
      readDocxRpr(node, entry);
      var ppr = on(node, OO('pPr'));
      if (ppr) readDocxPpr(ppr, entry);
      map[id] = entry;
    });
    return map;
  }

  function resolveStyle(map, id, depth) {
    if (!map || !map[id] || (depth || 0) > 8) return {};
    var own = map[id];
    var base = own.basedOn ? resolveStyle(map, own.basedOn, (depth || 0) + 1) : {};
    var merged = Object.assign({}, base);
    Object.keys(own).forEach(function (key) {
      if (key === 'basedOn') return;
      if (own[key] != null && own[key] !== false) merged[key] = own[key];
    });
    return merged;
  }

  /**
   * docx 的 ``word/document.xml``（+ 可选 ``word/styles.xml``）→ 段落指纹序列。
   * 与 HTML 侧同形状才能直接 compareVectors。
   * 样式表继承链在这里补齐：比对要看的是**最终生效值**，
   * 漏掉继承会把「样式表里已设 10pt」误判成"没设"。
   */
  function docxVectors(documentXml, stylesXml) {
    var styles = parseDocxStyles(stylesXml);
    var defaults = resolveStyle(styles, 'Normal');
    var out = [];
    eachDescendant(parseLight(documentXml), OO('p'), function (p) {
      var ppr = on(p, OO('pPr'));
      var para = { align: null, indentIn: null, indentChars: null, lineSpacing: null };
      var styleId = ppr && valOf(ppr, OO('pStyle'));
      var fromStyle = styleId && styles[styleId] ? resolveStyle(styles, styleId) : defaults;
      Object.keys(fromStyle || {}).forEach(function (key) {
        if (para[key] == null && (key === 'align' || key === 'indentIn' || key === 'indentChars' || key === 'lineSpacing')) {
          para[key] = fromStyle[key];
        }
      });
      if (ppr) readDocxPpr(ppr, para);
      var runs = [];
      (p.children || []).forEach(function (child) {
        if (child.tag !== OO('r')) return;
        var props = Object.assign({}, BASE_PROPS, {
          family: fromStyle && fromStyle.family, latin: fromStyle && fromStyle.latin,
          sizePt: fromStyle && fromStyle.sizePt, bold: fromStyle && fromStyle.bold,
          italic: fromStyle && fromStyle.italic, color: fromStyle && fromStyle.color
        });
        readDocxRpr(child, props);
        var text = '';
        (child.children || []).forEach(function (piece) {
          if (piece.tag === OO('t')) text += pieceText(piece);
          else if (piece.tag === OO('tab')) text += '\t';
          else if (piece.tag === OO('br')) text += '\n';
        });
        if (text) runs.push(runOf(text, props));
      });
      var fp = makeFingerprint('p', trimRuns(mergeRuns(runs)), para);
      if (fp) out.push(fp);
    });
    out.forEach(function (fp, i) { fp.i = i; });
    return out;
  }

  function pieceText(node) {
    var text = '';
    (node.children || []).forEach(function (child) {
      if (child.tag === '#text') text += child.text;
    });
    return text;
  }

  // ---------------------------------------------------------------- 期望样式表
  /**
   * 期望样式表 → 基准向量（覆盖在原稿声明之上）。
   *
   * spec = {
   *   name: '我司口径',
   *   defaults: { sizePt, family, latin, align, indentIn, indentChars, lineSpacing },
   *   rules: [ { match: { textStarts, textIncludes, textNotIncludes, kind, index, align, sizeLt },
   *              set:   { sizePt, family, latin, align, indentIn, indentChars, lineSpacing } } ]
   * }
   * 规则按顺序命中、后覆盖前；表里没写的属性退回原稿声明——
   * 期望表表达的是"我司口径"，不是用来抹掉原稿信息的。
   */
  function specVectors(spec, sourceVectors) {
    var defaults = (spec && spec.defaults) || {};
    var rules = (spec && spec.rules) || [];
    return (sourceVectors || []).map(function (fp) {
      var merged = Object.assign({}, fp);
      Object.keys(defaults).forEach(function (key) {
        if (merged[key] == null) merged[key] = defaults[key];
      });
      rules.forEach(function (rule) {
        if (!matchesRule(rule.match, merged)) return;
        Object.keys(rule.set || {}).forEach(function (key) { merged[key] = rule.set[key]; });
      });
      return merged;
    });
  }

  function matchesRule(match, fp) {
    if (!match) return true;
    var text = String(fp.text || '');
    if (match.kind && match.kind !== fp.kind) return false;
    if (match.align && match.align !== (fp.align || null)) return false;
    if (match.index != null && match.index !== fp.i) return false;
    if (match.textStarts && text.indexOf(match.textStarts) !== 0) return false;
    if (match.textIncludes && text.indexOf(match.textIncludes) < 0) return false;
    if (match.textNotIncludes && text.indexOf(match.textNotIncludes) >= 0) return false;
    if (match.sizeLt != null && !(fp.sizePt != null && fp.sizePt < match.sizeLt)) return false;
    return true;
  }

  // ---------------------------------------------------------------- 比对
  var TOLERANCE = { sizePt: 0.26, indentIn: 0.03, lineSpacing: 0.06 };

  var PROP_LABELS = {
    sizePt: '字号', family: '中文字体', latin: '西文字体', align: '对齐',
    indentIn: '首行缩进', lineSpacing: '行距',
    supChars: '上标字数', subChars: '下标字数', italicRuns: '斜体片段', boldRuns: '加粗片段'
  };

  var DEFAULT_PROPS = ['sizePt', 'family', 'align', 'indentIn', 'lineSpacing',
    'supChars', 'subChars', 'italicRuns'];

  function near(a, b, key) {
    if (a == null || b == null) return a === b;
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= (TOLERANCE[key] || 0);
    return String(a).toLowerCase() === String(b).toLowerCase();
  }

  function fmt(key, value) {
    if (value == null) return '未设置';
    if (key === 'sizePt') return value + 'pt';
    if (key === 'indentIn') return value + 'in';
    if (key === 'indentChars') return value + '字符';
    if (key === 'lineSpacing') return value + ' 倍';
    return String(value);
  }

  function brief(text) {
    var s = String(text || '').replace(/\s+/g, ' ').trim();
    return s.length > 34 ? s.slice(0, 34) + '…' : s;
  }

  /**
   * 缩进统一折算成**物理英寸**再比。
   * 为什么不按"字符"比：字符数 = 英寸 / 字号，字号一旦不同（正是我们要抓的错误），
   * 同一个物理缩进会被算成不同字符数，于是一处字号错误报出两条差异——
   * 而"2 字符"这种写法（docx 的 firstLineChars）按它自己的字号折回英寸，仍然可比。
   * 没写缩进 = 不缩进，与显式 0 同义（网页表格单元格写 0、docx 干脆不写 ind）。
   */
  function indentAsInches(fp) {
    if (fp.indentIn != null) return fp.indentIn;
    if (fp.indentChars != null) return Math.round(fp.indentChars * (fp.sizePt || 10) / 72 * 10000) / 10000;
    return 0;
  }

  /** 该侧到底声明过缩进没有（网页表格单元格写 0、docx 不写 ind，两者语义相同） */
  function indentDeclared(fp) {
    return fp.indentIn != null || fp.indentChars != null;
  }

  /**
   * 逐段逐属性比对 → 差异列表。
   * 段落对齐按**文本**（不是序号）：两侧段落数不等时（网页空段被丢、docx 多了页脚），
   * 按序号比会把"从某处起整体错位"误报成"每段都有版式问题"。
   * 只比「原稿声明过的属性」：没声明就无权要求，否则会把大量正常的默认值报成差异。
   * 原稿没写但 docx 写了的属性计入 undeclared（提醒，不算差异）。
   */
  function compareVectors(actual, expected, opts) {
    var options = opts || {};
    var props = options.props || DEFAULT_PROPS;
    var pairs = alignByParagraphs(actual, expected);
    var diffs = [], undeclared = 0;
    pairs.forEach(function (pair) {
      var a = pair.a, e = pair.b;
      if (!a || !e) return;
      props.forEach(function (key) {
        if (key === 'indentIn') {
          if (!indentDeclared(e)) return;             // 原稿没声明缩进 → 本次不作要求
          var aIn = indentAsInches(a), eIn = indentAsInches(e);
          if (!near(aIn, eIn, 'indentIn')) {
            diffs.push({ para: a.i, text: brief(a.text), prop: PROP_LABELS.indentIn,
              expect: fmt('indentIn', eIn), actual: fmt('indentIn', aIn) });
          }
          return;
        }
        // 判定基准是「原稿声明」：原稿没写这个属性就是没要求，docx 写什么都不算错；
        // 反过来（原稿写了、docx 没写）必须报——那正是「没还原」。
        if (e[key] == null) {
          if (a[key] != null && (key === 'sizePt' || key === 'family')) undeclared++;
          return;
        }
        if (!near(a[key], e[key], key)) {
          diffs.push({ para: a.i, text: brief(a.text), prop: PROP_LABELS[key] || key,
            expect: fmt(key, e[key]), actual: fmt(key, a[key]) });
        }
      });
    });
    return {
      diffs: diffs,
      undeclared: undeclared,
      aligned: pairs.filter(function (p) { return p.a && p.b; }).length,
      onlyActual: pairs.filter(function (p) { return p.a && !p.b; }).length,
      onlyExpected: pairs.filter(function (p) { return !p.a && p.b; }).length
    };
  }

  /** 段落对齐：逐条相等走快路径，否则 diffArrays；没有 diff 库时退回最长公共子序列 */
  function alignByParagraphs(a, b) {
    var ta = a.map(function (fp) { return fp.text; }), tb = b.map(function (fp) { return fp.text; });
    var pairs = [], i;
    if (ta.length === tb.length) {
      var same = true;
      for (i = 0; i < ta.length; i++) { if (ta[i] !== tb[i]) { same = false; break; } }
      if (same) { for (i = 0; i < ta.length; i++) pairs.push({ a: a[i], b: b[i] }); return pairs; }
    }
    var D = root.Diff || root.diff || null;
    if (!D || !D.diffArrays) return lcsPairs(a, b, ta, tb);
    var ops = D.diffArrays(ta, tb), x = 0, y = 0;
    ops.forEach(function (op) {
      var len = op.value.length, j;
      if (op.added) { for (j = 0; j < len; j++) pairs.push({ a: null, b: b[y + j] }); y += len; return; }
      if (op.removed) { for (j = 0; j < len; j++) pairs.push({ a: a[x + j], b: null }); x += len; return; }
      for (j = 0; j < len; j++) pairs.push({ a: a[x + j], b: b[y + j] });
      x += len; y += len;
    });
    return pairs;
  }

  function lcsPairs(a, b, ta, tb) {
    var n = ta.length, m = tb.length, dp = [], i, j;
    for (i = 0; i <= n; i++) { dp[i] = []; for (j = 0; j <= m; j++) dp[i][j] = 0; }
    for (i = n - 1; i >= 0; i--) {
      for (j = m - 1; j >= 0; j--) {
        dp[i][j] = ta[i] === tb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    var out = [];
    i = 0; j = 0;
    while (i < n && j < m) {
      if (ta[i] === tb[j]) { out.push({ a: a[i], b: b[j] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ a: a[i], b: null }); i++; }
      else { out.push({ a: null, b: b[j] }); j++; }
    }
    while (i < n) { out.push({ a: a[i++], b: null }); }
    while (j < m) { out.push({ a: null, b: b[j++] }); }
    return out;
  }

  /** 指纹序列 → 纯文本（段落间 "\n\n"，与 mammoth 同构），用于喂现有文本对比管线 */
  function vectorsText(vectors) {
    return (vectors || []).map(function (fp) { return fp.text; }).join('\n\n');
  }

  function summarize(result) {
    var byProp = {};
    (result.diffs || []).forEach(function (d) { byProp[d.prop] = (byProp[d.prop] || 0) + 1; });
    return {
      total: (result.diffs || []).length,
      undeclared: result.undeclared || 0,
      aligned: result.aligned || 0,
      onlyActual: result.onlyActual || 0,
      onlyExpected: result.onlyExpected || 0,
      byProp: Object.keys(byProp).sort(function (x, y) { return byProp[y] - byProp[x]; })
        .map(function (key) { return key + '×' + byProp[key]; }).join('、')
    };
  }

  var api = {
    parseDecls: parseDecls, parseLight: parseLight, attrOf: attrOf,
    toPt: toPt, toInches: toInches, lineSpacingOf: lineSpacingOf,
    pickFamily: pickFamily, hexColor: hexColor,
    htmlVectors: htmlVectors, docxVectors: docxVectors, specVectors: specVectors,
    compareVectors: compareVectors, vectorsText: vectorsText, summarize: summarize,
    cascadeProps: cascadeProps, collectRuns: collectRuns, mergeRuns: mergeRuns,
    indentAsInches: indentAsInches, alignByParagraphs: alignByParagraphs,
    TOLERANCE: TOLERANCE, PROP_LABELS: PROP_LABELS, DEFAULT_PROPS: DEFAULT_PROPS
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WebStyle = api;
})(typeof self !== 'undefined' ? self : this);
