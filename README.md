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

- **并排 / 内联** 两种视图切换；行级 + 字符级（词级）高亮
- **忽略选项**：
  - 忽略大小写
  - 忽略 CRLF/LF 行结束符（默认开）
  - 忽略空格（含行内空格）
  - 忽略换行（把段落当流水文本对比，重排不视为差异）
  - 忽略全/半角（`（`＝`(`、`Ａ`＝`A` 等）
  - 忽略标点（括号、引号、逗号、句号、分号、百分号、星号、加减号、等号、波浪号等）
- 折叠相同行（连续 ≥3 行相同自动折叠，点击展开）
- 同步滚动（并排视图下左右联动）
- 复制 Unified Diff 文本
- 历史记录（localStorage 最近 10 条，可恢复/删除/清空）
- 差异统计（修改/新增/删除行数）

## 技术

jsdiff（diff 算法）+ CodeMirror（输入编辑）+ Web Worker（大文本防卡顿）。
依赖已打包在 `lib/`，**完全离线可用**。

```
index.html          页面骨架
styles.css          全部样式
lib/                jsdiff@5.2.0、CodeMirror@5.65.16（本地打包）
src/normalize.js    归一化 + 分字符（纯逻辑，浏览器/Worker/Node 共用）
src/compute.js      diff 计算管线（行级对齐、字符级高亮、unified diff）
src/worker.js       Web Worker 入口
src/app.js          界面 / 渲染 / 同步滚动 / 历史 / Worker 编排
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

## 说明 / 取舍

- “忽略换行”会顺带忽略所有空白字符（含空格/Tab），以支持“第一行\n第二行”与“第一行 第二行”视为一致；
  此时结果区改为两侧各自的流水排版，不做行对齐与同步滚动。
- CRLF/LF 无论是否勾选都会被统一（按 `\r\n|\r|\n` 拆行），勾选项用于显式声明。
- 没有把它做成上传对比的服务器版：所有比较都在本机完成。