/**
 * dsh-compare-text — 客户端半侧（Web GUI bundle）
 *
 * 在 DSH Web GUI 的会话头部注册一个"文本对比"按钮；点击后在界面内弹出全屏
 * 浮层，用 iframe 加载对比工具（URL 来自同源 /compare-text-meta，由服务端
 * 半侧注册）。浮层可关闭，关闭后释放 iframe。
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

    /** 会话头部"文本对比"按钮 + 全屏浮层。 */
    function CompareTextButton() {
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

      var content = null;
      if (state === "loading") {
        content = jsx("div", { style: msgStyle, children: "正在启动文本对比工具…" });
      } else if (state === "error") {
        content = jsx("div", { style: msgStyle, children: "无法启动对比工具（后端未就绪）。请确认 dsh web 已重启，或在项目目录手动运行 node serve.js。" });
      } else if (url) {
        content = jsx("iframe", { src: url, style: iframeStyle, title: "文本对比工具" });
      }

      return jsxs(Fragment, {
        children: [
          jsx("button", {
            type: "button",
            onClick: openPanel,
            title: "打开文本对比工具",
            "aria-label": "打开文本对比工具",
            style: {
              cursor: "pointer",
              border: "1px solid var(--dsw-alias-border-l3, #d8dee4)",
              background: "transparent",
              color: "inherit",
              borderRadius: 8,
              padding: "4px 12px",
              fontSize: 13,
              lineHeight: "20px",
              whiteSpace: "nowrap",
            },
            children: "文本对比",
          }),
          open
            ? react_dom.createPortal(
                jsxs("div", {
                  style: overlayStyle,
                  children: [
                    jsxs("div", {
                      style: overlayBarStyle,
                      children: [
                        jsx("span", { style: overlayTitleStyle, children: "文本对比工具" }),
                        jsx("button", {
                          type: "button",
                          onClick: closePanel,
                          style: closeBtnStyle,
                          children: "关闭 ✕",
                        }),
                      ],
                    }),
                    jsx("div", { style: bodyStyle, children: content }),
                  ],
                }),
                document.body,
              )
            : null,
        ],
      });
    }

    var inject = ["slots"];

    function apply(ctx) {
      ctx.slots.inject("conversation.session.header.utilities", function () {
        return ctx.slots.register({
          name: "conversation.session.header.utilities",
          id: "compare-text",
          order: 50,
        }, CompareTextButton);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
