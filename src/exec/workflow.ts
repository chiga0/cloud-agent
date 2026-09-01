import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { AttemptParams, Env } from "../types";
import type { ArtifactRef } from "../audit/evidence";
import type { ReportMessage } from "./queue";
import { writeManifest, type EvidenceManifest } from "../audit/evidence";
import { runQwenCodeAttempt } from "./sandbox";
import { runVerifyAttempt } from "./verify";
import { runReviewLLM } from "./review";
import { composeAttemptPrompt } from "./prompt";
import { parseReviewVerdict, extractResultFromTranscript, extractTokensFromTranscript } from "./extract";
import type { ReviewVerdict } from "../control/gates";

interface ExecOutcome {
  exitCode: number;
  transcript: ArtifactRef;
  stderr: ArtifactRef;
  patch?: ArtifactRef;
  /** reviewer 专用:模型正文(受 max_tokens 约束,体积小,可直接进步骤返回值) */
  reviewText?: string;
  tokens?: number;
}

function slim(r: {
  exitCode: number;
  transcript: ArtifactRef;
  stderr: ArtifactRef;
  patch?: ArtifactRef;
}): ExecOutcome {
  return { exitCode: r.exitCode, transcript: r.transcript, stderr: r.stderr, patch: r.patch };
}

/**
 * 一次 Attempt 的 durable 执行编排。权威全部在 TaskSession DO:
 * 本 workflow 只负责执行 → 提取 → 证据落 R2 → 经 REPORT_QUEUE
 * 异步回报,不做任何状态转换。writer 额外等待 approval event(人工或
 * reviewer 裁决);reviewer 裁决完即返回。崩溃恢复:step 重放,回报消息
 * 在 DO 侧幂等(attempt 非 RUNNING 即忽略)。
 *
 * 步骤返回值一律不含 transcript 原文:Workflows 单步返回值上限 1MiB,
 * 大 transcript 必须留在 R2,由 extract 步骤按 ref 读取。
 *
 * 注意:workflow 环境里直接 RPC TaskSession DO 会解析到错误的 namespace
 * (idFromName 指向幽灵实例),回报必须走 queue consumer。
 */
export class AttemptWorkflow extends WorkflowEntrypoint<Env, AttemptParams> {
  async run(event: WorkflowEvent<AttemptParams>, step: WorkflowStep) {
    const p = event.payload;

    try {
      const run: ExecOutcome = await step.do(
        "exec",
        { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" } },
        async () => {
          if (p.role === "verifier") {
            if (!p.verify_context?.writer_manifest_key) {
              throw new Error("verifier attempt missing verify_context.writer_manifest_key");
            }
            return slim(
              await runVerifyAttempt(this.env, {
                attemptId: p.attempt_id,
                taskId: p.task_id,
                spec: p.spec,
                writerManifestKey: p.verify_context.writer_manifest_key,
              }),
            );
          }
          if (p.role === "writer") {
            return slim(
              await runQwenCodeAttempt(this.env, {
                attemptId: p.attempt_id,
                prompt: composeAttemptPrompt(p.spec, p.instructions),
                model: p.model,
                repoUrl: p.spec.repo_url,
                exportPatch: Boolean(p.spec.repo_url),
              }),
            );
          }
          const r = await runReviewLLM(this.env, {
            attemptId: p.attempt_id,
            prompt: p.spec.prompt,
            model: p.model,
          });
          return { ...slim(r), reviewText: r.transcriptRaw, tokens: r.tokens };
        },
      );

      const extracted: { text: string | null; tokens: number; review?: ReviewVerdict } = await step.do(
        "extract",
        async () => {
          if (p.role === "reviewer") {
            const text = run.reviewText ?? "";
            return { text, tokens: run.tokens ?? 0, review: parseReviewVerdict(text) };
          }
          const obj = await this.env.ARTIFACTS.get(run.transcript.key);
          const raw = obj ? await obj.text() : "";
          if (p.role === "verifier") {
            // transcript 已是结构化 JSON 报告,不做 NDJSON 提取
            return { text: raw, tokens: 0 };
          }
          return {
            text: extractResultFromTranscript(raw),
            tokens: extractTokensFromTranscript(raw),
          };
        },
      );

      const manifestRef = await step.do("evidence", async () => {
        const manifest: EvidenceManifest = {
          schema_version: 1,
          task_id: p.task_id,
          attempt_id: p.attempt_id,
          role: p.role,
          produced_at: new Date().toISOString(),
          spec_digest: p.spec_digest ?? "",
          model: p.model,
          transcript: run.transcript,
          artifacts: [run.stderr],
          patch: run.patch,
        };
        return writeManifest(this.env.EVIDENCE, manifest);
      });

      const report: ReportMessage = {
        schema_version: 1,
        type: "exec-report",
        task_id: p.task_id,
        session_id: p.session_id,
        attempt_id: p.attempt_id,
        exit_code: run.exitCode,
        transcript_digest: run.transcript.digest,
        manifest_key: manifestRef.key,
        manifest_digest: manifestRef.digest,
        tokens: extracted.tokens,
        patch_digest: run.patch?.digest ?? null,
        result_text:
          p.role === "writer" || p.role === "verifier"
            ? (extracted.text ?? "").slice(0, 32_000)
            : null,
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
