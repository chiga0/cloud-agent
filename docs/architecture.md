# cloud-agent 架构与设计

> 一句话:**控制面 / 执行面分离、可恢复、可审计**的云端 coding agent 基建。
>
> 栈:Cloudflare Workers + Durable Workflows + D1 + R2 + Sandbox + Queues;现有 agent CLI(`@qwen-code/qwen-code`)作为执行 worker 跑在沙箱里,Worker 自身不实现智能,只做**权威状态、凭据注入、事后记账、证据归集**。

---

## 1. 设计目标与非目标

### 目标

| 维度 | 承诺 |
|---|---|
| **正确性** | 运行中任务状态以 TaskSession DO 为唯一权威(单写者串行 + 显式转换表),终态归档 D1;任何外部视图(Workflow 历史、日志、R2 文件)都不作为仲裁依据 |
| **可恢复** | Worker 崩溃、Sandbox 容器替换、Workflow step 重试均不丢失进度;每个 step 都是幂等可重放 |
| **可审计** | 模型 I/O、沙箱 transcript、人工决策一律进 hash chain + 内容寻址 R2,篡改可检测 |
| **可交付** | 每个 repo 候选绑定一个精确基线 commit(writer 与 verifier 在同一个 SHA 上工作),经 `GET /api/tasks/:id/candidate` 原样取回并在本地重放(§13.13) |
| **凭据合规** | token-plan key 直连百炼、不经代理转发、不落盘(telemetry 关闭)。M8 起可分裂为两把:沙箱拿**可撤销的低权 key** `SANDBOX_MODEL_API_KEY`,高权 `DASHSCOPE_API_KEY` 留在 Worker 侧给 reviewer——低权那把是可选配置,缺配即回落共用,降权要等它真的铸出来才成立(§13.14) |
| **成本可控** | 每个 attempt 有 token / 时长 / turn 三重预算;时长与 turn 由 qwen-code 参数硬停,token 事后记账供归因与后续决策 |

### 非目标

- 不是多租户平台 — 当前单一 `WORKER_API_TOKEN` 做 API 鉴权,无用户/团队层
- 不是 agent 框架 — agent 实现(qwen-code / 未来的 opencode、pi)由 sandbox 镜像提供,本仓不管
- **不写外部代码托管** — 本仓的权威止于「产出可核对的候选 + 人工批准」;把批准后的精确内容送回 GitHub 需要独立的 Publisher 与受限写权限,属 M9+。沙箱一律不持有 push 能力
- 不提供实时流式 UI — 只暴露 REST,前端后续再做
- 不追求高并发写 — events hash chain 是防篡改,不是为吞吐优化

---

## 2. 系统拓扑

```
 ┌──────────────┐   POST /api/tasks              ┌──────────────────────────────┐
 │  外部调用方   │ ─────────────────────────────►  │  Worker (src/index.ts)       │
 │  CLI / UI    │                                 │   ├─ 控制面 API              │
 └──────────────┘                                 │   └─ Queue consumer          │
       ▲                                          └──────┬───────────────────────┘
       │ GET /api/tasks/:id  /result                         │
       │              ┌──────────────────────────────────┼──────────────────────┐
       │              │                                  ▼                      │
       │              │         ┌──────────────────────────────────────┐        │
       │              │         │   AttemptWorkflow (Durable Workflow) │        │
       │              │         │   exec → extract → evidence →        │        │
       │              │         │   report → (writer) human-approval   │        │
       │              │         └──────────────┬───────────────────────┘        │
       │              │                        ▼                                │
       │              │         ┌──────────────────────────────────┐             │
       │              │         │   Sandbox (一次一个容器)           │             │
       │              │         │   qwen-code stream-json          │             │
       │              │         │   直连百炼(token-plan key)        │             │
       │              │         └──────────────────────────────────┘             │
       │              └────────────────────────┼─────────────────────────────────┘
       │                                       │
       ▼                                       ▼
  ┌─────────┐                      ┌──────────────────────────────────┐
  │ 人类审批 │                      │  D1 (终态归档) · R2 (证据)      │
  │  via API│                      │  tasks / attempts / decisions    │
  └─────────┘                      │  events (hash chain)             │
                                   │  artifacts/ + evidence/          │
                                   └──────────────────────────────────┘
```

模块与源文件映射:

| 层 | 模块 | 文件 |
|---|---|---|
| 入口 + 路由 | Router / Landing / API dispatch(含候选交付 `handleGetCandidate`) | `src/index.ts` |
| 控制面 | **权威**:状态机、事件链、证据钉住、决策、终态归档 | `src/control/session.ts`(TaskSession DO) |
| 控制面 | 转换表 / watchdog 数学 / 组合 digest(纯函数) | `src/control/statemachine.ts` |
| 控制面 | 门禁分级判定 + 返工指令生成(纯函数) | `src/control/gates.ts` |
| 执行面 | Workflow 编排 | `src/exec/workflow.ts` |
| 执行面 | 基线冻结:SHA 校验 + 材质化/导出脚本(纯函数) | `src/exec/base.ts` |
| 执行面 | Sandbox 启动、基线材质化、transcript 处理 | `src/exec/sandbox.ts` |
| 执行面 | 独立验证器(新沙箱重放候选) | `src/exec/verify.ts` |
| 执行面 | reviewer(纯 LLM 直调,无工具) | `src/exec/review.ts` |
| 执行面 | 答案提取 + token 统计(stream-json → 纯文本/用量) | `src/exec/extract.ts` |
| 执行面 | attempt prompt 组装(原始任务 + 返工指令) | `src/exec/prompt.ts` |
| 执行面 | Queue consumer(verifier/reviewer 路由 + 回报映射) | `src/exec/queue.ts` |
| 审计 | sha256 / R2 内容寻址 / manifest | `src/audit/evidence.ts` |
| 审计 | 候选读模型投影(纯函数) | `src/audit/candidate.ts` |
| 类型 | Env / TaskState / AttemptParams / BaseRef | `src/types.ts` |
| Schema | D1 迁移脚本 | `migrations/0001_init.sql`、`0002_add_result_text.sql`、`0003_add_event_seq.sql` |
| 沙箱 | 自定义镜像(qwen-code 预装) | `sandbox/Dockerfile` |
| 部署 | Wrangler 绑定 + 容器配置 | `wrangler.jsonc` |

---

## 3. 设计原则

1. **权威唯一(TaskSession DO 运行中 / D1 终态)**
   运行中任务状态、attempt 状态、decision 全部由 TaskSession DO 单写者维护(内存态 + DO storage,带 fencing version);终态(DONE/REJECTED/BLOCKED)归档 D1 供查询。Workflow 历史、Worker 日志、R2 文件只承担参考/证据角色。
2. **Fail closed**
   fencing、token 校验失败一律拒绝;不靠 429 软信号,避免 agent 框架把限流误解为可重试。运行时长/turn 由 qwen-code 自身参数硬停,超限即非零退出。
3. **沙箱是隔离边界**
   沙箱内 qwen-code 直连百炼:token-plan key 只以环境变量注入 agent 客户端(token-plan 许可的用法),不经代理、不落盘、不写日志。沙箱内部 permission 一律放行(`--yolo`),隔离由外层容器承担。
4. **证据绑定决策**
   每个 decision 都带 `evidence_digest`,指向一份 manifest;manifest 内嵌 transcript / artifact / verify 的 digest。事后审计:`digest 在,决策就有依据`。
5. **幂等 + 可重放**
   Workflow step 失败后 Durable Workflow 会从上一个完成的 step 重放;所有写 D1/R2 的函数都对重入安全(INSERT UNIQUE、CAS、putArtifact 内容寻址覆盖同 key)。
6. **可观测的最小集**
   事件链(events)覆盖 task.created / attempt.created / model.call / result.captured / decision.recorded / task.transition;任一动作可追溯。

---

## 4. 核心概念

### Task
一次用户请求(immutable spec + 可变状态)。`spec` 在创建时 JSON 序列化 + SHA-256 冻结(`spec_digest`),后续不可变。

```ts
// src/types.ts
interface TaskSpec {
  prompt: string;
  acceptance?: string[];    // 声明式验收标准;缺省时 reviewer 意见纯 advisory
  repo_url?: string;        // 待改造仓(当前仅公开 https 匿名克隆,私有仓接入位在注释)
  base_sha?: string;        // 人工指定的冻结基线(全长度 hex);缺省 = 执行时解析默认分支 HEAD 并固定
  verify_command?: string;  // 独立验证器在冻结基线上重放候选后要跑的命令
  worker?: "qwen-code";
}
```

`spec_digest` 刻意只覆盖**人工意图**:执行期才解析出的基线不进 spec,而是落 `TaskRecord.base: { sha, source }`(§13.13)。Task 的 `result_text` 由回报路径写进 DO,终态随归档落 D1(`migrations/0002`)。

### Attempt
Task 的一次执行尝试。同一 task 可能有多次 attempt(rework 再试;或 verifier / reviewer 接力)。每个 attempt 有自己的:
- `max_model_tokens` / `max_wall_seconds` — 预算(时长/turn 由 qwen-code 参数硬停;tokens 事后记账)。`max_wall_seconds` 的口径权威在 `src/control/budget.ts`:入口形状校验(非法 → 400 `invalid_budget`)、缺省只有一份、被平台上限夹钳时往链里落一条 `budget.clamped`(§7.2.2)
- `tokens_used` — transcript 解析出的实际用量,由 workflow 的 extract step 统计
- `workflow_instance_id` — 对应的 Durable Workflow 实例
- `idempotency_key` — `task_id:attempt:N` 或 verifier/reviewer 场景的自定义键,UNIQUE 约束保证去重
- `base_pin` — 本轮要材质化到的精确 commit;返工轮由 `TaskRecord.base` 继承,并写进 `attempt.created` 事件

> `proxy_token` 列是旧代理架构的遗留(0001 schema),主流程已不使用,保留兼容。

### Decision
人工(HITL)或系统对 attempt 的判定。`POST /approve` 只收 `approve|reject`;落库的决策值另有两个内部产物——`accept_with_notes`(reviewer 想返工但举证不成立,降级放行、意见留档)与 `none`(reviewer 抖动或没产出结论,挂 `awaiting_human`)。任何 decision 强制绑定组合证据 digest(§13.9)。

### Candidate
repo 任务的产出物:一份基于**冻结基线**的 git patch + 它的证据血统。它**不是新的状态对象**,而是 `TaskRecord.base` + 钉住的 writer manifest + verifier 结论 + 最新 decision 的读模型投影(`src/audit/candidate.ts`),经 `GET /api/tasks/:id/candidate` 取回。`status` 与 `safe_to_apply` 的存在是为了让消费方一眼分清「独立验证过」和「只是产出过」——被 reject 或基线漂移的候选不能看起来像可直接提交。

### Evidence
R2 里的内容寻址对象 + 一次 attempt 的 manifest:

```
artifacts/sha256/<xx>/<xx>/<digest>          ← transcript / stderr / verify
evidence/ model-io/<task_id>/<digest>        ← 每次模型调用的原始 response
evidence/ manifests/task/<task_id>/<attempt_id>-<digest-prefix>.json
```

`putArtifact` 返回的 `{ key, digest, size }` 是绑定证据的最小单元。

### Event(hash chain)
追加式审计日志,每条:
```
digest = sha256(prev_digest || canonical({task_id, kind, payload}))
```
`prev_digest` 为空时以 `"GENESIS"` 起链。链断(`prev_digest` 与上一条 `digest` 不匹配)即告警。

---

## 5. 状态机

### Task 状态

合法转换的唯一权威是 `src/control/statemachine.ts` 的 `TASK_TRANSITIONS` 表;所有状态写入经 `setState → assertTransition` 校验,非法转换抛 `AuthorityConflict`(fail closed,不依赖调用点自觉):

| from \ to | RUNNING | VERIFYING | AWAITING_APPROVAL | DONE | REJECTED | BLOCKED |
|---|---|---|---|---|---|---|
| **PENDING** | ✅(writer claim) | | | | | ✅ |
| **RUNNING** | ✅(rework 下一 writer) | ✅(writer 成功,派验证器) | ✅(非 repo 任务 / verify fan-out 降级,派 reviewer;无进展熔断直接挂起) | | | ✅(workflow 错误 / writer 失败耗尽 / writer 预算到期 exit 53·55) |
| **VERIFYING** | ✅(验证失败,预算内 rework;env 签名样本仍走此路,§13.21) | | ✅(验证通过,派 reviewer) | | ✅(验证失败且预算耗尽) | ✅(验证器基建错误耗尽 / 超时) |
| **AWAITING_APPROVAL** | ✅(reviewer reject 且证据契约成立,预算内 rework) | | | ✅(approve / accept_with_notes) | ✅(reject) | ✅(超时兜底) |
| **DONE / REJECTED / BLOCKED** | — | — | — | — | — | —(终态) |

语义区分:
- **REJECTED** = 质量否决(reviewer/verifier 判定候选不合格,且 rework 预算耗尽)
- **BLOCKED** = 执行故障(writer 反复失败耗尽、workflow/基建错误、超时、预算到期),证据链可定位原因
- writer `exit_code != 0` **绝不**进入审批流(硬门禁),只能 rework 或 BLOCKED;其中 `exit 53/55`(qwen 预算执法)**只能** BLOCKED 转人工,不派同规格返工(§13.21)
- **`accept_with_notes`**(M7)→ DONE:reviewer 想返工但拿不出可核对的证据(影子期之外的 enforce 模式)或任务已 `awaiting_human` 时 reviewer 给出 advisory,均属此类(§13.12)
- **`task.awaiting_human`**(M7)= fail-closed 挂起标记:reviewer 基建不可用或无进展熔断命中时置位,此后 reviewer 的结论只记事件不裁决,终态只能由 `submitDecision` 人工给出

### Attempt 状态

```
RUNNING ──┬─► SUCCEEDED   (exit_code == 0;writer/verifier 还要求裁决为 approve)
          ├─► FAILED      (exit_code != 0 或 decision=reject)
          └─► BLOCKED     (workflow 异常捕获)
```

reviewer 的 `decision:"none"`(基建失败或输出不可解析,见 §13.12)**不是** attempt 失败:进程跑完了,只是没有任何自动裁决,任务停在 `AWAITING_APPROVAL` 并置 `awaiting_human` 等人工。

---

## 6. 控制面 — `src/control/`(TaskSession DO 为唯一权威)

M1 起权威从「Worker 直接 CAS D1 行」迁到 `TaskSession` DO,早期的 `src/control/authority.ts` 自由函数(`createTask/createAttempt/transition/recordDecision`)已删除。现存文件分工(路由判据独立放在 `src/routing/`,与 `src/control/` 同属控制面权威侧):

| 文件 | 职责 |
|---|---|
| `session.ts` — `TaskSession extends DurableObject` | 唯一写者:状态机、attempt 编排、证据钉住、决策、终态归档 |
| `statemachine.ts`(纯) | 转换表合法性、`attemptDeadline` / `nextWatchdogAlarm`、`composite` 组合 digest |
| `gates.ts`(纯) | 门禁分级判定、`describeVerifyFailure` 等返工指令生成 |
| `../routing/classify.ts`(纯) | 失败性质 → 路由动作:预算到期 / 环境签名 / 质量兜底三档判据 + 模式表(§13.21) |

**RPC 面**:写入 `createTask` / `startAttempt` / `reportExecution` / `submitDecision` / `alarm`;只读投影 `getSnapshot` / `getResultText` / `getEvidenceSummary` / `getCandidateRefs` / `getAttemptManifestKey`。Worker 侧不做任何仲裁,只做 HTTP ↔ RPC 的转换与 R2 读取。

**关键设计点**:

- DO 是**运行中**任务的权威;D1 只是终态归档 + 查询视图。Workflow 历史、日志、R2 文件都不是仲裁依据。
- 每条写路径(含 `alarm`)整体包在 `ctx.blockConcurrencyWhile()` 里完成 读 → 变更 → 写,并发不产生交错;有并发测试证明(§13.11)。
- `version` 是 fencing token:`setState` 每次 +1,并作为 `fencing_token` 写进 decisions 与归档。它现在的作用是**让外部读到的视图可判断新旧**,不再承担"调用方先读后写"的乐观锁义务——串行化已在 DO 内部完成。
- 事件按 task 单调 `seq` 追加、分片(每片 100 条),链内单写者。~~同一 task 并发 `appendEvent` 会读到同一个 prev 从而分叉~~ 已修(0003 加 seq + DO 串行),`GET /api/admin/chain-check` 可持续复核(§13.1)。

### 6.1 一次 RPC 被杀不得损坏权威链(c11)

prod 任务 `5489dc8a` 的故障形状:`appendEvent` 是写穿的 —— `const seq = s.task!.next_seq++` 之后
立刻 `put` 事件分片,而 `task`/`attempts`/`decisions` 只在最后一步 `saveAll` 落盘。一次 RPC 在两步
之间被击杀(`exceededWallTime`,wall=30004ms)⇒ **链已前进、状态陈旧**,而幂等判据读的恰好是那份
没落盘的状态。Workflow 的 3 次重试各从陈旧 `next_seq` 取号,同一批 6 个事件被写 4 份;次生灾害是
重号的链撞 `migrations/0003` 的 `CREATE UNIQUE INDEX idx_events_task_seq` ⇒ 整批归档永久失败。
三处改动把这类损坏变成结构上不可表示:

1. **链与状态同一次原子写**。`appendEvent` 只改内存(链数组 + 当前分片),唯一的落盘出口是
   `private async persist(s)`:一次 `ctx.storage.put({...})` 多键写覆盖 `task` / `attempts` /
   `decisions` / `events:cur` / 本轮新封箱分片 / `events:arc` —— DO 的单次多键 put 是一个存储事务,
   要么全落要么全不落。每条写路径(RPC 与 `alarm`)整体经 `inCriticalSection` 进入,业务体无论正常
   返回还是抛异常,都在 `finally` 里落到同一个出口。**这是本节的硬约束:「链写了、异常路径跳过落盘」
   的组合一旦存在,故障模式就从「多写一份」退化成「静默丢事件」,那是更坏的失效**(理由见下面第 5 条)。
   `saveAll` 已删除 —— 留两套写出口等于留下可被绕过的第二扇门。
2. **取号来自链,不来自计数器**。`seq = lastSeq(events) + 1`(链尾 + 1)。`task.next_seq` 字段与
   归档 schema 都保留,但降级为**对账字段**:`persist` 只做同步镜像,对账放在 `loadAll`(读到的计数器
   vs 读到的链),不相等时以链为准并 `console.warn("seq_reconciled task=… stored=… chain=…")`,一次
   载入最多一条。为什么对账在 `loadAll` 而不在 `appendEvent`:后者每轮都跑,而计数器恰恰是那个不再
   被追加动作推进的字段,拿它当每次追加的前置断言必然在每个追加事件的轮次误报。
   为什么建立在链上:**链是唯一在一次被杀之后仍然前进的结构,凡不可重放的分配器都必须建立在
   已落盘的那一层上。**
3. **终态回报的判重读链(兜底,不是主修)**。`reportExecution` 在 `attempt.state !== "RUNNING"`
   之外加一条:链里已有本 attempt 的 `attempt.exec_finished` / `attempt.blocked`(按 `attempt_id`
   匹配)⇒ 不追加任何事件,落一次状态,返回 `{ ok: true, ignored: true, reason: "already_in_chain" }`。
   **已接受的残留风险(这是取舍,不是遗漏)**:判重命中时状态行的其余字段(`error_tail`、用量台账)
   可能仍是陈旧值 —— 这里刻意不写事件溯源重放器,不从链反推状态机历史。该组合之所以可以接受,是因为
   第 1 条已把它变成**不可达路径**:留这条判据的意义是让「读证据的那一层」也站在权威一侧,
   而不是给状态行补数据。
4. **`waitUntil` 不等于 fire-and-forget 的许可证**。`ctx.waitUntil` 只延长实例寿命,既不参与本轮的
   storage 事务,也不保证跑完(实例被驱逐、进程被杀、异常吞掉都会让它蒸发)。所以它只能承载
   「丢了也无所谓」的副作用 —— 现存的唯一用途是 `destroyAttemptSandbox`(销毁容器,失败留日志,
   平台回收兜底)。任何权威写进 `waitUntil` 都是把第 1 条的原子性从根上游拆掉。
5. **宁可整批归档失败,也不静默丢事件**。归档撞 UNIQUE 索引时整批 `DB.batch` 失败、`archived` 保持
   false、alarm 重试 —— 代价是这个任务在 D1 里查不到,但链本身仍然自洽、chain-check 仍然说得清
   是谁不对。静默丢事件的代价相反:链与归档从此**互相印证一个不存在的历史**,而没有任何信号。
   可检测的失败优于不可检测的"成功"。

体积结论(实测口径,不是估计):DO storage 单键 ≤ 2 MiB、**单值 ≤ 128 KiB(131072 B)**、单次 `put`
的 key+value 合计 ≤ 2 MB。prod 最大的一条已归档链 = 10,210 B / 41 条 / 平均 249 B / 单条最大 397 B
⇒ 一个满分片(`EVENTS_PER_SHARD = 100`)≈ 40 KB,结构开销按 2× 算 ≈ 80 KB < 128 KiB;
`persist` 一次写六个键 ≈ 240 KB ≪ 2 MB。所以分片结构不需要为体积改动。

测试口径(workerd 实测语义,写在这里免得下一个人重新摸索):**一次抛异常的 RPC 会把该轮 storage 写
整体丢弃**,并把该 DO 实例的 input gate 打成 broken(此后每次调用返回同一个错误,且给测试进程留下
一条 `durableObjectReset` unhandled rejection,足以把整个套件染红)。因此「链已前进、状态陈旧」的
半写残骸在 miniflare 里既造不出来也读不到;`test/session-do.test.ts` 的 (a)(b)(c) 钉的是可观测的
那一半 —— 取号连续无重号直到 `idx_events_task_seq` 吃下整批、重放 4 次链只前进一块、异常轮次照样交出
与链自洽的状态。

### 6.2 卡死必须会喊,且不许空转(c11b)

§6.1 把「链与状态互相损坏」变成结构上不可表示的。本节管的是另一半:**归档仍然失败时,
让人看得见,并且不烧白工**。失败仍然会发生且不会被新代码修好 —— `5489dc8a` 那份损坏记录里
seq 4/5 各重号 5 次,归档那一批永远撞 `idx_events_task_seq`,重试多少次都一样。

prod 的现场事实(`durableObjectId=6cf8a28c7c65…` 的 TaskSession alarm):

- tail 实测**每 30.07 秒醒一次**,wallTime 84–132ms,`outcome=ok`,零日志、零异常,从 04:37Z
  起连续空转 100+ 次。原因:`alarm()` 的归档分支是 `try { archive(s) } catch { setAlarm(now + 30_000) }`
  —— 异常被吞,不进链、不打日志,于是「唯一能看见它的地方」恰好是被吞掉的那一处。
- 该分支还在 watchdog 续期与 Supervisor tick **之前** `return` ⇒ 这条 DO 从此只干「空转」这一件事,
  连还在 `RUNNING` 的 attempt 都没人回收。
- 监控也看不见它:`handleChainCheck` 的数据源是 `SELECT DISTINCT task_id FROM events`(只看已归档的
  D1 行),只校验 `prev_digest` 与 `digest` ⇒ 当时返回 `checked=79, broken=0`。

#### 6.2.1 同一个 RPC 里不做分钟级外部工作:销毁时限

`SANDBOX_DESTROY_BUDGET_MS = 5_000`(`src/control/session.ts`)。`destroyAttemptSandbox` 交给
`ctx.waitUntil` 的那个 promise 现在由 `Promise.race` 了结,结果三选一,每种一行可 grep 的日志:
`sandbox_destroy ok` / `sandbox_destroy timeout … budget_ms=5000` / `sandbox_destroy failed … err=`。

**为什么必须有**:DO 的 **RPC 生命周期包含 waitUntil** —— 销毁不返回,终态回报就不返回。prod 实测
一次 destroy 吃 30004ms,直接把 `reportExecution` 推成 `exceededWallTime`,而那正是 §6.1 整条事故链的
触发因。§6.1 第 4 条说「`waitUntil` 不是 fire-and-forget 的许可证」;时限是把它真正变成不等。

**为什么仍然销毁、不删掉**:销毁的理由一分没变 —— r7 prod 实测任务 BLOCKED 后孤儿 qwen 还对
token-plan 持续 POST 烧了 2.5 分钟,而容器内的模型凭据会一直留到容器消失。`sleepAfter` 自动休眠是
分钟级且只停容器 API、不杀内部进程。时限砍的是**等待**,不是动作:超时之后销毁照跑,容器最终由
平台回收;`@cloudflare/sandbox` 的 `destroy()` 不接受取消信号,所以也谈不上中断它。

**为什么是 5 秒**:清理动作不在任何权威路径上,它的价值是「别多烧一分钟 token / 别多留一分钟凭据」,
不是「一定成功」。平台侧正常 destroy 在秒级,5 秒放过绝大多数抖动,同时把终态回报的最坏延迟压进
一次 RPC 的零头(对照:`MAX_WRITER_WALL_MINUTES` 的钳位与 40 分钟量级,见 §12)。

#### 6.2.2 归档阶梯与 `archive_stalled` 的运维含义

归档失败的唯一处置出口是 `onArchiveStalled`,它做两件事:

```
console.error("archive_stalled task=<id> state=<state> attempt=<N> retry_in_ms=<阶梯值> error=<前 200 字符>")
ctx.storage.setAlarm(Date.now() + ARCHIVE_RETRY_LADDER_MS[step])
```

阶梯 `ARCHIVE_RETRY_LADDER_MS = [30s, 2min, 10min, 30min]`,取值理由写在常量的注释里(要点:
30s 保住原口径,因为多数归档失败是 D1 抖动这一类的瞬时失败,第一次重试就该过;30min 封顶与告警
面板的默认刷新同量级)。**封顶不是停表**:最后一档无限重复,因为归档是档案的唯一来源(§6.1 第 5 条
宁可整批失败也不静默丢事件 ⇒ 停滞期间权威链只存在于 DO storage,DO 一旦被淘汰就再无第二次机会)。
头 30 分钟内醒 4 次,而不是 60 次。

**档位在哪儿 = 这件事的全部难度**。`task.archive_retry_step` 是 `TaskRecord` 的字段,由 §6.1 第 1 条
那次原子写(临界区出口的 `persist`)与链同批落盘。放实例属性或局部变量等于没有阶梯:一次 alarm 是
独立的一次请求,实例随时可能被淘汰,内存里的计数器一蒸发,每次醒来都从 30 秒重新开始 —— 就回到
上面那个 100+ 次的形态。测试 `归档停滞可发现性(c11b) (d)` 直接读 storage 里那一行断言档位增长,
就是为钉住这一点(只断言「延时变大」抓不到它:同一 isolate 内实例属性也能长大)。

归档成功即 `archive_retry_step = 0`(阶梯的语义是「连续失败」,不是「历史上失败过几次」)。
alarm 的归档分支**不再提前 `return`**:往下走到 watchdog 对本分支是安全的 —— 能进到这里 task 必是
终态,`nextWatchdogAlarm` 对 terminal 返回 `null`,不会覆盖刚排的阶梯 alarm;换来的是停滞期间仍然
回收过期 attempt、仍然把 `attempt.blocked` 记进链。

**运维口径**:`archive_stalled` 是 error 级、按任务每档一行。看到它就意味着「这条任务的档案只在 DO 里,
D1 里查不到,而且它会一直重试到成功或人工介入」。同一个 task 的 `attempt=` 递增到 4 之后不再变,
那是封顶而不是修好了 —— 要判断有没有好,用 §6.2.3 的对账模式,不要靠日志停没停。

#### 6.2.3 chain-check 现在能证明什么 / 仍不能证明什么

`GET /api/admin/chain-check` 补了三条口径(`src/index.ts:chainBreaks`)。破口标记格式统一为
`<task_id>:<seq>:<kind>`,kind ∈ `prev` / `digest`(原有)、`seq` / `state`(新增)。

**现在能证明**(仅针对 D1 里已有的行):

- `:prev` / `:digest` —— 逐条重算,内容与前后继没被改过、没被替换。
- `:seq` —— seq **严格递增且唯一**(重号 5 次登记 1 条破口,不去重的话一个任务就能把 20 条的
  `brokenTasks` 上限占满)。`§6.1` 那个次生灾害的形状正是重号,原来只有 D1 的 UNIQUE 索引会撞、
  而 chain-check 看不出。
- `:state` —— 任务在 `tasks` 表里已是**汇点状态**(DONE/REJECTED/BLOCKED,判据取自状态机转换表,
  不留第二份清单),而链上最后一条可判定的 `task.transition` 的 `to` 不是它。抓的是「状态行被改写、
  链没跟上」这一类两侧不一致。

**仍然不能证明**(必须连着看,否则会把「没报」读成「没问题」):

1. **看不见未归档的任务。** 数据源仍是 `SELECT DISTINCT task_id FROM events`,而 events 只在归档
   成功时写。`5489dc8a` 从头到尾对它不可见 —— 这也是当年 `checked=79, broken=0` 的全部原因。
   **唯一出口有两条**:`?task_id=` 对账模式(下面),和 `archive_stalled` / `archive_rejected` 日志
   (§6.2.4)。补盲之后前者已经覆盖这条损伤:它不再需要靠容器日志考古才能发现。
2. 看不见 **seq 空洞**(只判严格递增唯一,不判连续)—— 少一行且恰好不打断前后继时不报。
3. `:state` 在链里一条 `to` 都解析不出来时**主动不判**(历史行/非当前写路径的产物)。假阳性的代价是
   淹没真信号,所以这里宁可留盲区并在本节写明。
4. 不判断归档内容的**外部真实性**(补丁是否真能应用、transcript 是否属实)—— 它只证明这份档案
   内部自洽、没被事后改动。权威仍是 §9 的证据 digest。

**`?task_id=` 对账模式**(DO↔D1,同时读两边)。旧实现**静默忽略**这个参数、返回与全局检查逐字节
相同的 200 —— 问它「这条任务对不对」,它答「全体扫了一遍没问题」,那是答非所问,比报错更坏。现在:

| result | 判据 | 运维含义 |
|---|---|---|
| `consistent` | 行数相等 **且** 链尾 digest 相等 | 档案与权威链对上 |
| `not_archived` | DO 有链、D1 零行 | 就是 `5489dc8a` 的形态:去查 `archive_stalled`,别当成干净任务 |
| `diverged` | 行数不等,或等长而尾 digest 不等 | 归档被改动/漏写,按 `brokenTasks` 逐条看 |

DO 里没有这个任务 ⇒ `404 task_not_found`(三态说的是「两份记录的关系」,一份都没有时不猜结论);
`task_id` 畸形 ⇒ `400 invalid_task_id`(与 `/api/admin/events` 同一条 `[0-9a-f-]{36}` 口径)。
响应额外带 `do_events`/`d1_events`/`do_tail_digest`/`d1_tail_digest` 与同一套 `brokenTasks`,
这样「差在哪」不需要再连一次库去猜。

**对账模式的 `broken`/`brokenTasks` 覆盖两侧**(c11b 补盲)。D1 侧沿用 `chainBreaks` 的四类判据,
一行未改;DO 侧对**全量事件**做一次重号计数,复用同一种 `:seq` 标记。为什么必须有 DO 这一半:
`not_archived` 的任务在 D1 里零行,只查 D1 等于替它宣布「损伤不存在」,而 `5489dc8a` 的损伤恰好
全程只存在于 DO 快照里(它一次都没进过 D1)。DO 侧**只扫重号、不走链** —— 分叉的孤儿分支不在 tail
链上,按 `prev_digest` 校验全量事件会满屏误报(判据 3 里那种「假阳性淹没真信号」在这里更严重)。
判据与归档面共用同一个 `duplicateSeqs`,不留两份口径。

#### 6.2.4 `archive_rejected`:把确定性死亡变成有名字的失效形状

失效形状:**快照自身带重复 seq**(pre-c11a 并发追加的分叉被 DO 快照冻结,§13.1)。`events` 表有
`UNIQUE(task_id, seq)`(migrations/0003),而归档是 DELETE-then-INSERT —— 旧行被清掉之后,**同一批内
第 2 条相同 `(task_id, seq)` 的 INSERT 自己撞自己**。所以这不是「重试从头重插所以撞约束」(那个早期
猜测不成立:四张表全是 DELETE-then-INSERT,归档路径本身是幂等的),而是这份快照**在任何时刻都不可
归档**:第 N 次重试与第 1 次的报错逐字节相同。这是确定性死亡,不是暂态故障。

现在的处置是**构批之前拒收**(`src/control/session.ts:archive()`):

```
console.error("archive_rejected task=<id> state=<state> reason=duplicate_seq duplicate_seqs=<升序去重的前 20 个> duplicate_seq_count=<N> events=<链长> d1_batch_constructed=false …")
throw ArchiveRejectedSnapshot
```

日志判读:三个 token 各管一件事。`archive_rejected` = 失效有名字,且 `reason=duplicate_seq` 直接
给出机理与 `duplicate_seqs=` 清单(不必再反查 SQLITE 报错说的是哪张表);`d1_batch_constructed=false`
= 这一轮 D1 一个请求都没打(原先每 30 分钟白写一整批四表);而同一轮的 `archive_stalled` **照旧喊**,
只是它的 `error=` 从 `UNIQUE constraint failed: events.task_id, events.seq` 换成了这句有名字的拒收 ——
既有告警口径不必改,而两类原因的 grep 面从此分开。

