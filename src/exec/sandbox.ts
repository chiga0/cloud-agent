import { getSandbox } from "@cloudflare/sandbox";
import type { BasePinMode, BaseReport, Env } from "../types";
import { putArtifact, type ArtifactRef } from "../audit/evidence";
import { EXIT_BUDGET_ABORT, EXIT_SESSION_TURNS_LIMIT } from "../routing/classify";
import {
  BASE_ERRORS,
  DEFAULT_MAX_PATCH_BYTES,
  PATCH_PATH,
  REPO_DIR,
  checkoutRepo,
  exportPatchScript,
  pinWorkspace,
} from "./base";
import { LONGRUN_SCRIPT, collectLongRunOutput, longRunScript } from "./longrun";
import { adjudicateCliExit } from "./cli-exit";
import type { BudgetEnv } from "../control/budget";
import { resolveBudget } from "../control/budget";

export interface SandboxRunResult {
  exitCode: number;
  transcript: ArtifactRef;
  stderr: ArtifactRef;
  patch?: ArtifactRef;
  /**
   * 预算到期导出的差量在这里自称不完整(与 `patch` 同生同灭)。正常路径刻意留
   * undefined 而不是 true:出口是「present ⇔ incomplete」,与 manifest 字段口径一致。
   */
  patchIncompleteReason?: string;
  /** repo 任务:候选实际所基于的精确 commit 及其来源 */
  base?: BaseReport;
}

/**
 * qwen 自己按预算干净退出的两个码(墙钟/工具次数 55、session turns 53)。
 * 它们与 exit 1 这类失败的差别是决定性的:**进程是自己在容器还活着、工作树还在
 * 的时刻停下的**,所以那份差量当场可取。非预算类失败(崩溃、API 错误上翻的 11)
 * 不在此列 —— 那种时刻的工作树状态不可知,导出来的是猜,不是证据。
 */
function isBudgetExit(code: number): boolean {
  return code === EXIT_BUDGET_ABORT || code === EXIT_SESSION_TURNS_LIMIT;
}

/**
 * 从 stream-json 的 stdout 里取末条 `type=result` 事件的两个裁决要素。
 * 末行不是 JSON、或不是 result 事件时返回 `undefined` —— 那时只剩进程退出码这一个
 * 事实,裁决器据此原样返回(与内联正则时代的「忽略非 JSON 末行」同一行为)。
 */
