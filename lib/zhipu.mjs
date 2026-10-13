// zhipu.mjs — 数据源 A:智谱开放平台控制台(open.bigmodel.cn)
// 思路与 DSH 的 EAC 监控同构:CDP 复用已登录的 Edge → 在页面上下文里发请求取数。
// 与 EAC 的差别:智谱控制台是 cookie 会话(不是 localStorage.userToken),
// 且内部接口路径需要现场勘察 → 本模块提供 probe() 自动抓取 XHR 清单。
'use strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensureEdge, attachPage, evalIn, sleep } from './cdp.mjs';

export const ZHIPU_URLS = {
  overview: 'https://open.bigmodel.cn/finance-center/finance/overview',
  expense: 'https://open.bigmodel.cn/finance-center/bill/expensebill/list',
};

export function defaultZhipuConfig(baseDir) {
  return {
    port: 9223, // 9222 已被 DSH 的 EAC 监控 Edge 占用,必须分开
    profileDir: join(process.env.LOCALAPPDATA || join(process.env.USERPROFILE || '', 'AppData', 'Local'), 'ZCodeGLMEdgeProfile'),
    endpointsFile: join(baseDir, 'zhipu-endpoints.json'),
    probeFile: join(baseDir, 'zhipu-probe.json'),
  };
}

function readJson(p, fallback) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
}

