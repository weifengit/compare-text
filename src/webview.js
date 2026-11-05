/**
 * webview.js —— 网页查看器（第三种正文源：URL 直连 / 本地 HTML 快照）。
 *
 * 职责：把网页渲染到主区域 3 的面板（与 PdfView / DocxView 共用 #pdfLeft/#pdfRight，
 *       同侧互斥由调用方保证），并提供对比用纯文本与原稿样式向量。
 * 契约与 DocxView 同名同语义，所以 Pipeline / SyncScroll / 差异标注 / 报告快照
 * 一条都不用改——这是本模块存在的形式约束。
 *
 * 全局暴露：WebView
 *
 *   WebView.init({ left, right })
 *   WebView.load(side, html, opts) → Promise   opts={ baseUrl, containerId, token, inlineAssets, fetchText }
 *   WebView.extractText(html, opts) → Promise<string>   段落间 "\n\n"，与 mammoth 同构
 *   WebView.styleVectors(html, opts) → Array             原稿样式向量（比对基准）
 *   WebView.setSourceText(side, text) / extractPanel(side) / styleVectorsOf(side)
 *   WebView.setHighlight(side, map)   行号 → 'rm' | 'ad' | {t:'ch', segs}
 *   WebView.clear(side?) / isLoaded(side) / swap() / showError(side, msg) / fitWidth(side)
 *   WebView.lineOffset / lineAtOffset / lineHeight / nextLineOffset   行锚定协同滚动
 *
 * 四个非做不可的设计决定：
 *
 * ① **同源 iframe，而不是往宿主 div 里注 HTML**。政务站点的 CSS 全是全局选择器
 *    （``body{}``、``.article_con p{font-size:18px}``、``#content_zw p{font-family:宋体}``），
 *    注进宿主 div 会反过来把整个应用改版；iframe 天然隔离，而 srcdoc 与父页同源，
 *    提词、标注、量行位都还能直接操作 contentDocument。
 *
 * ② **iframe 高度撑到内容全高，滚动交给面板**。若 iframe 自己滚（固定高度），
 *    面板 scrollTop 恒为 0，SyncScroll 的行锚定与 render.js 的"逐片滚动截图"全部失效。
 *    撑高后面板就是唯一滚动容器，与 PDF/docx 面板完全同构。
 *
 * ③ **脚本一律剥掉**。这批页面头部有一段 UA 判断脚本会把地址改写成 ``mpost_*.html``
 *    （手机版），截图途中会跳走；jQuery 还会改 DOM，让标注偏移与渲染结果对不上。
 *    剥脚本不动版式，只去掉动效。
 *
 * ④ **外链样式默认内联**。srcdoc 里没有 origin，相对 ``/css/reset.css`` 只能靠
 *    ``<base href>`` 回站点取，离线复跑时样式全丢、版式判断随之失真。所以 load 时把
 *    ``<link rel=stylesheet>`` 逐个走注入的 fetchText 抓下来换成 ``<style>``；
 *    抓不到就退回 <base> 并在面板顶部写明"外链样式未内联"，不静默降级。
 */
