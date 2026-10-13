// page.mjs — 监控页
// 视觉规范:严格采用 ZCode(Zai) 自带主题令牌(theme-zai-dark),不沿用 DeepSeek 的蓝调皮肤:
//   背景 #161616 / 面板 #202020 / 卡片 #2b2b2b / 次级 #363636
//   边框 rgba(255,255,255,.10)、悬停边框 .15、悬停底 .05、选中底 .10
//   品牌色 #fff(主按钮=白底黑字,这是 Zai 的标志性做法)
//   数据色板取 ZCode 的 --color-usage-chart-* 与 --color-trajectory-*
// 页面内 JS 一律用字符串拼接,避免与外层模板字符串冲突。
'use strict';

export function renderPage({ port }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>ZCode · 智谱用量监控</title>
<style>
  :root{
    --bg:#161616; --panel:#202020; --card:#2b2b2b; --elevated:#363636;
    --border:rgba(255,255,255,.10); --border-hover:rgba(255,255,255,.15);
    --hover:rgba(255,255,255,.05); --selected:rgba(255,255,255,.10);
    --fg:#d4d4d4; --fg-strong:#f8f8f8; --fg-muted:#adadad; --fg-faint:#747474;
    --brand:#fff; --brand-fg:#000;
    --ok:#46bf72; --warn:#ff8a30; --err:#ff5c5c; --info:#4099ff;
    --alpha:1;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%}
  body{background:var(--bg);color:var(--fg);font-family:ui-sans-serif,system-ui,"Segoe UI","Microsoft YaHei",sans-serif;font-size:13px;padding:6px 14px 14px;overflow:auto;-webkit-font-smoothing:antialiased}
  .card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:10px}
  .head{display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap}
  .alphaRow{display:flex;align-items:center;gap:5px;font-size:10.5px;color:var(--fg-faint);flex:none}
  .alphaRow input[type=range]{accent-color:var(--fg-strong);width:64px;margin:0;cursor:pointer}
  .dot{width:7px;height:7px;border-radius:50%;flex:none}
  .title{font-size:13px;font-weight:600;flex:1;color:var(--fg-strong);letter-spacing:.01em}
  .btn{border:1px solid var(--border);background:transparent;color:var(--fg);border-radius:8px;padding:4px 11px;font-size:11.5px;cursor:pointer;font-family:inherit;transition:background .12s,border-color .12s,color .12s}
  .btn:hover{background:var(--hover);border-color:var(--border-hover);color:var(--fg-strong)}
  .btn:disabled{opacity:.45;cursor:default}
  .btnPrimary{background:var(--brand);color:var(--brand-fg);border-color:var(--brand);font-weight:600}
  .btnPrimary:hover{background:#e8e8e8;border-color:#e8e8e8;color:var(--brand-fg)}
  .hero{font-size:26px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--fg-strong);letter-spacing:-.01em}
  .heroSub{font-size:11px;color:var(--fg-faint);margin-top:3px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:7px 14px;margin-top:9px}
  .row{display:flex;align-items:baseline;gap:6px;font-size:12px}
  .k{color:var(--fg-muted);flex:1;min-width:0}
  .v{font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--fg-strong)}
  .seri{display:flex;gap:6px;margin-bottom:6px;flex-wrap:wrap}
  .chip{font-size:10.5px;padding:3px 11px;border-radius:8px;border:1px solid var(--border);color:var(--fg-muted);cursor:pointer;background:transparent;font-family:inherit;transition:background .12s,color .12s,border-color .12s}
  .chip:hover{background:var(--hover);color:var(--fg)}
  .chip.on{background:var(--selected);border-color:var(--border-hover);color:var(--fg-strong)}
  canvas{width:100%;height:112px;display:block}
  .foot{font-size:10.5px;color:var(--fg-faint);text-align:center;padding:3px 0 2px}
  .status{display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--fg-muted)}
  .hint{font-size:10.5px;color:var(--fg-faint);margin-top:6px;line-height:1.6;word-break:break-word}
  .empty{font-size:11px;color:var(--fg-faint);padding:8px 0;line-height:1.6}
  .klHead{display:flex;align-items:center;gap:8px;margin-bottom:9px;flex-wrap:wrap}
  .klHead .title{font-size:13px}
  .klRow{margin-bottom:9px}
  .klTop{display:flex;align-items:baseline;gap:6px;font-size:11.5px;line-height:1.35}
  .klDot{width:8px;height:8px;border-radius:2px;flex:none;display:inline-block}
  .klName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg)}
  .klVal{font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--fg-strong);font-weight:600}
  .klBar{height:6px;border-radius:3px;background:rgba(255,255,255,.06);overflow:hidden;margin-top:4px}
  .klBar i{display:block;height:100%;border-radius:3px;min-width:2px}
  .klSub{font-size:10px;color:var(--fg-faint);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .klLegend{display:flex;flex-wrap:wrap;gap:5px 6px;margin-top:7px}
  .klLegItem{display:inline-flex;align-items:center;gap:5px;font-size:10px;line-height:1;padding:4px 9px 4px 7px;border-radius:8px;border:1px solid var(--border);color:var(--fg-muted);cursor:pointer;background:transparent;font-family:inherit;font-variant-numeric:tabular-nums;transition:background .12s,color .12s}
  .klLegItem:hover{background:var(--hover);color:var(--fg)}
  .klLegItem i{width:8px;height:8px;border-radius:2px;flex:none;opacity:.55}
  .klLegItem.on{background:var(--selected);border-color:var(--border-hover);color:var(--fg-strong)}
  .klLegItem.on i{opacity:1}
  .dailyRow{display:flex;align-items:center;gap:8px;font-size:11.5px;margin-bottom:6px}
  .dailyDate{width:56px;color:var(--fg-muted);font-variant-numeric:tabular-nums;flex:none}
  .dailyBar{flex:1;height:6px;border-radius:3px;background:rgba(255,255,255,.06);overflow:hidden}
  .dailyBar i{display:block;height:100%;background:var(--info);border-radius:3px;min-width:2px}
  .dailyVal{width:74px;text-align:right;color:var(--fg-strong);font-variant-numeric:tabular-nums;flex:none}
  .dailyReq{width:52px;text-align:right;color:var(--fg-faint);font-variant-numeric:tabular-nums;flex:none}
  .todayTag{font-size:9px;padding:1px 5px;border-radius:4px;background:var(--selected);color:var(--fg-muted);margin-left:5px}
  ::-webkit-scrollbar{width:8px;height:8px}
  ::-webkit-scrollbar-track{background:transparent}
  ::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:999px}
  ::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.24)}
  /* 浮窗较窄时把两列数值并成一列,避免「—(价格未校准)」这类文案折行 */
  @media (max-width:600px){
    .grid{grid-template-columns:1fr;gap:6px}
    .dailyDate{width:48px}
    .dailyVal{width:66px}
  }
