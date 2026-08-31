import { DurableObject } from "cloudflare:workers";
import type { AttemptParams, Env, TaskSpec, TaskState } from "../types";
import { compositeEvidenceDigest, sha256Hex, type EvidenceManifest, type EvidencePart } from "../audit/evidence";
import { assertTransition, decideRework } from "./statemachine";

/**
 * 每任务一个 TaskSession DO:任务状态机、事件 hash chain、决策、重试策略的
 * 唯一权威。D1 只承担终态归档(查询/报表),运行中的一切状态只存在于 DO storage。
 *
 * 并发模型:DO 的 RPC 在同一 isolate 内可并发执行(输入门不保护 RPC),
 * `loadAll → await → saveAll` 会在 await 边界交错。所有会写状态的 RPC
 * 用 `blockConcurrencyWhile` 包住整个临界区,保证串行;事件链由单写者
 * 顺序追加,不分叉。Workflow 重放导致的重复 RPC 靠幂等约定收敛
 * (attempt 非 RUNNING 即忽略;idempotency_key 查重)。
 * 状态转换一律经状态机转换表校验,非法转换抛 AuthorityConflict。
 */

interface TaskRecord {
  id: string;
  spec: string;
  spec_digest: string;
  state: TaskState;
  version: number;
  result_text: string | null;
  created_at: string;
  updated_at: string;
  next_seq: number;
  archived: boolean;
  pending_review: boolean;
  pending_verify: boolean;
}

interface AttemptRecord {
  id: string;
  role: "writer" | "reviewer" | "verifier";
  state: "RUNNING" | "SUCCEEDED" | "FAILED" | "BLOCKED";
  idempotency_key: string;
  tokens_used: number;
  max_model_tokens: number;
  max_wall_seconds: number;
  workflow_instance_id: string | null;
  created_at: string;
  finished_at: string | null;
  manifest_key: string | null;
  manifest_digest: string | null;
  review: { decision: "approve" | "reject"; reason: string } | null;
}

interface DecisionRecord {
  id: string;
  attempt_id: string | null;
  actor: string;
  decision: string;
  evidence_digest: string;
  fencing_token: number;
  created_at: string;
}

interface EventRecord {
  seq: number;
  kind: string;
  payload: unknown;
  canonical: string;
  digest: string;
  prev_digest: string | null;
  created_at: string;
}

interface SessionData {
  task: TaskRecord | null;
  attempts: AttemptRecord[];
  decisions: DecisionRecord[];
  events: EventRecord[];
}

const EVENTS_PER_SHARD = 100;

export class TaskSession extends DurableObject<Env> {
  /** 以 taskId 作为 name-based DO id 取 stub(同 task 恒映射同一实例)。 */
  static from(env: Env, taskId: string) {
    return env.TASK_SESSION.get(env.TASK_SESSION.idFromName(taskId));
  }

  private now(): string {
    return new Date().toISOString();
  }

  private async loadAll(): Promise<SessionData> {
    const task = (await this.ctx.storage.get<TaskRecord>("task")) ?? null;
    const attempts = (await this.ctx.storage.get<AttemptRecord[]>("attempts")) ?? [];
    const decisions = (await this.ctx.storage.get<DecisionRecord[]>("decisions")) ?? [];
    const events: EventRecord[] = [];
    const arc = (await this.ctx.storage.get<string[]>("events:arc")) ?? [];
    for (let i = 0; i < arc.length; i++) {
      const shard = await this.ctx.storage.get<EventRecord[]>(arc[i]);
      if (shard) events.push(...shard);
    }
    const cur = (await this.ctx.storage.get<EventRecord[]>("events:cur")) ?? [];
    events.push(...cur);
    events.sort((a, b) => a.seq - b.seq);
    return { task, attempts, decisions, events };
  }

  private async saveAll(s: SessionData): Promise<void> {
    if (!s.task) return;
    await this.ctx.storage.put("task", s.task);
    await this.ctx.storage.put("attempts", s.attempts);
    await this.ctx.storage.put("decisions", s.decisions);
  }

