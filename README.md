# cloud-agent

全套基于 Cloudflare 的云端 coding agent 基建:**控制面/执行面分离、可恢复、可审计、可交付**。
现有 agent CLI(qwen-code,后续 opencode/pi)作为执行 worker 跑在 Sandbox 里;运行中任务的权威状态在 TaskSession DO(单写者 + events hash chain),终态归档 D1,证据在 R2(内容寻址),编排用 Workflows;每个 repo 候选绑定一个冻结基线 commit,可经 `GET /tasks/:id/candidate` 原样取回本地重放。agent 用 token-plan key 直连百炼,记账(token 统计)与审计(transcript 落证)靠事后解析 stream-json 完成。

设计依据:[agent-research 仓 Cloudflare 调研](../research/agent-research/docs/research/cloudflare-ai-infra-overview-2026-08-28.md) 与 [工程最佳实践手册](../research/agent-research/docs/research/cloudflare-ai-agent-best-practices-2026-08-28.md)。

**详细架构与设计文档 → [`docs/architecture.md`](docs/architecture.md)**(目标/非目标、模块拓扑、状态机、证据链、API 参考、已知缺陷与改进方向)。

## 架构

```
POST /tasks ──► TaskSession DO (权威状态机 + events hash chain)
                     │
                     ▼
        AttemptWorkflow (durable steps)
          exec → extract → evidence → report
          → (writer) human-approval
                     │  执行产物/裁决经 REPORT_QUEUE 回报 DO
                     ▼
        Sandbox (一次 attempt 一个,qwen-code stream-json 直连百炼)
        writer: 先材质化到冻结基线 commit(detached)→ 成功后导出该基线上的候选 patch → R2
        verifier: 独立沙箱材质化到同一基线重放候选 + 跑 verify_command(不跑 LLM)
        reviewer: 纯 LLM 直调百炼(无工具)
                     │  OPENAI_BASE_URL / OPENAI_API_KEY(沙箱专用低权 key)
                     ▼
        百炼 compatible-mode API ──► stdout 即 stream-json transcript
                     │
                     ▼
        R2: artifacts/(内容寻址) + evidence/(manifest) + D1 终态归档
```

任务主线:writer 成功 →(repo 任务)`VERIFYING` 独立验证 → 通过后派 reviewer → `AWAITING_APPROVAL` → DONE/REJECTED。返工轮的新 attempt 会带上上一轮的失败证据与修复指令,不再只拿裸原始 prompt。

权威边界:运行中任务状态/决策只认 TaskSession DO(状态转换经显式转换表校验,所有写路径含 `alarm` 都用 `blockConcurrencyWhile` 串行,并有并发测试证明),终态归档 D1;transcript、产物、候选 patch 以 digest 形式绑定进 evidence manifest;每个 decision 强制绑定组合证据 `[writer, verifier?, reviewer?]`,且绑定值只从钉住的 `current_evidence` 算——`/evidence` 与 `/approve` 同口径,正确的审批不会 409。基线是任务级权威 `task.base`:首轮材质化时冻结(default HEAD 或人工 `spec.base_sha`),返工轮与 verifier 一律复用它(跨轮 `patch_digest` 比较与「候选可重放」都以此为前提);材质化失败(`21` 不可达 / `22` HEAD 不符 / `23` 导出失败)按环境事实处理 → `base.failed` + `awaiting_human` + `BLOCKED` 转人工,**不消耗返工预算、不派下游**;`base_sha` 会被重放进每个新沙箱的 shell,所以入口与 DO 双重按全长度小写 hex 严格校验,非法即 400 且不起沙箱。门禁分级:机械硬门禁(writer `exit_code != 0`、验证失败、超时/预算、证据缺失)保留否决权,writer 失败绝不进审批流;reviewer 的 reject 必须给出可执行修复指令与材料内可核对的证据引用,否则只是意见(默认 `shadow` 模式先只记事件)。两轮候选逐字节相同即熔断转人工(`awaiting_human`),此后终态只能人工给。事件链按 task 单调 seq 追加(链内单写者),并发不产生分叉。候选交付 `GET /tasks/:id/candidate` 是**只读投影**(不新增状态对象):报出候选自己的基线、patch 引用与判定标签,`?format=patch` 在下发前重算字节 sha256 与 manifest 记录比对,不一致即 `integrity_error` 而不是把未校验字节交出去 —— 平台仍不持有任何 GitHub 写权限。

