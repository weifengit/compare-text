# 打包发布指南（Tauri 2）

本工具是「纯前端 + Tauri 桌面壳」，同一个代码仓库在 **macOS / Windows / Linux** 上各打各的安装包。
本文档覆盖：本地打包、GitHub Actions 自动打包、签名与公证、常见问题。

---

## 0. 产物总览

| 平台    | 产物                    | 位置（`src-tauri/target/release/bundle/`） |
| ------- | ----------------------- | -------------------------------------------- |
| macOS   | .app（免安装运行）      | `macos/compare-text.app`                   |
| macOS   | .dmg（安装包）          | `dmg/compare-text_<版本>_<架构>.dmg`       |
| Windows | NSIS 安装包（推荐分发） | `nsis/compare-text_<版本>_x64-setup.exe`   |
| Windows | MSI 安装包              | `msi/compare-text_<版本>_x64_en-US.msi`    |
| Windows | 免安装单文件            | `target/release/compare-text.exe`          |
| Linux   | AppImage                | `appimage/*.AppImage`                      |
| Linux   | deb / rpm               | `deb/*.deb`、`rpm/*.rpm`                 |

> ⚠️ **Tauri 不能交叉编译**：Windows 安装包只能在 Windows 上生成、macOS 只能在 macOS 上生成。多平台要么找对应平台的机器，要么用下面第 3 节的 CI 一次全出。

---

## 1. 前置条件

通用：

- **Node.js** ≥ 18（本仓库 24 实测 OK）
- **Rust** stable（`rustup` 安装，本仓库 1.98 实测 OK）
- git

分平台：

| 平台                  | 额外依赖                                                                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS                 | `xcode-select --install`（命令行工具即可，无需完整 Xcode）                                                                                       |
| Windows               | Microsoft C++ Build Tools（含 MSVC）、WebView2（Win11 自带，Win10 安装包会自动引导）                                                               |
| Linux (Ubuntu/Debian) | `sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf` |

> 首次构建会下载并编译约 200+ 个 Rust crate，耗时数分钟，属正常现象；之后有缓存会快很多。

---

## 2. 本地打包

命令全平台一致（需在对应平台的机器上执行）：

```bash
npm install              # 首次：安装 @tauri-apps/cli
npm run build:desktop    # = tauri build：自动先跑 node serve.js build 生成 dist/，再编译 + 打包
```

图标已入库（`src-tauri/icons/`），无需生成；想换图标：准备一张 ≥512×512 的 PNG，执行 `npx tauri icon 你的图.png`。

按平台取产物（见第 0 节表格）。`dist/` 由 `beforeBuildCommand`（`node serve.js build`）在构建前自动生成，无需手动操作。

### 想只出某一种安装包？

```bash
npx tauri build --bundles app          # macOS 只出 .app
npx tauri build --bundles dmg          # macOS 只出 .dmg
npx tauri build --bundles nsis         # Windows 只出 exe
npx tauri build --bundles msi          # Windows 只出 msi
npx tauri build --bundles appimage     # Linux 只出 AppImage
npx tauri build --bundles deb,rpm      # Linux 出 deb + rpm
```

---

## 3. GitHub Actions 自动打包（推荐）

一次打全三个平台，tag 推送即自动发布到 GitHub Releases。仓库里已提供现成 workflow：
[`.github/workflows/build.yml`](.github/workflows/build.yml)。

### 用法

```bash
git add -A && git commit -m "v1.0.0 发布" && git push
git tag v1.0.0 && git push --tag
```

然后在 GitHub → **Releases** 看到一个 draft 版本，三个平台的安装包已作为附件上传，
检查无误后点「Publish release」即可发布。也可以进 **Actions** 页手动触发（`workflow_dispatch`）。

### 完整 workflow 内容

```yaml
name: 打包发布

on:
  workflow_dispatch:          # 手动触发
  push:
    tags: [ 'v*' ]            # 推送 v1.0.0 等 tag 时触发

jobs:
  build:
    permissions:
      contents: write         # 允许上传 release 附件
    strategy:
      fail-fast: false        # 一个平台失败不中断其他平台
      matrix:
        platform: [ macos-latest, windows-latest, ubuntu-22.04 ]
    runs-on: ${{ matrix.platform }}

    steps:
      - uses: actions/checkout@v4

      - name: 安装 Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm           # 缓存 npm 依赖（需 package-lock.json）

      - name: 安装 Rust
        uses: dtolnay/rust-toolchain@stable

      - name: Rust 编译缓存
        uses: swatinem/rust-cache@v2
        with:
          workspaces: ./src-tauri -> target

      - name: 安装 Linux 系统依赖
        if: matrix.platform == 'ubuntu-22.04'
        run: |
          sudo apt-get update
          sudo apt-get install -y \
            libwebkit2gtk-4.1-dev build-essential curl wget file \
            libxdo-dev libssl-dev libayatana-appindicator3-dev \
            librsvg2-dev patchelf

      - name: 安装 npm 依赖
        run: npm ci

      - name: 构建并发布
        uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # ---- macOS 签名 + 公证（可选，见第 4 节；先不配也能出未签名包） ----
          APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
          APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
          APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
          # ---- Windows 代码签名（可选） ----
          WINDOWS_CERTIFICATE: ${{ secrets.WINDOWS_CERTIFICATE }}
          WINDOWS_CERTIFICATE_PASSWORD: ${{ secrets.WINDOWS_CERTIFICATE_PASSWORD }}
        with:
          tagName: ${{ github.ref_name }}
          releaseName: 'compare-text v${{ github.ref_name }}'
          releaseBody: '请填写本次发布说明'
          releaseDraft: true
          prerelease: false
```

