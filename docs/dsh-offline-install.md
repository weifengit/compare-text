# 把 compare-text 离线安装进 DeepSeek Harness（换电脑 / 不公开安装）

本文档说明如何把本仓库的两个 DSH 集成点，**离线（不发布 npm / GitHub）**安装到
另一台电脑的 DeepSeek Harness（以下简称 DSH）中。全程只使用**本地文件**，
不上传任何代码到公开仓库，也无需把插件发布到 npm。

---

## 1. 本仓库有哪些东西要装

| 集成点 | 位置 | 作用 |
| ------ | ---- | ---- |
| **Skill**（技能） | `.dsh/skills/compare-report/SKILL.md` | 让 DSH 里的 AI 具备「文本对比报告」能力：把自然语言对比需求转成任务 JSON，调用 `tools/dsh-report.js` 产出 HTML 报告 |
| **Plugin**（插件） | `plugins/dsh-compare-text/` | 在 DSH Web GUI 加一个 **「文本对比」** 入口（默认在聊天输入框工具行发送键旁的小图标，可切换为悬浮球 / dock 条 / 侧栏按钮），点击后界面内弹出全屏浮层（iframe 加载对比工具），并自动拉起仅本机访问的静态服务器 |

两者相互独立，可以只装其中一个，也可以都装（推荐都装）：

- **Skill** 负责「对话 → 批量报告」（不开 UI）；
- **Plugin** 负责「在 DSH 界面里直接用对比工具 UI」。

---

## 2. 新电脑前置条件

在开始前，确认新电脑上已经有：

1. **Node.js**（含 npm）：`node -v`
2. **pnpm**：`pnpm -v`（没有则 `npm i -g pnpm` 或 `corepack enable`）
3. **DSH 本体**：`dsh -V`（没有则 `npm i -g @deepseek-ai/dsh`，这一步需要网络，只需一次）
4. **Edge 或 Chrome**（可选，仅「生成报告」的无头截图需要；插件浮层本身不需要）

