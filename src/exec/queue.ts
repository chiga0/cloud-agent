import type { Env, TaskSpec } from "../types";
import { TaskSession } from "../control/session";

interface ReviewMessage {
  schema_version: 1;
  type: "review-request";
  task_id: string;
  session_id: string;
  spec: TaskSpec;
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
  transcript_digest?: string | null;
  manifest_key?: string | null;
  manifest_digest?: string | null;
  tokens?: number;
  result_text?: string | null;
  review?: { decision: "approve" | "reject"; reason: string };
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
  batch: MessageBatch<ReviewMessage | ReportMessage>,
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
          max_wall_seconds: Number(env.DEFAULT_MAX_WALL_SECONDS),
        });
        msg.ack();
        continue;
      }
      if (body?.type === "exec-report") {
        const session = env.TASK_SESSION.get(env.TASK_SESSION.idFromString(body.session_id));
        await session.reportExecution({
          attempt_id: body.attempt_id,
          exit_code: body.exit_code,
          error: body.error,
          transcript_digest: body.transcript_digest ?? null,
          manifest_key: body.manifest_key ?? null,
          manifest_digest: body.manifest_digest ?? null,
          tokens: body.tokens ?? 0,
          result_text: body.result_text ?? null,
          review: body.review,
        });
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