function lastResultEvent(
  stdout: string,
): { is_error?: boolean; result?: string } | undefined {
  const lastLine = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  if (!lastLine) return undefined;
  try {
    const evt = JSON.parse(lastLine) as { type?: string; is_error?: boolean; result?: string };
    return evt.type === "result" ? evt : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 沙箱侧模型凭据。跑的是 `--yolo` + 任意 repo_url + 不可信代码,所以容器里
 * 理想只出现可单独撤销的低权 key;Worker 侧的高权 key 归 reviewer 独占。
 * 这里买到的是撤销能力 + 爆炸半径 + 归因,不是额度限流(token-plan 无
 * 可靠的 per-key 硬配额)。
 *
 * 未配置时**回落**到共用 key:降权是配置层增强,不该阻塞基线冻结与候选交付
 * 这两个主交付物。回落即 M8 前的状态(沙箱泄露 = 控制面凭据泄露),`grep
 * credential_fallback` 能在日志里查到哪些 attempt 跑在这个状态上。
 */
export function sandboxModelEnv(
  env: Env,
  model: string,
): Record<string, string> {
  const key = env.SANDBOX_MODEL_API_KEY ?? env.DASHSCOPE_API_KEY;
  if (!env.SANDBOX_MODEL_API_KEY) {
    console.warn(
      "credential_fallback=shared_dashscope_key sandbox has the control-plane key; " +
        "set SANDBOX_MODEL_API_KEY to make sandbox leaks revocable",
    );
  }
  return {
    OPENAI_BASE_URL: env.MODEL_UPSTREAM_BASE,
    OPENAI_API_KEY: key,
    OPENAI_MODEL: model,
  };
}

function pinMode(env: Env): BasePinMode {
  return env.BASE_PIN_MODE === "enforce" ? "enforce" : "shadow";
}

/**
 * qwen-code 双预算的**投影**(薄封装):算法在 control/budget.ts 的 resolveBudget,
 * 这里只取命令行需要的两个数。曾经它自己算一份(缺省、余量、上限各写一遍),
 * 于是「入口看到的预算」与「writer 拿到的墙钟」分叉时没人知道 —— 现在两份都
 * 出自同一次解析。钳制语义(120s 导出余量 + 平台安全上限)与 turns 缩放
 * (≈8/min,下限 40)的动机见 budget.ts 与 test/writer-budget.test.ts。
 */
export function deriveWriterBudget(
  maxWallSeconds: number | undefined,
  env: BudgetEnv,
): { wallMinutes: number; maxSessionTurns: number } {
  const { wallMinutes, maxSessionTurns } = resolveBudget(maxWallSeconds, env);
  return { wallMinutes, maxSessionTurns };
}

/** qwen 无头命令行(不含 cd/env/重定向——那些收在 longRunScript 里)。
 * --yolo:沙箱已是隔离边界,内部 permission 检查会挡住 shell/write,放行即可。
 * --max-session-turns / --max-wall-time:双重 budget,防止 reasoning loop 烧穿
 * proxy 或沙箱时长;达到阈值时 qwen 以 exit=55/53 干净退出,便于上游识别。
 * 墙钟必须与任务预算同源:曾硬编码 5m,代码类任务(装依赖+跑测试)必然撞墙。
 */
export function qwenCommand(
  maxWallSeconds: number | undefined,
  env: BudgetEnv,
): string {
  const { wallMinutes, maxSessionTurns } = deriveWriterBudget(maxWallSeconds, env);
  return (
    `QWEN_CODE_SUPPRESS_YOLO_WARNING=1 qwen -p "$(cat /workspace/task.txt)" ` +
    `--output-format stream-json --auth-type openai --yolo ` +
    `--max-session-turns ${maxSessionTurns} --max-wall-time ${wallMinutes}m`
  );
}

/**
 * 轮询到期兜底(Fix C):qwen 自带 --max-wall-time 会先干净退出,这里只兜
 * 「qwen 自己都没能退出」的悬挂(r6 实测单次模型调用悬挂 24 分钟)。
 * = min(qwen 墙钟 + 3min 余量, 任务预算 - 60s),后者保证赶在 DO 的
 * attemptDeadline alarm(claim + budget)之前给出带证据的回报。
 * 推导在 resolveBudget,这里只是取那一个数。
 */
export function qwenDeadlineSeconds(
  maxWallSeconds: number | undefined,
  env: BudgetEnv,
): number {
  return resolveBudget(maxWallSeconds, env).deadlineSeconds;
}

export interface QwenPrepareResult {
  /** 基线材质化失败:直接上报,不起模型(环境事实,烧沙箱只会重复同一失败) */
  early?: SandboxRunResult;
  base?: BaseReport;
}

/**
 * Fix C prepare 相:全部是短操作(克隆/钉基线/写任务文件/写启动脚本),
 * 在 workflow 的单个 step 内完成。模型凭据经 longRunScript 的 export 写进
 * 启动脚本——setEnvVars 只作用于 default session 的 shell(SDK 实证),
 * 专用 session 里的进程拿不到,所以必须随脚本走。
 */
export async function prepareQwenAttempt(
  env: Env,
  args: {
    attemptId: string;
    prompt: string;
    model: string;
    repoUrl?: string;
    basePin?: string | null;
    maxWallSeconds?: number;
  },
): Promise<QwenPrepareResult> {
  const sandbox = getSandbox(env.Sandbox, args.attemptId);
  let base: BaseReport | undefined;

  if (args.repoUrl) {
    await checkoutRepo(sandbox, args.repoUrl);
    const pinned = await pinWorkspace(sandbox, args.basePin ?? null, pinMode(env));
    if (!pinned.ok) {
      return {
        early: {
          exitCode: pinned.code,
          transcript: await putArtifact(
            env.ARTIFACTS,
            `base materialization failed (exit ${pinned.code})\n${pinned.detail}\n`,
            `attempts/${args.attemptId}`,
          ),
          stderr: await putArtifact(env.ARTIFACTS, pinned.detail, `attempts/${args.attemptId}`),
        },
      };
    }
    base = pinned.base;
  }

  // 基线确定之后才交凭据:一个连工作副本都建不起来的任务不该摸到模型 key。
  await sandbox.writeFile("/workspace/task.txt", args.prompt);
  await sandbox.writeFile(
    LONGRUN_SCRIPT,
    longRunScript({
      workdir: args.repoUrl ? REPO_DIR : "/workspace",
      env: sandboxModelEnv(env, args.model),
      command: qwenCommand(args.maxWallSeconds, env),
    }),
  );
  return { base };
}

/**
 * Fix C collect 相:进程已终态(或到期被杀),读回输出文件 → 内容寻址落 R2。
 * 与旧阻塞路径的唯一语义差:stdout/stderr 来自文件而非 ExecResult 回传。
 * patch 导出仍走 default session 的短 exec——qwen 从未占用过它,无排队竞态。
 */
export async function collectQwenAttempt(
  env: Env,
  args: {
    attemptId: string;
    repoUrl?: string;
    exportPatch?: boolean;
    base?: BaseReport;
  },
  outcome: { exitCode: number | null },
): Promise<SandboxRunResult> {
  const sandbox = getSandbox(env.Sandbox, args.attemptId);
  const { stdout, stderr } = await collectLongRunOutput(sandbox);

  // qwen stream-json 在遇到 API 错误时仍以 exit=0 返回,把错误嵌入最后一条
  // type=result 事件的 result 字段。判据在 exec/cli-exit.ts:整串才是错误,包含不算
  // (c15 的三次俱毁正是「包含即失败」把 writer 讨论错误形状的成功总结读成了失败)。
  const evt = lastResultEvent(stdout);
  const exitCode = adjudicateCliExit({
    nativeExit: outcome.exitCode,
    isError: evt?.is_error,
    resultText: evt?.result,
  });

  const transcript = await putArtifact(env.ARTIFACTS, stdout, `attempts/${args.attemptId}`);
  const stderrRef = await putArtifact(env.ARTIFACTS, stderr, `attempts/${args.attemptId}`);
  const base = args.base;

  let patch: ArtifactRef | undefined;
  let patchIncompleteReason: string | undefined;
  const abortedByBudget = isBudgetExit(exitCode);
  if ((exitCode === 0 || abortedByBudget) && args.exportPatch && args.repoUrl && base?.sha) {
    const exp = await sandbox.exec(
      exportPatchScript(base.sha, Number(env.MAX_PATCH_BYTES) || DEFAULT_MAX_PATCH_BYTES),
    );
    if (exp.exitCode !== 0) {
      // 容量事实不产候选:基线对象被 agent 改写历史丢掉,或补丁超出大小上限。
      // 宁可不产出候选,也不给下游一个无法重放/回传的半成品。
      if (abortedByBudget) {
        // 到期那一支不借用上面的退出码改写:把 55 换成 24 会让同一次死亡从
        // `route_decision(budget_abort)` 改轨到 `base.failed`,而本棒的前提正是
        // 路由语义一字不动。差量导不出来就如实留零,日志可 grep。
        console.warn(
          `budget_abort_patch_export_failed exit=${exitCode} export_exit=${exp.exitCode} ` +
            `attempt=${args.attemptId} err=${exp.stderr.slice(-200)}`,
        );
        return { exitCode, transcript, stderr: stderrRef, base };
      }
      return {
        exitCode: exp.exitCode || BASE_ERRORS.PATCH_EXPORT_FAILED,
        transcript,
        stderr: await putArtifact(env.ARTIFACTS, exp.stderr, `attempts/${args.attemptId}`),
        base,
      };
    }
    const file = await sandbox.readFile(PATCH_PATH);
    if (abortedByBudget && file.content.length === 0) {
      // 被杀在只读阶段(qwen 一分钟没写文件):零差量是事实,不是一份空补丁候选。
      // exit 0 那侧不做这个判空 —— 那是 writer 自己宣称「无需改动」,语义不同。
      console.info(
        `budget_abort_no_diff exit=${exitCode} attempt=${args.attemptId} ` +
          `base=${base.sha} worktree_matches_base=true`,
      );
      return { exitCode, transcript, stderr: stderrRef, base };
    }
    patch = await putArtifact(env.ARTIFACTS, file.content, `attempts/${args.attemptId}`);
    if (abortedByBudget) {
      // 容器的销毁发生在 attempt 终态时(DO 的 reportExecution),collect 这一步还在
      // 容器存活期内,所以差量就地可取;但它承载的是「击杀那一刻的在途状态」——
      // 未跑完的编辑、半写的文件都可能在内,必须自称不完整。
      patchIncompleteReason = `budget_abort(exit=${exitCode})`;
    }
  }

  return { exitCode, transcript, stderr: stderrRef, patch, patchIncompleteReason, base };
}
