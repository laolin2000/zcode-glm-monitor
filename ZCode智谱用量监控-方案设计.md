# ZCode 智谱用量监控 —— 方案设计（仅设计，未实施）

> 2026-09-23 起草。目标：把 DSH 的 EAC 监控架构搬到 ZCode 侧，监控智谱（open.bigmodel.cn）的订阅费用与用量，并融合 ZCode 自带的本地使用统计。
> 本文只做方案，不含任何实施。

---

## 一、目标对齐（EAC 监控有什么，我们搬什么）

EAC 监控的本质是三层：

| 层 | EAC 侧 | ZCode 侧（本方案） |
|---|---|---|
| 浮窗外壳 | `EacMonitorFloat.exe`（WebView2，加载 `127.0.0.1:50142/api/eac-monitor/page`） | 同款 WebView2 浮窗（直接复用 EacMonitorFloat.exe 的壳思路，或起一个小 HTTP 服务供它加载） |
| 业务逻辑 + 数据 | DSH 用户插件 `dsh-eac-monitor/index.js`：Edge CDP 复用登录态 → 调平台内部接口 → 内存快照 + jsonl 历史 → `GET /api/.../data` | 一个独立的 Node 常驻脚本（`~/.zcode` 之外的 Ztool 目录），同样 CDP 复用智谱控制台登录态 + 读 ZCode 本地 usage 数据库 |
| 样式注入 | `inject-ui.js` | 原样复用（深色实心底、透明滑条、图层/关闭接线） |

监控页形态照抄：余额/订阅卡片、今日消耗、各 Key（改为各模型/各会话）用量卡片、趋势图（含按模型分线 + 点亮高亮）、时间档位 1m~7d。

---

## 二、数据源设计（两路合并）

### 数据源 A：智谱控制台（云侧真实账单）

**给定的两个页面**：
- `https://open.bigmodel.cn/finance-center/finance/overview` —— 财务总览（费用详情）
- `https://open.bigmodel.cn/finance-center/bill/expensebill/list` —— 费用账单明细

**取数方式（照搬 EAC 的 CDP 方案）**：
1. 用 Edge 专用 profile 启动并登录一次 `open.bigmodel.cn`（EAC 已有同款做法：`--remote-debugging-port=9222` + 专用 `--user-data-dir`，登录态持久在该 profile 里）。
2. 监控服务经 CDP（9222）连到该页面：
   - **方式一（推荐，和 EAC 同构）**：在页面上下文 `Runtime.evaluate` 里直接 `fetch()` 平台的内部 XHR 接口 —— 自动带 cookie，无跨域问题；
   - **方式二**：CDP `Network.getCookies` 取会话 cookie，再从 Node 侧直连。控制台是 cookie 鉴权（不是 DeepSeek 那种 `localStorage.userToken`），方式一更省事也更稳。
3. 采集频率：轮询 1~5 分钟一次即可（账单/费用数据是分钟级更新的，没必要像 EAC 那样 5 秒）。

**⚠️ 前置勘察项（实施第一步，本文未做）**：
两个页面背后的**具体 XHR 接口路径与参数尚未确认**。实施时需开着 DevTools Network 面板在两个页面里各操作一遍，抄下：
- overview 的余额/订阅余量接口、expensebill 的分页查询接口（路径、query 参数、时间格式、返回 JSON 结构、字段名）；
- 是否有防爬签名头（若有，只能在页面上下文里 fetch，让页面自己的 JS 逻辑去发请求——方式一本来就能绕开这个问题）。
> 这一步是整个方案的**最大不确定点**，必须最先做；接口确认不了，数据源 A 就不成立。

### 数据源 B：ZCode 本地使用统计（token 级、实时）

**已实测确认**（本方案勘察时读过真实数据）：
ZCode 在 `C:\Users\<you>\.zcode\cli\db\db.sqlite` 里自带完整的用量记录：

