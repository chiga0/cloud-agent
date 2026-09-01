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
| **可交付** | 每个 repo 候选绑定一个精确基线 commit(writer 与 verifier 在同一个 SHA 上工作),经 `GET /tasks/:id/candidate` 原样取回并在本地重放(§13.13) |
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
 ┌──────────────┐   POST /tasks                  ┌──────────────────────────────┐
 │  外部调用方   │ ─────────────────────────────►  │  Worker (src/index.ts)       │
 │  CLI / UI    │                                 │   ├─ 控制面 API              │
 └──────────────┘                                 │   └─ Queue consumer          │
       ▲                                          └──────┬───────────────────────┘
       │ GET /tasks/:id  /result                         │
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
- `max_model_tokens` / `max_wall_seconds` — 预算(时长/turn 由 qwen-code 参数硬停;tokens 事后记账)
- `tokens_used` — transcript 解析出的实际用量,由 workflow 的 extract step 统计
- `workflow_instance_id` — 对应的 Durable Workflow 实例
- `idempotency_key` — `task_id:attempt:N` 或 verifier/reviewer 场景的自定义键,UNIQUE 约束保证去重
- `base_pin` — 本轮要材质化到的精确 commit;返工轮由 `TaskRecord.base` 继承,并写进 `attempt.created` 事件

> `proxy_token` 列是旧代理架构的遗留(0001 schema),主流程已不使用,保留兼容。

### Decision
人工(HITL)或系统对 attempt 的判定。`POST /approve` 只收 `approve|reject`;落库的决策值另有两个内部产物——`accept_with_notes`(reviewer 想返工但举证不成立,降级放行、意见留档)与 `none`(reviewer 抖动或没产出结论,挂 `awaiting_human`)。任何 decision 强制绑定组合证据 digest(§13.9)。

### Candidate
repo 任务的产出物:一份基于**冻结基线**的 git patch + 它的证据血统。它**不是新的状态对象**,而是 `TaskRecord.base` + 钉住的 writer manifest + verifier 结论 + 最新 decision 的读模型投影(`src/audit/candidate.ts`),经 `GET /tasks/:id/candidate` 取回。`status` 与 `safe_to_apply` 的存在是为了让消费方一眼分清「独立验证过」和「只是产出过」——被 reject 或基线漂移的候选不能看起来像可直接提交。

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
| **RUNNING** | ✅(rework 下一 writer) | ✅(writer 成功,派验证器) | ✅(非 repo 任务 / verify fan-out 降级,派 reviewer;无进展熔断直接挂起) | | | ✅(workflow 错误 / writer 失败耗尽) |
| **VERIFYING** | ✅(验证失败,预算内 rework) | | ✅(验证通过,派 reviewer) | | ✅(验证失败且预算耗尽) | ✅(验证器基建错误耗尽 / 超时) |
| **AWAITING_APPROVAL** | ✅(reviewer reject 且证据契约成立,预算内 rework) | | | ✅(approve / accept_with_notes) | ✅(reject) | ✅(超时兜底) |
| **DONE / REJECTED / BLOCKED** | — | — | — | — | — | —(终态) |

语义区分:
- **REJECTED** = 质量否决(reviewer/verifier 判定候选不合格,且 rework 预算耗尽)
- **BLOCKED** = 执行故障(writer 反复失败耗尽、workflow/基建错误、超时),证据链可定位原因
- writer `exit_code != 0` **绝不**进入审批流(硬门禁),只能 rework 或 BLOCKED
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

M1 起权威从「Worker 直接 CAS D1 行」迁到 `TaskSession` DO,早期的 `src/control/authority.ts` 自由函数(`createTask/createAttempt/transition/recordDecision`)已删除。现存三文件分工:

| 文件 | 职责 |
|---|---|
| `session.ts` — `TaskSession extends DurableObject` | 唯一写者:状态机、attempt 编排、证据钉住、决策、终态归档 |
| `statemachine.ts`(纯) | 转换表合法性、`attemptDeadline` / `nextWatchdogAlarm`、`composite` 组合 digest |
| `gates.ts`(纯) | 门禁分级判定、`describeVerifyFailure` 等返工指令生成 |

**RPC 面**:写入 `createTask` / `startAttempt` / `reportExecution` / `submitDecision` / `alarm`;只读投影 `getSnapshot` / `getResultText` / `getEvidenceSummary` / `getCandidateRefs` / `getAttemptManifestKey`。Worker 侧不做任何仲裁,只做 HTTP ↔ RPC 的转换与 R2 读取。

