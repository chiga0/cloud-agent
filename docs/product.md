# cloud-agent 产品化实施文档（w1–w6，2026-09-03 定稿 v2）

cloud-agent 从「纯 API harness + 操作员 curl」演进为**浏览器一等公民的运维看板**。
本文件是 w 系列的**唯一权威实施文档**（单一权威副本，派单规格从这里派生，不允许规格与本文件漂移）。

不变量（产品化全程不动）：

- 用户 = 操作员（自己人），单租户，不做公网多租户、不做用户体系。
- 三支柱不变：可观测（SSE + Live UI 已就绪）、可审计（hash chain 可独立核验）、可操作（审批）。
- 权威边界不变：TaskSession DO 单写者；**前端是投影**，只读显示 + 显式操作入口，不做任何权威判定；
  平台不持 push 凭据；land.mjs 守门链不因前端改动松动。
- 每棒 ≤ 40min 墙钟天花板，余量靠缩范围不靠加预算；每棒规格必须内嵌时间账纪律（r2 教训）。

## 1. 总体架构：同 worker 全栈，不前后端分离

- **一个部署单元**：Worker = API（`/api/*`）+ 静态资产（Vite build 产物）+ SPA fallback。
- 选型依据（已核实 Workers Static Assets 官方 GA 能力）：同域名同源 → **无 CORS**、cookie（SameSite=Strict）可用、
  EventSource 可用；`not_found_handling: "single-page-application"` 让客户端路由直接成立；一个 `wrangler deploy`。
- 前后端分离（两个域名/两个部署单元）的代价清单（已评估并否决）：CORS 白名单 + 预检、
  SameSite=Strict cookie 跨站失效 → 会话被迫降级 Lax + CSRF token、land.mjs 要管两个部署单元。结论：不分离。

## 2. 路由分区与 `/api/*` 迁移（w1a）

**为什么必须迁移**：`GET /tasks/:id`（API，返 JSON）与客户端路由 `/tasks/$taskId`（页面）同形。
静态资产就位后，「不匹配资产」的请求才会落 SPA fallback，而 `/tasks/<uuid>` 恰好**匹配 API 路由** →
浏览器导航到详情页会拿到一坨 JSON。路径前缀分区是唯一干净解（Accept 内容协商是脆弱方案，否决）。

分区表：

| 前缀 | 归属 | 棒 |
|---|---|---|
| `/api/*` | 全部 API（迁移自 `/tasks*`、`/admin/*`） | w1a |
| `/api/session/*` | 会话端点（w1b 新增） | w1b |
| `/live/:taskId` | 过渡期旧页面，w4 退役 | — |
| `/healthz` | 健康检查，不动 | — |
| 其余一切 | 静态资产 / SPA fallback | w2 起 |

迁移清单（writer 的活，机械替换 + 全量测试随动）：

```
POST /tasks                                          → POST /api/tasks
GET  /tasks/:id                                      → GET /api/tasks/:id
GET  /tasks/:id/{result,evidence,candidate,events}   → GET /api/tasks/:id/…
GET  /tasks/:id/events/stream                        → GET /api/tasks/:id/events/stream
POST /tasks/:id/approve                              → POST /api/tasks/:id/approve
GET  /tasks/:id/attempts/:aid/transcript             → GET /api/tasks/:id/attempts/:aid/transcript
GET  /admin/{tasks,attempts,events,chain-check}      → GET /api/admin/…
```

- in-repo 调用点随动：全部 SELF fetch 测试、`live.ts` 的 STREAM_URL（**必须加测试钉住页面注入的流路径以 `/api/` 开头**）、docs、README。`GET /` 旧落地页 w1a 不动（w2 退役，内容已在 README/docs）。
- **运营侧随动件（writer 禁止触碰 `scripts/`，操作员在部署前完成）**：land.mjs、landing kit、poller 里的 URL 全部改 `/api/*`。顺序 = w1a 落地 → 操作员改 land.mjs → 部署 → 冒烟 → 才派下一棒（不部署旧 land.mjs 打新 API 的断粮窗口）。

## 3. 会话与鉴权（w1b，鉴权面的唯一改动）