</style>
</head>
<body>
  <div class="card">
    <div class="head">
      <span class="dot" id="dotTop" style="background:var(--brand)"></span>
      <span class="title">ZCode · 智谱用量监控</span>
      <div class="alphaRow" title="背景透明度">透明<input type="range" id="alpha" min="35" max="100" value="96" oninput="setAlpha(this.value)"><span id="alphaVal">96%</span></div>
      <button class="btn" id="layerBtn" onclick="toggleLayer()">图层:最上层</button>
      <button class="btn" id="closeBtn" title="关闭窗口并结束监控">关闭监控</button>
    </div>
    <div class="title" style="margin-bottom:7px;font-size:12px;color:var(--fg-muted)">智谱账户(控制台)</div>
    <div class="heroSub" id="acctSub">未接入:需登录一次智谱控制台</div>
    <div id="packRow" style="margin-top:9px"></div>
    <div class="seri" style="margin-top:9px">
      <button class="btn" id="openConsole">接入智谱控制台</button>
      <button class="btn" id="reloadCloud">重新采集</button>
    </div>
    <div class="grid">
      <div class="row"><span class="k" id="cloudCostK">今日消耗(官方账单)</span><span class="v" id="cloudCost">—</span></div>
      <div class="row"><span class="k">今日消耗(本地估算)</span><span class="v" id="cost">—</span></div>
      <div class="row"><span class="k">今日输出 Token</span><span class="v" id="tokensOut">—</span></div>
      <div class="row"><span class="k">输入 / 缓存命中</span><span class="v" id="io">—</span></div>
      <div class="row"><span class="k">今日总 Token</span><span class="v" id="tokensTotal">—</span></div>
      <div class="row"><span class="k">请求 / 回合</span><span class="v" id="reqs">—</span></div>
    </div>
    <div class="hint" id="usageHint"></div>
  </div>

  <div class="card">
    <div class="title" style="margin-bottom:7px">趋势</div>
    <div class="seri" id="series">
      <button class="chip on" data-s="token">Token</button>
      <button class="chip" data-s="models">各模型</button>
      <button class="chip" data-s="cost">官方金额</button>
      <button class="chip" data-s="pack">资源包余量</button>
      <button class="chip" data-s="plan">订阅次数</button>
    </div>
    <div class="seri" id="ranges"></div>
    <canvas id="cv"></canvas>
    <div class="klLegend" id="legend"></div>
    <div class="hint" id="chartHint"></div>
  </div>

  <div class="card">
    <div class="klHead">
      <span class="title">各模型用量 · 今日</span>
      <button class="btn" id="modeTok">Token</button>
      <button class="btn" id="modeCost">金额</button>
    </div>
    <div id="modelList"></div>
    <div class="foot" id="modelFoot"></div>
  </div>

  <div class="card">
    <div class="title" style="margin-bottom:9px">每日用量 · 近 7 天</div>
    <div id="dailyList"></div>
    <div class="foot" id="dailyFoot"></div>
  </div>

  <div class="card">
    <div class="title" style="margin-bottom:9px">官方账单 · 按月</div>
    <div id="billList"></div>
    <div class="foot" id="billFoot"></div>
  </div>

  <div class="card">
    <div class="title" style="margin-bottom:7px">累计(全部历史)</div>
    <div class="grid">
      <div class="row"><span class="k">总 Token</span><span class="v" id="allTotal">—</span></div>
      <div class="row"><span class="k">总请求</span><span class="v" id="allReq">—</span></div>
    </div>
    <div class="hint" id="allHint"></div>
  </div>

  <div class="card">
    <div class="title" style="margin-bottom:9px">会话维度 · 今日 Top</div>
    <div id="sessList"></div>
    <div class="foot" id="sessFoot"></div>
  </div>

  <div class="card">
    <div class="title" style="margin-bottom:9px">数据源状态</div>
    <div class="status"><span class="dot" id="dbDot"></span><span id="dbText">—</span></div>
    <div class="status" style="margin-top:7px"><span class="dot" id="edgeDot"></span><span id="edgeText">—</span></div>
    <div class="hint" id="srcHint"></div>
    <div class="hint" id="errBox"></div>
  </div>

