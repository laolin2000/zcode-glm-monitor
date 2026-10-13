// monitor.mjs — ZCode · 智谱用量监控(主服务)
//  数据源 B:ZCode 本地用量库(db.sqlite,只读快照)  → 实时 token / 各模型 / 会话 / 曲线
//  数据源 A:智谱控制台(Edge CDP 复用登录态)        → 余额、订阅、官方账单金额
// 形态对齐 DSH 的 EAC 监控:本地 HTTP 页 + 浮窗(WebView2)+ inject-ui.js
//
// 用法:
//   node monitor.mjs             启动服务(默认 http://127.0.0.1:50143/api/monitor/page)
//   node monitor.mjs --probe     勘察智谱控制台接口(弹出专用 Edge,需已登录)
//   node monitor.mjs --once      只采样一次并打印,不起服务(自检用)
'use strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregate, bucketize, dbMtime, DEFAULT_DB, fetchAllTotals, fetchDaily, fetchLastReqAt, fetchSessionTitles, fetchTurnStats, fetchUsage, openSnapshot, startOfToday } from './lib/db.mjs';
import { estimateCost, modelRate, normalizePeakWindows, peakNow } from './lib/pricing.mjs';
import { collect, defaultZhipuConfig, endpointsConfigured, probe, ZHIPU_URLS } from './lib/zhipu.mjs';
import { cdpAlive, ensureEdge, sleep } from './lib/cdp.mjs';
import { renderPage } from './page.mjs';

const BASE_DIR = dirname(fileURLToPath(import.meta.url));
// PowerShell 路径用 path.join 拼(字面反斜杠在多轮编辑里被吞过两次,别再写)
const PS_EXE = join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const HISTORY_FILE = join(BASE_DIR, 'history.jsonl');
const PRICES_FILE = join(BASE_DIR, 'prices.json');
const CONFIG_FILE = join(BASE_DIR, 'monitor-config.json');
const HISTORY_MAX_BYTES = 8 * 1024 * 1024; // 与 EAC 同款截断策略

const RANGES = {
  '1m': 60 * 1000, '5m': 5 * 60 * 1000, '10m': 10 * 60 * 1000, '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000, '2h': 2 * 60 * 60 * 1000, '1d': 24 * 60 * 60 * 1000, '7d': 7 * 24 * 60 * 60 * 1000,
};

function readJson(p, fallback) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
}

let cfg = { port: 50143, host: '127.0.0.1', ...readJson(CONFIG_FILE, {}) };
const zhipuCfg = defaultZhipuConfig(BASE_DIR);
const prices = readJson(PRICES_FILE, { calibrated: false, rates: {} });
const peakWindows = normalizePeakWindows(prices.peakWindows, []);

const state = {
  startedAt: Date.now(),
  updatedAt: 0,
  today: null,
  yesterday: null,
  byModel: [],
  bySession: [],
  totals: {},
  costEstimate: { calibrated: !!prices.calibrated, byModel: {}, total: null, tier: peakNow(peakWindows, !!prices.weekendOffpeak) ? 'peak' : 'offpeak' },
  history: { points: 0, bytes: 0, lastAt: 0 },
  db: { path: DEFAULT_DB, source: '', mtime: 0, error: '' },
  zhipu: { ok: false, status: 'idle', hint: '尚未采集', at: 0, data: {} },
  errors: [],
};

// ── 浮窗层(复用 EacMonitorFloat 外壳:WebView2 + float-config.json + inject-ui.js) ──
const FLOAT_DIR = join(BASE_DIR, 'float');
const FLOAT_EXE = join(FLOAT_DIR, 'EacMonitorFloat.exe');
const FLOAT_CFG = join(FLOAT_DIR, 'float-config.json');
const FLOAT_POS = join(BASE_DIR, 'float-position.json'); // 记住用户拖动后的几何
let floatProc = null;
let floatSpawning = false; // 同步占位:防同一 tick 的重复 spawn(EAC 踩过的双开坑)
let lastFloatLaunchAt = 0; // 冷却窗口:Start-Process 返回后进程还没出现在进程表里,光靠"查不到就再起一个"会双开

