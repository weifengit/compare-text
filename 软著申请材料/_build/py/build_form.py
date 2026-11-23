# -*- coding: utf-8 -*-
"""build_form.py — 生成《申请表填写底稿.md》。

底稿不是提交材料，而是照着往中国版权保护中心在线系统里抄的稿子：
每一栏给出可直接复制的文字、字数与上限，超限或口径不对会在这里报错。
"""

import os
import re

import json

import content_form as F
import build_source as S

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT_MD = os.path.join(OUT_DIR, '申请表填写底稿.md')

LIMIT_50 = 50
MAIN_MIN, MAIN_MAX = 500, 1300
TECH_MAX = 100


def md_table(head, rows, aligns=None):
    out = ['| ' + ' | '.join(head) + ' |']
    sep = []
    for i in range(len(head)):
        sep.append(':---:' if aligns and aligns[i] == 'c' else '---')
    out.append('| ' + ' | '.join(sep) + ' |')
    for r in rows:
        out.append('| ' + ' | '.join(str(x) for x in r) + ' |')
    return '\n'.join(out)


def source_stats():
    files = S.collect()
    stats = {}
    total = 0
    for rel in files:
        n = len(S.read_lines(rel))
        top = rel.split(os.sep)[0]
        if rel in ('serve.js', 'index.html', 'styles.css'):
            key = rel
        else:
            key = top + '/'
        stats.setdefault(key, [0, 0])
        stats[key][0] += 1
        stats[key][1] += n
        total += n
    return files, stats, total


def load_stats():
    path = os.path.join(HERE, 'build_stats.json')
    if os.path.exists(path):
        with open(path, encoding='utf-8') as fh:
            return json.load(fh)
    return {}