## 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars   # 填入百炼 key 和本地调试 token
npm run db:migrate:local
npm run dev                      # 沙箱本地跑需要 Docker
npm test                         # vitest:状态机单测 + DO 并发测试(miniflare)
```

冒烟:

```bash
TOKEN=本地调试token
curl -X POST localhost:8787/tasks -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"spec":{"prompt":"写一个 hello.py 并运行"}}'
curl localhost:8787/tasks/<task_id> -H "authorization: Bearer $TOKEN"

# 带验收标准的 repo 任务:acceptance 是 reviewer 能否否决返工的前提
curl -X POST localhost:8787/tasks -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"spec":{"prompt":"...","repo_url":"https://github.com/octocat/Hello-World","verify_command":"test -f hello.txt","acceptance":["仓库根目录存在 hello.txt","文件内容为 hello cloud-agent"]},
       "review_evidence_mode":"shadow"}'

# 指定冻结基线(全长度小写 hex;非法值 400 invalid_base_sha,不落库、不起沙箱)
#   不指定则在首轮执行时解析默认分支 HEAD 并冻结,后续返工轮与 verifier 一律复用它
curl -X POST localhost:8787/tasks -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"spec":{"prompt":"...","repo_url":"https://github.com/octocat/Hello-World","base_sha":"<40位commit>","verify_command":"test -f hello.txt"}}'

# 审批强制绑定组合证据:先从 /evidence 取 binding_digest
curl -s localhost:8787/tasks/<task_id>/evidence -H "authorization: Bearer $TOKEN"
curl -X POST localhost:8787/tasks/<task_id>/approve -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"decision":"approve","actor":"human:me","attempt_id":"<writer_attempt_id>","evidence_digest":"<binding_digest>"}'

# 候选交付:status / 基线 / patch digest / 诚实性告警
curl -s localhost:8787/tasks/<task_id>/candidate -H "authorization: Bearer $TOKEN" | jq '{status, verified, safe_to_apply, base, patch, warnings}'

# 取回补丁并在它被验证过的那个 commit 上本地重放(下发前服务端已重算 sha256)
curl -s -OJ "localhost:8787/tasks/<task_id>/candidate?format=patch" -H "authorization: Bearer $TOKEN"
git -C <你的仓库> checkout <candidate.base.sha> && git apply task-<task_id>-<patch前12位>.patch

curl -N localhost:8787/tasks/<task_id>/events/stream -H "authorization: Bearer $TOKEN"   # GET /tasks/:id/events/stream:SSE 在途事件流(第④层可观测的投影,**非权威**,不写任何状态)—— 帧 id = 该帧之后已读的条数,与 /events 的 `?after=` 完全同口径,断线带 `Last-Event-ID` 续传不重发不漏读;每拍 3s 推增量,任务离开 RUNNING 且增量推完则一帧 `end` 后关流(详见 docs/architecture.md §9.6)

curl -s "localhost:8787/live/<task_id>" -H "authorization: Bearer $TOKEN" -o live.html && $BROWSER live.html   # GET /live/:taskId:上面那条流的人眼端(第④层下半,docs/architecture.md §9.7)—— 全内联、零外部依赖的单页 HTML,页面自己用 `EventSource` 连 /tasks/:id/events/stream。核心价值是**停滞检测**:「最后事件 Ns 前」每秒自增,>90s 黄、>300s 红(C2-r6 那种 24 分钟模型悬挂,5 分钟内肉眼可判,不必再人工 tail)。时间线按到达序渲染 seq/kind 徽章/ts/payload.text 摘要(>200 字符截断标注),`tool_use` 显示 tool_names、`raw` 显示 raw_type,收到 `end` 帧显示「流已结束」并停表;坏帧跳过并计数。**只被动显示:不做任何判定与处置**。判定由 Supervisor 做(第②层 Observation 的独立消费者,docs/architecture.md §9.8):它寄生在既有 watchdog alarm 里每 `SUPERVISOR_TICK_SECONDS`(缺省 60)醒一次,读 journal 判 stall/loop/no_progress 三类启发式,把结论写成权威链上的 `supervisor_finding` 事件 —— **只记事件,不做任何处置**(不 cancel/kill/BLOCKED/改路由)。启用点是 `wrangler.jsonc` 的 `SUPERVISOR_MODE`(代码缺省 `off`,prod 显式配 `shadow`,先攒样本再谈 enforce)。鉴权与 /tasks/:id/events* 同源:无凭据 401、任务不存在 404。⚠️ 已知前提:`EventSource` 不能携带 `Authorization` 头,浏览器直连会得到 401 并显示重连提示 —— 打通需要部署侧注入凭据(§9.7)

