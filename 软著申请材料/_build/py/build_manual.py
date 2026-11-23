# -*- coding: utf-8 -*-
"""build_manual.py — 生成《用户手册》docx，并做版面自检。

目录页码采用两遍法：先按占位页码排版，转成 PDF 后用文字层定位每个标题的实际页码，
再回填重建。页码回填不改变行数，因此两遍之后版面即稳定，最后一遍再核对一次。
"""

import os
import subprocess
import sys
import tempfile

import pymupdf
from PIL import Image
from docx.shared import Pt, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK, WD_TAB_ALIGNMENT, WD_TAB_LEADER
from docx.enum.section import WD_SECTION

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
OUT_DIR = os.path.abspath(os.path.join(HERE, '..', '..'))
SHOT = os.path.join(OUT_DIR, '界面截图-CompareText')
ART = os.path.join(OUT_DIR, '界面插图')

sys.path.insert(0, HERE)
import docx_kit as K
import content_manual as C

SOFTWARE = 'CompareText文件对比软件'
VERSION = 'V1.4'
DOC_TITLE = '%s %s 用户手册' % (SOFTWARE, VERSION)
OUT_DOCX = os.path.join(OUT_DIR, '用户手册-%s%s.docx' % (SOFTWARE, VERSION))


# ---------------------------------------------------------------- 插图预处理

def _trim_box(im, tol=6, keep=0.6):
    """裁掉四边纯色留白：截图常带一圈与界面无关的空边，占版面又看不清内容。"""
    g = im.convert('L')
    w, h = g.size
    d = g.tobytes()

    def row_flat(y):
        r = d[y * w:(y + 1) * w]
        return max(r) - min(r) < tol

    def col_flat(x):
        c = d[x::w]
        return max(c) - min(c) < tol

    top = 0
    while top < h * keep and row_flat(top):
        top += 1
    bot = h - 1
    while bot > h * (1 - keep) and row_flat(bot):
        bot -= 1
    left = 0
    while left < w * keep and col_flat(left):
        left += 1
    right = w - 1
    while right > w * (1 - keep) and col_flat(right):
        right -= 1
    pad = 6
    return (max(0, left - pad), max(0, top - pad), min(w, right + 1 + pad), min(h, bot + 1 + pad))


def prepare_art():
    """准备手册插图：侧边栏长图裁成两张，其余截图去掉四周纯色留白。"""
    os.makedirs(ART, exist_ok=True)
    for name in sorted(os.listdir(SHOT)):
        if not name.endswith('.png'):
            continue
        src = os.path.join(SHOT, name)
        dst = os.path.join(ART, 'trim-' + name)
        if os.path.exists(dst) and os.path.getmtime(dst) >= os.path.getmtime(src):
            continue
        im = Image.open(src)
        box = _trim_box(im)
        im.crop(box).save(dst)

    # 侧边栏截图过长，单独裁成“忽略选项”“历史记录”两张
    im = Image.open(os.path.join(SHOT, '03-忽略选项与历史.png'))
    w, h = im.size
    crops = {
        '04-忽略选项.png': (0, int(h * 0.195), w, int(h * 0.505)),
        '04-历史记录.png': (0, int(h * 0.515), w, int(h * 0.775)),
    }
    for name, box in crops.items():
        im.crop(box).save(os.path.join(ART, name))


# ---------------------------------------------------------------- 封面与文档信息

