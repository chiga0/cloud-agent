/**
 * 2026-09-02 prod 标本夹具 —— 环境故障被误判成质量失败的原始证据。
 *
 * 来源:任务 `6d4574df-1a25-48dc-8bd9-c2449f21ddf7`,verifier attempt `f1673050`
 * 回报的 schema v2 验证报告。当时的事实链:writer 一次成功(~14min)→ verifier
 * `apply.exit_code=0`(候选补丁完好、可重放)+ `verify.exit_code=1`(沙箱出站
 * ECONNRESET,依赖没装上)→ 控制面按质量失败派全量返工 → 两轮各跑满 2400s 撞 exit 55。
 *
 * 保真度说明(不夸大):标了「标本原文」的四处是那份报告 `stderr_tail` 里的引文;
 * 其余行是 npm 10 在同情形下的既有输出形态(errno 块的固定字段顺序、外层 lifecycle
 * 失败块),不是报告里的新事实。分类器只读 `stderr_tail` 且只做子串匹配,所以夹具的
 * 价值全在签名行,补全部分不影响判定。
 */

// ── 标本原文 ────────────────────────────────────────────────────────────────
/** `scripts/ensure-deps.mjs` 的缺依赖横幅(格式由该脚本第 34 行的模板决定)。 */
const LINE_MISSING_DEPS =
  "[ensure-deps] 缺少 node_modules/.bin/tsc, node_modules/.bin/vitest → npm install --include=dev";
const LINE_NPM_CODE = "npm error code ECONNRESET";
const LINE_NPM_ABORTED = "npm error network aborted";
const LINE_NPM_HINT = "npm error network This is a problem related to network connectivity.";

/** 报告里 `verify.stderr_tail` 的形态(`collectVerifyAttempt` 取的是 stderr 尾 2000 字符)。 */
export const ENV_TRANSIENT_VERIFY_STDERR_TAIL = [
  LINE_MISSING_DEPS,
  LINE_NPM_CODE,
  "npm error syscall read",
  "npm error errno -104",
  LINE_NPM_ABORTED,
  LINE_NPM_HINT,
  "npm error network In most cases you are behind a proxy or have bad network settings.",
  "npm error network If you are behind a proxy, please make sure that the",
  "npm error network 'proxy' config is set properly.  See: 'npm help config'",
  "npm error A complete log of this run can be found in: /root/.npm/_logs/2026-09-02T03_14_22_181Z-debug-0.log",
  "npm error code 1",
  "npm error command failed",
  "npm error command sh -c node scripts/ensure-deps.mjs",
].join("\n");

// ── 对照标本:同一条 verify_command 装完依赖后被**候选自己的**断言打挂 ──────────
export const QUALITY_VERIFY_STDERR_TAIL = [
  "> cloud-agent@0.1.0 test",
  "> vitest run",
  "FAIL  test/hello.test.ts > greets the caller",
  "AssertionError: expected 'hello world' to be 'hello cloud-agent'",
  "  Expected: \"hello cloud-agent\"",
  "  Received: \"hello world\"",
  "      at /workspace/repo/test/hello.test.ts:12:31",
  "Tests  1 failed | 7 passed (8)",
].join("\n");

// ── 对照标本:任务自己的依赖树冲突(同样是 npm error,但不是环境故障) ──────────
export const ERESOLVE_VERIFY_STDERR_TAIL = [
  "npm error code ERESOLVE",
  "npm error ERESOLVE could not resolve",
  "npm error While resolving: vitest@4.1.11",
  "npm error Found: typescript@5.9.2",
].join("\n");

// ── 对照标本:测试连不上它期望的本地服务(候选缺陷,不是出站网络故障) ───────────
export const LOCAL_REFUSED_VERIFY_STDERR_TAIL = [
  "Error: connect ECONNREFUSED 127.0.0.1:5432",
  '  at <tests/pg-connection/index.js:856:16> code: "ECONNREFUSED"',
].join("\n");

/** 对照标本:补丁在冻结基线上根本应用不上(质量事实,与网络无关)。 */
export const APPLY_FAILED_STDERR_TAIL =
  "error: patch failed: src/hello.js:1\nerror: src/hello.js: patch does not apply\n";

export interface VerifyReportArgs {
  taskId: string;
  attemptId: string;
  baseSha?: string;
  apply?: { exit_code: number; stderr_tail: string };
  verify?: { exit_code: number; stdout_tail: string; stderr_tail: string } | null;
}

/** 拼一份 schema v2 验证报告(`src/exec/verify.ts:VerifyReport` 的形状)。 */
export function verifyReport(args: VerifyReportArgs): string {
  return JSON.stringify(
    {
      schema_version: 2,
      task_id: args.taskId,
      attempt_id: args.attemptId,
      writer_manifest_key: `manifests/task/${args.taskId}/writer.json`,
      base: { sha: args.baseSha ?? null, source: args.baseSha ? "pinned" : "unknown_legacy" },
      apply: args.apply ?? { exit_code: 0, stderr_tail: "" },
      verify:
        args.verify ?? {
          exit_code: 1,
          stdout_tail: "",
          stderr_tail: ENV_TRANSIENT_VERIFY_STDERR_TAIL,
        },
    },
    null,
    2,
  );
}

/** 标本那一份:apply 成功、verify 因出站网络失败。 */
export function envTransientReport(args: { taskId: string; attemptId: string; baseSha?: string }): string {
  return verifyReport(args);
}
