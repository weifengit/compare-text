# -*- coding: utf-8 -*-
"""build_ai.py — 生成《AI相关声明.docx》。

格式与行文参照《AI相关声明-参考.docx》：
标题「软件合法合规及原创性声明（生成式人工智能相关）」，致中国版权保护中心，
分「类别与性质 / 原创性 / 生成内容合法合规 / 承诺」四节，
事实部分换成 CompareText文件对比软件 V1.4 的实际情况。
"""

import os

from docx.shared import Pt, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING

import docx_kit as K

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT_DOCX = os.path.join(OUT_DIR, 'AI相关声明.docx')

SOFTWARE = 'CompareText文件对比软件'
VERSION = 'V1.4'
APPLICANT = '钟文峰'

# 正文按“段落 / 小节标题 / 编号条目 / 括注条目”组织，编号由内容直接写出，
# 与参考文档一致，不在渲染时自动编号（避免与条文引用对不上）。
OPENING = (
    '申请人 ' + APPLICANT + '（以下简称“申请人”）就申请登记的软件《' + SOFTWARE +
    '》（版本号：' + VERSION + '，登记流水号：【待填：系统受理后生成的登记流水号】），'
    '以下简称“该软件”），依据《生成式人工智能服务管理暂行办法》（以下简称《暂行办法》）'
    '及《计算机软件保护条例》的相关规定，就该软件的类别性质、作品原创性、'
    '生成式人工智能服务与生成内容的合法合规情况，作出如下声明：'
)

