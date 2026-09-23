# 发布与版本管理（Release Guide）

> compare-text 采用 **GitHub Actions** 自动打包 macOS / Windows / Linux 三平台安装包并发布到 GitHub Release。
> 本文说明：版本号存在哪、如何**自动发布**、如何**手动发布**、如何配置代码签名、常见问题排查。

---

## 一、版本号存在哪（5 个文件必须保持一致）

| 文件 | 位置 |
|---|---|
| `package.json` | `"version": "1.2.0"` |
| `package-lock.json` | 顶层 `"version"` + `packages[""].version`（两处） |
| `src-tauri/tauri.conf.json` | `"version": "1.2.0"` |
| `src-tauri/Cargo.toml` | `[package]` 段的 `version = "1.2.0"` |
| `src-tauri/Cargo.lock` | 根包 `name = "app"` 条目下的 `version = "1.2.0"`（**只改这一个，勿动依赖版本**） |

> ⚠️ `Cargo.lock` 是 CRLF 行尾、且其他依赖也可能叫 1.2.0（如 `scopeguard`），**不要手改**，一律用脚本。

**统一改版本号的脚本**（自动发布和手动发布共用，保证 5 处一致）：

```bash
node scripts/bump-version.js current          # 只打印当前版本
node scripts/bump-version.js patch            # 1.2.0 -> 1.2.1（补丁号 +1）
node scripts/bump-version.js minor            # 1.2.0 -> 1.3.0
node scripts/bump-version.js major            # 1.2.0 -> 2.0.0
node scripts/bump-version.js 1.3.0            # 显式指定新版本
node scripts/bump-version.js patch --dry-run  # 只预览，不写盘
```

脚本把新版本号打印到 stdout（工作流用它打 tag），提示信息走 stderr。

---

## 二、自动发布（推荐，日常零操作）

### 工作流程

```
你推送代码到 main
   ↓ 触发
auto-version.yml（自动迭代版本并触发发布）
   1. 取最新版本 tag（如 v1.2.0），默认补丁号 +1 → 1.2.1
   2. 打 tag v1.2.1 并推送（★ 不改动 main，不会产生需要你同步的提交）
   3. 触发 release.yml
      ↓ 触发
release.yml（构建并发布 Release）
   在 macos-latest / windows-latest / ubuntu-22.04 三平台并行打包
   构建时自动把 5 个版本文件对齐到 tag（1.2.1）
   自动生成更新日志，上传安装包并发布正式 Release
```

> **关键点**：CI **绝不往 main 提交任何内容**，只在云端新增一个 `vX.Y.Z` tag。
> 云端 main 永远只含你自己的提交，本地 `git pull` 永远不会遇到需要合并的 CI 提交。

### 日常用法

```bash
git add .
git commit -m "修复 xxx 问题"
git push origin main          # 只需这一步！自动发布 v1.2.1
```

### 用提交信息关键词控制版本升级

默认（不加关键词）是 **补丁号 +1**（`1.2.0 → 1.2.1`）。需要升大版本时在提交信息里加关键词：

```bash
git commit -m "新增重大功能 [release:minor]"    # 1.2.0 -> 1.3.0
git commit -m "破坏性变更 [release:major]"      # 1.2.0 -> 2.0.0
```

### 跳过自动发布

某次提交不想触发自动发布，在提交信息里加 `[skip ci]` 即可：

```bash
git commit -m "只是改文档 [skip ci]"
git push origin main        # 不会触发自动发布
```

> `[skip ci]` 是 GitHub 官方跳过 push 触发工作流的关键词。另外，CI 自己产生的 `chore(release):` 提交也不会再次触发自动迭代（已做双重防护）。

---

## 三、手动发布（不依赖自动流程，精确到命令）

适合想完全自己控制发布节奏、或自动流程出问题时兜底。

### 1. 改版本号（任选其一）

用脚本（推荐，5 个文件一次改齐）：

```bash
node scripts/bump-version.js minor    # 例如升到 1.3.0；或 patch / 1.3.0
git diff --stat                       # 确认只改了 5 个版本文件
```

或手动改 5 个文件（见第一节表格），不推荐，容易漏。

### 2. 提交并打 tag

```bash
git add package.json package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore(release): v1.3.0"
git push origin main

git tag v1.3.0                # 标签版本必须与 5 个文件一致
git push origin v1.3.0        # ⬅ 推 tag 即触发 release.yml 三平台打包
```

> 手动推 tag 用的是你自己的 GitHub 凭据，会**天然触发** `push tags: v*` 事件，无需配置任何 PAT。

### 3. 查看构建进度

- 打开 GitHub 仓库 → **Actions** → 找到「构建并发布 Release」运行记录
- 三个平台并行跑，点开可看日志（约 5–15 分钟）

### 4. 下载安装包

- 构建完成后进仓库 → **Releases** → 对应版本 tag
- 安装包：macOS `.dmg/.app`、Windows `.msi/.exe`、Linux `.deb/.rpm/.AppImage`
- 更新日志由 CI 自动从提交记录生成

---

## 四、GitHub 页面手动触发（workflow_dispatch）

