/**
 * `/tasks/$taskId` 下半三块(w4b)的全部纯判定:result / evidence / candidate。
 *
 * 与 `lib/task-detail.ts` 同一分工:这一页有判断力的部分全是可测的纯函数,`.tsx` 只接线。
 * 三块各有一条独立的查询(w2b/w4a 的既有纪律:一方的失败不许把另两块判死),空态与
 * 失败也各自说话 —— 「还没有」(任务没产出过)、「读不到」(服务端缺口)、「不存在」
 * (id 打错)是三种结论,合并成一种就是观测面撒谎。
 *
 * 两件形状事实(权威都在 src/,由 test/web-task-detail.test.ts 拿 prod 干跑产物逐字对表):
 * - **patch 正文是 text/plain**:apiRequest 的介质检查收不了它,读法在 queries.ts 走裸
 *   fetch 拿回原始 `{status, body}`,「这算什么」由本文件的 `judgePatchResponse` 回答。
 *   no_patch 的 404 与 integrity_error 的 500 都把信息嵌在 `error:{...}` 里
 *   (且 no_patch 自带 status/warnings)—— 200 与错误体是两种介质,「能不能解 JSON」
 *   本身就是分支判据。
 * - **warnings 是交付合同**(src/audit/candidate.ts):未验证、基线未固定、已被否决等
 *   诚实性声明,消费方必须与补丁同屏展示。本文件不解释它们,只保证投影出口存在。
 */

import { ApiError, apiFailureKind } from "./api";
import {
  absentFact,
  decodeJsonObject,
  fact,
  truncateHash,
  type FactRow,
} from "./task-detail";
import { TEXT_SUMMARY_MAX_CHARS } from "./view";
import type { CandidateView, TaskEvidence } from "./schema";

// ── result 块:task.result_text 是唯一数据源(零新增请求)────────────────────

export interface ResultView {
  readonly empty: boolean;
  readonly emptyText: string;
  /** 显示层截断后的预览(不带换行折叠:result 是文档,不是日志行)。 */
  readonly shown: string;
  readonly note: string;
  /** 原文全文(显示层可展开;数据一个字节不动)。 */
  readonly full: string;
}

/**
 * result 的读法。空(null/undefined/纯空白)必须说话:渲染成空白等于让操作员猜
 * 「是没有还是没读到」;说「读取失败」则是撒谎 —— 快照明明读到了,只是没有 result。
 * 截断用 `TEXT_SUMMARY_MAX_CHARS`(与时间线同一个常量,不另立一份 200):
 * 全文的出处写进 note,操作员不必回代码就知道去哪看全文。
 */
export function resultView(resultText: string | null | undefined): ResultView {
  const text = typeof resultText === "string" ? resultText : "";
  if (text.trim() === "") {
    return {
      empty: true,
      emptyText:
        "还没有 result:任务尚未产出终态结果(或该轮没有可提取的结果)。这不是读取失败 —— 读取失败会有单独的错误行。",
      shown: "",
      note: "",
      full: "",
    };
  }
  if (text.length <= TEXT_SUMMARY_MAX_CHARS) {
    return { empty: false, emptyText: "", shown: text, note: "", full: text };
  }
  return {
    empty: false,
    emptyText: "",
    shown: text.slice(0, TEXT_SUMMARY_MAX_CHARS),
    note: `… 已截断(全文 ${text.length} 字符,完整原文:GET /api/tasks/:id/result)`,
    full: text,
  };
}

// ── evidence 块:404 的三种 type 各说各话 ────────────────────────────────────

/** 空态文案也是 lib 的产出(页面只引用):任务没证据 ≠ 读不到。 */
export const EVIDENCE_EMPTY_TEXT =
  "还没有 evidence:任务尚未产出被钉住的证据(未过 verify / 没有 writer manifest)—— 这不是读取失败。";