SECTIONS = [
    ('一、该软件的类别与性质', [
        ('p', '1. 该软件是运行于浏览器与本机桌面环境（同一套代码可打包为 macOS、Windows、'
              'Linux 桌面程序）的本地文件差异比对应用软件，属人工智能应用软件、开发工具类软件。'
              '其功能为文本、PDF、Word、Excel、网页与 Markdown 的差异比对、'
              '差异在原文版面上的标注、对比报告导出与批量处理等，'
              '均属软件开发与办公文档处理效率工具范畴；'
              '该软件不从事文艺创作、新闻出版、影视制作等内容生产活动。'),
        ('p', '2. 该软件不含生成式人工智能模型：未内置任何大语言模型、图像、音频、视频生成模型'
              '或模型权重，未开展预训练、优化训练（微调）、数据标注等训练活动。'
              '该软件内置的文字识别（OCR）模型仅用于把扫描件 PDF 的图像像素还原为文字，'
              '属判别式识别模型，不具备内容生成能力，也不用于生成文本、图片、音频或视频。'),
        ('p', '3. 该软件不属于向境内公众提供生成式人工智能服务的提供者，理由如下：'),
        ('p', '（1）该软件以本地服务或桌面安装包形式安装于使用者本机或其自行控制的私有环境运行。'
              '申请人未运营任何面向社会公众的统一模型推理服务端，'
              '未设供公众调用其内容生成能力的网页、客户端或可编程接口；'),
        ('p', '（2）该软件如需借助大模型能力（例如作为 DeepSeek Harness 的技能或插件，'
              '由宿主中的模型把自然语言描述的比对需求转换为批量比对任务），'
              '系通过宿主环境或使用者自行配置、自行付费的第三方大模型服务接口完成。'
              '模型服务由相应的服务提供者提供并承担其责任，该软件仅处于调用方（使用者）地位；'
              '而比对计算、版面标注与报告生成均由确定性的本机代码完成，不依赖模型输出；'),
        ('p', '（3）该软件以源代码及安装包形式公开发布，供他人在自有环境中安装使用，'
              '属软件产品分发，不等同于由申请人向公众提供生成式人工智能服务。'
              '使用者各自接入模型服务，并依其使用场景自行履行相应合规义务；'),
        ('p', '（4）依《暂行办法》第二条第三款，行业组织、企业、教育和科研机构、公共文化机构、'
              '有关专业机构等研发、应用生成式人工智能技术，未向境内公众提供生成式人工智能服务的，'
              '不适用本办法的规定；依第二十二条第三项，该软件的地位属生成式人工智能服务使用者。'),
        ('p', '4. 综上，该软件无需按照《暂行办法》办理生成式人工智能服务备案'
              '（含安全评估、算法备案及其变更、注销手续），亦无相应备案证明文件可提交。'),
    ]),
    ('二、软件作品的原创性', [
        ('p', '1. 该软件由申请人独立开发完成，开发方式为单独开发，权利取得方式为原始取得，'
              '权利范围为全部权利。'),
        ('p', '2. 开发过程中，申请人使用生成式人工智能工具作为辅助编码手段。'
              '该等使用仅限于代码片段建议、文档措辞润色等辅助性环节。'
              '软件的需求定义、总体架构、模块划分、数据结构、接口契约、交互逻辑与关键算法'
              '（含差异计算管线、版面标注映射、表格键列匹配、跨区域协同滚动、文字识别集成）'
              '均由申请人自主确定，并经申请人逐项审阅、修改、整合与验证后，'
              '形成最终交付的源代码与文档。'),
        ('p', '3. 该软件的源代码与文档系申请人独立创作完成，具有独创性，'
              '构成受《计算机软件保护条例》保护的作品，著作权由申请人享有。'),
        ('p', '4. 该软件源代码与文档中不包含侵犯他人著作权、专利权、商业秘密、肖像权、名誉权、'
              '荣誉权、隐私权及个人信息权益的内容。所使用的第三方开源组件'
              '（如 jsdiff、CodeMirror、pdf.js、ExcelJS、mammoth、docx-preview、onnxruntime-web 等）'
              '均依其原有开源许可使用，并保留了相应权属声明，未删除或篡改他人的权利管理信息。'),
    ]),
    ('三、生成内容的合法合规', [
        ('p', '1. 该软件自身不生成文本、图片、音频、视频等内容，亦不将任何生成内容向不特定公众'
              '发布或传播。该软件的输出是对使用者所选文件的差异比对结果与报告，'
              '其内容取决于输入文件本身，由确定性的比对算法产生，软件不进行改写或再创作。'
              '经由该软件转达的模型输出（仅在使用者通过宿主调用大模型时发生），'
              '其内容由所接入的模型服务提供者生成，并按该提供者的服务协议与安全机制接受管理。'
              '该软件不篡改、不伪造模型输出，亦不对其加工后对外发布。'),
        ('p', '2. 该软件不含利用生成式人工智能生成虚假信息、有害信息的功能设计，'
              '未设置绕过内容安全管理、批量生成违法违规内容的能力。'
              '软件在界面与交互上对自动化流程设有确认与干预环节'
              '（如取消修整、恢复原文、导出前预览、批量任务先确认参数再执行），'
              '使模型输出在采用前可被人工审阅。'),
        ('p', '3. 该软件运行中产生的数据（比对内容、忽略选项、历史记录、文字识别缓存、'
              '网页缓存、报告文件等）均保存在使用者本机的本地存储或使用者所选目录中。'
              '申请人不设服务器收集、不回传、不对外提供上述数据；'
              '该软件未内置任何面向申请人的遥测、埋点或数据上报通道。'
              '网页对比功能仅在用户主动输入网址时，经本机接口代理取回页面并按 24 小时'
              '缓存于本机，默认拒绝访问内网地址。'),
        ('p', '4. 该软件不采集与服务无关的个人信息。对确需在本机保存的配置数据，仅在本地读写，'
              '不向第三方传输。模型服务凭据由使用者自行配置，该软件不将其写入日志、'
              '不写入提交历史、不随仓库分发。'),
    ]),
    ('四、承诺', [
        ('p', '申请人承诺：本声明所述内容真实、准确、完整，不存在虚假陈述或隐瞒事实。'
              '如经查证存在不实，申请人自愿承担由此产生的全部法律责任，'
              '包括但不限于著作权登记被撤销，以及相应的民事、行政乃至刑事责任。'),
        ('p', '申请人同时承诺：该软件今后的业务形态如发生变化，一旦向境内公众提供生成式'
              '人工智能服务，申请人将依法另行履行安全评估与备案（含变更、注销备案）手续，'
              '并按规定对生成内容进行标识，落实内容安全与个人信息保护义务。'),
        ('p', '特此声明。'),
    ]),
]


