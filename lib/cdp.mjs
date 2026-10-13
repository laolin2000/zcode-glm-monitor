// cdp.mjs — 极简 CDP 客户端(Chrome DevTools Protocol)
// 用途:复用 Edge 登录态 —— 连到已登录智谱控制台的 Edge,在页面上下文里取数。
// 实现:Node 24 自带全局 WebSocket,不引第三方依赖。
'use strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function httpJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    req.then((res) => res.json()).then(resolve).catch(reject);
  });
}

export async function cdpAlive(port) {
  try {
    const v = await httpJson(`http://127.0.0.1:${port}/json/version`, 3000);
    return !!v && !!v.webSocketDebuggerUrl;
  } catch {
    return false;
  }
}

// 专用 profile 启动后 Edge 会把真实端口写进 DevToolsActivePort(端口被占时会自动换端口)
export function readDevToolsPort(profileDir) {
  try {
    const txt = readFileSync(join(profileDir, 'DevToolsActivePort'), 'utf8');
    const p = Number(String(txt).split(/\r?\n/)[0]);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}

export async function resolveEdgeExe() {
  const cands = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const c of cands) if (existsSync(c)) return c;
  const out = await new Promise((res) => {
    const ch = spawn('where.exe', ['msedge'], { windowsHide: true });
    let s = '';
    ch.stdout.on('data', (d) => { s += d; });
    ch.on('close', () => res(s.split(/\r?\n/)[0].trim()));
    ch.on('error', () => res(''));
  });
  return out && existsSync(out) ? out : '';
}

// 只杀"专用 profile"的 Edge(按命令行匹配 user-data-dir),绝不动用户日常浏览器
export async function killProfileEdge(profileDir) {
  const ps = process.env.SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const key = profileDir.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  const cmd =
    "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | " +
    `Where-Object { $_.CommandLine -match '${key}' } | ` +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
  await new Promise((res) => {
    const ch = spawn(ps, ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true });
    ch.on('close', res);
    ch.on('error', res);
    setTimeout(res, 8000);
  });
}

let seq = 0;
class Session {
  constructor(ws) {
    this.ws = ws;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message || 'CDP 错误')) : resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) { try { fn(msg); } catch { /* 监听器异常不影响主流程 */ } }
      }
    });
  }
  on(fn) { this.listeners.add(fn); }
  send(method, params = {}, timeoutMs = 15000) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CDP 超时:' + method));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  close() { try { this.ws.close(); } catch { /* 已关闭 */ } }
}

export async function connect(port) {
  const list = await httpJson(`http://127.0.0.1:${port}/json/list`, 5000);
  const pages = (Array.isArray(list) ? list : []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  return { pages };
}

// 找到(或新建)匹配 urlMatch 的页面,连上它
export async function attachPage(port, urlMatch, { createUrl = '', timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const { pages } = await connect(port);
      const re = urlMatch instanceof RegExp ? urlMatch : new RegExp(urlMatch);
      let target = pages.find((p) => re.test(p.url));
      if (!target && createUrl) {
        // 目标页不存在 → 让 Edge 新开一个(用 HTTP 端点,不依赖已有标签页)
        await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(createUrl)}`, { method: 'PUT' })
          .catch(() => fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(createUrl)}`))
          .catch(() => {});
        await sleep(2500);
        const again = await connect(port);
        target = again.pages.find((p) => re.test(p.url));
      }
      if (target) {
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.addEventListener('open', resolve, { once: true });
          ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
          setTimeout(() => reject(new Error('WebSocket 打开超时')), 8000);
        });
        const s = new Session(ws);
        await s.send('Runtime.enable').catch(() => {});
        await s.send('Page.enable').catch(() => {});
        return { session: s, target };
      }
    } catch (e) {
      lastErr = e;
    }
    await sleep(1000);
  }
  throw new Error('未找到匹配页面 ' + urlMatch + (lastErr ? ':' + lastErr.message : ''));
}

// 在页面上下文里求值(自动带 cookie / 天然同源,绕过签名头问题)
export async function evalIn(session, expr, timeoutMs = 20000) {
  const r = await session.send('Runtime.evaluate', {
    expression: `(async () => { ${expr} })()`,
    awaitPromise: true,
    returnByValue: true,
  }, timeoutMs);
  if (r && r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(d.exception?.description || d.text || '页面内执行异常');
  }
  return r && r.result ? r.result.value : undefined;
}

// 启动专用 Edge(已登录态持久在该 profile;端口被占时用 DevToolsActivePort 跟随)
export async function ensureEdge({ port, profileDir, urls = [], waitMs = 30000 }) {
  if (!(await cdpAlive(port))) {
    const exe = await resolveEdgeExe();
    if (!exe) throw new Error('未找到 msedge.exe');
    await killProfileEdge(profileDir);
    await sleep(1500);
    const args = [
      `--remote-debugging-port=${port}`,
      '--user-data-dir=' + profileDir,
      '--no-first-run',
      '--no-default-browser-check',
      ...urls,
    ];
    const ch = spawn(exe, args, { detached: true, stdio: 'ignore' });
    ch.unref();
  }
  let actual = port;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await cdpAlive(actual)) return actual;
    const p = readDevToolsPort(profileDir);
    if (p && p !== actual && (await cdpAlive(p))) return p;
    await sleep(1000);
  }
  throw new Error('Edge 调试端口未就绪(等待 ' + Math.round(waitMs / 1000) + ' 秒)');
}