# 复盘各 attempt(writer/verifier/reviewer)的终态与 token 消耗 —— `GET /admin/attempts`。
# 它是 D1 归档的**只读视图**(读投影,不是新的状态权威):attempt 随任务终态才归档,
# 因此**不含尚未归档的在途 attempt** —— 在跑的任务仍看 `GET /tasks/<task_id>`。
# 安全投影:一次性模型代理凭据 `proxy_token` **绝不下发**,内部去重用的
# `idempotency_key` 同样不进投影;返回字段固定为 id/task_id/role/state/tokens_used/
# input_tokens/cache_read_tokens/output_tokens/cost_weighted_tokens/max_model_tokens/
# max_wall_seconds/workflow_instance_id/created_at/finished_at。
# 成本口径看 `cost_weighted_tokens`,不是 `tokens_used`:后者是 raw total(为历史可比
# 保留),r11 writer 实测其 96.9% 是最便宜的隐式缓存命中(6,949,711 里 6,733,762 是
# cache_read)。加权值 = (input − cache_read) + output + round(cache_read × 折扣系数),
# 折扣系数取 `CACHE_READ_COST_FACTOR`(未设/非法回落 0.2;这只是横向比较用的估计值,
# qwen3.8-flash 的真实隐式缓存折扣以百炼控制台为准)。四列为 null = 该记录产生时未记过
# 拆分口径(M8 前的历史行)或没拿到 usage,**不等于消耗为 0**。
# 过滤按 AND 组合:?task_id=(36 字符 UUID) ?role= ?state= ?limit=(默认 50,上限 200);
# 畸形值 → 400,过滤不命中 → 空列表(count 是本次返回条数,受 limit 截断,不是总匹配数)
curl -s "localhost:8787/admin/attempts?task_id=<task_id>&role=writer" \
  -H "authorization: Bearer $TOKEN" | jq '{count, attempts: [.attempts[] | {id, state, tokens_used, cost_weighted_tokens, cache_read_tokens, finished_at}]}'

# 按任务回放审计事件 hash chain —— `GET /admin/events`。
# 同样是 D1 归档的**只读视图**(读投影,不是新的状态权威):事件随任务终态才归档,
# 因此**只含已归档(终态)任务的事件**,**看不到仍在 DO 中运行、尚未归档的在途事件**
# —— 在跑的任务仍看 `GET /tasks/<task_id>`。
# `?task_id=`(36 字符 UUID)**必填**:每 task 的 `seq` 才是分页脊线,跨 task 分页没有
# 意义;缺失或畸形 → 400。按 `seq` 升序(审计回放顺序)返回
# `{"events":[{seq,kind,digest,prev_digest,created_at,canonical}],"next_cursor":<string|null>}`。
# `canonical` 是 D1 `payload` 列的**逐字原文**(即被 hash 的 `JSON.stringify({task_id,kind,payload})`,
# 不是内层 payload 对象),不解析、不重新序列化 —— 客户端因此能独立重算
# `digest == sha256Hex((prev_digest ?? "GENESIS") + canonical)` 并逐条核对 `prev_digest`,
# 等于在本地重放一遍 `GET /admin/chain-check`:核验依据是拿到的字节,不是服务端的一句声称。
# 安全:审计 journal 按构造**绝不携带**一次性模型代理凭据 `proxy_token`(它只存在于
# `attempts` 表,从不进事件链),所以这个端点不是凭据的第二条出口。
# 游标分页:`?limit=`(默认 50,上限 200,非数字或越界 → 400)、`?cursor=`(不透明游标,
# 首页省略;畸形 → 400);`next_cursor` 是下一页起点,无后续时为 `null`。过滤不命中 → 空列表 + null,不是 404。
curl -s "localhost:8787/admin/events?task_id=<task_id>&limit=20" \
  -H "authorization: Bearer $TOKEN" | jq '[.events[] | {seq, kind, digest: .digest[0:12]}]'
