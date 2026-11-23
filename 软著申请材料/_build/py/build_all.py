# -*- coding: utf-8 -*-
"""build_all.py — 依次重跑四份材料并汇总自检结果。

只做编排：每个构建脚本自己负责生成与自检，任一脚本返回非零即视为失败。
"""

import subprocess
import sys

STEPS = [
    ('用户手册', ['build_manual.py']),
    ('源程序', ['build_source.py']),
    ('申请表填写底稿', ['build_form.py']),
    ('AI 相关声明', ['build_ai.py']),
]


def main():
    failed = []
    for name, cmd in STEPS:
        print('=' * 60)
        print('▶ %s' % name)
        r = subprocess.run([sys.executable] + cmd, cwd=__file__.rsplit('/', 1)[0])
        if r.returncode != 0:
            failed.append(name)
    print('=' * 60)
    if failed:
        print('失败：%s' % '、'.join(failed))
        return 1
    print('全部材料生成并通过自检。')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
