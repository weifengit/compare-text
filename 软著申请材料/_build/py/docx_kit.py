# -*- coding: utf-8 -*-
"""docx_kit.py — 软著申报材料的 Word 排版基础件。

只做四件事：统一的页面与字体、可复用的段落样式、表格/配图/提示框/代码块
的排版、页眉页码与目录。文档内容在 content_*.py 中，这里不写任何业务文字。
"""

from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING, WD_TAB_ALIGNMENT, WD_TAB_LEADER
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.section import WD_SECTION
from docx.enum.style import WD_STYLE_TYPE
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
from PIL import Image

# ---- 全文档统一的字体与字号 ----
SONG = '宋体'          # 正文中文字体
HEI = '黑体'           # 标题中文字体
LATIN = 'Times New Roman'   # 西文字体
MONO = 'Consolas'      # 代码等宽字体
INK = RGBColor(0x1A, 0x1A, 0x1A)
GRAY = RGBColor(0x55, 0x55, 0x55)
ACCENT = RGBColor(0x1F, 0x4E, 0x79)   # 章节强调色（深蓝）

TEXT_W_CM = 16.0       # 版心宽度：A4 21cm − 左右页边距 2.5cm × 2


def _set_rfonts(rPr, latin, east):
    """把 w:rFonts 的四个槽位一次性写全，避免 Word 用默认字体顶替。"""
    rF = rPr.find(qn('w:rFonts'))
    if rF is None:
        rF = OxmlElement('w:rFonts')
        rPr.insert(0, rF)
    rF.set(qn('w:ascii'), latin)
    rF.set(qn('w:hAnsi'), latin)
    rF.set(qn('w:cs'), latin)
    rF.set(qn('w:eastAsia'), east)
    rF.set(qn('w:hint'), 'eastAsia')


def _el(tag, **attrs):
    e = OxmlElement(tag)
    for k, v in attrs.items():
        e.set(qn('w:' + k), str(v))
    return e


def _style_font(style, size, east=SONG, latin=LATIN, bold=False, color=None):
    style.font.size = Pt(size)
    style.font.bold = bold
    style.font.name = latin
    if color is not None:
        style.font.color.rgb = color
    _set_rfonts(style.element.get_or_add_rPr(), latin, east)


def _first_line_chars(style, chars, size_pt):
    """首行缩进按字符数设置（w:firstLineChars），同时写入等效 twips 作为兜底。"""
    pPr = style.element.get_or_add_pPr()
    ind = pPr.find(qn('w:ind'))
    if ind is None:
        ind = OxmlElement('w:ind')
        pPr.append(ind)
    ind.set(qn('w:firstLineChars'), str(chars * 100))
    ind.set(qn('w:firstLine'), str(int(chars * size_pt * 20)))


def new_document(margins=(2.5, 2.5, 2.5, 2.5), header_cm=1.5, footer_cm=1.2):
    doc = Document()
    sec = doc.sections[0]
    sec.page_width = Cm(21.0)
    sec.page_height = Cm(29.7)
    sec.top_margin = Cm(margins[0])
    sec.bottom_margin = Cm(margins[1])
    sec.left_margin = Cm(margins[2])
    sec.right_margin = Cm(margins[3])
    sec.header_distance = Cm(header_cm)
    sec.footer_distance = Cm(footer_cm)

    normal = doc.styles['Normal']
    normal.font.size = Pt(11)
    normal.font.name = LATIN
    _set_rfonts(normal.element.get_or_add_rPr(), LATIN, SONG)
    pf = normal.paragraph_format
    pf.space_before = Pt(0)
    pf.space_after = Pt(0)
    pf.line_spacing = 1.5
    return doc


