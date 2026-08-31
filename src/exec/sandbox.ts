import { getSandbox } from "@cloudflare/sandbox";
import type { Env } from "../types";
import { putArtifact, type ArtifactRef } from "../audit/evidence";

export interface SandboxRunResult {
  exitCode: number;
  transcript: ArtifactRef;
  transcriptRaw: string;
  stderr: ArtifactRef;
  verify?: ArtifactRef;
}

/**
 * 在一次性 Sandbox 中运行 qwen-code(stream-json)。
 * qwen-code 直连百炼(token-plan key);Worker 不做中间代理,
 * token 记账和审计通过事后解析 transcript 完成。
 * 产物回收:stdout/stderr 直接经 ExecResult 回传 → 内容寻址写入 R2。
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
    verifyCommand?: string;
  },
): Promise<SandboxRunResult> {
  const sandbox = getSandbox(env.Sandbox, args.attemptId);

  // token-plan key:只允许 agent 客户端直接调用,不能经代理转发。
  await sandbox.setEnvVars({
    OPENAI_BASE_URL: env.MODEL_UPSTREAM_BASE,
    OPENAI_API_KEY: env.DASHSCOPE_API_KEY,
    OPENAI_MODEL: args.model,
  });

  if (args.repoUrl) {
    await sandbox.gitCheckout(args.repoUrl, { targetDir: "/workspace/repo", depth: 1 });
  }

  // 官方镜像未预装 qwen-code;Docker 可用后构建 sandbox/Dockerfile 预装镜像可跳过此步
  await sandbox.exec(
    "command -v qwen >/dev/null 2>&1 || npm install -g @qwen-code/qwen-code@0.21.10",
  );

  await sandbox.writeFile("/workspace/task.txt", args.prompt);
  const workdir = args.repoUrl ? "/workspace/repo" : "/workspace";
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

  let verify: ArtifactRef | undefined;
  if (args.verifyCommand) {
    const v = await sandbox.exec(`cd ${workdir} && ${args.verifyCommand}`);
    verify = await putArtifact(
      env.ARTIFACTS,
      `exit=${v.exitCode}\n\n${v.stdout}\n${v.stderr}`,
      `attempts/${args.attemptId}`,
    );
  }

  return { exitCode, transcript, transcriptRaw: run.stdout, stderr, verify };
}
