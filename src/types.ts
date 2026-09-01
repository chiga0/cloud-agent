import type { WorkflowEntrypoint } from "cloudflare:workers";

import type { Sandbox as SandboxDO } from "@cloudflare/sandbox";
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

  DASHSCOPE_API_KEY: string;
  WORKER_API_TOKEN: string;
}

export type ReviewEvidenceMode = "shadow" | "enforce";

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
  repo_url?: string;
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
}

export class AuthorityConflict extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "AuthorityConflict";
  }
}
