import type { WorkflowEntrypoint } from "cloudflare:workers";

import type { Sandbox as SandboxDO } from "@cloudflare/sandbox";
import type { BaseSource } from "./exec/base";
import type { TaskSession } from "./control/session";

export interface Env {
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  EVIDENCE: R2Bucket;
  ATTEMPT_WORKFLOW: Workflow;
  REVIEW_QUEUE: Queue;
  REPORT_QUEUE: Queue;
  Sandbox: DurableObjectNamespace<SandboxDO>;
  TASK_SESSION: DurableObjectNamespace<TaskSession>;

  ENVIRONMENT: string;
  PUBLIC_URL: string;
  MODEL_UPSTREAM_BASE: string;
  DEFAULT_MODEL: string;
  DEFAULT_MAX_MODEL_TOKENS: string;
  /**
   * 未给预算时的墙钟缺省(秒)。**只是缺省值**:校验、夹钳、四个时钟的推导全部在
   * src/control/budget.ts 的 resolveBudget(§7.2.2)。给了非法值 → 回落 3600 并打
   * `budget_default_invalid` 告警,不再让 NaN 流进 qwen 命令行。
   */
  DEFAULT_MAX_WALL_SECONDS: string;
  DEFAULT_MAX_ATTEMPTS: string;
  /** reviewer reject 的证据校验:"shadow"(只记账) | "enforce"(不成立即降级 accept-with-notes) */
  REJECT_EVIDENCE_MODE: string;
  /** 基线材质化失败的处理:"shadow"(回落默认分支并留痕) | "enforce"(直接 BLOCKED 转人工) */
  BASE_PIN_MODE: string;
  /**
   * 沙箱出站策略:"shadow"(全部放行但记录每个出站主机) | "enforce"(仅允许
   * 白名单主机)。可选,缺省按 shadow —— 有否决权的开关先观测再启用。
   */
  EGRESS_MODE?: string;
  /** enforce 白名单中的代码托管主机,逗号分隔。可选,缺省仅 "github.com"。 */
  EGRESS_GIT_HOSTS?: string;
  /** 补丁字节上限。可选,缺配/非法回落 1 MiB(见 base.ts DEFAULT_MAX_PATCH_BYTES)。 */
  MAX_PATCH_BYTES?: string;
  /**
   * writer 沙箱内 qwen-code 的 session turns 上限。可选,缺配/非法时随墙钟
   * 推导(≈8 turns/min,下限 40,见 control/budget.ts resolveBudget)。
   */
  DEFAULT_MAX_SESSION_TURNS?: string;
  /**
   * qwen 墙钟的平台安全上限(分钟)。可选,缺配/非法回落 25 —— workerd 挂起
   * 检测会在 ~29:48 杀掉单条 await 中的请求(M9 prod 实测),超过它拿到的是
   * 平台击杀而非 qwen 的干净退出。**只降 writer 能力,不改 DO alarm**;生效时
   * 往权威链落一条 budget.clamped 事件(§7.2.2)。
   */
  MAX_WRITER_WALL_MINUTES?: string;
  /**
   * 隐式 prompt 缓存命中相对 fresh input 的成本折扣(0 = 免费,1 = 同价),用于
   * attempts 台账的 cost_weighted_tokens。可选,缺配/非法回落 0.2 —— 这是横向
   * 比较用的估计值,qwen3.8-flash 的真实折扣以百炼控制台为准,不是账单口径。
   */
  CACHE_READ_COST_FACTOR?: string;
  /**
   * writer 侧 provider 错误的分流档位(§13.23):"off"(判据当不存在,逐字段等于本棒之前) |
   * "shadow"(照分类、落 route.infra_candidate 事件,路由动作一字不改) |
   * "enforce"(确定性 provider 错误不再派返工,直接 BLOCKED 转人工)。
   * 可选,缺省 shadow;非法值同样落 shadow。没有真实样本前不得写 enforce。
   */
  ROUTING_INFRA_MODE?: string;
  /**
   * Supervisor(独立消费者)的启用点:"off"(完全按历史行为跑) | "shadow"(读 journal
   * 判据、只往权威链记 supervisor_finding 事件、不做任何处置)。可选,**代码缺省 off** ——
   * 启用一律靠这里的 vars 显式写,这样「什么时候开始有 Supervisor 在看着」是可审计的。
   * 三类判据都是启发式,先攒样本再谈 enforce(与 M8/M9/C8 的 shadow 惯例同)。
   */
  SUPERVISOR_MODE?: string;
  /** shadow 模式下 alarm 的 tick 间隔(秒)。可选,缺省 60 —— 见 src/supervisor/detect.ts。 */
  SUPERVISOR_TICK_SECONDS?: string;

