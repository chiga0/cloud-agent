import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { AttemptParams, Env } from "../types";
import type { ReportMessage } from "./queue";
import { writeManifest, type EvidenceManifest } from "../audit/evidence";
import { runQwenCodeAttempt, type SandboxRunResult } from "./sandbox";
import { runReviewLLM } from "./review";
import {
  extractResultFromTranscript,
  extractReviewDecision,
  extractTokensFromTranscript,
} from "./extract";

type ExecResult = SandboxRunResult | Awaited<ReturnType<typeof runReviewLLM>>;

/**
 * 一次 Attempt 的 durable 执行编排。权威全部在 TaskSession DO:
 * 本 workflow 只负责执行 → 提取 → 证据落 R2 → 经 REPORT_QUEUE
 * 异步回报,不做任何状态转换。writer 额外等待 approval event(人工或
 * reviewer 裁决);reviewer 裁决完即返回。崩溃恢复:step 重放,回报消息
 * 在 DO 侧幂等(attempt 非 RUNNING 即忽略)。
 *
 * 注意:workflow 环境里直接 RPC TaskSession DO 会解析到错误的 namespace
 * (idFromName 指向幽灵实例),回报必须走 queue consumer。
 */
export class AttemptWorkflow extends WorkflowEntrypoint<Env, AttemptParams> {
  async run(event: WorkflowEvent<AttemptParams>, step: WorkflowStep) {
    const p = event.payload;

    try {
      const runResult: ExecResult = await step.do(
        "exec",
        { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" } },
        async () => {
          if (p.role === "writer" || p.role === "verifier") {
            return runQwenCodeAttempt(this.env, {
              attemptId: p.attempt_id,
              prompt: p.spec.prompt,
              model: p.model,
              repoUrl: p.spec.repo_url,
              verifyCommand: p.spec.verify_command,
            });
          }
          return runReviewLLM(this.env, {
            attemptId: p.attempt_id,
            prompt: p.spec.prompt,
            model: p.model,
          });
        },
      );

      const extracted = await step.do("extract", async () => {
        if (p.role === "reviewer") {
          const text = runResult.transcriptRaw;
          return {
            text,
            tokens: "tokens" in runResult ? runResult.tokens : 0,
            review: extractReviewDecision(text),
          };
        }
        return {
          text: extractResultFromTranscript(runResult.transcriptRaw),
          tokens: extractTokensFromTranscript(runResult.transcriptRaw),
          review: undefined,
        };
      });

      const manifestRef = await step.do("evidence", async () => {
        const manifest: EvidenceManifest = {
          schema_version: 1,
          task_id: p.task_id,
          attempt_id: p.attempt_id,
          role: p.role,
          produced_at: new Date().toISOString(),
          spec_digest: p.spec_digest ?? "",
          model: p.model,
          transcript: runResult.transcript,
          artifacts: [runResult.stderr],
          verify: "verify" in runResult ? runResult.verify : undefined,
        };
        return writeManifest(this.env.EVIDENCE, manifest);
      });

      const report: ReportMessage = {
        schema_version: 1,
        type: "exec-report",
        task_id: p.task_id,
        session_id: p.session_id,
        attempt_id: p.attempt_id,
        exit_code: runResult.exitCode,
        transcript_digest: runResult.transcript.digest,
        manifest_key: manifestRef.key,
        manifest_digest: manifestRef.digest,
        tokens: extracted.tokens,
        result_text: p.role === "writer" ? (extracted.text ?? "").slice(0, 32_000) : null,
        review: extracted.review,
      };
      await step.do(
        "report",
        { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" } },
        async () => {
          await this.env.REPORT_QUEUE.send(report);
        },
      );

      if (p.role === "writer") {
        await step.waitForEvent("human-approval", {
          type: "approval",
          timeout: "24 hours",
        });
      }

      return { status: "done", manifest: manifestRef };
    } catch (err) {
      await step
        .do("report-blocked", async () => {
          await this.env.REPORT_QUEUE.send({
            schema_version: 1,
            type: "exec-report",
            task_id: p.task_id,
            session_id: p.session_id,
            attempt_id: p.attempt_id,
            exit_code: -1,
            error: String(err).slice(0, 500),
          } satisfies ReportMessage);
        })
        .catch(() => {});
      throw err;
    }
  }
}