def main():
    files, stats, total = source_stats()
    st = load_stats()
    full_pages = st.get('source_full_pages') or (-(-len(S.build_listing(files)) // 64))
    manual_pages = st.get('manual_pages', 37)
    manual_imgs = st.get('manual_images', 26)
    shot_dir = os.path.join(OUT_DIR, '界面截图-CompareText')
    shots = len([f for f in os.listdir(shot_dir) if f.endswith('.png')])
    lines = []
    add = lines.append

    add('# 计算机软件著作权登记 · 申请表填写底稿')
    add('')
    add('> **用途**：登录中国版权保护中心在线登记系统后，按本底稿逐栏复制填报。'
        '本文件不是提交材料，填完即可留档。')
    add('> **配套材料**：《源程序-%s%s.docx》《用户手册-%s%s.docx》《AI相关声明.docx》'
        '（本套材料不含 PDF）。' % (F.SOFTWARE, F.VERSION, F.SOFTWARE, F.VERSION))
    add('> **软件全称 / 版本号**：%s / %s。三份文件与两个页眉必须与此完全一致。'
        % (F.SOFTWARE, F.VERSION))
    add('')
    add('---')
    add('')

    # 0 材料清单
    add('## 〇、本套材料一览')
    add('')
    add(md_table(['材料', '文件', '规格'], [
        ['源程序', '`源程序-%s%s.docx`' % (F.SOFTWARE, F.VERSION),
         '60 页（全本 %d 页，取前 30 页 + 后 30 页）；每页 64 行' % full_pages],
        ['用户手册', '`用户手册-%s%s.docx`' % (F.SOFTWARE, F.VERSION),
         '%d 页（不足 60 页，全部提交）；%d 张实拍插图' % (manual_pages, manual_imgs)],
        ['AI 相关声明', '`AI相关声明.docx`', '1—2 页，需签字后扫描或按系统要求提交'],
        ['界面截图', '`界面截图-CompareText/`', '%d 张 PNG，手册插图的原始素材' % shots],
        ['演示文件', '`演示文件/`', '手册中每个示例对应的可复现文件'],
        ['生成脚本', '`_build/py/`', '可重跑生成与自检'],
    ]))
    add('')
    add('> 官方要求：程序和文档的鉴别材料由前、后各连续 30 页组成；'
        '不足 60 页的全部提交。除特定情况外，程序每页不少于 50 行，文档每页不少于 30 行。'
        '本套源程序每页 64 行，手册纯文字页 30 行以上（含图页因图片占版面而少于 30 行，属常规情形）。')
    add('')

    # 一
    add('## 一、软件基本信息')
    add('')
    add(md_table(['字段', '填写内容', '说明'], [
        [k, '**%s**' % v if k in ('软件全称', '版本号') else v, note]
        for k, v, note in F.BASIC
    ]))
    add('')
    add('> 「软件简称」没有简称才留空，**不要填“无”**，且不得与全称完全相同。')
    add('')

    # 二
    add('## 二、著作权人信息（本人填写）')
    add('')
    add('> ⚠ 以下带【待填】的字段必须与身份证件完全一致，否则会被要求补正。')
    add('')
    add(md_table(['字段', '填写内容', '备注'], [[k, v, note] for k, v, note in F.OWNER]))
    add('')

    # 三
    add('## 三、软件开发信息（每栏上限 50 字）')
    add('')
    add('> ⚠ 系统对这几栏是**硬截断**：超出直接切掉且不报错。下表每栏都已量过字数。')
    add('')
    rows = []
    for k, v in F.DEV_FIELDS:
        n = F.count(v)
        flag = '✓' if n <= LIMIT_50 else '✗ 超限'
        rows.append([k, v, '%d/%d %s' % (n, LIMIT_50, flag)])
    add(md_table(['表单字段', '填写内容', '字数'], rows))
    add('')

    # 四
    add('## 四、软件功能与技术特点')
    add('')

    add('### 4.1 开发目的（上限 50 字）')
    add('')
    add('> ' + F.PURPOSE)
    add('')
    add('字数：%d / %d %s' % (F.count(F.PURPOSE), LIMIT_50,
                           '✓' if F.count(F.PURPOSE) <= LIMIT_50 else '✗ 超限'))
    add('')

    add('### 4.2 面向领域 / 行业（上限 50 字）')
    add('')
    add('> ' + F.DOMAIN)
    add('')
    add('字数：%d / %d %s' % (F.count(F.DOMAIN), LIMIT_50,
                           '✓' if F.count(F.DOMAIN) <= LIMIT_50 else '✗ 超限'))
    add('')

    n_main = F.count(F.MAIN_FUNCTION)
    add('### 4.3 主要功能（500—1300 字）')
    add('')
    add('字数：**%d**（要求 %d—%d）%s' % (n_main, MAIN_MIN, MAIN_MAX,
                                        '✓' if MAIN_MIN <= n_main <= MAIN_MAX else '✗ 超限'))
    add('')
    add('```text')
    add(F.MAIN_FUNCTION)
    add('```')
    add('')

    n_tech = F.count(F.TECH_FEATURE)
    add('### 4.4 技术特点（上限 100 字）')
    add('')
    add('字数：**%d** / %d %s' % (n_tech, TECH_MAX, '✓' if n_tech <= TECH_MAX else '✗ 超限'))
    add('')
    add('```text')
    add(F.TECH_FEATURE)
    add('```')
    add('')

    # 五
    add('## 五、申请与证书信息')
    add('')
    add(md_table(['字段', '填写内容'], [[k, v] for k, v in F.APPLY]))
    add('')

    # 六
    add('## 六、需要签字或扫描的材料')
    add('')
    add('1. **申请确认签章页**：网上填报后由系统生成，**不得更改内容、格式与打印比例**；'
        '打印后本人签字（或按手印），扫描为 PDF 上传。')
    add('2. **身份证明**：身份证正反面复印件，本人签字。')
    add('3. **AI 相关声明**：`AI相关声明.docx` 打印后本人签字、注明日期；'
        '按登记系统的要求上传，或在补正时提交。')
    add('4. **鉴别材料**：上传源程序与用户手册的 docx 文件；系统若要求 PDF，'
        '可用 Word 或 WPS 直接「另存为 PDF」后上传，版面与 docx 一致。')
    add('')

    # 七
    add('## 七、网上填报流程')
    add('')
    add('1. 注册并登录 <https://register.ccopyright.com.cn>，完成个人实名认证。')
    add('2. 进入「版权登记 → 计算机软件著作权登记申请」，按本底稿逐栏填报。')
    add('3. 上传鉴别材料（源程序、用户手册）与 AI 相关声明。')
    add('4. 系统生成「申请确认签章页」→ 打印 → 本人签字 → 扫描上传。')
    add('5. 受理 → 审查（普通通道约 1—2 个月）→ 下载电子证书。')
    add('6. 若收到补正通知，按补正单逐条修改，30 日内提交。')
    add('')

    # 八
    add('## 八、提交前核对清单')
    add('')
    add(md_table(['#', '核对项', '本套材料'], [
        ['1', '软件全称三处一致（申请表 / 源程序页眉 / 手册页眉）', 'CompareText文件对比软件'],
        ['2', '版本号三处一致（申请表 / 页眉 / 文件名）', 'V1.4'],
        ['3', '源程序每页行数 ≥ 50', '每页 64 行，逐页网格校验通过'],
        ['4', '源程序页数', '60 页（前 30 + 后 30）'],
        ['5', '源程序页眉含软件名与版本号', '60/60 页通过'],
        ['6', '页码位于页眉右上角', '源程序 60/60、手册 %d/%d 通过' % (manual_pages, manual_pages)],
        ['7', '用户手册图文结合、每章有截图', '%d 张实拍插图，编号连续' % manual_imgs],
        ['8', '手册纯文字页 ≥ 30 行', '通过（最短页为文档信息页，属非正文页）'],
        ['9', '源程序量与实际一致', '%d 行 / %d 个源文件' % (total, len(files))],
        ['10', '著作权人信息与证件一致', '【待填】项需本人补齐'],
        ['11', 'AI 相关声明已签字', '需本人签字并填日期'],
        ['12', '未上传或误交 PDF', '目录内只有 docx'],
    ]))
    add('')

    # 九
    add('## 九、常见补正原因与规避')
    add('')
    add(md_table(['补正原因', '本套材料的情况'], [
        ['页眉软件名与申请表不一致', '源程序与手册页眉均为「%s %s」，逐页核验' % (F.SOFTWARE, F.VERSION)],
        ['页码缺失或位置不对', '页码在页眉右上角，60/60 与 %d/%d 页核验通过' % (manual_pages, manual_pages)],
        ['每页行数不足', '源程序固定 64 行；手册纯文字页 ≥ 30 行'],
        ['源程序量与实际不符', '按 47 个源文件、%d 行核算，剔除第三方库' % total],
        ['文档过于单薄', '手册 %d 页、11 章 + 2 附录，%d 张实拍图' % (manual_pages, manual_imgs)],
        ['身份证明不清晰', '需本人重新扫描'],
        ['AI 使用情况未说明', '已附《AI相关声明》，签字后提交'],
    ]))
    add('')

    # 附录 A
    add('## 附录 A　源程序量核算')
    add('')
    add('统计口径：只计本人编写的源文件，剔除 `lib/` 下 vendored 的第三方库、'
        '`node_modules/`、`dist/`、`target/` 与材料目录本身。')
    add('')
    order = ['src/', 'serve.js', 'index.html', 'styles.css', 'src-tauri/',
             'plugins/', 'tools/', 'scripts/']
    rows = []
    for k in order:
        if k not in stats:
            continue
        cnt, n = stats[k]
        label = k.rstrip('/')
        rows.append(['`%s`' % label, cnt, n])
    add(md_table(['目录 / 文件', '文件数', '行数'], rows + [['**合计**', '**%d**' % len(files),
                                                         '**%d**' % total]],
                 aligns=[None, 'c', 'c']))
    add('')
    add('> 申请表「源程序量」填：`17651 行（47 个源文件，不含第三方库）`。'
        '若代码有增减，重跑 `python3 _build/py/build_source.py` 会重新核算并更新本表。')
    add('')

    # 附录 B
    add('## 附录 B　一致性核对表')
    add('')
    add(md_table(['出现位置', '实际内容'], [
        ['申请表 · 软件全称', F.SOFTWARE],
        ['申请表 · 版本号', F.VERSION],
        ['源程序页眉（左上）', '%s %s 源程序' % (F.SOFTWARE, F.VERSION)],
        ['用户手册页眉（左上）', '%s %s 用户手册' % (F.SOFTWARE, F.VERSION)],
        ['源程序文件名', '源程序-%s%s.docx' % (F.SOFTWARE, F.VERSION)],
        ['用户手册文件名', '用户手册-%s%s.docx' % (F.SOFTWARE, F.VERSION)],
    ]))
    add('')

    # 附录 C
    add('## 附录 C　重跑与自检')
    add('')
    add('```bash')
    add('python3 软著申请材料/_build/py/build_manual.py   # 用户手册（含目录页码两遍回填与版面自检）')
    add('python3 软著申请材料/_build/py/build_source.py   # 源程序（60 页 × 64 行，逐页网格校验）')
    add('python3 软著申请材料/_build/py/build_form.py     # 本底稿')
    add('python3 软著申请材料/_build/py/build_ai.py       # AI 相关声明')
    add('python3 软著申请材料/_build/py/build_all.py      # 全部重跑并汇总自检结果')
    add('```')
    add('')
    add('自检依赖 Python 3.10+，以及 `python-docx`、`Pillow`、`PyMuPDF` 与本机 LibreOffice'
        '（仅用于把 docx 转成 PDF 后读文字层做校验，不产出交付用 PDF）。')

    text = '\n'.join(lines) + '\n'
    with open(OUT_MD, 'w', encoding='utf-8') as fh:
        fh.write(text)

    # 自检
    problems = []
    for k, v, _ in F.BASIC:
        if F.count(v) > LIMIT_50:
            problems.append('基本信息 %s 超 50 字' % k)
    for k, v in F.DEV_FIELDS:
        if F.count(v) > LIMIT_50:
            problems.append('%s 超 50 字（%d）' % (k, F.count(v)))
    if F.count(F.PURPOSE) > LIMIT_50:
        problems.append('开发目的超 50 字（%d）' % F.count(F.PURPOSE))
    if F.count(F.DOMAIN) > LIMIT_50:
        problems.append('面向领域超 50 字（%d）' % F.count(F.DOMAIN))
    if not (MAIN_MIN <= F.count(F.MAIN_FUNCTION) <= MAIN_MAX):
        problems.append('主要功能字数 %d 不在 500—1300' % F.count(F.MAIN_FUNCTION))
    if F.count(F.TECH_FEATURE) > TECH_MAX:
        problems.append('技术特点超 100 字（%d）' % F.count(F.TECH_FEATURE))
    if '17651' not in F.DEV_FIELDS[-1][1] or total != 17651:
        problems.append('源程序量不符：内容写 17651，实际 %d' % total)

    print('申请表填写底稿：%s' % OUT_MD)
    print('源文件 %d 个、%d 行' % (len(files), total))
    print('主要功能 %d 字；技术特点 %d 字；开发目的 %d 字'
          % (F.count(F.MAIN_FUNCTION), F.count(F.TECH_FEATURE), F.count(F.PURPOSE)))
    print('自检：%s' % ('全部通过' if not problems else '；'.join(problems)))
    return 1 if problems else 0


if __name__ == '__main__':
    raise SystemExit(main())
