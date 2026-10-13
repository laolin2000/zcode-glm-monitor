// db.mjs — 读取 ZCode 本地用量库(只读)
// 数据源:B  |  位置:C:\Users\<user>\.zcode\cli\db\db.sqlite
//   model_usage  每次模型请求一行(模型/供应商/token 明细/时间/状态)
//   turn_usage   每个回合一行的汇总
// 库是 WAL 模式且被 ZCode 进程持续写入 → 先快照三个文件再查,避免锁冲突与读到半写状态。
'use strict';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

export const DEFAULT_DB = join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite');

function openReadOnly(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 3000;');
  return db;
}

// 快照(含 -wal/-shm)到临时目录;失败则退回直连只读
export function openSnapshot(dbPath = DEFAULT_DB, snapDir = join(tmpdir(), 'zcode-glm-monitor-snap')) {
  try {
    if (!existsSync(dbPath)) throw new Error('数据库不存在:' + dbPath);
    mkdirSync(snapDir, { recursive: true });
    const dst = join(snapDir, 'db.sqlite');
    for (const suffix of ['', '-wal', '-shm']) {
      const src = dbPath + suffix;
      const target = dst + suffix;
      if (existsSync(src)) copyFileSync(src, target);
      else if (existsSync(target)) rmSync(target, { force: true });
    }
    return { db: openReadOnly(dst), source: 'snapshot' };
  } catch {
    return { db: openReadOnly(dbPath), source: 'direct' };
  }
}

export function dbMtime(dbPath = DEFAULT_DB) {
  try { return statSync(dbPath).mtimeMs; } catch { return 0; }
}

// 拉取 [sinceMs, now] 的请求级明细
export function fetchUsage(db, sinceMs) {
  const rows = db.prepare(`
    SELECT model_id, provider_id, query_source, status, agent, mode,
           input_tokens, output_tokens, reasoning_tokens,
           cache_read_input_tokens, cache_creation_input_tokens,
           computed_total_tokens, started_at, session_id, turn_id,
           tool_call_count, error_type
    FROM model_usage
    WHERE started_at >= ?
    ORDER BY started_at ASC
  `).all(sinceMs);
  return rows.map((r) => ({ ...r }));
}

export function fetchSessionTitles(db) {
  const map = new Map();
  try {
    for (const r of db.prepare('SELECT id, title, directory FROM session').all()) map.set(r.id, r);
  } catch { /* session 表结构变动时不影响主流程 */ }
  return map;
}

// 全历史累计(不限时间窗口):总量级小,直接一次 SUM
export function fetchAllTotals(db) {
  try {
    const r = db.prepare(`
      SELECT count(*) AS req,
             COALESCE(sum(input_tokens),0)  AS input_tokens,
             COALESCE(sum(output_tokens),0) AS output_tokens,
             COALESCE(sum(reasoning_tokens),0) AS reasoning_tokens,
             COALESCE(sum(cache_read_input_tokens),0) AS cache_read_input_tokens,
             COALESCE(sum(cache_creation_input_tokens),0) AS cache_creation_input_tokens,
             COALESCE(sum(computed_total_tokens),0) AS computed_total_tokens
      FROM model_usage
    `).get() || {};
    return {
      in: Number(r.input_tokens) || 0, out: Number(r.output_tokens) || 0, reason: Number(r.reasoning_tokens) || 0,
      cacheR: Number(r.cache_read_input_tokens) || 0, cacheW: Number(r.cache_creation_input_tokens) || 0,
      total: Number(r.computed_total_tokens) || 0, req: Number(r.req) || 0, err: 0,
    };
  } catch {
    return null;
  }
}

// 近 N 天逐日汇总(本地时区自然日;旧的在前)
export function fetchDaily(db, days = 7, now = Date.now()) {
  const out = [];
  const today0 = startOfToday(now);
  const stmt = db.prepare(`
    SELECT count(*) AS req,
           COALESCE(sum(input_tokens),0)  AS input_tokens,
           COALESCE(sum(output_tokens),0) AS output_tokens,
           COALESCE(sum(reasoning_tokens),0) AS reasoning_tokens,
           COALESCE(sum(cache_read_input_tokens),0) AS cache_read_input_tokens,
           COALESCE(sum(cache_creation_input_tokens),0) AS cache_creation_input_tokens,
           COALESCE(sum(computed_total_tokens),0) AS computed_total_tokens
    FROM model_usage WHERE started_at >= ? AND started_at < ?
  `);
  for (let i = days - 1; i >= 0; i -= 1) {
    const t = today0 - i * 86400000;
    const r = stmt.get(t, t + 86400000) || {};
    out.push({
      t,
      total: Number(r.computed_total_tokens) || 0,
      in: Number(r.input_tokens) || 0,
      out: Number(r.output_tokens) || 0,
      cacheR: Number(r.cache_read_input_tokens) || 0,
      req: Number(r.req) || 0,
    });
  }
  return out;
}