- **无状态 HMAC 会话 cookie**：`POST /api/session/login {token}` → 常数时间比较 `WORKER_API_TOKEN` →
  `Set-Cookie: __Host-cas=<b64url({exp})>.<sig>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=21600`。
  `sig = HMAC-SHA256(key=WORKER_API_TOKEN, payload)`。零存储、天然过期、**换 token 即全量撤销**（与现有运维模型一致）。
  `__Host-` 前缀强制 Secure+Path=/+无 Domain（防子域混淆）；`wrangler dev` 的 http://localhost 是可信上下文，Secure cookie 可用。
- `checkApiToken` 扩展：**Bearer 优先**（API 客户端与 land.mjs 零回归），cookie 签名+未过期兜底（浏览器）。
  **w1b 第一验收 = land.mjs Bearer 全链照常工作。**
- CSRF：SameSite=Strict 主防；cookie 鉴权的**非 GET** 请求额外要求 `Origin` 头同源（浏览器对 POST 恒发 Origin，
  跨站表单连 cookie 都带不上还过不了 Origin 检查，双保险且前端零代码）。
- `POST /api/session/logout`（清 cookie）；`GET /api/session/me`（SPA bootstrap，401 → 前端跳登录）。
- **最大红利：EventSource 自动携带 same-origin cookie** —— 浏览器直连 SSE 从 w1b 起真正可用，c9b 的「401 页面」问题就此终结。

## 4. 前端工程基座（w2，技术栈定稿）

**技术栈（用户方向定稿：优先拥抱 TanStack 生态开源组件）**：

| 层 | 选型 | 说明 |
|---|---|---|
| 构建 | Vite（root=`web/`，outDir=`dist/`） | 根目录单 package.json，npm ci 一次 |
| UI | React + TypeScript strict | worker/web 两份 tsconfig，typecheck 脚本双跑 |
| **路由** | **@tanstack/react-router**（代码式路由，不引文件路由插件） | 类型安全 params/search、loader 与 Query 集成；用户定夺由 react-router 改此栈 |
| 服务端状态 | **@tanstack/react-query** v5 | router context 携 queryClient，loader `ensureQueryData` 预取 |
| **表格** | **@tanstack/react-table** v8 | headless（排序/过滤/分页逻辑），markup 用设计 token 自绘 |
| 样式 | Tailwind CSS v4（@tailwindcss/vite 官方插件）+ shadcn/ui | 组件源码进仓；radix 运行时原语随用随加，不预装全家桶 |
| SSE | 原生 EventSource + hook 封装 | 事件流是增量流不是快照，**不走 Query 缓存**；停滞计时用 `Date.now()` 差值（抗 hidden-tab 节流，c9b 实测） |
| 校验 | zod | search 参数校验 + API 响应运行时校验 |

- **TanStack Router 选型注记**：与 Query 同生态（loader 预取一体化）、`/tasks/$taskId` 参数类型安全、
  search 参数带校验；代价 = 语料比 react-router 小（qwen dogfooding 风险）→ 缓解：路由结构刻意简单（≤6 条）、
  代码式路由不引文件路由插件、规格里直接给出关键 API 用法示例。
- `wrangler.jsonc`：`assets: { directory: "dist", binding: ASSETS, not_found_handling: "single-page-application" }`，
  `run_worker_first: ["/api/*", "/live", "/live/*", "/healthz"]`（漏列 = API 被 SPA 吞掉返回 HTML，w2 冒烟必测）。
- `verify_command` 自 w2 起扩为 `npm run typecheck && npm test && npm run build`。
- 交付：工程骨架绿 + `/login` 页（第一个路由）+ authed 布局壳（`beforeLoad` guard：`/api/session/me` 401 → 重定向）。
- 旧 `/` 落地页（landingHtml）在 w2 退役。

## 5. 页面清单与信息架构