  /** Worker 侧高权 key:给 reviewer 用;也是沙箱 key 缺配时的回落值 */
  DASHSCOPE_API_KEY: string;
  /**
   * 沙箱专用低权 key:可单独撤销,泄露的爆炸半径止于一把 key。
   * 可选 —— 未配置时容器沿用 DASHSCOPE_API_KEY(= M8 前的共享受污染面状态)。
   */
  SANDBOX_MODEL_API_KEY?: string;
  WORKER_API_TOKEN: string;
}

export type ReviewEvidenceMode = "shadow" | "enforce";
export type BasePinMode = "shadow" | "enforce";

/** 执行面回报的基线事实:控制面据此落库、写 manifest、决定是否 fail-closed。 */
export interface BaseReport {
  sha: string | null;
  source: BaseSource;
  /** shadow 模式下 pinned 基线不可达、已回落默认分支时的人类可读原因 */
  fallback?: string;
}

export type TaskState =
  | "PENDING"
  | "RUNNING"
  | "VERIFYING"
  | "AWAITING_APPROVAL"
  | "DONE"
  | "REJECTED"
  | "BLOCKED";

export interface TaskSpec {
  prompt: string;
  /** 声明式验收标准。缺省时 reviewer 的意见纯 advisory,无权触发返工。 */
  acceptance?: string[];
  /**
   * 待改造仓库。**当前只支持公开 https 匿名克隆**;私有仓的接入点是
   * 执行面的 clone 步骤(短期安装 token 注入),不要在 spec 里放凭据。
   */
  repo_url?: string;
  /** 人工指定的冻结基线(全长度 hex commit)。缺省 = 执行时解析默认分支 HEAD 并固定。 */
  base_sha?: string;
  verify_command?: string;
  worker?: "qwen-code";
}

/**
 * attempt 角色的唯一权威清单。类型由这个常量元组派生,运行时的入参校验
 * (如 `GET /api/admin/attempts` 的 `?role=`)引用同一份声明 —— 加一个角色只需要
 * 改这里,不会出现「端点自己硬编码了另一份合法值」的漂移。
 */
export const ATTEMPT_ROLES = ["writer", "reviewer", "verifier"] as const;
export type AttemptRole = (typeof ATTEMPT_ROLES)[number];

export interface AttemptParams {
  task_id: string;
  attempt_id: string;
  role: AttemptRole;
  spec: TaskSpec;
  spec_digest: string;
  model: string;
  /** TaskSession DO 的实例 id(fetch 环境解析出的权威实例,跨环境经 idFromString 精确路由) */
  session_id: string;
  /** verifier 专用:writer 的 evidence manifest(含候选 patch)在 R2 的 key */
  verify_context?: { writer_manifest_key: string };
  /** 返工时带走的修复指令(上一轮硬门禁失败证据或成立的 reject),拼进 writer prompt */
  instructions?: string[];
  /**
   * 已冻结的基线 commit(小写全长度 hex)。writer 与 verifier 必须在工作副本
   * 上材质化到同一个值 —— 跨轮 patch_digest 比较与候选可重放性都以此为前提。
   */
  base_pin?: string | null;
  /** writer 墙钟预算(秒)。执行面据此推导 qwen --max-wall-time,缺省回落环境默认。 */
  max_wall_seconds?: number;
}

export class AuthorityConflict extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "AuthorityConflict";
  }
}

/** 入口校验失败的人工指定基线:它是会被重进沙箱执行的字符串,绝不入库。 */
export class InvalidBaseSha extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "InvalidBaseSha";
  }
}