<script>
// ZCode(Zai) 数据色板:--color-usage-chart-1..6 + --color-trajectory-*
var KEY_COLORS = ['#4099ff','#46bf72','#7b5ce5','#ff8a30','#42c8c8','#60a5fa','#2dd4bf','#a78bfa','#f59e0b','#38bdf8','#ff5c5c','#80beff'];
var LINE_TOKEN = '#4099ff', LINE_CACHE = '#7b5ce5', LINE_COST = '#ff8a30';
var RANGE_LIST = ['1m','5m','10m','30m','1h','2h','1d','7d'];
var RANGE_MS = {'1m':60000,'5m':300000,'10m':600000,'30m':1800000,'1h':3600000,'2h':7200000,'1d':86400000,'7d':604800000};
var colorFixed = {};
var modelMode = 'token';
var seriesMode = 'token';
var range = '1h';
var lit = {};
var lastData = null;
var lastSeries = null;
var lastHistory = null;

function fmtTok(n){
  n = Number(n)||0;
  if (n >= 1e8) return (n/1e8).toFixed(2)+' 亿';
  if (n >= 1e4) return (n/1e4).toFixed(1)+' 万';
  return String(Math.round(n));
}
function fmtMoney(v, digits){ return (v==null || !isFinite(v)) ? '—' : '¥'+Number(v).toFixed(digits==null?4:digits); }
function fmtTime(t){ if(!t) return '—'; var d=new Date(t); function p(x){return String(x).padStart(2,'0');} return p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds()); }
function fmtDur(ms){
  if (ms < 60000) return Math.round(ms/1000)+' 秒';
  if (ms < 3600000) return Math.round(ms/60000)+' 分钟';
  if (ms < 86400000) return (ms/3600000).toFixed(1)+' 小时';
  return (ms/86400000).toFixed(1)+' 天';
}
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
function colorIndexOf(name){
  if (colorFixed[name] == null) colorFixed[name] = Object.keys(colorFixed).length;
  return colorFixed[name] % KEY_COLORS.length;
}
function colorOf(name){ return KEY_COLORS[colorIndexOf(name)]; }
function shortModel(m){ return String(m||'').replace(/^account:/,'').replace(/^zai-/,''); }
function setAlpha(v){
  document.documentElement.style.setProperty('--alpha', (Number(v)/100).toFixed(2));
  var el = document.getElementById('alphaVal'); if (el) el.textContent = v+'%';
  try { localStorage.setItem('zgm_alpha', String(v)); } catch(e){}
}
function toggleLayer(){
  var host = null;
  try { host = window.chrome && window.chrome.webview && window.chrome.webview.hostObjects ? window.chrome.webview.hostObjects.floatHelper : null; } catch(e){}
  if (!host) { var b=document.getElementById('layerBtn'); if(b){b.textContent = window.__floatTop?'图层:一般':'图层:最上层'; window.__floatTop=!window.__floatTop;} return; }
  Promise.resolve(host.getState()).then(function(s){
    var j = {}; try { j = JSON.parse(s); } catch(e){}
    var next = !j.top; host.setTop(next); window.__floatTop = next;
    document.getElementById('layerBtn').textContent = '图层:'+(next?'最上层':'一般');
    fetch('/api/monitor/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:'layerMode',value:next?'top':'normal'}),cache:'no-store'}).catch(function(){});
  }).catch(function(){});
}
function setLayerMode(m){
  var b = document.getElementById('layerBtn'); if (!b) return;
  var top = (typeof window.__floatTop === 'boolean') ? window.__floatTop : (m === 'top');
  b.textContent = '图层:' + (top ? '最上层' : '一般');
}
function setPrimary(btn, on){
  if (!btn) return;
  btn.className = on ? 'btn btnPrimary' : 'btn';
}

// ── 各模型用量卡 ──────────────────────────────────────────────────────────
function drawModels(d){
  var box = document.getElementById('modelList'); if (!box) return;
  var list = (d.byModel||[]).slice();
  var useCost = (modelMode === 'cost');
  var val = function(m){ return useCost ? (d.cost && d.cost.byModel ? d.cost.byModel[m.model] : null) : m.total; };
  if (useCost) list = list.filter(function(m){ return val(m) != null; });
  var sum = 0; var anyVal = false;
  list.forEach(function(m){ var v = val(m); if (v != null && isFinite(v)) { sum += v; anyVal = true; } });
  if (!list.length){
    box.innerHTML = '<div class="empty">' + (useCost
      ? '价格未校准 —— 在 prices.json 填好各模型单价并把 calibrated 改成 true,这里就会按金额展示'
      : '今日暂无请求记录') + '</div>';
    document.getElementById('modelFoot').textContent = '';
    setPrimary(document.getElementById('modeTok'), !useCost);
    setPrimary(document.getElementById('modeCost'), useCost);
    return;
  }
  var html = '';
  list.slice(0,12).forEach(function(m){
    var v = val(m); var pct = (anyVal && sum > 0 && v != null) ? (v / sum * 100) : 0;
    var c = colorOf(m.model);
    var display = useCost ? fmtMoney(v) : fmtTok(v);
    var share = (anyVal && v != null && sum > 0) ? (v/sum*100).toFixed(1)+'%' : '占比 —';
    html += '<div class="klRow">'
      + '<div class="klTop"><i class="klDot" style="background:'+c+'"></i>'
      + '<span class="klName">'+esc(shortModel(m.model))+'</span>'
      + '<span class="klVal">'+display+'</span><span class="klSub" style="margin:0">'+share+'</span></div>'
      + '<div class="klBar"><i style="width:'+pct.toFixed(1)+'%;background:'+c+'"></i></div>'
      + '<div class="klSub">入 '+fmtTok(m.in)+' · 出 '+fmtTok(m.out)+' · 缓存读 '+fmtTok(m.cacheR)+' · 请求 '+m.req+(m.err?(' · 错误 '+m.err):'')+' · '+esc(shortModel(m.provider))+'</div>'
      + '</div>';
  });
  box.innerHTML = html;
  var foot = document.getElementById('modelFoot');
  foot.textContent = '共 '+list.length+' 个模型 · 合计 '+(useCost?fmtMoney(sum):fmtTok(sum))+' · '+fmtTime(d.updatedAt);
  setPrimary(document.getElementById('modeTok'), !useCost);
  setPrimary(document.getElementById('modeCost'), useCost);
}

// ── 每日用量(近 7 天,来自本地库) ─────────────────────────────────────────
function drawDaily(d){
  var box = document.getElementById('dailyList'); if (!box) return;
  var list = (d.daily||[]).slice().reverse(); // 新的在上
  if (!list.length){ box.innerHTML = '<div class="empty">本地库暂无按日数据</div>'; return; }
  var max = Math.max.apply(null, list.map(function(x){ return x.total||0; })) || 0;
  var total = list.reduce(function(a,x){ return a + (x.total||0); }, 0);
  var today = new Date(); today.setHours(0,0,0,0);
  box.innerHTML = list.map(function(x){
    var pct = max > 0 ? ((x.total||0)/max*100) : 0;
    var isToday = x.t === today.getTime();
    var label = new Date(x.t).toLocaleDateString('zh-CN',{month:'2-digit',day:'2-digit'});
    return '<div class="dailyRow">'
      + '<span class="dailyDate">'+label+(isToday?'<span class="todayTag">今</span>':'')+'</span>'
      + '<span class="dailyBar"><i style="width:'+pct.toFixed(1)+'%"></i></span>'
      + '<span class="dailyVal">'+fmtTok(x.total)+'</span>'
      + '<span class="dailyReq">'+(x.req||0)+' 次</span>'
      + '</div>';
  }).join('');
  var foot = document.getElementById('dailyFoot');
  foot.textContent = '近 '+list.length+' 天合计 '+fmtTok(total)+' · 柱长按最高一天为准';
}

function drawBills(d){
  var box = document.getElementById('billList'); if (!box) return;
  var c = d.cloud;
  var months = (c && c.months) ? c.months.filter(function(m){ return m.amount > 0; }) : [];
  if (!months.length){
    box.innerHTML = '<div class="empty">' + (c ? '账单接口返回的月份里没有非零金额' : '未接入智谱控制台 —— 点上方「接入智谱控制台」登录一次') + '</div>';
    document.getElementById('billFoot').textContent = '';
    return;
  }
  months = months.slice(-12);
  var max = Math.max.apply(null, months.map(function(m){ return m.amount; })) || 0;
  var sum = months.reduce(function(a, m){ return a + m.amount; }, 0);
  var nowM = new Date().toISOString().slice(0,7);
  box.innerHTML = months.map(function(m){
    var pct = max > 0 ? (m.amount/max*100) : 0;
    return '<div class="dailyRow">'
      + '<span class="dailyDate">'+m.month.slice(2)+(m.month===nowM?'<span class="todayTag">今</span>':'')+'</span>'
      + '<span class="dailyBar"><i style="width:'+pct.toFixed(1)+'%;background:var(--warn)"></i></span>'
      + '<span class="dailyVal">'+fmtMoney(m.amount,2)+'</span>'
      + '</div>';
  }).join('');
  document.getElementById('billFoot').textContent = '共 '+months.length+' 个月有消费 · 合计 '+fmtMoney(sum,2)+' · 数据源:智谱控制台按月账单接口';
}

function drawSessions(d){
  var box = document.getElementById('sessList'); if (!box) return;
  var list = (d.bySession||[]);
  if (!list.length){ box.innerHTML = '<div class="empty">今日暂无会话</div>'; document.getElementById('sessFoot').textContent=''; return; }
  var max = list[0].total || 0;
  var html = '';
  list.forEach(function(s){
    var c = colorOf(s.sessionId);
    var pct = max > 0 ? (s.total/max*100) : 0;
    var t = String(s.title||s.sessionId);
    if (t.length > 34) t = t.slice(0,34)+'…';
    html += '<div class="klRow" style="margin-bottom:7px">'
      + '<div class="klTop"><i class="klDot" style="background:'+c+'"></i><span class="klName">'+esc(t)+'</span>'
      + '<span class="klVal">'+fmtTok(s.total)+'</span><span class="klSub" style="margin:0">'+s.req+' 请求</span></div>'
      + '<div class="klBar"><i style="width:'+pct.toFixed(1)+'%;background:'+c+'"></i></div></div>';
  });
  box.innerHTML = html;
  document.getElementById('sessFoot').textContent = '显示今日 token 用量前 '+list.length+' 个会话';
}

// ── 趋势图 ────────────────────────────────────────────────────────────────
function drawFrame(g,w,H,pts,fmtVal,maxV,minV,flatLabel,topLabel){
  minV = minV || 0;
  var padL = 4, padR = 4, padT = 10, padB = 15;
  g.clearRect(0,0,w,H);
  g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = 1;
  for (var i=0;i<=3;i++){
    var y = padT + (H-padT-padB) * i/3;
    g.beginPath(); g.moveTo(padL,y); g.lineTo(w-padR,y); g.stroke();
  }
  g.fillStyle = '#747474'; g.font = '9px ui-sans-serif,system-ui';
  g.fillText(topLabel ? topLabel : fmtVal(maxV), padL+2, padT+9);
  // 值恒定(窗口内没变化)时轴底不写一个编出来的下界,改标「同值」——避免让人以为数值在该区间波动过
  g.fillText(flatLabel ? flatLabel : (minV > 0 ? fmtVal(minV) : '0'), padL+2, H-padB-3);
  if (pts.length){
    var t0 = new Date(pts[0].t).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});
    g.fillText(t0, padL+2, H-4);
    var t1 = new Date(pts[pts.length-1].t).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});
    g.fillText(t1, w-padR-g.measureText(t1).width-2, H-4);
  }
  return {padL:padL, padR:padR, padT:padT, padB:padB};
}
function plotLine(g, pts, pick, maxV, color, alpha, width, pad, w, H, minV, dots){
  minV = minV || 0;
  var n = pts.length; if (!n) return 0;
  var innerW = w - pad.padL - pad.padR, innerH = H - pad.padT - pad.padB;
  var span = (maxV - minV) || 1;
  var yOf = function(v){ return pad.padT + innerH - innerH * ((v - minV) / span); };
  var xOf = function(i){ return pad.padL + (n===1 ? innerW/2 : innerW * i/(n-1)); };
  g.globalAlpha = alpha; g.strokeStyle = color; g.lineWidth = width;
  g.lineJoin = 'round';
  g.beginPath();
  var drawn = 0, started = false, lastX = 0, lastY = 0;
  for (var i=0;i<n;i++){
    var v = pick(pts[i]); if (v == null) continue;
    var x = xOf(i), y = yOf(v);
    if (!started){ g.moveTo(x,y); started = true; } else g.lineTo(x,y);
    lastX = x; lastY = y; drawn++;
  }
  g.stroke();
  // 采样点逐个画出来:值恒定或点很少时,至少能看出"采了几个点、落在哪"
  if (dots !== false){
    g.fillStyle = color;
    for (var k=0;k<n;k++){
      var v1 = pick(pts[k]); if (v1 == null) continue;
      g.beginPath(); g.arc(xOf(k), yOf(v1), 1.7, 0, Math.PI*2); g.fill();
    }
    if (started){ g.beginPath(); g.arc(lastX, lastY, 3.0, 0, Math.PI*2); g.fill(); }
  }
  g.globalAlpha = 1;
  return drawn;
}
// 历史类曲线(智谱控制台采样):官方金额 / 资源包余量 / 订阅次数
var HIST_SERIES = {
  cost:    { name:'官方账单额', color:LINE_COST, pick:function(p){ return (p.officialCost != null ? p.officialCost : p.cost); }, fmt:function(v){ return '¥'+Number(v).toFixed(2); } },
  pack:    { name:'资源包余量', color:LINE_TOKEN, pick:function(p){ return p.tokenPackLeft; }, fmt:fmtTok },
  plan:    { name:'订阅剩余次数', color:LINE_CACHE, pick:function(p){ return p.planTimesLeft; }, fmt:function(v){ return Math.round(v)+' 次'; } }
};
function drawHistoryChart(pts, mode){
  var cv = document.getElementById('cv'), g = cv.getContext('2d');
  var w = cv.clientWidth, H = cv.clientHeight; cv.width = w; cv.height = H;
  document.getElementById('legend').innerHTML = '';
  var def = HIST_SERIES[mode];
  if (!def){ drawFrame(g,w,H,[],function(){return '—';},0); return; }
  var vals = pts.map(def.pick).filter(function(v){ return v != null && isFinite(v); });
  if (!vals.length){
    drawFrame(g,w,H,[],function(){return '—';},0);
    document.getElementById('chartHint').innerHTML = '该模式需要智谱控制台数据 —— 点上方「接入智谱控制台」登录一次,之后服务每 60 秒采一点。';
    return;
  }
  // 值域按窗口内真实范围缩放:这类"数值大但几乎不动"的量若从 0 起画,就是一条贴顶直线
  var minV = Math.min.apply(null, vals), maxV = Math.max.apply(null, vals);
  var flat = (maxV === minV);
  if (flat){
    // 只向下留白:让恒定的线画在顶部、与轴顶的"真实值"标注位置一致(不上下都留,免得线悬在中间)
    var pad0 = Math.max(Math.abs(maxV) * 0.05, mode === 'pack' ? 1000000 : (mode === 'plan' ? 5 : 1));
    minV = maxV - pad0;
  } else {
    var margin = (maxV - minV) * 0.15;
    minV = Math.max(0, minV - margin); maxV = maxV + margin;
  }
  // 恒定时:轴顶标真实值、轴底标「同值」——页面上不出现任何编出来的数字
  var pad = drawFrame(g,w,H,pts,def.fmt,maxV,minV, flat ? '同值' : '', flat ? def.fmt(vals[vals.length-1]) : '');
  var n = plotLine(g, pts, def.pick, maxV, def.color, 1, 2, pad, w, H, minV);
  var latest = vals[vals.length-1];
  var head = def.name + ' · ' + def.fmt(latest) + ' · ' + n + ' 个采样点';
  if (flat) head += ' · 窗口内恒定不变(线是平的,不是没采样;轴底留白只为把线画在顶部)';
  document.getElementById('chartHint').textContent = head + ' · 数据源:智谱控制台';
}
function drawTokenChart(sr, mode){
  var cv = document.getElementById('cv'), g = cv.getContext('2d');
  var w = cv.clientWidth, H = cv.clientHeight; cv.width = w; cv.height = H;
  var pts = sr.points || [];
  var legend = document.getElementById('legend');
  if (mode === 'models'){
    var names = [];
    pts.forEach(function(p){ Object.keys(p.models||{}).forEach(function(m){ if (names.indexOf(m)<0) names.push(m); }); });
    if (!names.length){
      legend.innerHTML = '';
      drawFrame(g,w,H,pts,function(v){return fmtTok(v);},0);
      document.getElementById('chartHint').textContent = '该时间窗口内没有请求记录 —— 换个更大的档位(如 1d / 7d)试试。';
      return;
    }
    var totals = {};
    names.forEach(function(m){ totals[m] = pts.reduce(function(a,p){ return a + ((p.models||{})[m]||0); }, 0); });
    names.sort(function(a,b){ return totals[b]-totals[a]; });
    names = names.slice(0,8);
    // Y 轴按"最高的那条线"定,合计不进值域(否则所有线被压到贴底)
    var maxV = 0;
    pts.forEach(function(p){ names.forEach(function(m){ var v=(p.models||{})[m]||0; if (v>maxV) maxV = v; }); });
    var pad = drawFrame(g,w,H,pts,fmtTok,maxV);
    var anyLit = names.some(function(m){ return lit[m]; });
    names.forEach(function(m){
      var on = !!lit[m];
      var a = anyLit ? (on ? 1 : 0.28) : 1;
      plotLine(g, pts, function(p){ return (p.models||{})[m]||0; }, maxV, colorOf(m), a, on?2.6:1.6, pad, w, H);
    });
    legend.innerHTML = names.map(function(m){
      return '<button class="klLegItem'+(lit[m]?' on':'')+'" data-m="'+esc(m)+'"><i style="background:'+colorOf(m)+'"></i>'+esc(shortModel(m))+' '+fmtTok(totals[m])+'</button>';
    }).join('');
    Array.prototype.forEach.call(legend.querySelectorAll('.klLegItem'), function(b){
      b.onclick = function(){ var m = b.getAttribute('data-m'); lit[m] = !lit[m]; drawTokenChart(sr, mode); };
    });
    document.getElementById('chartHint').textContent = '每个模型一条线 · Y 轴按最高的模型定(合计不画线) · 点图例可高亮';
    return;
  }
  var maxV = 0; pts.forEach(function(p){ if (p.total > maxV) maxV = p.total; });
  var pad = drawFrame(g,w,H,pts,fmtTok,maxV);
  var pick = mode === 'cache' ? function(p){ return p.cacheR; } : function(p){ return p.total; };
  plotLine(g, pts, pick, maxV, mode === 'cache' ? LINE_CACHE : LINE_TOKEN, 1, 2, pad, w, H);
  legend.innerHTML = '';
  var nz = pts.filter(function(p){ return p.req > 0; }).length;
  document.getElementById('chartHint').textContent = '窗口 '+range+' · 桶宽 '+fmtDur(sr.bucketMs)+' · '+pts.length+' 个采样点(其中 '+nz+' 个有请求) · '+(pts[0]?new Date(pts[0].t).toLocaleString('zh-CN'):'')+' → 现在';
}