def cover(doc):
    for _ in range(3):
        p = doc.add_paragraph()
        p.paragraph_format.space_after = Pt(0)
        p.add_run('')
        p.runs[0].font.size = Pt(20)
    doc.add_paragraph(SOFTWARE, style='CoverTitle')
    doc.add_paragraph('用户手册', style='CoverSub')
    p = doc.add_paragraph(style='CoverMeta')
    p.add_run('版本 %s　·　文档类型：用户操作与功能说明（鉴别材料 · 文档）' % VERSION)
    K.hr(doc, color='1F4E79', sz=10, space_before=10, space_after=26)

    for _ in range(2):
        p = doc.add_paragraph()
        p.add_run('')
        p.runs[0].font.size = Pt(14)

    tbl = doc.add_table(rows=3, cols=2)
    tbl.alignment = 1
    K._fixed_layout(tbl, [4.0, 8.0])
    rows = [
        ('软件名称', SOFTWARE),
        ('版本号', VERSION),
        ('编制日期', '2026 年 11 月'),
    ]
    for i, (k, v) in enumerate(rows):
        c0, c1 = tbl.rows[i].cells
        c0.text = ''
        c1.text = ''
        p0 = c0.paragraphs[0]
        p0.style = doc.styles['TableCellCN']
        r0 = p0.add_run(k)
        r0.font.color.rgb = K.GRAY
        p1 = c1.paragraphs[0]
        p1.style = doc.styles['TableCellCN']
        r1 = p1.add_run(v)
        r1.font.bold = True
    # 去掉封面信息表的边框
    tblPr = tbl._tbl.tblPr
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    borders = OxmlElement('w:tblBorders')
    for edge in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'):
        e = OxmlElement('w:' + edge)
        e.set(qn('w:val'), 'nil')
        borders.append(e)
    tblPr.append(borders)


def info_page(doc):
    p = doc.add_paragraph('文档信息', style='SectTitle')
    p.paragraph_format.space_before = Pt(0)
    K.table(doc, ['项目', '内容'], [
        ['软件全称', SOFTWARE],
        ['软件简称', 'CompareText'],
        ['版本号', VERSION],
        ['文档名称', '用户手册'],
        ['文档类型', '用户操作与功能说明（计算机软件著作权登记鉴别材料 · 文档）'],
        ['适用软件', '%s %s（浏览器模式与桌面模式）' % (SOFTWARE, VERSION)],
        ['对应源程序文档', '《源程序-%s%s》' % (SOFTWARE, VERSION)],
        ['示例文件', '随材料提供的「演示文件」目录，清单见附录 B'],
    ], [3.6, 12.4], None, first_col_bold=True)

    doc.add_paragraph('修订记录', style='SectTitle')
    K.table(doc, ['版本', '日期', '修订说明'], [
        ['V1.3', '2026-10-21', '首次编制：文本、文件、表格对比与报告导出。'],
        ['V1.4', '2026-11-22', '补充网页对比与样式核对、Markdown 对比、拖拽与关键词过滤，'
                               '重排全部章节与插图。'],
    ], [2.4, 3.2, 10.4], None, first_col_bold=True)



# ---------------------------------------------------------------- 目录

def toc_page(doc, pages, break_before=True):
    p = doc.add_paragraph('目　录', style='TocTitle')
    p.paragraph_format.space_after = Pt(14)
    if break_before:
        p.paragraph_format.page_break_before = True
    for i, (level, text) in enumerate(C.headings()):
        num = pages.get(text, 0)
        K.toc_line(doc, text, num, level=level)


# ---------------------------------------------------------------- 正文渲染

def render_body(doc):
    pending_break = False
    first_h1 = True
    for b in C.blocks():
        kind = b[0]
        if kind == 'pagebreak':
            pending_break = True
            continue
        if kind == 'h1':
            if first_h1:
                p = doc.add_paragraph(style='ChapTitle')
                p.paragraph_format.page_break_before = True
                first_h1 = False
            else:
                p = doc.add_paragraph(style='ChapTitle')
            p.add_run(b[1])
            pending_break = False
        elif kind == 'h2':
            doc.add_paragraph(b[1], style='SectTitle')
        elif kind == 'h3':
            doc.add_paragraph(b[1], style='SubTitle')
        elif kind in ('p', 'lead'):
            doc.add_paragraph(b[1], style='BodyCN')
        elif kind == 'bullets':
            K.bullets(doc, b[1])
        elif kind == 'steps':
            K.steps(doc, b[1])
        elif kind == 'table':
            _, head, rows, widths, cap = b
            K.table(doc, head, rows, widths, cap)
        elif kind == 'img':
            _, path, cap, w = b
            trimmed = os.path.join(ART, 'trim-' + os.path.basename(path))
            if os.path.exists(trimmed):
                path = trimmed
            K.figure(doc, path, cap, max_w_cm=w)
        elif kind == 'code':
            K.code_block(doc, b[1])
        elif kind == 'note':
            K.note_block(doc, b[1], b[2])
        else:
            raise ValueError('unknown block %r' % (kind,))


