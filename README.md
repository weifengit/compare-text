# 文件对比 · Text Diff（离线 · 纯前端）

[![License: Apache 2.0](<https://img.shields.io/badge/License-Apache%202.0-blue.svg>)](LICENSE)

类似 Diffchecker 的本地文本对比工具：粘贴两段文字（或选择本地文件 / PDF），逐行 + 逐字符高亮差异，
**纯本地计算**，不上传服务器。同一套代码既可跑在浏览器，也可打包成 macOS / Windows / Linux 桌面应用。

## 快速开始

```bash
node serve.js          # 默认监听 0.0.0.0:3000，局域网内其他人也能访问
# 浏览器打开 http://localhost:3000（局域网分享用启动时打印的 http://<本机IP>:3000）

node serve.js 8080              # 自定义端口
HOST=127.0.0.1 node serve.js    # 仅本机可访问
node serve.js build             # 重建 Tauri 打包用的 dist/（一般由打包命令自动调用）
```

> 局域网访问：启动时会打印本机局域网地址，把 `http://<IP>:3000` 发给别人即可。
> 若对方打不开，多为 Windows 防火墙拦截，放行 Node.js 或当前端口即可。

> 用本地服务器打开是推荐的（Web Worker 需要 http 协议）；若直接双击 index.html（file:// 协议），
> 会自动降级为在主线程计算，功能不受影响，仅大文本时界面可能短暂卡顿。

## 功能

- **多标签页**：浏览器风格标签栏，点 “＋” 开多个对比窗口，每个窗口独立保存文本/选项/PDF/对比源
- **对比源 + 文件对比**：侧边栏设本地对比源，选子文件夹后自动以 原始=第一个 / 修改=第二个 文件立即渲染 PDF 面板与编辑区
- **PDF 面板**：自动缩放 / 适应宽度 / 适应页面 三种缩放（Ctrl+滚轮手动调比例），可全屏；高度弹性撑满（隐藏编辑区后自动利用释放空间）；拖拽不选中文字
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
- 历史记录（localStorage 最近 100 条，侧边栏显示，可恢复/删除/清空）
- 差异统计（修改/新增/删除行数）
- 修整：一键把两侧多余空格 / 换行统一整理为一行
- 外部链接：桌面模式下用系统默认浏览器打开（"请作者喝茶"等外链）

## 技术

jsdiff（diff 算法）+ CodeMirror（输入编辑）+ pdf.js（PDF 渲染）+ Web Worker（大文本防卡顿）。
依赖已打包在 `lib/`，**完全离线可用**。

```
index.html              页面骨架
styles.css              全部样式
lib/                    jsdiff、CodeMirror、pdf.js（本地打包，已入库）
serve.js                零依赖静态服务器 + /api/*（含 build 子命令生成 dist/）
src/normalize.js        归一化 + 分字符（纯逻辑，浏览器/Worker/Node 共用）
src/compute.js          diff 计算管线（行级对齐、字符级高亮）
src/source-api.js       /api 封装（列出对比源目录/文件，浏览器与桌面双模式）
src/picker.js           文件夹选择弹层
src/filterbar.js        子文件夹/原始文件/修改文件下拉与加载
src/pdfview.js          PDF 渲染与文本提取、差异标注
src/syncscroll.js       跨区域协同滚动
src/tabs.js             顶部多标签页栏
src/worker.js           Web Worker 入口
src/app.js              界面 / 渲染 / 多标签状态 / 历史 / Worker 编排
src/external-links.js   外部链接（桌面模式调系统浏览器）
test/                   Node 测试
src-tauri/              Tauri 桌面壳（Rust 命令在 src-tauri/src/lib.rs）
```

## 测试

```bash
npm test             # 核心：算法 + Worker 桥接 + 界面初始化/渲染（DOM 桩）
npm run test:all     # 扩展：再加 API / 协同滚动 / PDF 多页切换
npm run test:ui      # 单独跑界面初始化/渲染（DOM 桩）
npm run test:pdf     # 单独跑 PDF 多页切换
```

测试均在 Node 内跑（DOM 桩 / 直接调用导出），无需浏览器或服务器。
个别浏览器端到端用例（`test/e2e-*.js`）需要本机 Edge，未纳入以上默认命令。

## 打包桌面应用（GitHub Actions 自动打包）

推送 `v*` 标签（如 `v1.0.0`），或在 GitHub 仓库 Actions 页面手动触发 **“打包发布”**，
[GitHub Actions](.github/workflows/build.yml) 会在 **macOS / Windows / Linux** 三平台自动构建并发布安装包到 Release：

| 平台    | 产物                       |
| ------- | -------------------------- |
| macOS   | `.dmg`（含 `.app`）    |
| Windows | NSIS`.exe`（另含 MSI）   |
| Linux   | AppImage（另含 deb / rpm） |

CI 是自包含的：`lib/` 与图标已入库，构建前会自动生成 `dist/`，**本地无需任何打包产物**。
macOS 签名 / 公证、Windows 代码签名的配置见 [PACKAGING.md](PACKAGING.md)。

本地打包（可选）：需 Node.js LTS + Rust stable，执行

```bash
npm install
npm run build:desktop   # = tauri build：自动先 `node serve.js build` 生成 dist/，再编译 + 打包
```

产物在 `src-tauri/target/release/bundle/`，分平台差异与常见问题同样见 PACKAGING.md。

架构说明：桌面模式下没有 Node 服务器，`src/source-api.js` 检测到 Tauri 环境后，
自动把 `/api/list`、`/api/browse`、`/api/file` 切换为同名 Rust 命令（`src-tauri/src/lib.rs`）；
浏览器模式（`node serve.js`）行为不变，两种模式共用同一套前端代码。

想换应用图标：准备一张 ≥512×512 的 PNG，在项目根执行 `npx tauri icon 你的图.png` 即可重新生成各尺寸图标（需先 `npm i`）。

## 说明 / 取舍

- “忽略换行”会顺带忽略所有空白字符（含空格/Tab），以支持“第一行\n第二行”与“第一行 第二行”视为一致；
  此时结果区改为两侧各自的流水排版，不做行对齐，但左右列仍参与协同滚动。
- CRLF/LF 无论是否勾选都会被统一（按 `\r\n|\r|\n` 拆行），勾选项用于显式声明。
- 没有把它做成上传对比的服务器版：所有比较都在本机完成。

## 支持作者

如果这个工具帮到了你，欢迎请作者喝杯茶 ☕

| 支付宝 | 微信 |
| ------ | ---- |
| <img src="docs/alipay.png" alt="支付宝收款码" height="200"> | <img src="docs/wechat.png" alt="微信收款码" height="200"> |

## 开源协议

本项目基于 [Apache License 2.0](LICENSE) 开源：可自由使用、修改、分发（含商用），
分发时需保留版权声明与许可声明，修改过的文件需标注改动说明；
协议同时包含专利授权条款，使用者发起专利诉讼将自动失去授权。
软件按“现状”提供，不附带任何担保。

第三方依赖遵循各自协议：jsdiff（BSD-3-Clause）、CodeMirror（MIT）、pdf.js（Apache-2.0），均打包在 `lib/` 内。
