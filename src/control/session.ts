import { DurableObject } from "cloudflare:workers";
import type { AttemptParams, BaseReport, Env, ReviewEvidenceMode, TaskSpec, TaskState } from "../types";
import { InvalidBaseSha } from "../types";
import {
  compositeEvidenceDigest,
  sha256Hex,
  type BaseRef,
  type EvidenceManifest,
  type EvidencePart,
} from "../audit/evidence";
import { isValidSha, isBaseError } from "../exec/base";
import type { CandidateDecision, CandidateEvidence } from "../audit/candidate";
import { assertTransition, attemptDeadline, decideRework, isLegalTransition, nextWatchdogAlarm } from "./statemachine";
import {
  assessReviewRejection,
  describeVerifyFailure,
  isNoProgress,
  MATERIAL_LIMITS,
  normalizeForMatch,
  type ReviewMaterial,
  type ReviewSource,
  type ReviewVerdict,
} from "./gates";

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
  /** 熔断或 reviewer 不可用后置真:自动裁决对该任务失效,终态只能由人工给出 */
  awaiting_human: boolean;
  review_evidence_mode: ReviewEvidenceMode;
  /**
   * 本任务所有候选共同冻结的基线 commit。首轮由执行面解析默认分支 HEAD 得到,
   * 之后返工轮与 verifier 一律复用它 —— 跨轮 patch_digest 比较与「候选可重放」
   * 都以它为前提。M8 前的老记录没有这个字段,其候选按基线未固定对待。
   */
  base: BaseRef | null;
  /** 最近一次候选摘要(patch digest 或归一化产出),用于无进展熔断 */
  last_candidate_digest: string | null;
  /** 钉住的当前证据:审批绑定、/evidence、血缘核对的唯一口径 */
  current_evidence: CurrentEvidence | null;
}

interface CurrentEvidence {
  writer_attempt_id: string;
  writer_manifest_key: string;
  writer_manifest_digest: string;
  verifier_attempt_id?: string;
  verifier_manifest_digest?: string;
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
  verify_context?: { writer_manifest_key: string };
  instructions?: string[];
  /** 失败时的错误尾部摘录,返工时随新 attempt 带走 */
  error_tail: string | null;
  review: ReviewVerdict | null;
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

type ReportArgs = Parameters<TaskSession["reportExecution"]>[0];

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
    // M8 前的老记录没有 base 字段:归一化成 null,其候选一律按「基线未固定」对待
    if (task && task.base === undefined) task.base = null;
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

