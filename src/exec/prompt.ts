import type { TaskSpec } from "../types";

/**
 * 仓库任务的基线纪律。工作副本已 detach 在一个精确 commit 上,控制面与独立
 * 验证器都以它为准;一次 `git pull` 就会让候选混进上游改动,在重放时被判定为
 * 缺陷 —— 而那轮返工的成本本可以完全不发生。
 */
function baselineNotice(baseline?: string | null): string {
  const which = baseline
    ? `本次基线是 commit \`${baseline}\`(工作副本已 detach 到它)`
    : "当前工作副本的 HEAD 就是本次基线";
  return (
    `【基线约束】${which}。直接在这个工作副本上修改:` +
    `不要执行 git fetch / git pull / git switch / git checkout 去同步或切换分支,` +
    `也不要改写历史(rebase / reset / filter-branch)。`
  );
}

/**
 * writer attempt 的 prompt。首轮 = 原始任务;返工时把上一轮的失败证据与
 * 修复指令带进新沙箱 —— 新 attempt 是新容器、空工作区,不给它这些信息,
 * 它就会把上一轮已经排除掉的弯路再走一遍(这正是 token 浪费的主项)。
 */
export function composeAttemptPrompt(
  spec: TaskSpec,
  instructions?: string[],
  baseline?: string | null,
): string {
  const notice = spec.repo_url ? baselineNotice(baseline) : null;
  const head = notice ? `${spec.prompt}\n\n${notice}` : spec.prompt;
  if (!instructions || instructions.length === 0) return head;
  const lines = instructions.map((i) => `- ${i}`).join("\n");
  return (
    `${head}\n\n` +
    `【这是同一任务的返工轮。上一轮候选未通过验收,必须先修好下面这些点,` +
    `不要重做与它们无关的改动】\n${lines}`
  );
}
