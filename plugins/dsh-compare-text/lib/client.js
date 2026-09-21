/**
 * dsh-compare-text — 客户端半侧（Web GUI bundle）
 *
 * 在 DSH Web GUI 里注册「文本对比」入口，点击后在界面内弹出全屏浮层，用
 * iframe 加载对比工具（URL 来自同源 /compare-text-meta，由服务端半侧注册）。
 * 浮层可关闭，关闭后释放 iframe。
 *
 * 入口样式可通过插件配置 `entry` 切换（见 cordis.patch.yml）：
 *   input-right  聊天输入框工具行右侧小图标（默认，最融入原生界面）
 *   input-left   聊天输入框工具行左侧小图标
 *   fab          右下角圆形悬浮按钮（shell.overlay 浮动层）
 *   dock         输入框上方全宽 dock 条（conversation.input.dock）
 *   footer       左侧边栏底部、设置按钮旁的小图标（sidebar.footer.action）
 *
 * 本文件是 DSH 客户端模块系统的已构建 bundle 格式：
 *   window.__ModuleLoader__.load({ id, factory })
 * 依赖仅使用平台种子模块（react / react-dom / react/jsx-runtime），无需构建。
 */
window.__ModuleLoader__.load({
  id: "dsh-compare-text",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");
    var react_dom = require("react-dom");
    var jsx_runtime = require("react/jsx-runtime");
    var jsx = jsx_runtime.jsx;
    var jsxs = jsx_runtime.jsxs;
    var Fragment = jsx_runtime.Fragment;

    var META_URL = "/compare-text-meta";

    // ---- 全屏浮层样式（内联，避免任何构建/CSS 依赖） ----
    var overlayStyle = {
      position: "fixed",
      inset: 0,
      zIndex: 2147483000,
      display: "flex",
      flexDirection: "column",
      background: "var(--dsw-alias-bg-layer-1, #ffffff)",
      color: "var(--dsw-alias-label-primary, #1f2328)",
      fontFamily: "var(--ds-font-family-ui, system-ui, -apple-system, sans-serif)",
    };
    var overlayBarStyle = {
      flex: "none",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      height: 44,
      padding: "0 14px",
      boxSizing: "border-box",
      borderBottom: "1px solid var(--dsw-alias-border-l3, #d8dee4)",
      background: "var(--dsw-alias-bg-layer-2, #f6f8fa)",
    };
    var overlayTitleStyle = {
      fontSize: 14,
      fontWeight: 600,
      letterSpacing: ".02em",
    };
    var closeBtnStyle = {
      cursor: "pointer",
      border: "1px solid var(--dsw-alias-border-l3, #d8dee4)",
      background: "transparent",
      color: "inherit",
      borderRadius: 8,
      padding: "4px 12px",
      fontSize: 13,
      lineHeight: "20px",
    };
    var bodyStyle = {
      flex: 1,
      minHeight: 0,
      position: "relative",
    };
    var iframeStyle = {
      width: "100%",
      height: "100%",
      border: "none",
      display: "block",
      background: "#ffffff",
    };
    var msgStyle = {
      position: "absolute",
      inset: 0,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontSize: 14,
      color: "var(--dsw-alias-label-secondary, #656d76)",
    };

    // 工具行小图标按钮样式（和模型选择器 / 附件按钮同一量级）
    var toolBtnStyle = {
      cursor: "pointer",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: 26,
      height: 26,
      border: "1px solid var(--dsw-alias-border-l3, #d8dee4)",
      background: "transparent",
      color: "inherit",
      borderRadius: 6,
      fontSize: 14,
      lineHeight: 1,
      padding: 0,
    };

    // ---- 共用「打开面板」状态 hook ----
    function useComparePanel() {
      var [open, setOpen] = react.useState(false);
      var [url, setUrl] = react.useState(null);
      var [state, setState] = react.useState("idle"); // idle | loading | error

      react.useEffect(() => {
        if (!open) return undefined;
        var onKey = function (e) {
          if (e.key === "Escape") setOpen(false);
        };
        window.addEventListener("keydown", onKey);
        return function () { window.removeEventListener("keydown", onKey); };
      }, [open]);

      var openPanel = function () {
        setOpen(true);
        if (url || state === "loading") return;
        setState("loading");
        fetch(META_URL, { method: "GET", cache: "no-store" })
          .then(function (r) {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.json();
          })
          .then(function (data) {
            setUrl(data.url);
            setState("idle");
          })
          .catch(function (err) {
            setState("error");
            setUrl(null);
            console.error("[dsh-compare-text] failed to load meta:", err);
          });
      };

      var closePanel = function () {
        setOpen(false);
        setUrl(null);
        setState("idle");
      };

      return { open, url, state, openPanel, closePanel };
    }

    /** 全屏浮层（各入口共用）。 */
    function CompareOverlay(props) {
      var state = props.state, url = props.url, onClose = props.onClose;
      var content = null;
      if (state === "loading") {
        content = jsx("div", { style: msgStyle, children: "正在启动文本对比工具…" });
      } else if (state === "error") {
        content = jsx("div", { style: msgStyle, children: "无法启动对比工具（后端未就绪）。请确认 dsh web 已重启，或在项目目录手动运行 node serve.js。" });
      } else if (url) {
        content = jsx("iframe", { src: url, style: iframeStyle, title: "文本对比工具" });
      }
      return react_dom.createPortal(
        jsxs("div", {
          style: overlayStyle,
          children: [
            jsxs("div", {
              style: overlayBarStyle,
              children: [
                jsx("span", { style: overlayTitleStyle, children: "文本对比工具" }),
                jsx("button", {
                  type: "button",
                  onClick: onClose,
                  style: closeBtnStyle,
                  children: "关闭 ✕",
                }),
              ],
            }),
            jsx("div", { style: bodyStyle, children: content }),
          ],
        }),
        document.body,
      );
    }

    // ============ 入口样式 ============

    /** A. 输入框工具行图标按钮（conversation.input.left / .right）。 */
    function ToolRowEntry() {
      var panel = useComparePanel();
      return jsxs(Fragment, {
        children: [
          jsx("button", {
            type: "button",
            onClick: panel.openPanel,
            title: "打开文本对比工具",
            "aria-label": "打开文本对比工具",
            style: toolBtnStyle,
            children: "⇄",
          }),
          panel.open ? jsx(CompareOverlay, {
            state: panel.state, url: panel.url, onClose: panel.closePanel,
          }) : null,
        ],
      });
    }

    /** B. 右下角圆形悬浮按钮（shell.overlay，注意层本身点击穿透，需 pointerEvents:auto）。 */
    function FabEntry() {
      var panel = useComparePanel();
      return jsxs(Fragment, {
        children: [
          jsx("button", {
            type: "button",
            onClick: panel.openPanel,
            title: "打开文本对比工具",
            "aria-label": "打开文本对比工具",
            style: {
              position: "fixed",
              right: 20,
              bottom: 20,
              zIndex: 2147482000,
              width: 48,
              height: 48,
              borderRadius: "50%",
              cursor: "pointer",
              pointerEvents: "auto",
              border: "1px solid var(--dsw-alias-border-l3, #d8dee4)",
              background: "var(--dsw-alias-bg-layer-2, #f6f8fa)",
              color: "var(--dsw-alias-label-primary, #1f2328)",
              fontSize: 20,
              lineHeight: 1,
              boxShadow: "0 4px 14px rgba(0,0,0,.18)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            },
            children: "⇄",
          }),
          panel.open ? jsx(CompareOverlay, {
            state: panel.state, url: panel.url, onClose: panel.closePanel,
          }) : null,
        ],
      });
    }

    /** C. 输入框上方 dock 条（conversation.input.dock，全宽、右对齐小胶囊）。 */
    function DockEntry() {
      var panel = useComparePanel();
      return jsxs("div", {
        style: {
          display: "flex",
          justifyContent: "flex-end",
          padding: "6px 10px 0",
        },
        children: [
          jsx("button", {
            type: "button",
            onClick: panel.openPanel,
            title: "打开文本对比工具",
            "aria-label": "打开文本对比工具",
            style: {
              cursor: "pointer",
              border: "1px solid var(--dsw-alias-border-l3, #d8dee4)",
              background: "transparent",
              color: "inherit",
              borderRadius: 999,
              padding: "3px 12px",
              fontSize: 12,
              lineHeight: "18px",
              whiteSpace: "nowrap",
            },
            children: "⇄ 文本对比",
          }),
          panel.open ? jsx(CompareOverlay, {
            state: panel.state, url: panel.url, onClose: panel.closePanel,
          }) : null,
        ],
      });
    }

    /** E. 侧边栏底部图标（sidebar.footer.action，设置按钮旁）。 */
    function FooterEntry() {
      var panel = useComparePanel();
      return jsxs(Fragment, {
        children: [
          jsx("button", {
            type: "button",
            onClick: panel.openPanel,
            title: "打开文本对比工具",
            "aria-label": "打开文本对比工具",
            style: {
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28,
              height: 28,
              border: "1px solid var(--dsw-alias-border-l3, #d8dee4)",
              background: "transparent",
              color: "inherit",
              borderRadius: 6,
              fontSize: 15,
              lineHeight: 1,
              padding: 0,
            },
            children: "⇄",
          }),
          panel.open ? jsx(CompareOverlay, {
            state: panel.state, url: panel.url, onClose: panel.closePanel,
          }) : null,
        ],
      });
    }

    var inject = ["slots"];

    /** 入口 → (插槽名, 组件) 映射；config.entry 选择，缺省 input-right。 */
    var ENTRIES = {
      "input-right": { slot: "conversation.input.right", comp: ToolRowEntry },
      "input-left": { slot: "conversation.input.left", comp: ToolRowEntry },
      "fab": { slot: "shell.overlay", comp: FabEntry },
      "dock": { slot: "conversation.input.dock", comp: DockEntry },
      "footer": { slot: "sidebar.footer.action", comp: FooterEntry },
    };

    function apply(ctx, config) {
      var entry = (config && config.entry) || "input-right";
      var choice = ENTRIES[entry] || ENTRIES["input-right"];
      ctx.slots.inject(choice.slot, function () {
        return ctx.slots.register({
          name: choice.slot,
          id: "compare-text",
          order: 50,
        }, choice.comp);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
