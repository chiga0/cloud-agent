import { getSandbox } from "@cloudflare/sandbox";
import type { BaseReport, Env, TaskSpec } from "../types";
import { putArtifact, type ArtifactRef, type EvidenceManifest } from "../audit/evidence";
import { REPO_DIR, checkoutRepo, pinWorkspace } from "./base";
import type { SandboxRunResult } from "./sandbox";

export interface VerifyReport {
  schema_version: 2;
  task_id: string;
  attempt_id: string;
  writer_manifest_key: string;
  /** 候选所基于的精确 commit;legacy 表示 v1 manifest 没带基线,只能按当时默认分支验 */
  base: BaseReport;
  apply: { exit_code: number; stderr_tail: string };
  verify: { exit_code: number; stdout_tail: string; stderr_tail: string } | null;
}

const APPLY_FAILED_EXIT = 20;

/**
 * 独立验证:全新沙箱重放冻结候选,与 writer 执行环境零共享。
 * 流程:浅克隆 → 材质化到 writer 的基线 commit → 从 writer manifest 取 patch →
 * git apply → 跑 verify_command。transcript 即结构化 JSON 报告(无 LLM、无模型
 * 调用,tokens 恒为 0)。
 *
 * 基线材质化在验证器一侧**永远按 enforce 处理**:writer 侧 shadow 回落只是多花
 * 一轮,验证器落到另一个 commit 上却会把「上游移动了」误判成「候选有缺陷」,
 * 触发一次永远修不好的返工。因此这里的失败必须原样上抛给控制面转人工。
 *
 * apply 失败(基线之上真的冲突/补丁损坏)= 候选不可重放 → exit 20 按验证失败
 * 进返工;verify_command 缺失则跳过执行,仅以 apply 成功为证据。
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
  await checkoutRepo(sandbox, args.spec.repo_url);

  // v1 manifest 没有 base:只能沿用「克隆当时的默认分支」,如实标成 legacy,
  // 让报告与 /candidate 都能说明这份结论的可重放性弱一档。
  const writerBase = manifest.base?.sha ?? null;
  let base: VerifyReport["base"];
  if (writerBase) {
    const pinned = await pinWorkspace(sandbox, writerBase, "enforce");
    if (!pinned.ok) {
      return {
        exitCode: pinned.code,
        transcript: await putArtifact(
          env.ARTIFACTS,
          `candidate base not materializable (exit ${pinned.code})\n${pinned.detail}\n`,
          `attempts/${args.attemptId}`,
        ),
        stderr: await putArtifact(env.ARTIFACTS, pinned.detail, `attempts/${args.attemptId}`),
      };
    }
    base = { sha: pinned.base.sha, source: pinned.base.source };
  } else {
    base = { sha: null, source: "unknown_legacy" };
  }

  await sandbox.writeFile("/tmp/patch.diff", patchText);

  const apply = await sandbox.exec(
    `git -C ${REPO_DIR} apply --whitespace=nowarn /tmp/patch.diff`,
  );

  let exitCode: number;
  let verify: VerifyReport["verify"] = null;
  if (apply.exitCode !== 0) {
    exitCode = APPLY_FAILED_EXIT;
  } else if (args.spec.verify_command) {
    const v = await sandbox.exec(`cd ${REPO_DIR} && ${args.spec.verify_command}`);
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
    schema_version: 2,
    task_id: args.taskId,
    attempt_id: args.attemptId,
    writer_manifest_key: args.writerManifestKey,
    base,
    apply: { exit_code: apply.exitCode, stderr_tail: apply.stderr.slice(-2000) },
    verify,
  };
  const reportText = JSON.stringify(report, null, 2);
  const transcript = await putArtifact(env.ARTIFACTS, reportText, `attempts/${args.attemptId}`);
  const stderrRef: ArtifactRef = await putArtifact(env.ARTIFACTS, "", `attempts/${args.attemptId}`);
  return { exitCode, transcript, stderr: stderrRef, base };
}