不想打 tag、只想临时打一个包？进仓库 → **Actions** → 「构建并发布 Release」→ **Run workflow**：

| 输入项 | 说明 |
|---|---|
| `tag` | 发布标签，如 `v1.3.0`。**留空**则使用 `tauri.conf.json` 里的版本号 |
| `draft` | 勾选 = 生成草稿 Release（不对外可见，需手动发布） |
| `prerelease` | 勾选 = 标记为预发布 |

若指定的 tag 与版本文件不一致，工作流会用 bump 脚本自动对齐，保证安装包版本 = 标签。

---

## 五、自动化原理（为什么不会死循环）

关键机制（GitHub 官方行为）：

1. **用 `GITHUB_TOKEN` push 的提交/tag 不会再触发任何 push 工作流**——唯一例外是 `workflow_dispatch` / `repository_dispatch`。
2. 自动发布工作流因此只做两件事：**打 tag**（不改动 main），然后 `gh workflow run` **显式 dispatch** 触发 `release.yml`（该事件对 `GITHUB_TOKEN` 豁免，**无需配置任何 PAT**）。
3. **为什么本地永远不用合并**：CI 从不往 main 提交或推送，云端 main 只会因为你自己的 push 而前进；CI 只新增一个 tag，tag 不占用 main 分支，本地 `git pull` 不会遇到它。
4. 循环防护：HEAD 已精确打 tag 守卫 + 连续提交用 `concurrency` 折叠为最新一次。`release.yml` 只构建、只创建 Release，**从不推代码**，不会产生新事件。

---

## 六、首次配置（一次性）

### 6.1 必要配置

无。自动发布默认可用（走 `GITHUB_TOKEN` + dispatch 接力），不需要任何 secret。

### 6.2 无需任何 Token / PAT

自动发布完全依赖内置的 `GITHUB_TOKEN`（通过 `workflow_dispatch` 接力触发），**不需要配置任何 PAT 或额外 Secret**。

> ⚠️ 若 main 分支开了**分支保护**，不影响 CI（CI 不再往 main 提交）；只影响你自己手动推 tag / 推 main 时的规则。

### 6.3 可选：代码签名

未配置时产出**未签名**安装包（macOS 首次打开需右键→打开；Windows 会提示未知发布者）。如需签名，配置以下 Secrets 后，CI 自动走签名版步骤：

| 平台 | Secret | 说明 |
|---|---|---|
| macOS | `APPLE_CERTIFICATE` | Apple Developer 证书（.p12 的 base64） |
| macOS | `APPLE_CERTIFICATE_PASSWORD` | 证书密码 |
| macOS | `APPLE_SIGNING_IDENTITY` | 签名身份，如 `Developer ID Application: xxx (TEAMID)` |
| macOS | `APPLE_ID` | Apple ID（用于公证） |
| macOS | `APPLE_PASSWORD` | Apple ID 专用密码（App-specific password） |
| macOS | `APPLE_TEAM_ID` | 开发者团队 ID |
| Windows | `WINDOWS_CERTIFICATE` | 代码签名证书（base64） |
| Windows | `WINDOWS_CERTIFICATE_PASSWORD` | 证书密码 |

> 签名相关变量**只在对应 Secret 非空时才注入**到构建环境（工作流里「签名版/未签名版」是两个独立步骤），所以不配签名绝不会报错。

---

## 七、常见问题排查

| 现象 | 原因 / 处理 |
|---|---|
| 推送后 Actions 里没有「自动迭代版本」运行 | 提交信息含 `[skip ci]`？确认推的是 `main` 分支 |
| 「自动迭代版本」成功了，但没有「构建并发布」运行 | 无 PAT 时靠 dispatch 接力，检查最后一步日志；或手动去 Actions 跑一次「构建并发布 Release」 |
| 自动发布报「触发失败」 | tag 推晚了/网络抖动；到 Actions 页面手动触发 release 即可 |
| macOS 构建报 `security import ... not valid` | 签名 Secret 配了一半（非空但无效）；检查 6.3 表格，或清空该 Secret 走未签名 |
| `npm ci` 报 lockfile 不一致 | 别手改 package-lock.json，用 bump 脚本；或删掉本地改动重新 `npm ci` |
| Linux 构建装依赖失败 | `ubuntu-22.04` 若被 GitHub 移除，把 `release.yml` 里的 `ubuntu-22.04` 改成 `ubuntu-24.04`（Tauri v2 同样适用） |
| 标签版本与安装包版本不一致 | `release.yml` 构建时会自动把 5 个版本文件对齐到 tag，通常不会出现；若仍不一致，确认手动打 tag 前是否用了 bump 脚本统一 |
| Windows 安装包被 SmartScreen 拦截 | 未代码签名所致；正式分发请配置 6.3 的 Windows 证书 |

---

## 八、本地打包（可选，需 Rust 工具链）

CI 已覆盖三平台打包，日常**不需要**本机打包。若想本地出安装包：

```bash
# 需要先装 Rust：https://rustup.rs（Windows 还需 VS Build Tools C++）
npm ci
npm run build:desktop       # 等价 tauri build，产物在 src-tauri/target/release/bundle/
```