**为什么不去重**:`INSERT OR REPLACE` / `ON CONFLICT` 静默去重是**伪造审计记录**。分叉链里「哪一条才是
真发生过的」没有任何代码可以判定 —— 那几份复制品的 `prev_digest` 各不相同,每一条都自证为真。选一条
写入 = 由归档层替审计决定历史上发生过什么,而归档层是读模型,不是权威(§3)。宁可这份档案缺席,
也不许它说谎。

**幂等处置选的是规格里的方案 (b)**:阶梯维持现状,拒收日志与暂态 D1 故障日志分级 ——
`archive_rejected`(机理具名)与 `archive_stalled`(仍在爬坡)各说一件事。规格那两个方案的轴是
**阶梯动不动**(a = 终止该任务的重试),而「判据放在 `archive()` 构批之前、而不是各调用方各查一遍」
是另一条独立的轴:归档有三个入口(终态 RPC 的 `archiveWithRetry`、alarm 的停滞重试、alarm 里
watchdog 打成 BLOCKED 之后的归档),写在写口本身才能保证哪一个入口都不白打 D1 —— 它省下 D1 往返,
**不改变阶梯的形状**。所以本节的阶梯原样保留:`ARCHIVE_RETRY_LADDER_MS` 数值一行未动
(`archive_retry_step` 也照旧累加),没有为拒收发明新的任务状态机状态。**为什么保留**:终态任务的
`nextWatchdogAlarm` 返回 `null`,所以停滞 alarm 是这条 DO
唯一还剩的观察者,而 Supervisor tick 就寄生在同一个 alarm 里(§9.8)—— 停掉它等于把一条仍然持有权威链
的 DO 永久静音,比每分钟多看一行日志危险得多;而 30 分钟一次的内存扫描成本可以忽略,换来的是操作员
真去修快照时不必重新部署就能被捡起。换句话说:拒收省下的是**白打的 D1 批写与误导性的报错文本**,
不是阶梯本身 —— 阶梯的语义(「连续失败」)在这里仍然成立。

**这类任务不会自愈**。看到 `archive_rejected` 意味着「它在等人工处置」,选项与各自的代价见 §13.1 的
open options;本棒不实现任何一种。

---

## 7. 执行面 — Workflow + Sandbox + Extract

### 7.1 `AttemptWorkflow.run` (src/exec/workflow.ts)

Durable Workflow 把一次 attempt 切成若干独立幂等 step,崩溃后从最近完成的 step 重放。权威状态全部在 TaskSession DO,workflow **不做任何状态转换**,只负责:执行 → 提取 → 证据落 R2 → 经 REPORT_QUEUE 异步回报(writer 额外等待审批事件):

| Step | 作用 | 写入 |
|---|---|---|
| **exec** | 按 role 分支:writer 启 sandbox 跑 qwen-code(重试 2 次指数退避,prompt 由 `composeAttemptPrompt` 组装——返工轮额外携带上一轮的修复指令),repo 任务成功后导出候选 patch;verifier 走 `runVerifyAttempt`(独立沙箱重放冻结 patch + 跑 verify_command,**不跑 LLM**);reviewer 直接调百炼 chat/completions(纯 LLM,无工具,`max_tokens=1200`) | artifacts(R2), 不写状态 |
| **extract** | **自己从 R2 读回 transcript**(`ARTIFACTS.get(ref.key).text()`):writer 解析 JSONL 取结果与 tokens;verifier 的 transcript 即结构化验证报告,直接透传(tokens=0);reviewer 对单行 JSON 裁决解析,失败则 `decision:"none"` | —(值传给 report step) |
| **evidence** | 拼装 manifest(artifact refs:transcript + stderr + verify + **patch**),写 R2 | manifests/ |
| **report** | 发 `exec-report` 到 REPORT_QUEUE(重试 2 次);consumer 经 session_id 精确路由 DO 的 reportExecution,DO 侧幂等;writer/verifier 额外带 `patch_digest`(无进展熔断用);`result_text` 覆盖 writer 与 verifier(验证摘要可查) | events(DO 侧) |
| **human-approval** | writer 专用:`waitForEvent(type="approval")` 最长 24h,接受 DO notifyWriter 转发的 agent/human 审批事件 | — |
| **report-blocked** | 异常兜底:发 `exit_code=-1` 的 exec-report;writer → task BLOCKED,verifier → 按验证失败进 rework 闭环 | events(DO 侧) |

**步骤返回值必须瘦身**(M7):Workflows 单个 step 的持久化返回值上限 1MiB,而 writer transcript 常常超过它。`ExecOutcome` 因此只带 `ArtifactRef`(`slim()` 剥掉原文),正文由 extract step 自己按 key 从 R2 取。reviewer 的正文是模型回答本身(`max_tokens` 封顶),保留原样。

**回报链路**:workflow/queue consumer 环境里的 DO namespace 与 fetch 环境不一致(见 §13.8),RPC 不能靠 `idFromName`;AttemptParams 携带 `session_id`(TaskSession DO 实例 id,全局唯一),consumer 用 `idFromString(session_id)` 精确路由。DO 决策后 `notifyWriter` 用 `ATTEMPT_WORKFLOW.get(workflow_instance_id)` 发 approval event 唤醒 writer workflow(实例 id = writer attempt_id,DO 侧已存)。

### 7.2 Sandbox 启动 (src/exec/sandbox.ts)

`@cloudflare/sandbox` 的 `getSandbox(env.Sandbox, attemptId)` 按 attemptId 取一个一次性容器。流程:

1. (repo 任务)`gitCheckout(repoUrl, depth=1)` 到 `/workspace/repo`,再由 `pinWorkspace()`(`src/exec/base.ts`)**把工作副本材质化到冻结基线**:先解析默认分支 HEAD;任务已有基线则 `fetch --depth=1 origin '<sha>'` → 逐级 `--deepen=10/100/1000` → `checkout --detach` → 断言 `rev-parse HEAD` 等于该 sha。刻意不用 `gitCheckout({branch: <sha>})`:SDK 只把 `branch` 原样透传给容器 HTTP 接口,SHA 是否被当 ref 处理没有文档承诺,而基线是本轮权威事实,必须由自己拥有的脚本保证(该脚本已在 bash / dash 两个 shell 下实测)。
2. **材质化失败即止**:直接返回 `exit_code=21/22/23` 加一条说明性 transcript,**不启动模型、不注入任何凭据**。失败原因可能是不可信 repo_url 根本连不上,起沙箱不等于把自己的 key 递过去。
3. `setEnvVars` — 注入 `OPENAI_BASE_URL = MODEL_UPSTREAM_BASE`、`OPENAI_API_KEY = SANDBOX_MODEL_API_KEY`(**沙箱专用低权 key**,§13.14)、`OPENAI_MODEL`,qwen-code 直连百炼。该 secret 未配置时回落到 `DASHSCOPE_API_KEY` 并打一条 `credential_fallback` 告警——降权是配置层增强,刻意不阻塞基线冻结与候选交付这两个主交付物。
4. 写 `/workspace/task.txt` = prompt(镜像由 `sandbox/Dockerfile` 预装 qwen-code,不再现场 `npm install`;缺二进制即 `exit 127` 直接失败并落证据,不做兜底 shim)。repo 任务的 prompt 前置【基线约束】:工作副本已 detach 到 `<sha>`,禁止 `git fetch/pull/switch/checkout` 与改写历史 —— 不写清这一点,writer 会自作主张「同步到最新」,把候选做进另一个世界。
5. `exec` 跑 `qwen -p "$(cat task.txt)" --output-format stream-json --auth-type openai --yolo --max-session-turns 12 --max-wall-time 5m`
6. 软失败检测:qwen 在 API 错误时仍 exit=0,但最后一条 `type=result` 的 `result` 字段**整个就是**那条错误(`[API Error: ...]` 包壳或裸机器码)。裁决交给 `src/exec/cli-exit.ts` 的纯函数,命中即上翻 exit_code=11 —— 判据是**整串**而非**包含**,动机见 §7.2.3
7. transcript / stderr 写 R2(内容寻址);**成功或预算到期**且为 repo 任务时导出工作树差量(到期那一支的产物自称不完整,见 §7.2.1)—— **断言式**:`cat-file -e` 确认基线对象在 → `git add -A` → `git diff '<base_sha>' --binary`,正常路径任一步非零即 `exit 23` 且**不产出半成品补丁**(宁可失败,也不交出一张不知道对谁有效的补丁)
8. 返回 `{ exitCode, transcript, stderr, patch, base }`,`base = { sha, source }` 随证据链上翻到控制面
9. **验证语义不在此执行**:`verify_command` 由独立 verifier 在另一沙箱**同一基线**上重放(见 §13.10);非 repo 任务无验证

**软失败检测的意义**:qwen-code 把 API 错误嵌入 stream-json 的 result 事件而不是反映在退出码,如果不识别会把"401/限流"当成"任务成功"。但这个检测**本身也是一台误判机器**:它改写退出码,而退出码决定 §7.2.1 那张表里差量导不导 —— 判错的代价不是「多一个失败任务」,而是丢掉一份已完成的工作。判据的形状因此单独成节(§7.2.3),而不是留在 `collectQwenAttempt` 的一个内联正则里。

### 7.2.1 预算到期时的产物语义(exit 55 / 53)

**墙钟到期不等于工作全部归零。** `--max-wall-time` / `--max-session-turns` 是 qwen 自己下发的退出码(`EXIT_BUDGET_ABORT=55` / `EXIT_SESSION_TURNS_LIMIT=53`,定义在 `src/routing/classify.ts`),进程停下的那一刻**容器还活着** —— 销毁发生在 attempt 终态时(DO 的 `reportExecution` → `destroyAttemptSandbox`),而 collect 相排在它之前。所以那份跑了几十分钟的工作树差量一直就地可取,此前只是没人去取。

要治的病(prod 标本 `5489dc8a`、`dbcc8fc0`,两次同形):writer 干净做完或做到一半 → 墙钟到期以 exit 55 收场 → 导出分支的条件是 `exitCode === 0`,**补丁从未被导出** → BLOCKED 那头的人拿到的信息量只有一个退出码,两次各白烧 ≈25 万 token。

`collectQwenAttempt` 的导出条件因此从「仅 `exitCode === 0`」放宽为「`exitCode === 0` **或**预算类退出码」。四条边界,一条不乱:

| 情形 | 处置 |
|---|---|
| exit 55/53 + 工作树有差量 | 导出,并**自称不完整**:manifest 落 `patch_complete: false` + `patch_incomplete_reason: "budget_abort(exit=55)"` |
| exit 55/53 + `git diff` 为零(被杀在只读阶段) | **不产出候选**(零差量是事实,不是一份空补丁),留一行可 grep 的 `budget_abort_no_diff` |
| exit 55/53 + 补丁超 `MAX_PATCH_BYTES` | 不产候选,留 `budget_abort_patch_export_failed` 日志。**上限不绕开**;也**不把 55 改写成 24** —— 换码会让同一次死亡从 `route_decision(budget_abort)` 改轨到 `base.failed`,而路由语义不变是这一棒的前提 |
| 非预算类失败(exit 1、API 错误上翻的 11、容量事实的 -1) | 一律不导:那种时刻的工作树状态不可知,导出来的是猜测,不是证据 |

`exitCode === 0` 那一支的字节行为一字未改 —— 包括零差量时仍产出空补丁(那是 writer 自认「无需改动」,与「被杀时还没写文件」是两件事,所以那一侧不做判空)。

**为什么必须带标记**:一份 40 分钟的在途 diff 与一份自认完成的候选,如果在读端长得一模一样,人就会把前者当后者用。标记沿 `manifest → /candidate → 验证报告` 传递,判读口径统一为 **present ⇔ incomplete**(字段只在不完整时写入,缺省即完整 —— 这样历史 manifest 与新生成的在字节上同构,也不会给每次成功都加一个恒真字段去改 manifest digest):

- `GET /api/tasks/:id/candidate`:视图新增 `patch_complete` / `patch_incomplete_reason`,`warnings` 点名「这是 writer 预算到期那一刻的在途差量,不是它自认完成的候选」,`safe_to_apply` 恒 `false`(即使后来被独立验证或被人工批准 —— 验证结论只对它自己的输入成立,而这份输入的完整性由执行面否定);
- `GET /api/tasks/:id/candidate?format=patch`:响应多一个 `x-patch-complete` 头,`curl -OJ` 的人不看 body 也知道拿到的是什么;
- verifier 的结构化报告在**被验 manifest 自报不完整时**带 `writer_patch_incomplete`(正常候选的报告字节不变):一个绿了的 apply+verify 不能把在途差量洗成合格候选。

**BLOCKED 不再是零信息 —— 以及这一棒的边界**。exit 55 仍按 M9.5②(§13.21)分类为 `budget_abort` 并 BLOCKED 转人工:本棒**不**升格差量为正常候选、**不**新增自动返工、**不**改 `current_evidence` 的钉住规则。不改的理由:覆盖前一轮成功候选的指针是净损失信息,还会让审批的 `binding_digest` 中途换轨 —— 那是路由/审批语义的改动,不属于「只多导出一步」这一棒。

> §7.2.1 的历史边界(c12 交付时的self-限制):人在 BLOCKED 这头取差量走事件链(失败回报同样落 `evidence.manifest` 事件,指针从来就在链上)。**这一条已被 §7.2.2 的 `GET /api/tasks/:id/rescue` 取代为常规路径**,下面的手工路线保留为端点不可用时的兜底取证法:
>
> ```
> GET /api/tasks/<id>            → events 里该 attempt 的 evidence.manifest 事件 → manifest_key
>    (已归档任务改读 GET /api/admin/events?task_id=<id> 的 canonical 原文)
> cloud-agent-evidence/<manifest_key>     → patch.key + patch_complete + patch_incomplete_reason
> cloud-agent-artifacts/<patch.key>       → 击杀那一刻的差量正文(git apply 前先自己看一遍)
> ```

> 为什么差量从事件链取而不是直接出现在 `/candidate`:`/candidate` 是 `current_evidence` 的投影,而 M7 的失败门禁规定 writer 失败产物不进审批流、不钉证据。读端对 `patch_complete` 的处理已经就位(视图、下载头、验证报告三处),将来若决定把被击杀的差量也钉成候选,这一棒不必再动执行面。

#### 7.2.2 抢救读面 `GET /api/tasks/:id/rescue`(c13)

c12 只走通了执行面那一半:差量导出来了、自称不完整了,但它躺在 R2 里,**人在 BLOCKED 任务上仍然取不到** —— 因为 `session.ts` 的 writer 终态处理里 `if (await this.routeFailure(...)) return;` 排在 `pinWriterEvidence(...)` 之前(M7 失败门禁),被击杀那一轮从不钉证据,于是 `/candidate` 对 BLOCKED 恒 404 `no_candidate_yet`,而 `patch_complete` 那批字段在 BLOCKED 路径上**没有读者**。prod 实测同形:`dbcc8fc0` / `5489dc8a` 取候选都是 404。

修法是**新增读面,不是放宽审批通道**。三条边界:

| 边界 | 落实 |
| --- | --- |
| `current_evidence` 仍是唯一证据口径 | `getRescueRefs()` **只读不写** DO 状态;`/rescue` 读完后 `task.current_evidence` 仍为 `null`,`/candidate` 与 `/evidence` 仍各自 404 |
| `binding_digest` 语义不变 | 组成仍是钉住的 `[writer, verifier?, 裁决者?]`;rescue 视图刻意返回 `binding_digest: null` —— 没有钉住就没有可核对的绑定,给一个按空组成算出的 digest 等于造假日 |
| verified/approved 门禁不变 | `assembleRescueView` 强制 `safe_to_apply: false`,并固定 `rescued: true` / `pinned: false` + 首条告警说明「不是可交付候选」。视图的开放条件是 `state === "BLOCKED"`(否则 404 `not_blocked`),抢救对象判据是「最近一个非成功终态且回报过 manifest 的 writer attempt」—— 与钉住的证据天然互斥 |

`patch_complete` 的判读口径与 `/candidate` 完全一致(present ⇔ incomplete),文案复用 `assembleCandidate`,两个读面共用同一套诚实性判据。下载走 `?format=patch`,同样逐字节重算 sha256,不一致 → 500 `integrity_error`;响应头在 `/candidate` 那套之外多 `x-rescued: true` / `x-pinned: false`。

**为什么不是「把 `current_evidence` 提前 pin 上」**:那会让一份 writer 被击杀时的半成品进入审批绑定 —— 人一旦 approve,绑定的就是那份从未经独立验证的在途差量,而 `binding_digest` 无法表达这个差别。那比「取不到」更坏的失效形状。

> **落地端同批补的门**:`scripts/land-gate.mjs` 的 candidate 门现在读 `evidence.manifest.patch_complete`,显式 `false` 即 `digest_ok=false` → 退出码 2,且在取补丁本体**之前**就拒,`fetchPatch`/git 一次都不碰。理由:落地是唯一不可逆的动作,而「不完整」这句话此前只存在于读端展示,消费方漏看头就能把在途差量 commit 进 main。

取证日志三条,都带退出码,可 grep:`budget_abort_no_diff`(到期且无差量)、`budget_abort_patch_export_failed`(到期且导出失败/超限)、`patch too large:`(容器内预检的超限原文,§13.17 那条上限的既有出口)。

### 7.2.2 预算的诚实性:一个请求值,三个时钟(c14b)

`budget.max_wall_seconds` 是**用户契约**,writer 真正拿到的墙钟是**平台事实**,这是两个数。此前系统在三处各写一份缺省(`src/index.ts` 的入口、`deriveWriterBudget`、`qwenDeadlineSeconds` 里各自的 `?? Number(... ?? "3600")`),入参零校验,夹钳发生时也不留痕 —— 于是「任务记录说 3600s、writer 实际只跑 25 分钟」这件事只能靠读代码复原。现在收成一个权威:`src/control/budget.ts` 的 `resolveBudget(maxWallSeconds, env)`,一次解析返回 `budgetSeconds / wallMinutes / ceilingMinutes / maxSessionTurns / deadlineSeconds / clamp`,`deriveWriterBudget` 与 `qwenDeadlineSeconds` 降为取数的薄封装(执行面投影与 `qwenCommand` 拼命令行时不再自己算一遍 min/max)。

**三个时钟的相对关系**(`test/budget.test.ts` 逐条钉住):

| 时钟 | 值 | 由谁排 | 意义 |
| --- | --- | --- | --- |
| qwen 墙钟 | `min(ceiling, max(1, floor((预算 - 120)/60)))` 分钟 | 容器内 `--max-wall-time` | writer 能力 |
| poll 到期线 | `max(60, min(墙钟×60 + 180, 预算 - 60))` 秒 | workflow 的轮询循环 | 兜「qwen 自己都没能退出」的悬挂 |
| DO alarm | `claim + 预算 + 300s`(`attemptDeadline`) | TaskSession alarm | 用户契约的兜底击杀 |

顺序恒定:**qwen 墙钟 ≤ poll 到期 < DO alarm**。到期线里「预算 - 60」这一支就是它存在的全部意义 —— 赶在 alarm 之前给出带证据的回报(Fix C,§13.19),而 120s 导出余量保证那份回报带得上产物。

**设计取向:夹钳只降 writer 能力,不改用户契约。** `MAX_WRITER_WALL_MINUTES`(缺配/非法回落 `MAX_SAFE_WALL_MINUTES = 25`,即 §13.18 那堵 workerd ~29:48 挂起墙)把 3600s 预算的 writer 削到 25 分钟时,DO alarm 仍按 `3600s + 宽限` 排。把 alarm 也一起提前看似「口径统一」,实际是悄悄把用户契约改小 —— 那是另一种不诚实。

**留痕:权威链里多一条 `budget.clamped`**(`startAttemptInternal` 只对 writer 判,平台上限约束的是单条 await 中的沙箱命令)。payload 与 c10b 心跳同一卫生纪律 —— 只有标识符、数值与枚举,没有自由文本通道:

```json
{"attempt_id":"…","requested_seconds":3600,"writer_wall_minutes":25,"ceiling_minutes":25,"clamp_reason":"writer_wall_ceiling"}
```

`clamp_reason` ∈ `BUDGET_CLAMP_REASONS` = `writer_wall_ceiling`(撞上限被削平)/ `minimum_wall`(预算扣完 120s 导出余量后不足 1 分钟,被下限**抬**到 1 分钟 —— 方向相反的偏差同样要报)。未夹钳**不写事件**,而不是写一条「本无事」的噪声:`budgetClampPayload` 直接返回 `null` 来表达这件事,所以 `grep budget.clamped` 的命中集合恰好就是「被夹过的那批 attempt」。

**入口 fail-closed**:`POST /api/tasks` 校验 `budget.max_wall_seconds` 的形状 —— 必须是 JSON 正整数;负数 / 0 / 小数 / 字符串 / NaN / Infinity 一律 `400 invalid_budget` 并带原因,**不建任务、不起 attempt**(非法值过去能落进 `TaskRecord`,于是 `attemptDeadline` 排出一个过去的 alarm,而沙箱侧的 `max(1, …)` 又把它掩盖成「1 分钟预算」)。这与配置侧的纪律刻意不对称:环境变量缺配 → 静默回落;给了非法值 → 回落 + `budget_default_invalid` 告警留痕(旧行为是 `Number("abc") = NaN` 一路流到命令行,变成 `--max-wall-time NaNm`)。理由是**请求方拿得到 400 并改正,配置方拿不到**;而对非法请求值做静默修正,产出的是与请求不符且无人报告的静默行为。

> 时间账口径示例:`max_wall_seconds = 1800` 在 `MAX_WRITER_WALL_MINUTES=40`(prod)下 → 有效墙钟 **28 分钟**(扣掉 120s 导出预算),不夹钳、无事件;同一预算在无覆盖值的环境里 → **25 分钟**,链上必有一条 `budget.clamped`。历史形状注一句以免误读:§7.2 第 5 步里的 `--max-session-turns 12 --max-wall-time 5m` 是 Fix C 之前的字面量,那两个数现在由 `resolveBudget` 推导。

### 7.2.3 CLI 退出码裁决:整串 vs 包含(c16)

qwen-code 的 API 错误不反映在退出码上,而以末条 `type=result` 事件的 `result` 文本形态出现(§7.2 第 6 步)。识别这件事曾经写在 `collectQwenAttempt` 的一个内联正则里:`/\[API Error:|upstream_error|model_not_found/` —— **在文本里找到**就把 exit 0 上翻为 11。这个「包含即失败」的假设在 c15 被打穿,而且是以最体面的方式打的:

writer 那三次都成功收尾(`is_error=false`),而任务规格**要求**它在总结里讨论这些错误形状 —— 于是被讨论的字样必然出现在成功文本里。三次俱毁的链路是:字样出现 → 0 改写成 11 → 11 不属于 §7.2.1 那张表里「可就地取回差量」的退出码集合 → 补丁导出整支跳过 → 已完成的工作按失败作废。

**病灶不是词表,是匹配位置。** 这条判据的输入是**散文**,而散文的天性就是引用它所讨论的一切;把「字样出现过」读成「错误发生过」,等于让任务的措辞决定任务的成败 —— 一个规格写得越要求解释错误处理的任务,越必然被判为失败。

因此判据搬进 `src/exec/cli-exit.ts` 的纯函数 `adjudicateCliExit({ nativeExit, isError, resultText })`。**词一个没删**(c10b 认的那些形状全部保留),收紧的是位置:`resultText` 去首尾空白后必须**整串**是一条错误。裁决顺序:

| 序 | 输入 | 结果 | 为什么排在这里 |
|---|---|---|---|
| 1 | `nativeExit === null` | `-1`(`EXIT_UNKNOWN_NATIVE`) | 终态不可知时不做任何文本判读:进程可能死在写一半的时刻,那一刻的 result 文本说明不了成败 |
| 2 | `nativeExit !== 0` | **原样返回** | 进程自己喊了失败,平台既不改判成功,也不改写它的码 —— 预算类的 55/53 尤其要原封,否则同一次死亡从 `route_decision(budget_abort)` 改轨到别处 |
| 3 | `isError === true` | `11`(`EXIT_CLI_API_ERROR`) | CLI 自认失败,不必再看文本 |
| 4 | `resultText` **整串**命中错误形状 | `11` | 见下两条形状;这一步与 `isError` 在场与否、是真是假**无关** |
| 5 | 其余 | `0` | 成功文本里**引用**错误形状是 writer 的正当工作 |

第 4 步认的两类整串形状:

- **方括号包壳**:`^\[API Error:[^\]]*\]$` —— 方括号开头、内部不再出现 `]`、整串到 `]` 结束;
- **裸机器码**:整串就是一个 token —— `AccessDenied.` 家族(子码不固定,故按前缀认)或 `model_not_found` / `upstream_error` / `insufficient_quota` 之一。**要求整串不含空白**,是因为「裸」才是机器码的形状:`AccessDenied. 后面接的是人写的散文` 不是错误本身。

**为什么 `isError === false` 不给免疫**:c10b 那批真失败的标本形状就是 `exit 0` + CLI 没置 `is_error` + result 整串是错误。让 `false` 免疫等于把这批真失败重新放成成功 —— 那是拿一个已知缺陷换一个未知缺陷。`isError` 缺失时同样走第 4 步。

**精度换召回,是刻意的**。漏判的方向(带上下文的错误文本落回 0)代价是「一次失败被当成成功」:差量照常导出,而那份候选会撞独立验证(§13.10)与 reviewer 的证据契约,有下游兜住。误判的方向代价是**销毁一份已完成的工作**,不可逆,而且下游永远不知道它存在过。两者不对称,所以判据偏向「宁可漏判形状,不可误判散文」。若将来真攒出「带上下文的失败」标本,加法是**再补一条整串形状**(或改读 `subtype` / `stop_reason` 这类枚举字段),不是回到子串。

**一字未动的部分**:末行不是 JSON 或不是 result 事件 → 忽略(与旧行为同);补丁导出的条件、`exitCode === 0` 那支的字节行为、预算类(55/53)差量自称不完整那一整支,全部原样;11 这个数字及其「非预算类失败」的路由归属也没动 —— 本棒改的是**什么时候**产出 11,不是产出之后走哪条路。

**为什么单独成文件**:纯函数才能整表穷举(裁决不必为一次判读起一个容器),也才能被将来的外圈(§9.8 Supervisor、重放工具)共用同一口径,而不是让第二份判据在调用点长出来。`collectQwenAttempt` 侧只剩「取末条 result 事件 + 喂三个事实」,接线与判据分开。

**测试**:`test/cli-exit.test.ts` 双向钉 —— 同一批形状,整串必须 11、嵌进散文必须 0,逐形状成对出现;并走真实入口 `collectQwenAttempt` 钉住两件:c15 标本(`exit 0` + 讨论错误形状的成功总结)必须仍是 0 **且差量照常导出**,c10b 标本必须仍是 11 且不导。值得记一笔的背景:内联正则时代**没有任何测试钉过这条判据**,所以同一个形状错了三次。

### 7.3 答案提取与记账 (src/exec/extract.ts)

`extractResultFromTranscript(transcript: string): string | null`

- 主路径:取最后一条 `type === "result"` 事件的 `result` 字段
- 退化:拼接所有 `type === "assistant"` 事件里的 `content[].type === "text"` 块
- 都拿不到返回 null,workflow 会照样推进(result_text 只是空),不会阻断 attempt

`accumulateUsageFromTranscript(transcript: string): AttemptUsageLedger` —— **用量提取的唯一路径**

- **逐事件累加**:遍历该 attempt 的全部 `type === "assistant"` 事件,把每次调用的 `usage` 按字段相加(input / cache_read / output / total)。`total_tokens` 缺失时由 `input + output` 推出(上游恒等式,不是猜)。
- **完成态与被杀态走同一条路径**。旧实现是「有 result 用 result、没 result 取有效 total 最大的一条 assistant」—— 被墙钟击杀的任务没有 result,于是记成单次调用的量级(r2 实测 input 漏 48.4×、加权漏 54.5×,见 §13.22)。**「最后一次调用」不是合法回落**:它与「会话累计量」是两个不同的量,补过去的误差由「还剩多少调用没被读到」决定,也就是由被杀位置决定。
- **`type === "result"` 只做对账基准,绝不参与累加**(它已经是累计值,加进去就是双计)。完成态若累加值 ≠ result 累计值 → 抛 `TranscriptLedgerMismatchError`,消息里给出两侧数值、逐字段差值与差异来源候选(不带 usage 的 assistant 条数、部分调用漏报的字段、多条 result、未知类型带 usage 的事件)。**两个候选值都不取**:格式正常时这两个量本该相等,不等说明我们对 transcript 的理解错了(重复/缺失的 usage 事件),取任一侧都是编一个来源不明的数。
- 字段只在**每次调用都上报**时才进累加结果;部分上报的字段整体留空(部分和是伪装成总量的欠计)。一个 usage 事件都没有 → `usage: null`(=「未记录」,与 0 严格区分)。
- 产出 `AttemptUsageLedger`:`usage`(累加的四元组)与 `total`(raw total,恒 = `totalFromUsage(usage)`)。**`totalFromUsage()` 是 raw total 的唯一推导处** —— 台账两处消费它(DO 快照 `result.captured.total_tokens`、D1 `attempts.tokens_used`),两处各算一遍就是两套口径(§13.22 第 4 条)。
- 写入链:workflow extract step 调一次,`tokens` 与 `usage` 都从同一个 ledger 上取 → `REPORT_QUEUE` → DO → `attempts`(成本口径另见 `costWeightedFromUsage`,fresh + output + 0.2×cache,口径不变)。

提取结果写回 `tasks.result_text`(`migrations/0002`),由 `GET /api/tasks/:id/result` 以 `text/plain` 直出。

---

## 8. 模型直连与记账(替代早期"模型代理"方案)

### 为什么直连而不是走 Worker 代理

早期版本在 Worker 侧实现了 OpenAI 兼容代理(`/proxy/v1/chat/completions`),沙箱内 agent 用 per-attempt scoped token 回连 Worker,由 Worker 转发百炼并实时记账。**该方案已废弃**,原因:

- 百炼 token-plan key 的许可边界:**只能由 agent 客户端(qwen-code / opencode / pi)直接调用**,不允许作为 API key 经第三方/代理转发,违者封号
- 代理会截获模型流量,但记账与审计完全可以用事后解析 transcript 达成,无需中间人

### 现在的链路

```
qwen-code (沙箱内)
   │  OPENAI_BASE_URL = MODEL_UPSTREAM_BASE (https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1)
   │  OPENAI_API_KEY  = SANDBOX_MODEL_API_KEY (沙箱专用低权 key;缺配则回落 DASHSCOPE_API_KEY 并告警。高权 key 平时只在 Worker 侧给 reviewer)
   ▼
百炼 compatible-mode API ──► 响应进 stream-json stdout ──► transcript 落 R2(审计)
                                                              │
                                                              ▼
                                            extract step: 结果 → tasks.result_text
                                                                 用量 → attempts.tokens_used
```

### 预算语义的变化

| 维度 | 旧(代理) | 新(直连) |
|---|---|---|
| 时长 / turn | 代理无法硬停 | qwen-code `--max-wall-time 5m` / `--max-session-turns 12`,超限非零退出 |
| token 预算 | 代理请求前检查,超限 403 fail-closed | 事后记账;`max_model_tokens` 作为归因与下一轮 attempt 的预算输入 |
| 实时拦截 | 有 | 无(合规优先,接受此权衡) |

### 记账与审计

- **记账**:workflow 的 extract step 调 `accumulateUsageFromTranscript`(逐事件累加,§7.3)→ `recordTokenUsage` → `attempts.tokens_used`;事件 `result.captured` 携带 `total_tokens`(与四元组同源于那次累加)
- **审计**:完整 stream-json transcript(含每次模型调用的请求/响应)内容寻址落 R2,digest 绑进 evidence manifest;原始模型 I/O 可以从 transcript 还原,不再单独存 `model-io/`

---

## 9. 证据链与内容寻址 — `src/audit/evidence.ts`

### 存储布局

| 前缀 | 内容 | 用途 |
|---|---|---|
| `artifacts/sha256/<xx>/<xx>/<digest>` | 沙箱 stdout / stderr / verify 输出 | 两层级前缀避免单目录百万条目 |
| `attempts/<attempt_id>/...` | 同一 attempt 的 transcript/stderr 分组 | 便于按 attempt 清理 |
| `manifests/task/<task_id>/<attempt_id>-<digest16>.json` | 一次 attempt 的证据清单 | 绑定 decision 的 evidence_digest |

> 旧架构的 `model-io/<task_id>/` 已不再写入:模型 I/O 可从 transcript(stream-json 含每次调用的请求/响应)还原。

### Manifest schema