# 客户端自校验:逐条用 canonical 重算 digest 并核对 prev 链接(分页时逐页核验,
# 游标串起来就是整条链)
curl -s "localhost:8787/admin/events?task_id=<task_id>" -H "authorization: Bearer $TOKEN" | \
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",async()=>{const{events}=JSON.parse(s);const h=async c=>[...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(c)))].map(b=>b.toString(16).padStart(2,"0")).join("");let prev=null;for(const e of events){if(e.prev_digest!==prev)throw new Error(`断链 @seq=${e.seq}`);if(await h((prev??"GENESIS")+e.canonical)!==e.digest)throw new Error(`digest 不符 @seq=${e.seq}`);prev=e.digest}console.log(`chain ok: ${events.length} 条`)})'
```

## 候选落地(`scripts/land.mjs`)

平台侧只读、不持任何 push 凭据;落地端是唯一能写远端的地方,所以它把「人工取证据 → 核 digest → 干净树 apply → 本地验证 → commit → push」写成一条**先证明再动手**的链。守门判定全在 `scripts/land-gate.mjs`(纯函数 + 依赖注入,由 `test/land-gate.test.ts` 钉不变量),`land.mjs` 只是接 git/npm/HTTP 的薄壳。

```bash
export WORKER_API_TOKEN=…                      # 平台 API token;缺失即 fail-closed(退出码 3)
node scripts/land.mjs --task <task_id>          # 默认 dry-run:五道门全跑,绝不 commit/push
node scripts/land.mjs --task <task_id> --execute # 通过后在临时 worktree 里 commit
node scripts/land.mjs --task <task_id> --execute --push   # 再 git push origin HEAD:main
# 可选:--api <url>(默认 https://cloud-agent.aflow.workers.dev)、--token-env <NAME>
#       (默认 WORKER_API_TOKEN)、--worktree <dir>(固定目录;失败现场保留,缺省放系统临时目录且结束回收)
# 迭代循环续命两段(独立开关,都在 g 步之后执行,守门链本身不变):
#   --next <file>  本轮 push 成功后,把该 JSON 文件原样 POST /tasks 提交下一任务(记进摘要 next_task)
#   --wait         上一段提交成功后,每 60s GET /tasks/<id> 直到 DONE/REJECTED/BLOCKED(上限 90 分钟)
node scripts/land.mjs --task <task_id> --execute --push --next backlog/next.json --wait
```

五道门按序执行,任一步失败立即停,后续步骤一次都不执行:

1. `done_state` —— `GET /tasks/:id` 的 `state` 必须是 `DONE`(平台不变量:进 DONE 必经决策记录),且 `base.sha` 是全长 commit sha。
2. `manifest_cross` —— `GET /tasks/:id/evidence` 的 `digest` 必须等于 `task.current_evidence.writer_manifest_digest`(证据口径单一来源,不一致即有一边被换过)。
3. `digest_ok` —— `GET /tasks/:id/candidate?format=patch` 的**响应体字节**本地重算 sha256,与 `manifest.patch.digest` 逐字符比对。这是防篡改硬门:材料是拿到的字节,不是服务端的声称。
4. `apply_ok` —— `git fetch origin` 后在 `<base_sha>` 上开 detached worktree,`git apply --check` 通过再 `git apply`(patch 走 stdin,不在工作树里留文件)。
5. `tests_ok` —— worktree 内 `npm ci --no-audit --no-fund` → `npm run typecheck` → `npm test`。

全绿且带 `--execute` 才 commit,提交信息逐字含四要素(task / base sha 全长 / patch sha256 / binding digest)加一行真实验证摘要;`--push` 必须与 `--execute` 同传,且 push 只在**已 commit** 后发生。push 失败(含非快进)直接报错退出,**绝不 `--force`**。

守门链之后可追加两段迭代循环尾巴(判定同样在 `land-gate.mjs`,h 步 `--next` / i 步 `--wait`):

- **h `--next <file>` —— 提交下一任务。硬不变量:本轮 `pushed` 为真才 POST。** 判的是实际推送事实而不是「传了 `--push`」:本轮改动没进远端就派下一任务,下一轮会在缺本轮成果的基线上重跑,而无人值守的循环里这种失败会一直「成功」。前置不满足时 stderr 打一行 `[land] next skip push 未成功 …`、`next_task=null`,不静默跳过。参数层还拦一条链式依赖:`--next` ⇒ `--push` ⇒ `--execute`、`--wait` ⇒ `--next`,缺环即 usage 错误(3)。
- **文件即权威副本**:`--next` 指向的 JSON 文件形状与 `POST /tasks` 请求体同构(`{"spec":{…},"budget":{…}}`)。脚本**不改写**它(POST 发的是文件原文字节,不是重新序列化)、**不做 schema 校验** —— 平台是唯一裁判,形状错误由 4xx 大声失败(→ 退出码 1)。文件读不到/不是合法 JSON → 退出码 3,但五道门已判完,摘要照打(`next_task=null`)。
- **i `--wait` —— 轮询下一任务到终态**:每 60s `GET /tasks/<next_id>`,直到 `state ∈ {DONE, REJECTED, BLOCKED}`(记进 `next_state`)。瞬态容忍:单次网络错误/HTTP 5xx 继续下一轮,连续 ≥5 次问不到才放弃;预算 90 分钟用完仍非终态即超时 —— 两者都是退出码 1(报的是环境)。下一任务自己的 `REJECTED`/`BLOCKED` **不改本次运行的退出码**:那是它那一轮 land 运行的裁决,不由本次运行代答。

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功。dry-run 表示「可以落地」;`--execute` 表示已 commit(`--push` 则已 push,`--wait` 则下一任务已到终态) |
| 1 | 执行期故障:网络、子进程、`npm ci`、commit/push 本身失败、`POST /tasks` 被拒、`--wait` 超时或连续 5 次问不到 —— 报的是环境,不是对候选的裁决 |
| 2 | 守门拒绝:五道门(`done_state`/`manifest_cross`/`digest_ok`/`apply_ok`/`tests_ok`)任一不过 |
| 3 | 环境或参数错误:usage 错误(只传 `--push`、`--next` 缺 `--push`、`--wait` 缺 `--next`、未知参数、缺 `--task`…)、token 环境变量缺失、目标不是 git 仓库、`--next` 的 spec 文件读不到或不是合法 JSON(此时五道门已判完,摘要**照打** —— 这是 3 里唯一打摘要的一类) |

过程日志走 stderr(`[land] <step> ok|fail|skip|retry <detail>`),终局摘要走 stdout 一行 JSON —— 守门开始**之前**的失败不输出摘要(一道门也没评估过);唯一例外是 `--next` 的 spec 文件不可用:那时五道门已判完,摘要照打。

```json
{"task":"…","gate":{"done_state":true,"manifest_cross":true,"digest_ok":true,"apply_ok":true,"tests_ok":true},"committed":false,"pushed":false,"commit_sha":null,"next_task":null,"next_state":null}
```

`next_task` 是 h 步提交成功后平台返回的新任务 id,`next_state` 是 i 步轮询到的终态;dry-run 或前置不满足时恒为 `null`(键恒在,读的人靠键的存在判断「这段跑过了」)。

边界:不做并发落地锁(假设单机单循环,一次只 land 一个 task),不做凭据缓存(每个请求从 env 现读 —— `--wait` 之后这个窗口最长 90 分钟,更要现读),不做 `--force`、不做交互式确认。`git`/`npm` 真实进程行为与真 HTTP 不在单测里 mock —— 第一次在新任务上跑请先 dry-run,看五道门是否如预期。

## 部署前一次性配置(需要账号操作)

1. `npx wrangler login`
2. `npx wrangler d1 create cloud-agent` → 把 `database_id` 填进 `wrangler.jsonc`
3. `npx wrangler r2 bucket create cloud-agent-artifacts` 和 `cloud-agent-evidence`
4. `npx wrangler queues create cloud-agent-review` 和 `cloud-agent-review-dlq`
5. `npx wrangler secret put DASHSCOPE_API_KEY`(百炼 token-plan 高权 key,Worker 侧给 reviewer 直调;沙箱默认不再用它,见下一步)
6. `npx wrangler secret put SANDBOX_MODEL_API_KEY`(**建议与上一把不同**:沙箱专用低权 key,注入容器当 `OPENAI_API_KEY`)。**可选**——没配时容器回落用 `DASHSCOPE_API_KEY` 并在日志打一条 `credential_fallback` 告警,那正是 M8 要消掉的状态:沙箱里跑 `--yolo` + 任意 repo_url + 不可信代码,与控制面共用一把 key 等于沙箱泄露即控制面凭据泄露。刻意不 fail-closed:降权是配置层增强,不该阻塞基线冻结与候选交付。低权 key 买到的是「可单独撤销 + 爆炸半径止于一把 key + 用量可归因」,**不是**额度硬上限(token-plan 无可靠的 per-key 硬额度)。
7. `npx wrangler secret put WORKER_API_TOKEN`(控制面 API token)
8. `npm run db:migrate:remote`
9. `wrangler.jsonc` 里 `PUBLIC_URL` 改为 `https://cloud-agent.<你的子域>.workers.dev`
10. 构建并推送沙箱镜像(`wrangler deploy` **不会**代劳,只在改 `sandbox/Dockerfile` 或升 qwen-code 版本时需要):
   ```bash
   docker build --platform=linux/amd64 -t cloud-agent-sandbox:qwen-0.21.10 sandbox
   npx wrangler containers push cloud-agent-sandbox:qwen-0.21.10
   # 把输出的 registry.cloudflare.com/<account>/… 写进 wrangler.jsonc containers[0].image
   ```
