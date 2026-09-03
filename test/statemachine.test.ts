import { describe, expect, it } from "vitest";
import { AuthorityConflict, type TaskState } from "../src/types";
import {
  TASK_TRANSITIONS,
  attemptDeadline,
  assertTransition,
  decideRework,
  isLegalTransition,
  nextWatchdogAlarm,
  WALL_GRACE_SECONDS,
  WATCHDOG_MIN_INTERVAL_MS,
} from "../src/control/statemachine";
import { compositeEvidenceDigest } from "../src/audit/evidence";

const STATES: TaskState[] = [
  "PENDING",
  "RUNNING",
  "VERIFYING",
  "AWAITING_APPROVAL",
  "DONE",
  "REJECTED",
  "BLOCKED",
];

describe("TASK_TRANSITIONS", () => {
  it("覆盖全部状态且终态无出边", () => {
    for (const s of STATES) expect(TASK_TRANSITIONS[s]).toBeDefined();
    for (const t of ["DONE", "REJECTED", "BLOCKED"] as TaskState[]) {
      expect(TASK_TRANSITIONS[t]).toEqual([]);
    }
  });

  it("允许 M6 主链路转换", () => {
    expect(isLegalTransition("PENDING", "RUNNING")).toBe(true);
    expect(isLegalTransition("RUNNING", "VERIFYING")).toBe(true);
    expect(isLegalTransition("RUNNING", "AWAITING_APPROVAL")).toBe(true);
    expect(isLegalTransition("VERIFYING", "AWAITING_APPROVAL")).toBe(true);
    expect(isLegalTransition("VERIFYING", "RUNNING")).toBe(true);
    expect(isLegalTransition("AWAITING_APPROVAL", "DONE")).toBe(true);
    expect(isLegalTransition("AWAITING_APPROVAL", "REJECTED")).toBe(true);
    expect(isLegalTransition("AWAITING_APPROVAL", "RUNNING")).toBe(true);
  });

  it("拒绝非法转换", () => {
    expect(isLegalTransition("PENDING", "DONE")).toBe(false);
    expect(isLegalTransition("DONE", "RUNNING")).toBe(false);
    expect(isLegalTransition("PENDING", "AWAITING_APPROVAL")).toBe(false);
  });

  it("assertTransition 非法时抛 AuthorityConflict", () => {
    expect(() => assertTransition("PENDING", "DONE")).toThrowError(AuthorityConflict);
    expect(() => assertTransition("DONE", "RUNNING")).toThrowError(AuthorityConflict);
    expect(() => assertTransition("RUNNING", "VERIFYING")).not.toThrow();
  });
});

describe("decideRework(writer 失败门禁的预算判断)", () => {
  it("预算内 rework,达到上限判定耗尽", () => {
    expect(decideRework({ writerAttempts: 1, maxAttempts: 3 }).action).toBe("rework");
    expect(decideRework({ writerAttempts: 2, maxAttempts: 3 }).action).toBe("rework");
    expect(decideRework({ writerAttempts: 3, maxAttempts: 3 }).action).toBe("exhausted");
    expect(decideRework({ writerAttempts: 5, maxAttempts: 3 }).action).toBe("exhausted");
  });
});

describe("watchdog 续期(alarm 一次性,不续期就丢兜底)", () => {
  const nowMs = Date.parse("2026-09-01T00:00:00.000Z");
  const at = (offsetMs: number, wall: number) => ({
    created_at: new Date(nowMs + offsetMs).toISOString(),
    max_wall_seconds: wall,
  });

  it("deadline = 创建时刻 + 墙钟上限 + 宽限", () => {
    expect(attemptDeadline(at(0, 600))).toBe(nowMs + (600 + WALL_GRACE_SECONDS) * 1000);
  });

  it("本次触发无一过期时仍按最早 deadline 续期", () => {
    const running = [at(0, 600), at(-10_000, 600)];
    const next = nextWatchdogAlarm({ running, nowMs });
    expect(next).toBe(attemptDeadline(running[1]));
  });

  it("deadline 已过但本轮没判过期时,最短 60s 后续期(不自旋也不丢兜底)", () => {
    const next = nextWatchdogAlarm({ running: [at(-10 * 60_000, 60)], nowMs });
    expect(next).toBe(nowMs + WATCHDOG_MIN_INTERVAL_MS);
  });

  it("没有 RUNNING attempt 或任务已终态则停表", () => {
    expect(nextWatchdogAlarm({ running: [], nowMs })).toBeNull();
    expect(nextWatchdogAlarm({ running: [at(0, 600)], nowMs, terminal: true })).toBeNull();
  });
});