def build():
    doc = K.new_document(margins=(2.5, 2.5, 2.5, 2.5), header_cm=1.5, footer_cm=1.5)
    K.build_styles(doc)

    # 参考文档：正文 12pt、行距约 16pt、段间无额外间距
    body = doc.styles['BodyCN']
    body.font.size = Pt(12)
    body.paragraph_format.line_spacing = Pt(15.2)
    body.paragraph_format.line_spacing_rule = WD_LINE_SPACING.EXACTLY
    body.paragraph_format.space_before = Pt(0)
    body.paragraph_format.space_after = Pt(0)

    # 标题：18pt 加粗居中
    K.add_para_style(doc, 'DeclTitle', size=18, east=K.SONG, bold=True,
                     align=WD_ALIGN_PARAGRAPH.CENTER, line=1.5, before=6, after=18)
    K.add_para_style(doc, 'DeclSub', size=12, align=WD_ALIGN_PARAGRAPH.CENTER,
                     line=1.5, before=0, after=14)
    h2 = K.add_para_style(doc, 'DeclH2', size=12, east=K.SONG, bold=True,
                          align=WD_ALIGN_PARAGRAPH.JUSTIFY, line=1.5, before=8, after=0,
                          indent_chars=2)
    h2.paragraph_format.line_spacing = Pt(15.2)
    h2.paragraph_format.line_spacing_rule = WD_LINE_SPACING.EXACTLY
    K.add_para_style(doc, 'DeclSign', size=12, line=1.5, before=0, after=0)

    doc.add_paragraph('软件合法合规及原创性声明', style='DeclTitle')
    doc.add_paragraph('（生成式人工智能相关）', style='DeclSub')

    p = doc.add_paragraph('中国版权保护中心：', style='BodyCN')
    p.paragraph_format.first_line_indent = Cm(0)

    doc.add_paragraph(OPENING, style='BodyCN')

    for title, items in SECTIONS:
        doc.add_paragraph(title, style='DeclH2')
        for _, text in items:
            doc.add_paragraph(text, style='BodyCN')

    # 签署区
    for i, line in enumerate(('著作权人（签字／盖章）：____________________',
                              '证件号码／统一社会信用代码：____________________',
                              '日期：__________年________月________日')):
        p = doc.add_paragraph(line, style='DeclSign')
        p.paragraph_format.space_before = Pt(16 if i == 0 else 0)
        p.paragraph_format.space_after = Pt(4)
        p.paragraph_format.line_spacing = Pt(15.2)

    doc.core_properties.title = 'AI相关声明 — %s %s' % (SOFTWARE, VERSION)
    doc.core_properties.author = APPLICANT
    doc.core_properties.subject = '软件合法合规及原创性声明（生成式人工智能相关）'
    doc.save(OUT_DOCX)
    return OUT_DOCX


if __name__ == '__main__':
    import subprocess
    import tempfile

    import pymupdf

    path = build()
    tmp = tempfile.mkdtemp(prefix='ai-pdf-')
    subprocess.run(['soffice', '--headless', '--convert-to', 'pdf', '--outdir', tmp, path],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    pdf = os.path.join(tmp, os.path.splitext(os.path.basename(path))[0] + '.pdf')
    d = pymupdf.open(pdf)
    print('AI 相关声明：%s' % path)
    print('页数：%d' % d.page_count)