```ts
interface EvidenceManifest {
  schema_version: 2;              // 写入恒为 2;读取方必须容忍 v1(缺 base,按「基线未固定」处理而非报错)
  task_id: string;
  attempt_id: string;
  role: string;                   // writer / reviewer / verifier
  produced_at: string;
  spec_digest: string;            // task.spec 的 SHA-256
  model: string;
  transcript: ArtifactRef;        // qwen 的 stream-json 输出
  artifacts: ArtifactRef[];       // 当前实际只放 stderr
  patch?: ArtifactRef;            // writer 导出的候选变更(repo 任务),供 verifier 重放
  patch_complete?: boolean;       // **只在不完整时写 false**;缺省 = 完整(含本字段引入前的历史 manifest)
  patch_incomplete_reason?: string; // 如 "budget_abort(exit=55)":击杀那一刻的在途差量,见 §7.2.1
  base?: { sha: string; source: "resolved_default" | "pinned" };  // 该候选所基于的精确 commit
  model_calls_digest?: string;    // 预留:整轮 model call 的 Merkle 根
}
```

> **为什么 `patch_complete` 只在不完整时出现**:manifest 的 key 含正文 digest,给每一次成功导出都加一个恒真字段,会让同一份产出在字段引入前后落进不同 key、语义却毫无变化;而缺省对读取方必须是「完整」—— 历史 manifest 全部出自 exit 0 的干净退出,把它判读成不完整是造假。口径统一为 **present ⇔ incomplete**。

> **为什么 `base` 必须在 manifest 里**:没有它,patch 只能对「当时那条默认分支」说话 —— 跨轮 `patch_digest` 比较失去意义,证据也无法自证「基于哪个世界」。`TaskRecord.base` 是任务级权威,manifest 的 `base` 是这份候选自己的血统;两者不一致时(基线在候选产生后变了)交付视图报的是**候选的**基线。
>
> 历史审批绑定不受影响:`compositeEvidenceDigest` / `computeBindingDigest` 组合的是已存的 manifest digest,不是重算的 manifest 内容。

### 审计路径

- **给定一个 decision**:查 `decisions.evidence_digest` → R2 `manifests/.../<digest16>.json` → 拿到 transcript/artifact/verify 的 digest → R2 `artifacts/sha256/...` 取原文
- **验证未被篡改**:重算 SHA-256 对比 manifest 里的 digest;任一字节改动即告警
- **重放一次 attempt**:spec 在 tasks.spec,digest 在 manifest;容器是临时的,换镜像也能重跑同一份 spec

---

## 9.5 Observation 层 —— 在途事件流(非权威)`src/obs/`

一句话:把 Fix C 的 30s 轮询顺手看到的 transcript 增量,变成**任务 RUNNING 期间就读得到**的事件流。它不改任何执行结论,只解决「外圈看不进来」。

### 为什么要单独一层

C2-r6 那次单次模型调用悬挂 24 分钟(§13.19)。当时外圈能拿到的只有:`GET /api/tasks/:id` 的粗粒度 `state: RUNNING`,以及 `/api/admin/events`、`/api/admin/attempts` —— 后两者读的是 D1 **终态归档**,任务没跑完就是空列表。于是「悬挂 24 分钟」与「正常干活 24 分钟」在事件层面完全同形。

**本层的验收基准一句话:同样的悬挂重现,外圈凭事件流 5 分钟内能发现。** 它是下一期无人值守监督(Supervisor)的数据底座 —— 本期只做数据路径,不做判定与分流。

⚠️ 这句基准里的「5 分钟」是 c7 按当时的算法算的(最后一条事件停滞 ⇒ 悬挂),那个算法后来被证明把两个问题当了一个(下面那张表就是它原来的形状),c10b 起**数字与算法一起由 §9.8 接管**;本节保留原句是为了记清这层当初的验收口径,**照它设闹钟会漏**。

### 数据路径(基准对应的每一跳)

```
qwen stream-json ──► /tmp/longrun-stdout(专用 session 的后台进程追加写)
        │
        │  poll-i step(workflow,每 30s 一拍):pollLongRun → ingestTranscript
        ▼
src/obs/ingest.ts ──► 按 index.json 的字节偏移取新增完整行 ──► AgentEventV1(ingress 白名单 + 脱敏)
        │
        │  commitObsRound:段文件先写、index.json 后写(提交点)
        ▼
R2  obs/<task_id>/<attempt_id>/g<generation>-seg<N>.jsonl  +  index.json
        │
        │  GET /api/tasks/:id/events?after=&limit=(直接读 R2,不经 D1)
        ▼
外圈 / 下一期 Supervisor
```

| 时刻 | 发生什么 | 外圈看到什么 |
|---|---|---|
| t=0 | 模型调用挂住,qwen 不再往 stdout 写任何字节 | — |
| t≤30s | `poll-i` 读到 0 条新增完整行 → 转录无新事件,但**仍落一条 `kind=heartbeat`**(c10b;不传 `snapshot` 的历史调用方才是「不落任何写」) | 尾部只增长心跳 |
| t=30s..N | 每拍如此:进程 `status=running`,心跳的 `gap_ms` ≈ 实测轮次 | 行为事件数恒定,心跳恒定增长 |
| 任意时刻 | `GET /api/tasks/:id/events` | **两个数分开看**:最后一条**行为**事件的 ts 距今单调增大(= 模型静默),最后一条**心跳**的 ts 距今 ≈ 一拍(= runner 活着) |

这里要问的是**两个**问题而不是一个:「模型还在产字吗」看最后一条行为事件的 ts,「runner 还活着吗」看最后一条心跳的 ts —— 只有一条时间源时这两个问题同形,而这正是 §9.5 本节旧算式与 §9.7 Live UI 旧阈值的判据答错的地方。c7 那份算式(「> 3 个 30s 周期 + 外圈 60s 拉一次 ⇒ 最坏 150s 出结论」)把两问当一问用,已被 prod 数据证伪并在 §9.8 重标定 —— **阈值数字只在那里推导一次**,本节不复制。摄取与轮询仍发生在同一个 step、同一拍(放置理由见 `src/exec/workflow.ts` 的注释:同一步就是同一轮,快照与本轮新增字节是同一时刻的两面),但「同一拍」不再被当成判据的前提:节奏由每条心跳自带的 `gap_ms` 自描述。

### 事件 schema:`AgentEventV1`

```ts
interface AgentEventV1 {
  v: 1;
  task_id: string;
  attempt_id: string;
  generation: number;   // attempt 内代数:durable 重放复用同一 attempt_id 时用来区分轮次
  seq: number;          // (attempt, generation) 内单调递增,从 1 起
  ts: string;           // ISO8601,**摄取时刻**(不是模型侧时间):外圈要的是「何时能知道」
  kind: ObsEventKind;
  payload: Record<string, unknown>;   // 已过白名单,见下面「脱敏」小节
}
```

| kind | 来源 transcript 行 |
|---|---|
| `system` | `type: "system"`(init 等) |
| `assistant` | `type: "assistant"` 且不含 tool_use 块 |
| `tool_use` | `type: "assistant"` 且含 tool_use 块 —— 语义是「发起了一个工具调用」;悬挂最典型的样子正是「最后一次 tool_use 之后再无事件」 |
| `tool_result` | `type: "user"` 且含 tool_result 块 |
| `user` | `type: "user"` 的其它块 |
| `result` | `type: "result"` 正常收尾 |
| `error` | 任一行 `is_error: true` 或 `subtype` 以 `error` 开头 |
| `raw` | **认不出的行,含非 JSON 行** —— 不丢:`payload.raw_type` 留原 type,`payload.unparseable` 标记非 JSON |

### 段布局与幂等

```
obs/<task_id>/<attempt_id>/g<generation>-seg<N>.jsonl   每段定长 200 条事件(JSONL)
obs/<task_id>/<attempt_id>/index.json                   每 attempt 一份:段清单 + 摄取游标
```

- **段清单**每段记 `{seg, generation, key, first_seq, last_seq, count}`;读端点靠它按序拼接、按 `after` 整段跳过(被跳过的段不下载)。
- **游标**(`offset_bytes` / `max_seq` / `head_len` / `head_digest`)存在 index.json 里,**不存在 workflow 的 step 返回值里**。这是幂等的关键:durable 重放会让同一 attempt 上的 `poll-i` 被多次执行(step 重试、isolate 驱逐后从 checkpoint 续跑),携带式游标在重放下必然滞后 → 重发旧事件。每轮从**已存状态**续读,同一批字节喂第二次就是第二次 0 条。字节偏移只按**完整行**推进:尾部半行留作余量等下一轮拼齐(顺带也躲开了 UTF-8 多字节字符被从中间切断的问题 —— 那只能发生在未终止的最后一行里)。
- **R2 没有 append 原语**:一段在写满前是同一 key 的重写(内容只增不减,已可见事件的字节不变),**写满 200 条即封盘,永不再动**。`index.json` 是提交点:段先写、index 后写;中途崩溃只会让下一轮重写同一批段,既不重号也不留空洞。
- **换代(generation + 1)只在旧字节偏移失去意义时发生**:① transcript 比游标短(`longrun.sh` 的 `>` 重定向在重新启动时就会清零);② 前 4 KiB 前缀指纹变了(文件被换成另一轮执行的输出)。换代即开新段命名空间 `g<新代>-seg1`,seq 从 1 重开,旧代段一个字节都不动。若换代时还没有完整行可写,游标也得单独提交(`commitObsCursor`),否则每轮都会重复判成换代。
- **写入前自洽检查**:`index.max_seq` 必须等于段清单推出来的最后 seq,且新事件第一条的 seq 必须等于 `max_seq + 1`,否则整轮拒写并记 stderr —— 这是「换代不串号」的最后防线:重叠的 seq 区间会让分页静默重放或漏读。

`obs/` 前缀复用现有 `ARTIFACTS` 桶(内容寻址制品桶),**不新增 R2 绑定、不新增 D1 表**。

### 脱敏白名单(在 ingress,不在读端点)

自由文本一旦以明文落进 R2,后面所有读取方与整个保留期都成了泄露面 —— 所以清洗发生在写之前。这里**没有黑名单**:白名单漏一个字段只是少一个观测维度,黑名单漏一个字段就是凭据外流。

| 通道 | 规则 |
|---|---|
| 枚举标量 | 只留白名单内的键:`subtype` / `uuid` / `session_id` / `model` / `stop_reason` / `is_error` / `num_turns` / `duration_ms` / `duration_api_ms` / `total_cost_usd` / `exit_code`,且类型对得上才留 |
| token 用量 | `payload.usage` 只留 `input_tokens` / `cache_read_input_tokens` / `output_tokens` / `total_tokens` 四个**数值**字段(与 §7.3 台账同口径,不重命名) |
| 工具调用(枚举) | 只留 `tool_names`(去重、≤16 条、每条 ≤128 字符);**`input` 整体仍然丢弃** —— `write_file` 的 input 里通常是整个文件内容 |
| 工具调用(形状) | `tool_targets: string[]`,与 `tool_names` **同长度、同顺序**(第 i 条 = 第 i 个 tool_use 块),见下表 |
| 自由文本 | 整段叙述的唯一出口是 `payload.text`:先按已知凭据精确打码,**再**截断到 ≤2048 字符(顺序反了会把凭据截成半个身子仍留在串里)。`tool_targets` 不走这条通道 —— 它是按键白名单后的**形状摘要**,长度上限低一个量级(见下表) |
| 凭据值 | `obsSecretValues(env)` = 平台注入沙箱的 `SANDBOX_MODEL_API_KEY` / `DASHSCOPE_API_KEY` 与 `WORKER_API_TOKEN` 的**值**,精确子串替换为 `***REDACTED***`。按值匹配而不是按字段名:transcript 里出现的是 key 的值,而不是 `OPENAI_API_KEY` 这个名字。短于 8 字符的值不参与(那会把正文打成筛子) |

`tool_result` 的输出摘要走的也是「截断 + 打码」通道:它能看出「跑了什么、结果形状如何」,但搬不走一个文件。

### `payload.tool_targets` —— 入参形状摘要的取值规则

加这个键的动机不在观测面本身,而在 §9.8:判据要区分「读 A 文件」与「读 B 文件」,而
`detect.ts` 能看见的只有这里写下的字节 —— 到了读端再想分辨已经太晚。它**不是**把 `input`
放回来:只有下表列出的键会被读,读到的值还要过打码与 128 字符限长。

| 项 | 规则 |
|---|---|
| 可取的参数键 | `file_path` / `path` / `pattern` / `directory` 原样取字符串值;`command` 取**一个形状摘要**(口径在本表下面三行),其余 token(含所有 flag)一律丢弃。一个 input 里同时命中多个键时按此顺序取第一个 |
| `command` 的形状 | 先按 shell 分段符拆段,**分段符集合是闭合的三成员 `&&` / `||` / `;`**,丢掉「只改目录/环境」的前缀段(`cd` / `export` / `source` / …),再取剩下**最具体**的那段(= token 数最多,并列取先出现的),最后按「首词 + 首个可当目标的实参」成形。**一条 tool_use 仍然只产一个键** —— 改的是键的分辨率,不是 §9.8 的计数方式。为什么必须拆段见 §9.8「两次塌缩」 |
| 为什么 `|` 不分段 | 单竖线**不是**分段符(操作员在同一批 36 条上实测:含 `\|` 的 24 条里有 12 条的竖线在**引号内**,形如 `grep -rn "a\|b\|c" src/`)。按竖线切会把正则劈成碎片、选段规则选中尾碎片 ⇒ 键变成 `not_archived" src/` 这类东西,随模式文本漂移(真空转反而测不出),且把 grep 模式送上观测面。判别用例在 `test/obs-events.test.ts`(③)与 `test/supervisor-detect.test.ts`(③) |
| 什么算「可当目标的实参」 | flag(`-` 开头)、重定向(`2>&1` / `>/dev/null`)、以及**正文 token**(以引号 / 反引号 / `$` 开头,或以引号收尾)都不算 —— 它们是 grep 的模式、echo 的消息、`$(date)`,选进形状等于把 `input` 的正文外送。配套口径:分词时**引号内的空白不切**(不脱引号、不认转义、不认嵌套;未闭合的引号一路吃到行尾,形状变粗但不外漏、不抛) |
| 键名匹配 | **大小写不敏感、去分隔符**后比对:`file_path` / `filePath` / `FilePath` / `file-path` 算同一个键(不同工具把同一个东西叫不同名字,按字面比对会让判据在换工具时静默失灵)。认不出的键(`notebook_path` / `cmd` / `query`)一律不取 |
| 值类型 | 只取 `string`。结构化值(对象/数组)不递归 —— 一递归就等于把整个 input 又收回来了 |
| 打码与长度 | 每条先按已知凭据打码、**再**截断到 ≤128 字符(与 `payload.text` 同一顺序理由) |
| 下标对齐 | 与 `tool_names` 同长度同顺序;某个工具调用取不到形状时该位写 `""` 占位。占位比稀疏好检查:读端点可以断言两个数组等长,而不必处理「第 i 个名字对应第几个目标」 |
| 整键缺省 | 一个形状都没取到时**不写** `tool_targets`(而不是写 `[]` 或 `[""]`)。缺省能把「这段 journal 早于本字段上线」与「新段里的工具全都没有可取形状」分开 —— §9.8 的分段统计依赖这个区别 |
| 与 `text` 的分工 | `tool_targets` 是形状摘要、`payload.text` 是可见叙述,两条口径不混:`tool_use` 的 `text` 行为**没有**任何变化(仍然不写) |

### 读端点

`GET /api/tasks/:id/events?after=<n>&limit=<n>` —— 鉴权与其余任务端点走同一条 `checkApiToken` 路径。按 DO 里 `attempts` 的创建序拼接各 attempt 的事件,attempt 内按 `generation`、`seq` 升序。`after` 是**扁平有序流上已读的条数**(不是 `seq`:`seq` 只在 (attempt, generation) 内单调,跨 attempt 当游标会静默漏读),`limit` 缺省 500、上限 2000。任务不存在 → 404;从未摄取过事件 → 空列表而不是 404(第一轮轮询还没跑完是常态)。某 attempt 的 journal 读坏不会瞎掉整个任务:该 attempt 进 `unreadable_attempts`,其余照常返回,同时记 `obs_read_attempt_failed`。

### 这一层刻意不做什么

- **不建 hash chain**:防篡改是权威层(§4 Event / §9)的职责;观测事件的价值是「现在在干什么」,要的是读得到、读得快。信封里既没有 `digest` 也没有 `prev_digest`。
- **不参与状态机、不改执行行为**:摄取失败(读文件错、解析错、R2 抖)只记 `obs_ingest_failed` 并跳过本轮,下一轮从已存游标重试 —— 把 attempt 弄成 BLOCKED 是权威层的事,旁路不该改变结论。
- **不做 Supervisor / 告警 / 分流**(下一期)。SSE 投影已落地(§9.6),Live UI 已落地(§9.7);本节只交付数据路径与 RUNNING 期间可读的出口。
- **不做事件回放改写/删除**:段文件 append-only。

### 取证日志

| 前缀 | 含义 |
|---|---|
| `obs_ingest` | 一轮摄取的账:任务/attempt/代/事件数/游标推进/余量字节/写了几个段 |
| `obs_generation_bump` | 换代及其原因(`transcript_shrunk` / `transcript_replaced`) |
| `obs_ingest_failed` | 本轮摄取失败已跳过(带 `action=skip_round_retry_next`) |
| `obs_index_malformed` / `obs_index_inconsistent` / `obs_commit_seq_discontinuity` / `obs_segment_count_drift` | 游标自洽性被破坏 → 整轮拒写 |
| `obs_read_attempt_failed` | 读端点遇到坏 journal,降级为「列出该 attempt 但不返回其事件」 |

### runner 心跳:`kind="heartbeat"`(c10b)

poll 相每轮把已经拿到的 `ProcessSnapshot` 交给 `ingestObsBestEffort`(新增可选入参 `snapshot`),
由摄取侧**每轮落一条**心跳。它不是 transcript 行:`obsKindOfLine` 永远不会返回这个 kind,它由
`toHeartbeatEvent` 显式产出,但仍走 `sanitizePayload` 的白名单(所以不可能绕过去)。

| payload 键 | 类型 | 来源 | 缺省规则 |
|---|---|---|---|
| `status` | 枚举(`LONGRUN_STATUSES`:starting/running/completed/failed/killed/error/missing) | `ProcessSnapshot.status` | 认不出的取值**整键丢掉**,不写字符串原文 |
| `exit_code` | 数值 | `ProcessSnapshot.exitCode` | `null` 即不写该键 |
| `started_at_ms` | 数值 | `ProcessSnapshot.startedAtMs` | 同上 |
| `round_ms` | 数值 | 本轮 ingest 在落盘前测得的耗时 | 恒有 |
| `gap_ms` | 数值 | 与上一轮提交(= 上一条心跳)的间隔 | 本 attempt 第一条心跳不写该键(不猜参照点) |

**为什么只有枚举与数值、不带任何自由文本**:心跳每轮一条、由 runner 无条件写、且是 §9.8 分级
唯一的时间源 —— 观测面一旦能带文本,心跳就成了一条**永不关闭的外流面**(每 30 秒一次、无人审阅、
内容来自沙箱内部)。所以这条通道连 `textField` 都不经过:白名单是「键 + 类型」双重匹配。

**为什么心跳必须由 runner 自己发,不能拿转录静默当心跳**:transcript 的有无说的是「模型这 30 秒
有没有吐字」,判据要问的是「外圈的摄取通道还通不通」。prod 取证里两者分叉:一个**健康** writer
出现过 576s 零新转录条目,而 C2-r6 的 24 分钟悬挂在同一个数字上长得一模一样。只有第二条由 runner
无条件写下的时间源能把它们分开 —— 于是有了 §9.8 的分级:**心跳断 ⇒ red(高置信,runner 自己停了);
心跳在而转录静 ⇒ 只 yellow(低置信)**。

**为什么加 kind 也不递增 `OBS_EVENT_V`**(与上一节的「加可选键不递增」不同类,所以单独判一次):
`v` 管的是信封与通道的形状,而 `kind` 从设计上就是**开放集合** —— 读端点对不认识的值必须照常透出
(`raw` 的存在就是这条的极端形式),`decodeJsonl` 也不按 kind 过滤。递增换来的是「所有按 v 分支的
读路径要么拒绝新段、要么各写两份解码」,而收益为零:判据侧靠 `kind` 排除心跳,不依赖 `v`。

**空轮也写**:`ingestTranscript` 原本在「无新增完整行」时不落任何写(30s 一次的空轮询不该把 R2
刷满小对象)。传了 `snapshot` 之后空轮也要落 —— 「这一轮什么新内容都没有」正是心跳要记录的事实;
不传 `snapshot` 的调用方(历史形态)路径逐字段不变。

### 为什么加 `tool_targets` 不递增 `OBS_EVENT_V`

`OBS_EVENT_V` 钉的是**信封**(`v` / `task_id` / `attempt_id` / `generation` / `seq` / `ts` /
`kind` / `payload` 这八个键的存在与语义),本棒一个都没动 —— 变的只是 `payload` 白名单里多
了一个**可选**键。递增版本要付的代价是让所有读端为「v1 与 v2 并存」写分支,而这里没有需要
它们分辨的差异:§9.6 的 SSE 帧、§9.7 的 Live UI、§9.8 的 Supervisor 全部按「有则用、无则
降级」读同一个字段名,老段文件与新段文件走同一条解析路径。反过来说,真正需要递增版本的
改动是「同一个键的含义变了」或「旧键被删了」—— 那会让老段被按新语义误读,而这正是本棒
刻意避开的形状(所以 `tool_use` 的 `text` 行为保持原样,新信息用新键带)。

判断纪律:**加可选 payload 键不递增,改既有键的语义或删除键才递增**。将来再问一遍时,先看
这条,再看上一条(整键缺省的写法)—— 两者合起来才使「不递增」是安全的。

---

## 9.6 SSE 投影 —— 在途事件的流式读出口(非权威)`src/obs/stream.ts`

一句话:把 §9.5 那条只能一页页拉的在途事件流,改成**按位置游标往前推**的 SSE。它一个字节都不写,权威仍是 §4 / §6 的 hash chain。

数据源与 §9.5 的读端点**完全相同**(同一个 `readObsAttemptEvents`、同一份 R2 段文件 journal、同一套扁平序),差别只在拉与推。

### 定位:四层可观测里的第四层,而且是投影

| 层 | 出口 | 数据源 | 权威? | 任务 `RUNNING` 期间有内容? |
|---|---|---|---|---|
| ① 控制面快照 | `GET /api/tasks/:id` | TaskSession DO `getSnapshot()` | **读的就是权威本人** | 有,但只有粗粒度 `state`(C2-r6 的病灶,§9.5) |
| ② 归档读视图 | `GET /api/admin/events`、`/api/admin/attempts` | D1 终态归档 | 否(投影) | **无** —— 事件/attempt 随终态才归档 |
| ③ 在途只读投影 | `GET /api/tasks/:id/events` | R2 `obs/` 段文件 journal | 否(投影) | 有,拉取式,单次 ≤2000 条 |
| ④ 在途流式投影 | **`GET /api/tasks/:id/events/stream`** | 同一份 journal(经 ③ 的同一个读函数) | **否(投影)** | 有,推送式,每拍只读增量 |
| ④′ 同一投影的人眼端 | **`GET /live/:taskId`**(§9.7) | 由浏览器直连 ④ 那条流 | **否(投影的投影)** | 有,且额外给出「距最新事件多久」这个判据 |

本节是第④层的**上半**;下半(Live UI / `/live`)已落地为 §9.7。

**「投影」的操作性定义,不是修辞**:本端点不写任何权威状态 —— 不碰 TaskSession DO 的 storage、不追加事件、不动 D1、不新增 R2 对象。全部副作用 = 每轮一次 `getSnapshot()` 短读 + 若干次 journal 读。因此删掉这条端点不影响任何执行结论,也不使任何已归档证据变得不完整。反过来这也界定了它**不能**承担什么:帧里没有 `digest`/`prev_digest`,不构成可核验的审计序列;要举证仍以 hash chain(`GET /api/admin/events`)为准。

为什么值得单独一条流,而不是用 ③ 分页全量重放:③ 单次上限 `MAX_OBS_LIMIT=2000`,而一次 40 分钟的长跑实测 **450+ 条且仍在涨** —— 靠「翻到最后一页看尾部」来回答「现在在干什么」,每轮都要付整段下载的代价(O(total))。流式投影把成本降到 O(new)。

为什么是**独立端点**而不是把 `/events` 改成「可选流式」:后者的 `Content-Type` 与响应形状会随 query 变化,同一个 URL 两种契约最容易让客户端猜错;而 SSE 的连接生命周期(取消、保活、终止帧)是一整套自己的约定,值得单独一个路径。

### 帧格式

```
HTTP/1.1 200 OK
content-type: text/event-stream; charset=utf-8
cache-control: no-cache, no-transform     ← 一条被中间盒攒住的 SSE 与没有 SSE 等价
x-accel-buffering: no

id: 3
event: agent
data: {"v":1,"task_id":"…","attempt_id":"…","generation":1,"seq":3,"ts":"…","kind":"tool_use","payload":{…}}

: ping                                    ← 一轮无新事件的保活注释帧:**没有 id 行**

id: 450
event: end
data: {"v":1,"task_id":"…","events":450,"unreadable_attempts":[]}
```

> **prod 客户端观测不到 `x-accel-buffering`**(2026-09-03 定性,非回归):它是给中间盒的消费型指令头(nginx 系约定),Cloudflare 边缘按语义消费后不向客户端转发 —— 同一 Response 上代码设置的 `cache-control: no-cache, no-transform` 原样可见,证明头透传本身无恙。客户端侧验证「禁缓冲生效」看 `cache-control`,不要用本头做断言。

- 事件帧的 `data` 就是 `AgentEventV1` 原文(§9.5 的信封),**不解析、不加工、不重排字段** —— 脱敏已在 ingress 完成,读端点再加工就是第二个口径。
- `event:` 名固定 `agent`(事件帧)与 `end`(终止帧);`end` 的 `data` 形状版本 `v` 是 `OBS_SSE_FRAME_V`,与 `AgentEventV1.v` **各自独立演进**。
- **`data:` 恒为一行**。一个裸换行会把一条事件切成两帧、把后续行当新帧解析 —— 那是 SSE 注入。`JSON.stringify` 已把 `\n`/`\r` 转义成两字符序列,注入这条路天然封死;剩下 U+2028/U+2029:对 JSON 合法、对 SSE 分行规则非法,而不少语言的分句函数(Python 的 `splitlines` 即一例)会当换行处理 —— 而 payload 里装的正是 agent 的任意自由文本。所以 `sseData()` 显式转义这两个码位,让「一帧一个 data 行」对任何客户端都成立(测试逐帧断言 `data:` 行数为 1)。

### 帧 id 与 `Last-Event-ID` 的口径:已读条数,与 `GET /events` 的 `after` 完全同源

**口径一句话**:帧的 `id` = **该帧之后已读的事件条数** = 全 attempt 扁平序(§9.5 的排序:attempt 创建序 + attempt 内 `generation`、`seq` 升序)上的 **1-based 位置**。客户端断线时按标准把最后看到的 `id` 回传成 `Last-Event-ID`,服务端把该值当**已读条数**消耗,于是下一帧的 id = 该值 + 1。`end` 帧的 id 同口径(= 当前扁平总条数),拿它当续传点再连,正好接在最后读过的那条之后。

**为什么不是 0-based 索引 —— 上一版实现正是这么错的**:

| 口径 | 断线续传的后果 |
|---|---|
| `id` = 索引 p(0-based) | 索引 p 之后已读 p+1 条,而服务端把 id 当已读条数消耗 → **位置 p 那条被重发一次** |
| 第一帧 `id: 0` | 浏览器重连回传 `Last-Event-ID: 0` = 「一条都没读过」→ **全量重放整条流** |
| `id` = 已读条数(现状) | 续传点之后第一条就是没读过的那条:不重发,也不漏读 |

两套口径的代价不是「有点吵」,是「同一事件出现两次、另一次永远看不到」,而这两者都不报错、都在客户端表现成一条正常增长的流 —— 只有拿它做去重或计数时才暴露,那时已经分不清哪一份是真的。

**同源靠的是同一个算法,不是靠注释**:本端点的每轮差分(`累计 before`、`skip = max(0, position - before)`)与 `handleGetTaskEvents` 的 `after` 分配规则**逐字相同**。两处各写一份迟早漂移,而漂移的表现就是上面那张表。可执行证据在 `test/obs-stream-api.test.ts`:「往返自洽」(最后一帧的 id 喂给 `?after=` 与当 `Last-Event-ID`,两边都读出 0 条)与「中间帧 id=2 时两种读法逐条相同」两条用例把这条口径钉成断言,而不是留给读者比对。

**入参校验**:

- header 不在 = 缺省 = 0 = 从流头回放已有全部事件。**header 出现了但值为空不是「缺省」** → 400 `invalid_last_event_id`(与 `?after=` 空值同理:把空值当 0 会让一次写错的续传从头重放整条流)。
- 比 `Number(raw)` 更严:只接受 `^\d+$` 且落在安全整数范围。`Number` 会把 `0x10` 读成 16、`1e3` 读成 1000 —— 一个续传游标被**悄悄换算**的后果是漏读(位置 16 之前全被跳过),而这条路径上没有任何东西会发现。
- 起始位置超过总条数(客户端拿着未来的游标重连)→ 零帧、正常收尾,不是错误。
- 装配层拿着畸形起始值 → `createObsStreamSession` 直接 throw `obs_stream_bad_start_position`:那是装配 bug,不该退化成「从头全量重放」。

鉴权与错误形状同其余任务端点:同一条 `checkApiToken` 路径(缺/错 token → 401);任务不存在 → 404,且**必须在建流之前判掉** —— 流一旦 200 就没法再补状态码。

### 为什么绝不把长连接挂进 TaskSession DO

§6 的定稿禁令,这里说清它针对什么。TaskSession 是 `blockConcurrencyWhile` 的**重度单写者**:`createTask` / `startAttempt` / `reportExecution` / `submitDecision` / `alarm` 每条写路径都把「读 → 变更 → 写」整体圈进临界区(§13.11 花力气消掉的就是这类交错)。一条活几分钟到几十分钟的 SSE 若驻留在 DO 里,它占住的并发槽位就会**挤占权威写路径** —— writer 的回报会被一条只读连接挡在后面,而回报正是状态机唯一的前进输入。

所以泵跑在**普通 worker handler 的 `ReadableStream`** 上,每轮只做一次**短读** `getSnapshot()`(只取 `state` 与 attempts 清单,`ObsStreamSnapshot` 刻意比快照窄:流不需要 events 与预算)。禁令的对象是「连接挂进 DO」,不是「周期性地短暂读一下 DO」—— 短读进出临界区的时长与一次普通 HTTP 请求同级。

这条边界值得写明白,否则下一棒容易矫枉过正:把 attempt 清单缓存进 worker 内存以「减少 DO 读」,就会多出第二个清单口径,而扁平序的正确性恰恰依赖它与 `GET /api/tasks/:id` 同源。

### 尾读节奏、保活与终止条件

| 规则 | 取值 | 为什么 |
|---|---|---|
| 尾读节拍 | `OBS_SSE_TAIL_INTERVAL_MS = 3000` | 它**不是新数据的来源**:journal 每 30s 才被 `poll-i` 推进一次(§9.5)。3s 只决定「事件落地后多久被流看见」。取 3s 而非 30s,是为了让尾部延迟由**摄取周期**主导,而不是由本端点的轮询节拍主导 |
| 保活 | 一轮零新增 → `: ping\n\n` | 让代理链与客户端都知道连接还活着。注释帧没有 `id:` 行,因此**不移动续传点**(浏览器保留上一个事件帧的 id) |
| 终止 | `state != RUNNING` **且**本轮增量已推完 → 一帧 `end` 后 `close()` | 只有 `RUNNING` 是「还在往前流」。`AWAITING_APPROVAL`、`BLOCKED`、各终态一律收尾:旁路不预测终态之后还有没有事件,收尾让客户端按标准带 `Last-Event-ID` 重连(拿 404)或转 ③ 复核 |
| 读写顺序 | 先读快照、后读 journal | 这样「快照已非 RUNNING」与「本轮增量已推完」在**同一轮**里同时成立,终止判定不需要再多等一拍确认 |
| 快照读不到(任务被删/DO 不可用) | 发 `end` 收尾 | 没有任何可信的前进依据,不该空转到天荒地老 |
| 快照读抛错 | 记 `obs_stream_pump_failed` 后关流(**无 `end` 帧**) | 大声失败,让 EventSource 按标准自己重连,而不是留一条永远不出声的 200 |
| 输出队列 | 刻意**不设上限** | 每轮产出受 journal 增量约束(30s 一轮、单轮条数有限),消费方是一个总在读的浏览器。真正的上限是「终态即收尾」,不是缓冲区大小 |

一条连接一个泵,不做多客户端扇出:要 N 个读者就 N 条连接,读的都是同一份 append-only journal,彼此不影响。

`AWAITING_APPROVAL` 也收尾值得单独说一句:按 §5 的转换表它可能因 reviewer 成立的 reject 回到 `RUNNING`(rework)。收尾**不丢事件** —— journal 继续增长,客户端带最后看到的 `id` 重连即从同一位置接上(位置口径与 ③ 同源,正是它保证这件事成立)。选择收尾而不是挂一条可能永远不醒的连接,是「旁路不预测权威接下来做什么」的同一取向。

### 降级语义