11. `npm run deploy`

## 已知边界(对应调研 §10)

- 长任务实测边界(2026-09-01 探针):**单条命令 ≤ 25 分钟** —— ~30 分钟处 workerd 挂起检测会杀掉 workflow 的长挂起请求(§13.18),修复(后台启动 + 短轮询)排在 M9.5。容器本身在 30+ 分钟内存活无问题,墙在执行面那侧。
- 容器可被替换:attempt 重建靠 spec+command digest,不依赖进程句柄。
- qwen-code 的 `--auth-type openai` 与 stream-json 标志以本机 `qwen --help` 为准(sandbox.ts 中有集中定义)。
- Sandbox 1.0 Preview(`@next`)API 已发布,稳定线 SDK 与镜像 tag 需对齐;升级时一起动。
- D1 高并发写争用未压测;events hash chain 是防篡改检测,不是防平台方的密码学证明。
- M7 的 fail-closed 是刻意的:reviewer 基建抖动或两轮候选无进展 → 任务挂 `awaiting_human` 等人工,绝不自动放行。代价是这类任务会堆积,`GET /tasks` 还没有 `awaiting_human` 过滤,只能逐个任务从事件里看。
- **沙箱出站已上 allowlist**(M9,prod `EGRESS_MODE=enforce`):`ContainerProxy` 已导出,`Sandbox` 子类 `interceptHttps` 全拦,白名单 = 模型主机(从 `MODEL_UPSTREAM_BASE` 推导)+ `EGRESS_GIT_HOSTS`(缺省 `github.com`),未列名主机一律 520。负向用例已在沙箱内固化证据(`curl example.com` → 520 `Origin is disallowed`),实施坑(含 `static outbound` 字段遮蔽基类 setter 那个)见 `docs/architecture.md` §13.14。凭据降权仍是独立的另一条防线且**处于回落态**:低权 `SANDBOX_MODEL_API_KEY` 尚未铸造,容器共用高权 key(日志 `credential_fallback`)。
- 基线冻结默认 `BASE_PIN_MODE=shadow`:writer 在 pinned 基线不可达时回落已解析的默认分支并记 `base.fallback`,verifier **恒 enforce、不回落**。老任务(M8 前)是 `unknown_legacy`,候选如实标注「基线未固定,不保证可重放」。
- 换沙箱镜像有热实例排空窗口:与"删掉冷装兜底"同批部署会让头几个 attempt 打到旧镜像(`exit 127`)。顺序见 `docs/architecture.md` §12。