(function (root) {
  'use strict';

  var panels = { L: null, R: null };
  var frames = { L: null, R: null };      // 每侧 iframe
  var docs = { L: null, R: null };        // 每侧 iframe document（渲染完成后可用）
  var markups = { L: '', R: '' };
  var optsBySide = { L: {}, R: {} };
  var texts = { L: null, R: null };       // 每侧登记原文（标注与行位的坐标系）
  var vectors = { L: null, R: null };     // 每侧样式向量
  var hlMaps = { L: {}, R: {} };
  var loadSeq = { L: 0, R: 0 };
  var posIndex = { L: null, R: null };
  var warnings = { L: [], R: [] };
  var heightTimers = { L: null, R: null };
  var heightFrozen = { L: false, R: false };   // 采集期上锁：不许再改 zoom / iframe 高度

  var W = (typeof window !== 'undefined') ? window : null;
  var HL_CSS = [
    '.web-hl-para{background:rgba(255,180,0,.22)}',
    '.web-hl-rm{background:rgba(255,90,90,.30)}',
    '.web-hl-ad{background:rgba(60,200,110,.30)}',
    'span.web-hl{border-radius:2px}',
    '.web-page-note{color:#b00;font-size:12px;margin:6px 0}'
  ].join('\n');
  var BLOCK_SELECTOR = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,td,th';

  function init(opts) {
    panels.L = opts.left || null;
    panels.R = opts.right || null;
  }

  /** WebStyle 由 src/webstyle.js 提供；延迟取，避免依赖脚本先后顺序 */
  function style() {
    if (!root.WebStyle) throw new Error('webstyle.js 未加载（WebView 依赖它做原稿样式解析）');
    return root.WebStyle;
  }

  function escHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /** 段文本归一：源码换行、连续空格都压成一个空格。DOM 段与样式向量比之前都要过这一步 */
  function collapse(text) { return String(text == null ? '' : text).replace(/\s+/g, ' ').trim(); }

  function countNl(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) if (s.charAt(i) === '\n') n++;
    return n;
  }

  /**
   * 样式向量 → 编辑器行号（第 k 段落在第几行）。
   * 与 docxview.splitParas 同一口径：向量文本之间用 "\n\n" 连接，
   * 段内 <br> 带来的换行也要计入，否则一处换行会让后面整篇标注错位。
   */
  function vectorLines(list) {
    var line = 1, out = [];
    (list || []).forEach(function (fp) {
      out.push(line);
      line += countNl(fp.text) + 2;
    });
    return out;
  }

  // ---------------------------------------------------------------- 渲染
  function clearPanel(side) {
    var p = panels[side];
    if (p) p.innerHTML = '';
    frames[side] = null;
    docs[side] = null;
    texts[side] = null;
    vectors[side] = null;
    hlMaps[side] = {};
    markups[side] = '';
    optsBySide[side] = {};
    warnings[side] = [];
    invalidatePos(side);
  }

  function clear(side) {
    if (side === 'L' || side === 'R') clearPanel(side);
    else { clearPanel('L'); clearPanel('R'); }
  }

  function isLoaded(side) { return !!docs[side]; }

  function showError(side, msg) {
    var p = panels[side];
    if (p) {
      p.innerHTML = '<div class="pdf-error">网页加载失败：' +
        escHtml(String((msg && msg.message) || msg)) + '</div>';
    }
  }

  function originOf(url) {
    try { var u = new URL(url); return u.protocol + '//' + u.host + '/'; } catch (e) { return ''; }
  }

  function cssLinks(markup) {
    var out = [], m;
    var re = /<link[^>]+rel=["']?stylesheet["']?[^>]*>/gi;
    while ((m = re.exec(markup))) {
      var href = /href=["']([^"']+)["']/i.exec(m[0]);
      if (href) out.push(href[1]);
    }
    return out;
  }

  /** 去重后的候选 base 列表：先按页面自己的 URL 解析，失败再退到站点 origin */
  function baseList(opts) {
    var out = [];
    [opts.baseUrl, opts.originBase].forEach(function (b) {
      if (b && out.indexOf(b) < 0) out.push(b);
    });
    return out;
  }

  /**
   * 逐个抓外链 CSS。半套样式也比没样式有用，所以成功的照旧内联、
   * 失败的单独记账退回 <base>，并把具体 URL 写进面板提示（不然用户只看到
   * “没样式”，分不清是整站挂了还是某一条 CDN 没抓到）。
   * 本地快照从 localhost 起，相对 ``/css/x.css`` 会先解析到 localhost；
   * 那里没有这个文件，所以再拿站点 origin 试一次。
   * 返回 { css: string[], failed: string[] }；fetchText 不可用时返回 null（完全没试过）。
   */
  function fetchAssets(markup, bases, fetchText) {
    var links = cssLinks(markup);
    if (!links.length || typeof fetchText !== 'function' || !bases.length) {
      return Promise.resolve(null);
    }
    return Promise.all(links.map(function (href) {
      function grab(i) {
        var abs;
        try { abs = new URL(href, bases[i]).href; } catch (e) { return Promise.reject(); }
        return Promise.resolve(fetchText(abs)).then(function (text) {
          if (!String(text || '')) throw new Error('empty');
          return text;
        });
      }
      var chain = grab(0);
      for (var i = 1; i < bases.length; i++) (function (k) {
        chain = chain.catch(function () { return grab(k); });
      })(i);
      return chain.then(function (text) {
        return { css: String(text), failed: '' };
      }, function () {
        return { css: '', failed: href };
      });
    })).then(function (list) {
      return {
        css: list.map(function (item) { return item.css; }).filter(Boolean),
        failed: list.map(function (item) { return item.failed; }).filter(Boolean)
      };
    });
  }

  /** 剥脚本 + 剥外链 link + 补 base + 内联样式；notes 是给用户看的降级说明 */
  function buildSrcdoc(markup, opts, inlinedCss) {
    var notes = [];
    var head = /<head[^>]*>[\s\S]*?<\/head>/i.exec(markup);
    var body = /<body[^>]*>[\s\S]*?<\/body>/i.exec(markup);
    var headHtml = head ? head[0].replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<link[^>]+rel=["']?stylesheet["']?[^>]*>/gi, '') : '';
    var bodyHtml = (body ? body[0] : '<body>' + markup + '</body>')
      .replace(/<script[\s\S]*?<\/script>/gi, '');
    var css = inlinedCss ? (inlinedCss.css || []).join('\n') : '';
    var failed = inlinedCss ? (inlinedCss.failed || []) : [];
    if (!inlinedCss) notes.push('外链样式未内联（未启用内联或离线），渲染按浏览器默认样式');
    else if (failed.length) notes.push('外链样式未内联（抓取失败，按浏览器默认样式）：' + failed.join('、')
      + (css ? '（其余已内联）' : ''));
    var base = opts.baseUrl ? '<base href="' + escHtml(originOf(opts.baseUrl)) + '">' : '';
    return {
      html: '<!DOCTYPE html><html><head>' + base + headHtml +
        '<style>' + css + '</style><style>' + HL_CSS + '</style></head>' + bodyHtml + '</html>',
      notes: notes
    };
  }

  /**
   * 渲染一侧。opts：baseUrl（<base> 与外链解析）、containerId（只渲染该容器）、
   * inlineAssets（默认 true）、fetchText（url→Promise<string>，由调用方注入）、token。
   */
  function load(side, markup, opts) {
    var options = Object.assign({ inlineAssets: true }, opts || {});
    var token = options.token === undefined ? ++loadSeq[side] : (loadSeq[side] = options.token);
    clearPanel(side);
    var p = panels[side];
    if (!p) return Promise.resolve();
    if (!markup) { showError(side, '正文为空'); return Promise.resolve(); }
    p.innerHTML = '<div class="pdf-loading">加载网页…</div>';

    var needAssets = options.inlineAssets !== false && !!(options.baseUrl || options.originBase) && !!options.fetchText;
    var assets = needAssets ? fetchAssets(markup, baseList(options), options.fetchText) : Promise.resolve(null);

    return assets.then(function (inlinedCss) {
      if (loadSeq[side] !== token) return;
      var built = buildSrcdoc(String(markup), options, inlinedCss);
      markups[side] = String(markup);
      optsBySide[side] = options;
      warnings[side] = built.notes;
      var frame = document.createElement('iframe');
      frame.className = 'web-frame';
      frame.setAttribute('sandbox', 'allow-same-origin');
      frame.setAttribute('referrerpolicy', 'no-referrer-when-downgrade');
      frame.srcdoc = built.html;
      p.innerHTML = '';
      p.appendChild(frame);
      frames[side] = frame;
      return new Promise(function (resolve) {
        frame.addEventListener('load', function () {
          if (loadSeq[side] !== token) return resolve();
          try {
            docs[side] = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document);
          } catch (e) { docs[side] = null; }
          if (!docs[side]) { showError(side, '沙箱不可访问（iframe 未取得同源文档）'); return resolve(); }
          trimToContainer(side);
          vectors[side] = style().htmlVectors(String(markup), { containerId: options.containerId });
          fitWidth(side);
          resolve();
        });
        frame.addEventListener('error', function () {
          if (loadSeq[side] === token) showError(side, '渲染失败');
          resolve();
        });
      });
    }, function (err) {
      if (loadSeq[side] === token) showError(side, err);
    });
  }

  /**
   * 只留正文容器，但**不搬动它**：沿祖先链把每一层的兄弟节点 display:none。
   *
   * 为什么不能把容器摘出来另放：站点 CSS 大量写成祖先作用域
   * （``.article_con p{font-size:18px;line-height:40px}``、``#content_zw p{font-family:宋体}``），
   * 一摘出去这些选择器就不再命中——网页侧会渲染成"没样式"的样子，
   * 于是"左右看起来不一样"到底是文档没还原、还是我们自己的对照基准失真，
   * 根本分不清。保留祖先链才能拿到与浏览器一致的渲染结果。
   */
  function trimToContainer(side) {
    var doc = docs[side], options = optsBySide[side] || {};
    if (!doc || !options.containerId) return;
    var target = doc.getElementById(options.containerId);
    if (!target || target === doc.body) return;
    if (target.classList) target.classList.add('web-page');
    var node = target;
    while (node && node !== doc.body) {
      var parent = node.parentNode;
      if (!parent) break;
      Array.prototype.forEach.call(parent.children, function (sibling) {
        if (sibling !== node && sibling.style) sibling.style.display = 'none';
      });
      node = parent;
    }
    if (warnings[side] && warnings[side].length) {
      var note = doc.createElement('div');
      note.className = 'web-page-note';
      note.textContent = warnings[side].join('；');
      target.insertBefore(note, target.firstChild);
    }
  }

  /**
   * iframe 撑到内容全高：面板成为唯一滚动容器（设计决定 ②）。
   *
   * 量的是 iframe 文档里**正文块的下沿**，不是 iframe 元素自己的 rect：
   * 元素高度就是我们写进去的那个数，拿它当"内容高度"会永远自洽——
   * 实测踩过：load 当时布局未就绪，量到 40px 写回去，
   * 之后"连续两次相同"立刻成立，正文 3310px 被塞进 240px 的 iframe 里自己滚，
   * 面板 scrollTop 与逐片截图的几何全部失真。
   */
  /**
   * iframe 撑到内容全高：面板成为唯一滚动容器（设计决定 ②）。
   *
   * 量的是 iframe 文档里**正文块的下沿**，不是 iframe 元素自己的 rect：
   * 元素高度就是我们写进去的那个数，拿它当"内容高度"会永远自洽——
   * 实测踩过：load 当时布局未就绪，量到 40px 写回去，
   * 之后"连续两次相同"立刻成立，正文 3310px 被塞进 240px 的 iframe 里自己滚，
   * 面板 scrollTop 与逐片截图的几何全部失真。
   *
   * 三个量必须同坐标系才能取 max：getBoundingClientRect 是**可视 px**（已按 zoom 缩小），
   * 而 scrollHeight 是**未缩放的布局 px**。站点 CSS 生效后 zoom 会小于 1，
   * 直接 max 会拿布局值把 iframe 撑高一倍多，截图下半截全是空白（实测踩过）。
   * 所以 scrollHeight 一律乘当前 zoom 折算到可视 px 再比。
   */
  function measureContentHeight(side) {
    var doc = docs[side];
    if (!doc || !doc.documentElement) return 0;
    var page = doc.querySelector('.web-page') || doc.body;
    var bottom = 0;
    if (page && page.getBoundingClientRect) {
      try { bottom = Math.ceil(page.getBoundingClientRect().bottom); } catch (e) { bottom = 0; }
    }
    var z = parseFloat(doc.documentElement.style.zoom);
    if (!(z > 0)) z = 1;
    var layoutH = Math.max(doc.documentElement.scrollHeight || 0,
      doc.body ? (doc.body.scrollHeight || 0) : 0) * z;
    return Math.max(bottom, Math.ceil(layoutH));
  }

  function syncFrameHeight(side) {
    var frame = frames[side];
    if (!frame) return 0;
    var height = measureContentHeight(side);
    if (height > 0) frame.style.height = (height + 24) + 'px';
    invalidatePos(side);
    return height;
  }

  /**
   * 字体与外链样式是异步落地的，首屏量到的高度往往偏小，必须补量；
   * 但补量不能无限期做下去——报告通道按「滚动→切片→拼接」采集整页，
   * 中途改一次 iframe 高度就等于把两种几何截进同一张图。
   * 所以这里比的是**内容高度**（不是写回去的数），连续两次一致才收手，
   * 并留出 freeze() 给采集前上锁。
   */
  function resyncHeight(side) {
    if (heightFrozen[side]) return;
    if (heightTimers[side]) clearTimeout(heightTimers[side]);
    var last = -1, tries = 0;
    (function step() {
      if (heightFrozen[side] || tries++ > 12) return;
      var now = syncFrameHeight(side);
      if (now > 0 && now === last) return;          // 内容高度连续两次一致 → 已稳定
      last = now;
      heightTimers[side] = setTimeout(step, 180);
    })();
  }

  /** 采集/截图前调用：此后不再自动改高度，保证逐片几何一致 */
  function freeze(side) {
    if (side === 'L' || side === 'R') {
      heightFrozen[side] = true;
      if (heightTimers[side]) clearTimeout(heightTimers[side]);
    } else ['L', 'R'].forEach(freeze);
  }

  function unfreeze(side) {
    if (side === 'L' || side === 'R') { heightFrozen[side] = false; resyncHeight(side); }
    else ['L', 'R'].forEach(unfreeze);
  }

  /** 适应宽度：网页没有"页宽"概念，按面板宽缩放（zoom 参与布局，不留底部空白） */
  /**
   * 网页版心宽度：iframe 自己的宽度决定站点按多宽排版（政务 CMS 的 .layout 常是
   * 固定 1200px，视口再窄也不会回流，只会横向溢出）。所以先把 iframe 定宽，
   * 再用 zoom 缩进面板——这样"网页渲染结果"是一个确定宽度下的样子，
   * 而不是随面板宽度乱变的半成品（面板 654px 时右侧被裁一条就是这么来的）。
   */
  var WEB_LAYOUT_WIDTH = 0;   // 0 = 自动量版心宽；opts.layoutWidth 可显式指定

  /**
   * 版心宽：沿正文容器向上到 body，取祖先链里最宽的一个。
   * 为什么不是 documentElement.scrollWidth——政务站的固定版心（.layout{width:1200px}）
   * 是 body 的后代，html 本身只有视口宽，量它永远得到"不用缩放"，
   * 于是快照右侧被面板裁掉一条；被 display:none 隐藏的兄弟不参与布局，
   * 正好也不该把它们的宽度算进来。
   */
  function naturalWidth(doc) {
    var best = doc.documentElement ? (doc.documentElement.scrollWidth || 0) : 0;
    var node = doc.querySelector('.web-page');
    while (node && node !== doc.documentElement) {
      var w = Math.max(node.scrollWidth || 0, node.offsetWidth || 0);
      if (w > best) best = w;
      node = node.parentElement;
    }
    return best;
  }

  function fitWidth(side) {
    var p = panels[side], doc = docs[side];
    if (!p || !doc || !doc.documentElement) return;
    // 冻结后不再改 zoom：改一次 zoom = 整页重排一次 = iframe 高度跟着变，
    // 采集是按"开始量到的页高"切片的，中途重排会把同一段内容截进两片里。
    if (heightFrozen[side]) return;
    var layoutWidth = (optsBySide[side] && optsBySide[side].layoutWidth) || naturalWidth(doc);
    var natural = Math.max(doc.documentElement.scrollWidth || 0, layoutWidth);
    var cw = (p.clientWidth || 0) - 2;
    doc.documentElement.style.zoom = String(natural > 0 && cw > 0 && natural > cw ? Math.min(1, cw / natural) : 1);
    resyncHeight(side);
  }

  // ---------------------------------------------------------------- 提词
  function extractText(markup, opts) {
    var options = opts || {};
    var list = style().htmlVectors(String(markup || ''), { containerId: options.containerId });
    return Promise.resolve(style().vectorsText(list));
  }

  /** 段落摘要 → 编辑器行号（样式差异表点一行，面板跳到那一段） */
  function lineForText(side, prefix) {
    var list = vectors[side] || [];
    if (!list.length) return null;
    var lines = vectorLines(list);
    var key = collapse(String(prefix || ''));
    if (!key) return null;
    for (var i = 0; i < list.length; i++) {
      var text = collapse(list[i].text);
      if (text && (text.indexOf(key) === 0 || key.indexOf(text) === 0)) return lines[i];
    }
    return null;
  }

  function setSourceText(side, text) { texts[side] = text; invalidatePos(side); }
  function extractPanel(side) { return Promise.resolve(texts[side]); }
  function styleVectorsOf(side) { return vectors[side] || []; }

  // ---------------------------------------------------------------- 面板里的"段"
  /**
   * 正文容器内的块级元素序列。表格单元格算一段：td 里包着 p 时取 p（p 才是承载
   * 文本与行高的节点），td 没有子块级时才用 td——与样式向量的单元格口径一致。
   */
  function blocksOf(side) {
    var doc = docs[side];
    if (!doc || !doc.querySelectorAll) return { els: [], texts: [] };
    var page = doc.querySelector('.web-page') || doc.body;
    if (!page || !page.querySelectorAll) return { els: [], texts: [] };
    var found = page.querySelectorAll(BLOCK_SELECTOR), els = [], list = [];
    for (var i = 0; i < found.length; i++) {
      var el = found[i], tag = String(el.tagName || '').toLowerCase();
      if ((tag === 'td' || tag === 'th') && el.querySelector('p,h1,h2,h3,li,pre,div')) continue;
      var text = collapse(el.textContent);
      // 空段（<p><br/></p> 这类分页残留）不进坐标系：样式向量已经把空段丢掉，
      // 留着它只会让 DOM 段比向量多出一截，对齐结果整体错位一格。
      if (!text) continue;
      els.push(el);
      list.push(text);
    }
    return { els: els, texts: list };
  }

  /** DOM 段 ↔ 样式向量 对齐 → [[domIdx, vectorIdx], ...]（同一套"宁可漏标也不错位"策略） */
  function alignBlocks(side) {
    var blocks = blocksOf(side);
    var list = vectors[side] || [];
    if (!blocks.els.length || !list.length) return { pairs: [], blocks: blocks };
    var pairs = style().alignByParagraphs(
      blocks.texts.map(function (t, i) { return { text: t, i: i }; }),
      list.map(function (fp, i) { return { text: String(fp.text || '').replace(/\s+/g, ' ').trim(), i: i }; })
    );
    var out = [];
    pairs.forEach(function (pair) { if (pair.a && pair.b) out.push([pair.a.i, pair.b.i]); });
    return { pairs: out, blocks: blocks };
  }

  // ---------------------------------------------------------------- 差异标注
  function textNodesOf(doc, el) {
    var out = [];
    (function walk(node) {
      var cs = (node && node.childNodes) || [];
      for (var i = 0; i < cs.length; i++) {
        var c = cs[i];
        if (c.nodeType === 3) out.push(c);
        else if (c.nodeType === 1) walk(c);
      }
    })(el);
    return out;
  }

  function unwrap(el) {
    var par = el.parentNode;
    if (!par) return;
    while (el.firstChild) par.insertBefore(el.firstChild, el);
    par.removeChild(el);
  }

  function wrapText(doc, node, s, e, cls) {
    var target = s > 0 ? node.splitText(s) : node;
    if (e - s < (target.nodeValue || '').length) target.splitText(e - s);
    var par = target.parentNode;
    if (!par) return;
    var span = doc.createElement('span');
    span.className = 'web-hl web-hl-' + cls;
    par.insertBefore(span, target);
    span.appendChild(target);
  }

  function segRanges(segs, fallback) {
    var fb = fallback === 'rm' ? 'rm' : 'ad', out = [], off = 0;
    (segs || []).forEach(function (seg) {
      var len = (seg.text || '').length;
      if (seg.cls !== 'eq' && len > 0) {
        out.push({ s: off, e: off + len,
          cls: seg.cls === 'rm' ? 'rm' : (seg.cls === 'ad' ? 'ad' : fb) });
      }
      off += len;
    });
    return out;
  }

  function clearPaint(side) {
    var doc = docs[side];
    if (!doc) return;
    var spans = doc.querySelectorAll('span.web-hl'), i;
    for (i = 0; i < spans.length; i++) unwrap(spans[i]);
    var ps = doc.querySelectorAll(BLOCK_SELECTOR);
    for (i = 0; i < ps.length; i++) {
      if (ps[i].classList) {
        ps[i].classList.remove('web-hl-para');
        ps[i].classList.remove('web-hl-rm');
        ps[i].classList.remove('web-hl-ad');
      }
      if (ps[i].normalize) ps[i].normalize();
    }
  }

  function paintPara(doc, el, marker) {
    if (!el) return;
    if (typeof marker === 'string') {
      if (el.classList) el.classList.add('web-hl-para', 'web-hl-' + (marker === 'rm' ? 'rm' : 'ad'));
      return;
    }
    var ranges = segRanges(marker.segs, marker.t);
    if (!ranges.length) return;
    var nodes = textNodesOf(doc, el), offset = 0, marks = [];
    nodes.forEach(function (node, nodeIndex) {
      var len = (node.nodeValue || '').length;
      ranges.forEach(function (range) {
        var s = Math.max(range.s - offset, 0), e = Math.min(range.e - offset, len);
        if (e > s) marks.push({ index: nodeIndex, node: node, s: s, e: e, cls: range.cls });
      });
      offset += len;
    });
    // 从后往前包：切分靠后的文本节点不会影响靠前的偏移
    marks.sort(function (x, y) { return y.index - x.index || y.s - x.s; });
    marks.forEach(function (mark) { wrapText(doc, mark.node, mark.s, mark.e, mark.cls); });
  }

  function applyHighlights(side) {
    var doc = docs[side];
    if (!doc || texts[side] == null) return;
    clearPaint(side);
    var aligned = alignBlocks(side);
    var lines = vectorLines(vectors[side] || []);
    var map = hlMaps[side] || {};
    aligned.pairs.forEach(function (pair) {
      var marker = map[lines[pair[1]]];
      if (marker) paintPara(doc, aligned.blocks.els[pair[0]], marker);
    });
    resyncHeight(side);
  }

  function setHighlight(side, map) {
    if (side === 'L' || side === 'R') { hlMaps[side] = map || {}; applyHighlights(side); return; }
    ['L', 'R'].forEach(function (s) { hlMaps[s] = map || {}; applyHighlights(s); });
  }

  // ---------------------------------------------------------------- 行锚定
  function invalidatePos(side) { posIndex[side] = null; }

  /**
   * 段顶在面板滚动内容中的坐标。与 DocxView.topInPanel 同式：
   * iframe 已被撑到内容全高、随面板一起滚，所以 el 的 rect 相对面板 rect
   * 再补 scrollTop 就是内容坐标（zoom 已折算进 rect，无需特判）。
   */
  function topInPanel(p, el) {
    try { return el.getBoundingClientRect().top - p.getBoundingClientRect().top + (p.scrollTop || 0); }
    catch (e) { return null; }
  }

  function buildPosIndex(side) {
    var p = panels[side], doc = docs[side];
    if (!p || !doc || texts[side] == null || !p.clientHeight) return null;
    var aligned = alignBlocks(side);
    if (!aligned.pairs.length) return null;
    var lines = vectorLines(vectors[side] || []), arr = [];
    for (var i = 0; i < aligned.pairs.length; i++) {
      var el = aligned.blocks.els[aligned.pairs[i][0]];
      if (!el || !el.getBoundingClientRect) return null;
      var top = topInPanel(p, el);
      if (top == null) return null;
      arr.push({ line: lines[aligned.pairs[i][1]], top: top, h: el.getBoundingClientRect().height || 0 });
    }
    arr.sort(function (a, b) { return a.top - b.top || a.line - b.line; });
    if (arr[0].line >= 1) arr.unshift({ line: 0, top: 0, h: arr[0].h || 16 });
    return arr;
  }

  function posIndexOf(side) {
    if (!posIndex[side]) posIndex[side] = buildPosIndex(side);
    return posIndex[side];
  }

  function idxAtPx(arr, px) {
    var lo = -1, hi = arr.length - 1;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (arr[mid].top <= px) lo = mid; else hi = mid - 1; }
    return lo;
  }

  function idxAtLine(arr, line) {
    var lo = -1, hi = arr.length - 1;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (arr[mid].line <= line) lo = mid; else hi = mid - 1; }
    return lo;
  }

  function lineOffset(side, line) {
    var arr = posIndexOf(side);
    if (!arr) return null;
    var i = idxAtLine(arr, line);
    if (i < 0) i = 0;
    var e = arr[i], span = e.h;
    if (i + 1 < arr.length) { var gap = arr[i + 1].top - e.top; if (gap > 0) span = gap; }
    return e.top + (line - e.line) * span;
  }

  function lineHeightAtLine(side, line) {
    var arr = posIndexOf(side);
    if (!arr) return null;
    var i = idxAtLine(arr, line);
    if (i < 0) i = 0;
    if (i + 1 < arr.length) { var gap = arr[i + 1].top - arr[i].top; if (gap > 0) return gap; }
    return arr[i].h;
  }

  function lineAtOffset(side, px) {
    var arr = posIndexOf(side);
    if (!arr) return null;
    var i = idxAtPx(arr, px);
    if (i < 0) return arr[0] ? arr[0].line : 1;
    return arr[i].line;
  }

  function nextLineOffset(side, line) {
    var arr = posIndexOf(side);
    if (!arr) return null;
    var i = idxAtLine(arr, line);
    if (i < 0) i = 0;
    return (i + 1 < arr.length) ? arr[i + 1].top : null;
  }

  // ---------------------------------------------------------------- 互换
  function swap() {
    var m = markups.L, o = optsBySide.L, t = texts.L, h = hlMaps.L, v = vectors.L;
    markups.L = markups.R; optsBySide.L = optsBySide.R; texts.L = texts.R;
    hlMaps.L = hlMaps.R; vectors.L = vectors.R;
    markups.R = m; optsBySide.R = o; texts.R = t; hlMaps.R = h; vectors.R = v;
    loadSeq.L++; loadSeq.R++;
    if (panels.L) panels.L.innerHTML = '';
    if (panels.R) panels.R.innerHTML = '';
    invalidatePos('L'); invalidatePos('R');
    function restore(side, text, map) {
      texts[side] = text; hlMaps[side] = map; applyHighlights(side);
    }
    if (markups.L) load('L', markups.L, optsBySide.L).then(function () { restore('L', texts.L, hlMaps.L); }, function () {});
    if (markups.R) load('R', markups.R, optsBySide.R).then(function () { restore('R', texts.R, hlMaps.R); }, function () {});
  }

  /**
   * 面板宽度一变就重算 zoom。只监听 window resize 是不够的：
   * 主区域3 刚加载时是 display:none（updatePdfArea 判空才显示），
   * 那一刻 clientWidth=0，fitWidth 只能把 zoom 退化成 1；随后面板转为可见、
   * 宽度确定，却没有任何事件再来一次——于是网页按原大渲染、超出面板被裁，
   * 逐片截图还会把"退化前 + 退化后"两种比例拼进同一张图。
   * docx 侧靠 render.js 在加载前手工解除 hidden 绕过，网页侧用 ResizeObserver 正面解决。
   */
  var fitTimer = { L: null, R: null };
  function scheduleFit(side) {
    if (fitTimer[side]) clearTimeout(fitTimer[side]);
    fitTimer[side] = setTimeout(function () {
      fitTimer[side] = null;
      if (docs[side] && !heightFrozen[side]) fitWidth(side);
    }, 120);
  }

  if (W) {
    W.addEventListener('resize', function () {
      ['L', 'R'].forEach(function (s) { if (docs[s]) scheduleFit(s); });
    });
  }
  if (typeof ResizeObserver === 'function') {
    var ro = new ResizeObserver(function (entries) {
      entries.forEach(function (entry) {
        ['L', 'R'].forEach(function (s) {
          if (panels[s] && entry.target === panels[s] && docs[s] && !heightFrozen[s]) scheduleFit(s);
        });
      });
    });
    // init 之后再观察（panels 在 init 里才拿到元素）
    var observePanels = init;
    init = function (opts) {
      observePanels(opts);
      ['L', 'R'].forEach(function (s) { if (panels[s]) ro.observe(panels[s]); });
    };
  }

  root.WebView = {
    init: init, load: load, extractText: extractText, clear: clear,
    isLoaded: isLoaded, swap: swap, showError: showError, fitWidth: fitWidth,
    setSourceText: setSourceText, extractPanel: extractPanel, setHighlight: setHighlight,
    lineForText: lineForText, syncHeight: resyncHeight, freeze: freeze, unfreeze: unfreeze,
    styleVectors: function (markup, opts) { return style().htmlVectors(markup, opts); },
    styleVectorsOf: styleVectorsOf,
    vectorsText: function (list) { return style().vectorsText(list); },
    compareStyle: function (a, b, opts) { return style().compareVectors(a, b, opts); },
    lineOffset: lineOffset, lineAtOffset: lineAtOffset, lineHeight: lineHeightAtLine,
    nextLineOffset: nextLineOffset,
    _debug: function (side) {
      return {
        loaded: !!docs[side], hasText: texts[side] != null,
        vectors: vectors[side] ? vectors[side].length : 0,
        blocks: blocksOf(side).els.length,
        aligned: alignBlocks(side).pairs.length,
        posEntries: posIndex[side] ? posIndex[side].length : 0,
        frameHeight: frames[side] ? frames[side].style.height : '',
        contentHeight: measureContentHeight(side),
        warnings: warnings[side]
      };
    }
  };
})(typeof self !== 'undefined' ? self : this);