| 路由 | 棒 | 数据源 | 要点 |
|---|---|---|---|
| `/login` | w2 | `POST /api/session/login` | token 粘贴框；错误提示不区分「token 错」与「网络错」（不泄露探测面） |
| `/` 任务列表 | w3 | `GET /api/admin/tasks`（**已有端点，零后端改动**） | TanStack Table；state 过滤（search param + zod）；**游标「加载更多」**（服务端是 cursor 分页，不伪装成页码）；RUNNING 置顶；30s refetchInterval |
| `/tasks/$taskId` 详情 | w4 | `GET /api/tasks/:id` + `/events` + `/events/stream`（全部已有） | 头部（state 徽章/budget/base sha/digest/attempts）+ **事件时间线**（SSE 直连 + Last-Event-ID 续传，与 `?after=` 拉取互为恢复源）+ attempts + result/evidence/candidate 区。**逐条迁移 c9b/c9c 实测经验**：kind 徽章全值、200 字符截断、停滞三色 >90s 黄 >300s 红（`Date.now()` 差值）、坏帧跳过并计数（绝不让一条坏帧停更整页）、end 帧停表、**readyState 双文案（401→CLOSED「不会自动重连」）** |
| `/approvals` | w5 | `GET /api/admin/tasks?state=AWAITING_APPROVAL` + `POST /api/tasks/:id/approve`（已有；缺 state 过滤参数则小补） | 证据视图（result_text / binding digest / manifest）+ candidate patch 预览 + approve 确认弹层（原因必填）。**人工门的一等公民化** |
| `/audit` | w6 | `GET /api/admin/events` + `GET /api/admin/chain-check`（已有） | 跨任务事件流 + **digest 链可视化**（prev→cur 链接图形化，chain-check 状态置顶）+ `supervisor_finding` 流（消费 c10 产出） |

- w4 验收通过后**退役 `/live/:taskId`**（页面 + 路由删除；SSE 数据端点保留）；过渡期 301 到 `/tasks/$taskId`。
- 后端在四层可观测架构里已经基本完工（admin/events、chain-check、approve、candidate 全部现成）——
  w 系列本质是**前端工程**，这决定预算分布。

## 6. 拆棒与预算（串行链式，每棒 base 钉上一棒落地 commit）

| 棒 | 内容 | budget | 新增后端 |
|---|---|---|---|
| w1a | `/api/*` 路由迁移（含测试/docs/live.ts 随动） | 1800 | 无（纯迁移） |
| w1b | 会话基座：HMAC cookie + checkApiToken 扩展 + `/api/session/*` + CSRF | 1800 | session 3 条 |
| w2 | 前端工程基座：Vite+React+Router/Query+Tailwind+assets+run_worker_first+login+布局壳 | 3000 | 无 |
| w3 | 任务列表页 | 2400 | 无 |
| w4 | 任务详情页（c9b/c9c 经验全量迁移）+ `/live` 退役 | 3000 | 无 |
| w5 | 审批 UI | 2400 | 至多 1 个过滤参数 |
| w6 | 审计页 + 链可视化 + findings | 2400 | 无 |

执行顺序：**c10 → w1a → w1b → w2 → w3 → w4 → w5 → w6**（c10 先行：`supervisor_finding` 是 w6 的天然数据源；
p2/p3 台账修正与 w 系列无耦合，可穿插）。

## 7. 风险登记

- **run_worker_first 漏列 `/api/*`** = API 被 SPA fallback 吞掉返 HTML → w2 冒烟清单：curl 全部 API 前缀断言 `content-type: application/json`。
- **w1a 漏改 live.ts STREAM_URL** = /live 页连旧路径 404 → w1a 加测试钉「页面注入的流路径以 /api/ 开头」。
- **land.mjs 断粮窗口** → 固定顺序：落地 → 改 land.mjs（操作员）→ 部署 → 冒烟 → 派下一棒。
- **Bearer 零回归是 w1b 第一验收**（land.mjs 是落地通道，断它 = 断粮）。
- **qwen 视觉边界**：规格钉死设计 token 与布局骨架，writer 只做实现；单测钉不住的标「需浏览器实测」，
  每棒部署后操作员浏览器冒烟。
- **Tailwind v4 / TanStack Router 语料较新**：用官方 vite 插件不手配 postcss；代码式路由 + 规格给 API 示例。
- **成本台账口径**：p3 落地前 `result.captured` 的 tokens 仍是完成态口径（被杀任务漏记 ~49×）——
  w 系列展示成本时标注口径，不在 w 系列里修台账（单一职责）。
- **CSRF/会话安全**：HttpOnly+Secure+SameSite=Strict+Origin 同源，四件套齐备才允许 w1b 落地；
  HMAC key 即 WORKER_API_TOKEN 本身，不新增 secret。
- **设计语言**（沿 c9b 已验收视觉延展，w2 定调后 writer 禁止自由发挥）：
  暗色运维风 `--bg:#0d1117` 系；state 色 ok/warn/err/run；等宽字体呈现一切数据；间距 4px 网格；零依赖内联 SVG 图标。
