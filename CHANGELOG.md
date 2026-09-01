# Changelog

本项目 M1→M9 的变更历史。事实全部取自 [`README.md`](README.md) 与 [`docs/architecture.md`](docs/architecture.md)(含 §13 各小节台账),材料未记载的日期、版本号、指标一律不补。

归属说明:材料里带显式里程碑标记的是 M1、M5、M6、M7(含 M7b/M7c)、M8、M9;§13 中另有若干条只记为「已修复 / 已实现」而没有标里程碑号的项目(events hash chain 并发分叉修复、budget overshoot 随代理废弃、`POST /admin/backfill-results` 回填、证据端点、DO namespace 分裂改用 `session_id` 显式路由、模型调用由 Worker 代理改为沙箱直连),因此本节不把 M2/M3/M4 的具体交付硬安到这些编号上。

## M1

- 权威边界迁移:运行中任务的状态不再由「Worker 直接 CAS D1 行」决定,而是迁到 `TaskSession` DO(§6);Workflow 历史、Worker 日志、R2 文件只承担参考/证据角色,D1 降为终态归档 + 查询视图。
- 旧写入面被清理:早期的 `src/control/authority.ts` 自由函数(`createTask` / `createAttempt` / `transition` / `recordDecision`)已删除,写入收敛到 DO 的 RPC 面(`createTask` / `startAttempt` / `reportExecution` / `submitDecision` / `alarm`),Worker 侧只做 HTTP ↔ RPC 的转换与 R2 读取。

## M2

- 材料中没有把任何交付条目显式归属到 M2,本节无可写事实(见顶部归属说明)。

## M3

- 材料中没有把任何交付条目显式归属到 M3,本节无可写事实(见顶部归属说明)。

## M4

- 材料中没有把任何交付条目显式归属到 M4,本节无可写事实(见顶部归属说明)。

## M5

- 自动裁决分支落地:候选通过后才派 reviewer,且 reviewer 是**纯 LLM** 直调百炼 `/chat/completions`(无工具、秒级、天然输出 JSON、不做任何任务执行);裁决经 REPORT_QUEUE 回报 DO,记录 `review.completed` + `decision.recorded` 并 → DONE/REJECTED,再由 `notifyWriter` 唤醒 writer workflow。
- 与人工审批互为兜底:先到先决、后到幂等忽略(§10)。
- 一条被记录的反面经验:reviewer 曾用带工具的 qwen-code 跑,即使 prompt 禁止也会真的执行任务,且结果被 NDJSON 提取器误解析;改为纯 LLM 后稳定。

## M6

- 失败门禁:writer `exit_code != 0` 一律不进审批流,预算内(`DEFAULT_MAX_ATTEMPTS`)自动 rework 下一个 writer,耗尽 → 任务 `BLOCKED`(与质量否决的 `REJECTED` 区分);此前存在「失败产物仍可被批准」的洞。
- 独立验证器:验证语义从 writer 沙箱移出成为独立角色 —— writer 成功后导出候选 patch 内容寻址入 R2 并写进 manifest 的 `patch` 字段,task `RUNNING → VERIFYING`,经 `REVIEW_QUEUE` 的 `verify-request`(复用现有队列、不新增队列,幂等键 `task:verify:<n>`)在全新沙箱重放候选并跑 `verify_command`,**不跑 LLM**,transcript 即结构化验证报告 `{apply:{exit_code}, verify:{exit_code, stdout_tail, stderr_tail}}`(报告里的 `base` 血统与 `schema_version: 2` 由 M8 补齐)。
- 组合证据强制绑定:每个 decision 绑定 `composite([writer, verifier?, reviewer?])`;缺 `attempt_id`/`evidence_digest` → 400 `evidence_required`,伪证据 → 409 `evidence_mismatch`,非 writer → 409 `attempt_not_writer`,仅 `AWAITING_APPROVAL` 可裁决 → 409 `task_not_awaiting`。
- DO 并发保护从注释声明变成有测试证明:`createTask` / `startAttempt` / `reportExecution` / `submitDecision` 整体包 `ctx.blockConcurrencyWhile()`(真 DO + miniflare,同 taskId 并发 8 个 `createTask` 恰好 1 条 `task.created`)。**验收(2026-08-31 部署后)**:E2E 证实落库 digest 与从 R2 manifest 独立重算的 `composite([w,v,r])` / `composite([w,r])` 逐字节一致,缺证据/伪证据/非 writer 全部被拒;repo 任务(`octocat/Hello-World` + `test -f hello.txt && grep -q 'hello cloud-agent' hello.txt`)全链 `RUNNING→VERIFYING→AWAITING_APPROVAL→DONE`,验证器报告 `apply=0, verify=0`。

