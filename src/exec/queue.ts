import type { BaseReport, Env, TaskSpec } from "../types";
import type { ReviewVerdict } from "../control/gates";
import { resolveBudget } from "../control/budget";
import type { TranscriptUsage } from "./extract";
import type { ErrorClass } from "../routing/error-class";
import { TaskSession } from "../control/session";

interface ReviewMessage {
  schema_version: 1;
  type: "review-request";
  task_id: string;
  session_id: string;
  spec: TaskSpec;
  idempotency_key: string;
}

/** 验证器的基线只从 writer manifest 读;消息里刻意不带 SHA,避免第二个口径。 */
interface VerifyMessage {
  schema_version: 1;
  type: "verify-request";
  task_id: string;
  session_id: string;
  spec: TaskSpec;
  writer_manifest_key: string;
  idempotency_key: string;
}

export interface ReportMessage {
  schema_version: 1;
  type: "exec-report";
  task_id: string;
  session_id: string;
  attempt_id: string;
  exit_code: number;
  error?: string;
  /**
   * 执行面按形状判出的失败成因(§13.23,枚举;词表见 `src/routing/error-class.ts`)。
   * 刻意与 `error` 分开:`error` 是自由文本(只进日志/产物),这条只允许枚举 ——
   * 它会随 `review.unavailable` 进权威事件链。
   */
  error_class?: ErrorClass | null;
  transcript_digest?: string | null;
  manifest_key?: string | null;
  manifest_digest?: string | null;
  tokens?: number;
  /**
   * 用量四元组拆分(input/cache_read/output/total)。`tokens` 是 raw total 口径,
   * 两者都要:total 保持历史可比,拆分才能算成本 —— 96.9% 缓存命中的 total 与
   * 全 fresh 的同号 total 钱差一个数量级(见 docs/architecture.md)。
   */
  usage?: TranscriptUsage | null;
  result_text?: string | null;
  /** writer 导出的候选 patch 摘要(非 repo 任务为空),无进展熔断的比较基准 */
  patch_digest?: string | null;
  /** 本次执行实际所基于的精确 commit(基线冻结的落库来源) */
  base?: BaseReport | null;
  review?: ReviewVerdict;
}

/**
 * exec-report 消息 → reportExecution 入参。逐字段列举意味着漏一行就静默变
 * null(证据就是这么丢的),所以单独成函数、由单测钉住字段齐备。
 */
export function reportArgsFrom(body: ReportMessage): Parameters<TaskSession["reportExecution"]>[0] {
  return {
    attempt_id: body.attempt_id,
    exit_code: body.exit_code,
    error: body.error,
    error_class: body.error_class ?? null,
    transcript_digest: body.transcript_digest ?? null,
    manifest_key: body.manifest_key ?? null,
    manifest_digest: body.manifest_digest ?? null,
    tokens: body.tokens ?? 0,
    usage: body.usage ?? null,
    result_text: body.result_text ?? null,
    patch_digest: body.patch_digest ?? null,
    base: body.base ?? null,
    review: body.review,
  };
}

/**
 * Queue consumer:review fan-out 与 workflow 执行回报的统一入口。
 *
 * 不能用 name-based idFromName 定位 TaskSession——workflow/queue 运行环境
 * 的 DO 绑定与 fetch 环境解析到不同的 namespace,name-based id 会指向幽灵
 * 实例。消息里携带 DO 在自身环境生成的权威实例 id(session_id),
 * consumer 用 idFromString 精确路由(DO id 全局唯一,与 namespace 无关)。
 * 两个路径都靠 DO 侧幂等收敛(idempotency_key 查重 / attempt 非 RUNNING
 * 即忽略),重试安全。
 */
export async function handleQueue(
  batch: MessageBatch<ReviewMessage | VerifyMessage | ReportMessage>,
  env: Env,
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      const body = msg.body;
      if (body?.type === "review-request") {
        const session = env.TASK_SESSION.get(env.TASK_SESSION.idFromString(body.session_id));
        await session.startAttempt({
          role: "reviewer",
          idempotency_key: body.idempotency_key,
          spec: body.spec,
          max_model_tokens: Number(env.DEFAULT_MAX_MODEL_TOKENS),
          max_wall_seconds: resolveBudget(undefined, env).budgetSeconds,
        });
        msg.ack();
        continue;
      }
      if (body?.type === "verify-request") {
        const session = env.TASK_SESSION.get(env.TASK_SESSION.idFromString(body.session_id));
        await session.startAttempt({
          role: "verifier",
          idempotency_key: body.idempotency_key,
          spec: body.spec,
          verify_context: { writer_manifest_key: body.writer_manifest_key },
          max_model_tokens: Number(env.DEFAULT_MAX_MODEL_TOKENS),
          max_wall_seconds: resolveBudget(undefined, env).budgetSeconds,
        });
        msg.ack();
        continue;
      }
      if (body?.type === "exec-report") {
        const session = env.TASK_SESSION.get(env.TASK_SESSION.idFromString(body.session_id));
        await session.reportExecution(reportArgsFrom(body));
        // reportExecution 幂等且自身不抛错;只有 DO 不可达等异常才 retry
        msg.ack();
        continue;
      }
      msg.ack();
    } catch (err) {
      if (String(err).includes("task not found")) {
        msg.ack();
      } else {
        msg.retry();
      }
    }
  }
}