某 attempt 的 journal 读不到(index 坏了 / R2 抖)→ **不杀流**:记一条 `obs_stream_attempt_unreadable` warn,把该 attempt 列进本轮 `unreadable` 集合,`continue` 推其余 attempt。与 ③ 的 `unreadable_attempts` 同一处置逻辑:**静默少一批事件比报错更糟** —— 视图不完整必须出声,并且随 `end` 帧把 `unreadable_attempts` 交给客户端。下一轮它翻回可读即从集合移除(集合只反映「截至收尾那一刻还读不到的」)。

副作用要如实记一句:扁平位置以「本轮读到的 attempt 清单」为准,所以某 attempt 从不可读**翻转为可读**会让位置重排。③ 同口径同表现,这不是本端点新增的偏差,实际也不会发生(index 坏了只会被下一轮摄取重写)。

### teardown 不变量:cancel 必须 settle 泵等待中的那一拍

本端点**头号的验收钉**,也是它前一版死掉的原因。

`stop()` 只做 `clearTimeout` 是不够的:那一拍写成 `await new Promise(resolve => { timer = schedule(..., resolve) })`,cancel 之后 fire 永不执行 → `resolve` 永不被调用 → 泵那个 async 帧**永久悬挂**,每次客户端断开漏一个。workerd 按 IoContext 追踪未完成的异步工作,teardown 时判定 hung 并取消整个请求:

```
jsg.Error: The Workers runtime canceled this request because it detected
that your Worker's code had hung
```

**实测标本(前一版)**:**48 条 `EnvironmentTeardownError`**,容器侧 **925s** 才收尾 —— 同一份套件本地 **4.5s 全绿**。后果不是「慢」,是**验证器连测试 summary 都打不出来**:被墙钟吃掉的是取证本身。这是 §13.16「这套绿不覆盖 orchestration」的镜像形态:**本地绿 ≠ 容器绿**,更准确地说是「本地绿也 ≠ 验证器能跑完」。

结构上的修法:「等一拍」抽成 `createObsStreamWaiter()` —— 一个定时器 + 一个可被 cancel 立刻了结的 promise。`cancel()` 既 `timer.cancel()` **也自己 `resolve()`**(不等 fire 来),泵因此立刻回到 `while (!stopped)` 判定。它单独导出、`ObsStreamHandle.settled` 也存在,唯一意义就是把这条不变量变成**可断言的东西**:`test/obs-stream.test.ts` 的假 `schedule` 与 workerd 的 `setTimeout` 同构 —— `cancel()` **只清登记,绝不触发 fire** —— 所以任何「靠 fire 才 settle」的实现会在 teardown 用例里**快速变红**,而不是悬挂到超时(后者才是本地那 4.5s 全绿骗过人的形态)。

> 两半都要守住,只做对一半本地仍然全绿:装配层(`src/index.ts` 的 `schedule`)必须真 `clearTimeout`,否则断开后定时器还在推进泵;`stream.ts` 的 `stop()` 必须真 settle 那一拍,否则断开后留一个悬挂帧。测试侧同理 —— `test/sse.ts` 的注释写明:**每个打开过 200 流的用例都必须 `cancel()`**。

### 取证日志

| 前缀 | 含义 |
|---|---|
| `obs_stream_attempt_unreadable` | 某 attempt 本轮读不到,已跳过(视图不完整,进 `end` 帧) |
| `obs_stream_pump_failed` | 泵自身抛错(快照读失败)→ 记警告并关流 |
| `obs_stream_bad_start_position` | 装配层喂进畸形起始位置 → throw,**不降级成全量重放** |

### 为什么 docs 单独一棒

这条端点是**「一个棒次里塞实现 + 测试 + 文档」连续撞墙两次**之后的拆分结果,不是格式洁癖:

| 棒次 | 交付范围 | 结局 |
|---|---|---|
| C9 原规格 | 代码 + 测试 + docs 一棒交付 | **40 分钟撞墙**(task `f78b622f`) |
| r2 | 同上,未拆 | 后台套件跑 **13 分钟颗粒无收**,被墙钟击杀(task `76464e22`) |
| c9a-r3 | 只交付代码 + 测试 | 全绿,verifier 全量回归通过 |
| c9a-r4(本节) | 只交付 docs | —— |

拆分判据:**代码与测试的产出可以边跑边验,文档的产出只在收尾那一刻兑现**。把只在最后一步兑现的东西排在会被墙钟击杀的位置,等于把它做成下一次的 40 分钟。

拆成两棒也有代价,要如实标出:本节读的是**已合入的实现与测试**,不是当时的设计意图。口径若与代码有冲突,以 `src/obs/stream.ts` 顶部注释与 `test/obs-stream*.test.ts` 为准 —— 它们是可执行的,本节不是。

### 这一层刻意不做什么

- **不产 HTML**(本节口径:上半只交付数据路径)。第④层的下半已落地在 §9.7 —— 它不改这条流的一个字节,只在浏览器里读它;落地页**不列**这个端点,`test/obs-stream-api.test.ts` 钉住首页 HTML 里既不出现 `/events/stream` 也不出现 `text/event-stream`。
- **不写权威状态、不参与状态机**(见上「定位」)。
- **不做背压/上限队列**、**不做多客户端扇出**。
- **不预测终态之后的事件**:离开 `RUNNING` 即收尾,由客户端决定要不要重连。

---

## 9.7 Live UI —— 时间线的人眼端(非权威)`src/obs/live.ts`

一句话:把 §9.6 那条流画成**一个页面**,并在页面上加一个 §9.6 给不出的东西 —— **一个每秒自增的「距最新事件多久」计时器**。数据出口仍是 §9.6,本层不新增任何数据路径。

### 定位:投影的投影

`GET /live/:taskId` 返回一个 HTML 文档(`text/html`,CSS/JS 全内联),浏览器拿到后**自己**用 `EventSource` 连 `/api/tasks/<taskId>/events/stream`。服务端在这条路上只渲染骨架(任务 id、state 徽章初值、阈值常量、kind 清单),**不渲染任何事件内容**。

所以它的权威性与 §9.6 同级、且只更低不更高:**只被动显示,不做任何判定,不做任何处置** —— 不 cancel 任务、不 approve、不标 `awaiting_human`、不预测终态、不写任何状态。它连「是不是挂了」都不下结论:它只把「离上一条事件过了 213 秒」这件事摆到人眼前,**判定由人做**。

这条边界是本期与下一期的分界线:**Supervisor 是独立的消费者层**(下一期),它才是把「N 秒无新事件 + 进程 alive + 预算未尽」翻成机械动作(告警 / 判 no-progress / 停 attempt)的那一层。Live UI 与 Supervisor 读同一份投影,但一个只长眼睛、一个长手 —— 把两者混在一层,等于让渲染层拿到处置权限。

### 为什么这个页面存在的唯一理由是停滞检测

验收标本 **C2-r6**:单次模型调用悬挂 **24 分钟**,当时只有人工 tail 才发现(§9.5 的起因)。

为什么 §9.5/§9.6 的出口不足以发现它:那两个出口都**有**数据 —— 问题恰恰是「新数据停止而进程 alive」。人眼盯着滚动的 NDJSON 或一个 `state: RUNNING` 徽章,量不出「距离上一条过了多久」,而「多久」是这件事唯一的判据。所以本 UI 的核心价值不是渲染,是**把时长变成一个会自己涨的数字**。

阈值(单位:秒)。**c10b 起这两个数不再是本页自己的数字** —— 它们派生自 §9.8 的那份判据
(`LIVE_STALL_* = detect.ts 的 AGENT_SILENT_YELLOW_MS / NO_HEARTBEAT_RED_MS ÷ 1000`),
本页不再自带一份理由。旧表里的 90/300 建立在「新数据每 30s 推进一次」这个前提上,prod 已证伪
(实测中位轮次 33s、健康 writer 静默过 576s)—— 也就是说旧页面早就在对健康任务准备误报。

| 阈值 | 值 | 对照的是哪条判据 |
|---|---|---|
| 黄 `LIVE_STALL_WARN_SECONDS` | **900** | `stall.agent_silent`:心跳在、模型静默超过它 → 黄。**永远只是黄** —— 区分不了「挂了」与「在干不产字的长活」 |
| 红 `LIVE_STALL_DANGER_SECONDS` | **180** | `stall.no_heartbeat`:连每轮无条件写的那条心跳都没了 → runner 停了(高置信) |

页面上两种异常是**两个说法**(这是本次改动对用户最有用的可见差异):「心跳停止 Ns(runner 停了)」
与「模型静默 Ns(runner 活着)」。计时器读两条独立时间源:`lastEventMs`(任意事件,含心跳)与
`lastBehavioralMs`(仅非心跳事件),后者绝不能把心跳算进去 —— 否则静默计时永远归零,`agent_silent` 形同虚设。

按这个标尺,C2-r6 那次 24 分钟悬挂**不会亮红**:挂起发生在容器内的单次模型调用上,poll 相每轮
照常返回快照 ⇒ 心跳不断,红线量的是「runner 停了」而 runner 没停。它在静默 900s(15 分钟)后
**亮黄**,而不是旧文案宣称的「5 分钟内必红」。这个变慢是**用检出时延换精度**,不是回退:旧红线
建立在「新数据每 30s 推进一次」上,而 prod 实测健康 writer 静默过 576s —— 那条线早就在对正常任务
误报,误报的观测面会让人不再相信它。换到的东西同样要说清:「runner 停了」这个判据在旧的单时间源
下**根本表达不出来**(最后一条事件停滞,分不清是模型不产字还是摄取通道死了)。旧文案「90 秒变黄、
5 分钟内必红」随阈值重标定一起作废。

还有一条同构的自律:计时器必须**每秒自跑**,不能只在事件到达时刷新 —— 悬挂的时候恰恰没有事件来触发刷新,而那一刻是它唯一有用的时刻。

### 为什么全内联、零依赖、无构建步骤

- **可测性**:页面是纯函数 `renderLivePage(taskId, {state}) → string` 的产物。单测因此可以直接 `toContain` 钉住契约(阈值数字、`EventSource`、流路径、`OBS_EVENT_KINDS` 全部徽章、转义生效),不需要起浏览器、不需要 npm 前端依赖、不需要构建步骤。
- **离线可用**:这是**故障时最后还要打开的页面**。引 CDN 等于让观测面依赖一个与故障无关的外部可用性 —— 而外部资源加载失败会让页面**看起来**是坏的,正好在最需要它的时刻最不可信。零依赖也意味着没有供应链面:这个文件里的每一个字节都是本仓写的。

### 为什么一个「只是给人看」的页面也要鉴权

`/live/:taskId` 走全局那一条 `checkApiToken`,与 `/api/tasks/:id/events*` 同源:无凭据 → **401**;任务不存在 → **404**(且必须在生成 HTML **之前**判掉 —— 200 + `text/html` 一旦发出就没法补状态码,同 §9.6 建流前判 404 的理由)。

理由不是「payload 里有敏感东西」:事件 payload 已在 ingress 过白名单脱敏(§9.5)。**要守的是任务存在性本身**,以及 `state`、事件条数、agent 正在动哪个仓库这类元信息 —— 对扫描器它们就是有价值的信号。更要紧的是:不鉴权的 404 会让「这个 taskId 存在」成为一个**无条件可问的问题**,那与鉴权后的 404 是两台机器。口径也必须是同一条:全仓凡带任务信息的出口都挂同一个 token 检查(§11 全表无例外),留一个例外就等于给下一个留位置。

附带两条同源约束:`taskId` 的路径正则与 `/api/tasks/:id/*` **同一条** `[0-9a-f-]{36}`(畸形 id 在路由层就 404,不进渲染),而 `renderLivePage` 仍然自己转义 —— 导出函数的契约不能建立在「调用方的正则恰好够用」上(下一棒放宽路由、或别处复用本函数,就得到一个静默的注入点)。转义按上下文分两套:HTML 文本节点走 `escapeHtmlText`,`<script>` 内的 JS 字面量走 `scriptJsonString`(`</script>` 会提前闭合标签,而 script 元素内容不是 HTML 文本节点,`&lt;` 在那里不还原 —— 用同一个函数糊过去就是 XSS);流里来的数据一律 `textContent` 落地,绝不 `innerHTML`,因为脱敏管的是「不该出现的值」,管不了「看起来像标记的字符」。

### 已知的部署侧前提:EventSource 带不了 Authorization 头(401 与断连**可区分**)

必须写清,不能靠实现蒙过去:**`EventSource` 按规范不能携带自定义请求头**,而 §9.6 那条流只认 `Authorization: Bearer`。所以 prod 无凭据直开 `/live` 会得到 **401**,页面停在「连接已关闭」那一支提示上。

**这个 401 是预期,不是回归**:全局那一条 `checkApiToken` 有意覆盖这个出口(理由见上一小节:要守的是任务存在性本身),而页面里不含任何凭据出口。**浏览器可达性由后续产品化会话方案统一解决,本期刻意不引入任何临时方案** —— 本地代理、登录壳、query token、cookie 会话、平台 ticket 铸发一律不做(方向已定,先搭临时桥等于给下一棒留要拆的桥);把 `WORKER_API_TOKEN` 塞进 URL 尤其不做(凭据会进浏览器历史、访问日志与 Referer,是拿观测面换一个泄露面)。本期硬约束同样包含**不改 SSE 端点的一个字节(含它的鉴权)**。

**本节此前写着「401 与网络断连在 EventSource 前端不可区分」—— 那句是错的,2026-09-03 浏览器实测后更正如下。** 同一 42s 窗口并排探两条流(readyState 探针):

| 故障形状 | `onerror` 触发次数 | 最终 `readyState` | 浏览器是否重连 |
|---|---|---|---|
| **HTTP 401**(prod 直开的实际落点) | 仅 **1 次**(dt≈1ms) | **2 = CLOSED** | **永不重连** |
| **网络失败(拒连)** | **每 ~3000ms 一次** | **0 = CONNECTING** | 每 3s 自动重连 |

判据因此是 `es.readyState`,**不是**「error 事件出现了几次」—— 两种故障的**第一次**都恰好是 1 次,拿次数当判据必然把 401 误判成「正在重连」。

页面据此分三条分支,规则与文案的唯一来源是 `src/obs/live.ts` 的 `LIVE_CONN_RULES`(同一张表既注入给浏览器侧的 `connView()`,又喂给纯函数 `liveConnectionView()`,后者由 `test/obs-live.test.ts` 逐分支钉住):

- `readyState === 2`(**CLOSED**)→ 明说「**不会自动重连**」,点名**鉴权失败(401)**为最常见原因,并给出**当下就能用**的出路:带凭据的 API 客户端(`curl -N` 加 `authorization` 头)访问流端点;
- `readyState === 0`(**CONNECTING**)→ 保留「自动重连(第 N 次)」,且**只在这条分支**上把 `reconnects` 计数 +1(否则计数行是第二处谎);
- 其它取值(如 `1 = OPEN`)→ 兜底分支:「状态未知,既不承诺重连也不承诺已关闭」。为什么需要第三条:本期只实测过 401 与拒连两种形状,在任何其它取值上承诺「会重连」或「已关闭」都是在替没测过的东西说话。

这就是本期修掉的**次生缺陷**:旧代码不分枝,401 下页面显示「连接中断,浏览器正在自动重连(第 1 次)」并**永久停在同一句**上 —— 它承诺了一件已证明不会发生的事,操作员会白等。断流与悬挂在页面上本来就长得一模一样(都不出事件),提示再说谎等于把唯一的线索也毁掉。

页面因此自带一条对照用的 curl 命令(同一条流、同一个凭据,能出事件就说明问题在浏览器侧的凭据出口),`onerror` 的提示**可见且分枝**;空态说明块也同步更正:如实写明 EventSource 无法携带 Authorization 头、浏览器自己连不上 prod,不再暗示「再等等浏览器自己就连上了」。

### 单测钉不住什么(不要拿断言当「UI 已验证」)

页面是字符串产物。`test/obs-live.test.ts` 钉得住:路由与 401/404、`text/html`、阈值数字与 `EventSource` 与流路径确实渲染出去、`OBS_EVENT_KINDS` 全部徽章、两套转义生效、**内联 JS 能通过编译**(`new Function(script)` 只编译不执行 —— 字符串产物里的语法错误是静默的,不钉这一条就会交付一个白屏页面)、**页面里那个 STREAM_URL 真能开出 200 的 `text/event-stream` 且首帧是 `{seq,kind,ts,payload}` 信封**(把「UI 连的是哪条流」从注释变成断言)、零外链(`not.toMatch(/https?:\/\//)`、无 `<link>`、无 `src=`)、**`onerror` 的三条分支判定与文案**(`liveConnectionView(2/0/其它)` 各钉一条:CLOSED 必须出现「不会自动重连」且**不得**出现「正在自动重连」、CONNECTING 保留「(第 N 次)」且 `reconnecting === true`、兜底分支不承诺任何一边;外加「兜底规则必须排在表末」这条顺序不变量与 `0/1/2` 常数本身)。

钉不住、**需浏览器实测**的:

| 未覆盖 | 为什么单测覆盖不到 |
|---|---|
| 两条计时器每秒各自自增;心跳停止跨 180s / 模型静默跨 900s 时 pill 真的变红 / 变黄 | 需要真实时钟与真实 CSS 计算;单测只钉得住渲染出去的数字与两条时间源的取值规则 |
| `end` 帧后「流已结束」并停止计时 | 需要真实 EventSource |
| 一条坏帧只跳过那一条、坏帧计数累加、其余继续渲染 | 需要浏览器的事件派发 |
| 真实 401 下 `onerror` 是否真的把 `readyState` 停在 2、真实拒连是否停在 0(即上面的实测结论在新版本上仍成立) | 分支**规则**由单测钉住,但规则与浏览器实现的对应关系只能实测;探针在页面之外 |
| CLOSED 那条长文案在顶部 pill 里的排版是否读得下去 | 渲染结果不是字符串断言能判的(本期只改文案,未做视觉重设计) |
| 200 字符截断后排版、`result`/`error` 的视觉强调是否真的「跳出来」 | 渲染结果不是字符串断言能判的 |

### 这一层刻意不做什么

- **不做任何判定与处置**:不告警、不 cancel、不 approve、不判 no-progress(那是 Supervisor,独立的消费者层,§9.8 —— 它读的正是本层的 journal)。
- **不服务端渲染事件内容**:把首批事件烤进 HTML 会让页面的一次性快照与流的位置游标(帧 id)混成两套进度,而页面活着的时间远长于那次读的一致性窗口。
- **不做多任务列表页**:跨任务枚举会纠缠 `/api/admin/tasks` 的「只读终态归档」口径(§11),是另一棒。
- **不做事件过滤 / 搜索 / 暂停滚动 / 折叠**,不加任务操作按钮。
- **不改 §9.6 的一个字节**:帧格式、鉴权、尾读节拍、终止条件全部只读复用。
- **不引任何 npm 前端依赖、不加构建步骤**。

---

## 9.8 Supervisor —— Observation 层的独立消费者(只观察,不裁决)`src/supervisor/`

四层可观测到本节为止的形态是:①控制面快照粗到看不出停滞,②Observation journal 记下了
每一步,③SSE / ④Live UI 把停滞时长变成人会看见的颜色。**看的人仍然是人。** 本节把「有人
盯着」变成「有东西盯着」:平台自己每 60s 判一次「attempt 还挂着但已经不动了」,把结论写成
权威链上的 `supervisor_finding` 事件。

### 为什么判据必须读 Observation 层,不能读权威层自己的时间戳

prod 活体证据(2026-09-02 11:46Z,C9 任务 `f78b622f-f1bc-49ff-8bc9-12a9d22ff5c3`,写本节
规格的当场取样):writer 已跑 37 分钟且**健康** —— Observation 层 **362 条**事件、最后一条
滞后 **31s**;同一时刻 DO 权威链只有 **3 条**事件(`task.created` / `attempt.created` /
`task.transition`),`task.updated_at` 冻结在创建时刻 **11:09:17.345Z** 一动未动。

这不是 bug,是设计:单写者只在**状态转换**时写权威链,RUNNING 期间权威层按设计零心跳。所以
权威层回答不了「agent 现在还在动吗」—— 它只知道「上一次确定的事实是什么」。判据一旦拿
`task.updated_at` 或 `attempt.created_at` 当依据,得到的必然是「37 分钟没有任何事件」= 全员
red。**Supervisor 是第②层的消费者,不是第①层的新读者。**

### 三条设计立场

| 立场 | 落地 |
| --- | --- |
| **观察与裁决分离** | 本层只 `appendEvent('supervisor_finding', …)`。不 cancel、不 kill、不 BLOCKED、不返工、不改路由、不改 C8 分类器判据。处置权仍在既有路由(wall-time 兜底、预算分流)与人工手里。可执行证据:`test/supervisor-do.test.ts` 钉住「tick 跑过之后 `task.state` / `version` / `updated_at` / `pending_review` / `pending_verify` / `awaiting_human` / `archived` 逐字段不变」,唯一允许动的是 `next_seq`(它就是「写了一条事件」的记账)。 |
| **全部规则默认 shadow** | 代码里 `supervisorModeOf()` 缺省 **`off`**,只有 `wrangler.jsonc` 的 vars 显式写 `"shadow"` 才启用 —— 启用点可审计。理由:三类判据都是启发式(时间阈值 / 重复计数),有误报面;按仓内 M8/M9/C8 的 shadow 惯例先攒样本再谈 enforce(本期**不存在** enforce 代码路径)。 |
| **寄生在既有 watchdog alarm 路径内** | 不新建 DO、不加 Cron Trigger、不做独立 Worker、零分布式协调。Supervisor 写事件走的就是 TaskSession 自己的 `appendEvent`,**不存在绕过单写者的静默写者**。取舍说明:进程级独立(架构纯洁性)本期不值得先建一套协调机制去换;独立性体现在「只观察不裁决」,不是「另一个进程」。 |

### 判据表(kind × rule × severity)

阈值全部可注入(`detectSupervisor({ now_ms, events, thresholds })`),下表是
`SUPERVISOR_THRESHOLDS` 的缺省值。三条判据的默认模式一律 `shadow`。

| kind | rule | 判据(缺省阈值) | severity | 边界纪律 |
| --- | --- | --- | --- | --- |
| `stall` runner 停了 | `stall.no_heartbeat` | `gap = now_ms - Date.parse(最后一条**心跳**.ts)`;`> no_heartbeat_red_ms = 180_000` → **red** | red | 输入是 §9.5 的 `kind="heartbeat"`(c10b 起每轮 poll 无条件一条)。阈值 = `NO_HEARTBEAT_MISS_ROUNDS(5) × HEARTBEAT_ROUND_MS(max(POLL_INTERVAL_MS, 实测中位轮次 33s))` = 165s,**向上取整到 tick(60s)的整数倍 = 180s**。只在「这段 journal 里有心跳」时参与判定 |
| `stall` 模型沉默 | `stall.agent_silent` | 心跳在,`transcript_gap = now_ms - 最后一条**行为**(非心跳)事件.ts`;`> agent_silent_yellow_ms = 900_000` → **只 yellow** | yellow(**永不 red**) | 阈值 = 实测健康 writer 最长静默 `576s × 1.5 = 864s` → 取整到 tick = 900s。样本 n=1,所以这条只黄不红。整段没有行为事件时参照点退回首条心跳 ts(观察开始),否则每个刚起跑的 attempt 都会因「还没有转录」被判 |
| `stall` 无心跳历史段(downlevel) | `stall.last_event_gap` | 仅当这段 journal **一条心跳都没有**(= c10b 部署前落的段)时生效:`gap = now_ms - 最后一条事件.ts > 900_000` → yellow | yellow(**永不 red**) | 保留它是为了旧数据可读,不是为了旧判据继续吓人。没有独立时间源就推不出「runner 停了」,所以这一档不给 red。**shadow 样本必须按有心跳 / 无心跳分段统计** —— 混算等于拿旧数据判新判据 |
| `loop` 循环嫌疑 | `loop.tool_repeat` | 末尾 `loop_window=20` 条**行为**事件的滑窗内,同一 `repeat_key = 工具名 @ target` 出现 `>= loop_repeat_max=5` 次 | yellow;`>= 2×` → red | 只有带 `tool_names` 的事件参与计数(否则一串无文本的 `assistant`/`system` 行会塌成同一个键 → 误报)。target 见下方三级取值。**心跳一律排除**(见下条边界纪律) |
| `no_progress` 空转 | `no_progress.target_repeat` | 末尾 `no_progress_window=30` 条**行为**事件里 `tool_use` 的**目标**重复 `>= no_progress_repeat_max=8` 次 | yellow;`>= 2×` → red | 与 loop 的分工:loop 看「动作全等(工具名 + 目标)」,本条只看「目标」—— `read A → edit A → read A …` 这种工具名交替、loop 抓不到的形态由它抓 |

**为什么 loop / no_progress 的滑窗必须排除心跳**:失效方向是**漏报**,不是误报。心跳 payload 里只有枚举与数值(§9.5),没有 `tool_names`,而两条判据都要求先有工具名才成形(`repeatKeyOf` / `targetOf` 的入口门)—— 所以一串心跳**塌不出 repeat_key**,不构成假阳性。它们真正的破坏力在别处:滑窗取的是 `events.slice(-window)`,**窗口按条数算,而心跳占槽位**。一个 25 分钟的 attempt 会攒 ~45 条心跳,比 `loop_window=20` 与 `no_progress_window=30` 都多 —— 不排除心跳时,窗里全是心跳,真循环整个落在窗外,于是**每条长任务尾部的行为类判据集体失聪**,而这恰好是最需要它们的那一段。

排除后心跳只剩一个用途:当时间源。三向都有用例(`test/supervisor-detect.test.ts` 的「心跳不进 loop / no_progress 的滑窗」):①一串心跳不推进行为类判据;②真循环**被心跳追在身后**时 loop 与 no_progress 各仍要命中(这两条才是①的判别力对偶 —— 交错形态在两种实现下都命中,杀不动任何变异);③同一串心跳仍要让 `agent_silent` 计时正确(排除 ≠ 丢弃时间源)。

**阈值的来源与天花板(c10b 重标定)**。旧的 90/300 已被 prod 数据证伪,两条前提都不成立:

- 前提「摄取节拍每 30s 一次」 ⇒ 实测一个真实轮次 **中位 33s**。富余的 ~3.5s 不是「一次 30 秒级的读」叠在睡眠上(那样就成 60s 了):c10b 起心跳自报 `round_ms`,prod 首个 writer 实测中位 **337ms**、最长 529ms ⇒ 富余属于同一个 poll step 的其余工作(进程快照 RPC + Workflows step 边界)。**33s 这个数被新时间源确认了,归因错过一次。**
- 至于「22% 的轮次会被跳过」(41 轮里 9 个间隔 >60s,最长 94s = 连跳 2 轮):那是**旧口径**(对 journal `ts` 去重反推轮次)得到的,而 c14 writer 的 38 个直接 `gap_ms` **全部落在 32.6–34.7s、0 个 >60s** ⇒ 跳轮未被直接时间源复现,它是任务/时段相关的现象。`MEASURED_ROUND_MAX_MS = 94s` 因此按「设计上的最坏值」保留(任何样本里都没见过更长的间隔),不是当前分布的上界。红线 180s / 实测最长 34.7s ≈ **5.2×** 余量。
- 前提「最后事件滞后 ≈ agent 有没有在动」 ⇒ journal 的 `ts` 写的是**摄取时刻**(`ingestTranscript` 给同一轮全部事件写 `ts: now`),所以它量的是「上一轮读到新东西的时刻」,分辨率天花板就是摄取节奏本身。**在这个数据源上无论怎么调 90/300 都是在猜** —— 这就是加心跳的理由:c10b 起每条心跳自带 `gap_ms` / `round_ms`,节奏在数据里自描述,下一次改阈值可以先从 journal 量出来。

⚠️ **`max(POLL_INTERVAL_MS, 实测中位 33s)` 里今天起作用的是实测那一项**。名义轮询周期在这条派生式中的角色是**下界**(阈值不得小于一轮名义睡眠,否则一次正常跳过就足以误红),而 33s > 30s ⇒ 胜出项是实测值。所以「红线由轮询节奏派生」**不能**读成「改 `POLL_INTERVAL_MS` 会带动 180s」:改成 10s 阈值不动,改成 60s 才动。这条区别在黑盒断言里测不出来 —— 实测过变异:把 `max(...)` 换成只取 `MEASURED_ROUND_MEDIAN_MS`,全量 527 条全绿(两个表达式当前给出同一个 33s)。c10b 补完四条判别用例后同一变异**重测仍为绿**,即盲区未因那批测试收窄。它是**已知的仪器盲区**,写下来是为了将来有人按「轮询一改阈值就跟动」推理时不被本节误导。

| 推进条件 | 达成标准 |
| --- | --- |
| shadow 攒样本 → 数字判据 → enforce | ①c10b 起 prod 有心跳,`gap_ms` 分布可直接量(不必再 tail 反推)——**已达成**;②按**有心跳 / 无心跳**分段统计各规则的命中率与人工复核结论;③`no_heartbeat` 的实测误红率 ≈ 0(独立轮次模型的先验是每 attempt ~2%)且 `agent_silent` 的真阳性能被复核承认 —— 首样本支持它(c14 writer 38 个 gap 全 ≤34.7s、红线余量 5.2×),但**只有一个任务**,不足以结案;④**行为类规则(loop / no_progress)在健康 writer 上零误报**。首样本即出 2 条误报(c14 writer 退出码 0,却在启动 2 分钟内落 `loop.tool_repeat` + `no_progress.target_repeat`,重复键都是塌缩后的 `cd /workspace/repo`)⇒ 成因是摄取侧的**第二次塌缩**(见下面「两次塌缩」),**已在 `commandShape` 修**:复合命令行逐段取形状,窗口与阈值一个数字都没动。于是 ④ 从「不可能达成」变成「待部署后的 prod 样本判定」—— 存量 journal 复算不出(塌缩有损),本棒只在夹具上交付分布,prod 侧由操作员部署后重取。四条齐了才谈 enforce 与处置动作。**enforce 之前必须用 shadow 样本复核这两个阈值**(与 c11 的归档取证清单同属一份证据链,互相指认)。 |

**target 的三级取值**(实现在 `targetOf`,顺序即优先级,每一级都过 `normalizeTarget`):

| 级 | 来源 | 什么时候走这一级 |
| --- | --- | --- |
| ① | `payload.tool_targets` 首个非空条目(§9.5) | 现在的 `tool_use`:入参里含 `file_path` / `path` / `pattern` / `directory` / `command` 之一。这就是「它在碰哪个东西」 |
| ② | `payload.text` 归一化 | c10a 部署前落的段文件(没有 `tool_targets`),以及 `raw` / `assistant` 这类有文本无工具形状的事件 —— 长期现实,不是过渡兜底 |
| ③ | 工具名本身 | 两级都取不到(例如 MCP 工具的 input 只有 `query`)。此时 `repeat_key` 塌成 `read_file @read_file`,**「反复调同一个工具」与「反复做同一件事」不可区分** —— 地板上的这一处误报面是已知且被接受的 |

取第 ① 级时逐条扫而不是只看第 0 条:一行可以带多个 tool_use 块,第 0 块可能恰好是 `""` 占位。

多条判据**可并存**(`detectSupervisor` 返回数组):悬挂前的循环痕迹与当前 stall 同时上报
才是有用的诊断,只给一个信号时人还得自己判断。

两条判据可信度的根,写在 `src/supervisor/detect.ts` 顶部注释里(⚠️ 别当 bug 改掉):

1. **空 `events` 不报 stall**。空数组有两种无法区分的成因:attempt 刚起跑(journal 还没写
   第一行,摄取是 30s 一轮的旁路 poll)、journal 缺失/未提交。「最后一条距今 = 无穷大」这种
   写法会让**每一个刚起跑的 attempt 立刻吃一条 red**。「没有证据」不等于「卡住了」。
2. **参数必须归一化才能判重复**。真实 transcript 里同一个动作的两行永远不字节相同:时间戳
   每行都变、临时目录带随机后缀、uuid/sha 每次不同。不归一化则 `repeat_count` 恒等于 1,
   两条判据**静默地永远不触发** —— 最坏的失效形态:看起来接了线,其实什么也不检查。
   `normalizeTarget` 把 ISO 时间戳 / epoch / uuid / 长 hex / 纯数字段折成占位符,把 `tmp`、
   `worktrees`、`.cache` 等临时目录以下整枝砍成 `<...>`,再把路径与命令行分别成形。

#### 两次塌缩 —— 判据的分辨率天花板永远在摄取侧

**第一次(c10 落地时)**:分辨率的天花板由 Observation 层的白名单决定,而且**修也只能修在那一层**:c10 落地时
`tool_use` 的 target 永远取不到文本(input 参数不进 journal,而 `text` 对 `tool_use` 不写),
于是 `repeat_key` 塌成 `read_file @read_file` —— 「连续 5 次读 5 个不同文件」会命中 loop
yellow,判据把「反复调同一个工具」当成了「反复做同一件事」。`detect.ts` 手里已经没有那个
信息了,在这里猜没有意义。所以 §9.5 补了 `payload.tool_targets`(按键白名单 + 打码 + ≤128),
target 因此有了上面的三级取值。仍然要说清楚的是:

