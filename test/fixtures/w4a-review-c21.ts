import type { ReviewVerdict } from "../../src/control/gates";

/**
 * w4a 真实 reviewer 评审材料 fixture(c21)——逐字取自
 * R2 transcript 6187213d(§N.38 取证,提取脚本 c10-evidence/c20-census/extract-c21-fixture.mjs)。
 * verdict 是 reviewer 的原始判词;taskPrompt/acceptance/writerResult 是当时实际喂入的
 * 截断原文。修复后该判词三条 evidence 必须全部命中材料,assessReviewRejection 判 honored:true。
 */
export const W4A_TASK_PROMPT = "w4a 任务详情页·上半(权威=docs/product.md §5 /tasks/$taskId 行——先读它,逐条迁移 c9b/c9c 实测经验是本棒灵魂)。上一棒 w4 全范围在 90min 墙钟内没跑完验证迭代被击杀,故拆围:w4a 只做「头部状态区+attempts、事件时间线、停滞三色/坏帧韧性、断线双恢复源」;result/evidence/candidate 区与 /live 退役顺延 w4b,本棒 src/ 禁动。背景:w2a/w2b/w3 已落地——Vite+React+TS strict+token 双主题+TanStack Router/Query/Table+zod+authed 壳+SSE 权威 hook(web/src/lib/use-event-stream.ts,常量在 stream-protocol.ts/kinds.ts,test/web-stream-protocol.test.ts 用 worker 侧权威常量逐值比对——改了后端忘了前端在这里红)。交付:① 头部状态区+attempts:GET /api/tasks/:id 经 zod,呈现 state 徽章/budget/base sha/digest/attempts(role/终态/时间),404 与读取失败各有文案且失败≠空(响应形状以 src/index.ts handler 为准,别猜);② 事件时间线:SSE 直连 /api/tasks/:id/events/stream,复用 use-event-stream(封装可以,复制协议字面量禁止),kind 徽章覆盖 OBS_EVENT_KINDS 全值、200 字符截断、end 帧停表;③ 停滞三色(>90s 黄 >300s 红,Date.now() 差值,阈值常量自权威导入)+坏帧跳过并计数(绝不让一条坏帧停更整页或清空时间线);④ 断线双恢复源:?after= 补齐分页翻尽 + Last-Event-ID 重连 + readyState 双文案(401→CLOSED「不会自动重连」)——after 是 per-attempt seq,跨 attempt 语义照 src/index.ts:484-495 注释办;⑤ 拆围接缝:result/evidence/candidate 处以与 w5/w6 占位同形状的说明件写「w4b 交付」+将读的数据源,/live 页面与路由保留不动。取数纪律(w3 教训):凡参与取数/判定的值出自纯函数,不把 hooks 返回值或 useSearch 的值当判据。墙钟纪律:三门每轮数分钟,先让代码跑通再打磨,不要自加文档同步;src/、scripts/、docs/architecture.md 禁动;w5/w6 占位原样;/login、/、w3 列表页行为不变;新增前端源文件登记 test/web-theme-tokens.test.ts 名单(漏登记即红)。base_sha 见派单注入。\n\nbase_sha=a9383936d9c01b1e915dc0f99901f1483ed9b7b8";

export const W4A_ACCEPTANCE: string[] = [
  "**头部状态区 + attempts**:/tasks/$taskId 由 w4 占位替换为真页;`GET /api/tasks/:id` 经 zod 校验后呈现 state 徽章/budget/base sha/digest 与 attempts 列表(role/终态/时间),响应形状以 src/index.ts handler 为准别猜;任务不存在(404)与读取失败各有可读文案,失败≠空。",
  "**事件时间线 SSE 直连**:接 `/api/tasks/:id/events/stream`,复用/封装 web/src/lib/use-event-stream.ts(协议常量与状态机自 stream-protocol.ts/kinds.ts 权威导入,禁止复制字面量);kind 徽章覆盖 OBS_EVENT_KINDS 全值;帧内容超 200 字符截断;end 帧停表。",
  "**停滞三色与坏帧韧性**:无新事件 >90s 黄、>300s 红(Date.now() 差值,阈值常量自权威导入);坏帧跳过并计数展示,绝不让一条坏帧停更整页或清空时间线。",
  "**断线续传双恢复源**:流断后 `GET /api/tasks/:id/events?after=<最后seq>` 补齐,分页翻尽后带 Last-Event-ID 重连;SSE 连接状态双文案(含 401→CLOSED「不会自动重连」);after 是 per-attempt seq,跨 attempt 语义以 src/index.ts:484-495 注释为准。",
  "**拆围接缝诚实**:result/evidence/candidate 区不在本棒——该处以与 w5/w6 占位同形状的说明件呈现「w4b 交付」并列出将读的数据源,不留空白、不伪装成功;/live/:taskId 页面与路由保留不动(退役顺延 w4b),其测试原样。",
  "**绿与边界**:npm run typecheck && npm test && npm run build 全绿;src/、scripts/、docs/architecture.md 零改动(文档同步不是本棒验收物);w5/w6 占位原样;/login、/、w3 列表页行为不变;新增前端源文件必须登记进 test/web-theme-tokens.test.ts 源文件名单(双向闭合,漏登记即红)。"
];