function renderChart(){
  if (seriesMode === 'token' || seriesMode === 'cache' || seriesMode === 'models'){
    if (lastSeries) drawTokenChart(lastSeries, seriesMode);
  } else {
    drawHistoryChart(lastHistory || [], seriesMode);
  }
}

function render(d){
  lastData = d;
  var t = d.today || {};
  document.getElementById('tokensOut').textContent = fmtTok(t.out);
  document.getElementById('io').textContent = fmtTok(t.in) + ' / ' + fmtTok(t.cacheR);
  document.getElementById('tokensTotal').textContent = fmtTok(t.total);
  document.getElementById('reqs').textContent = (t.req||0) + ' / ' + ((d.turns&&d.turns.turns)||0);
  document.getElementById('cost').textContent = d.cost && d.cost.calibrated ? fmtMoney(d.cost.total) : '—(价格未校准)';
  var z = d.zhipu || {};
  var c = d.cloud || null;
  // 官方口径的"今日消耗":接口的 todaySpendAmount 常为 null(当天没消耗或字段未启用),
  // 退化为"本月账单额",并在文案里说明口径,避免把月账当日报读。
  var cloudCost = null, cloudCostLabel = '今日消耗(官方账单)';
  if (c) {
    if (c.todaySpend != null) { cloudCost = c.todaySpend; }
    else if (c.curMonthAmount != null) { cloudCost = c.curMonthAmount; cloudCostLabel = '本月账单(官方)'; }
  }
  document.getElementById('cloudCost').textContent = (cloudCost == null) ? '—' : '¥' + Number(cloudCost).toFixed(2);
  var ccostK = document.getElementById('cloudCostK');
  if (ccostK) ccostK.textContent = cloudCostLabel;
  document.getElementById('acctSub').textContent = c
    ? ('累计充值 ' + fmtMoney(c.recharge, 2) + ' · 累计消费 ' + fmtMoney(c.totalSpend, 2)
       + ' · 采集 ' + fmtTime(z.at))
    : (z.hint || '未接入:点下方按钮登录一次智谱控制台');
  // 资源包 / 订阅额度
  var pack = document.getElementById('packRow');
  if (pack){
    if (c && (c.tokenPackLeft != null || c.planTimesLeft != null)){
      var parts = [];
      if (c.tokenPackLeft != null) parts.push('<div class="row"><span class="k">资源包剩余 Token</span><span class="v">'+fmtTok(c.tokenPackLeft)+'</span></div>');
      if (c.planTimesLeft != null) parts.push('<div class="row"><span class="k">订阅剩余次数</span><span class="v">'+c.planTimesLeft+' 次</span></div>');
      if (c.planTokens != null) parts.push('<div class="row"><span class="k">订阅额度 Token</span><span class="v">'+fmtTok(c.planTokens)+'</span></div>');
      pack.innerHTML = '<div class="grid">' + parts.join('') + '</div>';
    } else { pack.innerHTML = ''; }
  }

  var y = d.yesterday || {};
  var al = d.allTime || null;
  document.getElementById('allTotal').textContent = al ? fmtTok(al.total) : '—';
  document.getElementById('allReq').textContent = al ? String(al.req) : '—';
  document.getElementById('allHint').textContent = al
    ? ('输入 ' + fmtTok(al.in) + ' · 输出 ' + fmtTok(al.out) + ' · 缓存读 ' + fmtTok(al.cacheR) + ' · 覆盖 ZCode 本地库全部记录')
    : '本地库暂不可读';

  var lastReqAt = (d.db && d.db.lastReqAt) ? d.db.lastReqAt : 0;
  document.getElementById('usageHint').textContent = '今日请求 ' + (t.req||0) + ' 次 · 昨日同期 ' + fmtTok(y.total) + ' token'
    + ' · 缓存命中率 ' + (t.in ? ((t.cacheR / (t.in + t.cacheW || 1)) * 100).toFixed(1) + '%' : '—')
    + ' · 价格档位 ' + ((d.cost && d.cost.tier) === 'peak' ? '高峰' : '空闲')
    + (lastReqAt ? (' · 最后一条请求 ' + fmtTime(lastReqAt)) : '');
  document.getElementById('dbDot').style.background = d.db.error ? 'var(--err)' : 'var(--ok)';
  document.getElementById('dbText').textContent = '本地库(' + (d.db.source||'—') + ') · 库文件最后写入 ' + fmtTime(d.db.mtime) + (d.db.error ? ' · 错误:' + d.db.error : '');
  document.getElementById('edgeDot').style.background = z.ok ? 'var(--ok)' : (z.status === 'unconfigured' || z.status === 'idle' ? 'var(--warn)' : 'var(--err)');
  document.getElementById('edgeText').textContent = '智谱控制台(CDP) · ' + (z.status === 'ok' ? '已连接' : (z.status === 'need-login' ? '需在监控 Edge 登录一次' : (z.status === 'unconfigured' ? '未勘察接口' : (z.status || '—'))));
  document.getElementById('srcHint').textContent = '历史采样 ' + ((d.history&&d.history.points)||0) + ' 点 · ' + Math.round(((d.history&&d.history.bytes)||0)/1024) + ' KB · 服务启动于 ' + fmtTime(d.startedAt) + ' · 本地库路径 ' + ((d.db&&d.db.path)||'');
  document.getElementById('errBox').textContent = (d.errors&&d.errors.length) ? ('最近错误:' + d.errors.map(function(e){return e.where+':'+e.msg;}).join(' | ')) : '';
  drawModels(d); drawDaily(d); drawBills(d); drawSessions(d);
}
function findNumber(obj, re, depth){
  depth = depth || 0;
  if (obj == null || depth > 6) return null;
  if (typeof obj === 'number') return null;
  if (typeof obj === 'object'){
    for (var k in obj){
      if (re.test(k)){
        var v = obj[k];
        if (typeof v === 'number') return v;
        if (typeof v === 'string' && isFinite(Number(v))) return Number(v);
      }
      var r = findNumber(obj[k], re, depth+1);
      if (r != null) return r;
    }
  }
  return null;
}

