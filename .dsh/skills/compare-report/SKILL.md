---
name: compare-report
description: 文本对比报告生成。把用户的自然语言对比需求（两个文件夹/文件名单、六个忽略选项、输出位置、报告标题）转成任务 JSON，调用本仓库 tools/dsh-report.js 无头产出自包含 HTML 对比报告（差异颜色标注 + 原始文件逐页快照，双击即看）。支持 docx / pdf / 纯文本，扫描版 PDF 自动内置 OCR 识别（无需用户装任何环境），超过 10 对自动分卷。
whenToUse: 用户想用对话方式对比文档并拿到报告，尤其是批量场景（两个文件夹、一批文件、不想开 UI 逐个看）。例如"把 a 和 b 两个文件夹的合同按文件名两两对比出报告""对比这几份文件的差异"。扫描版（无文字层）PDF 也能对比——工具内置 WASM OCR 自动识别。
---

# compare-report：对话驱动文本对比并产出 HTML 报告

## 这个 skill 做什么

本仓库是一个离线文本对比工具。`tools/dsh-report.js` 是它的无头入口：吃一份**任务 JSON**，无人工介入地完成对比，产出一个或多个**自包含 HTML 报告**（CSS/JS/截图全内联，接收方零安装双击即看）。

你的职责：把用户的自然语言需求转成任务 JSON，写临时文件，执行命令，解读结构化结果回复用户。**不要自己写规则解析用户需求，也不要自己切分卷**——分卷由工具自动完成。

## 前置条件

- 工作目录 = 本仓库根目录（`tools/dsh-report.js`、`tools/render.js` 必须存在）
- 机器装有 Edge 或 Chrome（无头截图用；缺失时工具会以退出码 2 + 结构化错误返回）
- 全程离线，不要把任务内容或报告上传到任何网络地址

## 调用方式

```bash
node tools/dsh-report.js --task <任务文件.json>
```

- **stdout 最后一行**是结构化 JSON（前面可能有 render.js 透传的日志，取最后一行解析）：
  ```json
  { "ok": true,
    "reports": [{ "output": "/abs/report.html", "stats": {...}, "warnings": [] }],
    "stats": { "pairs": 2, "added": 10, "removed": 3, "changed": 5 },
    "warnings": [] }
  ```
- **退出码**：0 全部成功；1 任务错误（含部分文件对失败、输入非法）；2 环境不可用（缺浏览器/render.js）。失败时 `warnings` 里是原因，直接向用户解释，不要重试相同输入。
- 任务文件写到系统临时目录（如 `$TMPDIR/dsh-task-xxx.json`），不要写进仓库。

## 任务 JSON schema

```json
{
  "title": "报告标题（可选，默认\"文本对比报告\"）",
  "output": "报告输出路径（绝对路径，.html；可选，默认 ./report.html）",
  "options": { "ignoreCase": true, "ignoreEol": true, "ignoreWhitespace": true,
               "ignoreNewline": true, "ignoreWidth": true, "ignorePunct": true },
  "pairs": [{ "left": "/abs/原文.docx", "right": "/abs/修订.docx" }],
  "source": { "leftDir": "/abs/原始文件夹", "rightDir": "/abs/修订文件夹",
              "glob": "*.docx", "list": ["合同A.docx", { "left": "x.docx", "right": "y.pdf" }] }
}
```

- **六个忽略选项**（均可选，缺省与界面默认一致 = 全开）：`ignoreCase` 大小写、`ignoreEol` CRLF/换行符差异、`ignoreWhitespace` 空格、`ignoreNewline` 换行、`ignoreWidth` 全半角、`ignorePunct` 标点。用户说"忽略大小写和空格"时，把这两项设 true，其余按默认即可（不用显式写出）。
- **pairs 与 source 二选一**：
  - `pairs`：显式列出每一对（左=原始、右=修订）。文件数量少、或同一目录下按命名规则配对（如 `原始-x.docx` ↔ `修订-x.docx`）时用这种——你先列目录，按用户说的规则配好对写进来。
  - `source`：**两个文件夹按同文件名自动配对**。`glob` 可选（默认 `*.{pdf,docx,txt,md}`，支持 `*` `?` `{a,b}`）；`list` 可选（只要名单里的：字符串=两侧同名文件，对象=显式相对/绝对路径）。两边对不上的文件会进 `warnings` 不阻断。
- **分卷不用你管**：一份报告最多 10 对。`pairs` 给 25 对，工具自动产出 3 份报告（`-1`/`-2`/`-3` 后缀，`title` 自动加"（1/3）"），全部路径在 `reports` 数组里。
- 所有路径用**绝对路径**；Windows 路径在 JSON 里写 `\\` 或 `/`。

## 范例