## 验收

对照最佳实践手册 §7 的 PoC 验收矩阵逐条过:DO/Workflow 崩溃恢复、Queue 重投幂等、Sandbox 容器替换、**非 allowlist 网络拒绝(已覆盖 —— M9 起 `EGRESS_MODE=enforce`,沙箱内 `curl example.com` 得 520 `Origin is disallowed`,见 §13.14)**、token-plan key 仅注入沙箱供 agent 客户端直连(不经代理/不落盘)、时长与 turn 超限由 qwen-code 参数硬停、审批 HITL(或 reviewer agent 自动裁决)、digest 篡改检测、stale fencing 拒绝、events 链并发无分叉。

M6 追加(均已验收):**失败门禁**(writer 失败产物不可被批准,只能 rework/BLOCKED)、**独立验证器**(冻结候选在独立沙箱重放,结构化报告入证)、**组合证据强制绑定**(缺证据 400 / 伪证据 409,裁决绑定 `[writer, verifier?, reviewer?]`)、**DO 并发保护**(并发创建/读取/启动测试证明无交错写)。

M7 追加(2026-09-01 prod 验收,详见 `docs/architecture.md` §13.12):**门禁分级**(机械硬门禁保留否决权;reviewer 的 reject 需 `failed_criteria` + 可执行 `fix_instructions` + 材料内可核对 `quote`,默认 `shadow` 只记事件)、**返工带走证据**(验证失败的 stderr 原文翻成修复指令进下一轮 prompt → repo 任务两轮闭环,reviewer 的"额外字段"异议只作为意见不再开轮)、**无进展熔断**(两轮候选 patch digest 相同即停,不再派 verifier/reviewer,`awaiting_human` 后终态只能人工给)、**证据口径单一来源**(`current_evidence` 钉住,`/evidence` 与 `/approve` 同口径,R2 独立重算逐字节一致;陈旧血缘 409 `attempt_not_current_writer`)、**预装镜像**(自建 `sandbox/Dockerfile` 镜像上 Cloudflare managed registry,去掉每 attempt 的 `npm install -g`)。影子期尚无 reject 样本,`enforce` 保持关闭;`GET /admin/chain-check` = `broken: 0`。