function httpErrorType(err: unknown): { status: number; errorType: string | null } | null {
  return err instanceof ApiError && err.failure.kind === "http"
    ? { status: err.failure.status, errorType: err.failure.errorType }
    : null;
}

function is404WithType(err: unknown, type: string): boolean {
  const http = httpErrorType(err);
  return http !== null && http.status === 404 && http.errorType === type;
}

/** `no_evidence_yet`(任务没跑完)= 诚实空态;`not_found` / `evidence_missing` 是别的事。 */
export function isNoEvidenceYet(err: unknown): boolean {
  return is404WithType(err, "no_evidence_yet");
}

export function evidenceFailureText(err: unknown): string {
  const kind = apiFailureKind(err);
  const http = httpErrorType(err);
  if (http?.errorType === "no_evidence_yet") return EVIDENCE_EMPTY_TEXT;
  if (http?.errorType === "not_found") {
    return "evidence 端点答 404 not_found:任务 id 不存在 —— 与「还没有证据」是两件事。";
  }
  if (http?.errorType === "evidence_missing") {
    return "evidence 读取失败:R2 里那份证据对象缺失(evidence_missing)—— 证据链与对象存储脱节,需要处置。";
  }
  if (kind === "unauthorized") return "evidence 读取未授权(401):会话可能已过期,请重新登录。";
  if (kind === "network") return "evidence 读取失败(网络):请求没有拿到答复。";
  if (kind === "shape") return "evidence 读取失败(形状):答复与契约不符 —— 前端是投影,读不懂必须出声。";
  return `evidence 读取失败(HTTP ${http?.status ?? "?"}${http?.errorType ? ` · ${http.errorType}` : ""})。`;
}

/**
 * evidence 的投影行。只投影,不做质量推断;manifest 的自报基线单独一行 ——
 * 它可能与任务当前基线不同(assembleCandidate 的同一条提醒),读的人需要并排看见。
 */
export function evidenceFacts(evidence: TaskEvidence): readonly FactRow[] {
  const m = evidence.manifest;
  return [
    fact("writer attempt", truncateHash(evidence.attempt_id).shown, `完整值 ${evidence.attempt_id}`),
    evidence.verifier_attempt_id === null
      ? absentFact("verifier attempt", "这一轮没有 verifier 参与(或尚未落证据)")
      : fact(
          "verifier attempt",
          truncateHash(evidence.verifier_attempt_id).shown,
          `完整值 ${evidence.verifier_attempt_id}`,
        ),
    fact(
      "证据 digest",
      truncateHash(evidence.digest).shown,
      `完整值 ${evidence.digest}(钉住的 writer manifest digest)`,
    ),
    evidence.binding_digest === null
      ? absentFact("binding_digest", "还没有审批绑定(未过审批)")
      : fact(
          "binding_digest",
          truncateHash(evidence.binding_digest).shown,
          `完整值 ${evidence.binding_digest}`,
        ),
    fact(
      "awaiting_human",
      String(evidence.awaiting_human),
      evidence.awaiting_human ? "等待人工处置" : "无需人工介入",
    ),
    fact(
      "manifest 产出",
      m.produced_at,
      `role=${m.role} · model=${m.model} · schema_version=${m.schema_version}`,
    ),
    fact("manifest spec_digest", truncateHash(m.spec_digest).shown, `完整值 ${m.spec_digest}`),
    m.base === undefined
      ? absentFact("manifest 基线", "manifest 缺 base(v1 形状):按基线未固定处理,不报错")
      : fact("manifest 基线", truncateHash(m.base.sha).shown, `完整值 ${m.base.sha} · source=${m.base.source}`),
    fact("transcript", `${m.transcript.size} 字节`, `R2 key ${m.transcript.key} · digest ${m.transcript.digest}`),
    fact("artifacts", `${m.artifacts.length} 个`, m.artifacts.map((a) => a.digest.slice(0, 8)).join(", ")),
    m.patch === undefined
      ? absentFact("patch 产物", "manifest 没有 patch(非 repo 任务,或 writer 未导出变更)")
      : fact("patch 产物", `${m.patch.size} 字节`, `digest ${m.patch.digest} · key ${m.patch.key}`),
  ];
}

