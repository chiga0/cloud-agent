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
```

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

- Sandbox 单实例生命周期/空闲超时对长任务的影响未验证——PoC 第一件事就是跑一个 30min+ 任务观察。
- 容器可被替换:attempt 重建靠 spec+command digest,不依赖进程句柄。
- qwen-code 的 `--auth-type openai` 与 stream-json 标志以本机 `qwen --help` 为准(sandbox.ts 中有集中定义)。
- Sandbox 1.0 Preview(`@next`)API 已发布,稳定线 SDK 与镜像 tag 需对齐;升级时一起动。
- D1 高并发写争用未压测;events hash chain 是防篡改检测,不是防平台方的密码学证明。
- M7 的 fail-closed 是刻意的:reviewer 基建抖动或两轮候选无进展 → 任务挂 `awaiting_human` 等人工,绝不自动放行。代价是这类任务会堆积,`GET /tasks` 还没有 `awaiting_human` 过滤,只能逐个任务从事件里看。
- **沙箱出站目前没有 allowlist**:`ContainerProxy` 未从 Worker 入口导出,容器 HTTPS 直连不受治理。计划的补偿是"沙箱只拿可撤销的低权 key",但它目前是**可选配置**——prod 尚未铸第二把 key,容器仍回落共用高权 key(日志 `credential_fallback`),所以这项收益现在为 0。即便配上,买到的也只是撤销能力 + 爆炸半径 + 归因,**不是限流**(token-plan 无可靠的 per-key 硬额度)。三个实施坑见 `docs/architecture.md` §13.14,做在 M9。
- 基线冻结默认 `BASE_PIN_MODE=shadow`:writer 在 pinned 基线不可达时回落已解析的默认分支并记 `base.fallback`,verifier **恒 enforce、不回落**。老任务(M8 前)是 `unknown_legacy`,候选如实标注「基线未固定,不保证可重放」。
- 换沙箱镜像有热实例排空窗口:与"删掉冷装兜底"同批部署会让头几个 attempt 打到旧镜像(`exit 127`)。顺序见 `docs/architecture.md` §12。

## 验收

对照最佳实践手册 §7 的 PoC 验收矩阵逐条过:DO/Workflow 崩溃恢复、Queue 重投幂等、Sandbox 容器替换、**非 allowlist 网络拒绝(未覆盖 —— `ContainerProxy` 尚未导出,顺延 M9,见 §13.14)**、token-plan key 仅注入沙箱供 agent 客户端直连(不经代理/不落盘)、时长与 turn 超限由 qwen-code 参数硬停、审批 HITL(或 reviewer agent 自动裁决)、digest 篡改检测、stale fencing 拒绝、events 链并发无分叉。

M6 追加(均已验收):**失败门禁**(writer 失败产物不可被批准,只能 rework/BLOCKED)、**独立验证器**(冻结候选在独立沙箱重放,结构化报告入证)、**组合证据强制绑定**(缺证据 400 / 伪证据 409,裁决绑定 `[writer, verifier?, reviewer?]`)、**DO 并发保护**(并发创建/读取/启动测试证明无交错写)。

M7 追加(2026-09-01 prod 验收,详见 `docs/architecture.md` §13.12):**门禁分级**(机械硬门禁保留否决权;reviewer 的 reject 需 `failed_criteria` + 可执行 `fix_instructions` + 材料内可核对 `quote`,默认 `shadow` 只记事件)、**返工带走证据**(验证失败的 stderr 原文翻成修复指令进下一轮 prompt → repo 任务两轮闭环,reviewer 的"额外字段"异议只作为意见不再开轮)、**无进展熔断**(两轮候选 patch digest 相同即停,不再派 verifier/reviewer,`awaiting_human` 后终态只能人工给)、**证据口径单一来源**(`current_evidence` 钉住,`/evidence` 与 `/approve` 同口径,R2 独立重算逐字节一致;陈旧血缘 409 `attempt_not_current_writer`)、**预装镜像**(自建 `sandbox/Dockerfile` 镜像上 Cloudflare managed registry,去掉每 attempt 的 `npm install -g`)。影子期尚无 reject 样本,`enforce` 保持关闭;`GET /admin/chain-check` = `broken: 0`。

M8 追加(**2026-09-01 prod 验收**,详见 `docs/architecture.md` §13.13 / §13.15):**基线冻结**(`TaskRecord.base` 为任务级权威;writer 与 verifier 材质化到同一个精确 commit,`fetch --depth=1 → --deepen 阶梯 → checkout --detach → HEAD 断言`;`21/22/23` 按环境事实 fail-closed 进 `BLOCKED`,不烧返工预算、不派下游;`base_sha` 因会被重放进新沙箱的 shell,入口与 DO 双重严格校验)、**候选交付接口**(`GET /tasks/:id/candidate` 只读投影,`status`/`safe_to_apply` 区分"独立验证过"与"只是产出过";`?format=patch` 下发前重算 sha256,不一致即 `integrity_error`)、**沙箱凭据降权(可选)**(容器优先用可撤销的低权 `SANDBOX_MODEL_API_KEY`,高权 `DASHSCOPE_API_KEY` 留在 Worker 侧给 reviewer;低权那把缺配时回落共用并打 `credential_fallback` 告警 —— 刻意不 fail-closed,**prod 当前就是回落态**)、**apply 失败语义变更**(基线固定后 `git apply` 失败即候选缺陷,返工指令改为「基于该基线重做」而非「同步最新默认分支」)。

prod 取证结果:`npm test` → 93 passed、`tsc --noEmit` 干净;E1 无 repo 回归 / E2 pinned 双端同 SHA / E3 **候选取回本地在冻结基线上 `git apply` 成功**(本轮验收终点)/ E5 shadow 回落与 enforce fail-closed 双模式(19 秒 BLOCKED、writer `tokens_used=0`、预算不变)/ E6 注入 5 样本全 400 / E7 历史 `binding_digest` 逐字节不变 + 老任务如实标注基线未固定 + `chain-check broken=0` / E8 容器 key 指纹 = 高权 key(**降权收益目前为零**)。E4「上游移动」未取证:需要 runner 有默认分支 push 权限的仓库,现有样本都在 `octocat/Hello-World` 上。两条只有 prod 才暴露的问题已修:`sandbox.exec` 复用常驻 shell、脚本顶层 `exit` 会**杀掉会话**(退出码永不回传,改整段包进子 shell,§13.15);`base.failed.detail` 因 `??` 不认空串而恒为 `""`(改判空回落 + 事件带 `manifest_key` 指针)。**`BASE_PIN_MODE` 与 `REJECT_EVIDENCE_MODE` 均保持 `shadow`**:`BASE_PIN_MODE` 的样本量判据(≥10 个 repo attempt)未达成(自伤回落已确认为 0),`REJECT_EVIDENCE_MODE` 仍是 0 条 reject 样本 —— 两个开关的启用条件互不相干。