> `dist/` 由 `beforeBuildCommand`（`node serve.js build`）在 CI 里自动生成；图标已提交在 `src-tauri/icons/`，
> 无需在 CI 里重新执行 `tauri icon`。

### CI 前要把这些提交进仓库

`git ls-files` 确认以下都在版本控制里（CI 从仓库重新构建，缺一个就编译失败）：

- `src-tauri/Cargo.toml`、`Cargo.lock`（必须，锁定依赖版本）
- `src-tauri/src/`、`tauri.conf.json`、`capabilities/`
- `src-tauri/icons/`（构建要用）
- `package.json`、`package-lock.json`

---

## 4. 签名、公证与放行

### macOS

| 场景               | 情况                                 | 做法                                                                                                                                                             |
| ------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 自己 / 内部测试    | 未签名                               | 右键应用 →**打开** → 再点打开；或 `xattr -dr com.apple.quarantine <app>`；或在 系统设置 → 隐私与安全性 → **仍要打开**                          |
| **正式分发** | 需**Developer ID 签名 + 公证** | 付费 Apple Developer 账号（$99/年）：把证书 p12 转 base64 存到 GitHub Secrets，workflow 自动签名 + 公证；`tauri.conf.json` 设 `bundle.macOS.signingIdentity` |

macOS 公证的 Secrets 说明（在仓库 Settings → Secrets and variables → Actions 里配置）：

| Secret                         | 内容                                                                        |
| ------------------------------ | --------------------------------------------------------------------------- |
| `APPLE_CERTIFICATE`          | Developer ID Application 证书 .p12 的 base64（`base64 -i cert.p12` 输出） |
| `APPLE_CERTIFICATE_PASSWORD` | 导出 .p12 时设的密码                                                        |
| `APPLE_SIGNING_IDENTITY`     | 形如`Developer ID Application: 你的名字 (TEAMID)`                         |
| `APPLE_ID`                   | Apple 账号邮箱                                                              |
| `APPLE_PASSWORD`             | App 专用密码（appleid.apple.com 生成，不要用登录密码）                      |
| `APPLE_TEAM_ID`              | Team ID（开发者后台可见）                                                   |

### Windows

| 场景          | 情况         | 做法                                                                                                                                                                                                                 |
| ------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 自测 / 小范围 | 未签名       | 安装时 SmartScreen 弹"未知发布者"→ 点**更多信息 → 仍要运行**                                                                                                                                                 |
| 正式分发      | 可选代码签名 | 向 CA（如 DigiCert、GlobalSign）买代码签名证书（OV 几百~几千元/年）；`tauri.conf.json` 设 `bundle.windows.certificateThumbprint`，CI 里配 `WINDOWS_CERTIFICATE` / `WINDOWS_CERTIFICATE_PASSWORD` 两个 Secret |

未签名不影响功能，只是多一步"仍要运行"。个人分发一般不必买。

### Linux

Linux 没有强制签名体系，AppImage/deb/rpm 直接分发即可。

---

## 5. 发布检查清单

- [ ] 前端 `npm run test` 通过
- [ ] 本地 `npm run build:desktop` 构建成功（当前平台）
- [ ] 所有文件已提交（含 `src-tauri/`、`Cargo.lock`、`icons/`）
- [ ] `git tag v<版本>` 推送 → Actions 三个平台构建全绿
- [ ] Releases 草稿里三平台产物齐全：.dmg / .app、.exe / .msi、.AppImage
- [ ] macOS 安装验证：公证过的直接开；未公证的右键→打开
- [ ] Windows 安装验证：安装包能装上、能正常对比 PDF（若报 PDF 失败，检查 CSP 是否含 `ipc:`）
- [ ] 在目标机器实际测试核心功能（对比、PDF 加载、对比源选文件夹）

---

## 6. 常见问题

**`npx tauri icon` 报 "Couldn't recognize the current folder as a Tauri project"**
→ `src-tauri/` 不存在或未初始化。初始化：`npx tauri init --ci --app-name compare-text --window-title "文件对比 · File Compare（离线）" --frontend-dist ../dist --dev-url http://localhost:3000 --before-dev-command "node serve.js" --before-build-command "node serve.js build"`。

**macOS "无法验证该 App"**
→ 见第 4 节：自测用右键→打开或 `xattr`；正式分发需签名 + 公证。

**桌面版加载 PDF 报 "Invalid PDF structure."**
→ 两个修复都已合入，勿回退：

1. `src/source-api.js` 的 Blob 必须包 `new Uint8Array(bytes)`（防 postMessage 降级路径把字节变数字数组）
2. `tauri.conf.json` 的 CSP `connect-src` 必须含 `ipc:`（否则 IPC 被 CSP 拦截降级）

**首次构建很慢**
→ 正常，Rust 编译 200+ crate。CI 里已配 `rust-cache`，第二次起会复用。
