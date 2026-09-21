# 问题记录：报告快照空白/半空白（pdf.js 渲染竞态）

## 状态：已修复主因，残留竞态待处理

## 已修复（2025-xx 会话内）
1. **根因1：pdf.js 缺 cMapUrl / standardFontDataUrl**
   - 现象：桂枝等 PDF 的多页快照整页空白（31KB PNG，像素全白）。
   - 原因：这些 PDF 使用 CID 字体（非内嵌 CMap，如 GBK-EUC-H）和 Foxit 标准字体（如
     FoxitSerifItalic.pfb），pdf.js 未配置 `cMapUrl`/`cMapPacked`/`standardFontDataUrl`
     时字体加载失败，文字不绘制。
   - 证据：浏览器 console 报 "loadFont - translateFont failed: The CMap baseUrl must be
     specified"；提供 cmaps 后错误消失。
   - 修复：`src/pdfview.js` 新增 `pdfDocParams(url)`，配置
     `cMapUrl: location.origin + '/lib/cmaps/'`、`cMapPacked: true`、
     `standardFontDataUrl: location.origin + '/lib/standard_fonts/'`，两处 getDocument 均改用它。
   - 素材：从 VS Code 扩展 `cweijan.vscode-office-4.2.0` 复制 168 个 .bcmap 到
     `lib/cmaps/`，20 个标准字体到 `lib/standard_fonts/`。
   - 注意：cMapUrl 必须用绝对 URL（Worker 线程内相对路径会按 worker 脚本位置解析成
     /lib/lib/... 404）。

2. **根因2：page.render() 异步完成与截图时序竞态**
   - 现象：同一对文件两次运行，空白页位置随机漂移（桂枝对：run1 Lp2 空白→run2 Rp2 空白
     →run3 Rp3 空白→run4 Rp1/Rp3 空白；L 侧恒正常，R 侧随机空白）。
   - 原因：renderAll 对每页 page.render()（异步，全部同时排队）；render.js 的 loadedExpr
     只等 canvas.width>0（画布分配），不等真正画完；截图时部分页可能还没画完或被排队挤掉。
   - 已做的尝试（未解决）：pdfview.js 增加每页 rendered 标记（task.promise.then 置位）
     + 暴露 isPageRendered(side, pageNum)；render.js snapSide 每页截图前轮询该标记。
   - 结果：空白依旧随机 → 说明空白页的 render promise 已 resolve（标记置位）但画布仍空白，
     即渲染任务"完成"但内容未上画布（可能被 cancel 后 resolve，或 worker 渲染被中断）。
   - 未解之谜：L 侧为何恒正常、R 侧（后加载）随机空白？两批渲染任务在同一 worker 排队，
     后加载者可能被 getTextContent/collectText 等任务插队挤压。

## 待办（下次继续）
- 用监控探针观察空白页画布内容随时间变化（"从未画"还是"画了被清"），确认根因2的真正机制。
- 候选修复：
  a) 截图前对空白页强制重渲染该页（page.render 重跑，等其 promise）。
  b) renderAll 前先把 collectText（getTextContent）跑完，避免与渲染抢 worker。
  c) 加载后统一等所有页 rendered 再进入后续流程，且 rendered 判定改用
     canvas 像素采样（getImageData 非全白）而非 promise（防"假完成"）。
- 修复后需重新生成全部报告（126 子文件夹 / 130 卷，当前仅 19 份且部分可能含空白页）。

## 环境要点
- 跑 render.js 必须 danger-full-access（Edge IPC 命名管道被沙箱拦）。
- 当前审批策略已改为 never，不要请求 escalation；文件策略已是 danger-full-access。
- 报告输出位置：各 A层 文件夹下，以子文件夹名命名（如 docs/陈康梅-初审/0121 茯神.html）。
- 每份报告最多 10 对；>10 对自动分卷（-1/-2 后缀）。