// 清掉遗留的本项目浮窗(EAC 踩过的孤儿浮窗坑:detached 进程在服务重启后仍存活)
// 匹配放宽:ExecutablePath 大小写不敏感精确比较;读不到路径(实测有进程拿不到)就退回命令行匹配目录
async function killStrayFloats() {
  const exeLower = FLOAT_EXE.toLowerCase().replace(/'/g, "''");
  const dirMatch = FLOAT_DIR.replace(/\\/g, '\\\\').replace(/'/g, "''");
  const cmd = "Get-CimInstance Win32_Process -Filter \"Name='EacMonitorFloat.exe'\" | " +
    `Where-Object { ($_.ExecutablePath -and $_.ExecutablePath.ToLower() -eq '${exeLower}') -or ($_.CommandLine -and $_.CommandLine -match '${dirMatch}') } | ` +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
  await new Promise((res) => {
    const ch = spawn(PS_EXE, ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true });
    ch.on('error', res);
    ch.on('close', res);
    setTimeout(res, 8000);
  });
  await sleep(800);
}

// PowerShell 单引号字符串转义:内部单引号要写成两个
function psQuote(v) { return "'" + String(v).replace(/'/g, "''") + "'"; }

// 本项目浮窗进程数(用于"多于一个就收敛成一个")
async function floatCount() {
  return new Promise((res) => {
    const exeLower = FLOAT_EXE.toLowerCase().replace(/'/g, "''");
    const cmd = "Get-CimInstance Win32_Process -Filter \"Name='EacMonitorFloat.exe'\" | " +
      `Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLower() -eq '${exeLower}' } | Measure-Object | Select-Object -ExpandProperty Count`;
    let ch;
    try { ch = spawn(PS_EXE, ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true }); }
    catch { return res(0); }
    let out = '';
    ch.stdout.on('data', (d) => { out += d; });
    ch.on('error', () => res(0));
    ch.on('close', () => res(Number(String(out).trim()) || 0));
    setTimeout(() => res(0), 8000);
  });
}

function floatAlive() {
  if (!floatProc || floatProc.killed) return false;
  try { process.kill(floatProc.pid, 0); return true; } catch { return false; }
}

// 本项目是否已有浮窗进程(不依赖本进程的追踪:可能由上一轮服务或用户手动拉起)
async function floatExists() {
  return new Promise((res) => {
    const exeLower = FLOAT_EXE.toLowerCase().replace(/'/g, "''");
    const dirMatch = FLOAT_DIR.replace(/\\/g, '\\\\').replace(/'/g, "''");
    const cmd = "Get-CimInstance Win32_Process -Filter \"Name='EacMonitorFloat.exe'\" | " +
      `Where-Object { ($_.ExecutablePath -and $_.ExecutablePath.ToLower() -eq '${exeLower}') -or ($_.CommandLine -and $_.CommandLine -match '${dirMatch}') } | ` +
      'Measure-Object | Select-Object -ExpandProperty Count';
    let ch;
    try { ch = spawn(PS_EXE, ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true }); }
    catch { return res(false); }
    let out = '';
    ch.stdout.on('data', (d) => { out += d; });
    ch.on('error', () => res(false));
    ch.on('close', () => res(Number(String(out).trim()) > 0));
    setTimeout(() => res(false), 8000);
  });
}

async function spawnFloat() {
  // 守卫必须全部是"同步判定 + 同步占位",任何 await 之前就要把 floatSpawning 立起来。
  // 踩过的坑:把 await floatExists() 写在占位之前 → 两个调用在同一 tick 都通过了守卫,
  // 各开一个窗口(实测日志里连着两条 [spawn] 进入,然后两条 启动浮窗进程)。
  if (floatSpawning) return { ok: false, reason: 'spawning' };
  // 冷却期内直接当成已开:服务启动时的自动开窗与启动脚本的 POST 会撞在同一秒
  if (Date.now() - lastFloatLaunchAt < 15000) return { ok: true, reason: 'just-launched' };
  floatSpawning = true;
  try {
    if (await floatExists()) return { ok: false, reason: 'already-running' };
    if (!existsSync(FLOAT_EXE)) return { ok: false, reason: 'missing-exe' };
    await killStrayFloats();
    // 再确认一次:同一时刻只允许一个监控窗口,否则"关掉一个还剩一个"看起来就像关不掉
    if (await floatExists()) {
      await killStrayFloats();
      await sleep(600);
    }
    const top = cfg.layerMode === 'normal' ? '0' : '1';
    // 几何:读外壳配置(float-config.json,物理像素)交给助手摆位,避免落到外壳默认的左上角小窗
    let geo = null;
    try { geo = JSON.parse(readFileSync(FLOAT_CFG, 'utf8')); } catch { geo = null; }
    // 用 PowerShell Start-Process 而不是 spawn:服务自己是"隐藏"启动的,spawn 出来的窗口会继承
    // 隐藏/最小化状态(实测窗口一出生就是 minimized,看起来就是在角落的小窗);Start-Process
    // 走 ShellExecute,窗口按正常可见状态创建。
    const url = `http://${cfg.host}:${cfg.port}/api/monitor/page`;
    const opacity = String(geo && geo.opacity ? geo.opacity : 0.96);
    lastFloatLaunchAt = Date.now();
    const psCmd = 'Start-Process -FilePath ' + psQuote(FLOAT_EXE) +
      ' -ArgumentList ' + [psQuote('--url'), psQuote(url), psQuote('--top'), psQuote(top), psQuote('--opacity'), psQuote(opacity)].join(',');
    await new Promise((res) => {
      let ch;
      try { ch = spawn(PS_EXE, ['-NoProfile', '-NonInteractive', '-Command', psCmd], { windowsHide: true }); }
      catch { return res(); }
      ch.on('error', res);
      ch.on('close', res);
      setTimeout(res, 8000);
    });
    // 等窗口进程真正出现(Start-Process 返回 ≠ 进程已可见),最多 8 秒
    let ok = false;
    for (let i = 0; i < 8; i += 1) {
      await sleep(1000);
      if (await floatExists()) { ok = true; break; }
    }
    if (ok) {
      floatSpawnedOnce = true;
      // 收敛:同一时刻屏幕上只该有一个监控窗口(双开时用户关了其中一个,另一个还在,看起来像"关不掉")
      const n = await floatCount();
      if (n > 1) {
        await killStrayFloats();
        await sleep(500);
        await new Promise((res) => {
          let ch;
          try { ch = spawn(PS_EXE, ['-NoProfile', '-NonInteractive', '-Command', psCmd], { windowsHide: true }); }
          catch { return res(); }
          ch.on('error', res); ch.on('close', res); setTimeout(res, 8000);
        });
      }
    }
    const pid = null;
    startFloatHelper(); // 幂等:图标/标题栏/摆位由助手负责
    return ok ? { ok: true, pid } : { ok: false, reason: 'launch-failed' };
  } catch (e) {
    return { ok: false, reason: String(e && e.message || e) };
  } finally {
    floatSpawning = false;
  }
}


// 浮窗外观(图标 + 标题栏配色):由常驻助手 float-helper.ps1 负责。
// 常驻的原因:WM_SETICON 只交接 HICON 句柄不复制图像,设置图标的进程一退出句柄就失效;
// 助手还会每 3 秒复查,浮窗重启后自动重新应用。
const FLOAT_HELPER = join(BASE_DIR, 'float-helper.ps1');
const FLOAT_ICON = join(FLOAT_DIR, 'zcode.ico');
let helperProc = null;

function killStrayHelpers() {
  const ps = PS_EXE;
  const cmd = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'float-helper' } | " +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
  try { spawn(ps, ['-NoProfile', '-NonInteractive', '-Command', cmd], { stdio: 'ignore', windowsHide: true }).unref(); } catch { /* 忽略 */ }
}

function startFloatHelper() {
  if (helperProc && !helperProc.killed) return;
  if (!existsSync(FLOAT_HELPER) || !existsSync(FLOAT_ICON)) return;
  killStrayHelpers(); // 上一轮服务退出时可能留下助手(它不属于新进程,杀不掉旧的)
  try {
    // 置顶沿用启动时的意图(注意:这里不能用 spawnFloat 的局部 top —— 之前就是引用它导致
    // ReferenceError 被下面的空 catch 吞掉,助手一直没启动,图标/标题栏/摆位全都静默失效)
    const topFlag = cfg.layerMode === 'normal' ? '0' : '1';
    const geoArgs = [];
    try {
      const g = JSON.parse(readFileSync(FLOAT_CFG, 'utf8'));
      if (g && Number.isFinite(g.left) && Number.isFinite(g.topY) && g.w > 0 && g.h > 0) {
        geoArgs.push('-X', String(Math.round(g.left)), '-Y', String(Math.round(g.topY)), '-W', String(Math.round(g.w)), '-H', String(Math.round(g.h)));
      }
    } catch { /* 没配置就不摆位,尊重外壳自己的坐标 */ }
    helperProc = spawn(PS_EXE, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden', '-File', FLOAT_HELPER,
      '-ExePath', FLOAT_EXE, '-IcoPath', FLOAT_ICON,
      '-PosFile', FLOAT_POS, '-Top', topFlag,
      ...geoArgs,
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    helperProc.on('error', (e) => { console.log('[helper] 启动失败: ' + (e && e.message)); helperProc = null; }); // 路径异常也不能让服务崩
    if (helperProc.stderr) helperProc.stderr.on('data', (d) => { try { appendFileSync(join(BASE_DIR, '_helper.log'), String(d)); } catch { /* 忽略 */ } });
    helperProc.on('exit', (code, signal) => {
      console.log('[helper] 退出 code=' + code + ' signal=' + signal);
      helperProc = null;
    });
  } catch (e) {
    console.log('[helper] 启动异常: ' + String((e && e.message) || e));
    helperProc = null;
  }
}



// ── 生命周期:窗口即程序 ──────────────────────────────────────────────────
// 设计取向(2026-09-23 按用户要求改):监控是"打开一个窗口",不是"常驻一个后台服务"。
//   窗口关掉(点关闭按钮或系统 ✕) → 服务自己退出,不留后台进程。
//   需要只开网页、不要窗口的常驻模式:启动时加 --daemon(或 monitor-config.json 里 "daemon": true)。
let shuttingDown = false;
function shutdown(reason, { killFloat = false } = {}) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[zcode-glm-monitor] 退出:' + reason);
  killStrayFloats().catch(() => {});  // 退出时不留孤儿浮窗(按进程名清理,故不必记录 pid)
  try { helperProc && helperProc.kill(); } catch { /* 忽略 */ }
  try { server.close(); } catch { /* 忽略 */ }
  setTimeout(() => process.exit(0), 300);
}

// 窗口消失检测:每 20 秒确认一次浮窗是否还在,连续两次不在就退出
let floatGoneStreak = 0;
let floatSpawnedOnce = false;
async function lifecycleCheck() {
  if (cfg.daemon === true) return;
  if (!floatSpawnedOnce) return; // 还没开过窗口(例如只跑 --once / daemon)
  const alive = await floatExists();
  if (alive) { floatGoneStreak = 0; return; }
  floatGoneStreak += 1;
  if (floatGoneStreak >= 2) shutdown('监控窗口已关闭');
}

// ── 采样一次本地用量库 ─────────────────────────────────────────────────────
function sampleLocal() {
  const now = Date.now();
  const t0 = startOfToday(now);
  const t1 = t0 - 24 * 60 * 60 * 1000; // 昨日
  try {
    const snap = openSnapshot(DEFAULT_DB);
    state.db.source = snap.source;
    state.db.mtime = dbMtime(DEFAULT_DB);
    const titles = fetchSessionTitles(snap.db);
    const rowsToday = fetchUsage(snap.db, t0);
    const rowsYest = fetchUsage(snap.db, t1).filter((r) => r.started_at < t0);
    const aggToday = aggregate(rowsToday, titles);
    const aggYest = aggregate(rowsYest, titles);

    state.today = aggToday.total;
    state.yesterday = aggYest.total;
    state.byModel = aggToday.byModel;
    state.byProvider = aggToday.byProvider;
    state.bySession = aggToday.bySession.slice(0, 8);
    state.turns = fetchTurnStats(snap.db, t0);
    state.allTime = fetchAllTotals(snap.db);
    state.daily = fetchDaily(snap.db, 7, now);
    state.db.lastReqAt = fetchLastReqAt(snap.db);
    state.updatedAt = now;
    state.db.error = '';

    // 本地估算金额(仅在价格已校准时给出)
    const byModelCost = {};
    let sum = 0; let allKnown = true;
    for (const m of aggToday.byModel) {
      const rates = modelRate(prices, m.model);
      const est = estimateCost(m, rates);
      if (!est) { byModelCost[m.model] = null; allKnown = false; continue; }
      const v = est[state.costEstimate.tier];
      byModelCost[m.model] = v;
      sum += v;
    }
    state.costEstimate.byModel = byModelCost;
    state.costEstimate.calibrated = !!prices.calibrated;
    state.costEstimate.tier = peakNow(peakWindows, !!prices.weekendOffpeak) ? 'peak' : 'offpeak';
    state.costEstimate.total = prices.calibrated && allKnown ? sum : null;
    snap.db.close();
  } catch (e) {
    state.db.error = String(e && e.message || e);
    state.errors.push({ at: now, where: 'local', msg: state.db.error });
  }
}

// ── 采集一次智谱云侧 ───────────────────────────────────────────────────────
let autoProbeAt = 0;
async function sampleCloud() {
  if (!endpointsConfigured(zhipuCfg)) {
    // 未勘察:若监控 Edge 已在跑,自动打一次勘察(用户登录一次后无需再手动跑脚本)。
    // 限流 10 分钟一次,避免在登录页上反复开合页面。
    if (Date.now() - autoProbeAt > 10 * 60 * 1000) {
      autoProbeAt = Date.now();
      try {
        const alive = await cdpAlive(zhipuCfg.port);
        if (alive) {
          const r = await probe(zhipuCfg);
          if (r.endpoints.length && endpointsConfigured(zhipuCfg)) {
            state.zhipu = { ok: false, status: 'configured', hint: '已自动勘察到接口,下一轮开始取数', at: Date.now(), data: {} };
            return;
          }
        }
      } catch { /* 自动勘察失败不阻塞,等下次 */ }
    }
    state.zhipu = {
      ok: false, status: 'unconfigured',
      hint: '未接入:点页面「接入智谱控制台」→ 在弹出窗口登录一次,之后会自动勘察接口并取数',
      at: Date.now(), data: {},
    };
    return;
  }
  const r = await collect(zhipuCfg);
  state.zhipu = { ok: !!r.ok, status: r.status || (r.ok ? 'ok' : 'failed'), hint: r.hint || '', at: Date.now(), data: r.data || {} };
  state.cloud = r.ok ? normalizeCloud(state.zhipu) : (state.cloud || null);
}

// ── 历史点(趋势图的长时窗数据源:云侧数值 + 本地 token 汇总) ─────────────────
function appendHistory() {
  try {
    const point = {
      t: Date.now(),
      tok: state.today ? {
        in: state.today.in, out: state.today.out, cacheR: state.today.cacheR,
        cacheW: state.today.cacheW, total: state.today.total, req: state.today.req,
      } : null,
      models: Object.fromEntries(state.byModel.slice(0, 8).map((m) => [m.model, m.total])),
      cost: state.costEstimate.total,
      officialCost: state.cloud ? (state.cloud.todaySpend != null ? state.cloud.todaySpend : state.cloud.curMonthAmount) : null,
      tokenPackLeft: state.cloud ? state.cloud.tokenPackLeft : null,
      planTimesLeft: state.cloud ? state.cloud.planTimesLeft : null,
    };
    appendFileSync(HISTORY_FILE, JSON.stringify(point) + '\n', 'utf8');
    const st = statSync(HISTORY_FILE);
    if (st.size > HISTORY_MAX_BYTES) {
      // 截断:保留后半段(整行截断)
      const text = readFileSync(HISTORY_FILE, 'utf8');
      const lines = text.split('\n');
      const keep = lines.slice(Math.floor(lines.length / 2)).join('\n');
      writeFileSync(HISTORY_FILE + '.tmp', keep, 'utf8');
      renameSync(HISTORY_FILE + '.tmp', HISTORY_FILE);
    }
    state.history.lastAt = point.t;
  } catch (e) {
    state.errors.push({ at: Date.now(), where: 'history', msg: String(e && e.message || e) });
  }
  try {
    const lines = readFileSync(HISTORY_FILE, 'utf8').trim().split('\n').filter(Boolean);
    state.history.points = lines.length;
    state.history.bytes = statSync(HISTORY_FILE).size;
  } catch { /* 首次还没有文件 */ }
}

// ── 云侧数据规范化(原始返回 → 页面字段) ──────────────────────────────────
// 字段来源见 zhipu-endpoints.json 的 _fields 注释(均已在真实数据上核对过)
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

function normalizeCloud(z) {
  const pick = (name) => {
    const d = z && z.data && z.data[name];
    return d && d.code === 200 && d.json != null ? d.json : null;
  };
  const acc = pick('account') || {};
  const pack = pick('tokenPack') || {};
  const plan = pick('codingPlan') || {};
  const monthly = pick('monthly') || {};
  const bills = pick('bills');
  const recs = Array.isArray(monthly.consumptionRecord) ? monthly.consumptionRecord : [];
  const months = recs
    .map((r) => ({ month: String(r.billingMonth || ''), amount: num(r.settlementAmount) || 0 }))
    .filter((m) => m.month);
  const nowMonth = new Date().toISOString().slice(0, 7);
  const cur = months.find((m) => m.month === nowMonth);
  return {
    // 余额口径字段(balance/availableBalance/frozenBalance)按用户要求不再展示,故不进入视图
    recharge: num(acc.rechargeAmount),
    given: num(acc.giveAmount),
    totalSpend: num(acc.totalSpendAmount),
    todaySpend: num(acc.todaySpendAmount),
    creditStatus: acc.creditStatus || '',
    tokenPackLeft: num(pack.tokens),
    planTimesLeft: num(plan.times),
    planTokens: num(plan.tokens),
    months,
    curMonthAmount: cur ? cur.amount : null,
    bills: Array.isArray(bills) ? bills.map((b) => ({
      month: String(b.billingMonth || ''),
      original: num(b.originalAmount),
      paid: num(b.paidAmount),
      unpaid: num(b.unpaidAmount),
    })) : [],
  };
}

// ── 趋势序列(本地 DB 直接算,支持任意档位) ────────────────────────────────
// 语义:档位 = 时间窗口宽度,窗口内固定切 60 个桶(bucket = window/60,下限 5 秒)。
// 这样 1m 看秒级、7d 看小时级,而不是"60 个 1d 桶 = 60 天"。
function seriesFor(range) {
  const windowMs = RANGES[range] || RANGES['1h'];
  const bucketMs = Math.max(5000, Math.round(windowMs / 60));
  const now = Date.now();
  const from = now - bucketMs * 60;
  const snap = openSnapshot(DEFAULT_DB);
  const rows = fetchUsage(snap.db, from);
  snap.db.close();
  const points = bucketize(rows, from, from + bucketMs * 60, bucketMs);
  return { range, bucketMs, windowMs, from, to: now, points };
}

// ── HTTP ──────────────────────────────────────────────────────────────────
function json(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  try {
    if (p === '/api/monitor/page') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(renderPage({ port: cfg.port }));
    }
    if (p === '/api/monitor/data') {
      return json(res, {
        ok: true,
        now: Date.now(),
        updatedAt: state.updatedAt,
        startedAt: state.startedAt,
        today: state.today,
        yesterday: state.yesterday,
        byModel: state.byModel,
        byProvider: state.byProvider || [],
        bySession: state.bySession || [],
        turns: state.turns || {},
        allTime: state.allTime || null,
        cloud: state.cloud || null,
        daily: state.daily || [],
        cost: state.costEstimate,
        history: state.history,
        db: state.db,
        zhipu: state.zhipu,
        errors: state.errors.slice(-5),
        ranges: Object.keys(RANGES),
      });
    }
    if (p === '/api/monitor/series') {
      return json(res, { ok: true, ...seriesFor(url.searchParams.get('range') || '1h') });
    }
    if (p === '/api/monitor/history') {
      const limit = Math.max(10, Math.min(5000, Number(url.searchParams.get('limit')) || 720));
      let lines = [];
      try { lines = readFileSync(HISTORY_FILE, 'utf8').trim().split('\n').filter(Boolean).slice(-limit); } catch { /* 无历史 */ }
      const points = [];
      for (const l of lines) { try { points.push(JSON.parse(l)); } catch { /* 跳过坏行 */ } }
      return json(res, { ok: true, points });
    }
    if (p === '/api/monitor/config') {
      if (req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        try {
          const patch = JSON.parse(body || '{}');
          // 兼容两种写法:{key,value}(页面/inject-ui 用) 与 扁平对象
          if (patch && typeof patch.key === 'string') cfg = { ...cfg, [patch.key]: patch.value };
          else cfg = { ...cfg, ...patch };
          writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
        } catch { /* 忽略坏 body */ }
      }
      return json(res, { ok: true, config: cfg });
    }
    if (p === '/api/monitor/cloud' && req.method === 'POST') {
      await sampleCloud();
      return json(res, { ok: state.zhipu.ok, zhipu: state.zhipu });
    }
    if (p === '/api/monitor/shutdown' && req.method === 'POST') {
      json(res, { ok: true, hint: '监控已关闭' });
      setTimeout(() => shutdown('页面请求关闭', { killFloat: true }), 350);
      return undefined;
    }
    if (p === '/api/monitor/float' && req.method === 'POST') {
      const r = await spawnFloat();
      return json(res, r);
    }
    if (p === '/api/monitor/open-console' && req.method === 'POST') {
      // 拉起监控专用 Edge 到智谱财务总览页(未登录时是登录页,登录后即可勘察)
      try {
        const urls = [ZHIPU_URLS.overview, ZHIPU_URLS.expense];
        const port = await ensureEdge({ port: zhipuCfg.port, profileDir: zhipuCfg.profileDir, urls });
        return json(res, {
          ok: true,
          port,
          hint: '如果显示的是登录页,请在该窗口登录 open.bigmodel.cn(只需一次)。'
            + '登录后双击项目目录里的「勘察智谱接口.cmd」抓取接口;'
            + '抓完本卡片的余额与官方账单就会自动出现(服务每 5 分钟采一次)。',
        });
      } catch (e) {
        return json(res, { ok: false, hint: String(e && e.message || e) });
      }
    }
    if (p === '/api/monitor/probe' && req.method === 'POST') {
      const r = await probe(zhipuCfg);
      return json(res, { ok: r.endpoints.length > 0, pages: r.pages, endpoints: r.endpoints.length, suggested: r.suggested });
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('not found');
  } catch (e) {
    return json(res, { ok: false, error: String(e && e.message || e) }, 500);
  }
});

// ── 启动 ──────────────────────────────────────────────────────────────────
function start() {
  mkdirSync(BASE_DIR, { recursive: true });
  // 浮窗几何:没有配置文件时给一份默认(右侧竖长条),之后由用户拖动决定
  if (!existsSync(FLOAT_CFG)) {
    writeFileSync(FLOAT_CFG, JSON.stringify({ top: cfg.layerMode === 'normal' ? false : true, opacity: 0.92, left: 1100, topY: 120, w: 560, h: 900 }), 'utf8');
  }
  sampleLocal();
  appendHistory();
  server.listen(cfg.port, cfg.host, () => {
    console.log(`[zcode-glm-monitor] 页面: http://${cfg.host}:${cfg.port}/api/monitor/page`);
    console.log(`[zcode-glm-monitor] 本地库: ${DEFAULT_DB} (${state.db.source})`);
    console.log(`[zcode-glm-monitor] 智谱侧: ${endpointsConfigured(zhipuCfg) ? '已配置适配器' : '未勘察(跑 --probe)'}`);
    startFloatHelper();
    if (cfg.float !== false) {
      spawnFloat().then((r) => console.log('[zcode-glm-monitor] 浮窗:', JSON.stringify(r)));
    }
  });
  setInterval(() => { lifecycleCheck().catch(() => {}); }, 20 * 1000);
  setInterval(sampleLocal, 15 * 1000);
  setInterval(appendHistory, 60 * 1000);
  setInterval(() => { sampleCloud().catch(() => {}); }, (cfg.cloudIntervalSec || 60) * 1000);
  sampleCloud().catch(() => {});
}

process.on('exit', () => { try { helperProc && helperProc.kill(); } catch { /* 已退出 */ } });
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { helperProc && helperProc.kill(); } catch { /* 已退出 */ } process.exit(0); });
}