## M7

- 门禁分级(治「扁平一票否决 + 模型抖动即返工」):`writer exit≠0`、verifier 失败、超时/预算、证据缺失四类机械硬门禁不经 `assessReviewRejection` 直接处置;只有 reviewer 的 reject 受证据契约约束,须给 `failed_criteria` 索引、可执行 `fix_instructions` 与喂入材料内可核对的 `evidence.quote`,否则只算意见;reviewer 基建失败 → `review.unavailable` + `awaiting_human`,不再由解析器兜底成 reject(三阶段解析全失败即 `decision:"none"`)。
- 返工带走证据 + 无进展熔断:`scheduleRework` 按失败来源生成修复指令(verifier 失败经 `describeVerifyFailure` 把 `apply.stderr_tail` / `verify.stdout_tail` 翻成祈使句)拼在原始任务之后;两轮候选 `patch_digest` 相同即 `gate.no_progress`,不再派 verifier/reviewer,`awaiting_human=true` 后终态只能人工给。`alarm()` 也被补进同一个临界区,超时判定与续期统一由 `attemptDeadline` / `nextWatchdogAlarm` 计算。
- 证据口径单一来源 + step 瘦身:`task.current_evidence` 由回报路径钉住,`computeBindingDigest`、`GET /evidence`、`submitDecision` 三处同源,消除「一次本来正确的人工审批永久 409」;`ExecOutcome` 只带 `ArtifactRef`(`slim()` 剥原文)以避开 Workflows 单 step 1MiB 的持久化返回值上限。
- **验收(2026-09-01 prod)**:`REJECT_EVIDENCE_MODE=shadow` 下要求 `hello.js` 导出 `GREETING`、而 `verify_command` 额外要求 `EXPECTED`(prompt 里没有)的 repo 任务 **2 轮闭环 DONE**,reviewer 注意到「多了个 EXPECTED 字段」但按新契约只记为意见、没有为此再开一轮;无进展熔断样本两轮 patch digest 相同(`6ca6458e…`)命中后其后无任何 verify/review 事件;从 R2 独立重算 `sha256(manifest 原文)`=`51af0193…`=`GET /evidence` 的 digest、`composite` = `c2582af6…` = `binding_digest` 并据此审批通过,负例含 409 `attempt_not_current_writer`;`GET /admin/chain-check` → `checked=37, broken=0`。归档事件里 `review.reject_assessed` **0 条**,故 `REJECT_EVIDENCE_MODE` 保持 `shadow`(≥5 个真实 reject 样本的判据未达成)。M7c 另落地自建 `sandbox/Dockerfile` 预装镜像(`cloudflare/sandbox:0.8.14` + qwen-code,tag `qwen-0.21.10`)去掉每 attempt 的 `npm install -g`,并记下「换镜像与删冷装同批部署会让头几个 attempt 命中旧镜像热实例 → `exit 127`」的排空窗口。

## M8

- 基线冻结成为任务级权威:`TaskRecord.base: { sha, source }`(`spec_digest` 刻意只覆盖人工意图,基线不进 spec),首轮材质化时冻结默认分支 HEAD 或人工 `spec.base_sha`,返工轮与 verifier 一律复用;走自己拥有的脚本(`src/exec/base.ts`:`fetch --depth=1 '<sha>'` → `--deepen=10/100/1000` → `checkout --detach` → 断言 `rev-parse HEAD`)而不依赖 SDK 的 `gitCheckout({branch: <sha>})`。`21` 不可达 / `22` HEAD 不符 / `23` 导出失败按环境事实 fail-closed → `base.failed` + `awaiting_human` + `BLOCKED`,不消耗返工预算、不派下游;`base_sha` 会被重放进每个新沙箱的 shell,故入口与 DO 双重按全长度小写 hex 严格校验,非法即 400 且不起沙箱。verifier 侧恒 enforce、不回落(writer 在 `shadow` 可回落)。
- 候选交付接口 `GET /tasks/:id/candidate`:只读投影(不新增状态对象),报出候选自己的基线、patch 引用与判定标签,`status` / `safe_to_apply` 区分「独立验证过」与「只是产出过」;`?format=patch` 在下发前重算字节 sha256 与 manifest 记录比对,不一致即 `integrity_error` 而不是交出未校验字节。平台仍不持有任何 GitHub 写权限 —— 把批准后的内容送回 GitHub 需要独立 Publisher 与受限写权限,属 M9+。
- 沙箱凭据降权(刻意可选、不 fail-closed):容器优先用可单独撤销的低权 `SANDBOX_MODEL_API_KEY`,高权 `DASHSCOPE_API_KEY` 留在 Worker 侧给 reviewer;低权那把缺配时回落共用并打 `credential_fallback` 告警。买到的是「可撤销 + 爆炸半径止于一把 key + 用量可归因」,**不是**额度硬上限。
- **验收(2026-09-01 prod,`npm test` → 98 passed、`tsc --noEmit` 干净)**:E1 无 repo 回归 / E2 pinned 双端同 SHA / E3 候选取回后本地在冻结基线上 `git apply` 成功(本轮验收终点)/ E5 shadow 回落与 enforce fail-closed 双模式(19 秒 BLOCKED、writer `tokens_used=0`、预算不变)/ E6 注入 5 样本全 400 / E7 历史 `binding_digest` 逐字节不变、M8 前老任务(`unknown_legacy`)如实标注「基线未固定」、`chain-check checked=47, broken=0` / E8 容器 key 指纹 = 高权 key,即**降权收益目前为零、prod 处于回落态**。`BASE_PIN_MODE` 保持 `shadow`(样本量判据未达成,自伤回落已确认为 0);E4「上游移动」未取证(需要 runner 有默认分支 push 权限的仓库)。两处只有 prod 才暴露的缺陷同轮修掉:`sandbox.exec` 复用常驻 shell、脚本顶层 `exit` 会杀掉会话(退出码永不回传、fail-closed 路由永不执行,改整段包进子 shell)、`base.failed.detail` 因 `??` 不认空串而恒为 `""`(改判空回落 + 事件带 `manifest_key` 指针)。

