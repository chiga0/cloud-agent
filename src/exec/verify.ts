import { getSandbox } from "@cloudflare/sandbox";
import type { Env, TaskSpec } from "../types";
import { putArtifact, type ArtifactRef, type EvidenceManifest } from "../audit/evidence";
import type { SandboxRunResult } from "./sandbox";

export interface VerifyReport {
  schema_version: 1;
  task_id: string;
  attempt_id: string;
  writer_manifest_key: string;
  apply: { exit_code: number; stderr_tail: string };
  verify: { exit_code: number; stdout_tail: string; stderr_tail: string } | null;
}

const APPLY_FAILED_EXIT = 20;

/**
 * 独立验证:全新沙箱重放冻结候选,与 writer 执行环境零共享。
 * 流程:浅克隆默认分支 → 从 writer manifest 取 patch → git apply →
 * 跑 verify_command。transcript 即结构化 JSON 报告(无 LLM、无模型调用,
 * tokens 恒为 0)。
 *
 * apply 失败(上游移动/补丁损坏)= 候选不可重放 → exit 20,按验证失败
 * 处理进入 rework;verify_command 缺失则跳过执行,仅以 apply 成功为证据。
 */
export async function runVerifyAttempt(
  env: Env,
  args: {
    attemptId: string;
    taskId: string;
    spec: TaskSpec;
    writerManifestKey: string;
  },
): Promise<SandboxRunResult> {
  if (!args.spec.repo_url) throw new Error("verify attempt requires spec.repo_url");
  const manifestObj = await env.EVIDENCE.get(args.writerManifestKey);
  if (!manifestObj) throw new Error(`writer manifest missing: ${args.writerManifestKey}`);
  const manifest = (await manifestObj.json()) as EvidenceManifest;
  if (!manifest.patch) throw new Error(`writer manifest has no patch ref: ${args.writerManifestKey}`);
  const patchObj = await env.ARTIFACTS.get(manifest.patch.key);
  if (!patchObj) throw new Error(`patch artifact missing: ${manifest.patch.key}`);
  const patchText = await patchObj.text();

  const sandbox = getSandbox(env.Sandbox, args.attemptId);
  await sandbox.gitCheckout(args.spec.repo_url, { targetDir: "/workspace/repo", depth: 1 });
  await sandbox.writeFile("/tmp/patch.diff", patchText);

  const apply = await sandbox.exec(
    "cd /workspace/repo && git apply --whitespace=nowarn /tmp/patch.diff",
  );

  let exitCode: number;
  let verify: VerifyReport["verify"] = null;
  if (apply.exitCode !== 0) {
    exitCode = APPLY_FAILED_EXIT;
  } else if (args.spec.verify_command) {
    const v = await sandbox.exec(`cd /workspace/repo && ${args.spec.verify_command}`);
    exitCode = v.exitCode;
    verify = {
      exit_code: v.exitCode,
      stdout_tail: v.stdout.slice(-2000),
      stderr_tail: v.stderr.slice(-2000),
    };
  } else {
    exitCode = 0;
  }

  const report: VerifyReport = {
    schema_version: 1,
    task_id: args.taskId,
    attempt_id: args.attemptId,
    writer_manifest_key: args.writerManifestKey,
    apply: { exit_code: apply.exitCode, stderr_tail: apply.stderr.slice(-2000) },
    verify,
  };
  const reportText = JSON.stringify(report, null, 2);
  const transcript = await putArtifact(env.ARTIFACTS, reportText, `attempts/${args.attemptId}`);
  const stderrRef: ArtifactRef = await putArtifact(env.ARTIFACTS, "", `attempts/${args.attemptId}`);
  return { exitCode, transcript, stderr: stderrRef };
}