**关键设计点**:

- DO 是**运行中**任务的权威;D1 只是终态归档 + 查询视图。Workflow 历史、日志、R2 文件都不是仲裁依据。
- 每条写路径(含 `alarm`)整体包在 `ctx.blockConcurrencyWhile()` 里完成 读 → 变更 → 写,并发不产生交错;有并发测试证明(§13.11)。
- `version` 是 fencing token:`setState` 每次 +1,并作为 `fencing_token` 写进 decisions 与归档。它现在的作用是**让外部读到的视图可判断新旧**,不再承担"调用方先读后写"的乐观锁义务——串行化已在 DO 内部完成。
- 事件按 task 单调 `seq` 追加、分片(每片 100 条),链内单写者。~~同一 task 并发 `appendEvent` 会读到同一个 prev 从而分叉~~ 已修(0003 加 seq + DO 串行),`GET /admin/chain-check` 可持续复核(§13.1)。

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
6. 软失败检测:qwen 在 API 错误时仍 exit=0,但最后一条 `type=result` 的 `result` 字段会含 `[API Error:...]`。识别后上翻 exit_code=11
7. transcript / stderr 写 R2(内容寻址);成功且为 repo 任务时导出候选 patch —— **断言式**:`cat-file -e` 确认基线对象在 → `git add -A` → `git diff '<base_sha>' --binary`,任一步非零即 `exit 23` 且**不产出半成品补丁**(宁可失败,也不交出一张不知道对谁有效的补丁)
8. 返回 `{ exitCode, transcript, stderr, patch, base }`,`base = { sha, source }` 随证据链上翻到控制面
9. **验证语义不在此执行**:`verify_command` 由独立 verifier 在另一沙箱**同一基线**上重放(见 §13.10);非 repo 任务无验证

**软失败检测的意义**:qwen-code 把 API 错误嵌入 stream-json 的 result 事件而不是反映在退出码,如果不识别会把"401/限流"当成"任务成功"。

### 7.3 答案提取与记账 (src/exec/extract.ts)

`extractResultFromTranscript(transcript: string): string | null`

- 主路径:取最后一条 `type === "result"` 事件的 `result` 字段
- 退化:拼接所有 `type === "assistant"` 事件里的 `content[].type === "text"` 块
- 都拿不到返回 null,workflow 会照样推进(result_text 只是空),不会阻断 attempt

`extractTokensFromTranscript(transcript: string): number`

- 扫描 NDJSON 各事件的 `usage` 字段(`total_tokens`,缺失时按 input+output 相加)
- 取最大值(最后一条 `type=result` 的 usage 是累计值)
- 返回值写入 `attempts.tokens_used`(见 workflow extract step),供成本归因与后续 attempt 预算决策

提取结果写回 `tasks.result_text`(`migrations/0002`),由 `GET /tasks/:id/result` 以 `text/plain` 直出。

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