- **`stall` 判据与这件事无关**(它只读 `ts`),c10 的验收标本 C2-r6 那类模型悬挂的结论一个字
  不改;本棒改的是另外两条判据的分辨率。
- **shadow 样本必须按 `tool_targets` 是否存在分段统计**,不能混算。混在一起等于把 c10a
  之前那批误报算进之后的判据可信度里 —— 两批样本的判据语义其实不同(旧样本 target 恒为
  工具名或叙述文本,新样本是真实的入参目标)。分段口径:`tool_targets` 存在且至少一个非空
  条目 → target 来自入参,这一段的 loop / no_progress 命中率才能用来讨论 enforce;缺失 →
  要么落在旧段、要么该工具的 input 里没有白名单键(两者在事件字节上不可分辨,所以要再用
  「摄取时刻是否晚于 c10a 部署点」切一刀)。整键缺省而不是写空数组,正是为了让这一刀切得动。
- 归一化仍然会吃掉一部分分辨率(同一目标带上不同时间戳/随机 id 会被折成同一个键),这是
  上面第 2 条立场里明说的取舍,不是本棒引入的。

**第二次(c14 首样本,本棒修)**:同一个失效类的第二种形状 —— 键**有**,但被折成了一个。
旧的 `commandShape` 把 `&&` / `||` / `;` 当普通 token 边界(它只看「首词 + 首个不以 `-` 开头的
实参」),于是 `cd X && <任何事>` 一律塌成 `cd X`。prod 事实:任务 `c08c3242…` / writer attempt
`4b5e9588…` **跑到 DONE、退出码 0**,36 次 shell 调用里 **35 次共用这一个键**(不同键 2 个、
主键占比 **0.97**;被折进去的动作是 sed ×15、grep ×11、tsc、timeout、git log、ls、wc),
loop 与 no_progress 于是在启动两分钟内各亮一条黄(`seq=4` `repeat_count=5` / `seq=5`
`repeat_count=9`,两条都 `mode=shadow, enforced=false`)。

塌缩在**摄取侧**发生、在**判据侧**被消费,中间没有任何一步能还原:`targetOf` 拿到的已经是
`cd /workspace/repo`,而 `normalizeTarget` 做的正是同样的「首词 + 首个非 flag 实参」——
对已经塌缩的串无能为力。所以修只修 `src/obs/events.ts` 的 `commandShape`,`detect.ts`
一个字没动,**窗口与阈值的数字也一个没动**(唯一权威仍是上面那张规则表)。

修后的复算(夹具:`test/fixtures/shell-command-shapes.ts`,12 条取自那批真实命令行):

| 项 | 修前 | 修后 |
| --- | --- | --- |
| 不同键数(12 条夹具) | 2 | **11** |
| 主键占比 | 11/12 | **2/12 = 1/6** |

- 为什么是 11 而不是 12:夹具第 2、5 条的 grep 都打在 `src/control/session.ts` 上,选中段的
  「首个可当目标的实参」是同一个路径。**模式文本被排除在形状之外是刻意的**(§9.5「什么算
  可当目标的实参」),这一处合并就是它的代价 —— 换来的是真空转的键不随模式漂移。
- 双向判别(三条都有名有姓,不是调完数字再看一眼):① 12 条各跑两遍 = 24 条行为事件 ⇒
  loop / no_progress **零命中**;② 同一动作的重复仍命中 —— 换 sed 行号区间、换管道尾巴、
  换 grep 模式都不拆开键,裸 `cd /workspace/repo` ×8 仍报两条。**② 比 ① 重要**:只做到 ①
  的实现等于把这两条判据阉掉;③ 单竖线不分段各有一道独立用例(摄取侧 + 判据侧)。
- **不许拿存量 journal 复算这次修复**:`tool_targets` 存的是塌缩**之后**的形状,塌缩有损,
  原始命令行在 Observation 层根本不存在(操作员核过:c14 writer 的 journal 全文里 `&&` 只
  出现在 11 条 `tool_result` 的**输出文本**中,`tool_targets` 里一条没有)。原始命令行只在
  Raw transcript(R2 ARTIFACTS,`GET /api/tasks/:id/attempts/:aid/transcript`),而沙箱不持
  prod 凭据 ⇒ **prod 侧的键分布要部署后由操作员重取**。本棒能交付的结论止于「夹具上键被拆开
  + 判据在重复输入上仍命中、在多样输入上仍闭嘴」。
- 残留的误报面(如实写,不藏着):形状现在是**每个动作**一个键,所以「同一窗内对同一个文件
  跑满 loop 阈值次数的 sed」仍会亮黄 —— 那正是这条判据的定义(数字只在上面那张规则表里推导
  一次),不是本棒的失效;④ 的结案要靠部署后的新 shadow 样本,而不是把 ② 那批用例改成不报。

### `supervisor_finding` 事件 payload

```json
{
  "attempt_id": "…",
  "kind": "stall",
  "rule": "stall.last_event_gap",
  "severity": "red",
  "evidence": {
    "last_event_ts": "2026-09-02T11:22:31.000Z",
    "gap_ms": 1440000,
    "window_size": 362,
    "repeat_key": "run_shell_command@npm test",
    "repeat_count": 7
  },
  "mode": "shadow",
  "enforced": false
}
```

`kind` ∈ `stall | loop | no_progress`;`rule` 是稳定字符串(进事件、进去重键,不要改);
`gap_ms` 在时间戳不可解析时为 `null`(不猜);`repeat_key`/`repeat_count` 只有两条重复类判据
带。`mode`/`enforced` 是**自描述**字段:将来若有 enforce 模式,读事件的人不必查版本就知道
这条当时有没有杀伤力 —— 链上出现过的 payload 永不改写,所以这两个字段必须现在就写对。

### 幂等:去重键与冷却期

同一 `(attempt_id, kind, rule, severity)` 只在三种情况下产生事件:

1. 首次出现;
2. **severity 升级**(yellow→red;判据是「低一档已报过且不晚于本档上一次」,所以
   `red → 短暂恢复 → yellow → red` 的第二次 red 不会被吞);
3. 距上次上报超过冷却期 `SUPERVISOR_DEDUPE_COOLDOWN_MS = 600_000`(10 分钟,可注入)。

去重表存在 **DO storage 键 `supervisor:reported`**,不存在 alarm 的局部变量里 —— 每次 alarm
触发是独立的一次请求,局部变量随请求结束消失,等于完全没有去重:一次 38 分钟的悬挂会往权威
链灌 ~38 条同样的事件。权威链是事实底座,不是日志垃圾桶。

### alarm 节奏修正(不做则 Supervisor 无意义)

| | 修正前 | 修正后(shadow) |
| --- | --- | --- |
| 续期时刻 | `max(min(attemptDeadline), now + 60s)` —— **纯截止驱动** | `min(上面的既有结果, now + SUPERVISOR_TICK_MS)` |
| attempt 不死时 | 不醒 | 每 60s 醒一次 |
| C2-r6 形态(悬挂 24 分钟、墙钟还剩 ~14 分钟) | 悬挂期间 alarm **一次都不触发** | 悬挂期间醒来 ~14 次。c10b 双时间源后这一形态入链的是 `stall.agent_silent` / **yellow**(静默满 900s 后的那次 tick),不是 red —— 挂的是容器内的模型调用,poll 相每轮仍写心跳,而 red 现在只说「runner 停了」 |
| `SUPERVISOR_MODE=off` | — | **不传 tick**,逐字段等于修正前(回归证据,`test/statemachine.test.ts` 钉住) |

改动只落在 `statemachine.ts` 的纯函数上(加一个可选参数),`session.ts` 只决定「传还是不
传」。tick 不早于 `WATCHDOG_MIN_INTERVAL_MS`:alarm 自旋会白烧 DO 请求,而 60s 已是最细的
有效观测节拍(摄取的实测中位轮次 33s,更密只会看到同一批事件)。

### 降级与故障纪律

- 某个 attempt 的 journal 读抛错 → 跳过该 attempt,记 `console.warn` 一行
  (`supervisor_journal_unavailable task=… attempt=…`),**不抛、不影响其他 attempt、不改
  任务状态**。抛出去等于让 Supervisor 自己成为把任务搞死的新原因(alarm 整轮失败会连带
  watchdog 续期一起丢掉)。真实坏 index 的用例在 `test/supervisor-do.test.ts`(写一个
  `v: 99` 的 index,另一个 attempt 照常上报)。
- 降级**不进权威链**:它不是关于任务的事实,是关于平台的;而且每 60s 一条的故障噪声还得
  自己再去重一遍。仓内同类观测面降级(§9.5 的坏行)走的也是 `console.warn` 这条通道。
- 「逐条检查、大声失败」与「对外降级」不矛盾:对内(不可解析的时间戳、坏 index)一律显式
  跳过并留痕,对外(整条 alarm 路径)绝不外抛。

### 验收标本与本期边界

验收标本仍是 **C2-r6:单次模型调用悬挂 24 分钟**(§13.19)。c10 写的「5 分钟内可发现」随
300s red 一起作废 —— 那个算式假设「最后一条事件停滞 = runner 停了」,而该前提已被 prod 证伪
(证伪过程与重标定后的数字见上面「阈值的来源与天花板」)。按 c10b 的口径,这类悬挂的最迟入链
时刻是 **静默 900s + 一个 tick(60s)≈ 16 分钟**,结论是 `stall.agent_silent` / yellow;
red 档留给「连心跳都没了」这种形状,阈值 180s + 一个 tick ≈ 4 分钟 —— 而这一档旧口径**根本没有**
(旧的那条线分不清「模型不产字」与「摄取通道死了」)。所以净变化是:模型静默这一档变慢了,
换来的是不再对健康任务误报(实测静默过 576s),并多出一条能真的说「runner 停了」的红线。
误报的判据一旦 enforce,等于拿假设当处置依据。
**yellow 的时延能不能压回 5 分钟,是 shadow 样本要回答的问题**
(见上面推进条件表),不是重标定时钟能回答的。

本期明确不做:

| 不做 | 为什么 |
| --- | --- |
| 任何处置(cancel / kill / BLOCKED / 返工 / 改路由) | 观察与裁决分离;判据是启发式,误报面未量测 |
| `enforce` 模式 | 同上 —— 先攒 shadow 样本,样本判据达成前不翻 |
| 外部告警(邮件 / webhook / 钉钉) | finding 已经进权威链,`/api/admin/events` 与 §9.6 的流都是出口;再加一条出口只多一个凭据管理面 |
| 新建 DO / Cron Trigger / 独立 Worker | 寄生在既有 alarm 路径里才零协调成本,且**单写者天然保持** |
| 改 §9.5 的 journal/ingest/事件协议、§9.6/§9.7 的 SSE 与 Live UI | 只读复用。特别是不能为了判据去给 journal 加未脱敏字段 |
| 多任务聚合视图 | 本期逐 attempt 判据;跨任务全局视图留下一期(它要的是另一个读面,不是另一套判据) |
| 阈值调优 | 缺省值取「与 Live UI 同一把尺子 + 窗内明显超出常态」;调优是 shadow 样本攒够之后的事 |

---

## 10. 人工审批(HITL)与证据绑定

`POST /api/tasks/:id/approve` 接收 `{ decision: "approve" | "reject", actor?: string, attempt_id, evidence_digest }`,后两者**必填**(`submitDecision` 强制)。`accept_with_notes` 是控制面内部的降级决策(reject 举证不成立时由它写),**不由外部提交**;其它值 → 400 `invalid_decision`:

1. `evidence_required` — 缺 `attempt_id` 或 `evidence_digest` → 400
2. `attempt_not_writer` — attempt 必须是 writer(裁决对象是候选本身)→ 409
3. `evidence_mismatch` — 提交的 digest 必须等于控制面计算的组合证据 `composite([writer, verifier?])`,防"批的不是看的那份证据" → 409
4. `task_not_awaiting` — 仅 `AWAITING_APPROVAL` 可裁决 → 409
5. 通过校验 → `finishApproval`:记 `decision.recorded`(带组合 evidence_digest + fencing_token)→ CAS → DONE/REJECTED → `notifyWriter` 唤醒 writer workflow → 归档 D1(失败挂 30s alarm 重试)

组合证据的组成(见 §13.9):
- **人工审批**绑定 `[writer, verifier?]` — 调用方从 `GET /api/tasks/:id/evidence` 的 `binding_digest` 字段获取,先取证、后裁决
- **自动裁决**(reviewer)由 DO 内部附裁决者自身证据:`[writer, verifier?, reviewer]`

**绑定口径只有一个来源**(M7,见 §13.12):`task.current_evidence` 由控制面在 writer/verifier 回报时钉住,`computeBindingDigest`、`GET /evidence` 与 `submitDecision` 全部读它。此前 `/evidence` 取"任意角色最新 manifest"、审批按 created_at 启发式挑 verifier,两处口径不同会让一次**本来正确的**人工审批永久 409。`accept_with_notes` 同样落 DONE,advisory 内容留在事件链里,不产生返工。

`actor` 默认 `human:api`;接入 SSO / 审批系统时改成 `human:<user-id>`。M5 起已有自动裁决分支:reviewer 纯 LLM 裁决(见 §13.6),人工审批与之互为兜底,先到先决、后到幂等忽略;`awaiting_human` 的任务只认人工(§13.12)。

---

## 11. API 参考

