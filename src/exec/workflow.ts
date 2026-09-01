import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { getSandbox } from "@cloudflare/sandbox";
import type { AttemptParams, BaseReport, Env } from "../types";
import type { ArtifactRef } from "../audit/evidence";
import type { ReportMessage } from "./queue";
import { writeManifest, type EvidenceManifest } from "../audit/evidence";
import { collectQwenAttempt, prepareQwenAttempt, qwenDeadlineSeconds } from "./sandbox";
import { collectVerifyAttempt, prepareVerifyAttempt } from "./verify";
import { runReviewLLM } from "./review";
import { composeAttemptPrompt } from "./prompt";
import { parseReviewVerdict, extractResultFromTranscript, extractTokensFromTranscript } from "./extract";
import type { ReviewVerdict } from "../control/gates";
import {
  isLongRunTerminal,
  killLongRun,
  launchOrReattach,
  pollLongRun,
  type ProcessSnapshot,
} from "./longrun";

interface ExecOutcome {
  exitCode: number;
  transcript: ArtifactRef;
  stderr: ArtifactRef;
  patch?: ArtifactRef;
  /** repo 任务:本次执行实际所基于的精确 commit(writer 与 verifier 必须同值) */
  base?: BaseReport;
  /** reviewer 专用:模型正文(受 max_tokens 约束,体积小,可直接进步骤返回值) */
  reviewText?: string;
  tokens?: number;
}

function slim(r: {
  exitCode: number;
  transcript: ArtifactRef;
  stderr: ArtifactRef;
  patch?: ArtifactRef;
  base?: BaseReport;
}): ExecOutcome {
  return { exitCode: r.exitCode, transcript: r.transcript, stderr: r.stderr, patch: r.patch, base: r.base };
}