const args = process.argv.slice(2);
if (args.includes('--daemon')) cfg = { ...cfg, daemon: true };
if (args.includes('--probe')) {
  probe(zhipuCfg).then((r) => {
    console.log('勘察完成 → ' + zhipuCfg.probeFile);
    console.log('登录状态:', JSON.stringify(r.pages, null, 2));
    console.log('抓到接口 ' + r.endpoints.length + ' 条,按"像财务数据"排序,前 12 条:');
    for (const e of r.endpoints.slice(0, 12)) {
      console.log(`  [${e.interesting ? '★' : ' '}] ${e.status} ${e.url}`);
      console.log(`      topKeys=${JSON.stringify(e.topKeys)}  ${String(e.sample).slice(0, 160)}`);
    }
    if (!r.endpoints.length) console.log('  未抓到任何接口 —— 多半是专用 Edge 未登录智谱,请在弹出的窗口登录后重跑。');
  }).catch((e) => { console.error('勘察失败:', e && e.message || e); process.exitCode = 1; });
} else if (args.includes('--once')) {
  sampleLocal();
  console.log(JSON.stringify({
    updatedAt: state.updatedAt, today: state.today, byModel: state.byModel,
    bySession: state.bySession?.slice(0, 3), cost: state.costEstimate, db: state.db,
  }, null, 2));
  seriesFor('1h');
  console.log('series ok');
} else {
  start();
}