  async createTask(
    spec: unknown,
    taskId: string,
    reviewEvidenceMode?: ReviewEvidenceMode,
  ): Promise<{ task_id: string; spec_digest: string }> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const s = await this.loadAll();
      if (s.task) return { task_id: s.task.id, spec_digest: s.task.spec_digest };
      // base_sha 会被原样重放进多个新沙箱执行,校验必须在入口做,而不是在用的时候
      const pin = (spec as { base_sha?: unknown })?.base_sha;
      if (pin !== undefined && pin !== null && !isValidSha(pin)) {
        throw new InvalidBaseSha("base_sha must be a full lowercase hex commit id");
      }
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
        awaiting_human: false,
        review_evidence_mode:
          reviewEvidenceMode ?? (this.env.REJECT_EVIDENCE_MODE === "enforce" ? "enforce" : "shadow"),
        base: pin ? { sha: pin as string, source: "pinned" } : null,
        last_candidate_digest: null,
        current_evidence: null,
      };
      await this.appendEvent(s, "task.created", { spec_digest: specDigest, base: s.task.base });
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
    instructions?: string[];
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
      instructions?: string[];
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
      verify_context: args.verify_context,
      instructions: args.instructions,
      error_tail: null,
      review: null,
    };
    s.attempts.push(record);

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
      instructions: args.instructions,
      // 基线是执行期事实,不在冻结的 spec 里;返工轮靠这一行继承同一 commit
      base_pin: s.task!.base?.sha ?? null,
    };

    // base_pin 进事件链:跨轮 patch_digest 比较与「这一轮验的是哪个 commit」
    // 都必须能从审计里直接读出,而不是靠推断。
    await this.appendEvent(s, "attempt.created", {
      attempt_id: id,
      role: args.role,
      idempotency_key: args.idempotency_key,
      base_pin: params.base_pin,
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

    const instance = await this.env.ATTEMPT_WORKFLOW.create({ id, params });
    record.workflow_instance_id = instance.id;

    await this.ctx.storage.setAlarm(attemptDeadline(record));
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
    patch_digest?: string | null;
    base?: BaseReport | null;
    review?: ReviewVerdict;
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
      if (args.exit_code !== 0) {
        attempt.error_tail = (args.error ?? `exit_code=${args.exit_code}`).slice(0, 1200);
      }

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
          await this.onVerifyFailed(s, args.attempt_id, args.error ?? "verifier workflow error", null);
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

      if (isBaseError(args.exit_code)) {
        await this.onBaseFailed(s, attempt, args);
      } else if (attempt.role === "writer") {
        await this.onWriterReport(s, attempt, args);
      } else if (attempt.role === "verifier") {
        await this.onVerifierReport(s, attempt, args);
      } else if (attempt.role === "reviewer") {
        await this.onReviewerReport(s, attempt, args);
      }

      await this.saveAll(s);
      return { ok: true };
    });
  }

  /**
   * 基线材质化失败:环境事实,不是候选质量判定。重开一个沙箱在同一个 commit 上
   * 只会同样失败,所以这里不派返工、不烧预算,直接停下转人工(与 reviewer 抖动
   * 属同一类:没有可裁决的候选,也没有可归因给 agent 的缺陷)。
   */
  private async onBaseFailed(s: SessionData, attempt: AttemptRecord, args: ReportArgs): Promise<void> {
    await this.appendEvent(s, "base.failed", {
      attempt_id: attempt.id,
      role: attempt.role,
      exit_code: args.exit_code,
      requested_base: s.task!.base?.sha ?? null,
      // writer 角色下 result_text 恒为字符串(基线失败时提取不到 NDJSON → 空串),
      // `??` 不认空串,会让诊断永远落成 ""。真正的 git stderr 在 transcript 产物里。
      detail: (args.result_text?.trim() || attempt.error_tail || "").slice(0, 500),
      manifest_key: attempt.manifest_key ?? null,
    });
    // 在途的其它回报不该再自动裁决:置位后 reviewer 结论只留档
    s.task!.awaiting_human = true;
    s.task!.pending_review = false;
    s.task!.pending_verify = false;
    this.setState(s, "BLOCKED");
    await this.appendEvent(s, "task.transition", {
      to: "BLOCKED",
      actor: `agent:${attempt.id}`,
      reason: `base materialization failed (exit ${args.exit_code})`,
    });
    await this.archiveWithRetry(s);
  }

  /**
   * 把执行面回报的实际基线写进权威。基线一旦变化(shadow 回落、上游被重写),
   * 跨轮 patch_digest 比较就失去意义 —— 不清零基准会把「换了基线的同等产出」
   * 误判成无进展熔断,或反过来让真无进展躲过比较。
   */
  private async recordWriterBase(
    s: SessionData,
    attempt: AttemptRecord,
    base: BaseReport,
  ): Promise<void> {
    if (!base.sha) return;
    const next: BaseRef = { sha: base.sha, source: base.source };
    const prev = s.task!.base;
    if (base.fallback) {
      await this.appendEvent(s, "base.fallback", {
        attempt_id: attempt.id,
        requested: prev?.sha ?? null,
        used: next.sha,
        detail: base.fallback.slice(0, 500),
      });
    }
    if (prev && prev.sha !== next.sha) {
      await this.appendEvent(s, "base.moved", { attempt_id: attempt.id, from: prev.sha, to: next.sha });
      s.task!.last_candidate_digest = null;
    }
    s.task!.base = next;
    await this.appendEvent(s, "base.frozen", { attempt_id: attempt.id, sha: next.sha, source: next.source });
  }

  /** writer 回报:失败走硬门禁返工;成功则钉证据、过无进展熔断,再派 verifier 或 reviewer。 */
  private async onWriterReport(
    s: SessionData,
    attempt: AttemptRecord,
    args: ReportArgs,
  ): Promise<void> {
    // 门禁:writer 失败不得进入审批流,只能 rework 或 BLOCKED。机械事实,无需举证。
    if (args.exit_code !== 0) {
      await this.appendEvent(s, "writer.failed", {
        attempt_id: attempt.id,
        exit_code: args.exit_code,
      });
      await this.scheduleRework(s, {
        decider: `agent:${attempt.id}`,
        reason: `writer exit_code=${args.exit_code}`,
        eventKind: "writer.rework_scheduled",
        instructions: attempt.error_tail ? [attempt.error_tail] : undefined,
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
      return;
    }

    if (args.base) await this.recordWriterBase(s, attempt, args.base);
    if (args.result_text != null) s.task!.result_text = args.result_text;
    const candidate =
      args.patch_digest ??
      (args.result_text != null ? await sha256Hex(normalizeForMatch(args.result_text)) : null);

    await this.pinWriterEvidence(s, attempt, args.manifest_key, args.manifest_digest);

    if (isNoProgress(s.task!.last_candidate_digest, candidate)) {
      // 两轮候选逐字节相同:自动循环不会再有进展,停下转人工(省一次沙箱 + 一次裁决)
      await this.appendEvent(s, "gate.no_progress", {
        attempt_id: attempt.id,
        candidate_digest: candidate,
        awaiting: "human",
      });
      await this.holdForHuman(s, `agent:${attempt.id}`, "identical candidate: no progress");
      return;
    }
    s.task!.last_candidate_digest = candidate;

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
            attempt_id: attempt.id,
            idempotency_key: verifyKey,
          });
        } catch (err) {
          s.task!.pending_verify = false;
          await this.appendEvent(s, "verify.fanout_failed", {
            attempt_id: attempt.id,
            error: String(err).slice(0, 200),
          });
        }
      }
      if (s.task!.pending_verify) {
        this.setState(s, "VERIFYING");
        await this.appendEvent(s, "task.transition", {
          to: "VERIFYING",
          actor: `agent:${attempt.id}`,
          reason: "writer succeeded, dispatching verifier",
        });
      } else {
        await this.fanoutReview(s, attempt.id);
        await this.ensureAwaitingApproval(s, `agent:${attempt.id}`, "writer finished (verify fanout degraded)");
      }
    } else {
      await this.fanoutReview(s, attempt.id);
      await this.ensureAwaitingApproval(s, `agent:${attempt.id}`, "writer finished");
    }
  }

  /** verifier 回报:先核对它验的是不是当前候选,再按通过/失败分流。 */
  private async onVerifierReport(
    s: SessionData,
    attempt: AttemptRecord,
    args: ReportArgs,
  ): Promise<void> {
    const pinned = s.task!.current_evidence;
    if (!pinned || attempt.verify_context?.writer_manifest_key !== pinned.writer_manifest_key) {
      // 重投/乱序的陈旧验证结论:与被验证的候选不是同一个血缘,不采信
      await this.appendEvent(s, "evidence.lineage_mismatch", {
        verifier_attempt_id: attempt.id,
        verified: attempt.verify_context?.writer_manifest_key ?? null,
        current: pinned?.writer_manifest_key ?? null,
      });
      return;
    }
    if (args.base?.sha && s.task!.base && args.base.sha !== s.task!.base.sha) {
      // 验的不是这份基线:结论与当前候选无关,不采信
      await this.appendEvent(s, "base.lineage_mismatch", {
        verifier_attempt_id: attempt.id,
        verified_base: args.base.sha,
        current_base: s.task!.base.sha,
      });
      return;
    }
    if (args.manifest_digest) {
      pinned.verifier_attempt_id = attempt.id;
      pinned.verifier_manifest_digest = args.manifest_digest;
      await this.appendEvent(s, "evidence.pinned", {
        writer_attempt_id: pinned.writer_attempt_id,
        verifier_attempt_id: attempt.id,
        verifier_manifest_digest: args.manifest_digest,
      });
    }

    if (args.exit_code === 0) {
      await this.appendEvent(s, "verify.completed", { attempt_id: attempt.id, passed: true });
      await this.fanoutReview(s, attempt.id, { passed: true, summary: args.result_text ?? "" });
      await this.ensureAwaitingApproval(s, `agent:${attempt.id}`, "verification passed");
    } else {
      await this.appendEvent(s, "verify.completed", {
        attempt_id: attempt.id,
        passed: false,
        exit_code: args.exit_code,
      });
      await this.onVerifyFailed(
        s,
        attempt.id,
        `verify exit_code=${args.exit_code}`,
        describeVerifyFailure(args.result_text, s.task!.base?.sha ?? args.base?.sha ?? null),
      );
    }
  }

  /** reviewer 回报:机械结论不归它;它的 reject 要交证据,拿不出就只是附注。 */
  private async onReviewerReport(
    s: SessionData,
    attempt: AttemptRecord,
    args: ReportArgs,
  ): Promise<void> {
    const verdict: ReviewVerdict =
      args.exit_code !== 0
        ? { decision: "none", reason: `reviewer_unavailable:${(args.error ?? `exit_code=${args.exit_code}`).slice(0, 300)}` }
        : (args.review ?? { decision: "none", reason: "reviewer 未产出结论" });
    attempt.review = verdict;

    if (verdict.decision === "none") {
      // 模型抖动、HTTP 失败、输出不合规都不是质量结论:不返工也不放行,交人工
      await this.appendEvent(s, "review.unavailable", {
        attempt_id: attempt.id,
        reason: verdict.reason.slice(0, 500),
      });
      await this.holdForHuman(s, `agent:${attempt.id}`, "reviewer unavailable");
      return;
    }

    await this.appendEvent(s, "review.completed", {
      attempt_id: attempt.id,
      decision: verdict.decision,
      reason: verdict.reason,
      failed_criteria: verdict.failed_criteria ?? null,
    });

    if (s.task!.awaiting_human) {
      await this.appendEvent(s, "review.advisory_ignored_awaiting_human", {
        attempt_id: attempt.id,
        decision: verdict.decision,
      });
      return;
    }

    if (verdict.decision === "approve") {
      await this.finishApproval(s, {
        attemptId: attempt.id,
        actor: `agent:${attempt.id}`,
        decision: "approve",
        evidenceDigest: await this.computeBindingDigest(s, attempt),
      });
      return;
    }

    const spec = JSON.parse(s.task!.spec) as TaskSpec;
    const material = (await this.ctx.storage.get<ReviewMaterial>("review_material")) ?? null;
    const assessment = assessReviewRejection({ acceptance: spec.acceptance, verdict, material });
    const mode = s.task!.review_evidence_mode;
    await this.appendEvent(s, "review.reject_assessed", {
      attempt_id: attempt.id,
      honored: assessment.honored,
      reason: assessment.honored ? null : assessment.reason,
      mode,
    });

    if (!assessment.honored && mode === "enforce") {
      // 说不出可核对证据的 reject 不算否决,降级为「通过 + 附注」
      await this.appendEvent(s, "review.downgraded", {
        attempt_id: attempt.id,
        reason: assessment.reason,
      });
      await this.finishApproval(s, {
        attemptId: attempt.id,
        actor: `agent:${attempt.id}`,
        decision: "accept_with_notes",
        evidenceDigest: await this.computeBindingDigest(s, attempt),
      });
      return;
    }

    await this.handleReviewReject(s, attempt.id, verdict.reason, verdict.fix_instructions);
  }

  /** 独立验证失败(或验证器基建错误):硬门禁,无需举证,直接返工;耗尽则 REJECTED。 */
  private async onVerifyFailed(
    s: SessionData,
    verifierAttemptId: string,
    reason: string,
    instructions: string[] | null,
  ): Promise<void> {
    await this.scheduleRework(s, {
      decider: `agent:${verifierAttemptId}`,
      reason,
      eventKind: "verify.rework_scheduled",
      instructions: instructions ?? [reason],
      onExhausted: async () => {
        await this.finishApproval(s, {
          attemptId: verifierAttemptId,
          actor: `agent:${verifierAttemptId}`,
          decision: "reject",
          evidenceDigest: await this.computeBindingDigest(s),
        });
      },
    });
  }

  /** writer 成功 / 验证通过后派 reviewer(幂等:pending_review),并留存喂入材料供举证核对。 */
  private async fanoutReview(
    s: SessionData,
    triggerAttemptId: string,
    verify?: { passed: boolean; summary: string },
  ): Promise<void> {
    if (s.task!.pending_review) return;
    s.task!.pending_review = true;
    const writerIndex = s.attempts.filter((a) => a.role === "writer").length;
    const reviewKey = `${s.task!.id}:review:${writerIndex}`;
    const { spec, material, missing } = await this.buildReviewSpec(s, verify);
    if (missing.length > 0) {
      // 材料缺失时 reviewer 无从举证,其 reject 在 enforce 下必然被降级
      await this.appendEvent(s, "review.material_missing", {
        attempt_id: triggerAttemptId,
        missing,
      });
    }
    await this.ctx.storage.put("review_material", material);
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
        material_digest: await sha256Hex(JSON.stringify(material)),
      });
    } catch (err) {
      await this.appendEvent(s, "review.fanout_failed", {
        attempt_id: triggerAttemptId,
        error: String(err).slice(0, 200),
      });
    }
  }

  /**
   * 组装 reviewer 的输入材料。返回的 material 就是**实际喂入的截断原文**:
   * reviewer 若要以 reject 触发返工,它引用的证据必须能在这些字符串里逐字找到,
   * 因此材料与控制面核对用的是同一份,不能事后重新拼。
   */
  private async buildReviewSpec(
    s: SessionData,
    verify?: { passed: boolean; summary: string },
  ): Promise<{ spec: TaskSpec; material: ReviewMaterial; missing: ReviewSource[] }> {
    const taskSpec = JSON.parse(s.task!.spec) as TaskSpec;
    const taskPrompt = taskSpec.prompt.slice(0, MATERIAL_LIMITS.task_prompt);
    const writerResult = (s.task!.result_text ?? "").slice(0, MATERIAL_LIMITS.writer_result);
    const verifyOutput = verify ? verify.summary.slice(0, MATERIAL_LIMITS.verify_output) : null;
    const { text: patchExcerpt, missing } = await this.loadPatchExcerpt(s);

    const material: ReviewMaterial = {
      task_prompt: taskPrompt,
      writer_result: writerResult,
      verify_output: verifyOutput,
      patch_excerpt: patchExcerpt,
    };
    const acceptance = taskSpec.acceptance ?? [];
    const criteria = acceptance.length
      ? acceptance.map((c, i) => `${i}. ${c}`).join("\n")
      : "(任务未声明验收标准)";

    const prompt = [
      `你是 review agent。只做判断,不执行任务:`,
      `- 禁止调用任何工具、禁止网络查询、禁止重跑任务`,
      `- 机械门禁(执行退出码、干净沙箱重放候选、验证命令、超时与预算)已由控制面校验并通过,你不必也不应重复确认`,
      `- 你的唯一职责:核对【agent 产出】是否切题、是否满足每一条【验收标准】`,
      ``,
      `【原始任务】`,
      taskPrompt,
      ``,
      `【验收标准(编号从 0 开始)】`,
      criteria,
      ``,
      `【agent 产出】`,
      writerResult,
      ``,
      ...(verify
        ? [
            `【独立验证结果(干净沙箱重放候选 + 运行验证命令)】`,
            verify.passed ? "通过" : "失败",
            verifyOutput ?? "",
            ``,
          ]
        : []),
      ...(patchExcerpt ? [`【候选变更(diff 摘录)】`, patchExcerpt, ``] : []),
      `只输出一行 JSON,不要 markdown、不要解释:`,
      `{"decision":"approve"|"reject","reason":"一句话理由","failed_criteria":[验收标准编号],"fix_instructions":["可直接执行的祈使句"],"evidence":[{"source":"task_prompt|writer_result|verify_output|patch","quote":"上方材料里的原文片段(不少于 12 字符;核对时忽略换行与大小写)"}]}`,
      ``,
      `reject 的门槛(三条缺一即不成立):指出失败的验收标准编号、给出具体可执行的修复指令、`,
      `引用上方材料中能找到的原文证据(不改写、不概括)。做不到就不要 reject —— 用 approve 收尾,把保留意见写进 reason,`,
      `它只会作为附注留档,不会触发返工。`,
    ].join("\n");

    return { spec: { prompt, worker: "qwen-code" }, material, missing };
  }

  /** 从钉住的 writer manifest 读取候选 patch 摘录;取不到但要如实报告缺失。 */
  private async loadPatchExcerpt(
    s: SessionData,
  ): Promise<{ text: string | null; missing: ReviewSource[] }> {
    const key = s.task!.current_evidence?.writer_manifest_key;
    if (!key) return { text: null, missing: [] };
    try {
      const obj = await this.env.EVIDENCE.get(key);
      if (!obj) return { text: null, missing: ["patch"] };
      const manifest = (await obj.json()) as EvidenceManifest;
      if (!manifest.patch) return { text: null, missing: [] };
      const patch = await this.env.ARTIFACTS.get(manifest.patch.key);
      if (!patch) return { text: null, missing: ["patch"] };
      return { text: (await patch.text()).slice(0, MATERIAL_LIMITS.patch), missing: [] };
    } catch {
      return { text: null, missing: ["patch"] };
    }
  }

  /** 钉住 writer 候选证据:此后 /evidence、审批绑定、血缘核对都以它为准。 */
  private async pinWriterEvidence(
    s: SessionData,
    attempt: AttemptRecord,
    manifestKey?: string | null,
    manifestDigest?: string | null,
  ): Promise<void> {
    if (!manifestKey || !manifestDigest) return;
    s.task!.current_evidence = {
      writer_attempt_id: attempt.id,
      writer_manifest_key: manifestKey,
      writer_manifest_digest: manifestDigest,
    };
    await this.appendEvent(s, "evidence.pinned", {
      writer_attempt_id: attempt.id,
      writer_manifest_digest: manifestDigest,
    });
  }

  /** 收敛到"可被裁决"状态;已在 AWAITING_APPROVAL 则不动。 */
  private async ensureAwaitingApproval(s: SessionData, actor: string, reason: string): Promise<void> {
    if (s.task!.state === "AWAITING_APPROVAL") return;
    // 不可收敛时保持原状态而非抛出:这条路径是 fail-closed 的安全网,
    // 抛错会让整个回报 RPC 失败、消息进 DLQ,任务反而无人知晓。
    if (!isLegalTransition(s.task!.state, "AWAITING_APPROVAL")) return;
    this.setState(s, "AWAITING_APPROVAL");
    await this.appendEvent(s, "task.transition", { to: "AWAITING_APPROVAL", actor, reason });
  }

  /** 自动裁决失效(熔断或 reviewer 不可用):不再派工,终态只能由人工给出。 */
  private async holdForHuman(s: SessionData, actor: string, reason: string): Promise<void> {
    s.task!.awaiting_human = true;
    s.task!.pending_review = false;
    s.task!.pending_verify = false;
    await this.ensureAwaitingApproval(s, actor, reason);
  }

  /**
   * 决策绑定的组合证据:钉住的 [writer 候选, verifier 验证?, 裁决者?]。
   * 一律读 current_evidence —— /evidence、人工审批、自动裁决三处同口径,
   * 否则人从接口拿到的 digest 会与 DO 重算值不一致而永久 409。
   */
  private async computeBindingDigest(s: SessionData, decider?: AttemptRecord): Promise<string> {
    const parts: EvidencePart[] = [];
    const ev = s.task!.current_evidence;
    if (ev) {
      parts.push({ role: "writer", attempt_id: ev.writer_attempt_id, digest: ev.writer_manifest_digest });
      if (ev.verifier_attempt_id && ev.verifier_manifest_digest) {
        parts.push({
          role: "verifier",
          attempt_id: ev.verifier_attempt_id,
          digest: ev.verifier_manifest_digest,
        });
      }
    }
    if (decider && decider.role === "reviewer" && decider.manifest_digest) {
      parts.push({ role: "reviewer", attempt_id: decider.id, digest: decider.manifest_digest });
    }
    return compositeEvidenceDigest(parts);
  }

  /** 有限返工:预算内起下一个 writer(带走修复指令);耗尽走 onExhausted。 */
  private async scheduleRework(
    s: SessionData,
    args: {
      decider: string;
      reason: string;
      eventKind: string;
      instructions?: string[];
      onExhausted: () => Promise<void>;
    },
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
    // 新 attempt = 新容器 + 空工作区:不带上轮失败证据,它就会把已排除的弯路再走一遍
    await this.startAttemptInternal(s, {
      role: "writer",
      idempotency_key: `${s.task!.id}:attempt:${writerAttempts.length + 1}`,
      max_model_tokens: Number(this.env.DEFAULT_MAX_MODEL_TOKENS),
      max_wall_seconds: Number(this.env.DEFAULT_MAX_WALL_SECONDS),
      instructions: args.instructions,
    });
    await this.appendEvent(s, args.eventKind, {
      decider: args.decider,
      reason: args.reason.slice(0, 500),
      instructions: args.instructions?.map((i) => i.slice(0, 300)) ?? null,
      attempt_number: writerAttempts.length + 1,
    });
  }

  /** reviewer 的 reject 成立后的返工路径(是否成立已由 onReviewerReport 判定)。 */
  private async handleReviewReject(
    s: SessionData,
    reviewerAttemptId: string,
    reason: string,
    fixInstructions?: string[],
  ): Promise<void> {
    await this.scheduleRework(s, {
      decider: `agent:${reviewerAttemptId}`,
      reason,
      eventKind: "review.retry_scheduled",
      instructions: fixInstructions?.length ? fixInstructions : [reason],
      onExhausted: async () => {
        await this.finishApproval(s, {
          attemptId: reviewerAttemptId,
          actor: `agent:${reviewerAttemptId}`,
          decision: "reject",
          evidenceDigest: await this.computeBindingDigest(
            s,
            s.attempts.find((a) => a.id === reviewerAttemptId),
          ),
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
      const ev = s.task.current_evidence;
      if (!ev) return { ok: false, error: "evidence_missing", state: s.task.state };
      // 只认钉住的那一版候选:对旧 attempt 的审批不能裁决当前候选
      if (args.attempt_id !== ev.writer_attempt_id) {
        return { ok: false, error: "attempt_not_current_writer", state: s.task.state };
      }
      const binding = await this.computeBindingDigest(s);
      if (args.evidence_digest !== binding) {
        return { ok: false, error: "evidence_mismatch", state: s.task.state };
      }
      if (s.task.state !== "AWAITING_APPROVAL") {
        return { ok: false, error: "task_not_awaiting", state: s.task.state };
      }
      await this.finishApproval(s, {
        attemptId: ev.writer_attempt_id,
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
    args: {
      attemptId: string | null;
      actor: string;
      decision: "approve" | "reject" | "accept_with_notes";
      evidenceDigest: string;
    },
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
    // accept_with_notes = reject 举证不成立时降级放行,意见留在事件链而不触发返工
    this.setState(s, args.decision === "reject" ? "REJECTED" : "DONE");
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
    } catch (err) {
      // 事件丢了 writer 只会挂到 24h 超时才结束:必须留下可归因的记录,而不是静默
      await this.appendEvent(s, "workflow.notify_failed", {
        attempt_id: last.id,
        workflow_instance_id: last.workflow_instance_id,
        decision,
        error: String(err).slice(0, 200),
      });
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

  /**
   * GET /evidence:审批绑定的取数入口。一律读钉住的 current_evidence,
   * 与 submitDecision 重算的组合 digest 同口径 —— 两处口径不同会让人工
   * 拿着接口返回的 digest 永久 409。
   */
  async getEvidenceSummary(): Promise<{
    found: boolean;
    key: string | null;
    digest: string | null;
    binding_digest: string | null;
    writer_attempt_id: string | null;
    verifier_attempt_id: string | null;
    awaiting_human: boolean;
  }> {
    const s = await this.loadAll();
    if (!s.task) {
      return {
        found: false,
        key: null,
        digest: null,
        binding_digest: null,
        writer_attempt_id: null,
        verifier_attempt_id: null,
        awaiting_human: false,
      };
    }
    const ev = s.task.current_evidence;
    return {
      found: true,
      key: ev?.writer_manifest_key ?? null,
      digest: ev?.writer_manifest_digest ?? null,
      binding_digest: ev ? await this.computeBindingDigest(s) : null,
      writer_attempt_id: ev?.writer_attempt_id ?? null,
      verifier_attempt_id: ev?.verifier_attempt_id ?? null,
      awaiting_human: s.task.awaiting_human,
    };
  }

  /**
   * GET /candidate 的取数入口:只返回 refs 与摘要,R2 读取留在 Worker 侧
   * (与 getEvidenceSummary 同构)。判定者身份必须带出来 —— verifier 的
   * reject 意思是「候选不可重放/验收失败」,reviewer 或人工的 reject 是质量
   * 否决,两者在交付视图里不能混成一个标签。
   */
  async getCandidateRefs(): Promise<{
    found: boolean;
    state: TaskState;
    awaiting_human: boolean;
    base: BaseRef | null;
    evidence: CandidateEvidence | null;
    decision: CandidateDecision | null;
    binding_digest: string | null;
  }> {
    const s = await this.loadAll();
    if (!s.task) {
      return {
        found: false,
        state: "PENDING",
        awaiting_human: false,
        base: null,
        evidence: null,
        decision: null,
        binding_digest: null,
      };
    }
    const ev = s.task.current_evidence;
    const last = s.decisions[s.decisions.length - 1];
    const decider = last?.attempt_id ? s.attempts.find((a) => a.id === last.attempt_id) : undefined;
    return {
      found: true,
      state: s.task.state,
      awaiting_human: s.task.awaiting_human,
      base: s.task.base,
      evidence: ev
        ? {
            writer_attempt_id: ev.writer_attempt_id,
            writer_manifest_key: ev.writer_manifest_key,
            writer_manifest_digest: ev.writer_manifest_digest,
            verifier_attempt_id: ev.verifier_attempt_id ?? null,
            verifier_manifest_digest: ev.verifier_manifest_digest ?? null,
          }
        : null,
      decision: last
        ? {
            decision: last.decision,
            actor: last.actor,
            by: decider?.role === "verifier" ? "verifier" : decider?.role === "reviewer" ? "reviewer" : "human",
          }
        : null,
      binding_digest: ev ? await this.computeBindingDigest(s) : null,
    };
  }

  /** GET /attempts/:id/transcript:该 attempt 自己的 manifest,不参与证据钉住。 */
  async getAttemptManifestKey(attemptId: string): Promise<{ found: boolean; key: string | null }> {
    const s = await this.loadAll();
    if (!s.task) return { found: false, key: null };
    return { found: true, key: s.attempts.find((a) => a.id === attemptId)?.manifest_key ?? null };
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
    // alarm 与 RPC 并发:不复用同一临界区,陈旧快照可能把已裁决的任务改写成
    // BLOCKED,并把陈旧行覆盖回 D1 归档。
    return this.ctx.blockConcurrencyWhile(async () => {
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
        if (a.state === "RUNNING" && nowMs > attemptDeadline(a)) {
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
        }
        // 只有真的改了状态才回写:提前触发(无人过期)时不写,避免与并发 RPC 互踩快照
        await this.saveAll(s);
      }

      // alarm 是一次性的:本次触发没有任何 attempt 过期时也必须续期,
      // 否则超时兜底就此静默消失,任务会永远挂着。
      const terminal =
        s.task.archived ||
        s.task.state === "DONE" ||
        s.task.state === "REJECTED" ||
        s.task.state === "BLOCKED";
      const next = nextWatchdogAlarm({
        running: s.attempts.filter((a) => a.state === "RUNNING"),
        nowMs,
        terminal,
      });
      if (next != null) await this.ctx.storage.setAlarm(next);
    });
  }
}