def add_para_style(doc, name, size=11, east=SONG, latin=LATIN, bold=False, color=None,
                   align=None, line=1.5, before=0, after=6, indent_chars=0,
                   left_cm=0.0, first_cm=None, outline=None, keep_next=False,
                   keep_together=False):
    st = doc.styles.add_style(name, WD_STYLE_TYPE.PARAGRAPH)
    st.base_style = doc.styles['Normal']
    _style_font(st, size, east, latin, bold, color)
    pf = st.paragraph_format
    if align is not None:
        pf.alignment = align
    pf.line_spacing = line
    pf.space_before = Pt(before)
    pf.space_after = Pt(after)
    if left_cm:
        pf.left_indent = Cm(left_cm)
    if first_cm is not None:
        pf.first_line_indent = Cm(first_cm)
    if indent_chars:
        _first_line_chars(st, indent_chars, size)
    if outline is not None:
        pPr = st.element.get_or_add_pPr()
        pPr.append(_el('w:outlineLvl', val=outline))
    if keep_next:
        pf.keep_with_next = True
    if keep_together:
        pf.keep_together = True
    return st


def build_styles(doc):
    """建立整套样式。名称用英文，避免 Word 把内置样式名本地化后对不上。"""
    S = {}
    S['body'] = add_para_style(doc, 'BodyCN', size=11, align=WD_ALIGN_PARAGRAPH.JUSTIFY,
                               line=1.5, after=6, indent_chars=2)
    S['lead'] = add_para_style(doc, 'LeadCN', size=11, align=WD_ALIGN_PARAGRAPH.JUSTIFY,
                               line=1.5, after=6, indent_chars=2)
    S['h1'] = add_para_style(doc, 'ChapTitle', size=18, east=HEI, bold=True, color=ACCENT,
                             align=WD_ALIGN_PARAGRAPH.CENTER, line=1.5, before=22, after=14,
                             outline=0, keep_next=True)
    # 章标题上方一条细线，使不另起一页的章在视觉上与上文分开
    pPr = S['h1'].element.get_or_add_pPr()
    pBdr = OxmlElement('w:pBdr')
    top = OxmlElement('w:top')
    top.set(qn('w:val'), 'single')
    top.set(qn('w:sz'), '6')
    top.set(qn('w:space'), '6')
    top.set(qn('w:color'), '1F4E79')
    pBdr.append(top)
    pPr.append(pBdr)
    S['h2'] = add_para_style(doc, 'SectTitle', size=14, east=HEI, bold=True, color=INK,
                             align=WD_ALIGN_PARAGRAPH.LEFT, line=1.5, before=14, after=6,
                             outline=1, keep_next=True)
    S['h3'] = add_para_style(doc, 'SubTitle', size=12, east=HEI, bold=True, color=INK,
                             align=WD_ALIGN_PARAGRAPH.LEFT, line=1.5, before=10, after=4,
                             outline=2, keep_next=True)
    S['caption'] = add_para_style(doc, 'FigCaption', size=9.5, color=GRAY,
                                  align=WD_ALIGN_PARAGRAPH.CENTER, line=1.2, before=2, after=10)
    S['tabcap'] = add_para_style(doc, 'TabCaption', size=9.5, color=GRAY,
                                 align=WD_ALIGN_PARAGRAPH.CENTER, line=1.2, before=8, after=4,
                                 keep_next=True)
    S['cell'] = add_para_style(doc, 'TableCellCN', size=9.5, line=1.25, before=1, after=1)
    S['cellhead'] = add_para_style(doc, 'TableHeadCN', size=9.5, bold=True, line=1.25,
                                   before=1, after=1, align=WD_ALIGN_PARAGRAPH.CENTER)
    S['code'] = add_para_style(doc, 'CodeCN', size=9, latin=MONO, line=1.15, before=0, after=0)
    S['note'] = add_para_style(doc, 'NoteCN', size=9.5, line=1.3, before=2, after=2,
                               color=RGBColor(0x33, 0x3F, 0x4F))
    S['toc1'] = add_para_style(doc, 'TocLevel1', size=11.5, east=HEI, bold=True, line=1.35,
                               before=6, after=2)
    S['toc2'] = add_para_style(doc, 'TocLevel2', size=10.5, line=1.3, before=0, after=0,
                               left_cm=0.85)
    S['cover_title'] = add_para_style(doc, 'CoverTitle', size=30, east=HEI, bold=True,
                                      align=WD_ALIGN_PARAGRAPH.CENTER, line=1.4,
                                      before=0, after=8)
    S['cover_sub'] = add_para_style(doc, 'CoverSub', size=22, east=HEI, bold=False,
                                    align=WD_ALIGN_PARAGRAPH.CENTER, line=1.4,
                                    before=0, after=6)
    S['cover_meta'] = add_para_style(doc, 'CoverMeta', size=12, color=GRAY,
                                     align=WD_ALIGN_PARAGRAPH.CENTER, line=1.6,
                                     before=0, after=2)
    S['bullet'] = add_para_style(doc, 'BulletCN', size=11, align=WD_ALIGN_PARAGRAPH.JUSTIFY,
                                 line=1.5, before=0, after=3, left_cm=0.9, first_cm=-0.5)
    return S