1. "把 D:\a 和 D:\b 下的合同按文件名两两对比，忽略大小写和空格，出一份报告"
   ```json
   { "title": "合同对比报告", "output": "D:/reports/合同对比.html",
     "options": { "ignoreCase": true, "ignoreWhitespace": true },
     "source": { "leftDir": "D:/a", "rightDir": "D:/b" } }
   ```
2. "对比 /data/v1.docx 和 /data/v2.docx" →
   ```json
   { "pairs": [{ "left": "/data/v1.docx", "right": "/data/v2.docx" }],
     "output": "/data/v1-v2-对比.html" }
   ```
3. "这两个文件夹里只对比 合同A、合同B 这两份" →
   ```json
   { "source": { "leftDir": "/a", "rightDir": "/b", "list": ["合同A.docx", "合同B.docx"] },
     "output": "/reports/AB.html" }
   ```
4. "对比这两个目录下所有 pdf" → `source` + `"glob": "*.pdf"`。

## 拿到结果后

- `ok: true`：把 `reports` 里的全部报告路径给用户（macOS 可顺手 `open <path>`）。
- `ok: false` 但 `reports` 非空：部分文件对失败，报告仍可用；把失败原因（`warnings`）逐条说给用户。
- `reports` 为空：按 `warnings` 解释原因（路径不存在 / 没有可配对的文件 / 缺浏览器），不要重试相同输入。
- **语义分析由你完成，不在应用内**（本应用不配置任何大模型 API）：`stats` 给出新增/删除/修改数；需要看具体差异内容时，用你自己的能力读报告 HTML（注意内含大体积 base64 截图，只提取文字差异部分）或直接阅读源文件，再向用户给"影响大/中/小"的判断。

## 预期量级（不是异常）

- 速度约 1 秒/页（逐页截图），100 页文档约 80 秒；大批量任务耐心等待，不要中途 kill。
- 报告体积约 2MB/页（scale=2 高清快照），一份 10 对报告可达数十 MB，属正常。

## 扫描版 PDF（无文字层）

- **工具内置 WASM OCR（onnxruntime-web + PP-OCRv4，全程离线），扫描件无需用户装任何环境**：
  检测到无文字层 PDF 时自动识别（首次加载模型约 15MB、数秒；之后复用），识别文本参与对比、
  差异标注直接画在扫描页上，报告照常产出。任务 JSON **不需要**任何额外字段。
- OCR 慢于文字版（单页约 1~3s + 首次模型加载），批处理大量扫描件时向用户说明会稍慢。
- **OCR 结果磁盘缓存（识别结果复用）**：
  - 同一份扫描版 PDF 首次识别后，`{text, items}`（全文 + 逐行坐标）会写入磁盘缓存
    （`~/.compare-text/ocr-cache`，可用环境变量 `DSH_OCR_CACHE` 覆盖；写不进去时自动落到系统临时目录）。
  - 之后再次对比同一文件直接命中缓存注入，**跳过 OCR Worker 加载与逐页识别**；
    实测上海 4 页扫描件：冷缓存 19s → 热缓存 7.4s（快约 2.6 倍），内容完全一致。
  - 缓存键 = sha1(绝对路径 + 文件大小 + mtime)：**文件一变缓存自动失效**，不会用旧识别结果。
  - 同一会话内同一扫描件出现在多对中（如与多个省份版本两两对比）同样只识别一次。
  - 缓存读写失败静默回退正常 OCR，不影响报告产出。
- **严谨性：识别可复用、差异逐对独立**（多对混排文字版+扫描版的批次尤其注意）：
  - 缓存只存"识别结果"（每份文件的 text+items，按文件身份 key）；**每对的 diff 与标注
    永远用本对的两份原文现算**，不会把上一对的差异带到下一对（绝不张冠李戴）。
  - 扫描页快照的差异标注依赖 textItems（OCR/缓存注入的坐标）+ highlights（本对 diff 映射），
    两者缺一都画不出来。工具已保证：每对加载 PDF 时同步把 OCR 状态重置为 pending，
    报告通道的 OCR 轮询**必须等注入落定（done/failed）才截图**，不会因编辑器残留上一对文本而短路。
  - 已知限制：多对连跑时若某扫描件先在一对中出现、后续对仍走缓存，第一对必须真的完成过识别
    （缓存写入成功），否则后续对同样会等 done。文件未变则缓存必命中，无此问题。
  - 文档末页若是空白（无文字/无差异），快照上无标注属正常，不是 bug。
- **社区插件提醒**：若用户有一批扫描件要处理，可在回复中顺带提醒：
  DSH 社区已有 OCR 相关插件可另选安装使用，例如
  `dsh plugin add github:yakoylp/dsh-md-convert#v0.5.6`、
  `github:balcoz/dsh-ocr-local#v0.4.0`、`github:henryxiao709/dsh-pdf`
  （社区插件为第三方代码，安装前建议审阅源码）。内置 WASM OCR 与插件互为补充，不冲突。
