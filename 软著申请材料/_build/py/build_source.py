# -*- coding: utf-8 -*-
"""build_source.py — 生成《源程序》鉴别材料 docx。

规格：A4、每页 64 行、共 60 页（全本超过 60 页时取前 30 页 + 后 30 页），
页眉左侧软件全称与版本号、右侧页码，正文等宽 8pt、固定行距 11.5pt。
"""

import os
import re
import subprocess
import tempfile

import pymupdf
from docx.shared import Pt, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING, WD_BREAK

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
OUT_DIR = os.path.abspath(os.path.join(HERE, '..', '..'))

import docx_kit as K

SOFTWARE = 'CompareText文件对比软件'
VERSION = 'V1.4'
PAGE_LINES = 64
LINE_PT = 11.5
MAX_COLS = 88          # 显示列宽（中文按 2 列），留出字体替换的余量
FONT_PT = 8

INCLUDE_DIRS = ['src', 'src-tauri/src', 'plugins/dsh-compare-text', 'scripts']
INCLUDE_FILES = ['serve.js', 'index.html', 'styles.css', 'tools/render.js', 'tools/dsh-report.js']
EXCLUDE_PARTS = {'node_modules', 'dist', 'vendor', 'target', '.git', '软著申请材料'}
EXTS = {'.js', '.mjs', '.rs', '.html', '.css', '.yml', '.json', '.sh', '.ps1'}

OUT_DOCX = os.path.join(OUT_DIR, '源程序-%s%s.docx' % (SOFTWARE, VERSION))


def collect():
    files = []
    for d in INCLUDE_DIRS:
        base = os.path.join(ROOT, d)
        if not os.path.isdir(base):
            continue
        for cur, dirs, names in os.walk(base):
            dirs[:] = [x for x in dirs if x not in EXCLUDE_PARTS]
            for name in names:
                if os.path.splitext(name)[1] not in EXTS:
                    continue
                if re.search(r'package-lock', name):
                    continue
                files.append(os.path.relpath(os.path.join(cur, name), ROOT))
    for f in INCLUDE_FILES:
        p = os.path.join(ROOT, f)
        if os.path.isfile(p):
            files.append(f)
    return sorted(files, key=lambda s: s.replace(os.sep, '/'))


def read_lines(rel):
    with open(os.path.join(ROOT, rel), 'r', encoding='utf-8', errors='replace') as fh:
        raw = fh.read().replace('\r\n', '\n').replace('\r', '\n')
    out = [ln.replace('\t', '  ').rstrip() for ln in raw.split('\n')]
    while out and out[-1] == '':
        out.pop()
    return out


def dw(s):
    w = 0
    for ch in s:
        c = ord(ch)
        wide = (0x1100 <= c <= 0x115F or c in (0x2329, 0x232A) or
                0x2E80 <= c <= 0xA4CF and c != 0x303F or
                0xAC00 <= c <= 0xD7A3 or 0xF900 <= c <= 0xFAFF or
                0xFE30 <= c <= 0xFE6F or 0xFF00 <= c <= 0xFF60 or
                0xFFE0 <= c <= 0xFFE6)
        w += 2 if wide else 1
    return w


def wrap(line, maxw=MAX_COLS):
    if dw(line) <= maxw:
        return [line]
    out, rest = [], line
    while rest:
        if dw(rest) <= maxw:
            out.append(rest)
            break
        w, cut = 0, 0
        for i, ch in enumerate(rest):
            cw = 2 if dw(ch) == 2 else 1
            if w + cw > maxw:
                break
            w += cw
            cut = i + 1
        window = rest[:cut]
        brk = window.rfind(' ')
        if brk < maxw * 0.5:
            for sep in ('，', '。', '、', '；', '：', '）', ')', ' && ', ' || '):
                j = window.rfind(sep)
                if j >= maxw * 0.5:
                    brk = j + len(sep) - 1
                    break
        if brk >= maxw * 0.5:
            out.append(rest[:brk].rstrip())
            rest = '    ' + rest[brk + 1:].lstrip()
        else:
            out.append(window)
            rest = '    ' + rest[cut:]
    return out


def build_listing(files):
    full = []
    for idx, rel in enumerate(files):
        banner = '#' if re.search(r'\.(html|css|json|yml)$', rel) else '//'
        if idx:
            full.append('')
        full.append('%s ========== 文件：%s ==========' % (banner, rel.replace(os.sep, '/')))
        blank = 0
        for ln in read_lines(rel):
            if not ln.strip():
                blank += 1
                if blank > 1:
                    continue
                full.append('')
                continue
            blank = 0
            full.extend(wrap(ln))
    return full