  /** 追加事件到 hash chain。单写者串行执行,链不会分叉。 */
  private async appendEvent(s: SessionData, kind: string, payload: unknown): Promise<void> {
    const taskId = s.task!.id;
    const canonical = JSON.stringify({ task_id: taskId, kind, payload });
    const seq = s.task!.next_seq++;
    const prev = s.events.length > 0 ? s.events[s.events.length - 1].digest : null;
    const digest = await sha256Hex((prev ?? "GENESIS") + canonical);
    const record: EventRecord = {
      seq,
      kind,
      payload,
      canonical,
      digest,
      prev_digest: prev,
      created_at: this.now(),
    };
    s.events.push(record);

    let cur = (await this.ctx.storage.get<EventRecord[]>("events:cur")) ?? [];
    cur.push(record);
    if (cur.length >= EVENTS_PER_SHARD) {
      const arc = (await this.ctx.storage.get<string[]>("events:arc")) ?? [];
      const key = `evt:${arc.length}`;
      await this.ctx.storage.put(key, cur);
      arc.push(key);
      await this.ctx.storage.put("events:arc", arc);
      cur = [];
    }
    await this.ctx.storage.put("events:cur", cur);
  }

  private setState(s: SessionData, to: TaskState): void {
    assertTransition(s.task!.state, to);
    s.task!.state = to;
    s.task!.version += 1;
    s.task!.updated_at = this.now();
  }

  // ---- RPC: 任务创建 ----

