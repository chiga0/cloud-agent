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
  /** writer 沙箱内 qwen-code 的 session turns 上限。可选,缺配/非法回落 40(见 sandbox.ts)。 */
  DEFAULT_MAX_SESSION_TURNS?: string;

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

export interface AttemptParams {
  task_id: string;
  attempt_id: string;
  role: "writer" | "reviewer" | "verifier";
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
