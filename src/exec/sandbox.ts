import { getSandbox } from "@cloudflare/sandbox";
import type { BasePinMode, BaseReport, Env } from "../types";
import { putArtifact, type ArtifactRef } from "../audit/evidence";
import {
  BASE_ERRORS,
  DEFAULT_MAX_PATCH_BYTES,
  PATCH_PATH,
  REPO_DIR,
  exportPatchScript,
  pinWorkspace,
} from "./base";

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
 * 在一次性 Sandbox 中运行 qwen-code(stream-json)。
 * qwen-code 直连百炼(低权 token-plan key);Worker 不做中间代理,
 * token 记账和审计通过事后解析 transcript 完成。
 * 产物回收:stdout/stderr 直接经 ExecResult 回传 → 内容寻址写入 R2。
 *
 * repo 任务:克隆后把工作副本**钉到精确 commit**(pinWorkspace),成功后按
 * `git diff <base> --binary` 导出冻结快照,由独立 verifier 在另一沙箱重放同一
 * 基线验证 —— 验证语义不在 writer 沙箱内执行。基线不可用时不起模型:那是环境
 * 事实,烧一次沙箱只会重复同一个失败。
 *
 * 注意:qwen-code 无头标志以本机 `qwen --help` 为准(此处 -p / --output-format
 * stream-json / --auth-type openai 依据 sources/qwen-code 0.21.10 的 config.ts)。
 */
export async function runQwenCodeAttempt(
  env: Env,
  args: {
    attemptId: string;
    prompt: string;
    model: string;
    repoUrl?: string;
    exportPatch?: boolean;
    /** 控制面已冻结的基线;null = 本次执行解析默认分支 HEAD 并固定 */
    basePin?: string | null;
  },
): Promise<SandboxRunResult> {
  const sandbox = getSandbox(env.Sandbox, args.attemptId);
  let base: BaseReport | undefined;

  if (args.repoUrl) {
    await sandbox.gitCheckout(args.repoUrl, { targetDir: REPO_DIR, depth: 1 });
    const pinned = await pinWorkspace(sandbox, args.basePin ?? null, pinMode(env));
    if (!pinned.ok) {
      return {
        exitCode: pinned.code,
        transcript: await putArtifact(
          env.ARTIFACTS,
          `base materialization failed (exit ${pinned.code})\n${pinned.detail}\n`,
          `attempts/${args.attemptId}`,
        ),
        stderr: await putArtifact(env.ARTIFACTS, pinned.detail, `attempts/${args.attemptId}`),
      };
    }
    base = pinned.base;
  }

  // 基线确定之后才交凭据:一个连工作副本都建不起来的任务不该摸到模型 key。
  await sandbox.setEnvVars(sandboxModelEnv(env, args.model));

  await sandbox.writeFile("/workspace/task.txt", args.prompt);
  const workdir = args.repoUrl ? REPO_DIR : "/workspace";
  // --yolo:沙箱已是隔离边界,内部 permission 检查会挡住 shell/write,放行即可。
  // --max-session-turns / --max-wall-time:双重 budget,防止 reasoning loop 烧穿
  // proxy 或沙箱时长;达到阈值时 qwen 以 exit=55/53 干净退出,便于上游识别。
  const run = await sandbox.exec(
    `cd ${workdir} && QWEN_CODE_SUPPRESS_YOLO_WARNING=1 qwen -p "$(cat /workspace/task.txt)" ` +
      `--output-format stream-json --auth-type openai --yolo ` +
      `--max-session-turns 12 --max-wall-time 5m`,
  );

  // qwen stream-json 在遇到 API 错误时仍以 exit=0 返回,把错误嵌入最后一条
  // type=result 事件的 result 字段。在此识别并上翻为 exitCode != 0,避免误判成功。
  let exitCode = run.exitCode;
  if (exitCode === 0 && run.stdout) {
    const lastLine = run.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
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

  const transcript = await putArtifact(env.ARTIFACTS, run.stdout, `attempts/${args.attemptId}`);
  const stderr = await putArtifact(env.ARTIFACTS, run.stderr, `attempts/${args.attemptId}`);

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

  return { exitCode, transcript, stderr, patch, base };
}