# ---------------------------------------------------------------- 内容块

def _spacer(doc, pt):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(0)
    p.paragraph_format.space_after = Pt(0)
    p.paragraph_format.line_spacing = 1.0
    r = p.add_run('')
    r.font.size = Pt(pt)


def para(doc, text, style='BodyCN'):
    p = doc.add_paragraph(text, style=style)
    return p


def bullets(doc, items, bullet='•'):
    for it in items:
        p = doc.add_paragraph(style='BulletCN')
        r = p.add_run(bullet + ' ')
        r.font.name = LATIN
        p.add_run(it)


def steps(doc, items, start=1):
    for i, it in enumerate(items, start):
        p = doc.add_paragraph(style='BulletCN')
        r = p.add_run('%d. ' % i)
        r.font.name = LATIN
        p.add_run(it)


def caption(doc, text, kind='fig'):
    return doc.add_paragraph(text, style='FigCaption' if kind == 'fig' else 'TabCaption')


def _shade(cell, hex_fill):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement('w:shd')
    shd.set(qn('w:val'), 'clear')
    shd.set(qn('w:color'), 'auto')
    shd.set(qn('w:fill'), hex_fill)
    tcPr.append(shd)


def _cell_margins(table, top=50, left=100, bottom=50, right=100):
    tblPr = table._tbl.tblPr
    mar = OxmlElement('w:tblCellMar')
    for edge, w in (('top', top), ('left', left), ('bottom', bottom), ('right', right)):
        e = OxmlElement('w:' + edge)
        e.set(qn('w:w'), str(w))
        e.set(qn('w:type'), 'dxa')
        mar.append(e)
    tblPr.append(mar)


def _borders(table, color='C3CEDD', sz=4, inside=True):
    tblPr = table._tbl.tblPr
    b = OxmlElement('w:tblBorders')
    edges = ['top', 'left', 'bottom', 'right']
    if inside:
        edges += ['insideH', 'insideV']
    for edge in edges:
        e = OxmlElement('w:' + edge)
        e.set(qn('w:val'), 'single')
        e.set(qn('w:sz'), str(sz))
        e.set(qn('w:space'), '0')
        e.set(qn('w:color'), color)
        b.append(e)
    tblPr.append(b)


def _fixed_layout(table, widths_cm):
    tblPr = table._tbl.tblPr
    layout = OxmlElement('w:tblLayout')
    layout.set(qn('w:type'), 'fixed')
    tblPr.append(layout)
    table.autofit = False
    table.columns
    for col, w in zip(table.columns, widths_cm):
        col.width = Cm(w)
    for row in table.rows:
        for cell, w in zip(row.cells, widths_cm):
            cell.width = Cm(w)


