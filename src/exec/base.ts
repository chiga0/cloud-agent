/**
 * 基线冻结:每个候选必须绑定一个精确 commit,writer 与 verifier 在同一个
 * SHA 上工作,「补丁可重放」才是候选自身的性质,而不是「上游恰好没动」的运气。
 *
 * 本模块只做字符串构造与校验,无 env / 无沙箱依赖,便于穷举单测。持久化的
 * base_sha 会被重放进多个新沙箱里当 shell 命令执行 —— 那等于把一段数据库里的
 * 字符串变成跨沙箱的 shell 注入,直接击穿执行面的隔离边界。因此这里只接受
 * isValidSha 通过的值,二次防御性 throw,并且永不接触 repo_url。
 */

import type { BasePinMode, BaseReport } from "../types";

export type BaseSource = "resolved_default" | "pinned" | "unknown_legacy";

/** 基线相关失败专用退出码:环境事实而非质量判定,控制面据此不烧返工预算。 */
export const BASE_ERRORS = {
  /** 目标 commit 在远端不可达(被 force-push 丢弃、浅克隆取不到) */
  UNREACHABLE: 21,
  /** checkout 后的 HEAD 与请求的 SHA 不一致 */
  MISMATCH: 22,
  /** 候选导出失败(基线对象在导出前已消失 / git 命令报错) */
  PATCH_EXPORT_FAILED: 23,
  /** 补丁超出大小上限:容量事实,同 21–23 一样不进返工闭环 */
  PATCH_TOO_LARGE: 24,
} as const;

/** 补丁字节上限的回落默认值;可被 env.MAX_PATCH_BYTES 覆盖(可选 + 回落)。 */
export const DEFAULT_MAX_PATCH_BYTES = 1_048_576;

export const REPO_DIR = "/workspace/repo";
export const PATCH_PATH = "/tmp/patch.diff";

const SHA_RE = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

export function isValidSha(value: unknown): value is string {
  return typeof value === "string" && SHA_RE.test(value);
}

/** 不合法即 throw:调用方拿到的返回值保证可安全嵌入单引号 shell 字面量。 */
export function requireSha(value: unknown, what = "base_sha"): string {
  if (!isValidSha(value)) throw new Error(`invalid ${what}: not a lowercase hex commit id`);
  return value;
}

export function shaLiteral(value: unknown): string {
  return `'${requireSha(value)}'`;
}

/** 整体加引号的 revspec:引号外不留 `^{}` 这类可能被 shell 解释的字符。 */
export function revLiteral(value: unknown): string {
  return `'${requireSha(value)}^{commit}'`;
}

/**
 * 沙箱的 `exec()` 复用同一个常驻 shell 会话(`ensureDefaultSession` → `POST
 * /api/execute`),所以脚本里顶层的 `exit N` 退掉的是**会话本身**:SDK 不会把
 * 21 当成退出码返回,而是抛「Session … is not ready or shell has died」,
 * 我们精心设计的 fail-closed 路径就永远不会执行(prod 实测)。
 * 放进子 shell 执行,`exit` 只结束子进程,状态码照常回传,顺带阻止 `set -eu`
 * 与 export 泄漏进同一会话里后续的 qwen / patch 导出命令。
 */
function wrap(body: string): string {
  return `(\n${body}\n)`;
}

/** clone 后读默认分支 HEAD,作为 resolved_default 的基线。 */
export function resolveScript(): string {
  return wrap(`set -eu; GIT_TERMINAL_PROMPT=0 git -C ${REPO_DIR} rev-parse HEAD`);
}

/**
 * 把工作副本钉到精确 commit:先试 `fetch --depth=1 origin <sha>`(GitHub 等
 * 允许取任意可达 commit),不支持就沿 deepen 阶梯把历史加深到能看见它。
 * 结尾断言 HEAD 就是请求的 SHA —— 静默落到别的 commit 比失败危险得多。
 */
export function materializeScript(sha: unknown): string {
  const lit = shaLiteral(sha);
  const rev = revLiteral(sha);
  return wrap(
    [
      "set -eu",
      "export GIT_TERMINAL_PROMPT=0",
      `R=${REPO_DIR}`,
      `git -C $R fetch --depth=1 origin ${lit} 2>/dev/null || true`,
      `git -C $R cat-file -e ${rev} 2>/dev/null || {`,
      `  for d in 10 100 1000; do`,
      `    git -C $R fetch --deepen=$d origin 2>/dev/null || break`,
      `    if git -C $R cat-file -e ${rev} 2>/dev/null; then break; fi`,
      `  done`,
      `}`,
      `git -C $R cat-file -e ${rev} || exit ${BASE_ERRORS.UNREACHABLE}`,
      `git -C $R checkout --quiet --detach ${lit}`,
      `[ "$(git -C $R rev-parse HEAD)" = ${lit} ] || exit ${BASE_ERRORS.MISMATCH}`,
    ].join("\n"),
  );
}