所有路径前缀为 Worker 的 public URL(`wrangler.jsonc` 的 `PUBLIC_URL`,当前 `https://cloud-agent.aflow.workers.dev`)。

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/` | 无 | 落地页(环境 + 端点列表) |
| GET | `/healthz` | 无 | `{ ok: true, env }` |
| POST | `/api/tasks` | `Bearer $WORKER_API_TOKEN` | 创建 task + 首个 attempt,启动 workflow;`spec.acceptance[]`(可选,≤8 项、每项 3–500 字符,非法 → 400 `invalid_acceptance`)、`spec.base_sha`(可选,全长度小写 hex;非法 → 400 `invalid_base_sha`,不落库、不起沙箱)、顶层 `review_evidence_mode`(可选 `shadow`/`enforce`,覆盖环境变量);返回 `{ task_id, attempt_id, workflow }` |
| GET | `/api/tasks/:id` | `Bearer $WORKER_API_TOKEN` | 返回 `{ task, attempts[], events[] }`,含 `task.result_text` 与 `task.base` |
| GET | `/api/tasks/:id/result` | `Bearer $WORKER_API_TOKEN` | `text/plain` 直出 agent 最终答案;尚未提取到返回 404 `{ error: "no_result_yet" }` |
| POST | `/api/tasks/:id/approve` | `Bearer $WORKER_API_TOKEN` | 裁决 `approve`/`reject`,必填 `attempt_id` + `evidence_digest`(组合证据);缺 400 / 不匹配 409。`accept_with_notes` 是内部降级决策,不由外部提交 |
| GET | `/api/tasks/:id/evidence` | `Bearer $WORKER_API_TOKEN` | 返回钉住的 writer manifest JSON + `binding_digest`(approve 应提交的组合证据) |
| GET | `/api/tasks/:id/candidate` | `Bearer $WORKER_API_TOKEN` | 候选交付视图(只读投影,不新增状态对象):`{ status, verified, safe_to_apply, base, patch, writer_attempt_id, verifier_attempt_id, decision, binding_digest, warnings }`。`status ∈ unverified \| verified \| verification_failed \| approved \| rejected \| held_for_human`;`base` 是**这份候选自己的**基线(manifest 血统),与任务当前基线不一致时进 `warnings`。尚未有钉住候选 → 404 `no_candidate_yet` |
| GET | `/api/tasks/:id/candidate?format=patch` | `Bearer $WORKER_API_TOKEN` | `text/plain` + `Content-Disposition: attachment; filename="task-<id>-<patch digest 前 12 位>.patch"`。**下发前重算补丁字节 sha256 并与 manifest 记录的 digest 比对**,不一致 → 500 `integrity_error`,不把未校验字节交出去。判定进响应头 `x-candidate-status` / `x-verified` / `x-safe-to-apply` / `x-base-sha`,只看头也不会把被否决的候选当成可提交成品 |
| GET | `/api/tasks/:id/rescue` | `Bearer $WORKER_API_TOKEN` | **BLOCKED 专用抢救读面**(§7.2.2):被击杀 writer 那一轮的差量视图。字段与 `/candidate` 同形 + `rescued: true` / `pinned: false`;`binding_digest` 恒 `null`、`safe_to_apply` 恒 `false`。非 BLOCKED → 404 `not_blocked`;BLOCKED 但执行面未回报 manifest → 404 `no_rescue_yet` |
| GET | `/api/tasks/:id/rescue?format=patch` | `Bearer $WORKER_API_TOKEN` | 下载抢救差量正文,同样逐字节重算 sha256(不一致 → 500 `integrity_error`);额外响应头 `x-rescued: true` / `x-pinned: false` |
| GET | `/api/tasks/:id/events` | `Bearer $WORKER_API_TOKEN` | **在途事件流**(§9.5):直接读 R2 的 `obs/` 段文件 journal,**不经 D1 终态归档**,所以任务 `RUNNING` 期间就有内容。返回 `{ task_id, state, events: AgentEventV1[], count, total, next_cursor, unreadable_attempts }`;按 attempt 创建序、attempt 内按 `generation`/`seq` 升序。`?after=`(扁平流上已读的条数,缺省 0)、`?limit=`(缺省 500,上限 2000;非法 → 400 `invalid_after`/`invalid_limit`)。任务不存在 → 404;从未摄取过 → 空列表 |
| GET | `/api/tasks/:id/events/stream` | `Bearer $WORKER_API_TOKEN` | **在途事件的 SSE 投影**(§9.6):`text/event-stream`,与 `/events` 同一份 journal、同一个位置游标的两种读法(推/拉),互为恢复源。帧 `id` = **该帧之后已读的条数**(扁平序 1-based 位置),与 `?after=` 完全同口径 → 断线带 `Last-Event-ID: <id>` 续传不重发也不漏读(header 缺省 = 0 = 从头回放;值为空或畸形 → 400 `invalid_last_event_id`)。每拍 3s 尾读增量,零新增发 `: ping` 注释帧;任务离开 `RUNNING` 且增量推完 → 一帧 `event: end`(id = 总条数,`data` 带 `unreadable_attempts`)后关流。某 attempt 的 journal 读不到只列进 `unreadable_attempts`,**不杀流**。任务不存在 → 404(在建流之前判定)。**只读投影:不写任何权威状态** |
| GET | `/api/tasks/:id/attempts/:aid/transcript` | `Bearer $WORKER_API_TOKEN` | 流式透传 R2 里的 transcript 原文 |
| GET | `/live/:taskId` | `Bearer $WORKER_API_TOKEN` | **Live UI**(§9.7):第④层投影的人眼端。返回 `text/html`(`cache-control: no-store`),CSS/JS **全内联**、零外部依赖、无构建步骤;页面自己用 `EventSource` 连上一条端点(浏览器按标准重连并回传 `Last-Event-ID`,与帧 `id` 同口径 → 续传不需要 UI 侧代码)。顶部 = 任务 id + state 徽章;主体 = 事件时间线按到达序渲染 `seq`/`kind` 徽章(清单派生自 `OBS_EVENT_KINDS`)/`ts`/`payload.text` 摘要(>200 字符截断并标注全文长度),`tool_use` 附 `tool_names`、`raw` 附 `raw_type`、`result`/`error` 视觉强调。**核心价值 = 停滞检测**:显著位置一条 pill 每秒自增,c10b 起是**两条时间源、三个说法** —— 平时「最后事件 Ns 前」,心跳停止 >180s 转红并改口「心跳停止 Ns(runner 停了)」,模型静默 >900s 转黄并改口「模型静默 Ns(runner 活着)」;静默那一档**永不转红**(两个阈值的推导与理由只在 §9.8 出现一次,页面只是它的读者)。收到 `event: end` → 显示「流已结束」并停止计时。前端防御性解析:坏帧跳过并计数,`onerror` 有**分枝**的可见提示(401 不承诺重连)。鉴权与 `/api/tasks/:id/events*` 同源(无凭据 401、任务不存在 404,均在生成 HTML 之前判定 —— 要守的是**任务存在性**本身,不只是 payload);`taskId` 按上下文分两套转义(HTML 文本节点 / JS 字面量)。**只被动显示:不做任何判定、不做任何处置**(Supervisor 是独立消费者层,下一期)。⚠️ `EventSource` 不能携带 `Authorization` 头 → prod 无凭据直开得到 **401(预期:全局鉴权门有意覆盖这个出口)**;而 401 与网络断连按 `es.readyState` **可区分**(401 → 2/CLOSED 且永不重连,拒连 → 0/CONNECTING 且每 3s 重连),页面据此分分支提示,401 下如实写「不会自动重连」并指向带凭据的 API 客户端。浏览器可达性等后续产品化会话方案统一解决,**本期不引入任何临时凭据出口**(详见 §9.7「已知的部署侧前提」) |

### 典型调用序列

```bash
# 1. 创建任务
TASK=$(curl -sS -X POST $BASE/api/tasks \
  -H "Authorization: Bearer $WORKER_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"spec":{"prompt":"..."}}' | jq -r .task_id)

# 2. 轮询状态
while :; do
  STATE=$(curl -sS $BASE/api/tasks/$TASK \
    -H "Authorization: Bearer $WORKER_API_TOKEN" | jq -r .task.state)
  echo "state=$STATE"
  [[ "$STATE" =~ ^(AWAITING_APPROVAL|DONE|REJECTED|BLOCKED)$ ]] && break
  sleep 10
done

# 3. 读 agent 答案
curl -sS $BASE/api/tasks/$TASK/result \
  -H "Authorization: Bearer $WORKER_API_TOKEN"

# 4. 取证并审批(组合证据强制绑定)
EV=$(curl -sS $BASE/api/tasks/$TASK/evidence \
  -H "Authorization: Bearer $WORKER_API_TOKEN")
WRITER_ID=$(echo "$EV" | jq -r '.manifest.attempt_id')
BINDING=$(echo "$EV" | jq -r .binding_digest)
curl -sS -X POST $BASE/api/tasks/$TASK/approve \
  -H "Authorization: Bearer $WORKER_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"decision\":\"approve\",\"actor\":\"human:me\",\"attempt_id\":\"$WRITER_ID\",\"evidence_digest\":\"$BINDING\"}"

# 5. 取回候选并在它的基线上本地重放(这一步才是"补丁 Harness"的验收终点)
CAND=$(curl -sS $BASE/api/tasks/$TASK/candidate -H "Authorization: Bearer $WORKER_API_TOKEN")
echo "$CAND" | jq '{status, verified, safe_to_apply, base, warnings}'
BASE_SHA=$(echo "$CAND" | jq -r .base.sha)
curl -sS -OJ "$BASE/api/tasks/$TASK/candidate?format=patch" -H "Authorization: Bearer $WORKER_API_TOKEN"
git -C /path/to/repo fetch origin "$BASE_SHA" && git -C /path/to/repo checkout --detach "$BASE_SHA"
git -C /path/to/repo apply task-$TASK-*.patch
```

---

## 12. 部署与运维

### 资源清单(wrangler.jsonc)

| 类型 | 名称/绑定 | 用途 |
|---|---|---|
| D1 | `DB` = `cloud-agent` (8b42f506…) | 终态归档 + 查询 |
| R2 | `ARTIFACTS` = `cloud-agent-artifacts` | 沙箱产物、transcript、verify |
| R2 | `EVIDENCE` = `cloud-agent-evidence` | manifest |
| Workflow | `ATTEMPT_WORKFLOW` = `attempt` | Durable Workflow 注册 |
| Queue | `REVIEW_QUEUE` = `cloud-agent-review`,DLQ = `cloud-agent-review-dlq` | fan-out 通道:`review-request`(派 reviewer)+ `verify-request`(派 verifier,M6 复用,不新增队列) |
| Queue | `REPORT_QUEUE` = `cloud-agent-report`,DLQ = `cloud-agent-report-dlq` | workflow → DO 回报通道(经 session_id 路由) |
| Container | `Sandbox` = `registry.cloudflare.com/34817bdd…/cloud-agent-sandbox:qwen-0.21.10` | 自建沙箱镜像(`sandbox/Dockerfile`,base = `cloudflare/sandbox:0.8.14` + qwen-code 预装) |
| Durable Object | `Sandbox` | 容器绑定 |
| Secret | `DASHSCOPE_API_KEY` | 百炼 token-plan 高权 key,Worker 侧 reviewer 直调用;并在下一行缺配时作为沙箱回落值 |
| Secret | `SANDBOX_MODEL_API_KEY` | 沙箱专用低权 key,注入容器当 `OPENAI_API_KEY`;可单独撤销。**可选** —— 缺配时回落上一把并打 `credential_fallback` 告警,即回到「沙箱泄露 = 控制面凭据泄露」的状态;真正的降权要等这把它配上 |
| Secret | `WORKER_API_TOKEN` | 控制面 API token |
| Var | `DEFAULT_MODEL` = `qwen3.8-flash` | 默认模型 |
| Var | `DEFAULT_MAX_MODEL_TOKENS` = `5000000` | 软上限,基本不触达 |
| Var | `DEFAULT_MAX_WALL_SECONDS` = `3600` | 单 attempt 1 小时。**只是缺省值**,算术全在 `src/control/budget.ts`:未给预算时取它,给了非法值则回落 `3600` 并打 `budget_default_invalid` 告警(§7.2.2) |
| Var | `MAX_WRITER_WALL_MINUTES` = `40` | writer 沙箱墙钟上限(分钟),**可选 + 回落** —— 缺配/非法回落 `MAX_SAFE_WALL_MINUTES = 25`(§13.18 的 workerd ~29:48 挂起墙)。它只降 writer 能力,不改 DO alarm;生效即落一条 `budget.clamped`(§7.2.2) |
| Var | `DEFAULT_MAX_SESSION_TURNS` | writer 的 turns 闸,**可选 + 回落** —— 缺配/非法时随墙钟推导(≈8 turns/min,下限 40)。prod 未设,故 `wrangler.jsonc` 里不出现 |
| Var | `REJECT_EVIDENCE_MODE` = `shadow` | reviewer 证据硬校验模式:`shadow` 只记事件、`enforce` 才降级返工(§13.12) |
| Var | `BASE_PIN_MODE` = `shadow` | 基线材质化失败的处理:`shadow` 回落已解析的默认分支并记 `base.fallback`、`enforce` 直接 `BLOCKED` 转人工(§13.13)。**两种模式都真实使用冻结基线材质化工作副本**,只在失败路径上分叉;verifier 侧恒为 enforce |
| Var | `ROUTING_INFRA_MODE` = `shadow` | writer 侧 provider 错误的分流档位,**可选 + 回落**:三档 —— `off`(判据当不存在,逐字段等于没有这一棒)/ `shadow`(照分类并落一条 `route.infra_candidate`,**路由动作一字不改**)/ `enforce`(确定性 provider 错误不派返工,直接 `BLOCKED` 转人工)。缺省与非法值都落 `shadow`(§13.23) |
| Var | `EGRESS_MODE` = `enforce` | 沙箱出站策略:`shadow` 只记账放行、`enforce` 白名单拒绝(§13.14)。有否决权的策略,先 shadow 取样再翻 |
| Var | `EGRESS_GIT_HOSTS` = `github.com` | 出站白名单的代码托管主机(逗号分隔);模型主机从 `MODEL_UPSTREAM_BASE` 推导,不经此变量 |
| Var | `MAX_PATCH_BYTES`(未设,代码默认 `1048576`) | 候选 patch 字节上限,**可选 + 回落**;超限在容器内 `exit 24`、不回传字节(§13.17) |
| Var | `SUPERVISOR_MODE` = `shadow` | Supervisor(第②层的独立消费者)启用点:**代码缺省 `off`**,必须显式写 `shadow` 才生效(可审计的启用点)。`shadow` = 只往权威链记 `supervisor_finding` 事件,**不做任何处置**;本期不存在 `enforce` 路径(§9.8) |
| Var | `SUPERVISOR_TICK_SECONDS` = `60` | shadow 模式下 alarm 的 tick 间隔(秒),**可选**,缺省 60(= `WATCHDOG_MIN_INTERVAL_MS`)。它给截止驱动的 alarm 加一条更早的醒来节奏,使悬挂期间也能判一次(§9.8) |

### 部署动作顺序

1. 改 D1 schema → `npm run db:migrate:remote`(CI=true 绕过交互)
2. 改 `sandbox/Dockerfile` → 构建并推送镜像,再把 `wrangler.jsonc` 的 `containers[0].image` 指向新 tag:
   ```bash
   docker build --platform=linux/amd64 -t cloud-agent-sandbox:qwen-<ver> sandbox
   npx wrangler containers push cloud-agent-sandbox:qwen-<ver>   # → registry.cloudflare.com/<account>/…
   ```
   镜像 tag 每次升级都要换(容器只在 tag 变化时重拉),`linux/amd64` 是 Cloudflare 侧的硬性要求。
3. 改代码 → `npx wrangler deploy`(自动带 container 检查)
4. 改 secret → `npx wrangler secret put ...`

**换镜像与删冷装不要紧接在一起上线**(M7c 实测):把 `containers[0].image` 换成自建镜像的同一次部署里删掉 `npm install -g` 兜底,部署后的**头几个 attempt 会命中仍在服务旧镜像的热实例** → `qwen: command not found` → `exit_code=127`(旧镜像里没有 qwen)。平台按实例逐个换血,窗口期约几分钟;每个任务因此白烧一轮返工预算。缓解:先只部署镜像(保留兜底安装)→ 等热实例换完 → 再删兜底。

**注意**:worker 启动时即查 `tasks` 等表,如果 migration 没跑,所有涉及 D1 的端点会立刻 500。先迁移、后部署。

**取证与部署会撞到的平台事实**（M8 实测，逐条都卡过）：

- **wrangler 的 OAuth bearer 打不通 D1 与 Workflows**。同一个 bearer 在 Workers Scripts / R2 / Queues / `/user` 上全部正常，唯独这两个产品的 API 回 `{"code":10000,"message":"Authentication error"}` —— 而 token 的 scope 列表里 `d1:write` 明明在。原因与 scope 无关，是**凭据类型**：wrangler 只发 `Authorization: Bearer`（从不发 `X-Auth-Token`），而这两类 API 只认用户 API token。解法是 `export CLOUDFLARE_API_TOKEN=cfut_…`（该环境变量**完全覆盖**已存的 OAuth 配置），此后 `d1 execute --remote` / workflow 相关命令即恢复。
- **脚本库 UA 会被 Cloudflare bot 防护拦下**。`curl` 的默认 UA 放行（200），但 `Python-urllib` 这类库 UA 一律 `403 / error code 1010` —— 对 `*.workers.dev` 上的控制面 API 和对 `dash.cloudflare.com/oauth2/token` 都一样。表现像"token 无效"或"端点挂了"，实际是 UA 指纹，排查时先换 UA 再怀疑凭据。
- **secret 与 plain var 不能同名**：`wrangler secret put BASE_PIN_MODE` → `code: 10053`（该名字已是 `wrangler.jsonc` 的 vars）。要临时改这类策略开关，只能改配置再部署。
- **桶别搞错**：manifest 在 `EVIDENCE`（`cloud-agent-evidence`），transcript / stderr / patch 产物在 `ARTIFACTS`（`cloud-agent-artifacts`）。`wrangler r2 object get` **不接受** `--force`（那是 `put` 的参数），且 `--file` 失败时不会留文件，容易误判成"下载成功但内容为空"。

---

## 13. 已知缺陷与改进方向

### 13.1 events hash chain 并发分叉 — 已修复(0003 + seq CAS)

~~`appendEvent` 用 `ORDER BY created_at DESC, rowid DESC` 取 prev_digest,同一 task 并发 append 会读到同一个 prev 写出 sibling,链分叉。~~

修复(`migrations/0003_add_event_seq.sql` + `authority.appendEvent`):events 增加按 task 单调的 `seq` 列,`UNIQUE(task_id, seq)` 做 CAS;append 时单条 SELECT 原子取 `MAX(seq)+1` 与 prev digest,INSERT 冲突即重读重试(最多 5 次)。链不会分叉。

**修复时发现并处置了一个真实分叉**:任务 `8ba58c8c` 在旧代理架构下,budget.exhausted 与 model.call 同一秒(created_at 秒级精度)并发写入,seq 7/8 同时指向 seq 6。已按序重算 digest 将分叉重链,修复后全库断链检查 `broken = 0`。

**历史分叉尸体的归档面后果(c11b 补)**。写层修好 ≠ 存量干净:`J.2` 全量重放「84 链 0 broken」说的是
**新任务**不再分叉,而 pre-c11a 已经写坏并被 DO 快照冻结的老损伤仍然原样躺在 storage 里。prod 标本
`5489dc8a-a2bd-4b81-85be-3265f7a77bb6`(BLOCKED)的 `GET /api/tasks/<id>` 读出 29 条事件,其中
seq 4–9 各有 4–5 份重复(同 seq、`prev_digest` 各不相同)。

要分清谁是受害者:**权威层自己没事** —— DO 是权威,读面按到达序工作,重复那份只是多显示一遍。
**只有 D1 归档读模型与审计回放受害** —— 归档的 DELETE-then-INSERT 清掉旧行之后,同一批内第 2 条相同
`(task_id, seq)` 的 INSERT 自撞 `idx_events_task_seq`,于是这条任务**永远进不了 D1**:`/api/admin/events`、
`/api/admin/tasks`、全局 chain-check 全都看不见它(它一次都没归成档)。当年唯一的可见面是容器日志里的
`archive_stalled` + 那句 `UNIQUE constraint failed`,对全部现有仪器不可见。

现在的形状:归档在构批之前**具名拒收**(`archive_rejected`,§6.2.4),而 `?task_id=` 对账模式对 DO 全量
事件做重号扫描(`:seq` 破口,§6.2.3)—— 这类损伤从此在仪器上是**主动可见**的,不再需要日志考古。

**遗留尸体的处置是 open options(操作员的产品决策,本棒不实现任何一种)**:

1. **留档不归档**:接受它永不进 D1,靠 DO 读面 + `?task_id=` 对账兜住。零写风险;代价是审计回放有
   永久缺口,且这份权威链只存在于 DO storage —— DO 一旦被淘汰就再无第二次机会(§6.1 第 5 条)。
2. **手术修快照**:人工判定「哪条是真」、删掉孤儿分支、按序重算 digest 重链,之后归档自然成功(§13.1
   对 `8ba58c8c` 就是这么做的)。**必须连同权威层的审计记录一起做** —— 谁在何时以何依据删了哪几条;
   否则修完的链虽然自洽,却成了一份不可自证的档案。
3. **隔离归档**:给这类任务开一条允许重号的旁路(独立表,或放宽 UNIQUE)。慎选:那是 **D1 语义变化**,
   而 `UNIQUE(task_id, seq)` 正是 c11a 的 seq CAS 机制本身(migrations/0003)—— 除非确认旁路行不参与
   CAS 且不会被任何校验口径误读,否则不要走这条路。

不许做的第四种:用 `INSERT OR REPLACE` / `ON CONFLICT` 在归档层静默去重 —— 那是伪造审计记录,理由见 §6.2.4。

### 13.2 budget overshoot 窗口 — 已随代理废弃消除

~~proxy 的 settle 是异步的(`ctx.waitUntil`),burst 里多个请求读到旧值同时放行,最终越过 max_model_tokens。~~

直连架构下不存在代理放行路径:token 记账是 workflow extract step 的单次事后写入(`SET tokens_used = ?`),无并发窗口。剩余风险:直连后 Worker 无法实时拦截超预算,预算语义改为"时长/turn 由 qwen-code 参数硬停 + tokens 事后归因"(见 §8)。

### 13.3 沙箱镜像与 SDK 版本漂移 — 已对齐

~~三处版本不一致(0.8.9 / ^0.8.9 / 0.8.14)~~

M7c 之后版本只有一处权威:`sandbox/Dockerfile` 的 `FROM docker.io/cloudflare/sandbox:0.8.14`。`wrangler.jsonc` 的 `containers[0].image` 指向由它构建并推送的镜像(`registry.cloudflare.com/<account>/cloud-agent-sandbox:qwen-0.21.10`),`package.json` 的 `@cloudflare/sandbox` 必须留在**同一条 release line**(SDK 与容器内 supervisor 协议配套)。升级顺序:改 FROM → build/push 新 tag → 改 `containers[0].image` → 对齐 SDK → deploy。

### 13.4 reasoning model 的 token 爆炸 — 未修复(剩余)

qwen3.8-flash 带 reasoning,单次调用 tokens 可能很高(内部推理 + 工具调用 + 输出)。当前靠 5M 软上限兜底,但 reasoning 开启后 1~2 个长任务就能触达。

改进:
- 暴露 `reasoning_effort` / `enable_thinking` 参数,任务级可选
- 给 attempt 加 `reasoning_tokens_used` 单独列,和 completion tokens 分开看
- 在 landing page / API 提供"任务预估 token 区间"的经验值

### 13.5 老任务缺 result_text — 已实现(`POST /api/admin/backfill-results`)

~~`migrations/0002` 上线前产生的 task,`result_text` 全部为 null,需手动拉 R2 回填。~~

已实现 `POST /api/admin/backfill-results`:扫 `result_text IS NULL` 的 task → 经 events 定位 writer attempt 的 manifest → 读 R2 transcript → extract 结果与 tokens → 回填 `tasks.result_text` / `attempts.tokens_used`。首次执行回填 10/10。注意:代理时代失败任务的 result_text 会保留 `[API Error: ...]` 文本(如实反映失败)。

### 13.6 reviewer / verifier 角色 — 已闭环(含独立验证证据注入)

~~consumer 骨架就绪但上游没有发消息,reviewer 未生效。~~

已接通:候选验证/审查通过后才派 reviewer;reviewer 是**纯 LLM**(直接调百炼 `/chat/completions`,无工具,天然输出 JSON,不做任何任务执行;~~秒级~~ 这个前提是错的,prod 实测墙钟中位 27.0s、最慢成功 64.6s,详见 §13.23),裁决经 REPORT_QUEUE 回报 DO,DO 记录 `review.completed` + `decision.recorded`(绑定组合证据,见 §13.9)并 → DONE/REJECTED,再 `notifyWriter` 唤醒 writer workflow。

- **repo 任务**:writer 成功 → 独立验证器重放候选(§13.10)→ 验证通过才派 reviewer
- **reviewer 输入**(M7):review prompt 注入编号的【验收标准】(来自 `spec.acceptance`)、【独立验证结果】与【候选变更摘录】,并要求裁决按 `ReviewVerdict` 结构输出——reject 必须附 `failed_criteria` 索引、可执行的 `fix_instructions` 和喂入材料内可核对的 `evidence.quote`。旧的「验证失败必须 reject」措辞已删除:验证失败根本不会走到 reviewer(硬门禁直接 rework/REJECTED)
- reviewer 结论经 `parseReviewVerdict` 三阶段解析(JSON.parse → 抽取 JSON 子串 → 结构校验);**全部失败即 `decision:"none"`**,不再用关键词兜底成 reject(M7 前默认 reject 是返工放大器)
- reviewer 自身基建失败(`exit_code != 0`)→ `review.unavailable` + `awaiting_human`,停在 `AWAITING_APPROVAL` 等人工,**不触发返工**。三个 `exit_code=12` 位点(到期 abort / 端点非 2xx / 响应体读不懂)自 §13.23 起各带一个 `error_class` 枚举(与 writer 的 provider 分类同一份词表),`reason` 形如 `reviewer_unavailable:upstream_timeout` —— 处置一字未动,变的是原因可分辨(§13.23)
- reject 是否真的执行返工由门禁分级决定(§13.12);自动裁决与人工审批互为兜底,先到先决、后到幂等忽略,人工裁决必须携带组合证据(§10、§13.9)
- 曾用 qwen-code(带工具)跑 reviewer:即使 prompt 禁止也会真的执行任务,且结果经 NDJSON 提取器误解析 → 改为纯 LLM 后稳定

### 13.7 证据端点缺失 — 已实现

~~manifest / transcript / verify 只能通过 `wrangler r2 object get` 拉。~~

已实现(全部 `Bearer $WORKER_API_TOKEN`):
- `GET /api/tasks/:id/evidence` — 最新 attempt 的 manifest JSON
- `GET /api/tasks/:id/attempts/:aid/transcript` — 流式透传 R2 原文(text/plain)
- `GET /api/tasks/:id/attempts/:aid/verify` — verify 输出(未配置时 404)

### 13.8 DO namespace 分裂 — 已解决(session_id 显式路由)

~~workflow / queue consumer 环境里 `env.TASK_SESSION.idFromName(taskId)` 解析出的 DO namespace 与 fetch 环境不一致,`get()` 到"幽灵实例"(task=null),RPC 返回 `{ok:false}` 不抛错 → workflow step Success 但状态不更新。~~

证据:同一 task 的 reportExecution 到达 DO `960cb073`(task:null),getSnapshot 到 `1521a9af`(有数据);fetch 环境跨部署稳定解析同一实例 → 结论是**运行环境绑定的 namespace 不同**,不是版本钉扎。

修复:TaskSession DO 在自身环境生成 `session_id = this.ctx.id.toString()`(全局唯一),经 AttemptParams / queue 消息传递;consumer 用 `env.TASK_SESSION.idFromString(session_id)` + `get()` 精确路由。DO 实例 id 全局唯一,与 namespace 无关。教训:**跨环境(workflow/queue/fetch)RPC Durable Object 不要用 name 路由,显式传实例 id**。

### 13.9 证据门禁与组合证据绑定 — 已实现

~~两个硬伤:① writer `exit_code != 0` 后仍发 review、转 AWAITING_APPROVAL,失败产物可被批准;② `POST /approve` 的 attempt_id/evidence_digest 均可选,且只对比单个 attempt 的 manifest digest——人工裁决可以不带任何证据,或拿旧证据批新候选。~~

修复(控制面强制,不依赖调用方自觉):

- **失败门禁**:writer `exit_code != 0` 一律不进审批流——预算内(`DEFAULT_MAX_ATTEMPTS`)自动 rework 下一个 writer;耗尽 → task **BLOCKED**(与质量否决的 REJECTED 区分)。事件链记 `writer.failed` / `writer.rework_scheduled`
- **组合证据**:每个 decision 绑定因果链上全部证据的组合 digest `sha256(JSON.stringify([{role, attempt_id, digest}, ...]))`——人工审批 = `[writer, verifier?]`,自动裁决附裁决者 = `[writer, verifier?, reviewer]`。候选或验证记录任一字节变化,组合 digest 即变化
- **强制校验**(`submitDecision`):`attempt_id`/`evidence_digest` 必填(400 `evidence_required`);必须指向 writer(409 `attempt_not_writer`);必须等于控制面重算的组合绑定(409 `evidence_mismatch`);仅 `AWAITING_APPROVAL` 可裁决(409 `task_not_awaiting`)。调用方从 `GET /api/tasks/:id/evidence` 的 `binding_digest` 取证
- **验收**(2026-08-31 部署后):E2E 证实 decision 落库的 digest 与从 R2 manifest 独立重算的 `composite([w,v,r])` / `composite([w,r])` 逐字节一致;缺证据 400、伪证据 409、非 writer 409 全部拒绝

### 13.10 独立验证器 — 已实现(冻结候选 + 独立沙箱重放)

~~`verify_command` 在 writer 同一沙箱内执行,退出码只进文本产物、控制面不解析——验证与执行共享被污染的环境,且"验证通过"不可审计。~~

修复:验证语义从 writer 沙箱移出,成为独立角色纵切:

1. **冻结候选**:writer 成功后在**已材质化到冻结基线**的工作副本上导出 `git diff '<base_sha>' --binary` 为 patch(导出前先 `cat-file -e` 断言基线对象在、`git add -A`),内容寻址入 R2,写入 writer manifest 的 `patch` 字段;任一步非零即 `exit 23` 且不产出半成品补丁
2. **编排**:task `RUNNING → VERIFYING`,经 `REVIEW_QUEUE` 发 `verify-request`(复用现有队列,幂等键 `task:verify:<n>`);consumer 路由 DO 创建 verifier attempt
3. **重放**:全新沙箱浅克隆 → 从 **writer manifest 的 `base.sha`** 取基线并跑与 writer **同一个** `materializeScript` 材质化到它 → 从 R2 取 patch → `git apply` → 跑 `verify_command`;**不跑 LLM**,transcript 即结构化报告 `{schema_version:2, base:{sha,source}, apply:{exit_code}, verify:{exit_code, stdout_tail, stderr_tail}}`。基线只从 manifest 读、消息里刻意不带 SHA —— 不能有两个口径
4. **裁决**:验证通过 → 派 reviewer(输入含验证结论 + diff 摘录)→ `AWAITING_APPROVAL`;验证失败 → 按否决进 rework 闭环,预算耗尽 → REJECTED;verifier 基建错误同样按验证失败处理
- **验收**:repo 任务(`octocat/Hello-World` + `test -f hello.txt && grep -q 'hello cloud-agent' hello.txt`)全链 `RUNNING→VERIFYING→AWAITING_APPROVAL→DONE`,验证器报告 `apply=0, verify=0`
- ~~**已知限制**:patch 基于浅克隆默认分支,上游在 writer→verifier 窗口期移动时 `git apply` 可能失败~~ → **M8 消解**:verifier 重放的是 writer 那个精确 commit,上游移动不再改变验证语义;此时 `git apply` 失败就是候选真有缺陷(见 §13.13 的文案同步)
- **M8 引入的刻意不对称**:writer 在 `BASE_PIN_MODE=shadow` 下可以回落默认分支,verifier **永远 enforce、不回落**。理由:让验证器"自己找一个能 clone 的分支"会把基线漂移伪装成候选缺陷,烧掉一轮不可能赢的返工

### 13.11 DO 并发保护 — 已实现并有测试证明

~~"TaskSession 单写者串行"只是注释声明:DO 的 input gate 不保护 RPC,多个并发 RPC 在同一 isolate 内于 await 边界交错,`loadAll → 变更 → saveAll` 是 read-modify-write 竞态——并发创建会写出双份 `task.created`,事件链 sibling 分叉。~~

修复:`createTask / startAttempt / reportExecution / submitDecision` 全部用 `this.ctx.blockConcurrencyWhile()` 包裹完整临界区(读 → 变更 → 写)。

**测试证明**(`test/session-do.test.ts`,vitest + @cloudflare/vitest-pool-workers,真 DO + miniflare):
- 同一 taskId 并发 8 个 `createTask` → 恰好 1 条 `task.created`,spec_digest 一致,事件链完整(修复前该测试应为红:交错写会产生 2 条)
- 写与并发 `getSnapshot` 交错 → 无撕裂读,每个快照状态一致、链不断
- 并发 `startAttempt`(同幂等键)→ 恰好 1 个 attempt,claim 转换一次

另有纯单测覆盖状态转换表合法性、rework 预算判断、watchdog 数学与组合 digest 确定性(`test/statemachine.test.ts`)、门禁分级判定(`test/gates.test.ts`)、候选读模型的诚实性(`test/candidate.test.ts`)、沙箱 key 注入(`test/sandbox-env.test.ts`),以及 reviewer 基建失败挂人工 / awaiting_human 忽略自动裁决 / 证据口径同源 / 陈旧血缘不采信(`test/session-do.test.ts`);回报链路的投递入口 `handleQueue`(`session_id` → `idFromString` 路由、重投幂等、`-1` 回报进 BLOCKED)在 `test/queue-routing.test.ts`。`npm test` 一键运行;注意测试用 `wrangler.test.jsonc`(compatibility_date 受 pool 内置 workerd 版本限制),D1 迁移由 vite `define` 在构建期内联(`test/d1.ts`)。**这套绿不覆盖 `AttemptWorkflow` 的编排本身**,原因与判读方式见 §13.16。

**M7 补的第三类竞态**:`alarm()` 原本游离在临界区外。DO 的 alarm 与 RPC **不互斥**,`loadAll → 判定 → saveAll` 会把并发 RPC 刚裁决完的任务改写成 BLOCKED,并把陈旧行覆盖回 D1 归档。现在 alarm 全程包在同一个 `blockConcurrencyWhile` 里,且**只有真的改了状态才回写**;超时判定与续期统一由 `statemachine.ts` 的 `attemptDeadline` / `nextWatchdogAlarm` 计算(`WALL_GRACE_SECONDS=300` 宽限 + 最小 60s 间隔),修掉了"本次触发没有 attempt 过期就不续期 → 超时兜底静默消失、任务永久挂住"。

### 13.12 反 rework 门禁分级与证据口径统一 — 已实现(M7,默认影子运行)

**要治的病**:姊妹实现 Marshal 的实测病理是「简单任务也要 6–7 轮才肯合并」——每轮返工都走全仪式新 Attempt(新沙箱 + 重新 clone + 重新装依赖 + 重灌上下文),而门禁是扁平的一票否决:任何一条 finding、任何一次模型抖动都能否决,且否决时不带可执行信息,下一轮只能从头猜。本仓裁决路径上有三个同构的洞:

1. reviewer 是一句话纯 LLM 裁决,`reason` 再空洞也能触发"新起沙箱重做";
2. reviewer 自身基建失败(HTTP 4xx / 超时)被解析器兜底成 `reject` —— **模型抖动 = 任务返工**;
3. 返工时下一轮拿到的仍是裸原始 prompt,上一轮攒下的失败证据一点没带走。

四条规则落在控制面(`src/control/gates.ts` 纯判定 + `TaskSession` 编排),权威边界不变:执行面不改状态。

| 规则 | 实现 | 事件 |
|---|---|---|
| **主观意见默认 advisory,硬门禁才有否决权** | `writer exit≠0`、verifier 失败、超时/预算、证据缺失这四类机械门禁**不经** `assessReviewRejection`,直接 rework/REJECTED;只有 reviewer 的 reject 受契约约束 | `writer.failed` / `review.reject_assessed` |
| **拒绝必须带可执行指令 + 可核对证据** | `assessReviewRejection` 按序核:`material_missing` → `no_acceptance_criteria` → `no_failed_criteria` → `criteria_index_out_of_range` → `missing_fix_instruction` → `instruction_too_short`(<10 字符) → `no_evidence_quote` → `quote_not_found`(quote 须在被截断的实际喂入材料内,`normalizeForMatch` 去空白、忽略大小写;`MATERIAL_LIMITS` 与实际喂入截断长度为唯一口径) | `review.reject_assessed {attempt_id, honored, reason?, mode}`、`review.material_missing` |
| **无进展即熔断转人工** | writer 成功回报时算 `candidate = patch_digest ?? sha256(normalizeForMatch(result_text))`,与 `task.last_candidate_digest` 相同 → 不再派 verifier/reviewer(省一次沙箱 + 一次裁决),`awaiting_human=true` 挂 `AWAITING_APPROVAL` | `gate.no_progress` |
| **证据口径单一来源** | `task.current_evidence`(`{writer_attempt_id, writer_manifest_key, writer_manifest_digest, verifier_attempt_id?, verifier_manifest_digest?}`)由回报路径钉住;`computeBindingDigest`、`getEvidenceSummary`、`submitDecision` 三处同源。verifier 回报须核对 `writer_manifest_key` 血缘,不匹配即 `evidence.lineage_mismatch` 且不采信 | `evidence.pinned`、`evidence.lineage_mismatch` |

另外两条同属"别把抖动当结论":reviewer 基建失败 → `review.unavailable` + `holdForHuman`;reviewer 在 `awaiting_human` 任务上给出的任何结论只记 `review.advisory_ignored_awaiting_human`,终态只能人工给。

**返工带走证据**(替代"原地续轮"的收益来源):`scheduleRework` 按失败来源生成 `instructions[]` —— verifier 失败经 `describeVerifyFailure` 把结构化报告翻成祈使句(含 `apply.stderr_tail` / `verify.stdout_tail`)、writer 自身失败带 `error_tail`、成立的 reject 带 reviewer 的 `fix_instructions` 原文;`composeAttemptPrompt` 把它们拼在原始任务之后。

**影子运行 → 强制**:`REJECT_EVIDENCE_MODE` 默认 `shadow`(任务级 `review_evidence_mode` 可覆盖)。**两种模式都写 `review.reject_assessed`**;差别只在 `enforce` 下 `honored=false` 才降级为 `accept_with_notes`(→ DONE,意见留在事件链不返工),`shadow` 下照旧返工。启用判据(不靠感觉):影子期 ≥5 个真实 reject 样本中 `quote_not_found` 占比 <20%,且事后复核没有"真问题被降级"的结论,才切 `enforce`。

**验收(2026-09-01 prod)**:
- **返工带证据 → 两轮闭环**:repo 任务要求 `hello.js` 导出 `GREETING`,而 `verify_command` 额外要求 `EXPECTED` 字段(prompt 里没有)。writer#1 成功 → verifier `exit_code=1` → `verify.rework_scheduled.instructions` 带上 stderr 原文 `hello.js must export a string field named EXPECTED` → writer#2 的 transcript 含返工段并直接推理到该字段 → verifier#2 通过 → reviewer approve → **DONE 共 2 轮**。reviewer 注意到"多了个 EXPECTED 字段"但按新契约只记为意见("…不构成验收标准"),没有为此再开一轮 —— 这正是要治的病。
- **无进展熔断**:repo 任务 + `verify_command=false`(必败)。writer#2 与 writer#3 的候选 patch digest 相同(`6ca6458e…`)→ `gate.no_progress` 命中,**其后没有任何 verify/review 事件**(省掉一次沙箱 + 一次 LLM),`awaiting_human=true` 挂 `AWAITING_APPROVAL`;人工 `submitDecision` 200 收尾 → DONE + archived。
- **绑定同源**:从 D1 归档事件取 writer manifest key → `wrangler r2 object get --remote` 下载 → `sha256(原文)` = `51af0193…` = `GET /evidence` 的 `digest`;`composite([{role:"writer",attempt_id,digest}])` = `c2582af6…` = `binding_digest`;用该值审批通过。负例:缺字段 400 `evidence_required`、伪 digest 409 `evidence_mismatch`、把 verifier 的 attempt_id 当 writer 提交 → 409 `attempt_not_current_writer`(M7 新增的血缘检查)。
- **链完整性**:`GET /api/admin/chain-check` → `checked=37, broken=0`。
- **影子数据尚未成立**:归档事件里 `review.reject_assessed` **0 条** —— 本轮 reviewer 在所有任务上都 approve,没有 reject 样本可统计 `quote_not_found` 占比。因此 `REJECT_EVIDENCE_MODE` 保持 `shadow`,启用判据(≥5 个真实 reject 样本)未达成,不靠感觉切 `enforce`。

**已知不覆盖**:
- 非 repo 任务的候选是归一化后的回答文本,两轮完全相同的概率极低 → 熔断在这类任务上基本不触发,属预期,不引入相似度启发式;
- `spec.acceptance` 缺省时 reviewer 无从指向"第几条标准",其 reject 一律 `no_acceptance_criteria` 降级为 advisory —— 想让门禁有牙齿就要写验收标准;
- 原地续轮(同一沙箱内继续下一轮,省掉重新 clone/装依赖)未做:默认 `sleepAfter=10m` 下轮间存活不成立,需先实测(见 plan 的 M7b spike)。

### 13.13 基线冻结 — 已实现(M8,默认影子运行)

~~`sandbox.ts` 抓到 `baseSha` 后只用于本地拼 `git diff`,既不返回也不落库;`verify.ts` 独立 `gitCheckout(depth:1)` 与 writer **零 SHA 协调**——补丁能否重放取决于默认分支在两次 clone 之间有没有动,而不是候选的性质。~~

不只是 `git apply` 失败会误伤:没有固定基线,M7 的跨轮 `patch_digest` 比较失去意义(两轮工作在不同的世界里),`EvidenceManifest` 也没有 commit 字段,证据无法自证「基于哪个世界」,人拿到候选在本地对不上。M8 把「这个候选基于哪个精确 commit」变成控制面权威事实。

**基线为什么不进 `TaskSpec`**:`spec_digest = sha256(JSON.stringify(spec))` 是**人工意图的承诺**,已进全部历史 manifest 绑定;把执行期才解析出的 commit 塞进 spec 会让 `spec_digest` 语义漂移,并让 M7 攒下的影子语料不可比。所以运行时事实落 `TaskRecord.base: { sha, source }`,`spec.base_sha` 只在人**明确 pin** 时存在(`source="pinned"`)。`scheduleRework` 重新解析的是冻结的 `TaskRecord.spec`,基线不在里面 → 返工继承靠 `startAttemptInternal` 显式写 `params.base_pin`,且 `attempt.created` 事件带 `base_pin`,让「这一轮验的是哪个 commit」能从审计链直接读出,不靠推断。

`BaseSource = "resolved_default" | "pinned" | "unknown_legacy"`。`unknown_legacy`(M8 前的老记录)是**唯一允许「无基线候选」的例外**。

**不依赖 SDK 的 `gitCheckout({ branch: <sha> })`**:`@cloudflare/containers` 只是把 `branch` 透传给容器 HTTP 接口,SHA 会不会被当 ref 处理是镜像版本的经验属性、无文档承诺。统一走自己拥有的材质化阶梯(`src/exec/base.ts`,`depth:1` clone 之后逐条 `git -C /workspace/repo`):

```
fetch --depth=1 origin '<sha>'   # GitHub 等允许直接取任意可达 commit
  ↓ 取不到
cat-file -e '<sha>^{commit}' || 循环 --deepen=10/100/1000 把历史加深到能看见它
  ↓ 仍取不到 → exit 21 UNREACHABLE
checkout --quiet --detach '<sha>'
  ↓ 最后断言 rev-parse HEAD == '<sha>',否则 exit 22 MISMATCH
```

结尾的 HEAD 断言是必要的:静默落在另一个 commit 上比失败危险得多——补丁会「看起来」通过验证而基线是假的。多一次 fetch 换确定性,符合最小复杂度。

**三个专用退出码 + fail-closed 路由**:`21 UNREACHABLE` / `22 MISMATCH` / `23 PATCH_EXPORT_FAILED`。`reportExecution` 见到它们 → `base.failed` + `awaiting_human=true` + `RUNNING→BLOCKED`,**不调 `decideRework`、不递减预算**——基线材质化失败是环境事实,重开一个沙箱在同一个 commit 上必然同样失败,烧一轮预算只会得到一个更贵的 BLOCKED(与 M6 确立的「基建抖动 ≠ verdict」同类)。

**shell 注入防护是硬性要求,不是加固项**:持久化的 `base_sha` 会被原样重放进**多个新沙箱**执行,那等于把一段数据库里的字符串变成跨沙箱的 shell 执行,直接击穿执行面隔离边界。三层:① HTTP 入口与 DO 入口都跑 `isValidSha`(`/^([0-9a-f]{40}|[0-9a-f]{64})$/`,长度与字符集全锚定;不合法 400,不落库、不起沙箱),② `shaLiteral` / `revLiteral` 二次校验、不合法即 throw,③ 脚本里 SHA 只以单引号字面量出现且 `base.ts` **永不接收 `repo_url`**;外加 `GIT_TERMINAL_PROMPT=0`,避免坏 ref / 私有仓触发凭据交互把沙箱挂死。

**刻意不对称**:writer 在 `BASE_PIN_MODE=shadow` 下可在 `exit 21` 时回落默认分支(记 `base.fallback`);verifier **恒 enforce、不回落**,基线只从 writer manifest 读、消息里刻意不带 SHA(不能有第二个口径)。让验证器"自己找一个能 clone 的分支"会把基线漂移伪装成候选缺陷,烧掉一轮不可能赢的返工。verifier 报回的 `base.sha` 与权威不一致 → `base.lineage_mismatch` 且不采信结论。

**语义随之变更**:基线冻结后 `git apply` 失败不再可能是"世界移动了",它就是候选有缺陷、该进返工。因此 `describeVerifyFailure` 的 apply 分支文案从「请基于最新默认分支重新生成补丁」改成「基线已固定为 commit `<sha>`,验证器重放的正是它……请基于该基线重做变更,不要同步或切换到其它分支」——不改文案会把 writer 推向与冻结基线不一致的第二次努力。

**shadow / enforce 都真实材质化**,只在失败路径分叉。另有一条 M7 交互:`base.moved`(shadow 回落或上游重写导致基线变化)时清零 `last_candidate_digest` —— 否则跨基线的同等产出会被无进展熔断误判。

**向后兼容**:`EvidenceManifest.schema_version: 2` + 可选 `base?`;所有读取方容忍 v1(`verify.ts` 读到无 base 的老 manifest 时如实标 legacy,沿用默认分支克隆)。`compositeEvidenceDigest` 组合的是**已存 digest**,历史审批绑定逐字节不变。

**启用判据**(与 `REJECT_EVIDENCE_MODE` 同一套做法,但**条件互不相干,不要混淆**):≥10 个 repo attempt 中 `base_source != "unknown_legacy"` **且** `base.fallback` 由我方脚本造成 **0 次**(只允许真实 force-push 导致),才切 `enforce`;样本不足或存在自伤回落 → 保持 `shadow`。

**证据现状**(2026-09-01 prod，版本 `2b8df82e`，全部 `--remote` 取证）：
- **测试**：`npm test` → 98 passed，`tsc --noEmit` 干净。覆盖：注入样本（`a]b;c`、反引号、长度 39/41、大写）全拒、脚本内 SHA 只以 `'<sha>'` 出现且无 `repo_url`、三个 exit 码可达、**全部脚本函数体在子 shell 内且括号外无 `exit`**（§13.15 回归）、返工轮 `attempt.created.base_pin` 与首轮同 SHA、`exit 21 → BLOCKED`+`awaiting_human`+预算不变+不派 verifier/reviewer、`result_text` 为空串时 `base.failed` 仍留得下诊断、shadow 回落只记 `base.fallback`+`base.moved` 不误触熔断、verifier 血缘不匹配不采信、`reportArgsFrom` 键集与 `ReportArgs` 一致（防"静默丢字段"回归）、沙箱 key 配了独立值即不混用高权 key / 缺配回落且只在那一次告警、**`handleQueue` 投递路由 5 条**（`session_id` 命中正确实例 / 幽灵实例不误写 / `-1` 回报进 BLOCKED / 重投幂等 / 未知类型 ack，§13.16）。
- **E1 无 repo 回归** ✅：天气任务闭环 DONE，证明基线代码路径与 key 注入没破坏非 repo writer。
- **E2 pinned 基线端到端** ✅（`e38b8357` / `62edbba0`）：writer 与 verifier 报同一个 sha，`base.frozen` 落 `task.base`，manifest v2 带 `base`，返工轮继承同一 pin。
- **E3 交付闭合（本轮验收终点）** ✅：`GET /api/tasks/:id/candidate?format=patch` 落盘 → 本地 `git checkout 762941318ee16e59dabbacb1b4049eec22f0d303 && git apply` 成功；下发的字节 sha256 与 `manifest.patch.digest` 一致（不一致会返回 `integrity_error` 而不是把未校验字节交出去）。
- **E5 不可达基线** ✅ 双模式：`shadow` 下（`9d3a84d5` / `346a1dcb`）回落已解析的默认分支、记 `base.fallback`（detail 带 git 原文）并继续正常流程；`enforce` 下（`73fd11c4` / `c4ceadcf`）19 秒 BLOCKED，`attempts=1`、writer `tokens_used=0`（**基线不可用就不起模型**这一点被记账证实）、无 `verify.requested` / `review.requested`、预算不变。
- **E6 注入** ✅：5 个样本（含 `a'*;touch /pwn`、39/41 位、大写）全 400 `invalid_base_sha`，D1 无记录、无沙箱。
- **E7 向后兼容** ✅：M7 老任务 `8e8e408a` 重算 `binding_digest` = `c2582af6650e…`、writer manifest digest = `51af01939692…`，与 M7 归档**逐字节相同**（v1 manifest 无 `base`，读取路径容忍）；`GET /candidate` 对它返回 `base: null` + 警告「基线未固定：补丁只与抓取时刻的默认分支绑定，不保证能在其它 commit 上重放」，状态如实给 `held_for_human`、`safe_to_apply=false`，**没有**因为曾经 approve 就伪装成可提交。`GET /api/admin/chain-check` → `checked=47, broken=0`。
- **E8 凭据** ✅（结论是**否**）：容器内 `OPENAI_API_KEY` 的 sha256 前缀与 Worker 侧 `DASHSCOPE_API_KEY` 相同 —— prod 至今没有铸 `SANDBOX_MODEL_API_KEY`，所以本轮"降权"实际收益为零，与 §13.14 写明的条件一致。
- **修好的静默丢字段（prod 才看得见）**：`base.failed.detail` 在单测里非空、在 prod 恒为 `""`。根因是 writer 的 `result_text` 恒为字符串：基线失败时 transcript 是纯文本、提取器返回 `null`、workflow 落成 `""`，而 DO 用 `args.result_text ?? attempt.error_tail` 取值——`??` 不认空串，回落永远不执行。现改为先 `trim()` 判空再回落，并给事件补 `manifest_key` 指针。上面 `73fd11c4`（修复前，detail 空）与 `c4ceadcf`（修复后，detail `exit_code=21` + `manifest_key`）是同一条路径的前后对照样本；沿 `manifest_key → manifest.transcript → 产物` 一跳即可取到真实诊断：`pinned base deadbeef… not materializable (exit 21): fatal: remote error: upload-pack: not our ref …`。
- **enforce 判据未达成**：判据要求 ≥10 个 repo attempt 且 `base.fallback` 由我方脚本造成 0 次。现状 = 5 个 `base.frozen` + 2 个 `base.failed`（均为刻意注入的合成样本），`base.fallback` 2 次全部来自不存在的 `deadbeef…` pin，**我方脚本造成 0 次**这一半成立，样本量那一半不成立。因此 `BASE_PIN_MODE` 保持 `shadow`。测完 enforce 已立刻改回 shadow 再部署，prod 不留 enforce 状态。

