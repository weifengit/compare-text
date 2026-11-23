# -*- coding: utf-8 -*-
"""build_ai.py — 生成《AI相关声明.docx》。

声明用于说明软件开发过程中使用人工智能工具的情况：用了哪些工具、用在什么环节、
人工如何审查、原创性与权利归属如何保证。凡涉及本人实际情况的部分一律留【待填】。
"""

import os

from docx.shared import Pt, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT

import docx_kit as K

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT_DOCX = os.path.join(OUT_DIR, 'AI相关声明.docx')

SOFTWARE = 'CompareText文件对比软件'
VERSION = 'V1.4'


def build():
    doc = K.new_document(margins=(2.6, 2.4, 2.7, 2.6), header_cm=1.5)
    K.build_styles(doc)
    # 声明是签署用的表单，比手册排得紧一些，保证两页内收尾
    body = doc.styles['BodyCN']
    body.font.size = Pt(10.5)
    body.paragraph_format.line_spacing = 1.4
    body.paragraph_format.space_after = Pt(4)
    sect = doc.styles['SectTitle']
    sect.font.size = Pt(12.5)
    sect.paragraph_format.space_before = Pt(10)
    sect.paragraph_format.space_after = Pt(3)

    # 标题
    p = doc.add_paragraph(style='ChapTitle')
    p.paragraph_format.space_before = Pt(0)
    p.paragraph_format.space_after = Pt(2)
    p.add_run('关于使用人工智能工具辅助开发软件的情况声明')
    p2 = doc.add_paragraph(style='BodyCN')
    p2.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p2.paragraph_format.first_line_indent = Cm(0)
    r = p2.add_run('（计算机软件著作权登记用）')
    r.font.size = Pt(10.5)
    r.font.color.rgb = K.GRAY
    p2.paragraph_format.space_after = Pt(12)

    # 声明人信息
    K.table(doc, ['项目', '内容'], [
        ['声明人', '【待填：本人姓名，与身份证一致】'],
        ['身份证号', '【待填：身份证号码】'],
        ['软件名称', SOFTWARE],
        ['版本号', VERSION],
        ['开发完成日期', '2026-11-22'],
        ['声明日期', '【待填：年　月　日】'],
    ], [3.6, 11.4], None, first_col_bold=True)

    K.para(doc, '本人系上述软件的著作权人。现就本人在开发该软件过程中使用人工智能工具的情况，'
                '作出如下声明，并保证所陈述内容真实、准确、完整。')

    doc.add_paragraph('一、开发过程概述', style='SectTitle')
    K.para(doc, '本软件由本人独立构思、设计、编码、测试并持续维护，开发过程中使用了人工智能'
                '编程辅助工具。人工智能工具在本项目中仅作为辅助手段，用于提高编码与文档整理的效率，'
                '不参与软件的功能设计决策，也不替代本人对代码质量与功能正确性的判断。')

    doc.add_paragraph('二、使用的人工智能工具与用途', style='SectTitle')
    K.para(doc, '本人在开发过程中使用的人工智能工具及其用途如下表所列。'
                '如使用过多种工具，请逐行填写；未使用的行可删除。')
    K.table(doc, ['工具名称 / 版本', '使用环节', '具体用途', '占比'], [
        ['【待填：工具名】', '编码', '代码补全、片段生成、语法与 API 用法查询', '约 __%'],
        ['【待填：工具名】', '调试', '错误信息解释、排查思路提示', '约 __%'],
        ['【待填：工具名】', '文档', '用户手册措辞润色、注释整理', '约 __%'],
        ['', '', '', ''],
    ], [3.4, 2.4, 7.8, 2.4], None, first_col_bold=False)

    p = doc.add_paragraph(style='BodyCN')
    p.add_run('上述工具均由本人自行选择与使用，使用过程不涉及将他人享有著作权的代码、'
              '未公开的商业秘密或第三方保密资料输入工具。')

    doc.add_paragraph('三、人工参与与审查', style='SectTitle')
    K.steps(doc, [
        '需求与功能设计：软件的功能范围、交互流程、界面布局与数据结构均由本人独立确定，'
        '未由人工智能工具代为决策。',
        '架构与关键算法：模块划分、差异计算管线、版面标注映射、表格键列匹配、协同滚动等关键实现，'
        '由本人设计并逐行编写或改写。',
        '代码审查：对人工智能工具生成的每一段代码，本人均逐行阅读、理解并修改，'
        '确认其符合项目结构与编码规范后才纳入代码库。',
        '测试验证：软件配有自动化测试，覆盖差异计算、界面初始化、文件拖放、报告生成、表格对比等核心路径；'
        '所有提交均在测试通过后才合入。',
        '文档整理：用户手册与源程序材料由本人编写与核对，人工智能工具仅用于措辞与格式的辅助整理。',
    ])

    doc.add_paragraph('四、原创性与第三方代码', style='SectTitle')
    K.para(doc, '本软件为原创软件，不存在复制、抄袭、剽窃他人软件的情形，'
                '也未侵犯任何第三方的著作权、专利权、商标权或其他合法权益。'
                '软件中使用的开源组件均遵循其许可证使用，并在源程序中保留原始版权声明，主要包括：')
    K.bullets(doc, [
        'jsdiff（BSD-3-Clause）：文本差异计算。',
        'CodeMirror（MIT）：文本编辑区。',
        'pdf.js（Apache-2.0）：PDF 渲染与文字层提取。',
        '其余表格解析、文档预览与文字识别组件均按其各自许可证使用，详见项目依赖清单。',
    ])
    K.para(doc, '上述开源组件不属于本人独立编写的源程序，未计入申请表「源程序量」。')

    doc.add_paragraph('五、权利归属与责任承诺', style='SectTitle')
    K.para(doc, '本人确认：本软件的著作权归本人所有，本人有权就本软件申请计算机软件著作权登记；'
                '开发过程中使用人工智能工具的事实不影响本人对本软件享有的著作权。'
                '如本声明内容不实，或因此引发权属争议、侵权纠纷，本人愿承担相应的法律责任，'
                '并配合登记机构进行核查。')

    doc.add_paragraph('六、其他需要说明的情况', style='SectTitle')
    p = doc.add_paragraph(style='BodyCN')
    p.add_run('【待填：如无，填“无”；如有其他需要说明的 AI 使用情形，请在此补充。】')

    # 签署区：用段落 + ASCII 下划线，打印后可直接手签
    doc.add_paragraph()
    K.hr(doc, color='C3CEDD', sz=4, space_before=10, space_after=8)
    for label, blank in (
            ('声明人（签字）', '____________________________'),
            ('身份证号', '________________________________'),
            ('日期', '______ 年 ______ 月 ______ 日')):
        p = doc.add_paragraph(style='BodyCN')
        p.paragraph_format.first_line_indent = Cm(0)
        p.paragraph_format.space_after = Pt(8)
        r = p.add_run(label + '：')
        r.font.bold = True
        p.add_run(blank)

    doc.core_properties.title = 'AI相关声明 — %s %s' % (SOFTWARE, VERSION)
    doc.core_properties.author = SOFTWARE
    doc.core_properties.subject = '计算机软件著作权登记辅助材料'
    doc.save(OUT_DOCX)
    return OUT_DOCX


def to_pdf(docx_path):
    import subprocess
    import tempfile
    tmp = tempfile.mkdtemp(prefix='ai-pdf-')
    subprocess.run(['soffice', '--headless', '--convert-to', 'pdf', '--outdir', tmp, docx_path],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return os.path.join(tmp, os.path.splitext(os.path.basename(docx_path))[0] + '.pdf')


if __name__ == '__main__':
    path = build()
    import pymupdf
    pdf = to_pdf(path)
    d = pymupdf.open(pdf)
    print('AI 相关声明：%s' % path)
    print('页数：%d' % d.page_count)