  async createTask(spec: unknown, taskId: string): Promise<{ task_id: string; spec_digest: string }> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const s = await this.loadAll();
      if (s.task) return { task_id: s.task.id, spec_digest: s.task.spec_digest };
      const canonical = JSON.stringify(spec);
      const specDigest = await sha256Hex(canonical);
      const now = this.now();
      s.task = {
        id: taskId,
        spec: canonical,
        spec_digest: specDigest,
        state: "PENDING",
        version: 1,
        result_text: null,
        created_at: now,
        updated_at: now,
        next_seq: 1,
        archived: false,
        pending_review: false,
        pending_verify: false,
      };
      await this.appendEvent(s, "task.created", { spec_digest: specDigest });
      await this.saveAll(s);
      return { task_id: s.task.id, spec_digest: specDigest };
    });
  }

  // ---- RPC: 启动 attempt(幂等:同 idempotency_key 只创建一个) ----

  async startAttempt(args: {
    role: "writer" | "reviewer" | "verifier";
    idempotency_key: string;
    max_model_tokens: number;
    max_wall_seconds: number;
    spec?: TaskSpec;
    verify_context?: { writer_manifest_key: string };
  }): Promise<{ attempt_id: string; workflow_instance_id: string | null }> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const s = await this.loadAll();
      if (!s.task) throw new Error("task not found");
      const result = await this.startAttemptInternal(s, args);
      await this.saveAll(s);
      return result;
    });
  }

  private async startAttemptInternal(
    s: SessionData,
    args: {
      role: "writer" | "reviewer" | "verifier";
      idempotency_key: string;
      max_model_tokens: number;
      max_wall_seconds: number;
      spec?: TaskSpec;
      verify_context?: { writer_manifest_key: string };
    },
  ): Promise<{ attempt_id: string; workflow_instance_id: string | null }> {
    const existing = s.attempts.find((a) => a.idempotency_key === args.idempotency_key);
    if (existing) return { attempt_id: existing.id, workflow_instance_id: existing.workflow_instance_id };

    const id = crypto.randomUUID();
    const record: AttemptRecord = {
      id,
      role: args.role,
      state: "RUNNING",
      idempotency_key: args.idempotency_key,
      tokens_used: 0,
      max_model_tokens: args.max_model_tokens,
      max_wall_seconds: args.max_wall_seconds,
      workflow_instance_id: null,
      created_at: this.now(),
      finished_at: null,
      manifest_key: null,
      manifest_digest: null,
      review: null,
    };
    s.attempts.push(record);
    await this.appendEvent(s, "attempt.created", {
      attempt_id: id,
      role: args.role,
      idempotency_key: args.idempotency_key,
    });

    if (
      args.role === "writer" &&
      (s.task!.state === "PENDING" || s.task!.state === "AWAITING_APPROVAL" || s.task!.state === "VERIFYING")
    ) {
      this.setState(s, "RUNNING");
      await this.appendEvent(s, "task.transition", {
        to: "RUNNING",
        actor: `agent:${id}`,
        reason: `attempt claimed (${args.role})`,
      });
    }

    const spec = args.spec ?? (JSON.parse(s.task!.spec) as TaskSpec);
    const params: AttemptParams = {
      task_id: s.task!.id,
      attempt_id: id,
      role: args.role,
      spec,
      spec_digest: s.task!.spec_digest,
      model: this.env.DEFAULT_MODEL,
      session_id: this.ctx.id.toString(),
      verify_context: args.verify_context,
    };
    const instance = await this.env.ATTEMPT_WORKFLOW.create({ id, params });
    record.workflow_instance_id = instance.id;

    await this.ctx.storage.setAlarm(Date.now() + (args.max_wall_seconds + 300) * 1000);
    return { attempt_id: id, workflow_instance_id: instance.id };
  }

  // ---- RPC: workflow 回报执行结果(幂等:attempt 非 RUNNING 即忽略) ----

  async reportExecution(args: {
    attempt_id: string;
    exit_code: number;
    error?: string;
    transcript_digest?: string | null;
    manifest_key?: string | null;
    manifest_digest?: string | null;
    tokens?: number;
    result_text?: string | null;
    review?: { decision: "approve" | "reject"; reason: string };
  }): Promise<{ ok: boolean; ignored?: boolean; error?: string }> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const s = await this.loadAll();
      if (!s.task) return { ok: false, error: "task not found" };
      if (s.task.state === "DONE" || s.task.state === "REJECTED") {
        return { ok: true, ignored: true };
      }
      const attempt = s.attempts.find((a) => a.id === args.attempt_id);
      if (!attempt) return { ok: false, error: "unknown_attempt" };
      if (attempt.state !== "RUNNING") return { ok: true, ignored: true };

      attempt.finished_at = this.now();
      attempt.tokens_used = args.tokens ?? 0;
      if (args.manifest_key) attempt.manifest_key = args.manifest_key;
      if (args.manifest_digest) attempt.manifest_digest = args.manifest_digest;

      if (args.exit_code < 0) {
        attempt.state = "BLOCKED";
        await this.appendEvent(s, "attempt.blocked", {
          attempt_id: args.attempt_id,
          error: args.error ?? "workflow error",
        });
        if (attempt.role === "writer") {
          this.setState(s, "BLOCKED");
          await this.appendEvent(s, "task.transition", {
            to: "BLOCKED",
            actor: "system:workflow",
            reason: args.error ?? "workflow error",
          });
          await this.archiveWithRetry(s);
        } else if (attempt.role === "verifier") {
          // 验证器基建错误按验证失败处理,进入 rework 闭环
          await this.onVerifyFailed(s, args.attempt_id, args.error ?? "verifier workflow error");
        }
        await this.saveAll(s);
        return { ok: true };
      }

      attempt.state = args.exit_code === 0 ? "SUCCEEDED" : "FAILED";
      await this.appendEvent(s, "attempt.exec_finished", {
        attempt_id: args.attempt_id,
        exit_code: args.exit_code,
        transcript_digest: args.transcript_digest ?? null,
      });
      await this.appendEvent(s, "result.captured", {
        attempt_id: args.attempt_id,
        has_text: args.result_text != null,
        length: args.result_text?.length ?? 0,
        total_tokens: args.tokens ?? 0,
      });
      await this.appendEvent(s, "evidence.manifest", {
        attempt_id: args.attempt_id,
        manifest_digest: args.manifest_digest ?? null,
        manifest_key: args.manifest_key ?? null,
      });

      if (attempt.role === "writer") {
        // 门禁:writer 失败不得进入审批流,只能 rework 或 BLOCKED
        if (args.exit_code !== 0) {
          await this.appendEvent(s, "writer.failed", {
            attempt_id: args.attempt_id,
            exit_code: args.exit_code,
          });
          await this.scheduleRework(s, {
            decider: `agent:${args.attempt_id}`,
            reason: `writer exit_code=${args.exit_code}`,
            eventKind: "writer.rework_scheduled",
            onExhausted: async () => {
              this.setState(s, "BLOCKED");
              await this.appendEvent(s, "task.transition", {
                to: "BLOCKED",
                actor: "system:control",
                reason: "writer attempts exhausted without success",
              });
              await this.archiveWithRetry(s);
            },
          });
          await this.saveAll(s);
          return { ok: true };
        }

        if (args.result_text != null) s.task!.result_text = args.result_text;
        const spec = JSON.parse(s.task!.spec) as TaskSpec;
        if (spec.repo_url && args.manifest_key) {
          // repo 任务:候选先经独立验证器重放验证,通过后才派 reviewer
          if (!s.task!.pending_verify) {
            s.task!.pending_verify = true;
            const writerIndex = s.attempts.filter((a) => a.role === "writer").length;
            const verifyKey = `${s.task!.id}:verify:${writerIndex}`;
            try {
              await this.env.REVIEW_QUEUE.send({
                schema_version: 1,
                type: "verify-request",
                task_id: s.task!.id,
                session_id: this.ctx.id.toString(),
                spec,
                writer_manifest_key: args.manifest_key,
                idempotency_key: verifyKey,
              });
              await this.appendEvent(s, "verify.requested", {
                attempt_id: args.attempt_id,
                idempotency_key: verifyKey,
              });
            } catch (err) {
              s.task!.pending_verify = false;
              await this.appendEvent(s, "verify.fanout_failed", {
                attempt_id: args.attempt_id,
                error: String(err).slice(0, 200),
              });
            }
          }
          if (s.task!.pending_verify) {
            this.setState(s, "VERIFYING");
            await this.appendEvent(s, "task.transition", {
              to: "VERIFYING",
              actor: `agent:${args.attempt_id}`,
              reason: "writer succeeded, dispatching verifier",
            });
          } else {
            await this.fanoutReview(s, args.attempt_id);
            this.setState(s, "AWAITING_APPROVAL");
            await this.appendEvent(s, "task.transition", {
              to: "AWAITING_APPROVAL",
              actor: `agent:${args.attempt_id}`,
              reason: "writer finished (verify fanout degraded)",
            });
          }
        } else {
          await this.fanoutReview(s, args.attempt_id);
          this.setState(s, "AWAITING_APPROVAL");
          await this.appendEvent(s, "task.transition", {
            to: "AWAITING_APPROVAL",
            actor: `agent:${args.attempt_id}`,
            reason: "writer finished",
          });
        }
      }

      if (attempt.role === "verifier") {
        if (args.exit_code === 0) {
          await this.appendEvent(s, "verify.completed", { attempt_id: args.attempt_id, passed: true });
          await this.fanoutReview(s, args.attempt_id, { passed: true, summary: args.result_text ?? "" });
          this.setState(s, "AWAITING_APPROVAL");
          await this.appendEvent(s, "task.transition", {
            to: "AWAITING_APPROVAL",
            actor: `agent:${args.attempt_id}`,
            reason: "verification passed",
          });
        } else {
          await this.appendEvent(s, "verify.completed", {
            attempt_id: args.attempt_id,
            passed: false,
            exit_code: args.exit_code,
          });
          await this.onVerifyFailed(s, args.attempt_id, `verify exit_code=${args.exit_code}`);
        }
      }

      if (attempt.role === "reviewer") {
        const review = args.review ?? { decision: "reject" as const, reason: "reviewer 未产出结论" };
        attempt.review = review;
        await this.appendEvent(s, "review.completed", {
          attempt_id: args.attempt_id,
          decision: review.decision,
          reason: review.reason,
        });
        const writer = this.latestWriter(s);
        if (review.decision === "approve") {
          const binding = writer
            ? await this.computeBindingDigest(s, writer, attempt)
            : attempt.manifest_digest ?? "";
          await this.finishApproval(s, {
            attemptId: args.attempt_id,
            actor: `agent:${args.attempt_id}`,
            decision: "approve",
            evidenceDigest: binding,
          });
        } else {
          await this.handleReviewReject(s, args.attempt_id, review.reason);
        }
      }

      await this.saveAll(s);
      return { ok: true };
    });
  }

  /** 独立验证失败(或验证器基建错误):走与审查否决相同的 rework 闭环,耗尽则终态。 */
  private async onVerifyFailed(s: SessionData, verifierAttemptId: string, reason: string): Promise<void> {
    await this.scheduleRework(s, {
      decider: `agent:${verifierAttemptId}`,
      reason,
      eventKind: "verify.rework_scheduled",
      onExhausted: async () => {
        const writer = this.latestWriter(s);
        const verifier = s.attempts.find((a) => a.id === verifierAttemptId);
        const binding = writer
          ? await this.computeBindingDigest(s, writer, verifier)
          : verifier?.manifest_digest ?? "";
        await this.finishApproval(s, {
          attemptId: verifierAttemptId,
          actor: `agent:${verifierAttemptId}`,
          decision: "reject",
          evidenceDigest: binding,
        });
      },
    });
  }

  /** writer 成功 / 验证通过后派 reviewer(幂等:pending_review)。 */
  private async fanoutReview(
    s: SessionData,
    triggerAttemptId: string,
    verify?: { passed: boolean; summary: string },
  ): Promise<void> {
    if (s.task!.pending_review) return;
    s.task!.pending_review = true;
    const writerIndex = s.attempts.filter((a) => a.role === "writer").length;
    const reviewKey = `${s.task!.id}:review:${writerIndex}`;
    const spec = await this.buildReviewSpec(s, s.task!.result_text ?? "", verify);
    try {
      await this.env.REVIEW_QUEUE.send({
        schema_version: 1,
        type: "review-request",
        task_id: s.task!.id,
        session_id: this.ctx.id.toString(),
        spec,
        idempotency_key: reviewKey,
      });
      await this.appendEvent(s, "review.requested", {
        attempt_id: triggerAttemptId,
        idempotency_key: reviewKey,
      });
    } catch (err) {
      await this.appendEvent(s, "review.fanout_failed", {
        attempt_id: triggerAttemptId,
        error: String(err).slice(0, 200),
      });
    }
  }

  private async buildReviewSpec(
    s: SessionData,
    writerResult: string,
    verify?: { passed: boolean; summary: string },
  ): Promise<TaskSpec> {
    const original = (JSON.parse(s.task!.spec) as TaskSpec).prompt;
    let material = `【原始任务】\n${original}\n\n【agent 产出】\n${writerResult.slice(0, 2000)}\n\n`;
    if (verify) {
      material +=
        `【独立验证结果(在干净沙箱重放候选变更并运行验证命令)】\n` +
        `${verify.passed ? "通过" : "失败"}\n${verify.summary.slice(0, 1000)}\n\n`;
      const patchExcerpt = await this.loadPatchExcerpt(s);
      if (patchExcerpt) material += `【候选变更(diff 摘录)】\n${patchExcerpt}\n\n`;
    }
    return {
      prompt:
        `你是 review agent。只审查,绝不执行任务:\n` +
        `- 禁止调用任何工具、禁止网络查询、禁止再次运行任务\n` +
        `- 只依据下方材料判断是否满足【原始任务】\n` +
        `- 有【独立验证结果】时,验证失败必须 reject;验证通过仍需核对产出是否切题\n\n` +
        material +
        `只输出一行 JSON,不要 markdown、不要解释:{"decision":"approve"|"reject","reason":"一句话理由"}`,
      worker: "qwen-code",
    };
  }

  /** 从 writer 最新 manifest 读取候选 patch 摘录,失败静默返回 null。 */
  private async loadPatchExcerpt(s: SessionData): Promise<string | null> {
    const writer = this.latestWriter(s);
    if (!writer?.manifest_key) return null;
    try {
      const obj = await this.env.EVIDENCE.get(writer.manifest_key);
      if (!obj) return null;
      const manifest = (await obj.json()) as EvidenceManifest;
      if (!manifest.patch) return null;
      const patch = await this.env.ARTIFACTS.get(manifest.patch.key);
      if (!patch) return null;
      return (await patch.text()).slice(0, 4000);
    } catch {
      return null;
    }
  }

  private latestWriter(s: SessionData): AttemptRecord | undefined {
    return s.attempts
      .filter((a) => a.role === "writer")
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .pop();
  }

  /**
   * 决策绑定的组合证据:因果链上的 [writer 候选, verifier 验证?, 裁决者?]。
   * 人工审批校验 [writer, verifier?] 组合;自动裁决附裁决者自身证据。
   */
  private async computeBindingDigest(s: SessionData, writer: AttemptRecord, decider?: AttemptRecord): Promise<string> {
    const parts: EvidencePart[] = [];
    if (writer.manifest_digest) {
      parts.push({ role: "writer", attempt_id: writer.id, digest: writer.manifest_digest });
    }
    const verifier = s.attempts
      .filter((a) => a.role === "verifier" && a.manifest_digest && a.created_at >= writer.created_at)
      .pop();
    if (verifier) {
      parts.push({ role: "verifier", attempt_id: verifier.id, digest: verifier.manifest_digest! });
    }
    if (decider && decider.role === "reviewer" && decider.manifest_digest) {
      parts.push({ role: "reviewer", attempt_id: decider.id, digest: decider.manifest_digest });
    }
    return compositeEvidenceDigest(parts);
  }

  /** 有限返工:预算内起下一个 writer;耗尽走 onExhausted(reviewer/verifier 否决→REJECTED,writer 失败→BLOCKED)。 */
  private async scheduleRework(
    s: SessionData,
    args: { decider: string; reason: string; eventKind: string; onExhausted: () => Promise<void> },
  ): Promise<void> {
    const writerAttempts = s.attempts.filter((a) => a.role === "writer");
    const maxAttempts = Number(this.env.DEFAULT_MAX_ATTEMPTS ?? "3");
    if (decideRework({ writerAttempts: writerAttempts.length, maxAttempts }).action === "exhausted") {
      await args.onExhausted();
      return;
    }
    await this.notifyWriter(s, "reject", args.decider);
    s.task!.pending_review = false;
    s.task!.pending_verify = false;
    await this.startAttemptInternal(s, {
      role: "writer",
      idempotency_key: `${s.task!.id}:attempt:${writerAttempts.length + 1}`,
      max_model_tokens: Number(this.env.DEFAULT_MAX_MODEL_TOKENS),
      max_wall_seconds: Number(this.env.DEFAULT_MAX_WALL_SECONDS),
    });
    await this.appendEvent(s, args.eventKind, {
      decider: args.decider,
      reason: args.reason.slice(0, 500),
      attempt_number: writerAttempts.length + 1,
    });
  }

  private async handleReviewReject(s: SessionData, reviewerAttemptId: string, reason: string): Promise<void> {
    await this.scheduleRework(s, {
      decider: `agent:${reviewerAttemptId}`,
      reason,
      eventKind: "review.retry_scheduled",
      onExhausted: async () => {
        const writer = this.latestWriter(s);
        const reviewer = s.attempts.find((a) => a.id === reviewerAttemptId);
        const binding = writer
          ? await this.computeBindingDigest(s, writer, reviewer)
          : reviewer?.manifest_digest ?? "";
        await this.finishApproval(s, {
          attemptId: reviewerAttemptId,
          actor: `agent:${reviewerAttemptId}`,
          decision: "reject",
          evidenceDigest: binding,
        });
      },
    });
  }

  // ---- RPC: 审批/决策(人工或 agent 裁决的统一入口) ----

  async submitDecision(args: {
    attempt_id?: string;
    evidence_digest?: string;
    decision: "approve" | "reject";
    actor: string;
  }): Promise<{ ok: boolean; error?: string; state?: TaskState }> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const s = await this.loadAll();
      if (!s.task) return { ok: false, error: "task not found" };
      if (!args.attempt_id || !args.evidence_digest) {
        return { ok: false, error: "evidence_required", state: s.task.state };
      }
      const attempt = s.attempts.find((a) => a.id === args.attempt_id);
      if (!attempt) return { ok: false, error: "unknown_attempt" };
      if (attempt.role !== "writer") return { ok: false, error: "attempt_not_writer" };
      if (!attempt.manifest_digest) return { ok: false, error: "evidence_missing", state: s.task.state };
      const binding = await this.computeBindingDigest(s, attempt);
      if (args.evidence_digest !== binding) return { ok: false, error: "evidence_mismatch" };
      if (s.task.state !== "AWAITING_APPROVAL") {
        return { ok: false, error: "task_not_awaiting", state: s.task.state };
      }
      await this.finishApproval(s, {
        attemptId: attempt.id,
        actor: args.actor,
        decision: args.decision,
        evidenceDigest: binding,
      });
      await this.saveAll(s);
      return { ok: true };
    });
  }

  /** 终态收敛:记录 decision → 状态转换 → 唤醒 writer → 清 alarm → 归档 D1。 */
  private async finishApproval(
    s: SessionData,
    args: { attemptId: string | null; actor: string; decision: "approve" | "reject"; evidenceDigest: string },
  ): Promise<void> {
    s.decisions.push({
      id: crypto.randomUUID(),
      attempt_id: args.attemptId,
      actor: args.actor,
      decision: args.decision,
      evidence_digest: args.evidenceDigest,
      fencing_token: s.task!.version,
      created_at: this.now(),
    });
    await this.appendEvent(s, "decision.recorded", {
      actor: args.actor,
      decision: args.decision,
      evidence_digest: args.evidenceDigest,
      fencing_token: s.task!.version,
    });
    this.setState(s, args.decision === "approve" ? "DONE" : "REJECTED");
    await this.appendEvent(s, "task.transition", {
      to: s.task!.state,
      actor: args.actor,
      reason: `${args.actor} decision: ${args.decision}`,
    });
    await this.notifyWriter(s, args.decision, args.actor);
    await this.ctx.storage.deleteAlarm();
    await this.archiveWithRetry(s);
  }

  /** 归档失败时挂 30s alarm 重试并抛出,让调用方感知失败(不静默丢终态)。 */
  private async archiveWithRetry(s: SessionData): Promise<void> {
    try {
      await this.archive(s);
    } catch (err) {
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
      throw new Error(`archive failed, will retry via alarm: ${String(err).slice(0, 200)}`);
    }
  }

  private async notifyWriter(s: SessionData, decision: string, actor: string): Promise<void> {
    const writers = s.attempts.filter((a) => a.role === "writer" && a.workflow_instance_id);
    if (writers.length === 0) return;
    const last = writers.sort((a, b) => a.created_at.localeCompare(b.created_at)).pop()!;
    try {
      const wf = await this.env.ATTEMPT_WORKFLOW.get(last.workflow_instance_id!);
      await wf.sendEvent({
        type: "approval",
        payload: { decision, actor, task_id: s.task!.id },
      });
    } catch {
      // workflow 已不存在时静默:人工兜底由归档状态可见
    }
  }

  // ---- RPC: 只读快照 ----

  async getSnapshot(): Promise<{
    task: TaskRecord;
    attempts: Array<Pick<AttemptRecord, "id" | "role" | "state" | "tokens_used" | "created_at" | "finished_at">>;
    events: Array<{ seq: number; kind: string; payload: string; digest: string; prev_digest: string | null; created_at: string }>;
  } | null> {
    const s = await this.loadAll();
    if (!s.task) return null;
    return {
      task: { ...s.task },
      attempts: s.attempts.map(({ id, role, state, tokens_used, created_at, finished_at }) => ({
        id,
        role,
        state,
        tokens_used,
        created_at,
        finished_at,
      })),
      events: s.events.map((e) => ({
        seq: e.seq,
        kind: e.kind,
        payload: JSON.stringify(e.payload),
        digest: e.digest,
        prev_digest: e.prev_digest,
        created_at: e.created_at,
      })),
    };
  }

  async getResultText(): Promise<{ found: boolean; result_text: string | null }> {
    const s = await this.loadAll();
    if (!s.task) return { found: false, result_text: null };
    return { found: true, result_text: s.task.result_text };
  }

  async getManifestKey(attemptId?: string): Promise<{
    found: boolean;
    key: string | null;
    digest: string | null;
    binding_digest: string | null;
  }> {
    const s = await this.loadAll();
    if (!s.task) return { found: false, key: null, digest: null, binding_digest: null };
    const candidates = s.attempts
      .filter((a) => a.manifest_key && (!attemptId || a.id === attemptId))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    const writer = this.latestWriter(s);
    return {
      found: true,
      key: candidates[0]?.manifest_key ?? null,
      digest: candidates[0]?.manifest_digest ?? null,
      binding_digest: writer ? await this.computeBindingDigest(s, writer) : null,
    };
  }

  // ---- 终态归档:D1 一次性写入(幂等,可重放重建) ----

  private async archive(s: SessionData): Promise<void> {
    if (s.task!.archived) return;
    const t = s.task!;
    const stmts: D1PreparedStatement[] = [];
    stmts.push(
      this.env.DB.prepare(
        "INSERT OR REPLACE INTO tasks (id, spec, spec_digest, state, version, result_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(t.id, t.spec, t.spec_digest, t.state, t.version, t.result_text, t.created_at, t.updated_at),
    );
    stmts.push(this.env.DB.prepare("DELETE FROM attempts WHERE task_id = ?").bind(t.id));
    for (const a of s.attempts) {
      stmts.push(
        this.env.DB.prepare(
          "INSERT INTO attempts (id, task_id, role, state, idempotency_key, proxy_token, tokens_used, max_model_tokens, max_wall_seconds, workflow_instance_id, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).bind(
          a.id,
          t.id,
          a.role,
          a.state,
          a.idempotency_key,
          null,
          a.tokens_used,
          a.max_model_tokens,
          a.max_wall_seconds,
          a.workflow_instance_id,
          a.created_at,
          a.finished_at,
        ),
      );
    }
    stmts.push(this.env.DB.prepare("DELETE FROM decisions WHERE task_id = ?").bind(t.id));
    for (const d of s.decisions) {
      stmts.push(
        this.env.DB.prepare(
          "INSERT INTO decisions (id, task_id, attempt_id, actor, decision, evidence_digest, fencing_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).bind(d.id, t.id, d.attempt_id, d.actor, d.decision, d.evidence_digest, d.fencing_token, d.created_at),
      );
    }
    stmts.push(this.env.DB.prepare("DELETE FROM events WHERE task_id = ?").bind(t.id));
    for (const e of s.events) {
      stmts.push(
        this.env.DB.prepare(
          "INSERT INTO events (id, task_id, kind, payload, digest, prev_digest, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).bind(crypto.randomUUID(), t.id, e.kind, e.canonical, e.digest, e.prev_digest, e.seq, e.created_at),
      );
    }
    await this.env.DB.batch(stmts);
    t.archived = true;
  }

  // ---- alarm:归档重试 + attempt 超时兜底 ----

  async alarm(): Promise<void> {
    const s = await this.loadAll();
    if (!s.task) return;

    if (
      !s.task.archived &&
      (s.task.state === "DONE" || s.task.state === "REJECTED" || s.task.state === "BLOCKED")
    ) {
      try {
        await this.archive(s);
      } catch {
        await this.ctx.storage.setAlarm(Date.now() + 30_000);
      }
      await this.saveAll(s);
      return;
    }

    const nowMs = Date.now();
    let changed = false;
    for (const a of s.attempts) {
      if (a.state === "RUNNING" && nowMs - Date.parse(a.created_at) > (a.max_wall_seconds + 300) * 1000) {
        a.state = "BLOCKED";
        a.finished_at = this.now();
        changed = true;
        await this.appendEvent(s, "attempt.blocked", {
          attempt_id: a.id,
          reason: "alarm: wall time exceeded",
        });
      }
    }
    if (changed) {
      const stillRunning = s.attempts.some((a) => a.state === "RUNNING");
      if (!stillRunning && (s.task.state === "RUNNING" || s.task.state === "VERIFYING" || s.task.state === "AWAITING_APPROVAL")) {
        this.setState(s, "BLOCKED");
        await this.appendEvent(s, "task.transition", {
          to: "BLOCKED",
          actor: "system:alarm",
          reason: "all attempts blocked",
        });
        try {
          await this.archive(s);
        } catch {
          await this.ctx.storage.setAlarm(Date.now() + 30_000);
        }
      } else if (stillRunning) {
        await this.ctx.storage.setAlarm(nowMs + 60_000);
      }
    }
    await this.saveAll(s);
  }
}
