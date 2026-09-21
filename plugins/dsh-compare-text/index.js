/**
 * dsh-compare-text — 服务端半侧（server half）
 *
 * 职责：
 *  1. 在 DSH 启动时，自动在 127.0.0.1:<port> 启动 compare-text 自带的静态服务器
 *     （serve.js），仅本机可访问（HOST=127.0.0.1），不会对外网暴露。
 *  2. 在 DSH 的 webserver 上注册 GET /compare-text-meta，返回对比工具的实际
 *     URL，供浏览器侧（lib/client.js）的浮层 iframe 使用。
 *
 * 端口默认 3180；若该端口已被占用（比如你已经手动跑过 serve.js），插件不会
 * 重复启动，而是直接复用现有实例。
 */
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-compare-text';
export const inject = ['webServer'];

/** 对比工具静态服务器监听端口（仅 127.0.0.1）。 */
const DEFAULT_PORT = 3180;

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 项目根目录：优先取环境变量 COMPARE_TEXT_ROOT，否则按插件包所在位置推导（plugins/dsh-compare-text → 项目根）。 */
function resolveProjectRoot() {
  if (process.env.COMPARE_TEXT_ROOT && existsSync(process.env.COMPARE_TEXT_ROOT)) {
    return process.env.COMPARE_TEXT_ROOT;
  }
  const inferred = join(__dirname, '..', '..');
  if (existsSync(join(inferred, 'serve.js'))) return inferred;
  if (existsSync(join(process.cwd(), 'serve.js'))) return process.cwd();
  return inferred;
}

/** 探测 127.0.0.1:port 是否已有进程在监听。 */
function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}

export function apply(ctx, config) {
  const port = Number(config?.port) || DEFAULT_PORT;
  const root = resolveProjectRoot();
  const servePath = join(root, 'serve.js');
  const url = `http://127.0.0.1:${port}/`;
  const log = (...args) => {
    try { ctx.logger?.info?.('[dsh-compare-text]', ...args); } catch { /* noop */ }
  };
  const warn = (...args) => {
    try { ctx.logger?.warn?.('[dsh-compare-text]', ...args); } catch { console.warn('[dsh-compare-text]', ...args); }
  };

  let child = null;
  let disposed = false;

  // 启动（或复用）对比工具的静态服务器；dispose 时杀掉由本插件拉起的进程。
  ctx.effect(() => {
    log(`starting compare-text server at ${url} (serve.js: ${servePath})`);
    if (!existsSync(servePath)) {
      warn(`serve.js not found at ${servePath}; set COMPARE_TEXT_ROOT to the project root.`);
      return;
    }
    isPortOpen(port).then((open) => {
      if (disposed) return;
      if (open) {
        log(`port ${port} already in use — reusing existing compare-text instance.`);
        return;
      }
      log(`spawning: node ${servePath} ${port}`);
      child = spawn(process.execPath, [servePath, String(port)], {
        cwd: root,
        env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('error', (err) => warn(`failed to spawn serve.js: ${err.message}`));
      child.on('exit', (code, signal) => {
        if (!disposed) warn(`serve.js exited (code=${code}, signal=${signal}); the compare panel will fail to load.`);
        child = null;
      });
    });
    return () => {
      disposed = true;
      if (child) {
        try { child.kill(); } catch { /* noop */ }
        child = null;
      }
    };
  }, 'dsh-compare-text: spawn static server');

  // 供浏览器侧查询对比工具 URL（同源 /compare-text-meta，无 CORS 问题）。
  ctx.webServer.register({
    kind: 'exact',
    path: '/compare-text-meta',
    handler: async (_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ ok: true, url, port }));
    },
  });
}
