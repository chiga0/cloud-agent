import { describe, expect, it } from "vitest";
import { REPO_DIR, checkoutRepo } from "../src/exec/base";

/**
 * workflow 的 exec step / 整个 run 失败会重试,而沙箱按 attemptId 键控、重试
 * 复用同一容器。克隆入口必须幂等且与残留进程无竞态:
 * - r3:上一轮 clone 超时留下的目录让每次重试必败于 "already exists";
 * - r6:run 被平台取消后孤儿进程在 rm(exit 0)与 clone 之间重写目录,
 *   照样 "already exists and is not an empty directory"。
 * 现机制:杀残留进程 → 克隆进 staging → 单条 rm+mv 换入 → 每步退出码校验。
 */

const STAGING = `${REPO_DIR}.new`;

interface Call {
  kind: "exec" | "gitCheckout";
  arg: string;
  options?: { targetDir?: string; depth?: number };
}

function fakeSandbox(overrides?: { rmExit?: number; swapExit?: number }) {
  const calls: Call[] = [];
  return {
    calls,
    async exec(cmd: string) {
      calls.push({ kind: "exec", arg: cmd });
      if (cmd.startsWith("cd / && rm -rf") && !cmd.includes("mv")) {
        return { exitCode: overrides?.rmExit ?? 0, stdout: "", stderr: "rm boom" };
      }
      if (cmd.includes("mv")) {
        return { exitCode: overrides?.swapExit ?? 0, stdout: "", stderr: "swap boom" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async gitCheckout(repoUrl: string, options?: { targetDir?: string; depth?: number }) {
      calls.push({ kind: "gitCheckout", arg: repoUrl, options });
    },
  };
}

describe("checkoutRepo", () => {
  it("固定序列:杀残留 → 清空 → 克隆进 staging → rm+mv 换入", async () => {
    const sb = fakeSandbox();
    await checkoutRepo(sb, "https://github.com/example/repo");
    expect(sb.calls).toEqual([
      {
        kind: "exec",
        arg: `pkill -9 -f '/workspace/rep[o]' 2>/dev/null; pkill -9 -f '[q]wen' 2>/dev/null; true`,
      },
      { kind: "exec", arg: `cd / && rm -rf ${REPO_DIR} ${STAGING}` },
      {
        kind: "gitCheckout",
        arg: "https://github.com/example/repo",
        options: { targetDir: STAGING, depth: 1 },
      },
      { kind: "exec", arg: `cd / && rm -rf ${REPO_DIR} && mv ${STAGING} ${REPO_DIR}` },
    ]);
  });

  it("克隆参数固定为 staging 目录 + depth 1,不随 repo 名漂移", async () => {
    const sb = fakeSandbox();
    await checkoutRepo(sb, "https://github.com/example/other-repo");
    const clone = sb.calls.find((c) => c.kind === "gitCheckout");
    expect(clone?.options).toEqual({ targetDir: STAGING, depth: 1 });
  });

  it("清理退出码非 0 即 throw(带 stderr),不得带病走进克隆", async () => {
    const sb = fakeSandbox({ rmExit: 1 });
    await expect(checkoutRepo(sb, "https://github.com/example/repo")).rejects.toThrow(
      /workspace cleanup failed \(exit 1\).*rm boom/,
    );
    expect(sb.calls.some((c) => c.kind === "gitCheckout")).toBe(false);
  });

  it("换入退出码非 0 即 throw(带 stderr):克隆成功也不留半程状态", async () => {
    const sb = fakeSandbox({ swapExit: 2 });
    await expect(checkoutRepo(sb, "https://github.com/example/repo")).rejects.toThrow(
      /workspace swap failed \(exit 2\).*swap boom/,
    );
  });

  it("exec 直接抛异常(会话死亡)时同样中止,不再克隆", async () => {
    const calls: Call[] = [];
    const sb = {
      async exec(cmd: string) {
        calls.push({ kind: "exec", arg: cmd });
        if (!cmd.startsWith("pkill")) throw new Error("exec unavailable");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      async gitCheckout(repoUrl: string, options?: { targetDir?: string; depth?: number }) {
        calls.push({ kind: "gitCheckout", arg: repoUrl, options });
      },
    };
    await expect(checkoutRepo(sb, "https://github.com/example/repo")).rejects.toThrow(
      "exec unavailable",
    );
    expect(calls.some((c) => c.kind === "gitCheckout")).toBe(false);
  });
});
