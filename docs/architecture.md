# cloud-agent 架构与设计

> 一句话:**控制面 / 执行面分离、可恢复、可审计**的云端 coding agent 基建。
>
> 栈:Cloudflare Workers + Durable Workflows + D1 + R2 + Sandbox + Queues;现有 agent CLI(`@qwen-code/qwen-code`)作为执行 worker 跑在沙箱里,Worker 自身不实现智能,只做**权威状态、凭据注入、事后记账、证据归集**。

---

## 1. 设计目标与非目标

### 目标

| 维度 | 承诺 |
|---|---|
| **正确性** | 任务状态以 D1 为唯一权威,带 fencing version 做 CAS,任何外部视图(Workflow 历史、日志、R2 文件)都不作为仲裁依据 |
| **可恢复** | Worker 崩溃、Sandbox 容器替换、Workflow step 重试均不丢失进度;每个 step 都是幂等可重放 |
| **可审计** | 模型 I/O、沙箱 transcript、人工决策一律进 hash chain + 内容寻址 R2,篡改可检测 |
| **凭据合规** | token-plan key 只注入沙箱内 agent 客户端直连百炼(token-plan 许可的用法),不经任何代理转发、不落盘、不进 API 路径 |
| **成本可控** | 每个 attempt 有 token / 时长 / turn 三重预算;时长与 turn 由 qwen-code 参数硬停,token 事后记账供归因与后续决策 |

### 非目标

- 不是多租户平台 — 当前单一 `WORKER_API_TOKEN` 做 API 鉴权,无用户/团队层
- 不是 agent 框架 — agent 实现(qwen-code / 未来的 opencode、pi)由 sandbox 镜像提供,本仓不管
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
| 入口 + 路由 | Router / Landing / API dispatch | `src/index.ts` |
| 控制面 | 权威状态、fencing、事件链 | `src/control/authority.ts` |
| 执行面 | Workflow 编排 | `src/exec/workflow.ts` |
| 执行面 | Sandbox 启动与 transcript 处理 | `src/exec/sandbox.ts` |
| 执行面 | 答案提取 + token 统计(stream-json → 纯文本/用量) | `src/exec/extract.ts` |
| 执行面 | Queue consumer(reviewer fan-out) | `src/exec/queue.ts` |
| 审计 | sha256 / R2 内容寻址 / manifest | `src/audit/evidence.ts` |
| 类型 | Env / TaskState / AttemptParams | `src/types.ts` |
| Schema | D1 迁移脚本 | `migrations/0001_init.sql`、`0002_add_result_text.sql` |
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
一次用户请求(immutable spec + 可变状态)。`spec` 在创建时 JSON 序列化 + SHA-256 冻结,后续不可变。

```ts
// src/types.ts
interface TaskSpec {
  prompt: string;
  repo_url?: string;        // 可选:沙箱内 git clone 到的工作仓
  verify_command?: string;  // 可选:执行完后跑这个命令做 verify
  worker?: "qwen-code";
}
```

Task 的 `result_text` 列(`migrations/0002`)保存 agent 的最终答案纯文本,由 workflow 在 `extract` step 里写入。

### Attempt
Task 的一次执行尝试。同一 task 可能有多次 attempt(reject 后再试;或 reviewer 接力)。每个 attempt 有自己的:
- `max_model_tokens` / `max_wall_seconds` — 预算(时长/turn 由 qwen-code 参数硬停;tokens 事后记账)
- `tokens_used` — transcript 解析出的实际用量,由 workflow 的 extract step 写入
- `workflow_instance_id` — 对应的 Durable Workflow 实例
- `idempotency_key` — `task_id:attempt:N` 或 reviewer 场景的自定义键,UNIQUE 约束保证去重

> `proxy_token` 列是旧代理架构的遗留(0001 schema),主流程已不使用,保留兼容。

### Decision
人工(HITL)或系统对 attempt 的判定。当前只走 approve/reject,后续 reviewer agent 可以产出 block + reason。

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

```
   ┌─────────┐
   │ PENDING │   (createTask 写入)
   └────┬────┘
        │ workflow.claim (CAS v → v+1)
        ▼
   ┌─────────┐
   │ RUNNING │
   └────┬────┘
        │ exec_finished + evidence
        ▼
┌──────────────────┐       approve         ┌──────┐
│ AWAITING_APPROVAL│ ─────────────────────►│ DONE │
└──────────────────┘                       └──────┘
        │ reject                    │ 异常捕获
        ▼                           ▼
   ┌──────────┐                 ┌─────────┐
   │ REJECTED │                 │ BLOCKED │
   └──────────┘                 └─────────┘
```

