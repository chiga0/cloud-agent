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