- `model_usage` 表：**每次模型请求一行**，字段齐全 —— `provider_id`（如 `account:bigmodel-start-plan`）、`model_id`（如 `GLM-5.3-Flash`）、`input_tokens` / `output_tokens` / `reasoning_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`、`started_at`（毫秒时间戳）、`status`、`finish_reason`、`agent`、`mode`、`raw_usage_json` 等；
- `turn_usage` 表：每个回合一行的汇总（请求次数、重试、工具调用数、TTFT 等）。

**注意**：SQLite 是 WAL 模式且正被 ZCode 进程写入 → 监控进程**只读**，并且每轮查询前先复制 db（或用 `sqlite3` 以 `?mode=ro&immutable=0` 只读连接 + 失败重试），避免锁冲突。稳妥做法：把 `.sqlite`+`-wal`+`-shm` 三个文件定期快照到临时目录再查（文件总共几 MB，代价可忽略）。

**这一路能提供什么**：
- token 用量实时曲线（比控制台账单实时得多，控制台有延迟）；
- 按 模型 / 会话 / agent / 模式 的分组视图（对应 EAC 的「各 Key」卡片，天然有维度）；
- 缓存命中/未命中拆分（结合智谱峰谷价格可直接本地估算费用，与云侧账单互为对账）。

### 两路如何合并

| 用途 | 用哪路 |
|---|---|
| 余额 / 订阅余量 / 官方计费金额 | 数据源 A（唯一权威） |
| 实时 token 曲线、按模型分线、缓存拆分 | 数据源 B（本地 DB，秒级） |
| 本地估算费用 | B 的 token × 智谱定价表，展示为「估算」，旁边对齐 A 的「官方账单」 |
| 历史趋势 jsonl | 采样点 = B 的 token + A 的金额，结构与 EAC 的 `eac-monitor-history.jsonl` 相同（`{t,c,cost,req,m}` 换成按模型） |

---

## 三、视图与交互设计（对齐 EAC 监控的统一与美观）

监控页卡片从上到下（页面由本地 Node 服务在 `127.0.0.1:<port>` 伺服，风格/CSS 沿用 EAC 的 `MONITOR_PAGE`）：

1. **账户卡片**：智谱账户余额 / 订阅包余量 / 今日消耗金额（数据源 A）。
2. **今日 Token 卡片**：入 / 出 / 缓存命中 / 缓存写入 四数值（数据源 B），下带与昨日同期对比。
3. **各模型用量 · 今日**（对应 EAC 的「各 API Key 用量」）：每行 = 色块 + 模型名 + token + 估算金额 + 占比 + 比例条；Token/金额 双模式切换；12 色固定调色板、首分配后固定。
4. **趋势图**：`余额 / Token / 费用 / 各模型` 四个序列 chip + 1m~7d 时间档位；「各模型」模式 = 每模型一条线、Y 轴按最高模型定（合计不画线不进值域 —— EAC 第二轮的教训直接继承）、图例可点亮高亮。
5. **ZCode 会话维度小卡**（B 独有）：今日活跃会话数、top 会话 token、错误/重试次数。
6. **数据源状态卡**：Edge CDP 连接状态、本地 DB 最后采样时间，任一路断掉时卡片降级提示「等待数据…」而不是报错（EAC 同款容错）。

浮窗：复用 `EacMonitorFloat.exe` 壳的思路（WebView2 + `float-config.json` 记忆位置/透明度 + `inject-ui.js` 接线）。**注意 EAC 的浮窗是它自己的插件拉起的**，ZCode 侧要由我们的 Node 服务自己 spawn 浮窗进程，并照抄 EAC 修过的两个坑：spawn 竞态占位 + 启动前清孤儿浮窗进程。

---

## 四、落点与进程模型

```
D:\toolresources\Ztool\zcode-glm-monitor\     ← 全部产物（按用户级 outdir 规则）
  monitor.mjs          ← 常驻 Node 服务：采样(A/B) + 快照 + jsonl 历史 + HTTP 页面
  prices.json          ← 智谱定价表（峰谷/cache 命中档，可覆盖）
  history.jsonl        ← 趋势历史（8MB 截断逻辑照抄 EAC）
  float/               ← 浮窗壳 + inject-ui.js（改造自 EacMonitorFloat）
  edge-profile/        ← 专用 Edge profile（只放智谱登录态，别和 EAC 的混用）
```