- **记账**:workflow 的 extract step 调 `extractTokensFromTranscript` → `recordTokenUsage` → `attempts.tokens_used`;事件 `result.captured` 携带 `total_tokens`
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
  base?: { sha: string; source: "resolved_default" | "pinned" };  // 该候选所基于的精确 commit
  model_calls_digest?: string;    // 预留:整轮 model call 的 Merkle 根
}
```

> **为什么 `base` 必须在 manifest 里**:没有它,patch 只能对「当时那条默认分支」说话 —— 跨轮 `patch_digest` 比较失去意义,证据也无法自证「基于哪个世界」。`TaskRecord.base` 是任务级权威,manifest 的 `base` 是这份候选自己的血统;两者不一致时(基线在候选产生后变了)交付视图报的是**候选的**基线。
>
> 历史审批绑定不受影响:`compositeEvidenceDigest` / `computeBindingDigest` 组合的是已存的 manifest digest,不是重算的 manifest 内容。

### 审计路径

- **给定一个 decision**:查 `decisions.evidence_digest` → R2 `manifests/.../<digest16>.json` → 拿到 transcript/artifact/verify 的 digest → R2 `artifacts/sha256/...` 取原文
- **验证未被篡改**:重算 SHA-256 对比 manifest 里的 digest;任一字节改动即告警
- **重放一次 attempt**:spec 在 tasks.spec,digest 在 manifest;容器是临时的,换镜像也能重跑同一份 spec

---

## 10. 人工审批(HITL)与证据绑定

`POST /tasks/:id/approve` 接收 `{ decision: "approve" | "reject", actor?: string, attempt_id, evidence_digest }`,后两者**必填**(`submitDecision` 强制)。`accept_with_notes` 是控制面内部的降级决策(reject 举证不成立时由它写),**不由外部提交**;其它值 → 400 `invalid_decision`:

1. `evidence_required` — 缺 `attempt_id` 或 `evidence_digest` → 400
2. `attempt_not_writer` — attempt 必须是 writer(裁决对象是候选本身)→ 409
3. `evidence_mismatch` — 提交的 digest 必须等于控制面计算的组合证据 `composite([writer, verifier?])`,防"批的不是看的那份证据" → 409
4. `task_not_awaiting` — 仅 `AWAITING_APPROVAL` 可裁决 → 409
5. 通过校验 → `finishApproval`:记 `decision.recorded`(带组合 evidence_digest + fencing_token)→ CAS → DONE/REJECTED → `notifyWriter` 唤醒 writer workflow → 归档 D1(失败挂 30s alarm 重试)

组合证据的组成(见 §13.9):
- **人工审批**绑定 `[writer, verifier?]` — 调用方从 `GET /tasks/:id/evidence` 的 `binding_digest` 字段获取,先取证、后裁决
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
| POST | `/tasks` | `Bearer $WORKER_API_TOKEN` | 创建 task + 首个 attempt,启动 workflow;`spec.acceptance[]`(可选,≤8 项、每项 3–500 字符,非法 → 400 `invalid_acceptance`)、`spec.base_sha`(可选,全长度小写 hex;非法 → 400 `invalid_base_sha`,不落库、不起沙箱)、顶层 `review_evidence_mode`(可选 `shadow`/`enforce`,覆盖环境变量);返回 `{ task_id, attempt_id, workflow }` |
| GET | `/tasks/:id` | `Bearer $WORKER_API_TOKEN` | 返回 `{ task, attempts[], events[] }`,含 `task.result_text` 与 `task.base` |
| GET | `/tasks/:id/result` | `Bearer $WORKER_API_TOKEN` | `text/plain` 直出 agent 最终答案;尚未提取到返回 404 `{ error: "no_result_yet" }` |
| POST | `/tasks/:id/approve` | `Bearer $WORKER_API_TOKEN` | 裁决 `approve`/`reject`,必填 `attempt_id` + `evidence_digest`(组合证据);缺 400 / 不匹配 409。`accept_with_notes` 是内部降级决策,不由外部提交 |
| GET | `/tasks/:id/evidence` | `Bearer $WORKER_API_TOKEN` | 返回钉住的 writer manifest JSON + `binding_digest`(approve 应提交的组合证据) |
| GET | `/tasks/:id/candidate` | `Bearer $WORKER_API_TOKEN` | 候选交付视图(只读投影,不新增状态对象):`{ status, verified, safe_to_apply, base, patch, writer_attempt_id, verifier_attempt_id, decision, binding_digest, warnings }`。`status ∈ unverified \| verified \| verification_failed \| approved \| rejected \| held_for_human`;`base` 是**这份候选自己的**基线(manifest 血统),与任务当前基线不一致时进 `warnings`。尚未有钉住候选 → 404 `no_candidate_yet` |
| GET | `/tasks/:id/candidate?format=patch` | `Bearer $WORKER_API_TOKEN` | `text/plain` + `Content-Disposition: attachment; filename="task-<id>-<patch digest 前 12 位>.patch"`。**下发前重算补丁字节 sha256 并与 manifest 记录的 digest 比对**,不一致 → 500 `integrity_error`,不把未校验字节交出去。判定进响应头 `x-candidate-status` / `x-verified` / `x-safe-to-apply` / `x-base-sha`,只看头也不会把被否决的候选当成可提交成品 |
| GET | `/tasks/:id/attempts/:aid/transcript` | `Bearer $WORKER_API_TOKEN` | 流式透传 R2 里的 transcript 原文 |

### 典型调用序列

```bash
# 1. 创建任务
TASK=$(curl -sS -X POST $BASE/tasks \
  -H "Authorization: Bearer $WORKER_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"spec":{"prompt":"..."}}' | jq -r .task_id)

# 2. 轮询状态
while :; do
  STATE=$(curl -sS $BASE/tasks/$TASK \
    -H "Authorization: Bearer $WORKER_API_TOKEN" | jq -r .task.state)
  echo "state=$STATE"
  [[ "$STATE" =~ ^(AWAITING_APPROVAL|DONE|REJECTED|BLOCKED)$ ]] && break
  sleep 10
done

# 3. 读 agent 答案
curl -sS $BASE/tasks/$TASK/result \
  -H "Authorization: Bearer $WORKER_API_TOKEN"

# 4. 取证并审批(组合证据强制绑定)
EV=$(curl -sS $BASE/tasks/$TASK/evidence \
  -H "Authorization: Bearer $WORKER_API_TOKEN")
WRITER_ID=$(echo "$EV" | jq -r '.manifest.attempt_id')
BINDING=$(echo "$EV" | jq -r .binding_digest)
curl -sS -X POST $BASE/tasks/$TASK/approve \
  -H "Authorization: Bearer $WORKER_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"decision\":\"approve\",\"actor\":\"human:me\",\"attempt_id\":\"$WRITER_ID\",\"evidence_digest\":\"$BINDING\"}"

# 5. 取回候选并在它的基线上本地重放(这一步才是"补丁 Harness"的验收终点)
CAND=$(curl -sS $BASE/tasks/$TASK/candidate -H "Authorization: Bearer $WORKER_API_TOKEN")
echo "$CAND" | jq '{status, verified, safe_to_apply, base, warnings}'
BASE_SHA=$(echo "$CAND" | jq -r .base.sha)
curl -sS -OJ "$BASE/tasks/$TASK/candidate?format=patch" -H "Authorization: Bearer $WORKER_API_TOKEN"
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
| Var | `DEFAULT_MAX_WALL_SECONDS` = `3600` | 单 attempt 1 小时 |
| Var | `REJECT_EVIDENCE_MODE` = `shadow` | reviewer 证据硬校验模式:`shadow` 只记事件、`enforce` 才降级返工(§13.12) |
| Var | `BASE_PIN_MODE` = `shadow` | 基线材质化失败的处理:`shadow` 回落已解析的默认分支并记 `base.fallback`、`enforce` 直接 `BLOCKED` 转人工(§13.13)。**两种模式都真实使用冻结基线材质化工作副本**,只在失败路径上分叉;verifier 侧恒为 enforce |

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

### 13.5 老任务缺 result_text — 已实现(`POST /admin/backfill-results`)

~~`migrations/0002` 上线前产生的 task,`result_text` 全部为 null,需手动拉 R2 回填。~~

已实现 `POST /admin/backfill-results`:扫 `result_text IS NULL` 的 task → 经 events 定位 writer attempt 的 manifest → 读 R2 transcript → extract 结果与 tokens → 回填 `tasks.result_text` / `attempts.tokens_used`。首次执行回填 10/10。注意:代理时代失败任务的 result_text 会保留 `[API Error: ...]` 文本(如实反映失败)。

### 13.6 reviewer / verifier 角色 — 已闭环(含独立验证证据注入)

~~consumer 骨架就绪但上游没有发消息,reviewer 未生效。~~

已接通:候选验证/审查通过后才派 reviewer;reviewer 是**纯 LLM**(直接调百炼 `/chat/completions`,无工具,秒级,天然输出 JSON,不做任何任务执行),裁决经 REPORT_QUEUE 回报 DO,DO 记录 `review.completed` + `decision.recorded`(绑定组合证据,见 §13.9)并 → DONE/REJECTED,再 `notifyWriter` 唤醒 writer workflow。

- **repo 任务**:writer 成功 → 独立验证器重放候选(§13.10)→ 验证通过才派 reviewer
- **reviewer 输入**(M7):review prompt 注入编号的【验收标准】(来自 `spec.acceptance`)、【独立验证结果】与【候选变更摘录】,并要求裁决按 `ReviewVerdict` 结构输出——reject 必须附 `failed_criteria` 索引、可执行的 `fix_instructions` 和喂入材料内可核对的 `evidence.quote`。旧的「验证失败必须 reject」措辞已删除:验证失败根本不会走到 reviewer(硬门禁直接 rework/REJECTED)
- reviewer 结论经 `parseReviewVerdict` 三阶段解析(JSON.parse → 抽取 JSON 子串 → 结构校验);**全部失败即 `decision:"none"`**,不再用关键词兜底成 reject(M7 前默认 reject 是返工放大器)
- reviewer 自身基建失败(`exit_code != 0`)→ `review.unavailable` + `awaiting_human`,停在 `AWAITING_APPROVAL` 等人工,**不触发返工**
- reject 是否真的执行返工由门禁分级决定(§13.12);自动裁决与人工审批互为兜底,先到先决、后到幂等忽略,人工裁决必须携带组合证据(§10、§13.9)
- 曾用 qwen-code(带工具)跑 reviewer:即使 prompt 禁止也会真的执行任务,且结果经 NDJSON 提取器误解析 → 改为纯 LLM 后稳定

### 13.7 证据端点缺失 — 已实现

~~manifest / transcript / verify 只能通过 `wrangler r2 object get` 拉。~~

已实现(全部 `Bearer $WORKER_API_TOKEN`):
- `GET /tasks/:id/evidence` — 最新 attempt 的 manifest JSON
- `GET /tasks/:id/attempts/:aid/transcript` — 流式透传 R2 原文(text/plain)
- `GET /tasks/:id/attempts/:aid/verify` — verify 输出(未配置时 404)

### 13.8 DO namespace 分裂 — 已解决(session_id 显式路由)

~~workflow / queue consumer 环境里 `env.TASK_SESSION.idFromName(taskId)` 解析出的 DO namespace 与 fetch 环境不一致,`get()` 到"幽灵实例"(task=null),RPC 返回 `{ok:false}` 不抛错 → workflow step Success 但状态不更新。~~

证据:同一 task 的 reportExecution 到达 DO `960cb073`(task:null),getSnapshot 到 `1521a9af`(有数据);fetch 环境跨部署稳定解析同一实例 → 结论是**运行环境绑定的 namespace 不同**,不是版本钉扎。

修复:TaskSession DO 在自身环境生成 `session_id = this.ctx.id.toString()`(全局唯一),经 AttemptParams / queue 消息传递;consumer 用 `env.TASK_SESSION.idFromString(session_id)` + `get()` 精确路由。DO 实例 id 全局唯一,与 namespace 无关。教训:**跨环境(workflow/queue/fetch)RPC Durable Object 不要用 name 路由,显式传实例 id**。

### 13.9 证据门禁与组合证据绑定 — 已实现

~~两个硬伤:① writer `exit_code != 0` 后仍发 review、转 AWAITING_APPROVAL,失败产物可被批准;② `POST /approve` 的 attempt_id/evidence_digest 均可选,且只对比单个 attempt 的 manifest digest——人工裁决可以不带任何证据,或拿旧证据批新候选。~~

修复(控制面强制,不依赖调用方自觉):

- **失败门禁**:writer `exit_code != 0` 一律不进审批流——预算内(`DEFAULT_MAX_ATTEMPTS`)自动 rework 下一个 writer;耗尽 → task **BLOCKED**(与质量否决的 REJECTED 区分)。事件链记 `writer.failed` / `writer.rework_scheduled`
- **组合证据**:每个 decision 绑定因果链上全部证据的组合 digest `sha256(JSON.stringify([{role, attempt_id, digest}, ...]))`——人工审批 = `[writer, verifier?]`,自动裁决附裁决者 = `[writer, verifier?, reviewer]`。候选或验证记录任一字节变化,组合 digest 即变化
- **强制校验**(`submitDecision`):`attempt_id`/`evidence_digest` 必填(400 `evidence_required`);必须指向 writer(409 `attempt_not_writer`);必须等于控制面重算的组合绑定(409 `evidence_mismatch`);仅 `AWAITING_APPROVAL` 可裁决(409 `task_not_awaiting`)。调用方从 `GET /tasks/:id/evidence` 的 `binding_digest` 取证
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

另有纯单测覆盖状态转换表合法性、rework 预算判断、watchdog 数学与组合 digest 确定性(`test/statemachine.test.ts`)、门禁分级判定(`test/gates.test.ts`),以及 reviewer 基建失败挂人工 / awaiting_human 忽略自动裁决 / 证据口径同源 / 陈旧血缘不采信(`test/session-do.test.ts`)。`npm test` 一键运行;注意测试用 `wrangler.test.jsonc`(compatibility_date 受 pool 内置 workerd 版本限制),D1 迁移由 vite `define` 在构建期内联(`test/d1.ts`)。

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
- **链完整性**:`GET /admin/chain-check` → `checked=37, broken=0`。
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
- **测试**：`npm test` → 93 passed，`tsc --noEmit` 干净。覆盖：注入样本（`a]b;c`、反引号、长度 39/41、大写）全拒、脚本内 SHA 只以 `'<sha>'` 出现且无 `repo_url`、三个 exit 码可达、**全部脚本函数体在子 shell 内且括号外无 `exit`**（§13.15 回归）、返工轮 `attempt.created.base_pin` 与首轮同 SHA、`exit 21 → BLOCKED`+`awaiting_human`+预算不变+不派 verifier/reviewer、`result_text` 为空串时 `base.failed` 仍留得下诊断、shadow 回落只记 `base.fallback`+`base.moved` 不误触熔断、verifier 血缘不匹配不采信、`reportArgsFrom` 键集与 `ReportArgs` 一致（防"静默丢字段"回归）、沙箱 key 配了独立值即不混用高权 key / 缺配回落且只在那一次告警。
- **E1 无 repo 回归** ✅：天气任务闭环 DONE，证明基线代码路径与 key 注入没破坏非 repo writer。
- **E2 pinned 基线端到端** ✅（`e38b8357` / `62edbba0`）：writer 与 verifier 报同一个 sha，`base.frozen` 落 `task.base`，manifest v2 带 `base`，返工轮继承同一 pin。
- **E3 交付闭合（本轮验收终点）** ✅：`GET /tasks/:id/candidate?format=patch` 落盘 → 本地 `git checkout 762941318ee16e59dabbacb1b4049eec22f0d303 && git apply` 成功；下发的字节 sha256 与 `manifest.patch.digest` 一致（不一致会返回 `integrity_error` 而不是把未校验字节交出去）。
- **E5 不可达基线** ✅ 双模式：`shadow` 下（`9d3a84d5` / `346a1dcb`）回落已解析的默认分支、记 `base.fallback`（detail 带 git 原文）并继续正常流程；`enforce` 下（`73fd11c4` / `c4ceadcf`）19 秒 BLOCKED，`attempts=1`、writer `tokens_used=0`（**基线不可用就不起模型**这一点被记账证实）、无 `verify.requested` / `review.requested`、预算不变。
- **E6 注入** ✅：5 个样本（含 `a'*;touch /pwn`、39/41 位、大写）全 400 `invalid_base_sha`，D1 无记录、无沙箱。
- **E7 向后兼容** ✅：M7 老任务 `8e8e408a` 重算 `binding_digest` = `c2582af6650e…`、writer manifest digest = `51af01939692…`，与 M7 归档**逐字节相同**（v1 manifest 无 `base`，读取路径容忍）；`GET /candidate` 对它返回 `base: null` + 警告「基线未固定：补丁只与抓取时刻的默认分支绑定，不保证能在其它 commit 上重放」，状态如实给 `held_for_human`、`safe_to_apply=false`，**没有**因为曾经 approve 就伪装成可提交。`GET /admin/chain-check` → `checked=47, broken=0`。
- **E8 凭据** ✅（结论是**否**）：容器内 `OPENAI_API_KEY` 的 sha256 前缀与 Worker 侧 `DASHSCOPE_API_KEY` 相同 —— prod 至今没有铸 `SANDBOX_MODEL_API_KEY`，所以本轮"降权"实际收益为零，与 §13.14 写明的条件一致。
- **修好的静默丢字段（prod 才看得见）**：`base.failed.detail` 在单测里非空、在 prod 恒为 `""`。根因是 writer 的 `result_text` 恒为字符串：基线失败时 transcript 是纯文本、提取器返回 `null`、workflow 落成 `""`，而 DO 用 `args.result_text ?? attempt.error_tail` 取值——`??` 不认空串，回落永远不执行。现改为先 `trim()` 判空再回落，并给事件补 `manifest_key` 指针。上面 `73fd11c4`（修复前，detail 空）与 `c4ceadcf`（修复后，detail `exit_code=21` + `manifest_key`）是同一条路径的前后对照样本；沿 `manifest_key → manifest.transcript → 产物` 一跳即可取到真实诊断：`pinned base deadbeef… not materializable (exit 21): fatal: remote error: upload-pack: not our ref …`。
- **enforce 判据未达成**：判据要求 ≥10 个 repo attempt 且 `base.fallback` 由我方脚本造成 0 次。现状 = 5 个 `base.frozen` + 2 个 `base.failed`（均为刻意注入的合成样本），`base.fallback` 2 次全部来自不存在的 `deadbeef…` pin，**我方脚本造成 0 次**这一半成立，样本量那一半不成立。因此 `BASE_PIN_MODE` 保持 `shadow`。测完 enforce 已立刻改回 shadow 再部署，prod 不留 enforce 状态。

**已知不覆盖**：
- **E4「上游移动」未取证**：需要在一个**对 runner 有默认分支 push 权限**的仓库上，于 writer 执行期间再压一个与候选冲突的提交，对照 M8 前会 `APPLY_FAILED_EXIT=20`、M8 后候选仍按冻结基线通过。prod 全部 repo 样本都在 `octocat/Hello-World`（无写权限）上，因此这条只能标未覆盖。复现配方：建一个自己的 scratch 仓 → 提交任务时 pin 一个稳定 sha → 任务在跑时向默认分支 push 一个改动同一文件的提交 → 期望 verifier 仍 `exit 0`。
- 私有仓 fetcher 未实现：只在 `TaskSpec.repo_url` 处留了接入位注释，`GIT_TERMINAL_PROMPT=0` 保证坏 ref 不会挂死，但私有仓现在一律 clone 失败。
- **候选 patch 无大小上限**：导出走 `sandbox.readFile`（容器文件 API 的 base64 GET，**不经 shell 会话**，所以不受 §13.15 那条影响），整份读进 Worker 内存后由 `putArtifact` 落 R2 —— 只记 `size`、不设上限（我们这侧没有任何代码层阈值，超限的表现落在平台配额上）。一个含巨型二进制改动的候选会整份穿过 Worker isolate。本轮未加截断或拒绝，因为「候选被静默截断」比失败更危险，正解是给 `exportPatchScript` 加 `--stat` 预检 + 超限 fail-closed，属 M9 工作量。
- 基线只保证「writer 与 verifier 在同一个 commit」，不保证「这个 commit 是 GitHub 当前默认分支」——`GET /candidate` 的 `base.moved` 提示负责把这一点如实告诉消费方。

### 13.14 出站网络 allowlist — 未做(顺延 M9),本轮用可撤销低权 key 补偿

调研与最佳实践手册都把「沙箱出站必须可治理」列为长任务前置条件,但**探针结论是本轮不该硬上**:三个坑里任何一个配错,得到的都是「看着像有门禁、实际没有」,而这比明确标未做更危险。现状事实:`src/index.ts` 只导出 `Sandbox` / `TaskSession` / `AttemptWorkflow`,**没有导出 `ContainerProxy`**——`@cloudflare/sandbox` 依赖 `@cloudflare/containers@^0.3.0` 并 re-export 了它,能力在,但链没挂上,容器出站今天完全不经过 allowlist。

三个坑(实施 M9 前必须逐条过):

1. **`ContainerProxy` 必须从 Worker 入口导出**。不导出时 outbound 拦截**根本不发生**——不是"配置没生效",是请求压根没进处理器链,`allowedHosts` 形同注释。
2. **`setAllowedHosts` / `allowedHosts` 是半配置陷阱**:拦截默认只覆盖 HTTP(`interceptHttps` 默认 `false`),此时白名单设得再对,`https://` 出站照样直连。要打开必须 `allowedHosts` + `interceptHttps` 成对配置,并保留 `deniedHosts` 兜底。
3. **`interceptHttps=true` 要求容器镜像信任 Cloudflare 的 CA**(`/etc/cloudflare/certs/cloudflare-containers-ca.crt`)。镜像不装这个证书,后果不是"拦截失效"而是**每个合法 HTTPS 请求 TLS 失败**——`npm install` / `git clone` / `curl` 全红,表现为随机基建故障。因此它是**镜像改动**:要写进 `sandbox/Dockerfile` 并随镜像 tag 一起升,同时按 §12 的排空窗口与 worker 部署同批走,否则头几个 attempt 会打到不信任 CA 的旧镜像。

**本轮实际买到的东西(诚实边界)**:`SANDBOX_MODEL_API_KEY`(低权、可撤销、只注入容器)与 `DASHSCOPE_API_KEY`(高权,Worker 侧 reviewer 用)分开,方向与 M7 前相反——控制面持高权 key,沙箱持低权 key。它买到的是**撤销能力 + 爆炸半径 + 归因**(泄露时立刻撤 key、从事件链定位泄露窗口内的 attempt 集合),**不是限流**:DashScope token-plan 没有可靠的 per-key 硬额度,拿到 key 仍可花到配额上限。所以沙箱泄露的应急动作是「立刻撤销 + 圈定受影响 attempt」,不要指望"损失有上界"。

**这条收益是有条件的**:低权 key 是**可选配置**,缺配时 `sandboxModelEnv` 回落沿用 `DASHSCOPE_API_KEY` 并打 `credential_fallback` 告警。回落 = 拆分带来的收益为零,状态与 M8 前逐字节相同。刻意不做 fail-closed:那会让一个配置层增强项阻塞基线冻结与候选交付这两个主交付物,而部署阻塞的代价是真实的(M8 曾因此停摆)。判断降权是否成立只看一处:`wrangler secret list` 里有没有 `SANDBOX_MODEL_API_KEY`,以及日志里还有没有 `credential_fallback`。

**最可靠的核查是直读部署后的 binding**(`wrangler secret list` 只看当前目录配置所指向的环境,而策略开关的实际生效值在已部署的 Worker 上):`GET /accounts/<ACCOUNT_ID>/workers/scripts/cloud-agent/settings` → `result.bindings` 里 `type=plain_text` 给出 `BASE_PIN_MODE` / `REJECT_EVIDENCE_MODE` 的真值,`type=secret_text` 给出**名字**(不返回值),据此一次请求同时确认「prod 跑的是哪个模式」与「低权 key 到底铸没铸」。2026-09-01 实测:`plain_text` = `BASE_PIN_MODE=shadow` / `REJECT_EVIDENCE_MODE=shadow`,`secret_text` 只有 `DASHSCOPE_API_KEY` 与 `WORKER_API_TOKEN` —— **沙箱降权确认处于回落态**,与 E8 的 key 指纹结论一致。

**M9 的最小落地顺序**:导出 `ContainerProxy` → 在 `Sandbox` 子类上设 `allowedHosts`(GitHub 域 + 包源 + 百炼 upstream)+ `interceptHttps=true` → 镜像装 CA 并 bump tag → 同批部署 → 验收**正负两条都要**:白名单内域名(如 `api.github.com`)在容器内 `curl` 成功、白名单外(如随机 VPS 或 `webhook.site`)必须失败,且 `npm install` 在预装镜像内不因 TLS 报错。

### 13.15 沙箱 `exec` 复用常驻 shell：顶层 `exit` 会杀掉会话 — 已修复（M8，prod 才发现）

**事实**：`sandbox.exec()` → `ensureDefaultSession()` → `POST /api/execute` 的每条命令都跑在**同一个常驻 shell 会话**里（`@cloudflare/sandbox` 的 execute 路径），不是一次性进程。于是脚本里顶层的 `exit N` 退掉的是**会话本身**：SDK 不返回退出码，而是抛 `SandboxError: … Session '…' is not ready or shell has died`。

这对 M8 是致命的：`base.ts` 的三个退出码（21 / 22 / 23）与 `reportExecution` 里那条「环境事实不烧返工预算、直接 BLOCKED 转人工」的路由，全部依赖脚本自己 `exit`。实际表现是 fail-closed 路径**永不执行**，任务从 workflow 的通用异常分支落成 BLOCKED，`awaiting_human=false`、诊断文本丢失——看起来"也失败了"，但审计语义完全不同。

**修法**：`materializeScript` / `exportPatchScript` / `resolveScript` 的整个函数体包进子 shell `( … )`。`exit` 只结束子进程，状态码照常回传；顺带阻止 `set -eu`、`export GIT_TERMINAL_PROMPT`、`R=` 泄漏进同一会话里后续的 qwen 与 patch 导出命令。

**为什么测试没抓到**：`wrangler.test.jsonc` 没有 Sandbox 绑定，单测只能断言**脚本字符串**的形状（SHA 只以 `'<sha>'` 出现、三个 exit 码可达），断不了容器语义；M6/M7 也没暴露这一类，因为那两轮的退出码全部由 **TS 侧计算**（`apply.exitCode → APPLY_FAILED_EXIT=20`），从来没有任何脚本 `exit` 过。现在 `base.test.ts` 里有一条括号深度扫描的回归：`exit` 必须出现在 `(` 之内，包装层不得把退出码吞掉。

**给后续轮次的约束**：任何要经 `sandbox.exec` 执行的脚本，**退出码只能通过子 shell 产生**；需要"失败即中止"的语义优先在 TS 里判断 `exitCode`，不要在脚本顶层 `exit`。

---

## 14. 延伸阅读

- [`../research/agent-research/docs/research/cloudflare-ai-infra-overview-2026-08-28.md`](../../../research/agent-research/docs/research/cloudflare-ai-infra-overview-2026-08-28.md) — Cloudflare AI 基础设施调研
- [`../research/agent-research/docs/research/cloudflare-ai-agent-best-practices-2026-08-28.md`](../../../research/agent-research/docs/research/cloudflare-ai-agent-best-practices-2026-08-28.md) — 工程最佳实践手册
- `README.md` — 部署与冒烟命令