def table(doc, head, rows, widths_cm, caption_text=None, header_bg='E9EFF7',
          first_col_bold=False, font_size=None):
    if caption_text:
        caption(doc, caption_text, kind='table')
    t = doc.add_table(rows=1, cols=len(head))
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    _fixed_layout(t, widths_cm)
    _borders(t)
    _cell_margins(t)

    # 表头行：加底纹、加粗、跨页时重复
    hdr = t.rows[0]
    trPr = hdr._tr.get_or_add_trPr()
    trPr.append(_el('w:tblHeader', val='true'))
    trPr.append(_el('w:cantSplit', val='true'))
    for cell, text in zip(hdr.cells, head):
        _shade(cell, header_bg)
        cell.vertical_alignment = 1  # center
        p = cell.paragraphs[0]
        p.style = doc.styles['TableHeadCN']
        p.add_run(text)
        if font_size:
            for r in p.runs:
                r.font.size = Pt(font_size)

    for row_data in rows:
        row = t.add_row()
        trPr = row._tr.get_or_add_trPr()
        trPr.append(_el('w:cantSplit', val='false'))
        for i, (cell, text) in enumerate(zip(row.cells, row_data)):
            cell.vertical_alignment = 1
            p = cell.paragraphs[0]
            p.style = doc.styles['TableCellCN']
            if first_col_bold and i == 0:
                for seg in str(text).split('\n'):
                    r = p.add_run(seg)
                    r.font.bold = True
                    if seg != str(text).split('\n')[-1]:
                        r.add_break()
            else:
                for seg in str(text).split('\n'):
                    r = p.add_run(seg)
                    if font_size:
                        r.font.size = Pt(font_size)
                    if seg != str(text).split('\n')[-1]:
                        r.add_break()
    _spacer(doc, 8)
    return t


def code_block(doc, lines):
    t = doc.add_table(rows=1, cols=1)
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    _fixed_layout(t, [TEXT_W_CM])
    _borders(t, color='DCE3EC', sz=4, inside=False)
    _cell_margins(t, top=90, left=160, bottom=90, right=160)
    t.rows[0]._tr.get_or_add_trPr().append(_el('w:cantSplit', val='true'))
    cell = t.rows[0].cells[0]
    _shade(cell, 'F6F8FB')
    first = True
    for line in lines:
        p = cell.paragraphs[0] if first else cell.add_paragraph()
        first = False
        p.style = doc.styles['CodeCN']
        p.add_run(line)
    _spacer(doc, 6)


def note_block(doc, text, label='提示'):
    t = doc.add_table(rows=1, cols=1)
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    _fixed_layout(t, [TEXT_W_CM])
    tblPr = t._tbl.tblPr
    b = OxmlElement('w:tblBorders')
    for edge in ('top', 'left', 'bottom', 'right'):
        e = OxmlElement('w:' + edge)
        e.set(qn('w:val'), 'single')
        e.set(qn('w:sz'), '4')
        e.set(qn('w:space'), '0')
        e.set(qn('w:color'), 'D5DEEA')
        b.append(e)
    tblPr.append(b)
    _cell_margins(t, top=80, left=160, bottom=80, right=140)
    t.rows[0]._tr.get_or_add_trPr().append(_el('w:cantSplit', val='true'))
    cell = t.rows[0].cells[0]
    _shade(cell, 'F4F7FB')
    p = cell.paragraphs[0]
    p.style = doc.styles['NoteCN']
    r = p.add_run(label + '　')
    r.font.bold = True
    r.font.color.rgb = ACCENT
    p.add_run(text)
    _spacer(doc, 6)


def figure(doc, path, cap, max_w_cm=None, max_h_cm=7.8):
    w, h = Image.open(path).size
    max_w = max_w_cm if max_w_cm else TEXT_W_CM - 0.4
    scale = min(max_w / w, max_h_cm / h)
    width_cm = w * scale
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(8)
    p.paragraph_format.space_after = Pt(2)
    p.paragraph_format.keep_with_next = True
    p.add_run().add_picture(path, width=Cm(width_cm))
    caption(doc, cap, kind='fig')