M8 追加(**2026-09-01 prod 验收**,详见 `docs/architecture.md` §13.13 / §13.15):**基线冻结**(`TaskRecord.base` 为任务级权威;writer 与 verifier 材质化到同一个精确 commit,`fetch --depth=1 → --deepen 阶梯 → checkout --detach → HEAD 断言`;`21/22/23` 按环境事实 fail-closed 进 `BLOCKED`,不烧返工预算、不派下游;`base_sha` 因会被重放进新沙箱的 shell,入口与 DO 双重严格校验)、**候选交付接口**(`GET /tasks/:id/candidate` 只读投影,`status`/`safe_to_apply` 区分"独立验证过"与"只是产出过";`?format=patch` 下发前重算 sha256,不一致即 `integrity_error`)、**沙箱凭据降权(可选)**(容器优先用可撤销的低权 `SANDBOX_MODEL_API_KEY`,高权 `DASHSCOPE_API_KEY` 留在 Worker 侧给 reviewer;低权那把缺配时回落共用并打 `credential_fallback` 告警 —— 刻意不 fail-closed,**prod 当前就是回落态**)、**apply 失败语义变更**(基线固定后 `git apply` 失败即候选缺陷,返工指令改为「基于该基线重做」而非「同步最新默认分支」)。

M9 追加(安全三件,**2026-09-01 prod 验收**,详见 `docs/architecture.md` §13.14 / §13.17):**出站 allowlist**(`ContainerProxy` 导出 + `Sandbox` 子类两档策略;按惯例先 `shadow` 取样 —— prod 样本恰好 3 个主机,其中 qwen-code 的阿里云 RUM 遥测定性为非必要、不加白,加白零新增 —— 再翻 `enforce`。正向:完整 repo 任务在 enforce 下全绿,同时证明基镜像已继承平台 CA、无需改 Dockerfile;负向:沙箱内 `curl https://example.com` 得 `520 / Origin is disallowed`,证据固化在任务自己的产物里;`wrangler tail` 对账:放行主机条条有 `egress=forward` 记账,被拒主机零记账 —— 门禁在第 2 步就拦,不进处理器)、**补丁大小上限**(容器内 `wc -c` 预检,超限 `exit 24` → 容量事实路由 `BLOCKED` 转人工,不返工;默认 1 MiB,`MAX_PATCH_BYTES` 可选回落;字节不回传,杜绝巨型 `--binary` diff 撑爆 worker isolate)、**长任务生命周期探针(失败,但失败得有价值)**:单条 ~30 分钟的 `sandbox.exec` 在 29:48 处被 workerd 挂起检测杀掉(不是文档里的 step 限制),保守安全线 = 单条命令 ≤ 25 分钟;顺带暴露「验证器平台错误进 writer 返工」的浪费路径。全部事实与 M9.5 修复方向见 §13.18。实施中新抓一个 SDK 级坑并修掉:`static outbound = fn` 类字段遮蔽基类静态 setter → 处理器注册表恒空、观测静默失效,改 `static { this.outbound = fn }` 并有机制测试钉住。

