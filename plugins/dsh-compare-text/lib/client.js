/**
 * dsh-compare-text — 客户端半侧（Web GUI bundle）
 *
 * 现状：**本插件不再注册任何界面入口**。
 *
 * 背景（用户 2026-10-07 调整）：原来 compare-text 有两处界面入口——
 *   1) 「文本对比」全屏浮层入口（输入框工具行 / 悬浮球 / dock / 侧边栏底部图标，由 config.entry 选）；
 *   2) dsh-worktable「控制室」里的「文本对比」项目卡片（sidebar.worktable.project 子座位）。
 * 现在这两处都已**移除**：compare-text 的展示统一交给 **dsh-tokensave 项目中心**——
 * 在项目中心里点该项目卡片的「展示」按钮，即以 iframe 在 DSH 内呈现对比工具。
 *
 * 因此本客户端 bundle 只保留一个「空 apply」：
 *   - 继续满足 package.json 的 dsh.client 声明与 __ModuleLoader__ 握手（模块能正常加载）；
 *   - 不注册任何 slot，界面上不再出现任何 compare-text 入口/卡片。
 *
 * 服务端半侧（index.js）保持不动：仍负责在 DSH 启动时拉起 127.0.0.1:<port> 的
 * serve.js，并注册同源 GET /compare-text-meta——对比工具的实际地址由项目中心侧
 * 经项目的 devUrl 推导（见 compare-text 根 package.json 的 dsh.devUrl）。
 */
window.__ModuleLoader__.load({
  id: "dsh-compare-text",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    /** 无 UI 入口：加载即可，什么都不注册。 */
    function apply() {
      /* intentionally empty — compare-text 的展示已交给 dsh-tokensave 项目中心 */
    }

    exports.apply = apply;
    exports.inject = [];
    return module.exports;
  },
});