// ── candidate 块:CandidateView 投影 + patch 字节流的判定 ────────────────────

export const CANDIDATE_EMPTY_TEXT =
  "无候选:这个任务还没有产出过候选(BLOCKED 轮零候选是设计,不是故障)。";

export function isNoCandidateYet(err: unknown): boolean {
  return is404WithType(err, "no_candidate_yet");
}

export function candidateFailureText(err: unknown): string {
  const kind = apiFailureKind(err);
  const http = httpErrorType(err);
  if (http?.errorType === "no_candidate_yet") return CANDIDATE_EMPTY_TEXT;
  if (http?.errorType === "not_found") {
    return "candidate 端点答 404 not_found:任务 id 不存在 —— 与「无候选」是两件事。";
  }
  if (http?.errorType === "evidence_missing") {
    return "candidate 读取失败:writer manifest 对象在 R2 里缺失(evidence_missing)—— 证据链与对象存储脱节。";
  }
  if (kind === "unauthorized") return "candidate 读取未授权(401):会话可能已过期,请重新登录。";
  if (kind === "network") return "candidate 读取失败(网络):请求没有拿到答复。";
  if (kind === "shape") return "candidate 读取失败(形状):答复与契约不符 —— 前端是投影,读不懂必须出声。";
  return `candidate 读取失败(HTTP ${http?.status ?? "?"}${http?.errorType ? ` · ${http.errorType}` : ""})。`;
}

export function candidateFacts(view: CandidateView): readonly FactRow[] {
  return [
    fact(
      "status",
      view.status,
      "取值权威 src/audit/candidate.ts:approved / verified / unverified / rejected / verification_failed / held_for_human",
    ),
    fact(
      "safe_to_apply",
      String(view.safe_to_apply),
      view.safe_to_apply
        ? "基线已知 + 有补丁 + 判定非否决:可直接 git apply"
        : "不满足直通条件:以 warnings 为准",
    ),
    view.base === null
      ? absentFact("补丁基线", "基线未固定:补丁只与抓取时刻的默认分支绑定,不保证在其它 commit 重放")
      : fact(
          "补丁基线",
          truncateHash(view.base.sha ?? "").shown,
          `完整值 ${view.base.sha ?? "null"} · source=${view.base.source}`,
        ),
    view.patch === null
      ? absentFact("patch digest", "没有补丁文件(非 repo 任务,或 writer 未导出变更)")
      : fact(
          "patch digest",
          truncateHash(view.patch.digest).shown,
          `完整值 ${view.patch.digest} · ${view.patch.size} 字节`,
        ),
    fact(
      "patch_complete",
      view.patch_complete ? "true" : "false(不完整)",
      view.patch_complete ? "" : `在途差量原因:${view.patch_incomplete_reason ?? "执行面未说明"}`,
    ),
    view.writer_attempt_id === null
      ? absentFact("writer attempt", "未记录")
      : fact("writer attempt", truncateHash(view.writer_attempt_id).shown, `完整值 ${view.writer_attempt_id}`),
    view.verifier_attempt_id === null
      ? absentFact("verifier attempt", "这一轮没有独立验证参与")
      : fact(
          "verifier attempt",
          truncateHash(view.verifier_attempt_id).shown,
          `完整值 ${view.verifier_attempt_id}`,
        ),
    view.decision === null
      ? absentFact("decision", "尚无判定(等待 reviewer 或人工)")
      : fact(
          "decision",
          `${view.decision.decision}(by ${view.decision.by})`,
          `actor ${view.decision.actor}`,
        ),
    view.binding_digest === null
      ? absentFact("binding_digest", "还没有审批绑定")
      : fact(
          "binding_digest",
          truncateHash(view.binding_digest).shown,
          `完整值 ${view.binding_digest}`,
        ),
    fact("state", view.state, "组装候选那一刻的任务状态"),
  ];
}