// 最近一条请求的时间(用于"最后一条请求"提示,区分"库没在写"与"确实没请求")
export function fetchLastReqAt(db) {
  try {
    const r = db.prepare('SELECT max(started_at) m FROM model_usage').get();
    return Number(r && r.m) || 0;
  } catch {
    return 0;
  }
}

export function fetchTurnStats(db, sinceMs) {  try {
    return db.prepare(`
      SELECT count(*) AS turns,
             sum(model_request_count) AS requests,
             sum(model_retry_count)  AS retries,
             sum(tool_call_count)    AS tools,
             sum(tool_error_count)   AS toolErrors,
             sum(duration_ms)        AS durationMs
      FROM turn_usage WHERE started_at >= ?
    `).get(sinceMs) || {};
  } catch {
    return {};
  }
}

const EMPTY = () => ({ in: 0, out: 0, reason: 0, cacheR: 0, cacheW: 0, total: 0, req: 0, err: 0 });

function addTok(acc, r) {
  acc.in += Number(r.input_tokens) || 0;
  acc.out += Number(r.output_tokens) || 0;
  acc.reason += Number(r.reasoning_tokens) || 0;
  acc.cacheR += Number(r.cache_read_input_tokens) || 0;
  acc.cacheW += Number(r.cache_creation_input_tokens) || 0;
  acc.total += Number(r.computed_total_tokens) || 0;
  acc.req += 1;
  if (r.error_type) acc.err += 1;
  return acc;
}

// 分组聚合:按模型 / 供应商 / 会话
export function aggregate(rows, titles = new Map()) {
  const byModel = new Map();
  const byProvider = new Map();
  const bySession = new Map();
  const total = EMPTY();
  for (const r of rows) {
    addTok(total, r);
    const m = byModel.get(r.model_id) || { ...EMPTY(), model: r.model_id, provider: r.provider_id };
    addTok(m, r);
    byModel.set(r.model_id, m);
    const p = byProvider.get(r.provider_id) || { ...EMPTY(), provider: r.provider_id };
    addTok(p, r);
    byProvider.set(r.provider_id, p);
    const sid = r.session_id || '-';
    const s = bySession.get(sid) || { ...EMPTY(), sessionId: sid, title: (titles.get(sid) || {}).title || sid, lastAt: 0 };
    addTok(s, r);
    s.lastAt = Math.max(s.lastAt, Number(r.started_at) || 0);
    bySession.set(sid, s);
  }
  const sortByTotal = (a, b) => b.total - a.total;
  return {
    total,
    byModel: [...byModel.values()].sort(sortByTotal),
    byProvider: [...byProvider.values()].sort(sortByTotal),
    bySession: [...bySession.values()].sort(sortByTotal),
  };
}

// 时间分桶(供趋势图):bucketMs 由前端档位决定
export function bucketize(rows, sinceMs, untilMs, bucketMs) {
  const n = Math.max(1, Math.ceil((untilMs - sinceMs) / bucketMs));
  const buckets = Array.from({ length: n }, (_, i) => ({
    t: sinceMs + i * bucketMs,
    total: 0, in: 0, out: 0, cacheR: 0, cacheW: 0, req: 0,
    models: {},
  }));
  for (const r of rows) {
    const idx = Math.min(n - 1, Math.max(0, Math.floor(((Number(r.started_at) || 0) - sinceMs) / bucketMs)));
    const b = buckets[idx];
    const tok = Number(r.computed_total_tokens) || 0;
    b.total += tok;
    b.in += Number(r.input_tokens) || 0;
    b.out += Number(r.output_tokens) || 0;
    b.cacheR += Number(r.cache_read_input_tokens) || 0;
    b.cacheW += Number(r.cache_creation_input_tokens) || 0;
    b.req += 1;
    b.models[r.model_id] = (b.models[r.model_id] || 0) + tok;
  }
  return buckets;
}

// 日窗口起点(本地时区 00:00)
export function startOfToday(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