/**
 * 导出冻结候选。基线对象在导出前必须仍在(防 agent 改写历史把 SHA 丢掉);
 * agent 在自己的提交上继续工作属正常,diff 以基线为准即可。
 *
 * `maxBytes` 上限在容器内预检(`wc -c`),超限以 24 退出且把实际字节数写进
 * stderr —— 超大补丁绝不回传:控制面用的是非流式 `readFile`,把失控的
 * `--binary` diff 读进 isolate 内存才是真正的事故。
 */
export function exportPatchScript(sha: unknown, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error(`invalid maxBytes: ${maxBytes}`);
  }
  const lit = shaLiteral(sha);
  return wrap(
    [
      "set -eu",
      "export GIT_TERMINAL_PROMPT=0",
      `R=${REPO_DIR}`,
      `git -C $R cat-file -e ${revLiteral(sha)} || exit ${BASE_ERRORS.PATCH_EXPORT_FAILED}`,
      `git -C $R add -A || exit ${BASE_ERRORS.PATCH_EXPORT_FAILED}`,
      `git -C $R diff ${lit} --binary > ${PATCH_PATH} || exit ${BASE_ERRORS.PATCH_EXPORT_FAILED}`,
      `SIZE=$(wc -c < ${PATCH_PATH})`,
      `[ "$SIZE" -le ${maxBytes} ] || {`,
      `  echo "patch too large: $SIZE bytes > ${maxBytes} limit" >&2`,
      `  exit ${BASE_ERRORS.PATCH_TOO_LARGE}`,
      `}`,
    ].join("\n"),
  );
}

/** 从 exec 输出里取 rev-parse 结果;不是合法 SHA 就返回 null(交调用方决定)。 */
export function parseSha(stdout: string | undefined | null): string | null {
  const line = (stdout ?? "").trim().split("\n").pop()?.trim() ?? "";
  return isValidSha(line) ? line : null;
}

export function isBaseError(exitCode: number): boolean {
  return (
    exitCode === BASE_ERRORS.UNREACHABLE ||
    exitCode === BASE_ERRORS.MISMATCH ||
    exitCode === BASE_ERRORS.PATCH_EXPORT_FAILED ||
    exitCode === BASE_ERRORS.PATCH_TOO_LARGE
  );
}

/** 只用到 exec,便于用假沙箱做单测。 */
export interface SandboxExec {
  exec(cmd: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export type PinResult = { ok: true; base: BaseReport } | { ok: false; code: number; detail: string };

/**
 * 把工作副本钉到精确 commit,返回这次执行**实际**基于的基线。
 *
 * - `pin = null`:解析默认分支 HEAD 并固定为 `resolved_default`。此后同一任务
 *   的返工轮与 verifier 都复用这个值,不再受上游移动影响。
 * - `pin = <sha>`:远端取该 commit 并 detach。取不到时 shadow 模式回落默认分支
 *   并带原因继续(enforce 判据还没攒够前不能拿它堵死正常任务),enforce 模式
 *   返回专用退出码交给控制面 fail-closed。
 */
export async function pinWorkspace(
  sandbox: SandboxExec,
  pin: string | null,
  mode: BasePinMode,
): Promise<PinResult> {
  const resolved = await sandbox.exec(resolveScript());
  const defaultSha = parseSha(resolved.stdout);
  if (resolved.exitCode !== 0 || !defaultSha) {
    return {
      ok: false,
      code: BASE_ERRORS.MISMATCH,
      detail: `cannot read cloned HEAD (exit ${resolved.exitCode}): ${resolved.stderr.slice(-500)}`,
    };
  }
  if (!pin) return { ok: true, base: { sha: defaultSha, source: "resolved_default" } };
  if (pin === defaultSha) return { ok: true, base: { sha: pin, source: "pinned" } };

  const mat = await sandbox.exec(materializeScript(pin));
  if (mat.exitCode === 0) return { ok: true, base: { sha: pin, source: "pinned" } };

  const detail = `pinned base ${pin} not materializable (exit ${mat.exitCode}): ${mat.stderr.slice(-500)}`;
  if (mode === "shadow" && mat.exitCode === BASE_ERRORS.UNREACHABLE) {
    return { ok: true, base: { sha: defaultSha, source: "resolved_default", fallback: detail } };
  }
  return { ok: false, code: isBaseError(mat.exitCode) ? mat.exitCode : BASE_ERRORS.MISMATCH, detail };
}
