# dsh-compare-text

把 compare-text 文本对比工具嵌入 DeepSeek Harness Web GUI 的本地私有插件。

- **不发布**：只安装到本机 `web` profile，不涉及 npm / GitHub 公开。
- **仅本机访问**：插件自动启动项目自带的 `serve.js`，只绑定 `127.0.0.1`。
- **零改动**：不修改 compare-text 的任何源码，直接复用现有前端与 API。

## 效果

DSH Web GUI 里出现 **「文本对比」** 入口，有两种打开方式，**可同时并存**：

1. **dsh-worktable 工作台卡片（新）**：左侧边栏「工作台」区块出现「文本对比」
   项目卡片，点击后在分栏工作区的 **「浏览器」窗** 内直接渲染对比工具前端 UI
   （右侧仍保留对话窗）。这是针对 dsh-worktable 插件的适配集成。
2. **旧版浮层入口（保留）**：聊天输入框工具行 / 悬浮按钮等旧入口，点击后在
   界面内弹出全屏浮层（iframe 加载对比工具），可关闭。

关闭 DSH 时，插件自动停止它拉起的静态服务器。

### 工作台卡片细节（新增）

- 卡片走 dsh-worktable 的入驻协议：注册到 `sidebar.worktable.project` 子座位，
  项目 id 为 `compare-text`；
- 点击卡片 → 调用工作台下发的 `openSplit(LayoutSpec)` 打开分栏工作区，主行
  一个「浏览器」窗（`builtin browser`），地址自动填好对比工具 URL（来自同源
  `/compare-text-meta`，失败回退 `http://127.0.0.1:3180/`）；
- 支持工作台的改名 / 图标更换 / 排序 / 搜索过滤 / 隐藏（owner props
  `nameOverrides` / `iconOverrides` / `order` / `query` / `hidden`）；
- 若工作台未安装（子座位永不出现）或 `openSplit` 不可用，卡片自动回退为旧版
  全屏浮层，功能不丢；
- 通过 `cordis.patch.yml` 的 `config.worktable: false` 可关闭卡片（旧入口不受影响）。

### 入口样式（可配置）

默认入口在**聊天输入框工具行**（发送键旁的小图标 `⇄`，最融入原生界面）。
也可在 `cordis.patch.yml` 的 `config.entry` 切换，改完重启 DSH 生效：

| entry | 位置 | 插槽 |
| ----- | ---- | ---- |
| `input-right`（默认） | 聊天输入框工具行右侧（发送键旁） | `conversation.input.right` |
| `input-left` | 聊天输入框工具行左侧 | `conversation.input.left` |
| `fab` | 右下角圆形悬浮按钮 | `shell.overlay` |
| `dock` | 输入框上方全宽 dock 条 | `conversation.input.dock` |
| `footer` | 左侧边栏底部（设置按钮旁） | `sidebar.footer.action` |

```yaml
# cordis.patch.yml
- insert:
    - id: dsh-compare-text
      name: dsh-compare-text
      config:
        port: 3180
        entry: fab      # ← 换入口样式
        worktable: true # ← 工作台卡片开关（默认开；false 关闭）
```

## 目录结构

```
plugins/dsh-compare-text/
├── package.json      # dsh.bundle（配置层）+ dsh.client（Web UI bundle）声明
├── cordis.patch.yml  # 把插件行插入 profile 配置树（含 entry 入口样式 + worktable 开关）
├── index.js          # 服务端半侧：拉起 serve.js + 注册 /compare-text-meta
└── lib/client.js     # 客户端半侧：旧入口（input-left/right/fab/dock/footer）+
                      # 工作台项目卡片（sidebar.worktable.project 子座位）
```

## 安装（一次）

> **换电脑 / 离线安装（不发布 npm / GitHub）请看 [`docs/dsh-offline-install.md`](../../docs/dsh-offline-install.md)**，
> 或直接用仓库脚本：`bash scripts/install-dsh-plugin.sh`（macOS/Linux）、
> `.\scripts\install-dsh-plugin.ps1`（Windows）。

在项目根目录（或任意目录）执行：

```powershell
dsh plugin --profile web add E:\code\compare-text\plugins\dsh-compare-text
```

命令会：
1. 在 `C:\Users\Administrator\.dsh\profiles\web` 里执行 `pnpm add <路径>`；
2. 因为包声明了 `dsh.bundle.patch`，自动把它加入该 profile 的
   `dsh.profile.bundles` 配置层列表。

> 安装的是本地路径（pnpm link），以后改了插件代码无需重装。
> 相对路径也可：`cd E:\code\compare-text` 后执行
> `dsh plugin --profile web add .\plugins\dsh-compare-text`。

## 验证

```powershell
dsh --profile web --dump-config | findstr /i "compare-text"
```

应能看到 `dsh-compare-text` 配置层和 `dsh-compare-text` 行。

## 使用

1. **重启** DSH：`dsh web`（或你平时启动 GUI 的方式）。插件在启动时自动拉起
   `node serve.js 3180`（仅 127.0.0.1）。
2. 打开 `http://127.0.0.1:3080`，进入任意会话。
3. **工作台方式（新）**：左侧边栏找到「工作台」区块（需已安装
   [dsh-worktable](https://github.com/Aisland-SJL/dsh-worktable)），点击
   **文本对比** 项目卡片，分栏工作区的「浏览器」窗内直接渲染对比工具。
4. **旧版方式（保留）**：点击 **文本对比** 入口（位置取决于 `config.entry`，
   默认在输入框工具行发送键旁），浮层内即是对比工具；`Esc` 或右上角
   **关闭 ✕** 退出。

## 配置

- 端口：在 `cordis.patch.yml` 的 `config.port` 修改（默认 3180）。若该端口
  已被占用，插件会复用现有实例而不重复启动。
- 入口样式：在 `cordis.patch.yml` 的 `config.entry` 修改（默认 `input-right`），
  可选 `input-right` / `input-left` / `fab` / `dock` / `footer`。
- 工作台卡片：在 `cordis.patch.yml` 的 `config.worktable` 修改（默认 `true`），
  设 `false` 关闭 dsh-worktable 里的项目卡片（旧入口不受影响）。
- 项目根目录：默认按插件包位置推导（`plugins/dsh-compare-text` 的上两级）；
  也可设置环境变量 `COMPARE_TEXT_ROOT` 指向项目根目录。

## 卸载

```powershell
dsh plugin --profile web remove dsh-compare-text
```

然后重启 DSH。插件拉起的 serve.js 进程会在 DSH 退出时自动停止。
