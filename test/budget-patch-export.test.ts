import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";

/**
 * 容器在 qwen 退出后仍活着(销毁发生在 attempt 终态时,由 DO 的 reportExecution 触发),
 * 所以「墙钟到期」本来就不等于「工作全部归零」—— 差的只是 collect 那一步愿不愿意
 * 去取。prod 标本 `5489dc8a` / `dbcc8fc0`:writer 做了 40 分钟,exit 55 收场,补丁从未
 * 被导出,两次各白烧 ≈25 万 token、零产物。
 *
 * 这里钉住的是导出条件本身,全部走真实入口 `collectQwenAttempt`:
 * - 预算类退出码(55 墙钟 / 53 turns)也导,且产物自称不完整;
 * - 零差量不伪造空候选(被杀在只读阶段是事实,不是一份补丁);
 * - exit 0 一字不变(完整、无标记);
 * - 非预算类失败(exit 1)不因本棒多导一次。
 * 桩测手段沿用 test/longrun.test.ts:替换 getSandbox + 假 R2,不为测试新增只在测试里
 * 用的公开方法。
 */

const sandboxFiles: Record<string, string> = {};
const execLog: string[] = [];
let exportExit = 0;

vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: () => ({
    async exec(cmd: string) {
      execLog.push(cmd);
      return { exitCode: exportExit, stdout: "", stderr: "patch too large: 99999999 bytes" };
    },
    async readFile(path: string) {
      return { content: sandboxFiles[path] ?? "" };
    },
  }),
}));

import { collectQwenAttempt } from "../src/exec/sandbox";
import { PATCH_PATH } from "../src/exec/base";
import { LONGRUN_STDERR, LONGRUN_STDOUT } from "../src/exec/longrun";

const BASE_SHA = "b".repeat(40);
const RESULT_LINE = '{"type":"result","is_error":false,"result":"partial work"}';
const DIFF = "diff --git a/src/session.ts b/src/session.ts\n@@\n+// in-flight edit\n";

function fakeArtifacts() {
  const bodies: Record<string, string> = {};
  const bucket = {
    async put(key: string, body: string) {
      bodies[key] = body;
      return {};
    },
  };
  return { bucket: bucket as unknown as R2Bucket, bodies };
}

/**
 * @param worktreeDiff 容器里 /tmp/patch.diff 的内容(exportPatchScript 的产物)
 */
async function collect(
  exitCode: number,
  worktreeDiff: string,
  opts: { exportExit?: number } = {},
) {
  execLog.length = 0;
  exportExit = opts.exportExit ?? 0;
  for (const k of Object.keys(sandboxFiles)) delete sandboxFiles[k];
  sandboxFiles[LONGRUN_STDOUT] = RESULT_LINE;
  sandboxFiles[LONGRUN_STDERR] = "";
  sandboxFiles[PATCH_PATH] = worktreeDiff;

  const { bucket, bodies } = fakeArtifacts();
  const env = { ARTIFACTS: bucket } as unknown as Env;
  const r = await collectQwenAttempt(
    env,
    {
      attemptId: "att-1",
      repoUrl: "https://github.com/example/repo",
      exportPatch: true,
      base: { sha: BASE_SHA, source: "resolved_default" },
    },
    { exitCode },
  );
  return { r, bodies };
}

/** exportPatchScript 的产物形状:`git -C $R diff '<base_sha>' --binary > /tmp/patch.diff` */
const exportWasAttempted = () => execLog.some((c) => c.includes(`diff '${BASE_SHA}' --binary`));

describe("collectQwenAttempt:预算到期也导出差量", () => {
  it("exit 55 + 有工作树差量 → 调用导出,产物带「不完整」标记,退出码原样保留", async () => {
    const { r, bodies } = await collect(55, DIFF);
    expect(exportWasAttempted()).toBe(true);
    expect(r.patch).toBeDefined();
    expect(bodies[r.patch!.key]).toBe(DIFF);
    // 语义 = complete:false + 原因带退出码:读模型据此说明这是击杀那一刻的差量
    expect(r.patchIncompleteReason).toBe("budget_abort(exit=55)");
    // 路由语义不变:仍然是 exit 55 → budget_abort → BLOCKED,不升格成候选
    expect(r.exitCode).toBe(55);
  });

  it("exit 53(turns 触顶)同样导出并标记 —— 两个都是 qwen 自己的预算执法", async () => {
    const { r } = await collect(53, DIFF);
    expect(exportWasAttempted()).toBe(true);
    expect(r.patchIncompleteReason).toBe("budget_abort(exit=53)");
    expect(r.exitCode).toBe(53);
  });

  it("零差量时不伪造空候选,并留一行可 grep 的 budget_abort_no_diff", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const { r } = await collect(55, "");
      expect(r.patch).toBeUndefined();
      expect(r.patchIncompleteReason).toBeUndefined();
      expect(r.exitCode).toBe(55);
      expect(info.mock.calls.map((c) => String(c[0])).join("\n")).toContain("budget_abort_no_diff");
    } finally {
      info.mockRestore();
    }
  });

  it("到期 + 补丁超上限(导出以 24 退出)不产候选,也不把 55 改写成 24:上限不绕,路由不换轨", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { r } = await collect(55, DIFF, { exportExit: 24 });
      expect(r.patch).toBeUndefined();
      expect(r.exitCode).toBe(55);
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
        "budget_abort_patch_export_failed",
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("collectQwenAttempt:正常路径不受本棒影响", () => {
  it("exit 0 → 行为与之前完全一致:导出、落产物、不带不完整标记", async () => {
    const { r, bodies } = await collect(0, DIFF);
    expect(exportWasAttempted()).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.patch).toBeDefined();
    expect(bodies[r.patch!.key]).toBe(DIFF);
    expect(r.patchIncompleteReason).toBeUndefined();
  });

  it("exit 0 + 零差量仍产出空补丁(那是 writer 自认「无需改动」,与到期那支语义不同)", async () => {
    const { r } = await collect(0, "");
    expect(r.exitCode).toBe(0);
    expect(r.patch).toBeDefined();
    expect(r.patch!.size).toBe(0);
    expect(r.patchIncompleteReason).toBeUndefined();
  });

  it("非预算类失败(exit 1)不因本棒新增导出,也不产出补丁", async () => {
    const { r } = await collect(1, DIFF);
    expect(exportWasAttempted()).toBe(false);
    expect(r.patch).toBeUndefined();
    expect(r.exitCode).toBe(1);
  });
});