## M9

- 出站 allowlist 落地并翻 `enforce`:`ContainerProxy` 补导出(SDK 缺这个导出拦截根本不发生)、新增 `src/exec/sandbox-do.ts` 的 `Sandbox` 子类、`interceptHttps` 两档全开;白名单 = 从 `MODEL_UPSTREAM_BASE` 推导的模型主机 + `EGRESS_GIT_HOSTS`(缺省 `github.com`),列表必须静态可审计(不按任务 `repo_url` 动态放行)。按惯例先 `shadow` 取样:prod 样本恰好 3 个主机,其中 qwen-code 内置的阿里云 RUM 遥测定性为非必要、不加白,加白零新增。
- **验收(2026-09-01 prod)**:正向 —— 完整 repo 任务在 enforce 下全绿(clone → 基线冻结 → writer → verifier `passed=true` → reviewer approve),同时证明基镜像已继承平台 CA、无需改 Dockerfile;负向 —— 沙箱内 `curl https://example.com` 得 `520 / Origin is disallowed`(20 字节),证据由任务自己的产出固化;`wrangler tail` 对账 —— 放行主机条条有 `egress=forward` 记账、被拒主机零记账(门禁在白名单门第 2 步就拦,没进处理器)。实施中新抓一个 SDK 级坑并修掉:`static outbound = fn` 类字段遮蔽基类静态 setter → 处理器注册表恒空、观测静默失效,改 `static { this.outbound = fn }`,并有机制测试(`Object.hasOwn(Sandbox, "outbound") === false`)+ 变异验证钉住。
- 候选 patch 大小上限:`BASE_ERRORS.PATCH_TOO_LARGE = 24`,`exportPatchScript` 在容器内 `wc -c` 预检、超限 `exit 24` 且**字节不回传**(默认 1 MiB,`MAX_PATCH_BYTES` 可选 + 回落);路由零改动地复用 `onBaseFailed` —— 容量事实 ≠ 候选质量判定 → `BLOCKED` + `awaiting_human`,不返工、不派下游,`transition.reason` 按退出码区分。`npm test` → 110 passed、`tsc --noEmit` 干净;上限由本地测试 + 变异证明可达,**prod 无超限样本**(现有任务补丁都是几百字节级)。
- 长任务生命周期探针**失败,但失败得有价值**:`verify_command: "sleep 1920 && echo long-ok"` + `budget.max_wall_seconds: 3600` 的探针,在 exec 开始后 29 分 48 秒被 workerd 的挂起检测杀掉(不是 Workflows 文档里的 step 限制),保守安全线写为「单条命令 ≤ 25 分钟」;顺带暴露「验证器平台错误按验证失败进 writer 返工」的浪费路径(第二轮 137K tokens 重做同样的活)。修复方向(后台启动 + 短轮询)顺延 M9.5,本轮不实施。两条旧账仍未动:`BASE_PIN_MODE` / `REJECT_EVIDENCE_MODE` 保持 `shadow`(样本判据未达成),`SANDBOX_MODEL_API_KEY` 仍未铸造(日志仍有 `credential_fallback`);「本地跑不到执行面、`exec/extract/evidence` 只有 prod 一层证据」的边界不变。
