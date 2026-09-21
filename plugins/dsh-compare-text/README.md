# dsh-compare-text

把 compare-text 文本对比工具嵌入 DeepSeek Harness Web GUI 的本地私有插件。

- **不发布**：只安装到本机 `web` profile，不涉及 npm / GitHub 公开。
- **仅本机访问**：插件自动启动项目自带的 `serve.js`，只绑定 `127.0.0.1`。
- **零改动**：不修改 compare-text 的任何源码，直接复用现有前端与 API。

## 效果

DSH Web GUI 里出现一个 **「文本对比」** 入口，点击后在界面内弹出全屏
浮层（iframe 加载对比工具），可关闭。关闭 DSH 时，插件自动停止它拉起的
静态服务器。

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
        entry: fab   # ← 换入口样式
```

## 目录结构

```
plugins/dsh-compare-text/
├── package.json      # dsh.bundle（配置层）+ dsh.client（Web UI bundle）声明
├── cordis.patch.yml  # 把插件行插入 profile 配置树（含 entry 入口样式配置）
├── index.js          # 服务端半侧：拉起 serve.js + 注册 /compare-text-meta
└── lib/client.js     # 客户端半侧：可配置入口（input-left/right/fab/dock/footer）
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
2. 打开 `http://127.0.0.1:3080`，进入任意会话，点击 **文本对比** 入口
   （位置取决于 `config.entry`，默认在输入框工具行发送键旁）。
3. 浮层内即是对比工具；`Esc` 或右上角 **关闭 ✕** 退出。

## 配置

- 端口：在 `cordis.patch.yml` 的 `config.port` 修改（默认 3180）。若该端口
  已被占用，插件会复用现有实例而不重复启动。
- 入口样式：在 `cordis.patch.yml` 的 `config.entry` 修改（默认 `input-right`），
  可选 `input-right` / `input-left` / `fab` / `dock` / `footer`。
- 项目根目录：默认按插件包位置推导（`plugins/dsh-compare-text` 的上两级）；
  也可设置环境变量 `COMPARE_TEXT_ROOT` 指向项目根目录。

## 卸载

```powershell
dsh plugin --profile web remove dsh-compare-text
```

然后重启 DSH。插件拉起的 serve.js 进程会在 DSH 退出时自动停止。
