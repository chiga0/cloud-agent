import { getSandbox } from "@cloudflare/sandbox";
import type { BaseReport, Env, TaskSpec } from "../types";
import { putArtifact, type ArtifactRef, type EvidenceManifest } from "../audit/evidence";
import { REPO_DIR, checkoutRepo, pinWorkspace } from "./base";
import { LONGRUN_SCRIPT, collectLongRunOutput, longRunScript } from "./longrun";
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

export interface VerifyPrepareResult {
  /** 基线不可材质化:验证器的结论会失真,必须原样上抛转人工(见 runVerifyAttempt 旧注) */
  early?: SandboxRunResult;
  base: BaseReport;
  apply: { exit_code: number; stderr_tail: string };
  /** false = apply 失败,候选不可重放,不启动 verify 进程 */
  launched: boolean;
}

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
 * Fix C 拆分:prepare(短操作,单 step)→ launch/poll(workflow 轮询长进程)→
 * collect(组报告落 R2)。apply 失败(基线之上真的冲突/补丁损坏)= 候选不可
 * 重放 → exit 20 按验证失败进返工;verify_command 缺失则跳过执行,仅以 apply
 * 成功为证据。
 */
export async function prepareVerifyAttempt(
  env: Env,
  args: {
    attemptId: string;
    taskId: string;
    spec: TaskSpec;
    writerManifestKey: string;
  },
): Promise<VerifyPrepareResult> {
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
  let base: BaseReport;
  if (writerBase) {
    const pinned = await pinWorkspace(sandbox, writerBase, "enforce");
    if (!pinned.ok) {
      return {
        base: { sha: null, source: "unknown_legacy" },
        apply: { exit_code: pinned.code, stderr_tail: "" },
        launched: false,
        early: {
          exitCode: pinned.code,
          transcript: await putArtifact(
            env.ARTIFACTS,
            `candidate base not materializable (exit ${pinned.code})\n${pinned.detail}\n`,
            `attempts/${args.attemptId}`,
          ),
          stderr: await putArtifact(env.ARTIFACTS, pinned.detail, `attempts/${args.attemptId}`),
        },
      };
    }
    base = pinned.base;
  } else {
    base = { sha: null, source: "unknown_legacy" };
  }

  await sandbox.writeFile("/tmp/patch.diff", patchText);

  const apply = await sandbox.exec(
    `git -C ${REPO_DIR} apply --whitespace=nowarn /tmp/patch.diff`,
  );
  const applyReport = { exit_code: apply.exitCode, stderr_tail: apply.stderr.slice(-2000) };

  if (apply.exitCode === 0 && args.spec.verify_command) {
    await sandbox.writeFile(
      LONGRUN_SCRIPT,
      longRunScript({ workdir: REPO_DIR, command: args.spec.verify_command }),
    );
    return { base, apply: applyReport, launched: true };
  }
  // apply 失败,或没有 verify_command(仅以 apply 成功为证据):不起长进程
  return { base, apply: applyReport, launched: false };
}

/**
 * Fix C collect 相:组结构化报告落 R2。outcome=null 表示从未启动 verify
 * 进程(apply 失败或无 verify_command)。到期被杀/记录消失时 workflow 传
 * exitCode=-1:容量事实按基建错误路由,不当候选质量结论。
 */
export async function collectVerifyAttempt(
  env: Env,
  args: {
    attemptId: string;
    taskId: string;
    writerManifestKey: string;
  },
  prep: { base: BaseReport; apply: { exit_code: number; stderr_tail: string }; launched: boolean },
  outcome: { exitCode: number | null } | null,
): Promise<SandboxRunResult> {
  let exitCode: number;
  let verify: VerifyReport["verify"] = null;

  if (prep.launched && outcome) {
    const sandbox = getSandbox(env.Sandbox, args.attemptId);
    const { stdout, stderr } = await collectLongRunOutput(sandbox);
    exitCode = outcome.exitCode ?? -1;
    verify = {
      exit_code: exitCode,
      stdout_tail: stdout.slice(-2000),
      stderr_tail: stderr.slice(-2000),
    };
  } else if (prep.apply.exit_code !== 0) {
    exitCode = APPLY_FAILED_EXIT;
  } else {
    exitCode = 0;
  }

  const report: VerifyReport = {
    schema_version: 2,
    task_id: args.taskId,
    attempt_id: args.attemptId,
    writer_manifest_key: args.writerManifestKey,
    base: prep.base,
    apply: prep.apply,
    verify,
  };
  const reportText = JSON.stringify(report, null, 2);
  const transcript = await putArtifact(env.ARTIFACTS, reportText, `attempts/${args.attemptId}`);
  const stderrRef: ArtifactRef = await putArtifact(env.ARTIFACTS, "", `attempts/${args.attemptId}`);
  return { exitCode, transcript, stderr: stderrRef, base: prep.base };
}