/**
 * patch 字节流的一次裁决结果。`network` / `shape` 只可能来自抛出侧
 * (`patchOutcomeOfThrown`):裸 fetch 的成功答复总有一个 status 可读。
 */
export type PatchOutcome =
  | { kind: "ok"; text: string }
  | { kind: "no_patch"; detail: string; candidateStatus: string; warnings: readonly string[] }
  | { kind: "integrity_error"; key: string; expected: string; actual: string }
  | { kind: "unauthorized"; status: number }
  | { kind: "network" }
  | { kind: "shape"; detail: string }
  | { kind: "http"; status: number; errorType: string | null };

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * `{status, body}` → 裁决。错误信息嵌在 `error:{...}` 里(src/index.ts 的既有形状),
 * 解不出来时退回 http 支并把原始 status 交出去 —— 不猜。
 * `no_patch` 的 404 自带 `status`(候选状态串)与 `warnings`:那是一份 404 里的交付合同,
 * 页面必须把它与其它 warnings 同等对待地列出来。
 * `integrity_error` 的 500 = R2 字节 sha256 与 manifest 记录不一致,**补丁未下发**:
 * 这不是网络抖动,是对象内容与证据链脱节,文案必须把 expected/actual 摆出来。
 */
export function judgePatchResponse(res: { status: number; body: string }): PatchOutcome {
  if (res.status === 200) return { kind: "ok", text: res.body };
  if (res.status === 401) return { kind: "unauthorized", status: res.status };
  const err = asRecord(asRecord(decodeJsonObject(res.body))["error"]);
  const errorType = asString(err["type"]) || null;
  if (res.status === 404 && errorType === "no_patch") {
    const warnings = Array.isArray(err["warnings"])
      ? (err["warnings"] as unknown[]).filter((w): w is string => typeof w === "string")
      : [];
    return {
      kind: "no_patch",
      detail: asString(err["detail"]),
      candidateStatus: asString(err["status"]),
      warnings,
    };
  }
  if (res.status === 500 && errorType === "integrity_error") {
    return {
      kind: "integrity_error",
      key: asString(err["key"]),
      expected: asString(err["expected"]),
      actual: asString(err["actual"]),
    };
  }
  return { kind: "http", status: res.status, errorType };
}

/** 抛出侧(fetch 网络层异常)只有一种归宿。abort 也算「没有拿到答复」,一并归 network。 */
export function patchOutcomeOfThrown(err: unknown): PatchOutcome {
  void err;
  return { kind: "network" };
}

/** 裁决 → 一句话(`ok` 例外:正文本身就是展示)。 */
export function patchOutcomeText(outcome: PatchOutcome): string | null {
  switch (outcome.kind) {
    case "ok":
      return null;
    case "no_patch":
      return `服务端答 404 no_patch:${outcome.detail}(候选 status=${outcome.candidateStatus})—— 下面把这条 404 里自带的 warnings 原样列出。`;
    case "integrity_error":
      return `完整性校验失败(integrity_error):R2 字节的 sha256 与 manifest 记录不一致,补丁未下发。expected ${outcome.expected} ≠ actual ${outcome.actual}(key ${outcome.key})—— 这不是网络问题,是对象内容与证据链脱节。`;
    case "unauthorized":
      return `patch 下载未授权(${outcome.status}):会话可能已过期,请重新登录。`;
    case "network":
      return "patch 下载失败(网络):请求没有拿到答复。";
    case "shape":
      return `patch 下载失败(形状):${outcome.detail}`;
    case "http":
      return `patch 下载失败(HTTP ${outcome.status}${outcome.errorType ? ` · ${outcome.errorType}` : ""})。`;
  }
}