**已知不覆盖**：
- **E4「上游移动」未取证**：需要在一个**对 runner 有默认分支 push 权限**的仓库上，于 writer 执行期间再压一个与候选冲突的提交，对照 M8 前会 `APPLY_FAILED_EXIT=20`、M8 后候选仍按冻结基线通过。prod 全部 repo 样本都在 `octocat/Hello-World`（无写权限）上，因此这条只能标未覆盖。复现配方：建一个自己的 scratch 仓 → 提交任务时 pin 一个稳定 sha → 任务在跑时向默认分支 push 一个改动同一文件的提交 → 期望 verifier 仍 `exit 0`。
- 私有仓 fetcher 未实现：只在 `TaskSpec.repo_url` 处留了接入位注释，`GIT_TERMINAL_PROMPT=0` 保证坏 ref 不会挂死，但私有仓现在一律 clone 失败。
- **候选 patch 无大小上限 — 已实现上限(§13.17)**:导出走 `sandbox.readFile`(容器文件 API 的 base64 GET,**不经 shell 会话**,所以不受 §13.15 那条影响),整份读进 Worker 内存后由 `putArtifact` 落 R2。M9 前的状态是只记 `size`、不设上限,一个含巨型二进制改动的候选会整份穿过 Worker isolate。当时的判断是「候选被静默截断」比失败更危险,所以不做截断、只做容器内预检 + 超限显式失败 —— 现已按该正解落地:`exportPatchScript` 在容器内 `wc -c` 预检,超限 `exit 24` 走容量事实路由,**字节根本不回传**,见 §13.17。
- 基线只保证「writer 与 verifier 在同一个 commit」，不保证「这个 commit 是 GitHub 当前默认分支」——`GET /candidate` 的 `base.moved` 提示负责把这一点如实告诉消费方。

### 13.14 出站网络 allowlist — 已实现(M9,prod `enforce`)

原状(本节旧版)是「未做,顺延 M9」。2026-09-01 落地并翻转 `enforce`,实现与证据如下。

**实现面**:

- `src/index.ts` 补导出 `ContainerProxy`(`@cloudflare/sandbox` re-export)。SDK 经 `ctx.exports.ContainerProxy` 挂拦截,缺这个导出拦截**根本不发生**(旧版坑 1,源码 `container.js:1173` 实证)。
- 新增 `src/exec/sandbox-do.ts`:`Sandbox` 子类(DO 类名不变,wrangler 绑定/迁移不动)。两档策略由 `EGRESS_MODE` 切换,共用同一套拦截机器,`interceptHttps=true` 两档都开(流量几乎全是 HTTPS,不拦 HTTPS 就等于没观测也没治理):
  - `shadow`:不设 `allowedHosts`、`enableInternet=true`,所有出站经 catch-all 记 `egress=forward host=…` 后放行 —— 积累「封了会打到谁」的样本,同时让 CA 信任问题在观测期就暴露;
  - `enforce`:`allowedHosts` 白名单 + `enableInternet=false`,未列名主机在处理器链第 2 步(白名单门)即被拒,HTTP 520 `Origin is disallowed`,连 catch-all 都不到。
- 白名单内容(`egressAllowedHosts`):模型主机从 `MODEL_UPSTREAM_BASE` 推导(与既有变量同源,避免两处维护)+ `EGRESS_GIT_HOSTS`(逗号分隔,缺省仅 `github.com`)。列表必须**静态可审计**:不按任务 `repo_url` 动态放行 —— 那是外带通道。

**原文三个坑的落地结论**:1、2 照旧成立并已按原文实施;3 需要修正 —— **不需要改镜像装 CA**:官方基镜像 `cloudflare/sandbox:0.8.14` 已信任平台注入的 `cloudflare-containers-ca.crt`,我们的镜像 FROM 它即继承。prod 实证:shadow 期(拦截全开)与 enforce 期的 repo 任务 `git clone` → 模型调用 → 候选导出 → 验证全链绿。原文「镜像装 CA 并 bump tag」从 M9 工序中删除,无 Dockerfile 改动。

**实施中新发现的两个坑**:

4. **`static outbound = fn` 类字段会遮蔽基类静态 setter**(M9 shadow 首轮零日志的根因):类字段初始化是 [[DefineOwnProperty]],直接盖掉基类 `Container` 提供的静态访问器,`outboundHandlersRegistry` 永远空着 —— 拦截照常安装、流量照进代理,但处理器链第 3–6 步全部落空,shadow 流量从第 8 步 `enableInternet=true` 静默直出,呈现「部署成功、任务全绿、一条日志没有」的假象。修法是 `static { this.outbound = fn }`([[Set]] → 基类 setter 真正注册)。机制测试钉住 `Object.hasOwn(Sandbox, "outbound") === false`,变异验证:改回字段即红。
5. **模式翻转无需迁移**:每个 attempt 是全新 DO 实例,类字段在构造期求值(基类构造器先让出微任务等子类字段初始化完再读取,官方模式),翻 `EGRESS_MODE` 对后续 attempt 即时生效,不存在存量实例按旧模式跑的问题。

**shadow → enforce 过程**(有否决权的策略先观测再启用):

- shadow 样本(prod):恰好 3 个主机 —— `github.com`、`token-plan.cn-beijing.maas.aliyuncs.com`、`gb4w8c3ygj-default-sea.rum.aliyuncs.com`(qwen-code 内置的阿里云 RUM 遥测,与任务成败无关)。决策:遥测不加白、直接封。**加白零新增**。
- 正向用例(prod,`EGRESS_MODE=enforce`):完整 repo 任务全绿 —— clone → 基线冻结 → writer → verifier `passed=true` → reviewer approve,同时证明 CA 信任继承与白名单充分性(一条任务两证)。
- 负向用例(prod):任务 prompt 要求在沙箱内 `curl -sS https://example.com` 并把结果写进产物 —— transcript 里记录到 `HTTP 520`、响应体 `Origin is disallowed`(20 字节),请求未出网,证据由任务自己的产出固化。
- 记账对账(`wrangler tail`):enforce 窗内 `github.com` / `token-plan` 的每个请求都伴随 `egress=forward` 记账日志;RUM 遥测请求**无记账日志** —— 被白名单门在第 2 步拦掉、根本没进处理器,与 520 语义一致,不是「放行了只是没记」。

**诚实边界**:allowlist 是主机粒度,不是路径粒度;白名单内的 `token-plan` 主机本身仍是花钱通道(与下文「降权 ≠ 限流」同构)。出站治理与凭据降权是两条独立防线,互不替代。

**凭据降权是另一条独立防线**(原「未做」时期的补偿措施,保留现状):`SANDBOX_MODEL_API_KEY`(低权、可撤销、只注入容器)与 `DASHSCOPE_API_KEY`(高权,Worker 侧 reviewer 用)分开,方向与 M7 前相反——控制面持高权 key,沙箱持低权 key。它买到的是**撤销能力 + 爆炸半径 + 归因**(泄露时立刻撤 key、从事件链定位泄露窗口内的 attempt 集合),**不是限流**:DashScope token-plan 没有可靠的 per-key 硬额度,拿到 key 仍可花到配额上限。所以沙箱泄露的应急动作是「立刻撤销 + 圈定受影响 attempt」,不要指望"损失有上界"。

**这条收益是有条件的**:低权 key 是**可选配置**,缺配时 `sandboxModelEnv` 回落沿用 `DASHSCOPE_API_KEY` 并打 `credential_fallback` 告警。回落 = 拆分带来的收益为零,状态与 M8 前逐字节相同。刻意不做 fail-closed:那会让一个配置层增强项阻塞基线冻结与候选交付这两个主交付物,而部署阻塞的代价是真实的(M8 曾因此停摆)。判断降权是否成立只看一处:`wrangler secret list` 里有没有 `SANDBOX_MODEL_API_KEY`,以及日志里还有没有 `credential_fallback`。

**最可靠的核查是直读部署后的 binding**(`wrangler secret list` 只看当前目录配置所指向的环境,而策略开关的实际生效值在已部署的 Worker 上):`GET /accounts/<ACCOUNT_ID>/workers/scripts/cloud-agent/settings` → `result.bindings` 里 `type=plain_text` 给出 `BASE_PIN_MODE` / `REJECT_EVIDENCE_MODE` 的真值,`type=secret_text` 给出**名字**(不返回值),据此一次请求同时确认「prod 跑的是哪个模式」与「低权 key 到底铸没铸」。2026-09-01 实测:`plain_text` = `BASE_PIN_MODE=shadow` / `REJECT_EVIDENCE_MODE=shadow`,`secret_text` 只有 `DASHSCOPE_API_KEY` 与 `WORKER_API_TOKEN` —— **沙箱降权确认处于回落态**,与 E8 的 key 指纹结论一致。

### 13.15 沙箱 `exec` 复用常驻 shell：顶层 `exit` 会杀掉会话 — 已修复（M8，prod 才发现）

**事实**：`sandbox.exec()` → `ensureDefaultSession()` → `POST /api/execute` 的每条命令都跑在**同一个常驻 shell 会话**里（`@cloudflare/sandbox` 的 execute 路径），不是一次性进程。于是脚本里顶层的 `exit N` 退掉的是**会话本身**：SDK 不返回退出码，而是抛 `SandboxError: … Session '…' is not ready or shell has died`。

这对 M8 是致命的：`base.ts` 的三个退出码（21 / 22 / 23）与 `reportExecution` 里那条「环境事实不烧返工预算、直接 BLOCKED 转人工」的路由，全部依赖脚本自己 `exit`。实际表现是 fail-closed 路径**永不执行**，任务从 workflow 的通用异常分支落成 BLOCKED，`awaiting_human=false`、诊断文本丢失——看起来"也失败了"，但审计语义完全不同。

**修法**：`materializeScript` / `exportPatchScript` / `resolveScript` 的整个函数体包进子 shell `( … )`。`exit` 只结束子进程，状态码照常回传；顺带阻止 `set -eu`、`export GIT_TERMINAL_PROMPT`、`R=` 泄漏进同一会话里后续的 qwen 与 patch 导出命令。

**为什么测试没抓到**：`wrangler.test.jsonc` 没有 Sandbox 绑定，单测只能断言**脚本字符串**的形状（SHA 只以 `'<sha>'` 出现、三个 exit 码可达），断不了容器语义；M6/M7 也没暴露这一类，因为那两轮的退出码全部由 **TS 侧计算**（`apply.exitCode → APPLY_FAILED_EXIT=20`），从来没有任何脚本 `exit` 过。现在 `base.test.ts` 里有一条括号深度扫描的回归：`exit` 必须出现在 `(` 之内，包装层不得把退出码吞掉。

**给后续轮次的约束**：任何要经 `sandbox.exec` 执行的脚本，**退出码只能通过子 shell 产生**；需要"失败即中止"的语义优先在 TS 里判断 `exitCode`，不要在脚本顶层 `exit`。

### 13.16 本地测试环境的边界：workflow orchestration 一行都没跑过 — 未解决(记录 + 部分补偿)

**现象**：`npm test`(98 条)全绿且**退出码 0**,但输出里夹着 **33 行** `uncaught exception; source = Uncaught (in promise)`:

| 特征 | 次数 | 成因 |
|---|---|---|
| `TypeError: … reading 'idFromName'`(`getContainer` ← `runQwenCodeAttempt` `src/exec/sandbox.ts:79` ← `workflow.ts:72`) | 22 | `wrangler.test.jsonc` 没有 `containers` 绑定,`env.Sandbox` 是 undefined |
| `verify attempt requires spec.repo_url` / `writer manifest missing`(`verify.ts:42/44`) | 2 + 1 | 测试造的 verifier attempt 命中 `verify.ts` 的真实守卫 |
| `Error: internal error; reference = …`(无栈) | 8 | 本地 Workflows 实现(workerd)自身失败,不可归因 |

**为什么会打印出来**：`startAttempt` 里 `ATTEMPT_WORKFLOW.create()` 只建实例、不 await；`run()` 的 catch 回报完 DO 之后**刻意 `throw err`**(`workflow.ts:177`),让实例在 Workflows dashboard 落成 `errored` 而不是伪装成 completed。测试进程里没人接这个 rejection,vitest 的 workers pool 就只打一行,不影响结果。

**它有没有污染断言?没有(实测)**。一次性探针用例(跑完已删)建一个 writer attempt 后连续观察 **40s**:`task.state` 始终 `RUNNING`,事件链始终是 `task.created, attempt.created, task.transition` —— 后台 workflow 的 `exit_code=-1` 回报**从未到达任何 DO**。所以这套绿不是靠"回报来得比断言晚"的时序侥幸;`exec` 步骤的 10s/20s 退避只是让事情更明显。

**真正该记的账不是噪音**：`AttemptWorkflow.run` 的编排本身(`exec → extract → evidence → report` 四步、`slim()` 瘦身、`waitForEvent("human-approval")`、catch 的回报)**在本地完全没有执行路径** —— 容器起不来,本地 Workflows 自己还会 internal error。这条链路只有 prod E2E 一层保障。

**本轮补的部分**(`test/queue-routing.test.ts`,5 条):回报链路的最后一公里 `handleQueue`,即 §13.8 幽灵实例事故的修法现场。此前只有 `reportArgsFrom` 的字段映射有单测,投递入口零覆盖。现在钉住:按 `session_id` 走 `idFromString` 命中正确实例并驱动状态机(writer 成功 → attempt `SUCCEEDED` + task `AWAITING_APPROVAL` + tokens 落库)/ 合法但空无任务的实例 → ack 且**不得有兜底查找**把状态写到别处 / workflow 抛错的 `-1` 回报 → attempt 与 task 一起 `BLOCKED` 且 error 进 `attempt.blocked` / `review-request` 重投同幂等键 → 只有一个 reviewer attempt / 未知类型 → ack 不 retry。

**变异验证**(确认这套用例真能抓到它声称抓的东西):把 `queue.ts` 里三处 `idFromString(body.session_id)` 换成 `idFromName(body.task_id)` → 5 条里 **3 条红**(投递未命中 / `-1` 未落 BLOCKED / reviewer 起不来),改回即全绿。注意各自抓的是不同失效:抓 name-based 回归的是**第一条**,幽灵实例那条在 name-based 变异下**依然绿**(它同样落进空实例并 ack),它真正守的是「查不到就不写、不 retry、不猜第二个口径」。

**没补、也别补**：不要为消灭噪音给测试环境加假的 `Sandbox` DO —— 只会把 `TypeError` 换成容器 HTTP 错误,噪音照旧、覆盖面不变。噪音的判读方式:命中上表三类特征的属预期;**其它**栈的 uncaught exception 意味着 workflow 里多了一条新的失败路径,应当查。`exec/extract/evidence` 三步要真实容器,只能留在 prod 取证。

**为什么这套噪音不会红灯(A/B 实测,别误解成"vitest 不管未捕获异常")**:一次性探针在测试自身 isolate 里 `void Promise.reject(new Error("PROBE_MARKER"))` → 该用例通过但 vitest 打印 `Unhandled Errors` + `Errors 1 error` 且**退出码 1**;而 workflow 侧那 33 行同样形态的 rejection 只让 summary 保持 `7 passed / 98 passed`、**退出码 0**、无 `Errors` 计数。差别在于它们出生在 Workflows 运行时(vitest pool 之外的 workerd/miniflare 上下文),走的是 runtime 自己的错误打印,绕开了 vitest 的 per-test 异常通道。结论:机制是有的,只是覆盖不到后台 workflow —— 所以「本地跑不到 orchestration」这条账不能靠红灯兜住,只能靠上面的 `handleQueue` 用例把可本地化的那一跳拿回来。

### 13.17 候选 patch 大小上限 — 已实现(M9,容器内预检 + 容量事实路由)

问题即 §13.13 记的那条:`readFile` 非流式(约 0.6 MB/s),一个失控的 `--binary` diff 会整份穿过 Worker isolate。修法遵循当时记下的正解 —— **不做截断**(静默截断比失败更危险),只在容器内预检、超限显式失败,**字节根本不回传**:

- `src/exec/base.ts`:`BASE_ERRORS.PATCH_TOO_LARGE = 24`;`exportPatchScript(sha, maxBytes)` 在 `git diff > $PATCH_PATH` 之后 `SIZE=$(wc -c < $PATCH_PATH)`,超限 `exit 24`,stderr 带实际字节数。脚本仍是纯字符串构造(可穷举单测),子壳包裹规则(§13.15)不变;`maxBytes` 非法(NaN/负数/非整数/Infinity)直接 throw,不进拼接。
- `src/exec/sandbox.ts`:`maxBytes = Number(env.MAX_PATCH_BYTES) || DEFAULT_MAX_PATCH_BYTES`(1 MiB)。`MAX_PATCH_BYTES` 是**可选 + 回落**配置,`wrangler.jsonc` 刻意不设(用代码默认),调参时才写。
- **路由零改动**:`isBaseError(24)` 自动走既有 `onBaseFailed` —— 容量事实 ≠ 候选质量判定,重开沙箱在同一个任务上必然产出同样大的补丁,返工无意义:`BLOCKED` + `awaiting_human`,不烧返工预算、不派下游。唯一改动是审计诚实:`transition.reason` 按退出码区分(`patch exceeds size cap` vs `base materialization failed`),两种失败在事件链里可分辨。

**测试与变异验证**:脚本字符串断言(`wc -c` 在 `diff` 之后、`-le ${maxBytes}` 插值审计、`exit 24`)、非法 `maxBytes` throw、`isBaseError(24)`、DO 路由测试(24 → `base.failed` + `BLOCKED` + `awaiting_human` + 单 writer attempt + 无 `rework_scheduled`/`verify.requested` + reason 可区分)。变异两条:删脚本预检行、改坏 `isBaseError` —— 对应测试变红后还原。

**诚实边界**:prod 尚无超限样本(现有任务补丁都是几百字节级),门禁的可达性由测试证明,prod 触发要等真实大 diff 任务。上限是保护控制面的容量闸,不是质量信号 —— 被 24 拦住的任务转人工后,合理处置是人工拆分任务或调高 `MAX_PATCH_BYTES`,不是返工。

### 13.18 长任务生命周期探针 — 失败(发现 ~30 分钟挂起墙,修复顺延 M9.5)

探针设计:`verify_command: "sleep 1920 && echo long-ok"`、`budget.max_wall_seconds: 3600`,问「单次 >30min 的 exec 能否穿过容器 + workflow step + DO 回报链」。**答案:不能,在 ~30 分钟处被平台杀掉。**

**时间线**(全部来自事件链与 `wrangler tail`,可回放):

- 15:24:05Z:verifier 沙箱完成 clone + `git apply`(5 秒),开始执行 `sleep 1920`;
- 15:53:53Z(**exec 开始后 29 分 48 秒**):workerd 报 `The Workers runtime canceled this request because it detected that your Worker's code had hung` —— 执行 `exec` 步骤的那条请求被运行时挂起检测杀掉;
- workflow 的 catch 如实回报,attempt 落 `BLOCKED`,error = `Attempt failed due to internal workflows error`;
- 随后控制面派了 **writer 返工**(137K tokens 重做了一遍同样的活),第二轮 verify 再跑同一个 1920 秒 —— 按同一堵墙的确定性,会原样再失败,直至 `DEFAULT_MAX_ATTEMPTS=3` 耗尽、任务 `BLOCKED`。