def build(pages=None):
    pages = pages or {}
    doc = K.new_document()
    K.build_styles(doc)
    # 目录标题样式
    K.add_para_style(doc, 'TocTitle', size=18, east=K.HEI, bold=True, color=K.ACCENT,
                     align=WD_ALIGN_PARAGRAPH.CENTER, line=1.5, before=0, after=14,
                     outline=0, keep_next=True)

    sec1 = doc.sections[0]
    sec1.different_first_page_header_footer = True
    cover(doc)

    sec2 = doc.add_section(WD_SECTION.NEW_PAGE)
    K.set_header(sec2, DOC_TITLE)
    K.set_page_numbering(sec2, 1)
    sec2.different_first_page_header_footer = False

    info_page(doc)
    toc_page(doc, pages, break_before=True)
    render_body(doc)

    # 文档属性
    doc.core_properties.title = DOC_TITLE
    doc.core_properties.author = SOFTWARE
    doc.core_properties.subject = '计算机软件著作权登记鉴别材料 · 文档'
    doc.core_properties.comments = '%s %s 用户手册' % (SOFTWARE, VERSION)
    doc.save(OUT_DOCX)
    return OUT_DOCX


# ---------------------------------------------------------------- 自检 / 页码

def to_pdf(docx_path):
    tmp = tempfile.mkdtemp(prefix='manual-pdf-')
    subprocess.run(['soffice', '--headless', '--convert-to', 'pdf', '--outdir', tmp, docx_path],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    name = os.path.splitext(os.path.basename(docx_path))[0] + '.pdf'
    return os.path.join(tmp, name)


def _norm(s):
    return ''.join(s.split())


def scan(pdf_path):
    doc = pymupdf.open(pdf_path)
    page_lines = []
    for page in doc:
        # 按基线归并 span：中西文混排时 pymupdf 会把一行拆成多个 line，
        # 直接按 line 取文本会串行，标题也就定位不到。
        groups = {}
        for block in page.get_text('dict')['blocks']:
            for line in block.get('lines', []):
                for span in line['spans']:
                    y = round(span['origin'][1], 1)
                    groups.setdefault(y, []).append((span['bbox'][0], span['text']))
        lines = []
        for y in sorted(groups):
            text = ''.join(t for _, t in sorted(groups[y])).strip()
            if text:
                lines.append((y, text))
        page_lines.append(lines)
    return doc, page_lines


def locate_headings(page_lines, headings):
    """按顺序在正文页里找标题，返回 {标题: 打印页码}。

    PDF 文字层会把“CompareText 文件对比软件”这类中西文混排的行拆成多个 span，
    因此按“整页去空白后做子串匹配”定位；目录页靠连续省略号识别并跳过。
    封面不编号，正文首页即打印第 1 页，故打印页码等于 PDF 页序号（0 起）。
    """
    import re
    page_text = []
    is_toc = []
    for lines in page_lines:
        raw = ''.join(t for _, t in lines)
        page_text.append(_norm(raw))
        is_toc.append(bool(re.search(r'\.{6,}', raw)))
    body_start = 0
    for i, flag in enumerate(is_toc):
        if flag:
            body_start = i + 1

    result = {}
    cursor = body_start
    for level, text in headings:
        key = _norm(text)
        found = None
        for idx in range(cursor, len(page_text)):
            if is_toc[idx]:
                continue
            if key and key in page_text[idx]:
                found = idx
                break
        if found is None:
            raise RuntimeError('目录定位失败：%s' % text)
        result[text] = found
        cursor = found
    return result


def verify(pdf_path, pages):
    doc, page_lines = scan(pdf_path)
    total = doc.page_count
    missing_header = []
    for i, page in enumerate(doc):
        if i == 0:
            continue
        txt = _norm(page.get_text())
        if _norm(DOC_TITLE) not in txt:
            missing_header.append(i + 1)
            continue
        # 页码在页眉右上角：取页眉区域的数字 span，检查其 x 坐标
        nums = []
        for block in page.get_text('dict')['blocks']:
            for line in block.get('lines', []):
                for span in line['spans']:
                    if span['text'].strip().isdigit() and span['bbox'][3] < 60:
                        nums.append(span['bbox'][0])
        if not nums or min(nums) < page.rect.width * 0.80:
            missing_header.append(i + 1)

    actual = locate_headings(page_lines, C.headings())
    drift = [(k, pages.get(k), v) for k, v in actual.items() if pages.get(k) != v]

    counts = []
    image_pages = []
    for i, page in enumerate(doc):
        if i == 0:
            counts.append(0)
            continue
        ys = set()
        for block in page.get_text('dict')['blocks']:
            for line in block.get('lines', []):
                text = ''.join(s['text'] for s in line['spans']).strip()
                if text and line['bbox'][1] > 60 and line['bbox'][3] < page.rect.height - 50:
                    ys.add(round(line['bbox'][1], 0))
        counts.append(len(ys))
        if any(b.get('type') == 1 for b in page.get_text('dict')['blocks']):
            image_pages.append(i + 1)

    xrefs = set()
    for page in doc:
        for img in page.get_images(full=True):
            xrefs.add(img[0])
    return {
        'pages': total,
        'missing_header': missing_header,
        'drift': drift,
        'counts': counts,
        'image_pages': image_pages,
        'images': len(xrefs),
    }


def build_with_toc():
    prepare_art()
    # 第一遍：占位页码
    build({})
    pdf1 = to_pdf(OUT_DOCX)
    _, lines1 = scan(pdf1)
    pages = locate_headings(lines1, C.headings())

    # 第二遍：回填页码
    build(pages)
    pdf2 = to_pdf(OUT_DOCX)
    res = verify(pdf2, pages)

    if res['drift']:
        # 页码漂移时再迭代一次
        _, lines2 = scan(pdf2)
        pages = locate_headings(lines2, C.headings())
        build(pages)
        pdf3 = to_pdf(OUT_DOCX)
        res = verify(pdf3, pages)

    return pages, res


def write_stats(**kw):
    import json
    path = os.path.join(HERE, 'build_stats.json')
    data = {}
    if os.path.exists(path):
        with open(path, encoding='utf-8') as fh:
            data = json.load(fh)
    data.update(kw)
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2, sort_keys=True)


if __name__ == '__main__':
    pages, res = build_with_toc()
    print('用户手册：%s' % OUT_DOCX)
    print('总页数：%d，插图：%d 张' % (res['pages'], res['images']))
    print('页眉/页码异常页：%s' % (res['missing_header'] or '无'))
    print('目录页码漂移：%s' % (res['drift'] or '无'))
    img_pages = set(res['image_pages'])
    text_only = [c for i, c in enumerate(res['counts']) if i > 0 and (i + 1) not in img_pages]
    print('纯文字页行数：最少 %d，最多 %d' % (min(text_only), max(text_only)))
    print('纯文字页少于 30 行的页：%s' % ([i + 1 for i, c in enumerate(res['counts'])
                                    if i > 0 and (i + 1) not in img_pages and c < 30] or '无'))
    write_stats(manual_pages=res['pages'], manual_images=res['images'])
    print('含插图页：%d 页，文字行数范围 %s' % (len(img_pages), sorted(
        (i + 1, c) for i, c in enumerate(res['counts']) if (i + 1) in img_pages)[:6]))