function initRanges(){
  document.getElementById('ranges').innerHTML = RANGE_LIST.map(function(r){
    return '<button class="chip'+(r===range?' on':'')+'" data-r="'+r+'">'+r+'</button>';
  }).join('');
  Array.prototype.forEach.call(document.querySelectorAll('#ranges .chip'), function(b){
    b.onclick = function(){
      range = b.getAttribute('data-r');
      Array.prototype.forEach.call(document.querySelectorAll('#ranges .chip'), function(x){ x.className = 'chip' + (x===b?' on':''); });
      loadChart();
    };
  });
  Array.prototype.forEach.call(document.querySelectorAll('#series .chip'), function(b){
    b.onclick = function(){
      seriesMode = b.getAttribute('data-s');
      Array.prototype.forEach.call(document.querySelectorAll('#series .chip'), function(x){ x.className = 'chip' + (x===b?' on':''); });
      lit = {};
      loadChart();
    };
  });
  document.getElementById('modeTok').onclick = function(){ modelMode='token'; if(lastData) drawModels(lastData); };
  document.getElementById('modeCost').onclick = function(){ modelMode='cost'; if(lastData) drawModels(lastData); };
  document.getElementById('openConsole').onclick = function(){
    var b = this; b.disabled = true; b.textContent = '正在打开监控 Edge…';
    fetch('/api/monitor/open-console',{method:'POST',cache:'no-store'}).then(function(r){return r.json();}).then(function(j){
      b.disabled = false; b.textContent = '接入智谱控制台';
      alert(j.ok ? ('已在监控专用 Edge 打开智谱控制台:\\n\\n' + (j.hint||'') ) : ('打开失败:' + (j.hint || j.reason || '')));
    }).catch(function(){ b.disabled = false; b.textContent = '接入智谱控制台'; });
  };
  document.getElementById('reloadCloud').onclick = function(){
    var b = this; b.disabled = true; b.textContent = '采集中…';
    fetch('/api/monitor/cloud',{method:'POST',cache:'no-store'}).then(function(r){return r.json();}).then(function(j){
      b.disabled = false; b.textContent = '重新采集';
      if (!j.ok) alert('采集未成功:' + ((j.zhipu && (j.zhipu.hint || j.zhipu.status)) || '未知原因'));
      loadData();
    }).catch(function(){ b.disabled = false; b.textContent = '重新采集'; });
  };
}