const EXEC_RETRIES = { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" } } as const;
const POLL_RETRIES = { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" } } as const;
/** 轮询周期。30s:25min 墙钟 ≈ 50 轮 ×2 step,远在 Workflows step 数上限内 */
const POLL_INTERVAL = "30 seconds";

/** prepare step 的 checkpoint 返回值(必须显式标注:Serializable 推断会塌成 unknown) */
type PrepOutcome =
  | {
      kind: "verify";
      early?: ExecOutcome;
      base: BaseReport;
      apply: { exit_code: number; stderr_tail: string };
      launched: boolean;
    }
  | { kind: "writer"; early?: ExecOutcome; base?: BaseReport };

interface LaunchOutcome {
  snapshot: ProcessSnapshot;
  reattached: boolean;
  deadlineMs: number;
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
      let run: ExecOutcome;
      /** 到期击杀/进程记录消失的容量事实:随回报带上,DO 侧 exit<0 → BLOCKED 转人工 */
      let execError: string | undefined;

      if (p.role === "reviewer") {
        run = await step.do(
          "exec",
          EXEC_RETRIES,
          async () => {
            try {
              const r = await runReviewLLM(this.env, {
                attemptId: p.attempt_id,
                prompt: p.spec.prompt,
                model: p.model,
              });
              return { ...slim(r), reviewText: r.transcriptRaw, tokens: r.tokens };
            } catch (err) {
              console.warn(
                `exec_step_failed task=${p.task_id} attempt=${p.attempt_id} role=${p.role} ` +
                  `err=${String(err).slice(0, 500)}`,
              );
              throw err;
            }
          },
        );
      } else {
        // Fix C(M9.5①):长命令不再放进单个 step 里阻塞 await——那是 isolate
        // 驱逐 → run 重调 → 孤儿进程的温床(r6/r7/r8)。拆成:
        // prepare(短操作) → launch(后台启动,幂等重连) → 轮询(sleep+短 RPC,
        // 逐个落 checkpoint) → collect(回收产物)。驱逐只会让轮询从最近的
        // checkpoint 恢复,launch 永不重放。
        const prep = await step.do("prepare", EXEC_RETRIES, async (): Promise<PrepOutcome> => {
          try {
            if (p.role === "verifier") {
              if (!p.verify_context?.writer_manifest_key) {
                throw new Error("verifier attempt missing verify_context.writer_manifest_key");
              }
              const v = await prepareVerifyAttempt(this.env, {
                attemptId: p.attempt_id,
                taskId: p.task_id,
                spec: p.spec,
                writerManifestKey: p.verify_context.writer_manifest_key,
              });
              return { kind: "verify" as const, ...v };
            }
            const w = await prepareQwenAttempt(this.env, {
              attemptId: p.attempt_id,
              prompt: composeAttemptPrompt(p.spec, p.instructions, p.base_pin),
              model: p.model,
              repoUrl: p.spec.repo_url,
              basePin: p.base_pin ?? null,
              maxWallSeconds: p.max_wall_seconds,
            });
            return { kind: "writer" as const, ...w };
          } catch (err) {
            console.warn(
              `exec_step_failed stage=prepare task=${p.task_id} attempt=${p.attempt_id} ` +
                `role=${p.role} err=${String(err).slice(0, 500)}`,
            );
            throw err;
          }
        });

        if (prep.early) {
          run = slim(prep.early);
        } else if (prep.kind === "verify" && !prep.launched) {
          // apply 失败(候选不可重放)或没有 verify_command:不起长进程,直接组报告
          run = slim(
            await step.do("collect", EXEC_RETRIES, async () =>
              collectVerifyAttempt(
                this.env,
                {
                  attemptId: p.attempt_id,
                  taskId: p.task_id,
                  writerManifestKey: p.verify_context!.writer_manifest_key,
                },
                prep,
                null,
              ),
            ),
          );
        } else {
          const launch = await step.do("launch", EXEC_RETRIES, async (): Promise<LaunchOutcome> => {
            try {
              const out = await launchOrReattach(getSandbox(this.env.Sandbox, p.attempt_id));
              // verifier 没有内层墙钟,到期线 = 任务预算 - 120s(赶在 DO alarm 前回报);
              // writer 由 qwenDeadlineSeconds 与 qwen 自身 --max-wall-time 对齐。
              const deadlineS =
                prep.kind === "writer"
                  ? qwenDeadlineSeconds(p.max_wall_seconds, this.env)
                  : Math.max(60, (p.max_wall_seconds ?? 3600) - 120);
              const startedAtMs = out.snapshot.startedAtMs ?? Date.now();
              return {
                snapshot: out.snapshot,
                reattached: out.reattached,
                deadlineMs: startedAtMs + deadlineS * 1000,
              };
            } catch (err) {
              console.warn(
                `exec_step_failed stage=launch task=${p.task_id} attempt=${p.attempt_id} ` +
                  `role=${p.role} err=${String(err).slice(0, 500)}`,
              );
              throw err;
            }
          });

          let final: ProcessSnapshot = launch.snapshot;
          let i = 0;
          while (!isLongRunTerminal(final)) {
            if (Date.now() > launch.deadlineMs) {
              await step.do(
                "kill-longrun",
                { retries: { limit: 1, delay: "5 seconds" } },
                async () => {
                  await killLongRun(getSandbox(this.env.Sandbox, p.attempt_id));
                },
              );
              execError =
                `longrun_wall_exceeded role=${p.role} attempt=${p.attempt_id} ` +
                `deadline_ms=${launch.deadlineMs} reattached=${launch.reattached}`;
              final = { status: "killed", exitCode: -1, startedAtMs: null };
              break;
            }
            await step.sleep(`wait-${i}`, POLL_INTERVAL);
            final = await step.do(`poll-${i}`, POLL_RETRIES, async (): Promise<ProcessSnapshot> =>
              pollLongRun(getSandbox(this.env.Sandbox, p.attempt_id)),
            );
            i++;
          }
          if (final.status === "missing" && !execError) {
            execError = `longrun_process_vanished role=${p.role} attempt=${p.attempt_id}`;
          }

          run = await step.do("collect", EXEC_RETRIES, async () => {
            try {
              if (prep.kind === "writer") {
                return slim(
                  await collectQwenAttempt(
                    this.env,
                    {
                      attemptId: p.attempt_id,
                      repoUrl: p.spec.repo_url,
                      exportPatch: Boolean(p.spec.repo_url),
                      base: prep.base,
                    },
                    { exitCode: final.exitCode },
                  ),
                );
              }
              return slim(
                await collectVerifyAttempt(
                  this.env,
                  {
                    attemptId: p.attempt_id,
                    taskId: p.task_id,
                    writerManifestKey: p.verify_context!.writer_manifest_key,
                  },
                  prep,
                  { exitCode: final.exitCode },
                ),
              );
            } catch (err) {
              console.warn(
                `exec_step_failed stage=collect task=${p.task_id} attempt=${p.attempt_id} ` +
                  `role=${p.role} err=${String(err).slice(0, 500)}`,
              );
              throw err;
            }
          });
        }
      }

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
          schema_version: 2,
          task_id: p.task_id,
          attempt_id: p.attempt_id,
          role: p.role,
          produced_at: new Date().toISOString(),
          spec_digest: p.spec_digest ?? "",
          model: p.model,
          transcript: run.transcript,
          artifacts: [run.stderr],
          patch: run.patch,
          base: run.base?.sha ? { sha: run.base.sha, source: run.base.source } : undefined,
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
        error: execError,
        transcript_digest: run.transcript.digest,
        manifest_key: manifestRef.key,
        manifest_digest: manifestRef.digest,
        tokens: extracted.tokens,
        patch_digest: run.patch?.digest ?? null,
        base: run.base ?? null,
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
