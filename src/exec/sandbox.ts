import { getSandbox } from "@cloudflare/sandbox";
import type { BasePinMode, BaseReport, Env } from "../types";
import { putArtifact, type ArtifactRef } from "../audit/evidence";
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

export interface SandboxRunResult {
  exitCode: number;
  transcript: ArtifactRef;
  stderr: ArtifactRef;
  patch?: ArtifactRef;
  /** repo 任务:候选实际所基于的精确 commit 及其来源 */
  base?: BaseReport;
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
 * workerd 挂起检测会在 ~29:48 杀掉单条正在 await 的请求(M9 prod 实测),
 * 单条命令的安全上限 = 25 分钟。qwen 的墙钟绝不能超过它:超了拿到的是平台
 * 击杀(无产物、无回报、无退出码),而不是 qwen 自己的干净退出。
 * 可被 env.MAX_WRITER_WALL_MINUTES 覆盖(可选 + 回落)。
 */
export const MAX_SAFE_WALL_MINUTES = 25;

/**
 * qwen-code 双预算推导(纯函数,可单测)。
 * 墙钟与任务预算同源:留 120s 给 patch 导出/证据/回报,让 qwen 先于外层
 * 预算干净退出(否则外层杀进程时产物与回报都拿不到),再钳到平台上限。
 * turns 闸随墙钟缩放:实测健康产出速率 ≈ 8 turns/min(C2-r5 attempt 1
 * 5.3 分钟撞旧的固定 40 上限,且死在自己做变异验证的中途)—— turns 上限
 * 不该比墙钟先到,它只兜 reasoning loop 这类退化性快转。
 */
export function deriveWriterBudget(
  maxWallSeconds: number | undefined,
  env: {
    DEFAULT_MAX_WALL_SECONDS?: string;
    DEFAULT_MAX_SESSION_TURNS?: string;
    MAX_WRITER_WALL_MINUTES?: string;
  },
): { wallMinutes: number; maxSessionTurns: number } {
  const budgetSeconds = maxWallSeconds ?? Number(env.DEFAULT_MAX_WALL_SECONDS ?? "3600");
  const ceilingRaw = Number(env.MAX_WRITER_WALL_MINUTES ?? "");
  const ceiling =
    Number.isFinite(ceilingRaw) && ceilingRaw > 0 ? Math.floor(ceilingRaw) : MAX_SAFE_WALL_MINUTES;
  const wallMinutes = Math.min(ceiling, Math.max(1, Math.floor((budgetSeconds - 120) / 60)));
  const turnsRaw = Number(env.DEFAULT_MAX_SESSION_TURNS ?? "");
  const maxSessionTurns =
    Number.isFinite(turnsRaw) && turnsRaw > 0
      ? Math.floor(turnsRaw)
      : Math.max(40, wallMinutes * 8);
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
  env: {
    DEFAULT_MAX_WALL_SECONDS?: string;
    DEFAULT_MAX_SESSION_TURNS?: string;
    MAX_WRITER_WALL_MINUTES?: string;
  },
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
 */
export function qwenDeadlineSeconds(
  maxWallSeconds: number | undefined,
  env: { DEFAULT_MAX_WALL_SECONDS?: string; MAX_WRITER_WALL_MINUTES?: string },
): number {
  const { wallMinutes } = deriveWriterBudget(maxWallSeconds, env);
  const budget = maxWallSeconds ?? Number(env.DEFAULT_MAX_WALL_SECONDS ?? "3600");
  return Math.max(60, Math.min(wallMinutes * 60 + 180, budget - 60));
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
  // type=result 事件的 result 字段。在此识别并上翻为 exitCode != 0,避免误判成功。
  let exitCode = outcome.exitCode ?? -1;
  if (exitCode === 0 && stdout) {
    const lastLine = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
    if (lastLine) {
      try {
        const evt = JSON.parse(lastLine) as { type?: string; is_error?: boolean; result?: string };
        if (evt.type === "result" && (evt.is_error === true || /\[API Error:|upstream_error|model_not_found/.test(evt.result ?? ""))) {
          exitCode = 11;
        }
      } catch {
        // 非 JSON 最后一行,忽略
      }
    }
  }

  const transcript = await putArtifact(env.ARTIFACTS, stdout, `attempts/${args.attemptId}`);
  const stderrRef = await putArtifact(env.ARTIFACTS, stderr, `attempts/${args.attemptId}`);
  const base = args.base;

  let patch: ArtifactRef | undefined;
  if (exitCode === 0 && args.exportPatch && args.repoUrl && base?.sha) {
    const exp = await sandbox.exec(
      exportPatchScript(base.sha, Number(env.MAX_PATCH_BYTES) || DEFAULT_MAX_PATCH_BYTES),
    );
    if (exp.exitCode !== 0) {
      // 容量事实不产候选:基线对象被 agent 改写历史丢掉,或补丁超出大小上限。
      // 宁可不产出候选,也不给下游一个无法重放/回传的半成品。
      return {
        exitCode: exp.exitCode || BASE_ERRORS.PATCH_EXPORT_FAILED,
        transcript,
        stderr: await putArtifact(env.ARTIFACTS, exp.stderr, `attempts/${args.attemptId}`),
        base,
      };
    }
    const file = await sandbox.readFile(PATCH_PATH);
    patch = await putArtifact(env.ARTIFACTS, file.content, `attempts/${args.attemptId}`);
  }

  return { exitCode, transcript, stderr: stderrRef, patch, base };
}
