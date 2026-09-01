import { AuthorityConflict, type TaskState } from "../types";

/**
 * 任务状态机的唯一合法转换表。状态写入一律经 assertTransition 校验,
 * 正确性由状态机自身强制,而不是依赖每个调用点不犯错。
 */
export const TASK_TRANSITIONS: Record<TaskState, TaskState[]> = {
  PENDING: ["RUNNING", "BLOCKED"],
  RUNNING: ["VERIFYING", "AWAITING_APPROVAL", "RUNNING", "BLOCKED"],
  VERIFYING: ["AWAITING_APPROVAL", "RUNNING", "BLOCKED", "REJECTED"],
  AWAITING_APPROVAL: ["DONE", "REJECTED", "RUNNING", "BLOCKED"],
  DONE: [],
  REJECTED: [],
  BLOCKED: [],
};

export function isLegalTransition(from: TaskState, to: TaskState): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!isLegalTransition(from, to)) {
    throw new AuthorityConflict(`illegal task transition: ${from} -> ${to}`);
  }
}

/** writer 失败/审查否决后的 rework 决策:预算内重试,耗尽则终态。 */
export function decideRework(args: {
  writerAttempts: number;
  maxAttempts: number;
}): { action: "rework" } | { action: "exhausted" } {
  return args.writerAttempts < args.maxAttempts ? { action: "rework" } : { action: "exhausted" };
}

/** 墙钟上限之外的宽限期,给 workflow 自己回报留余地。 */
export const WALL_GRACE_SECONDS = 300;
/** watchdog 提前触发时的最小续期间隔(避免自旋)。 */
export const WATCHDOG_MIN_INTERVAL_MS = 60_000;

/** RUNNING attempt 的硬截止:创建时刻 + 墙钟上限 + 宽限。 */
export function attemptDeadline(a: { created_at: string; max_wall_seconds: number }): number {
  return Date.parse(a.created_at) + (a.max_wall_seconds + WALL_GRACE_SECONDS) * 1000;
}

/**
 * 下一次 watchdog 触发时间。
 *
 * DO alarm 是一次性的:本次 alarm 若没有任何 attempt 过期(归档重试提前触发、
 * 时钟抖动等),不续期就等于把超时兜底永久丢掉 —— 任务会一直挂着。
 * 因此「还有 RUNNING attempt」本身就足以续期,terminal(终态/已归档)才停表。
 */
export function nextWatchdogAlarm(args: {
  running: Array<{ created_at: string; max_wall_seconds: number }>;
  nowMs: number;
  terminal?: boolean;
}): number | null {
  if (args.terminal || args.running.length === 0) return null;
  return Math.max(Math.min(...args.running.map(attemptDeadline)), args.nowMs + WATCHDOG_MIN_INTERVAL_MS);
}
