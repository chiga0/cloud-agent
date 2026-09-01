import type { TaskSpec } from "../types";

/**
 * writer attempt 的 prompt。首轮 = 原始任务;返工时把上一轮的失败证据与
 * 修复指令带进新沙箱 —— 新 attempt 是新容器、空工作区,不给它这些信息,
 * 它就会把上一轮已经排除掉的弯路再走一遍(这正是 token 浪费的主项)。
 */
export function composeAttemptPrompt(spec: TaskSpec, instructions?: string[]): string {
  if (!instructions || instructions.length === 0) return spec.prompt;
  const lines = instructions.map((i) => `- ${i}`).join("\n");
  return (
    `${spec.prompt}\n\n` +
    `【这是同一任务的返工轮。上一轮候选未通过验收,必须先修好下面这些点,` +
    `不要重做与它们无关的改动】\n${lines}`
  );
}