function loadSeries(){
  return fetch('/api/monitor/series?range='+range,{cache:'no-store'}).then(function(r){return r.json();}).then(function(j){ if(j&&j.ok){ lastSeries = j; } });
}
function loadHistory(){
  return fetch('/api/monitor/history?limit=2000',{cache:'no-store'}).then(function(r){return r.json();}).then(function(j){
    if (!j||!j.ok) return;
    var now = Date.now(), from = now - (RANGE_MS[range]||3600000);
    lastHistory = (j.points||[]).filter(function(p){ return p.t >= from; });
  });
}
function loadChart(){
  Promise.all([loadSeries(), loadHistory()]).then(renderChart).catch(function(){});
}
function loadData(){
  fetch('/api/monitor/data',{cache:'no-store'}).then(function(r){return r.json();}).then(function(j){ if(j&&j.ok) render(j); }).catch(function(){});
}

initRanges();
try { var a = localStorage.getItem('zgm_alpha'); if (a){ document.getElementById('alpha').value = a; setAlpha(a); } } catch(e){}
// 调试用:?scroll=1400 打开后自动滚到指定位置;?series=models&range=1d 直接切视图(无人值守截图验证用)
try {
  var q = new URLSearchParams(location.search);
  var sc = q.get('scroll');
  if (sc) setTimeout(function () { window.scrollTo(0, Number(sc) || 0); }, 1200);
  var qs = q.get('series'), qr = q.get('range');
  if (qr && RANGE_MS[qr]) {
    range = qr;
    Array.prototype.forEach.call(document.querySelectorAll('#ranges .chip'), function(x){ x.className = 'chip' + (x.getAttribute('data-r')===qr ? ' on' : ''); });
  }
  if (qs) {
    seriesMode = qs;
    Array.prototype.forEach.call(document.querySelectorAll('#series .chip'), function(x){ x.className = 'chip' + (x.getAttribute('data-s')===qs ? ' on' : ''); });
  }
  if (sc || qs || qr) setTimeout(function(){ loadChart(); }, 900);
} catch(e){}
document.getElementById('closeBtn').addEventListener('click', function(){
  // 关窗 = 关掉整个监控(服务随之退出,不留后台进程)
  var done = function(){
    try { window.chrome.webview.hostObjects.floatHelper.close(); } catch(e){ try { window.close(); } catch(e2){} }
  };
  fetch('/api/monitor/shutdown', { method: 'POST', cache: 'no-store' }).then(function(){ setTimeout(done, 400); }).catch(done);
});
setInterval(function(){ setLayerMode(''); }, 2000);
loadData(); loadChart();
setInterval(loadData, 5000);
setInterval(loadChart, 30000);
</script>
</body>
</html>`;
}