所有转换都经过 `authority.transition`:
```sql
UPDATE tasks SET state = ?, version = version + 1
 WHERE id = ? AND version = ?
```
`changes = 0` 即视为冲突,抛 `AuthorityConflict`,workflow 把它上翻成 `BLOCKED`。

### Attempt 状态

```
RUNNING ──┬─► SUCCEEDED   (exit_code == 0 且 decision=approve)
          ├─► FAILED      (exit_code != 0 或 decision=reject)
          └─► BLOCKED     (workflow 异常捕获)
```

---

## 6. 控制面 — `src/control/authority.ts`

职责:
- **`createTask(env, spec)`** — 分配 id,sha256 冻结 spec,落 events.task.created
- **`createAttempt(env, args)`** — 分配 id,UNIQUE 约束做幂等(proxy_token 为遗留列,继续填充但不再用于鉴权)
- **`transition(env, args)`** — CAS 状态转换,version 不匹配 fail closed
- **`recordDecision(env, args)`** — 写入 decisions 表,绑定 evidence_digest 与 fencing_token
- **`finishAttempt(env, id, state)`** — 收口 attempt 状态 + finished_at
- **`recordTokenUsage(env, id, tokens)`** — 写入 attempt 的 tokens_used(transcript 解析的事后记账)
- **`appendEvent(env, taskId, kind, payload)`** — 追加 hash chain 事件
- **`getTask` / `setResultText`** — 读与轻量写辅助

**关键设计点**:

- `version` 是 fencing token。每次 transition +1,调用方必须先读后写;过期 version 立即拒绝。
- `appendEvent` 当前用 `ORDER BY created_at DESC, rowid DESC LIMIT 1` 取 prev。**已知缺陷**:同一 task 并发 appendEvent 会让两个 worker 读到同一个 prev,各自写出 sibling,链会"分叉"。短期内靠 attempt 串行缓解,长期方案见 §11.1。

---

## 7. 执行面 — Workflow + Sandbox + Extract

### 7.1 `AttemptWorkflow.run` (src/exec/workflow.ts)

Durable Workflow 把一次 attempt 切成若干独立幂等 step,崩溃后从最近完成的 step 重放。权威状态全部在 TaskSession DO,workflow **不做任何状态转换**,只负责:执行 → 提取 → 证据落 R2 → 经 REPORT_QUEUE 异步回报(writer 额外等待审批事件):

| Step | 作用 | 写入 |
|---|---|---|
| **exec** | 按 role 分支:writer/verifier 启 sandbox 跑 qwen-code(重试 2 次指数退避);reviewer 直接调百炼 chat/completions(纯 LLM,无工具) | artifacts(R2), 不写状态 |
| **extract** | writer/verifier 解析 transcript JSONL 取结果与 tokens;reviewer 对 LLM 单行 JSON 回答直接解析裁决 | —(值传给 report step) |
| **evidence** | 拼装 manifest(transcript + stderr + verify 三个 ArtifactRef),写 R2 | manifests/ |
| **report** | 发 `exec-report` 到 REPORT_QUEUE(重试 2 次);consumer 经 session_id 精确路由 DO 的 reportExecution,DO 侧幂等 | events(DO 侧) |
| **human-approval** | writer 专用:`waitForEvent(type="approval")` 最长 24h,接受 DO notifyWriter 转发的 agent/human 审批事件 | — |
| **report-blocked** | 异常兜底:发 `exit_code=-1` 的 exec-report,DO 置 BLOCKED | events(DO 侧) |

**回报链路**:workflow/queue consumer 环境里的 DO namespace 与 fetch 环境不一致(见 §13.8),RPC 不能靠 `idFromName`;AttemptParams 携带 `session_id`(TaskSession DO 实例 id,全局唯一),consumer 用 `idFromString(session_id)` 精确路由。DO 决策后 `notifyWriter` 用 `ATTEMPT_WORKFLOW.get(workflow_instance_id)` 发 approval event 唤醒 writer workflow(实例 id = writer attempt_id,DO 侧已存)。

### 7.2 Sandbox 启动 (src/exec/sandbox.ts)

`@cloudflare/sandbox` 的 `getSandbox(env.Sandbox, attemptId)` 按 attemptId 取一个一次性容器。流程:

1. `setEnvVars` — 注入 `OPENAI_BASE_URL = MODEL_UPSTREAM_BASE`、`OPENAI_API_KEY = DASHSCOPE_API_KEY`(token-plan key)、`OPENAI_MODEL`,qwen-code 直连百炼
2. 可选 `gitCheckout(repoUrl, depth=1)` 到 `/workspace/repo`
3. 兜底 `npm install -g @qwen-code/qwen-code@0.21.10`(官方镜像未预装)
4. 写 `/workspace/task.txt` = prompt
5. `exec` 跑 `qwen -p "$(cat task.txt)" --output-format stream-json --auth-type openai --yolo --max-session-turns 12 --max-wall-time 5m`
6. 软失败检测:qwen 在 API 错误时仍 exit=0,但最后一条 `type=result` 的 `result` 字段会含 `[API Error:...]`。识别后上翻 exit_code=11
7. transcript / stderr 写 R2(内容寻址);如提供 `verify_command`,再跑一次,输出单独作为 verify artifact

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
   │  OPENAI_API_KEY  = DASHSCOPE_API_KEY (token-plan key)
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
  schema_version: 1;
  task_id: string;
  attempt_id: string;
  role: string;                   // writer / reviewer / verifier
  produced_at: string;
  spec_digest: string;            // task.spec 的 SHA-256
  model: string;
  transcript: ArtifactRef;        // qwen 的 stream-json 输出
  artifacts: ArtifactRef[];       // 当前实际只放 stderr
  verify?: ArtifactRef;           // 可选,verify_command 的输出
  model_calls_digest?: string;    // 预留:整轮 model call 的 Merkle 根
}
```

### 审计路径

- **给定一个 decision**:查 `decisions.evidence_digest` → R2 `manifests/.../<digest16>.json` → 拿到 transcript/artifact/verify 的 digest → R2 `artifacts/sha256/...` 取原文
- **验证未被篡改**:重算 SHA-256 对比 manifest 里的 digest;任一字节改动即告警
- **重放一次 attempt**:spec 在 tasks.spec,digest 在 manifest;容器是临时的,换镜像也能重跑同一份 spec

---

## 10. 人工审批(HITL)

`POST /tasks/:id/approve` 接收 `{ decision: "approve" | "reject", actor?: string }`:

1. 查最近 attempt 的 `workflow_instance_id`
2. `ATTEMPT_WORKFLOW.get(id).sendEvent({ type: "approval", payload })`
3. Workflow 在 `waitForEvent` 处唤醒,进入 `decide` step
4. `recordDecision` 写 decisions 表(decision + evidence_digest + fencing_token)
5. `transition` CAS → DONE 或 REJECTED

`actor` 默认 `human:api`;后续接入 SSO / 审批系统时改成 `human:<user-id>` 或 `agent:<reviewer-attempt-id>`。

当前没有自动审批分支 — 即使 exit_code=0 也必等人点 approve。后续可在 `decide` 之前加一个 auto-approve 判断(如 spec.auto_approve === true 且 verify.exit === 0),但当前刻意保守。

---

## 11. API 参考

所有路径前缀为 Worker 的 public URL(`wrangler.jsonc` 的 `PUBLIC_URL`,当前 `https://cloud-agent.aflow.workers.dev`)。

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/` | 无 | 落地页(环境 + 端点列表) |
| GET | `/healthz` | 无 | `{ ok: true, env }` |
| POST | `/tasks` | `Bearer $WORKER_API_TOKEN` | 创建 task + 首个 attempt,启动 workflow;返回 `{ task_id, attempt_id, workflow }` |
| GET | `/tasks/:id` | `Bearer $WORKER_API_TOKEN` | 返回 `{ task, attempts[], events[] }`,含 `task.result_text` |
| GET | `/tasks/:id/result` | `Bearer $WORKER_API_TOKEN` | `text/plain` 直出 agent 最终答案;尚未提取到返回 404 `{ error: "no_result_yet" }` |
| POST | `/tasks/:id/approve` | `Bearer $WORKER_API_TOKEN` | 发送 approval event 到 workflow |
| GET | `/tasks/:id/evidence` | `Bearer $WORKER_API_TOKEN` | 返回最新 attempt 的 manifest JSON |
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

# 4. 审批
curl -sS -X POST $BASE/tasks/$TASK/approve \
  -H "Authorization: Bearer $WORKER_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"decision":"approve","actor":"human:me"}'
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
| Queue | `REVIEW_QUEUE` = `cloud-agent-review`,DLQ = `cloud-agent-review-dlq` | reviewer fan-out 通道 |
| Queue | `REPORT_QUEUE` = `cloud-agent-report`,DLQ = `cloud-agent-report-dlq` | workflow → DO 回报通道(经 session_id 路由) |
| Container | `Sandbox` = `docker.io/cloudflare/sandbox:0.8.14` | 沙箱基础镜像 |
| Durable Object | `Sandbox` | 容器绑定 |
| Secret | `DASHSCOPE_API_KEY` | 百炼 token-plan key,注入沙箱供 agent 客户端直连(不落盘) |
| Secret | `WORKER_API_TOKEN` | 控制面 API token |
| Var | `DEFAULT_MODEL` = `qwen3.8-flash` | 默认模型 |
| Var | `DEFAULT_MAX_MODEL_TOKENS` = `5000000` | 软上限,基本不触达 |
| Var | `DEFAULT_MAX_WALL_SECONDS` = `3600` | 单 attempt 1 小时 |

### 部署动作顺序

1. 改 D1 schema → `npm run db:migrate:remote`(CI=true 绕过交互)
2. 改代码 → `npx wrangler deploy`(自动带 container 检查)
3. 改 secret → `npx wrangler secret put ...`

**注意**:worker 启动时即查 `tasks` 等表,如果 migration 没跑,所有涉及 D1 的端点会立刻 500。先迁移、后部署。

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

已统一为 `docker.io/cloudflare/sandbox:0.8.14`:`wrangler.jsonc` containers.image、`package.json` `@cloudflare/sandbox`、`sandbox/Dockerfile` FROM 三处一致。后续升级建议写一个 `VERSION` 文件集中管理并加 CI 校验。

### 13.4 reasoning model 的 token 爆炸 — 未修复(剩余)

qwen3.8-flash 带 reasoning,单次调用 tokens 可能很高(内部推理 + 工具调用 + 输出)。当前靠 5M 软上限兜底,但 reasoning 开启后 1~2 个长任务就能触达。

改进:
- 暴露 `reasoning_effort` / `enable_thinking` 参数,任务级可选
- 给 attempt 加 `reasoning_tokens_used` 单独列,和 completion tokens 分开看
- 在 landing page / API 提供"任务预估 token 区间"的经验值

### 13.5 老任务缺 result_text — 已实现(`POST /admin/backfill-results`)

~~`migrations/0002` 上线前产生的 task,`result_text` 全部为 null,需手动拉 R2 回填。~~

已实现 `POST /admin/backfill-results`:扫 `result_text IS NULL` 的 task → 经 events 定位 writer attempt 的 manifest → 读 R2 transcript → extract 结果与 tokens → 回填 `tasks.result_text` / `attempts.tokens_used`。首次执行回填 10/10。注意:代理时代失败任务的 result_text 会保留 `[API Error: ...]` 文本(如实反映失败)。

### 13.6 reviewer / verifier 角色 — 已闭环(writer → reviewer → 自动裁决)

~~consumer 骨架就绪但上游没有发消息,reviewer 未生效。~~

已接通:writer attempt 在 evidence 之后向 `REVIEW_QUEUE` 发 `review-request`(幂等 key `task_id:review:1`,队列故障不阻断主流程);consumer 经 `session_id` 路由 DO 创建 reviewer attempt;reviewer 是**纯 LLM**(直接调百炼 `/chat/completions`,无工具,秒级,天然输出 JSON,不做任何任务执行),裁决经 REPORT_QUEUE 回报 DO,DO 记录 `review.completed` + `decision.recorded` 并 CAS → DONE/REJECTED,再 `notifyWriter` 唤醒 writer workflow。

- reviewer 结论由 review prompt 约束为一行 JSON `{"decision":"approve"|"reject","reason":...}`;`extractReviewDecision` 三阶段解析(JSON.parse → 正则 → 关键词兜底)
- reviewer 自身失败(exit != 0)时不唤醒 writer,留给人工审批兜底
- 人工审批始终可用(`POST /tasks/:id/approve`,现固定发给 writer attempt);人工先审批后 reviewer 再完成时,reportExecution 幂等忽略
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

---

## 14. 延伸阅读

- [`../research/agent-research/docs/research/cloudflare-ai-infra-overview-2026-08-28.md`](../../../research/agent-research/docs/research/cloudflare-ai-infra-overview-2026-08-28.md) — Cloudflare AI 基础设施调研
- [`../research/agent-research/docs/research/cloudflare-ai-agent-best-practices-2026-08-28.md`](../../../research/agent-research/docs/research/cloudflare-ai-agent-best-practices-2026-08-28.md) — 工程最佳实践手册
- `README.md` — 部署与冒烟命令