**根因判定**:不是 Workflows 文档里的 step 限制([官方限制页](https://developers.cloudflare.com/workflows/reference/limits/)写明 step 墙钟无限、只限 CPU 秒),而是 **workerd 的挂起检测容不下单一长挂起 fetch** —— `step.do("exec")` 里一条 `await sandbox.exec(...)` 挂了 ~30 分钟,运行时就当代码死了。[workerd#6925](https://github.com/cloudflare/workerd/issues/6925) 里同款错误文案的讨论佐证了这条检测的存在与误伤面。保守安全线:**单条命令 ≤ 25 分钟**,超过必须拆。

**顺带暴露的路由语义问题**(M9.5 一起修):验证器的平台级失败目前按「验证失败」进 writer 返工闭环(`session.ts:388` 的既有设计)。在瞬时抖动下这是对的 —— 换个沙箱重验有意义;但在**确定性容量失败**下纯属浪费,还把平台错误字符串原样塞进 writer 的修复指令(语义污染)。容量/拓扑事实 ≠ 候选质量判定,这条原则在基线路由上是清楚的,在验证器路径上还没贯彻。

**M9.5 修复方向**(本轮不实施):把长 exec 从「一条长 fetch」改成「后台启动 + 短轮询」—— 容器内 `nohup` 起任务、落完成标记文件,workflow 用一串短 `step.do` 轮询 + `step.sleep` 续命,每步都是秒级请求,天然绕过挂起检测且崩溃可从最近 checkpoint 恢复([Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/) 的标准模式)。修好前,任务规格的 `verify_command` / 单条命令按 25 分钟以内设计。

### 13.19 长 exec 后台启动 + 短轮询(M9.5① / Fix C)— 已实现,r10 prod 取证暴露 SDK 契约坑后修复

§13.18 记的修复方向已落地(`src/exec/longrun.ts`,提交 `716cbe6`)。长命令(qwen 主跑 / `verify_command`)不再是 workflow step 里的一条长 `await sandbox.exec`,而是「后台 `startProcess` + 短轮询」,从根上消除 §13.18 的挂起墙与 r6/r7/r8 的驱逐孤儿。

**机制**:

- **专用 session**:长进程跑在固定 id `longrun` 的隔离 session,default session 永不被长命令占用 —— 重试的 pkill/clone 不再排在孤儿后面(r7 实测 429s、r8 实测 415s 排队病灶消除)。
- **幂等启动**:`launchOrReattach` 用固定 `processId=longrun` + `autoCleanup:false`;step 重试/驱逐后重放都先 `getProcess` 查记录,有记录(哪怕已终态 —— 结果绝不能丢,治 r7「exit 0 无人认领」)即重连,无记录才 `startProcess`。驱逐只重放廉价的 poll step,launch step 不重放,孤儿无从产生。
- **脚本化启动**:启动命令固定 `bash /tmp/longrun.sh`;脚本由 `writeFile` 落盘(已实证路径),`cd`/env/重定向全收在脚本内(`{ cmd; } > stdout 2> stderr; exit $?`),不依赖 `startProcess` 端的 shell 语义。**模型凭据必须随脚本 `export` 传入** —— SDK 实证 `setEnvVars` 只作用于 default session 的 shell,专用 session 收不到。
- **四相编排**:prepare(checkoutRepo → pinWorkspace → writeFile task.txt → writeFile longrun.sh)/ launch / poll(`step.sleep 30s` + 秒级短 RPC,逐个落 checkpoint)/ collect(`readFile` 回收两个固定输出文件,不依赖 `getProcessLogs`)。
- **到期兜底击杀**:writer = `min(qwen 墙钟 + 3min, 预算 − 60s)`,verifier = `预算 − 120s`;到期 `killProcess(SIGKILL)`,kill/记录消失(missing)按 `exit -1` = 容量事实 → writer `BLOCKED` 转人工。**verifier `-1` 现路由仍进返工,平台错误与候选质量的分流属 M9.5②**(§13.18 末)。

**r10 prod 取证暴露的 SDK 契约坑(只有真任务才暴露,提交 `34a5302` 修复)**:C4 首跑(任务 `da1ada45`,writer `c8d1dbab`)launch step 连死 3 次 → workflow Exception → writer `BLOCKED`,日志只见 `exec_step_failed stage=launch err=ProcessNotFoundError: Process longrun not found`、**无 `longrun_started`**(startProcess 从未到达)。根因:SDK 的 `getProcess(id, sessionId)` 对「进程记录不存在」**抛 `ProcessNotFoundError`**(`createErrorFromResponse` → `ErrorCode.PROCESS_NOT_FOUND`,`name` 固定),**不是返回 `null`**;而 `readProcess` 只处理了 falsy 返回,且 `launchOrReattach` 把 `readProcess` 调在它的 `try` 之外(那个 `try` 只包了 `createSession`)→ 首次启动时「查无记录」本应走 missing→startProcess,却把异常一路抛穿。

这是**反模式 17 的活体标本**(见调研手册 §5):本地 23 条 longrun 单测全绿,因为测试 fake 的 `getProcess` 在不存在的分支**返回 `null`**(错误契约),恰好被 `readProcess` 的 falsy 处理接住 —— 绿的套件根本没行使 prod 失败的那条路径。修法两层:① `readProcess` 把 `getProcess` 包进 `try`,据 `err.name === "ProcessNotFoundError"` 识别为 missing(**按 name 而非 `instanceof`** —— 打包后类身份可能不是同一份,name 是稳定契约),暂态错误上抛绝不吞成 missing;② **修测试保真度**:fake 的 `getProcess` 在记录不存在时改为抛 `ProcessNotFoundError`(显式对象含畸形 `{}` 才返回),新增 3 条契约测试(name 命中→missing→启动 / 暂态错误 name≠not-found→上抛且不 startProcess / 轮询期暂态错误→上抛)。变异验证两咬人:`isProcessNotFound` 恒 false → 4 红;吞掉所有错误当 missing → 2 红。longrun 单测 23 → 26 条,全量套件 181 绿。**教训固化为:fake 必须复刻真实 SDK 的失败契约(抛 vs 返回 null),否则「绿」只是没踩到那条路。**

**prod 取证状态(已闭环)**:`34a5302` 部署 `def22563`(23:31:30Z)后复验 C4(任务 `17a43e26`,r11)—— **全链绿、任务 DONE**:writer `c2c6198b` SUCCEEDED(16.8min、exit 0、6.95M tokens)、verifier `3da98ff2` SUCCEEDED(2.3min,`npm ci && tsc && npm test` → 208 测试通过)、reviewer `5e3dcd5e` approve(27s);`AttemptWorkflow.run - Ok`(非 Exception/Canceled),`longrun_started` 落日志,出站 enforce 正确(github + token-plan 放行,qwen 的 `rum.aliyuncs.com` ARMS 遥测被 allowedHosts 门拦下、无 `egress=forward`)。

两个关键经验风险就此关闭:① **完成态进程记录可靠携带 exitCode** —— writer/verifier 两个 longrun 进程都以 exit 0 终态被正确读回(若缺失会被映成 `-1` → writer BLOCKED,SUCCEEDED 本身即反证);② **驱逐churn 被 durable-step 重放完全吸收** —— tail 拍到 **16 条 `getProcess - Canceled`(精确 30s 节奏 = poll 间隔)**,是 `step.sleep` 窗口里 isolate 被回收打断的轮询 RPC;但 `exec_step_failed=0`、`Exception=0`、`longrun_killed=0`,每个被取消的 poll step 都重放成功,qwen 在专用 `longrun` session 内不受 worker isolate 抖动影响跑完全程。**对照 r6/r7/r8:同样是驱逐,旧架构(单条长 exec)产出孤儿 + BLOCKED + 双烧 token,Fix C 产出零副作用的 DONE —— 这是「后台启动 + 短轮询」消灭驱逐孤儿这一类的最强实证。** 候选(`GET /api/admin/events`,+145 行 src/index.ts、27 新测试、base64url 不透明游标)经本地 apply→tsc→208 测试→3 条独立变异(canonical 改 parse→stringify 5 红 / ASC→DESC 10 红 / 游标 `>`→`>=` 4 红)后人工落地。

---

### 13.20 attempt token 台账的成本口径(M9.5)— 已实现:四元组拆分 + 成本加权值,raw total 原样保留

**问题(r11 writer 实测)**:`attempts.tokens_used` 只记 qwen stream-json 的累计 `usage.total_tokens` = **6,949,711**。拆开是 input 6,886,340 / **cache_read_input 6,733,762** / output 63,371 —— **96.9% 是隐式 prompt 缓存命中**,即最便宜的那类 token;真正贵的 fresh input(152,578)+ output(63,371)只有约 **216K**。把 total 当成本口径,会把「一次几乎全程命中缓存的跑」与「一次全新长上下文的跑」记成同一个数;以同一口径比对的 `max_model_tokens` 同样失真。

**改法(只加不改)**:

- **提取层** `src/exec/extract.ts`:新增 `TranscriptUsage`(字段名与 qwen stream-json 原样对齐,缺的是 `undefined` 不是 0 —— 「上游没说」与「上游说没消耗」是两回事)、用量提取与 `costWeightedFromUsage()`。⚠️ 本节当时落地的提取是「在所有携带 usage 的事件里取**有效 total 最大**的一条」(type=result 是整轮累计值,单次调用超不过上下文窗口,故最大值"必是"累计值)—— 那个推断只对完成态成立,被杀态没有 result,于是悄悄退成「最后一次调用」,漏记 48×。**该启发式已被 §13.22 的逐事件累加取代**,`extractUsageFromTranscript()` / `extractTokensFromTranscript()` 两个函数随之删除。成本口径(`costWeightedFromUsage`,fresh + output + 0.2×cache)未动。
- **台账层** `AttemptRecord` 与 D1 `attempts` 增加 `input_tokens` / `cache_read_tokens` / `output_tokens` / `cost_weighted_tokens` 四列(`migrations/0004`);`tokens_used` **仍是 raw total**,历史行与既有复盘口径不动。
- **传递链**:workflow extract step → `REPORT_QUEUE` → DO 全程带 `usage`。reviewer 走 chat completions,把 `prompt_tokens`/`completion_tokens` 规范化成同一形状;上游不下发 `cache_read` → 留空,成本按全 fresh 保守计。verifier 的 transcript 是结构化 JSON 报告(无用量),如实记 null。
- **读端**:`GET /api/admin/attempts` 透出四列(`proxy_token` / `idempotency_key` 仍绝不进投影);`GET /api/tasks/:id` 的 attempts 投影刻意不动 —— 审计面只改一处。

**`cost_weighted_tokens` 的三档口径**(单位 = fresh input token 数):

| 已知字段 | 计算 | 含义 |
| --- | --- | --- |
| input + cache_read | `(input − cache_read) + output + round(cache_read × factor)` | 精确拆分 |
| 仅 input | `input + output` | 缓存收益未知,**保守按全 fresh**,绝不猜「全是命中」 |
| 仅 total | `total` | 无从拆分,与 raw total 同值 —— 如实标注 |

r11 向量自检:`factor=1` → 6,949,711,**恰等于 raw total**(「缓存与 fresh 同价」的退化情形,拿它当回归锚点最省事);`factor=0.2` → 1,562,701;`factor=0` → 215,949(只剩真贵的部分)。

**0.2 是估计值,不是价目表**:`CACHE_READ_COST_FACTOR`(wrangler.jsonc 显式 `"0.2"`,`Env` 里可选)是「缓存命中相对 fresh input 折扣」的唯一读取口径 —— `Number(env.CACHE_READ_COST_FACTOR) || 0.2`,未设/非法一律回落 0.2,不因此打断回报链路。qwen3.8-flash 经百炼 compatible-mode 的**真实隐式缓存折扣以百炼控制台为准**;这个加权值用于跨 attempt 横向比较(哪次真贵),不是账单,output 按 1 个 input token 计同样是简化(真实 output 单价更高)。

**刻意不做**:`max_model_tokens` 仍是纯记录字段,**不新增执法、路由或预算拦截逻辑** —— 它与 `tokens_used` 同源于失真的 raw total,拿它执法等于拿失真值执法。四列**不给 `DEFAULT 0`**:旧行 NULL 表示「当时未记录」;`result.captured` 事件同步带 `cost_weighted_tokens`(无 usage → null)。台账在终态转换前就落定,所以 SUCCEEDED/FAILED/BLOCKED 三种终态都有数 —— 到期击杀的 attempt 钱已经花了,台账不能空白。

验证:`npm run typecheck && npm test` 全绿(15 文件 230 测试,新增 22 条:提取/加权向量 17 + DO 落库 4 + 读端投影 1)。

---

### 13.21 平台路由分流:预算到期与环境故障不再当质量失败(M9.5②③)— 已实现

§13.18 末记下、§13.19 明确顺延的那条账:「验证器平台错误按验证失败进 writer 返工」。本期落地的是**路由侧**的处置分流,执行面一行未动。

**要治的病(2026-09-02 prod 死亡螺旋,任务 `6d4574df-1a25-48dc-8bd9-c2449f21ddf7`)**:一次失败在控制面只有一种解释 —— 终态非 0 即质量失败 —— 于是「环境坏了」与「agent 做错了」共用同一条返工链路,而这两类失败的返工收益一个是零、一个是正。

**标本时间线**(全部来自事件链;`verifier attempt = f1673050`):

| 时刻 | 事实 | 当时的处置 | 应有的处置 |
|---|---|---|---|
| t+0 ~ +14min | writer 一次成功,候选导出、证据钉住 | ✅ 正常 | ✅ |
| ~t+15min | verifier:`apply.exit_code=0`(**补丁完好、可重放**),`verify.exit_code=1`,`stderr_tail` 里是 `[ensure-deps] 缺少 node_modules/.bin/tsc, …` → `npm install` → `npm error code ECONNRESET` / `npm error network aborted` / `npm error network This is a problem related to network connectivity.` | 当质量失败 | 重试 verifier,或 BLOCKED 转人工 |
| +1 | `verify.rework_scheduled` → writer 全量返工 #2(新沙箱 + 重新 clone + 重灌上下文) | 跑满 2400s 墙钟 → **exit 55** | — |
| +2 | exit 55 又被当成失败 → 返工 #3 | 再跑满 2400s → **exit 55** | — |
| +3 | `DEFAULT_MAX_ATTEMPTS=3` 耗尽 → 熔断 `BLOCKED` | ≈50 分钟 + 数 M token 白烧 | 第一次 exit 55 就该停下 |

三次错误定性叠成一条链:**环境故障没被识别 → 烧掉一轮返工;预算到期没被识别 → 再烧两轮**。预算不会因为重开沙箱而多出一分,所以「再返工一轮试试」在这两类上的期望收益恒为零。

**分类判据**(`src/routing/classify.ts`,纯函数:不读 env、不碰 DO、不写事件,输入全注入,可与将来的 Supervisor 共用同一份口径):

| kind | rule | action | 默认档 | 判据 |
|---|---|---|---|---|
| `budget_turns` | `writer_exit_53_session_turns` | `blocked` | **enforce** | role=writer 且 `exit_code=53`(qwen 0.22.3 `nonInteractiveCli.ts` 的 `enforceSessionTurnLimit`) |
| `budget_abort` | `writer_exit_55_budget_abort` | `blocked` | **enforce** | role=writer 且 `exit_code=55`(qwen `chunk-DJPASAUV.js:42029-42032`,`--max-wall-time` / `--max-tool-calls` 超限;**不是 token 预算** —— token 侧从不执法,§13.20) |
| `env_transient` | `verifier_env_network_signature` | `none`(不主张改动) | **shadow** | role=verifier 且 `apply.exit_code=0` 且 `verify.exit_code≠0` 且 `verify.stderr_tail` 命中依赖安装阶段的网络签名 |
| `quality` | `quality_fallback` | `rework` | enforce(= 既有语义) | 其余一切:writer 的质量失败、verifier 的 apply 失败(候选不可重放)、非环境签名的 verify 失败、验证器基建错误(`-1`) |

`action` 三取值:`blocked` 改路由(停下转人工)/ `rework` 主张返工(现状)/ `none` 表示分类器**不主张**改动 —— shadow 档用它:分类照记,处置权留在既有链路上。下一期把某条规则切 enforce 时,改的是这张表里的动作与模式,**接线点不动**。

**网络签名的三条通道**(`ENV_NETWORK_SIGNATURES`)都取 npm 自己给错误归类的产物:裸 errno 词 `ECONNRESET` / `ENOTFOUND` / `ETIMEDOUT`;`npm error code <网络码>`(显式枚举 `ECONNRESET|ECONNABORTED|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|ENETDOWN|ENETRESET|EHOSTUNREACH|ESOCKET|EPROTO|ERR_SOCKET_TIMEOUT`);`npm error network …` 行前缀。刻意**不是**「以 E 开头就算」:`ERESOLVE`(依赖树冲突)、`EACCES`、`ENOENT` 同样是 E 前缀却与网络无关,误命中会把该返工的缺陷洗成环境问题。同理,任务自己的测试连不上本地服务时那句裸 `connect ECONNREFUSED 127.0.0.1:5432` 不命中 —— 只有带 `npm error code` 前缀的那条才等于 npm 自己出不了网。

**接线三处**(都落在「即将派返工」的那一刻;分类器是唯一的改路由来源):

- `onWriterReport` 的 `exit_code≠0` 分支(`writer.failed` 之后、`scheduleRework` 之前)→ 命中预算档即 `BLOCKED`,**绝不** rework 同规格;
- `onVerifierReport` 的验证失败分支(`verify.completed(passed=false)` 之后、`onVerifyFailed` 之前),输入含 `parseVerifyReport(result_text)`;
- `reportExecution` 的 `exit_code<0` verifier 分支:被到期击杀的 verify 进程照样回报了结构化报告(`verify.exit_code=-1`),它的 `stderr_tail` 里也可能带网络签名 —— 这类样本也要攒进链里。§13.19 说的「verifier `-1` 现路由仍进返工」本期**未改**,只是让它从此可被计数。

`TaskSession.routeFailure()` 是无条件的一跳:分类 → 落事件 → 只有 `action=blocked` 才改路由。`blockByRoute()` 与 `onBaseFailed` 同族 —— 不派返工、不递减 `DEFAULT_MAX_ATTEMPTS`、置 `awaiting_human`、`BLOCKED` 即归档。`task.transition.reason` 按 kind 分别措辞(`budget_turns` 指向 `DEFAULT_MAX_SESSION_TURNS`,`budget_abort` 指向 `MAX_WRITER_WALL_MINUTES` 并写明「不是 token 预算」),人在 BLOCKED 那头不必反查 exit code 的语义。**没有登记理由的 kind 一律 throw**:将来若新判据也主张 blocked 却没在这里登记理由,必须当场炸,不能顶着「预算到期」的旧说法进归档。

与 §13.20 的分工要说清:那一节立的规矩是「不拿 token 台账执法」,本期没有违反 —— 执法依据是 qwen 自己下发的退出码,`max_model_tokens` 与四列台账在任何路由判据里都不出现。

**事件形状**(进 DO 事件 hash chain —— append-only 权威层,不改链的 digest 语义;终态归档后 `/api/admin/events` 读得到):

```json
{"kind": "route_decision", "payload": {
  "attempt_id": "…", "role": "writer|verifier", "exit_code": 55,
  "outcome_kind": "budget_turns|budget_abort|env_transient|quality",
  "rule": "writer_exit_55_budget_abort", "action": "blocked|rework|none",
  "enforced": true
}}
```

`enforced` 读的是 `ROUTE_RULE_MODES[rule] === "enforce"` —— **模式表的取值,不是调用点的心情**。enforce 与 shadow 都发事件,shadow 事件 `enforced=false`。

**为什么两条 exit code 判据可以默认 enforce**:退出码是平台自己下发给控制面的语义,不是从自由文本里猜出来的信号。53/55 只可能由 qwen 的预算执法产生 —— 那条命令是我们亲手拼的(`src/exec/sandbox.ts:qwenCommand` 显式带 `--max-session-turns` / `--max-wall-time`)。判据里没有启发式,因此没有误报面,不需要观测期。

**为什么这两条只在 writer 侧生效**:只有 writer 的退出码来自那条我们拼的命令。verifier 的 `exit_code` 就是任务自己那条 `verify_command` 的退出码,任意脚本都可能吐 53/55;拿它当「预算到期」会把真质量失败洗白成平台问题(比返工更糟:任务被静默停成 BLOCKED 而无人复核)。

**为什么环境签名必须 shadow**:它是错误文本的启发式匹配,存在真实误报面。仓内惯例是「有否决权的开关先攒样本再 enforce」—— `REJECT_EVIDENCE_MODE`(§13.12)、`BASE_PIN_MODE`(§13.13)、`EGRESS_MODE`(§13.14)皆如此,本条同一口径。**切 enforce 的判据先写死,以免将来靠感觉**:`route_decision ∧ outcome_kind=env_transient` 的样本 ≥10 条、且人工复核误报率 <10%,才谈处置;而届时的处置首选**重试 verifier**(换容器重验有意义),不是 BLOCKED 转人工,更不是返工 writer。

**刻意不做**:不改 exit 53/55 的产生侧(qwen 的预算机制不动);不写 env_transient 的 enforce 与 `retry_verifier` 分支(样本未够,不写半截的 retry);不动 evidence / binding / digest / 审批逻辑;不改 writer/verifier 的执行行为本身(只改它们结束后的路由);不做 Supervisor 与外圈告警(下一期,与本 case 正交)。

**后续(M9.5④):分类不变,但 BLOCKED 不再是零信息**。分流把「预算到期」从返工里摘出来,省下的是下一轮的 25 万 token;它治不了另一半 —— 人被转到 BLOCKED 时手里仍然只有一个退出码,writer 跑掉的那 40 分钟整份蒸发。本期补的就是这一半:导出条件放宽到预算类退出码,产物自称不完整(`patch_complete: false` + 原因),读端口径见 §7.2.1 与 §9 的 manifest schema。**分类与处置一字未动** —— 55 仍是 `budget_abort` 仍 BLOCKED,差量不升格成候选、不触发自动返工、`current_evidence` 的钉住规则不变。

**再后续(c13):接线接到人手上**。M9.5④ 只走通执行面那一半:被击杀那一轮从不钉证据(`onWriterReport` 里 `routeFailure → return` 在 `pinWriterEvidence` 之前),所以 `/candidate` 对 BLOCKED 恒 404,`patch_complete` 那批字段在 BLOCKED 路径上没有读者。本期补读面(§7.2.2):新增 `GET /api/tasks/:id/rescue`(BLOCKED 专用)与 `getRescueRefs()` / `assembleRescueView()`,落地端 candidate 门同批读 `patch_complete` 拦不可逆动作。**审批口径一字未动** —— `current_evidence` 仍是唯一证据口径、`binding_digest` 组成不变、verified/approved 门禁不变;rescue 视图的 `binding_digest` 恒 `null`、`safe_to_apply` 恒 `false`。测试手法上把 manifest 的材质化从 step 闭包提成 `buildAttemptManifest` 并让 handler 测试直接与它配对,修掉的反模式是「消费者测试配合成 fixture、从不与生产者配对」:c12 的变异验证里 V6/V10/V11 三条因此全绿,现三条均由 `test/rescue-api.test.ts` 钉红(逐条实测过变异,非推断)。V7/V8(`VerifyReport` 的不完整原因与其读端判据)**仍无取证路线**,保持原样未动:被预算击杀的 writer 走不到 verifier,它们是零读者的保险条款,本期既不删也不为它们写测试。

**验证与边界**(2026-09-02 本地):`npm run typecheck` 干净;`npm test` → 21 文件 **354** 条全绿(基线 323 + 新增 31:`test/routing-classify.test.ts` 22 条判据穷举 + `test/routing-do.test.ts` 9 条真 DO 路由)。新增夹具 `test/fixtures/env-transient-report.ts` 保存标本的 `stderr_tail` 形态(四处引文原样保留,其余按 npm 10 的既有输出形态补全,夹具里写明了保真度边界)。DO 侧钉法:`exit 55` → `route_decision{budget_abort,blocked,enforced=true}` + `BLOCKED` + `awaiting_human` + writer attempt 数不变 + 无 `writer.rework_scheduled`;`exit 53` 与 `exit 55` 的 reason 可分辨;shadow 环境签名与同形普通质量失败的**路由行为逐字段等值**(事件种类序列、`verify.rework_scheduled` 的字段集 / reason / attempt_number、attempt 计数、`task.state`),只有分类字段不同;`route_decision` 在链上的位置(`writer.failed` 之后、`task.transition` 之前)、seq 单调、digest 前继,以及 BLOCKED 归档后从 D1 `events` 读回的 canonical 原文与 digest 同值。质量路径一条断言未改即全绿 —— 那就是「语义不变」的回归证据。**变异验证五条**(逐条改坏判据,确认用例真能抓到它声称抓的东西;数字为变红条数,还原后全绿):`EXIT_BUDGET_ABORT` 55→54 → 5 红;删掉环境判据的 `apply.exit_code!==0` 约束 → 1 红(apply 失败被洗成环境问题);`quality_fallback` 模式 enforce→shadow → 4 红(`enforced=true` 断言);删掉 verifier 侧接线 → 3 红(`route_decision` 缺失);预算判据放开到两个角色 → 2 红(role 区分失守 —— verifier 的 53/55 会被当预算到期停成 BLOCKED,把真质量失败洗白)。**prod 未取证**:53/55 分流的可达性由测试证明,真实命中要等下一个撞预算的 attempt;`env_transient` 的 shadow 样本从本版本部署起才开始积累。

---

### 13.22 失败任务的用量必须逐事件累加(M9.5④)— 已实现:累加是唯一提取路径,完成态额外对账

**问题(2026-09-02 prod 取证,任务 `76464e22`)**:§13.20 的提取有两条启发式分支 —— 完成态从 result 事件取会话累计值(实测 C8 writer:input 14,954,778 / cache 14,737,154 / output 75,677 / 加权 3,240,732,与 fresh+output+0.2×cache 精确吻合,完成态确实不漏);被杀任务**没有 result 事件**,于是落到另一条分支:「有效 total 最大的一条 assistant」。单次调用里 total 最大 ≈ 最靠后的那次,记的是**一次调用**的量:

| 口径 | 旧提取归档(= 末次调用) | 按事件流累加的真实会话总量 | 漏 |
| --- | --- | --- | --- |
| input | 221,006 | 10,686,994 | **48.4×** |
| cache_read | 219,186 | (同批事件累加) | — |
| 成本加权 | 45,818 | 2,495,488 | **54.5×** |

**为什么这不是可以忍的噪声**:漏记只发生在**失败**任务上。被墙钟击杀的 attempt 往往是烧得最久、最贵的那批,而 C8 的路由分类与人工成本审计吃的正是这个数 —— 一个「成功任务准、失败任务低两个数量级」的台账,会把「该收口预算的任务」读成便宜任务。偏差与故障形态相关,就不是误差。

**改法(消灭分支形状,不是换一条更好的启发式)**:

1. **逐事件累加成为唯一提取路径**(`accumulateUsageFromTranscript`,纯函数、不依赖时钟、注入事件数组即可单测):遍历该 attempt 全部 `type === "assistant"` 事件,按字段累加每次调用的 usage。完成态与被杀态**走同一条路径**,不再有任何「有 result 走 A、没 result 走 B」的形状。
2. **`result` 事件降级为对账基准**,永不参与累加(它已是累计值,加进去即双计)。
3. **完成态对账(同源测试)**:同一份 transcript 里「逐次调用之和」与「result 的会话累计值」不是两个可互相近似的估计,而是**同一个量的两种记法**。不相等 → 抛 `TranscriptLedgerMismatchError`,消息带上两侧数值、逐字段差值与差异来源候选(不带 usage 的 assistant 条数 / 部分调用漏报的字段 / 多条 result / 未知类型带 usage 的事件),**绝不静默取其一**。判据刻意严格到「字段覆盖不齐以致无法证明相等」也算失败:无法证明相等就不能宣称相等。执行面的处置是**响亮但不越界**:workflow 捕获后把差异原样 `console.error`(`stage=extract-ledger`),台账记 null(=未记录,不是 0),结果文本与补丁照旧回报 —— 一次成功的执行不该被记账分歧毁掉(见 §13.19 的教训:抛在 extract step 会走到 report-blocked,连劳动一起丢)。
4. **两条口径同源**:DO 快照的 `result.captured.total_tokens` 与 D1 归档四元组由同一个累加产物给出 —— workflow 调一次累加、`tokens` 与 `usage` 都从它身上取;DO 侧用 `totalFromUsage(usage)` 重算而不信消息里那个冗余的 `tokens`,两者不一致时喊 `ledger_total_drift`(不静默改)。这与 p2 的 `resolveBudget` 同一条教训:**两处各算一遍,缺陷就会以新形状复活**。顺带修掉 reviewer 侧同样的形状(`tokens` 不再独立取 `usage.total_tokens`,改从同一规范化对象派生)。
5. **被杀态钉死在测试里**:r2 向量(3 次调用、无 result、会话合计与取证逐字段相等)断言提取值 = 全部调用之和,且既不等于末次调用也不等于最大一次调用;成本口径仍是 fresh+output+0.2×cache = 2,495,488(旧值 45,818)。C8 向量钉完成态:累加值与 result 累计值同时命中同一组数(14,954,778 / 14,737,154 / 75,677 / 加权 3,240,732)。

**口径澄清**(旧文档靠约定维持、现在由代码保证):单次调用的 `usage.total_tokens = input_tokens + output_tokens`(input 含 cache_read)是**单次值不是累计值**;累加侧的 `total_tokens` 只有在每次调用都可得(直接给或由 input+output 推出)时才进结果,否则留空 —— 部分和不是总量。

**刻意不做**:不改预算/墙钟机制(归 p2)、不改路由分类器判据、不动 Observation 层的 journal/ingest/事件协议(提取的输入是 transcript 与既有事件,只读)、不新增指标/看板/外部告警、不引新依赖。历史行不回填:被杀任务那批旧行的低估留在原地,读端看 §13.20 与本节的取证说明。

验证:`npm run typecheck && npm test` 全绿(30 文件 607 测试;`test/token-ledger.test.ts` 28 条覆盖被杀态/完成态对账/解析卫生/唯一推导处,`test/session-do.test.ts` 新增 2 条钉两口径同源与被击杀 attempt 的台账量级)。

### 13.23 provider 错误与候选质量失败分流(writer 侧补档 / reviewer 侧三因合一)— 已实现,`shadow` 中

**问题(两起标本,同一个病的两个读面)**

1. **writer 侧**(2026-09-03,task `daa8dd44-7a94-43b5-8b49-5cea27e0c050`,base `f8885c8`):三个 writer attempt 全部 `exit_code=11` → `route_decision` 三连判 `outcome_kind=quality / rule=quality_fallback / action=rework` → attempts 耗尽 `BLOCKED`。白烧 2 轮返工(每轮一次克隆 + `npm ci` 的沙箱开销,零产出)。attempt-1 的 transcript(196KB,digest `53f2fe39…`)前 16 轮完全健康,第 17 轮起模型 API 回 403,终态 result 文本整串是
   `[API Error: 403 Access to model denied. Please make sure you are eligible for using the model.]`(95 字符,`is_error:false` —— **CLI 把 API 错误当成功结果回报**);attempts 2/3 首调即死(`total_tokens=0`,同一份文本)。根因是 token-plan 端点对该模型的购买资格失效(`403 AccessDenied.Unpurchased`),与补丁质量零相关 —— 重开沙箱原规格重做,拿到的是同一个 403。
2. **reviewer 侧**:`runReviewLLM` 有**三个** `return { exitCode: 12 }` 位点(传输失败/到期 abort、非 2xx、`JSON.parse` 失败),三件事共用一个码。它的路由与 writer **不同轴**:reviewer 的 `exit!=0` 走 `verdict=none` → `review.unavailable` → `holdForHuman`,**不烧返工**,而是把任务钉在人工闸门上。prod 台账(56 次带首尾时刻的 reviewer attempt):墙钟中位 **27.0s**;记到 token 的 50 次最长排到 **64.6s**(另有一次 08-31 的 250s 无法拆解,不计入);**6 次 0 token 的全部落在 67.8–71.1s**(= 旧的 60s abort + 约 8~11s 排队/step 开销)⇒ 6/56 ≈ **11%** 的审查以超时收场,且集中在差量大的候选上 —— 一个纯粹太紧的上限,表现成 11% 的「需要操作员来判定这个候选」的假信号,而 reason 里只有 `exit_code=12`,看不出该改上限还是端点挂了。

同构先例:M9 时 verifier 的平台错误曾被当「修复指令」喂给 writer 重做(烧 137K tokens);§13.21 那一棒修的是 verifier 侧的基建/质量分流。**本棒是 writer 侧的同构补齐**,不发明新机制 —— 用的就是 §13.21 那条 `outcome_kind` 轴,给它补一档。

**判据(`src/routing/error-class.ts` = 唯一的成因词表)**

- `ErrorClass` 六个成员:`provider_access_denied` / `provider_quota_exhausted` / `provider_model_unavailable` / `upstream_error` / `upstream_timeout` / `bad_response_body`。后两个是 reviewer 三个位点带来的;**前四个与 writer 的 provider 分类共用** —— 刻意不立 `reviewer_failure_class` 之类的第二套词汇:两套词表迟早漂移,而漂移的表现是同一个故障在两个读面上叫两个名字。
- 分类器是纯函数,输入 `{result_text, exit_code}`,输出 `{is_infra, error_class}`。**按形状判读,一处都不读 `exit_code` 的数值**:11 只是 `adjudicateCliExit`(§7.2.1)上翻的产物,拿它当判据是循环论证 —— 测试用同一份文本换 9 个退出码断言结论逐字段相同。`is_error:false` 更说明「CLI 说成功」这件事本身不可信。
- 三条形状通道,全部**整串匹配**(与 §7.2.1 同一理由:包含即失败那个假设已被 c15 打穿过三次 —— 规格要求 writer 在总结里讨论这些字样):`[API Error: <3 位码> …]` 包壳(状态码必须后面不接数字,`4033` 不读成 `403`)/ 裸 `AccessDenied.*` / 裸定长机器码。与 `src/exec/cli-exit.ts` 那张形状表做**锁步断言**:它认的整串错误形状,这边必须给出非 null 成因,否则两张表分叉会立刻炸测试。
- `is_infra` 只给「重开沙箱原规格重做必然复现」的四类;**`upstream_error`(5xx / 无码 / 裸 `upstream_error`)刻意 `is_infra:false`** —— 里面混着瞬态。漏报可以(unknown 落 quality 走老路),**误报不行**:把质量失败判成 infra 会吞掉本来该返工的轮次。

**分流(`ROUTING_INFRA_MODE`,三档,缺省 `shadow`)**

| 档 | `route_decision` | 新事件 | 处置 |
| --- | --- | --- | --- |
| `off` | 逐字段 = 本棒之前 | 不落 | 照旧 quality → rework |
| `shadow`(缺省) | 逐字段 = 本棒之前 | `route.infra_candidate` 一条 | **路由动作一字不改**,照旧 rework |
| `enforce` | `outcome_kind=provider_infra / rule=writer_provider_error_shape / action=blocked` | 照落,`mode=enforce` | 不派返工,`BLOCKED` 转人工 |

- 顺序写死:两条预算判据(53/55)在 provider 形状之前 —— 同框时人在 BLOCKED 那头要调的旋钮是预算,不是端点资格。
- 这条判据的档位**不进** §13.21 那张编译期模式表:它是运行时旋钮,两处各存一份等于让事件里的 `enforced` 与实际处置各说各话。
- 事件卫生:`route.infra_candidate` 的 payload 只有枚举与数值(`attempt_id / role / exit_code / error_class / is_infra / mode / action`),**不带原始错误文本** —— 与 c10b 心跳「不带自由文本」同一理由:观测/路由面一旦能带文本,它就成了新的外流面。reviewer 侧同规矩:`review.unavailable` 的 reason 是 `reviewer_unavailable:<ErrorClass>`,响应体原文只留在 `attempts/<id>` 的 transcript 产物里。过去那个 `error` 自由文本位点对 reviewer 恒为 undefined(它只在长命令轮询路径上被赋值),所以改判 reason 不丢既有诊断。
- reviewer 三个位点**退出码仍是 12**(换码等于悄悄改 `onReviewerReport` 的路由语义),分流靠枚举;`onReviewerReport` 的处置一行未动 —— 既不返工也不放行,照旧交人工,只是原因现在可分辨。
- 新的 chat 上限是算出来的:`REVIEW_LLM_TIMEOUT_MS = ceil(64_600 × 1.5)` = **97_000ms**(最慢真实成功 × 1.5 余量,向上取整到整秒;样本只有 50 个成功点,最大值之外没有分位数可估,所以不挑整齐的 120s)。**现场核对(abort 必须早于外层预算)**:最坏 = 97s + 11.1s 实测最大开销 = 108.1s;reviewer attempt 的截止 = `resolveBudget(undefined, env).budgetSeconds` = `DEFAULT_MAX_WALL_SECONDS = 3600`(测试环境最紧的配值是 600s)⇒ 余量 33 倍 / 5.5 倍;`runReviewLLM` 自己 catch 掉 abort 从不抛错 ⇒ 不触发 `EXEC_RETRIES` 的 step 重试(否则会 ×3 = 324s);workerd 单条 await 的挂起检测 ≈ 29:48(§13.18)⇒ 余量 16 倍。这组不等式由 `test/review-error-class.test.ts` 钉住:将来把上限改成「一个更大的数」而越过截止,测试会红。

**新事件的形状**(进 DO 权威链,与 `route_decision` 同一通道):

```json
{"kind": "route.infra_candidate", "payload": {
  "attempt_id": "…", "role": "writer", "exit_code": 11,
  "error_class": "provider_access_denied", "is_infra": true,
  "mode": "shadow", "action": "rework"
}}
```

`error_class` / `mode` / `action` 三个字段都是枚举,`exit_code` 是数值,**没有任何自由文本位点**。
`action` 记的是这条事件落地时本次失败**实际走过**的路由 —— 攒样本要能回答「enforce 会省下几轮返工」,
而 shadow 期它恒等于 `rework`(那正是标本里白烧的两轮)。`event_kind` 在 D1 里是无约束的 `TEXT`
(§6.1),新名字不需要迁移;Observation 层那张 `OBS_EVENT_KINDS` 是唯一的硬注册表,只管 journal,
控制面事件不进那里。

**编号说明**:本节刻意不叫「c15 那一棒」—— `c15` 在本仓已被 §7.2.3 用作**任务规格**的编号
(`src/exec/cli-exit.ts` 的「c15 三次俱毁」指的是那次跑出来的标本),一名两指正是本节要消掉的漂移。
新判据一律以 §13.23 引用。

**测试**

```bash
npm run typecheck && npm test
timeout 240 npm test                                            # 全量收敛确认
./node_modules/.bin/vitest run test/routing-error-class.test.ts test/review-error-class.test.ts   # 定向
```

`test/fixtures/provider-error-report.ts` 按逐字标本收录(95 字符这条事实由断言钉住)。三组判据各钉一面:① 不读数值(同一文本换 `[0,1,11,12,20,53,55,127,-1]` 结论逐字段相同;形状不符的 11 一律 unknown);② 不误报(13 条「像但不算」的散文/多行/半截包壳/四位状态码全部 unknown,`upstream_error` 恒 `is_infra:false`);③ 词表唯一(与 `isCliErrorShape` 双向锁步,枚举无重名,`reviewer_failure_class` 这类第二个词汇不认)。档位三档各一条:off 与 shadow 的决策 `toEqual` 相同、shadow 仍 `writer.rework_scheduled` 且不 BLOCKED、enforce 才 `provider_infra/blocked`。DO 侧 `test/routing-do.test.ts` 把三档全部端到端钉在真事件链上(拨 `env` 袋就是 DO 读到的 `this.env`):缺省档(测试环境不写这个 var ⇒ 就是 shadow)重放 2026-09-03 标本 —— `route.infra_candidate` 整表 `toEqual`(多一个文本字段就红)、`route_decision` 七字段逐字等值于分流之前、仍 `writer.rework_scheduled` 且不 BLOCKED;`enforce` 档同一个标本 → `outcome_kind=provider_infra` + `BLOCKED` + writer attempt 数停在 1 + reason 带枚举而不带原文,且质量文本**照旧返工**(不扩大打击面);`off` 档连候选事件都不落。成功回报不经过分流。reviewer 侧按三个位点逐个注入(`globalThis.fetch` 替身),断言同码不同因、三个成因两两不同、原始响应体不进成因;DO 侧 `test/session-do.test.ts` 钉住 `review.unavailable` 的 reason 只有枚举、三种成因的处置逐字相同。

验证:`npm run typecheck` 干净;`timeout 240 npm test` 全绿(**33 文件 687 测试**,基线 627 + 本棒新增 60:`test/routing-error-class.test.ts` 37 + `test/review-error-class.test.ts` 14 + `test/routing-do.test.ts` 7 + `test/session-do.test.ts` 2)。既有断言无一处判据被改弱:只有两条既有用例**加**了断言(`session-do.test.ts` 的字段映射守卫登记新枚举位点、reviewer 基建失败那条补 reason 只带枚举),其余全绿原样 —— 那就是「off/shadow 不改语义」的回归证据。**prod 未取证**:`provider_infra` 的 enforce 路径只有测试证明可达,真实命中要等下一个撞端点资格的 attempt。

**边界(本棒不做)**:不做模型调用重试、不自动换模型(操作员配置决策);verifier 侧分流不动(§13.21 已修);预算账本口径不动(p2 的域);不加状态机状态、不加 npm 依赖;不动 `DEFAULT_MAX_ATTEMPTS` 与返工次数上限本身的逻辑;不动 `onReviewerReport` 的路由动作。平台不持 push 凭据。

**未解决 / prod 取证(推进条件)**:`provider_infra` 在 prod 的真实命中率为零 —— 这条判据自本版本部署起才开始积累样本,`shadow` 期的 `route_decision` 全部仍是既有取值。切 `enforce` 的判据先写死,以免将来靠感觉:`route.infra_candidate ∧ is_infra=true` 的样本 **≥5 条**、人工复核**误报率 0%**(每条都核对过「这确实不是候选质量失败」,判据是整串形状,所以这一项应当是机械的)、且**没有一条**样本在后续同任务里靠返工自救成功 —— 三条同时成立才谈有否决权(与 §13.21「≥10 条 + 误报率 <10%」同一纪律,这里的门槛更低是因为判据不含启发式:整串形状要么对要么错,没有中间态)。reviewer 侧的 11% 超时率同理要复核:新上限 97s 生效后,`review.unavailable ∧ error_class=upstream_timeout` 的占比应显著下降;若仍有可观命中,说明延迟分布本身变了(不是「再拍一个更大的数」的理由,而是回到台账重量)。

---

## 14. 延伸阅读

- [`../research/agent-research/docs/research/cloudflare-ai-infra-overview-2026-08-28.md`](../../../research/agent-research/docs/research/cloudflare-ai-infra-overview-2026-08-28.md) — Cloudflare AI 基础设施调研
- [`../research/agent-research/docs/research/cloudflare-ai-agent-best-practices-2026-08-28.md`](../../../research/agent-research/docs/research/cloudflare-ai-agent-best-practices-2026-08-28.md) — 工程最佳实践手册
- `README.md` — 部署与冒烟命令

---

## 15. 落地取证清单(操作员在 prod 上必须跑通)

本节的三条是 §6.2 那批机制的**prod 判据**。本地全绿不算落地:三条都只有真实 D1 + 真实
tail 能回答,而且每条都对应一个「本地绿而 prod 坏」的历史教训(§13.16:workflow
orchestration 在本地一行都没跑过)。任何一条不成立,就回到 §6.2 对应的小节读判据边界,
不要靠加日志碰运气。

```bash
export API=https://cloud-agent.aflow.workers.dev
auth=(-H "authorization: Bearer $WORKER_API_TOKEN")
```

### ① 新任务跑完:`archived=true` 且 D1 events 行数 == DO 链条数

```bash
# 任取一个刚跑到终态的 task_id(不要挑本节 ② 那个损坏标本)
curl -s "$API/api/tasks/$TASK_ID" "${auth[@]}" | jq '{archived: .task.archived, state: .task.state, do_events: (.events|length)}'
curl -s "$API/api/admin/chain-check?task_id=$TASK_ID" "${auth[@]}" | jq '{result, do_events, d1_events, broken, brokenTasks}'
```

**通过标准**:第一个响应的 `archived` 为 `true`;第二个的 `result == "consistent"` 且
`d1_events == do_events`(同一份 DO 快照的链长,两处必须同一个数)。`state` 已终态而
`archived=false` ⇒ 归档没落地,立刻走 ③ 与 `archive_stalled`。

顺带复核全局口径:`curl -s "$API/api/admin/chain-check" "${auth[@]}" | jq .broken` 应为 0,
且 `brokenTasks` 里没有 `:seq` / `:state` 后缀(§6.2.3 的两条新判据)。

### ② 损坏标本 `5489dc8a` 必须报 `not_archived`

```bash
curl -s "$API/api/admin/chain-check?task_id=5489dc8a-… 全长度 id" "${auth[@]}" | jq '{result, do_events, d1_events}'
```

**通过标准**:`result == "not_archived"`,且 `d1_events == 0` 而 `do_events > 0`。
这是 prod 里唯一那条损坏样本(§6.1:seq 4/5 各重号 5 次撞 `idx_events_task_seq`),
**留着就是为了这条取证** —— 它不该被「修好」,也不该被清掉:它是「新代码也不替它归档成功」
的唯一实物证据,也是对账模式与 `archive_stalled` 这两条出口是否真的通的最小回归样本。
若哪天它变成 `consistent`,说明有人手工补写过 D1 行 —— 那是数据篡改事件,按 §9 的证据口径处理。

同时确认全局模式仍然看不见它:`GET /api/admin/chain-check` 的 `checked` 不包含这条任务。
**这不是 bug,是本节存在的理由**(§6.2.3 第 1 条)。

### ③ 真实终态回报 RPC 的 wallTime 必须显著低于 30 秒

```bash
# 另一个终端:抓 TaskSession 的 RPC 调用与耗时
npx wrangler tail --persist-to /tmp/wrangler-tail 2>&1 | grep -Ei 'reportExecution|TASK_SESSION|wallTime|outcome'
# 同时看两条新日志是否只在真出问题时出现
npx wrangler tail 2>&1 | grep -E 'sandbox_destroy|archive_stalled'
```

**通过标准**:一个 attempt 终态时那条 `reportExecution` 的 `wallTime` 在**百毫秒量级**
(§6.2.1 之前的实测是 30004ms ⇒ `exceededWallTime`,那正是整条事故链的触发因);
`outcome` 不得再出现 `exceededWallTime`。日志侧:正常路径只应有
`sandbox_destroy ok attempt=… reason=attempt_finished:exit=N`。
出现 `sandbox_destroy timeout` 说明 destroy 又在抖 —— 它现在只延迟 5 秒而不是拖死回报,
但要记进运维台账(容器改由平台回收,孤儿 token 燃烧的窗口 = 平台回收时刻)。
出现 `archive_stalled` 则按 §6.2.2 的口径处理:看 `attempt=` 爬到第几档,并用 ① 的
对账请求判断有没有恢复。

### 为什么这三条不能只靠测试

`test/session-do.test.ts` 的 (d)(f) 与 `test/admin-events.test.ts` 的 chain-check 用例钉的是
**机制**(阶梯值、日志格式、三态判定),它们不知道 prod 上有没有一条正在停滞的任务:
测试环境没有 Sandbox 绑定(销毁必然走 failed 分支)、D1 是每次新建的空库、alarm 由测试
本体触发而不是平台排程。上面三条量的恰好是这三件事在真实环境里的样子。
**被击杀的棒不自动获准进入下一相** —— 同理,没跑通本节的部署不算落地。