def build_docx(lines):
    doc = K.new_document(margins=(1.5, 1.2, 2.0, 1.6), header_cm=0.9, footer_cm=0.5)
    # 正文样式：等宽、固定行距、无首行缩进
    K.add_para_style(doc, 'CodeLine', size=FONT_PT, east=K.SONG, latin='Courier New',
                     align=WD_ALIGN_PARAGRAPH.LEFT, line=1.0, before=0, after=0)
    style = doc.styles['CodeLine']
    style.paragraph_format.line_spacing = Pt(LINE_PT)
    style.paragraph_format.line_spacing_rule = WD_LINE_SPACING.EXACTLY
    style.paragraph_format.widow_control = False

    pages = [lines[i:i + PAGE_LINES] for i in range(0, len(lines), PAGE_LINES)]
    for pi, page in enumerate(pages):
        for li, text in enumerate(page):
            p = doc.add_paragraph(style='CodeLine')
            if li == 0 and pi > 0:
                p.paragraph_format.page_break_before = True
            p.add_run(text)
    sec = doc.sections[0]
    sec.different_first_page_header_footer = False
    K.set_header(sec, '%s %s 源程序' % (SOFTWARE, VERSION), page_right=True, size=9)

    doc.core_properties.title = '%s %s 源程序' % (SOFTWARE, VERSION)
    doc.core_properties.author = SOFTWARE
    doc.core_properties.subject = '计算机软件著作权登记鉴别材料 · 源程序'
    doc.save(OUT_DOCX)
    return pages


def to_pdf(docx_path):
    tmp = tempfile.mkdtemp(prefix='source-pdf-')
    subprocess.run(['soffice', '--headless', '--convert-to', 'pdf', '--outdir', tmp, docx_path],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return os.path.join(tmp, os.path.splitext(os.path.basename(docx_path))[0] + '.pdf')


def verify(pdf_path, submit):
    """逐页核对：64 个行槽、每行落在网格上、页眉与右上角页码齐全。"""
    page_total = len(submit) // PAGE_LINES
    doc = pymupdf.open(pdf_path)
    bad_lines, bad_header = [], []
    page_baselines = []
    for i, page in enumerate(doc):
        ys = set()
        for block in page.get_text('dict')['blocks']:
            for line in block.get('lines', []):
                for span in line['spans']:
                    if span['bbox'][3] > 40:          # 排除页眉
                        ys.add(round(span['origin'][1], 1))
        page_baselines.append(sorted(ys))

    base = min(ys[0] for ys in page_baselines if ys)
    for i, ys in enumerate(page_baselines):
        page = doc[i]
        expected = submit[i * PAGE_LINES:(i + 1) * PAGE_LINES]
        want = [k for k, t in enumerate(expected) if t.strip()]
        got = []
        for y in ys:
            k = (y - base) / LINE_PT
            if abs(k - round(k)) > 0.06:            # 不在 11.5pt 网格上
                bad_lines.append((i + 1, 'off-grid %.2f' % k))
            got.append(int(round(k)))
        if len(got) != len(want) or got != want:
            bad_lines.append((i + 1, '%d 行（应为 %d）' % (len(got), len(want))))

        txt = ''.join(page.get_text().split())
        if ('%s%s源程序' % (SOFTWARE, VERSION)) not in txt:
            bad_header.append(i + 1)
        nums = [sp['bbox'][0] for block in page.get_text('dict')['blocks']
                for line in block.get('lines', []) for sp in line['spans']
                if sp['text'].strip().isdigit() and sp['bbox'][1] < 40]
        if not nums or min(nums) < page.rect.width * 0.80:
            bad_header.append(i + 1)
    return {
        'pages': doc.page_count,
        'expect': page_total,
        'bad_lines': bad_lines[:10],
        'bad_header': sorted(set(bad_header)),
    }


def main():
    files = collect()
    raw_total = sum(len(read_lines(f)) for f in files)
    full = build_listing(files)
    per_page = PAGE_LINES

    if len(full) > 60 * per_page:
        head = full[:30 * per_page]
        end = len(full) - (len(full) % per_page)
        tail = full[end - 30 * per_page:end]
        submit = head + tail
        mode = '前 30 页 + 后 30 页'
        dropped = len(full) - end
    else:
        submit = full + [''] * ((-len(full)) % per_page)
        mode = '全本提交'
        dropped = 0

    pages = build_docx(submit)
    pdf = to_pdf(OUT_DOCX)
    res = verify(pdf, submit)

    print('源程序：%s' % OUT_DOCX)
    print('源文件数：%d，原始行数：%d，打印行数：%d（含横幅与折行）' % (len(files), raw_total, len(full)))
    print('交存方式：%s，共 %d 页，每页 %d 行' % (mode, res['pages'], per_page))
    if dropped:
        print('为保证页末满行，尾部舍弃 %d 行（不足一页的部分）' % dropped)
    import json
    total_pages = -(-len(full) // PAGE_LINES)
    stats_path = os.path.join(HERE, 'build_stats.json')
    data = {}
    if os.path.exists(stats_path):
        with open(stats_path, encoding='utf-8') as fh:
            data = json.load(fh)
    data.update(source_pages=res['pages'], source_full_pages=total_pages,
                source_lines=raw_total, source_files=len(files))
    with open(stats_path, 'w', encoding='utf-8') as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2, sort_keys=True)
    print('页数校验：%d / 期望 %d %s' % (res['pages'], res['expect'],
                                   '✓' if res['pages'] == res['expect'] else '✗'))
    print('行数异常页：%s' % (res['bad_lines'] or '无'))
    print('页眉/页码异常页：%s' % (res['bad_header'] or '无'))
    return 0 if (res['pages'] == res['expect'] and not res['bad_lines'] and not res['bad_header']) else 1


if __name__ == '__main__':
    raise SystemExit(main())