// 登录态判定:控制台未登录会跳登录页
async function loginState(session) {
  try {
    const r = await evalIn(session, `
      return JSON.stringify({
        href: location.href,
        title: document.title,
        loggedOut: /login|signin|passport/i.test(location.href) || !!document.querySelector('input[type=password]')
      });
    `, 10000);
    return JSON.parse(r || '{}');
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
}

// ── 勘察:抓取两个财务页发出的所有 XHR/fetch,落一份清单供写适配器 ────────────
export async function probe(cfg, { timeoutMs = 45000 } = {}) {
  const port = await ensureEdge({ port: cfg.port, profileDir: cfg.profileDir, urls: [ZHIPU_URLS.overview, ZHIPU_URLS.expense] });
  const captured = [];
  const out = { at: new Date().toISOString(), port, pages: {}, endpoints: [] };

  for (const [name, url] of Object.entries(ZHIPU_URLS)) {
    // 页面匹配放宽到"任一智谱页":登录态缺失时 URL 会变成 /login?redirect=...,严格匹配会找不到
    const { session, target } = await attachPage(port, /open\.bigmodel\.cn/, { createUrl: '', timeoutMs: 25000 });

    const seen = new Map();
    const onEvent = (msg) => {
      if (msg.method !== 'Network.responseReceived') return;
      const p = msg.params || {};
      const u = p.response && p.response.url || '';
      if (!/\/api\/|graphql|\.json/i.test(u)) return;
      if (!seen.has(u)) seen.set(u, { url: u, method: p.response.requestHeadersText ? '' : '', status: p.response.status, mimeType: p.response.mimeType, requestId: p.requestId, type: p.type });
      else seen.get(u).requestId = p.requestId;
    };
    session.on(onEvent);
    await session.send('Network.enable').catch(() => {});
    await session.send('Page.enable').catch(() => {});
    // 复用同一个智谱标签页:直接导航到目标 URL(不新开标签,避免刷屏)
    await session.send('Page.navigate', { url }).catch(() => {});
    await sleep(3000);
    const state = await loginState(session);
    out.pages[name] = { url: target.url, ...state };
    if (state.loggedOut) { await sleep(1500); session.close(); continue; }

    for (const item of seen.values()) {
      let body = '';
      try {
        const r = await session.send('Network.getResponseBody', { requestId: item.requestId }, 8000);
        body = r && r.body ? String(r.body) : '';
        if (r && r.base64Encoded) body = Buffer.from(body, 'base64').toString('utf8');
      } catch { /* 响应体可能已被回收 */ }
      let json = null;
      try { json = JSON.parse(body); } catch { /* 非 JSON */ }
      const keys = json && typeof json === 'object' ? Object.keys(json).slice(0, 20) : [];
      // 在完整响应体上算数值字段路径(sample 会截断,不能事后解析)
      const nums = json ? findNumericPaths(json).slice(0, 24) : [];
      const flat = JSON.stringify(json || {}).slice(0, 1500);
      out.endpoints.push({
        page: name,
        url: item.url,
        status: item.status,
        type: item.type,
        topKeys: keys,
        nums,
        sample: flat,
        interesting: nums.some((n) => NUM_KEY_RE.test(n.path)) || /balance|amount|cost|expense|bill|token|usage|quota|credit|money|price/i.test(flat),
      });
      captured.push(item.url);
    }
    session.close();
  }
  // 去重 + 按"是否像财务数据"排序
  const uniq = [];
  const seenUrl = new Set();
  for (const e of out.endpoints.sort((a, b) => Number(b.interesting) - Number(a.interesting))) {
    if (seenUrl.has(e.url)) continue;
    seenUrl.add(e.url);
    uniq.push(e);
  }
  out.endpoints = uniq;
  mkdirSync(dirname(cfg.probeFile), { recursive: true });
  writeFileSync(cfg.probeFile, JSON.stringify(out, null, 2), 'utf8');
  out.suggested = suggestAdapters(out);
  if (out.suggested) writeFileSync(cfg.endpointsFile, JSON.stringify(out.suggested, null, 2), 'utf8');
  return out;
}

// ── 自动推断适配器 ────────────────────────────────────────────────────────
// 按"响应体里有没有金额/余额类字段"给候选接口打分,取每个页面最像财务数据的那个,
// 并把该字段在 JSON 里的路径挖出来,交给 collect() 直接取值。
const NUM_KEY_RE = /(balance|remaining|remain|available|credit|amount|cost|expense|total|money|price|fee|consume|usage|token)/i;

function findNumericPaths(obj, path = '', out = [], depth = 0) {
  if (obj == null || depth > 6 || out.length > 60) return out;
  if (typeof obj === 'number') { out.push({ path, value: obj }); return out; }
  if (typeof obj === 'string' && /^-?\d+(\.\d+)?$/.test(obj)) { out.push({ path, value: Number(obj) }); return out; }
  if (typeof obj === 'object') {
    for (const k of Object.keys(obj)) findNumericPaths(obj[k], path ? path + '.' + k : k, out, depth + 1);
  }
  return out;
}

function suggestAdapters(probeOut) {
  const byPage = {};
  for (const e of probeOut.endpoints || []) {
    if (!Array.isArray(e.nums) || !e.nums.length) continue;
    const nums = e.nums.filter((n) => NUM_KEY_RE.test(n.path));
    if (!nums.length) continue;
    const score = nums.length + (e.interesting ? 5 : 0) + (/finance|bill|expense|balance|cost|usage/i.test(e.url) ? 5 : 0);
    if (!byPage[e.page] || score > byPage[e.page].score) byPage[e.page] = { url: e.url, score, nums };
  }
  const spec = {};
  for (const [page, best] of Object.entries(byPage)) {
    // 优先挑"总额/余额"语义的字段,否则退到第一个数值字段
    const pick = best.nums.find((n) => /balance|remaining|available|total.*(cost|amount|expense)|(cost|amount|expense).*total/i.test(n.path))
      || best.nums.find((n) => /balance|remaining|available|cost|expense|amount/i.test(n.path))
      || best.nums[0];
    spec[page] = {
      url: best.url,
      pick: pick.path.split('.'),
      _note: '自动推断(probe 产出):确认字段语义无误后保留;若要整段 JSON 用作展示,删掉 pick 即可',
      _candidates: best.nums.slice(0, 8),
    };
  }
  return Object.keys(spec).length ? spec : null;
}

// ── 授权上下文 ────────────────────────────────────────────────────────────
// 智谱控制台的内部接口要带 Authorization: Bearer <JWT>,而该 JWT 由 SPA 在运行时
// 生成(不在 localStorage / sessionStorage 里,已实测确认)。所以取数前先让页面自己
// 发一次真实请求,用 CDP 从请求头里把 Authorization 与 Bigmodel-Organization/Project
// 一起抄下来,再用同样的头去 fetch —— 相当于"借用页面已经拿到的授权"。
let authCache = { at: 0, headers: null };

export async function captureAuthContext(port, { timeoutMs = 25000 } = {}) {
  const { session } = await attachPage(port, /open\.bigmodel\.cn/, { createUrl: ZHIPU_URLS.overview, timeoutMs: 20000 });
  let captured = null;
  session.on((msg) => {
    if (captured || msg.method !== 'Network.requestWillBeSent') return;
    const req = (msg.params || {}).request;
    if (!req || !/open\.bigmodel\.cn\/api\/(biz|finance)\//.test(req.url)) return;
    const h = req.headers || {};
    const find = (name) => {
      const k = Object.keys(h).find((x) => x.toLowerCase() === name.toLowerCase());
      return k ? h[k] : '';
    };
    const auth = find('authorization');
    if (!auth) return;
    captured = {
      Authorization: auth,
      'Bigmodel-Organization': find('Bigmodel-Organization'),
      'Bigmodel-Project': find('Bigmodel-Project'),
      sampleUrl: req.url.slice(0, 90),
    };
  });
  await session.send('Network.enable').catch(() => {});
  // 触发一次真实请求:导航到财务总览(SPA 会立刻拉一批 /api 数据)
  await session.send('Page.navigate', { url: ZHIPU_URLS.overview }).catch(() => {});
  const deadline = Date.now() + timeoutMs;
  while (!captured && Date.now() < deadline) await sleep(500);
  session.close();
  if (!captured) return null;
  const headers = { Authorization: captured.Authorization };
  if (captured['Bigmodel-Organization']) headers['Bigmodel-Organization'] = captured['Bigmodel-Organization'];
  if (captured['Bigmodel-Project']) headers['Bigmodel-Project'] = captured['Bigmodel-Project'];
  authCache = { at: Date.now(), headers, sampleUrl: captured.sampleUrl };
  return headers;
}

export function authAgeMs() { return authCache.at ? Date.now() - authCache.at : -1; }
export function authTokenPrefix() {
  const a = authCache.headers && authCache.headers.Authorization || '';
  return a ? a.slice(0, 24) + '…(' + a.length + ')' : '';
}

// 取授权头:缓存 20 分钟(JWT 有时效,过期会被服务端拒,收到拒绝会自动重取)
async function getAuthHeaders(port, { force = false } = {}) {
  const ttl = 20 * 60 * 1000;
  if (!force && authCache.headers && Date.now() - authCache.at < ttl) return authCache.headers;
  return captureAuthContext(port);
}

// ── 采集:按已确认的适配器取数(zhipu-endpoints.json) ────────────────────────
// 适配器文件结构(勘察后人工确认填写):
// { "account": { "url": "...", "pick": ["data"] }, "monthly": { "url": "..." } }
export async function collect(cfg) {
  const spec = readJson(cfg.endpointsFile, null);
  if (!spec) {
    return { ok: false, status: 'unconfigured', hint: '尚未勘察智谱接口:先跑 node monitor.mjs --probe' };
  }
  try {
    const port = await ensureEdge({ port: cfg.port, profileDir: cfg.profileDir, urls: [ZHIPU_URLS.overview] });
    const { session, target } = await attachPage(port, /open\.bigmodel\.cn/, { createUrl: ZHIPU_URLS.overview, timeoutMs: 20000 });
    const state = await loginState(session);
    if (state.loggedOut) {
      session.close();
      return { ok: false, status: 'need-login', hint: '专用监控 Edge 未登录智谱:在弹出的窗口里登录一次即可' };
    }
    // 取授权头(借用页面自己请求里带的 JWT)
    let headers = await getAuthHeaders(port);
    if (!headers) {
      session.close();
      return { ok: false, status: 'no-auth', hint: '没能从页面请求里拿到授权头:确认监控 Edge 已登录并停在财务页' };
    }

    const result = { ok: true, status: 'ok', at: Date.now(), page: target.url, data: {}, auth: authTokenPrefix() };
    const fetchOne = async (ep, hdrs) => {
      const expr = `
        const res = await fetch(${JSON.stringify(ep.url)}, { credentials: 'include', headers: ${JSON.stringify(hdrs)} });
        const text = await res.text();
        let json = null; try { json = JSON.parse(text); } catch (e) {}
        let picked = json;
        ${ep.pick ? `for (const k of ${JSON.stringify(ep.pick)}) { picked = picked == null ? null : picked[k]; }` : ''}
        const code = json && typeof json === 'object' ? json.code : undefined;
        return JSON.stringify({ status: res.status, code: code, json: ${ep.pick ? 'picked' : 'json'} });
      `;
      const r = JSON.parse(await evalIn(session, expr, 20000) || '{}');
      return r;
    };

    for (const [name, ep] of Object.entries(spec)) {
      if (!ep || !ep.url || name.startsWith('_')) continue;
      const hdrs = { ...(ep.headers || {}), ...headers };
      try {
        let r = await fetchOne(ep, hdrs);
        // code 1001 = 授权失效 → 重取一次授权头再试
        if (r && (r.code === 1001 || r.code === 401)) {
          const fresh = await getAuthHeaders(port, { force: true });
          if (fresh) {
            headers = fresh;
            r = await fetchOne(ep, { ...(ep.headers || {}), ...fresh });
          }
        }
        result.data[name] = r;
      } catch (e) {
        result.data[name] = { error: String(e && e.message || e) };
      }
    }
    session.close();
    // 只要有任意一项真的取到数据就算成功
    const anyOk = Object.values(result.data).some((d) => d && d.status === 200 && d.code === 200 && d.json != null);
    return anyOk ? result : { ok: false, status: 'failed', hint: '接口返回异常(可能需重新登录)', data: result.data };
  } catch (e) {
    return { ok: false, status: 'error', hint: String(e && e.message || e) };
  }
}

export function endpointsConfigured(cfg) {
  return existsSync(cfg.endpointsFile);
}