M9 prod 取证:`npm test` → 110 passed、`tsc --noEmit` 干净(噪音形态仍是 §13.16 记录的三类,无形态变化;「本地跑不到执行面」的边界不变 —— A/B 的门禁语义只有 prod 一层证据)。出站治理:shadow 样本 3 主机 → enforce 翻转 → 正向全绿 + 负向 520 各一 + `wrangler tail` 记账对账。补丁上限:本地测试 + 变异证明门禁可达,**prod 无超限样本**(现有任务补丁都是几百字节级)。长任务:如上,探针失败,安全线 25 分钟写进 §13.18。两条旧账未动:`BASE_PIN_MODE` / `REJECT_EVIDENCE_MODE` 仍 `shadow`(样本判据未达成),`SANDBOX_MODEL_API_KEY` 仍未铸造(日志仍有 `credential_fallback`)。

prod 取证结果:`npm test` → 98 passed、`tsc --noEmit` 干净;E1 无 repo 回归 / E2 pinned 双端同 SHA / E3 **候选取回本地在冻结基线上 `git apply` 成功**(本轮验收终点)/ E5 shadow 回落与 enforce fail-closed 双模式(19 秒 BLOCKED、writer `tokens_used=0`、预算不变)/ E6 注入 5 样本全 400 / E7 历史 `binding_digest` 逐字节不变 + 老任务如实标注基线未固定 + `chain-check broken=0` / E8 容器 key 指纹 = 高权 key(**降权收益目前为零**)。E4「上游移动」未取证:需要 runner 有默认分支 push 权限的仓库,现有样本都在 `octocat/Hello-World` 上。两条只有 prod 才暴露的问题已修:`sandbox.exec` 复用常驻 shell、脚本顶层 `exit` 会**杀掉会话**(退出码永不回传,改整段包进子 shell,§13.15);`base.failed.detail` 因 `??` 不认空串而恒为 `""`(改判空回落 + 事件带 `manifest_key` 指针)。**套件全绿不等于执行面被验证过**:`AttemptWorkflow` 的 `exec/extract/evidence/report` 要求真实容器,本地一行跑不到(本地 `npm test` 输出里那批 `uncaught exception` 就是这些被遗弃的本地 run,已实测不会写进 DO,计数与判读见 §13.16;能本地化的那一跳已补成 `test/queue-routing.test.ts` 的 5 条 `handleQueue` 投递用例)。**`BASE_PIN_MODE` 与 `REJECT_EVIDENCE_MODE` 均保持 `shadow`**:`BASE_PIN_MODE` 的样本量判据(≥10 个 repo attempt)未达成(自伤回落已确认为 0),`REJECT_EVIDENCE_MODE` 仍是 0 条 reject 样本 —— 两个开关的启用条件互不相干。
