# 文本对比工具 · Text Diff（离线 · 纯前端）

类似 Diffchecker 的网页文本对比工具：粘贴两段文字，逐行 + 逐字符高亮差异（让浏览器分组显示），
**纯本地计算**，不上传服务器。

## 快速开始

```bash
node serve.js          # 默认监听 0.0.0.0:3000，局域网内其他人也能访问
# 浏览器打开 http://localhost:3000（局域网分享用启动时打印的 http://<本机IP>:3000）

node serve.js 8080              # 自定义端口
HOST=127.0.0.1 node serve.js    # 仅本机可访问
```

> 局域网访问：启动时会打印本机局域网地址，把 `http://<IP>:3000` 发给别人即可。
> 若对方打不开，多为 Windows 防火墙拦截，放行 Node.js 或当前端口即可。

> 用本地服务器打开是推荐的（Web Worker 需要 http 协议）；若直接双击 index.html（file:// 协议），
> 会自动降级为在主线程计算，功能不受影响，仅大文本时界面可能短暂卡顿。

## 功能

- **多标签页**：浏览器风格标签栏，点 “＋” 开多个对比窗口，每个窗口独立保存文本/选项/PDF/对比源
- **对比源 + 文件对比**：侧边栏设本地对比源，选子文件夹后自动以 原始=第一个 / 修改=第二个 文件立即渲染 PDF 面板与编辑区
- **PDF 面板**：自动缩放 / 适应宽度 / 适应页面 / 实际大小 四种缩放，可全屏；高度弹性撑满（隐藏编辑区后自动利用释放空间）；拖拽不选中文字
- **PDF 差异标注**：把对比差异直接标注在 PDF 页面上（变更/删除/新增分别用琥珀/红/绿背景色标出对应行）
- 行级 + 字符级（词级）高亮
- **忽略选项（默认全选中）**：
  - 忽略大小写
  - 忽略 CRLF/LF 行结束符
  - 忽略空格（含行内空格）
  - 忽略换行（把段落当流水文本对比，重排不视为差异）
  - 忽略全/半角（`（`＝`(`、`Ａ`＝`A` 等）
  - 忽略标点（括号、引号、逗号、句号、分号、百分号、星号、加减号、等号、波浪号等）
- 折叠相同行（连续 ≥3 行相同自动折叠，点击展开）
- 跨区域协同滚动（标注区左右列 / 编辑区 / PDF 面板联动）
- 历史记录（localStorage 最近 100 条，直接显示在侧边栏，可恢复/删除/清空）
- 差异统计（修改/新增/删除行数）

## 技术

jsdiff（diff 算法）+ CodeMirror（输入编辑）+ pdf.js（PDF 渲染）+ Web Worker（大文本防卡顿）。
依赖已打包在 `lib/`，**完全离线可用**。

```
index.html          页面骨架
styles.css          全部样式
lib/                jsdiff@5.2.0、CodeMirror@5.65.16、pdf.js（本地打包）
src/normalize.js    归一化 + 分字符（纯逻辑，浏览器/Worker/Node 共用）
src/compute.js      diff 计算管线（行级对齐、字符级高亮）
src/source-api.js   /api 封装（列出对比源目录/文件）
src/filterbar.js    子文件夹/字段/文件下拉与加载
src/pdfview.js      PDF 渲染与文本提取、差异标注
src/tabs.js         顶部多标签页栏
src/syncscroll.js   跨区域协同滚动
src/worker.js       Web Worker 入口
src/app.js          界面 / 渲染 / 多标签状态 / 历史 / Worker 编排
test/               Node 冒烟测试
serve.js            零依赖静态服务器
```

## 测试

```bash
node test/smoke.js        # 核心算法用例
node -e "require('./test/integration.js')"   # worker 桥接
node -e "require('./test/ui-init.js')"       # 界面初始化/渲染（DOM 桩）
```

`dl-deps.js` 是依赖下载脚本，仅当需要重新打包 `lib/` 时使用（需联网）。

## 打包桌面应用（Tauri）

可把本工具打包成 Windows 桌面应用分发（需 Node.js LTS + Rust stable + WebView2，首次构建需联网）：

```bash
npm install                     # 安装 @tauri-apps/cli（仅首次）
node make-icon.js               # 生成图标源文件 icon.png（已生成过可跳过）
npx tauri icon icon.png         # 生成 src-tauri/icons/ 各尺寸图标（已生成过可跳过）
npm run dev:desktop             # 桌面窗口内验证（自动生成 dist/ 并编译调试版）
npm run build:desktop           # 打包发布版
```

产物在 `src-tauri/target/release/`：

- `bundle/nsis/compare-text_<版本>_x64-setup.exe` — NSIS 安装包（推荐分发，免管理员权限安装）
- `bundle/msi/compare-text_<版本>_x64_en-US.msi` — MSI 安装包
- `compare-text.exe` — 免安装单文件，可直接运行

目标机器需装有 WebView2（Win11 自带；Win10 若没有，安装程序会自动引导下载，安装时需联网）。

架构说明：桌面模式下没有 Node 服务器，`src/source-api.js` 检测到 Tauri 环境后，
自动把 `/api/list`、`/api/browse`、`/api/file` 切换为同名 Rust 命令（`src-tauri/src/lib.rs`）；
浏览器模式（`node serve.js`）行为不变，两种模式共用同一套前端代码。

## 说明 / 取舍

- “忽略换行”会顺带忽略所有空白字符（含空格/Tab），以支持“第一行\n第二行”与“第一行 第二行”视为一致；
  此时结果区改为两侧各自的流水排版，不做行对齐，但左右列仍参与协同滚动。
- CRLF/LF 无论是否勾选都会被统一（按 `\r\n|\r|\n` 拆行），勾选项用于显式声明。
- 没有把它做成上传对比的服务器版：所有比较都在本机完成。
