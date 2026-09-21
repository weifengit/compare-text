# dsh-compare-text

把 compare-text 文本对比工具嵌入 DeepSeek Harness Web GUI 的本地私有插件。

- **不发布**：只安装到本机 `web` profile，不涉及 npm / GitHub 公开。
- **仅本机访问**：插件自动启动项目自带的 `serve.js`，只绑定 `127.0.0.1`。
- **零改动**：不修改 compare-text 的任何源码，直接复用现有前端与 API。

## 效果

DSH Web GUI 的会话顶部会出现一个 **文本对比** 按钮，点击后在界面内弹出全屏
浮层（iframe 加载对比工具），可关闭。关闭 DSH 时，插件自动停止它拉起的
静态服务器。

## 目录结构

```
plugins/dsh-compare-text/
├── package.json      # dsh.bundle（配置层）+ dsh.client（Web UI bundle）声明
├── cordis.patch.yml  # 把插件行插入 profile 配置树
├── index.js          # 服务端半侧：拉起 serve.js + 注册 /compare-text-meta
└── lib/client.js     # 客户端半侧：会话头部按钮 + 全屏浮层 iframe
```

## 安装（一次）

在项目根目录（或任意目录）执行：

```powershell
dsh plugin --profile web add E:\code\compare-text\plugins\dsh-compare-text
```

命令会：
1. 在 `C:\Users\Administrator\.dsh\profiles\web` 里执行 `pnpm add <路径>`；
2. 因为包声明了 `dsh.bundle.patch`，自动把它加入该 profile 的
   `dsh.profile.bundles` 配置层列表。

> 安装的是本地路径（pnpm link），以后改了插件代码无需重装。

## 验证

```powershell
dsh --profile web --dump-config | findstr /i "compare-text"
```

应能看到 `dsh-compare-text` 配置层和 `dsh-compare-text` 行。

## 使用

1. **重启** DSH：`dsh web`（或你平时启动 GUI 的方式）。插件在启动时自动拉起
   `node serve.js 3180`（仅 127.0.0.1）。
2. 打开 `http://127.0.0.1:3080`，进入任意会话，点击会话头部 **文本对比** 按钮。
3. 浮层内即是对比工具；`Esc` 或右上角 **关闭 ✕** 退出。

## 配置

- 端口：在 `cordis.patch.yml` 的 `config.port` 修改（默认 3180）。若该端口
  已被占用，插件会复用现有实例而不重复启动。
- 项目根目录：默认按插件包位置推导（`plugins/dsh-compare-text` 的上两级）；
  也可设置环境变量 `COMPARE_TEXT_ROOT` 指向项目根目录。

## 卸载

```powershell
dsh plugin --profile web remove dsh-compare-text
```

然后重启 DSH。插件拉起的 serve.js 进程会在 DSH 退出时自动停止。