进程关系：`monitor.mjs`（Node，独立常驻，可用现有 `supervise-dsh.ps1` 同款 VBS 隐藏自启）→ 每轮采样 A/B → 内存快照 + 追加 jsonl → 浮窗(WebView2) 每 5 秒拉 `GET /api/monitor/data` 渲染。**不侵入 ZCode 进程本身，ZCode 崩了监控不受影响；反过来监控只读、对 ZCode 零影响。**

---

## 五、可行性评估

| 项 | 结论 | 依据 |
|---|---|---|
| 浮窗 + 注入 + 本地 HTTP 页 | **成熟，直接搬** | EacMonitorFloat 整套已在本机跑通多年形态 |
| 数据源 B（本地 usage DB） | **成立，已实测** | db.sqlite 的 `model_usage`/`turn_usage` 字段齐全、正被实时写入（本勘察已读到今天的真实 token 记录） |
| 数据源 A（智谱控制台抓取） | **大概率成立，有前置条件** | 架构与 EAC 完全同构（CDP 复用登录态），但**具体 XHR 接口未勘察**；控制台是 SPA，接口要从 DevTools 抄；若接口带签名头，用页面上下文内 fetch 可绕 |
| 本地估算费用与官方账单对账 | 成立 | token 明细(B) × 官方定价；以 A 为准显示误差 |
| 资源开销 | 可忽略 | 一个 Node 常驻 + 一个隐藏 Edge；内存预算 16GB 常年紧（~4GB 余），Edge 专用 profile 建议复用**已开着的**浏览器而非新开一个 |

**主要风险**：
1. 智谱控制台接口未知（最大不确定点，勘察先行）；
2. 控制台改版会导致接口失效（EAC 同样有此风险，靠「解析不到就显示等待」的降级兜底）；
3. 本机已有一个 9222 被 EAC 的 Edge 占用 → 我们的 Edge profile **不能用同一个端口也不能用同一个 profile**，换端口（如 9223）各自独立；
4. SQLite 并发读 → 快照后查询解决；
5. 智谱订阅（start plan）的费用口径和 token 计费口径可能不一致（订阅是打包额度），金额展示要以控制台「订阅抵扣后」口径为准，勘察时一并确认。

## 六、必要设施清单（实施时要备齐的）

- [ ] Edge 专用 profile + 智谱账号登录一次（CDP 端口 9223）；
- [ ] 从 DevTools 抄下两个页面的 XHR 接口（路径/参数/返回结构）；
- [ ] 智谱官方定价表（各模型 peak/off-peak、cache 命中/未命中）；
- [ ] Node 端 CDP 客户端（EAC 里已有现成写法可参考/移植）；
- [ ] 只读访问 `db.sqlite` 的快照读取函数；
- [ ] 浮窗壳（复用/改造 EacMonitorFloat.exe + float-config.json + inject-ui.js）；
- [ ] 隐藏自启（沿用 `supervise-dsh-hidden.vbs` 同款机制，可选）。

## 七、建议实施顺序（供批准后执行）

1. **勘察**（半天）：DevTools 确认智谱接口；确认订阅口径；定 CDP 端口与 profile。
2. **数据源 B 先行**：monitor.mjs 读取本地 DB → 出「各模型用量 + token 曲线」最小页面（无外部依赖，先看到东西）。
3. **数据源 A 接入**：CDP fetch 智谱接口 → 余额/官方金额卡片 + jsonl 采样合并。
4. **浮窗化**：套 EacMonitorFloat 壳，搬 inject-ui.js，复刻图层/透明度接线。
5. **验收**：对账（B 的 token 合计 vs 控制台、估算金额 vs 官方账单）、断源降级测试、双开/孤儿浮窗回归。