def page_break(doc):
    from docx.enum.text import WD_BREAK
    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)


def hr(doc, color='C3CEDD', sz=6, space_before=6, space_after=6):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(space_before)
    p.paragraph_format.space_after = Pt(space_after)
    pPr = p._p.get_or_add_pPr()
    pBdr = OxmlElement('w:pBdr')
    bottom = OxmlElement('w:bottom')
    bottom.set(qn('w:val'), 'single')
    bottom.set(qn('w:sz'), str(sz))
    bottom.set(qn('w:space'), '1')
    bottom.set(qn('w:color'), color)
    pBdr.append(bottom)
    pPr.append(pBdr)


# ---------------------------------------------------------------- 页眉页脚

def _field(p, instr, size=9):
    r = p.add_run()
    r.font.size = Pt(size)
    r.font.name = LATIN
    r.font.color.rgb = GRAY
    _set_rfonts(r._r.get_or_add_rPr(), LATIN, SONG)
    fld1 = OxmlElement('w:fldChar')
    fld1.set(qn('w:fldCharType'), 'begin')
    it = OxmlElement('w:instrText')
    it.set(qn('xml:space'), 'preserve')
    it.text = instr
    fld2 = OxmlElement('w:fldChar')
    fld2.set(qn('w:fldCharType'), 'separate')
    t = OxmlElement('w:t')
    t.text = '1'
    fld3 = OxmlElement('w:fldChar')
    fld3.set(qn('w:fldCharType'), 'end')
    r._r.append(fld1)
    r._r.append(it)
    r._r.append(fld2)
    r._r.append(t)
    r._r.append(fld3)


def set_header(section, left_text, page_right=True, size=9):
    section.header.is_linked_to_previous = False
    hdr = section.header
    p = hdr.paragraphs[0]
    p.text = ''
    p.paragraph_format.space_after = Pt(2)
    # 内置 Header 样式自带居中/右对齐制表位，先清掉，否则页码会落在页面中间
    try:
        p.style.paragraph_format.tab_stops.clear_all()
    except Exception:
        pass
    p.paragraph_format.tab_stops.clear_all()
    p.paragraph_format.tab_stops.add_tab_stop(Cm(TEXT_W_CM), WD_TAB_ALIGNMENT.RIGHT)
    r = p.add_run(left_text)
    r.font.size = Pt(size)
    r.font.name = LATIN
    _set_rfonts(r._r.get_or_add_rPr(), LATIN, SONG)
    r.font.color.rgb = GRAY
    if page_right:
        p.add_run('\t')
        _field(p, ' PAGE ', size)
    # 页眉下加一条细线
    pPr = p._p.get_or_add_pPr()
    pBdr = OxmlElement('w:pBdr')
    bottom = OxmlElement('w:bottom')
    bottom.set(qn('w:val'), 'single')
    bottom.set(qn('w:sz'), '4')
    bottom.set(qn('w:space'), '1')
    bottom.set(qn('w:color'), 'C3CEDD')
    pBdr.append(bottom)
    pPr.append(pBdr)


def set_page_numbering(section, start=1):
    sectPr = section._sectPr
    pg = sectPr.find(qn('w:pgNumType'))
    if pg is None:
        pg = OxmlElement('w:pgNumType')
        sectPr.append(pg)
    pg.set(qn('w:start'), str(start))


def toc_line(doc, text, page, level=1, width_cm=None):
    style = 'TocLevel1' if level == 1 else 'TocLevel2'
    p = doc.add_paragraph(style=style)
    p.paragraph_format.tab_stops.add_tab_stop(
        Cm(width_cm if width_cm else TEXT_W_CM), WD_TAB_ALIGNMENT.RIGHT, WD_TAB_LEADER.DOTS)
    p.add_run(text)
    p.add_run('\t' + str(page))
    return p
