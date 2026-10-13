// pricing.mjs — 本地估算费用(峰谷时段判定移植自 DSH 侧的 balance.js 逻辑)
// 只做本地估算;云侧官方账单(数据源 A)永远是权威口径。
'use strict';

function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]); const mn = Number(m[2]);
  if (h > 23 || mn > 59) return null;
  return h * 60 + mn;
}

export function normalizePeakWindows(raw, fallback = []) {
  const valid = Array.isArray(raw) && raw.length > 0 &&
    raw.every((w) => Array.isArray(w) && w.length === 2 && parseHHMM(w[0]) !== null && parseHHMM(w[1]) !== null);
  const src = valid ? raw : fallback;
  return src.map(([a, b]) => [parseHHMM(a), parseHHMM(b)]).sort((x, y) => x[0] - y[0]);
}

function inWindow(min, [s, e]) {
  return s < e ? min >= s && min < e : min >= s || min < e;
}

export function peakNow(windows, weekendOffpeak, now = new Date()) {
  const min = now.getHours() * 60 + now.getMinutes();
  if (weekendOffpeak) {
    const dow = now.getDay();
    if (dow === 0 || dow === 6) return false;
  }
  return windows.some((w) => inWindow(min, w));
}

// 单个模型在某个档位下的单价(元/百万 token)。任一必需项缺失 → null(表示不可估算)
export function modelRate(prices, modelId) {
  const r = (prices && prices.rates && prices.rates[modelId]) || null;
  if (!r) return null;
  const pick = (tier) => {
    const src = (r[tier] && typeof r[tier] === 'object') ? r[tier] : r;
    const v = ['cacheMiss', 'cacheHit', 'output'].map((k) => Number(src[k]));
    if (v.some((x) => !Number.isFinite(x) || x < 0)) return null;
    return { cacheMiss: v[0], cacheHit: v[1], output: v[2] };
  };
  const peak = pick('peak');
  const off = pick('offpeak') || peak;
  if (!peak && !off) return null;
  return { peak: peak || off, offpeak: off || peak };
}

// 按 token 明细估算金额(元)。rates=null 或价格未校准时返回 null
export function estimateCost(tok, rates) {
  if (!rates) return null;
  const cacheHitAgg = Number(tok.cacheR) || 0;
  // 输入侧:能确认的缓存命中按 cacheHit 计;其余输入(cacheMiss 口径)按 cacheMiss 计。
  // ZCode 的 input_tokens 已含缓存读(实测 raw_usage_json: input 16550 内含 cacheRead 11136),
  // 所以这里先扣除缓存读,避免重复计费。
  const nonCacheInput = Math.max(0, (Number(tok.in) || 0) - cacheHitAgg);
  const cacheWrite = Number(tok.cacheW) || 0;
  const calc = (r) => (
    (nonCacheInput + cacheWrite) / 1e6 * r.cacheMiss +
    cacheHitAgg / 1e6 * r.cacheHit +
    ((Number(tok.out) || 0) + (Number(tok.reason) || 0)) / 1e6 * r.output
  );
  return { peak: calc(rates.peak), offpeak: calc(rates.offpeak) };
}
