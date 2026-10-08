# dsh-compare-text

把 compare-text 文本对比工具接入 DeepSeek Harness 的本地私有插件。

> **2026-10-07 调整**：本插件现在**只保留服务端半侧**，不再注册任何界面入口。
> compare-text 的展示统一由 **dsh-tokensave 项目中心**发起——在项目中心里点
> compare-text 卡片的「展示」按钮，即以 iframe 在 DSH 内呈现对比工具（项目中心的内嵌视图）。
> 原来那两处入口（输入框/侧边栏浮层按钮、dsh-worktable「控制室」项目卡片）
> 都已移除。

- **不发布**：只安装到本机 `web` profile，不涉及 npm / GitHub 公开。
- **仅本机访问**：插件自动启动项目自带的 `serve.js`，只绑定 `127.0.0.1`。
- **零改动**：不修改 compare-text 的任何前端源码，直接复用现有前端与 API。

## 这个插件现在做什么

1. **启动静态服务器**：DSH 启动时自动拉起 `node serve.js <port>`（`HOST=127.0.0.1`，
   默认端口 `3180`）；若端口已被占用（例如你手动跑过 `serve.js`），则复用现有实例，
   不会重复启动。DSH 退出时插件会停掉自己拉起的进程。
2. **注册地址查询路由**：在宿主的 webserver 上注册同源 `GET /compare-text-meta`，
   返回对比工具的实际 URL（`{ ok, url, port }`）。
3. **不注册任何 UI 入口**：`lib/client.js` 是一个空 `apply`，只维持
   `__ModuleLoader__` 握手（模块能正常加载），不往任何 slot 注入内容。

## 界面从哪来（新版流程）

compare-text 作为「项目」登记进 **dsh-tokensave 项目中心**后：

1. 打开任意会话 → 左侧边栏「项目中心」→ 找到 compare-text 卡片；
2. 点卡片上的 **「展示」** 按钮 → 项目中心的视图切为对比工具（iframe 全幅加载）；
   工具条上有「刷新 / 新窗口 / ← 返回」。

地址来源：tokensave 的 `project-info` 路由读项目 `package.json` 的
**`previewUrl`**（本仓库根 `package.json` 已声明 `http://127.0.0.1:3180/`），
再探测端口是否在监听。因此**插件与服务端两处的端口必须一致**：
本插件 `cordis.patch.yml` 的 `config.port` ⇄ 根 `package.json` 的 `previewUrl`。

## 目录结构

```
plugins/dsh-compare-text/
├── package.json      # dsh.bundle（配置层）+ dsh.client（Web 握手，空入口）
├── cordis.patch.yml  # 把插件行插入 profile 配置树（含端口）
├── index.js          # 服务端半侧：拉起 serve.js + 注册 /compare-text-meta
└── lib/client.js     # 客户端半侧：空 apply（不注册任何 slot）
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

> 安装的是本地路径（pnpm link），以后改了插件代码无需重装（重启 `dsh web` 生效）。
> 相对路径也可：`cd E:\code\compare-text` 后执行 `dsh plugin --profile web add .\plugins\dsh-compare-text`。

## 验证

```powershell
dsh --profile web --dump-config | findstr /i "compare-text"
```

应能看到 `dsh-compare-text` 配置层和 `dsh-compare-text` 行。

## 使用

1. **重启** DSH：`dsh web`（或你平时启动 GUI 的方式）。插件在启动时自动拉起
   `node serve.js 3180`（仅 127.0.0.1）。
2. 打开 `http://127.0.0.1:3080`，进入任意会话。
3. 侧边栏 **「项目中心」** → compare-text 卡片 → **「展示」** → iframe 内即是对比工具。

## 配置

- 端口：在 `cordis.patch.yml` 的 `config.port` 修改（默认 3180）；
  同时把 compare-text 根 `package.json` 的 `previewUrl` 改成同一端口。
  端口被占用时插件会复用现有实例而不重复启动。
- 项目根目录：默认按插件包位置推导（`plugins/dsh-compare-text` 的上两级）；
  也可设置环境变量 `COMPARE_TEXT_ROOT` 指向项目根目录。

## 卸载

```powershell
dsh plugin --profile web remove dsh-compare-text
```

然后重启 DSH。插件拉起的 serve.js 进程会在 DSH 退出时自动停止。