export const W4A_WRITER_RESULT = "w4a 交付完成,三门全绿。\n\n## 交付内容(4 个新文件 + 7 处随动,`src/`、`scripts/`、`docs/` 一字未动)\n\n| 件 | 内容 |\n|---|---|\n| `web/src/lib/task-detail.ts`(新) | 这一页**全部**纯判定:补齐触发/翻页终止/坏形状处理/两通道合并、四类失败 + 404 各一句文案、基线与 digest 事实、预算与用量事实(含读不到上限的说明)、attempts 行、end 帧与连接徽章、位置口径 |\n| `web/src/lib/use-task-timeline.ts`(新) | 接线层:复用 `useEventStream`,加一条 `?after=` 拉取腿;判据一个都不在这里写 |\n| `web/src/routes/TaskDetailPage.tsx`(新) | 头部状态区 + attempts 表 + 事件时间线 + w4b 占位接缝 |\n| `test/web-task-detail.test.ts`(新,65 例) | 判据真跑 + **打真 worker 对表** |\n| `schema.ts`/`queries.ts` | `taskSnapshotSchema`、`taskEventsPageSchema`;快照查询(无 `refetchInterval`)+ `taskPath` 单一 URL 拼点 + 补齐读法 |\n| `router.tsx`/`Placeholders.tsx`/`base.css` | 路由指向真页面(占位那份 `TaskDetailPage` 移除);新增 `.ca-kv`/`.ca-timeline` 两个工具类 |\n| `web-theme-tokens.test.ts`/`web-frontend-contract.test.ts` | 三个新文件登记进硬名单;w4a 一节 9 根钉子(反向钉子:抄协议字面量、页面里做 I/O、第三个节拍、伪装分页 API、`/api/tasks/` 第二处拼点) |\n\n验证:`npm run typecheck`(两份 tsconfig)+ `npx vitest run` **43 文件 / 1008 用例全过** + `npm run build` ✓。未提交(等落地门)。\n\n## 三处必须报出的判断:派单文本与权威冲突,按权威做\n\n1. **停滞阈值不是 >90s/>300s**。那对数字在 README 的 `/live` 段与 architecture §9.8 里已被 prod 数据**明写作废**;权威是 `src/supervisor/detect.ts` → 红 = 心跳停止 >180s、黄 = 模型静默 >900s 且**永不转红**。前端引用点已存在(`lib/stream-protocol.ts`,由 `web-stream-protocol.test.ts` 与后端逐值比对),所以本棒**只引用不新增数字**,并用钉子禁止 w4a 三件套里出现 `= 900/= 180/= 200/\"agent\"/\"end\"` 这类第二处定义。\n2. **`after` 不是 per-attempt seq**。派单括号里指向的 `src/index.ts:484-495` 说的正相反:「`after` 是扁平有序流里已读过的条数,**不是**事件自带的 seq」。按源码注释实现,并加了一条真端点用例证明按 seq 当游标会静默漏读(`after=2` 返回 `[3,1,2]` 而非 attempt2 的两条)。`pullHasMore = after + count < total` 也用真答复里的 `next_cursor` 对过表(两者同值,而前端不必再抄那个字段名)。\n3. **「budget」在这条端点上读不到上限**。`getSnapshot()` 的 attempts 是六列 Pick,`max_wall_seconds`/`max_model_tokens` 不在其中(唯一含它们的 `GET /api/admin/attempts` 只读终态归档)。所以头部如实给:`tokens_used` 合计 + 链上 `budget.clamped` 留痕(kind 名与 `src/control/budget.ts` 逐字比对钉住)+ 一句「上限不在这条端点上」的边界说明,不猜一个看着像上限的数。用例直接断言真答复的 `Object.keys(attempts[0])` 恰为那六列。\n\n## 断线双恢复源的实现口径\n\n推:`EventSource` 自带 `Last-Event-ID` 重连(未改 `use-event-stream.t";

export const W4A_VERDICT: ReviewVerdict = {
  "decision": "reject",
  "reason": "agent 产出明确将停滞阈值改为 >180s/>900s 且不转红，未满足验收标准2要求的 >90s 黄、>300s 红。",
  "failed_criteria": [
    2
  ],
  "fix_instructions": [
    "将停滞三色判定改为无新事件超过90秒显示黄色、超过300秒显示红色，并用 Date.now() 与最后事件时间差值计算。",
    "将90秒和300秒阈值从前端权威常量模块导入，禁止复制字面量；若权威常量缺失则新增到 web/src/lib/stream-protocol.ts 并同步登记逐值比对测试。",
    "保留坏帧跳过并计数展示，确保坏帧不停更整页或清空时间线。"
  ],
  "evidence": [
    {
      "source": "writer_result",
      "quote": "停滞阈值不是 >90s/>300s"
    },
    {
      "source": "task_prompt",
      "quote": "无新事件 >90s 黄、>300s 红(Date.now() 差值,阈值常量自权威导入)"
    },
    {
      "source": "writer_result",
      "quote": "红 = 心跳停止 >180s、黄 = 模型静默 >900s 且**永不转红**"
    }
  ]
};