> 如果新电脑**完全没有网络**（连 DSH 本体都装不了），见文末
> [第 8 节「完全离线（无网络）的特殊情况」](#8-完全离线无网络的特殊情况)。

---

## 3. 把项目拷到新电脑（离线传输）

把整个 `compare-text` 项目文件夹拷贝到新电脑，方式任选：

- U 盘 / 移动硬盘
- 局域网拷贝：`scp -r compare-text user@newhost:/path/`
- 内网网盘 / 微信文件传输助手（注意别丢 `node_modules`，拷了也无妨但没必要）

**关键约束**（不要破坏，否则插件找不到项目）：

- 插件包路径必须保持 `项目根/plugins/dsh-compare-text` 这种两级结构。
  插件的服务端半侧靠 `plugins/dsh-compare-text` 的上级两级推导项目根
  （即 `join(__dirname, '..', '..')`），`serve.js` 必须和插件包保持相对位置。
- 推荐把项目放在固定路径（如 macOS `~/code/compare-text`，Windows
  `D:\code\compare-text`），便于后续维护。

拷完之后，在项目根目录确认关键文件在：

```bash
ls serve.js tools/dsh-report.js tools/render.js index.html   # 都应在
ls plugins/dsh-compare-text/package.json                     # 插件包
```

---

## 4. 安装 Skill（让 AI 会「文本对比报告」）

Skill 有两种装法：

### 4a. 项目内自动发现（零安装，推荐日常使用）

DSH 会在当前会话的工作目录所属的 git 项目里自动发现 `.dsh/skills/` 下的技能
（按 `项目根/.dsh/skills/<name>/SKILL.md` 结构）。只要：

1. 新电脑上已有这个项目（第 3 节已拷）；
2. 打开 DSH 会话时，**工作目录在项目内**（或打开项目目录作为工作区），

技能列表里就会出现 `compare-report`，无需任何安装动作。

> 本技能的前置条件要求「工作目录 = 本仓库根目录」，因为要调用
> `tools/dsh-report.js` 和 `tools/render.js`。因此建议直接在项目目录里开会话。

### 4b. 全局安装（任何会话都可见）

把技能目录复制到 DSH 的用户技能目录（macOS/Linux `~/.dsh/skills`，Windows
`%USERPROFILE%\.dsh\skills`，或 `$DSH_HOME/skills`）：

```bash
# macOS / Linux
mkdir -p ~/.dsh/skills
cp -R .dsh/skills/compare-report ~/.dsh/skills/compare-report

# Windows PowerShell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\skills" | Out-Null
Copy-Item -Recurse -Force .dsh\skills\compare-report "$env:USERPROFILE\.dsh\skills\compare-report"
```

验证（新开会话后技能列表里应出现 `compare-report`）：

```bash
ls ~/.dsh/skills/compare-report/SKILL.md
```

> 全局安装后技能在任何会话可见，但执行时 AI 仍需要知道项目根在哪
> （要调用 `tools/dsh-report.js`）。建议把项目路径告诉 AI，或仍把工作目录切到项目内。

---

## 5. 安装 Plugin（Web GUI 里加「文本对比」按钮）

在**项目根目录**执行（`dsh plugin --profile web add <插件包路径>`）：

```bash
# macOS / Linux（相对路径即可，命令会以当前目录为基准解析）
cd /path/to/compare-text
dsh plugin --profile web add ./plugins/dsh-compare-text

# Windows PowerShell
cd D:\code\compare-text
dsh plugin --profile web add .\plugins\dsh-compare-text
```

这条命令做三件事（全部**本地完成，零网络**）：

1. 如果 `web` profile 还没初始化，自动创建 `~/.dsh/profiles/web`；
2. 在 profile 目录里执行 `pnpm add <本地路径>` —— 因为是本地路径依赖，
   pnpm 直接**链接**（link）到你的项目插件包，不从任何 registry 下载；
3. 检测到插件包的 `package.json` 里声明了 `dsh.bundle.patch`，自动把
   `dsh-compare-text` 追加到 profile 的 `dsh.profile.bundles` 层列表。

预期输出类似：

```
dsh: initialized profile web at /Users/you/.dsh/profiles/web   # 首次才有
Already up to date

dependencies:
+ dsh-compare-text link:../../.../compare-text/plugins/dsh-compare-text

Done in 87ms using pnpm v12.5.1
```

验证安装（应能看到 `# == dsh-compare-text` 配置层）：

```bash
dsh --profile web --dump-config | grep -i compare
```

> 安装的是**本地路径链接**（pnpm link），以后改了插件代码**无需重装**，
> 重启 DSH 即生效。插件包移动了位置也无需重装（链接会跟着解析）。

---

## 6. 重启 DSH 并使用

1. 完全退出 DSH，然后重新启动 Web GUI：`dsh web`（或你平时启动的方式）。
2. 打开 `http://127.0.0.1:3080`，进入任意会话。
3. 点击 **「文本对比」** 入口（**默认**在聊天输入框工具行、发送键旁的小图标 `⇄`；
   想换位置见下方「入口样式」），点击后界面内弹出全屏浮层，就是对比工具本身。
4. 插件启动时自动在 `127.0.0.1:3180` 拉起 `serve.js`（仅本机可访问）；
   若端口已被占用（比如你已手动跑过），插件直接复用现有实例，不会重复启动。
5. 在对话里说「对比这两个文件夹的合同，出报告」，AI 会用
   `compare-report` 技能调用 `tools/dsh-report.js` 生成 HTML 报告。

> 端口可在 `plugins/dsh-compare-text/cordis.patch.yml` 的 `config.port` 改（默认 3180）。
> 项目根目录默认按插件包位置推导，也可用环境变量 `COMPARE_TEXT_ROOT` 显式指定。

### 入口样式（不想在输入框旁？可换）

插件入口默认在聊天输入框工具行右侧（最融入原生界面）。编辑
`plugins/dsh-compare-text/cordis.patch.yml` 的 `config.entry` 即可切换，
改完重启 DSH：

| entry | 入口位置 |
| ----- | -------- |
| `input-right`（默认） | 聊天输入框工具行右侧，发送键旁的小图标 |
| `input-left` | 聊天输入框工具行左侧 |
| `fab` | 右下角圆形悬浮按钮 |
| `dock` | 输入框上方全宽 dock 条 |
| `footer` | 左侧边栏底部、设置按钮旁 |

---

## 7. 卸载

```bash
# 卸载插件（从 web profile 移除依赖 + bundle 层）
dsh plugin --profile web remove dsh-compare-text

# 删除全局技能（如果 4b 装过）
rm -rf ~/.dsh/skills/compare-report            # macOS / Linux
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\skills\compare-report"   # Windows
```

然后重启 DSH。插件拉起的 `serve.js` 进程会在 DSH 退出时自动停止。

---

## 8. 完全离线（无网络）的特殊情况

如果新电脑**一点网都没有**，且 DSH 本体还没装，需要额外把这几样带过去：

1. **DSH 本体**（含 base bundles，`@deepseek-ai/dsh-base` 等随包自带）：
   在有网的机器上执行 `npm pack @deepseek-ai/dsh`，得到 `deepseek-ai-dsh-*.tgz`，
   拷到新电脑后 `npm i -g ./deepseek-ai-dsh-*.tgz`。
2. **pnpm**：`npm pack pnpm` 同理，或直接拷 pnpm 的安装目录。
3. **本项目**（第 3 节）。

之后按第 4、5 节安装即可。`dsh plugin add <本地路径>` 本身**不需要网络**
（本地路径链接 + 插件零依赖）；web profile 的 base bundles 从 DSH 安装包内解析，
也不联网。唯一要联网的是「首次安装 Node/pnpm/DSH 本体」这一下。

> 小贴士：把第 3–5 节的命令打包成一个脚本，新电脑上一条命令搞定 ——
> 见 `scripts/install-dsh-plugin.sh`（macOS/Linux）和
> `scripts/install-dsh-plugin.ps1`（Windows），以及
> `scripts/package-offline-bundle.sh`（生成离线传输包）。

---

## 9. 常见问题

| 现象 | 原因 / 处理 |
| ---- | ----------- |
| `dsh: pnpm not found on PATH` | 没装 pnpm。`npm i -g pnpm` 或 `corepack enable` 后重试 |
| 点「文本对比」按钮提示「后端未就绪」 | DSH 是在插件安装**之前**启动的，重启 DSH 即可；或确认项目根能找到 `serve.js`（必要时设 `COMPARE_TEXT_ROOT`） |
| 浮层打开后 404 | `serve.js` 没起来或端口被别的程序占用。手动跑 `node serve.js 3180` 看报错；或在 `cordis.patch.yml` 里换端口 |
| `dsh --profile web --dump-config` 里看不到 `dsh-compare-text` | 插件没装上。重跑第 5 节命令，确认输出里有 `+ dsh-compare-text link:...` |
| 生成报告报「缺浏览器」 | 报告需要 Edge/Chrome 做无头截图。装一个即可（第 2 节） |
| 换了电脑后技能列表里没有 `compare-report` | 确认会话工作目录在项目内（4a），或做了全局安装（4b） |

---

## 10. 相关文件

- 插件源码：`plugins/dsh-compare-text/`（`index.js` 服务端半侧、`lib/client.js` 客户端半侧、
  `cordis.patch.yml` 配置层补丁、`package.json` 的 `dsh.bundle` / `dsh.client` 声明）
- 技能文件：`.dsh/skills/compare-report/SKILL.md`
- 无头报告入口：`tools/dsh-report.js`（任务 JSON → HTML 报告，>10 对自动分卷）
- 安装脚本：`scripts/install-dsh-plugin.sh`、`scripts/install-dsh-plugin.ps1`、
  `scripts/uninstall-dsh-plugin.sh`、`scripts/uninstall-dsh-plugin.ps1`、
  `scripts/package-offline-bundle.sh`
