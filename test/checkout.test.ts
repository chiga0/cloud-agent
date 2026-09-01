import { describe, expect, it } from "vitest";
import { REPO_DIR, checkoutRepo } from "../src/exec/base";

/**
 * workflow 的 exec step 失败会重试,而沙箱按 attemptId 键控、重试复用同一容器。
 * 克隆入口必须幂等,否则上一轮留下的 /workspace/repo 会让每次重试必败于
 * "already exists",重试机制形同虚设(这正是 prod 上任务直落 BLOCKED 的路径)。
 */

interface Call {
  kind: "exec" | "gitCheckout";
  arg: string;
  options?: { targetDir?: string; depth?: number };
}

function fakeSandbox() {
  const calls: Call[] = [];
  return {
    calls,
    async exec(cmd: string) {
      calls.push({ kind: "exec", arg: cmd });
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async gitCheckout(repoUrl: string, options?: { targetDir?: string; depth?: number }) {
      calls.push({ kind: "gitCheckout", arg: repoUrl, options });
    },
  };
}

describe("checkoutRepo", () => {
  it("先清空目标目录再克隆:重试复用容器时,残留目录不得让克隆失败", async () => {
    const sb = fakeSandbox();
    await checkoutRepo(sb, "https://github.com/example/repo");
    expect(sb.calls).toEqual([
      { kind: "exec", arg: `rm -rf ${REPO_DIR}` },
      { kind: "gitCheckout", arg: "https://github.com/example/repo", options: { targetDir: REPO_DIR, depth: 1 } },
    ]);
  });

  it("克隆参数固定为 REPO_DIR + depth 1,不随 repo 名漂移", async () => {
    const sb = fakeSandbox();
    await checkoutRepo(sb, "https://github.com/example/other-repo");
    const clone = sb.calls.find((c) => c.kind === "gitCheckout");
    expect(clone?.options).toEqual({ targetDir: REPO_DIR, depth: 1 });
  });

  it("清空失败即中止:不得在脏状态上继续克隆", async () => {
    const calls: Call[] = [];
    const sb = {
      async exec(cmd: string) {
        calls.push({ kind: "exec", arg: cmd });
        throw new Error("exec unavailable");
      },
      async gitCheckout(repoUrl: string, options?: { targetDir?: string; depth?: number }) {
        calls.push({ kind: "gitCheckout", arg: repoUrl, options });
      },
    };
    await expect(checkoutRepo(sb, "https://github.com/example/repo")).rejects.toThrow("exec unavailable");
    expect(calls.some((c) => c.kind === "gitCheckout")).toBe(false);
  });
});