/**
 * Supervisor tick 下的节奏。核心事实:截止驱动的 alarm 在「attempt 还活着但已经不动了」
 * 期间根本不会醒(C2-r6 悬挂 24 分钟时墙钟还剩十几分钟),所以 shadow 模式必须给一条
 * 更早的节奏;而 off 模式一个字节都不能变 —— 那是本期的回归证据。
 */
describe("watchdog 续期 + Supervisor tick", () => {
  const nowMs = Date.parse("2026-09-03T00:00:00.000Z");
  const at = (offsetMs: number, wall: number) => ({
    created_at: new Date(nowMs + offsetMs).toISOString(),
    max_wall_seconds: wall,
  });
  const MIN = WATCHDOG_MIN_INTERVAL_MS;

  it("不传 tick → 与历史逐字段一致(mode off 的回归证据)", () => {
    const running = [at(0, 600), at(-10_000, 600)];
    expect(nextWatchdogAlarm({ running, nowMs, supervisorTickMs: undefined })).toBe(
      nextWatchdogAlarm({ running, nowMs }),
    );
    expect(nextWatchdogAlarm({ running, nowMs })).toBe(attemptDeadline(running[1]));
  });

  it("tick 早于截止 → 返回 now+tick(悬挂期间会醒)", () => {
    const running = [at(0, 600)];
    expect(nextWatchdogAlarm({ running, nowMs, supervisorTickMs: 3 * MIN })).toBe(nowMs + 3 * MIN);
  });

  it("tick 晚于截止 → 仍返回截止(超时兜底不会被 tick 推迟)", () => {
    const running = [at(0, 600)];
    expect(nextWatchdogAlarm({ running, nowMs, supervisorTickMs: 60 * MIN })).toBe(attemptDeadline(running[0]));
  });

  it("tick 不早于 WATCHDOG_MIN_INTERVAL_MS;非法 tick 当没给", () => {
    const running = [at(0, 600)];
    expect(nextWatchdogAlarm({ running, nowMs, supervisorTickMs: 5_000 })).toBe(nowMs + MIN);
    expect(nextWatchdogAlarm({ running, nowMs, supervisorTickMs: 0 })).toBe(attemptDeadline(running[0]));
    expect(nextWatchdogAlarm({ running, nowMs, supervisorTickMs: NaN })).toBe(attemptDeadline(running[0]));
  });

  it("terminal 或没有 RUNNING attempt 时,tick 也不产生下一次 alarm", () => {
    const running = [at(0, 600)];
    expect(nextWatchdogAlarm({ running, nowMs, terminal: true, supervisorTickMs: MIN })).toBeNull();
    expect(nextWatchdogAlarm({ running: [], nowMs, supervisorTickMs: MIN })).toBeNull();
  });
});

describe("compositeEvidenceDigest", () => {
  it("确定性:相同输入相同结果", async () => {
    const parts = [
      { role: "writer", attempt_id: "w1", digest: "d1" },
      { role: "verifier", attempt_id: "v1", digest: "d2" },
    ];
    const a = await compositeEvidenceDigest(parts);
    const b = await compositeEvidenceDigest([...parts]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("顺序敏感且成员变化即变化", async () => {
    const writer = { role: "writer", attempt_id: "w1", digest: "d1" };
    const verifier = { role: "verifier", attempt_id: "v1", digest: "d2" };
    const reviewer = { role: "reviewer", attempt_id: "r1", digest: "d3" };
    const base = await compositeEvidenceDigest([writer, verifier]);
    expect(await compositeEvidenceDigest([verifier, writer])).not.toBe(base);
    expect(await compositeEvidenceDigest([writer])).not.toBe(base);
    expect(await compositeEvidenceDigest([writer, verifier, reviewer])).not.toBe(base);
  });

  it("空组合也有稳定摘要", async () => {
    const a = await compositeEvidenceDigest([]);
    const b = await compositeEvidenceDigest([]);
    expect(a).toBe(b);
  });
});
