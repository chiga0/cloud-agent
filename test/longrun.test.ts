import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";

/**
 * Fix C(M9.5①)机制测试。r6/r7/r8 的教训:长命令阻塞在 workflow step 里,
 * 驱逐后重试会制造孤儿进程。这里的每条用例都对应一个已实证过的失败形态:
 * - 重连不重启(孤儿与重复烧 token 的根源);
 * - 终态记录必须保住(重启丢结果 = r7 writer-2 run1 的「exit 0 无人认领」);
 * - kill/collect 全链 fail-open(兜底路径自己不能成为新的失败源)。
 */

vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: () => sandboxSingleton,
}));

import {
  LONGRUN_LAUNCH_CMD,
  LONGRUN_PROCESS_ID,
  LONGRUN_SESSION,
  LONGRUN_STDERR,
  LONGRUN_STDOUT,
  SCRIPT_CD_FAILED,
  collectLongRunOutput,
  isLongRunTerminal,
  killLongRun,
  launchOrReattach,
  longRunScript,
  pollLongRun,
  type LongRunSandbox,
} from "../src/exec/longrun";
import { collectVerifyAttempt } from "../src/exec/verify";
import { qwenCommand, qwenDeadlineSeconds } from "../src/exec/sandbox";

// ---- 脚本构造 ----

describe("longRunScript", () => {
  it("固定骨架:cd 失败专用码 + env export + { } 组重定向 + exit $?", () => {
    const s = longRunScript({
      workdir: "/workspace/repo",
      command: "npm ci && npm test",
      env: { OPENAI_API_KEY: "sk-abc" },
    });
    expect(s).toBe(
      [
        "#!/bin/bash",
        `cd /workspace/repo || exit ${SCRIPT_CD_FAILED}`,
        "export OPENAI_API_KEY='sk-abc'",
        "{",
        "npm ci && npm test",
        `} > ${LONGRUN_STDOUT} 2> ${LONGRUN_STDERR}`,
        "exit $?",
        "",
      ].join("\n"),
    );
  });

  it("env 值里的单引号被安全转义(脚本仍是纯字符串构造)", () => {
    const s = longRunScript({ workdir: "/w", command: "true", env: { K: "a'b" } });
    expect(s).toContain("export K='a'\\''b'");
  });

  it("无 env 时不产生空 export 行", () => {
    const s = longRunScript({ workdir: "/w", command: "sleep 1" });
    expect(s).not.toContain("export");
  });
});

// ---- launch / reattach ----

interface Call {
  kind: string;
  args: unknown[];
}

function fakeLongRun(overrides: {
  existing?: { status?: string; exitCode?: number | null; startTime?: Date | string | number } | null;
  createSessionError?: Error;
  killError?: Error;
  files?: Record<string, string>;
  readFileError?: Error;
}) {
  const calls: Call[] = [];
  const sb: LongRunSandbox = {
    async createSession(options) {
      calls.push({ kind: "createSession", args: [options] });
      if (overrides.createSessionError) throw overrides.createSessionError;
      return {};
    },
    async startProcess(command, options, sessionId) {
      calls.push({ kind: "startProcess", args: [command, options, sessionId] });
      return {};
    },
    async getProcess(id, sessionId) {
      calls.push({ kind: "getProcess", args: [id, sessionId] });
      return (overrides.existing ?? null) as never;
    },
    async killProcess(id, signal, sessionId) {
      calls.push({ kind: "killProcess", args: [id, signal, sessionId] });
      if (overrides.killError) throw overrides.killError;
    },
    async readFile(path) {
      calls.push({ kind: "readFile", args: [path] });
      if (overrides.readFileError) throw overrides.readFileError;
      return { content: overrides.files?.[path] ?? "" };
    },
  };
  return { sb, calls };
}

describe("launchOrReattach", () => {
  it("全新启动:建专用 session → 查无记录 → 固定 processId + autoCleanup:false 启动", async () => {
    const { sb, calls } = fakeLongRun({ existing: null });
    const out = await launchOrReattach(sb);
    expect(out.reattached).toBe(false);
    expect(out.snapshot.status).toBe("running");
    expect(calls.map((c) => c.kind)).toEqual(["createSession", "getProcess", "startProcess"]);
    expect(calls[0].args).toEqual([{ id: LONGRUN_SESSION, cwd: "/" }]);
    expect(calls[2].args).toEqual([
      LONGRUN_LAUNCH_CMD,
      { processId: LONGRUN_PROCESS_ID, autoCleanup: false },
      LONGRUN_SESSION,
    ]);
  });

  it("已有在跑记录 = 重连,绝不 startProcess(重启即孤儿+双烧 token)", async () => {
    const { sb, calls } = fakeLongRun({
      existing: { status: "running", startTime: "2026-09-02T22:00:00.000Z" },
    });
    const out = await launchOrReattach(sb);
    expect(out.reattached).toBe(true);
    expect(out.snapshot.status).toBe("running");
    expect(out.snapshot.startedAtMs).toBe(Date.parse("2026-09-02T22:00:00.000Z"));
    expect(calls.some((c) => c.kind === "startProcess")).toBe(false);
  });

  it("已终态记录也重连并保住 exitCode(r7:exit 0 的结果不能丢)", async () => {
    const { sb } = fakeLongRun({ existing: { status: "completed", exitCode: 0 } });
    const out = await launchOrReattach(sb);
    expect(out.reattached).toBe(true);
    expect(out.snapshot).toEqual({ status: "completed", exitCode: 0, startedAtMs: null });
    expect(isLongRunTerminal(out.snapshot)).toBe(true);
  });

  it("createSession 失败 fail-open:session 可能已存在,启动照常", async () => {
    const { sb, calls } = fakeLongRun({ existing: null, createSessionError: new Error("exists") });
    const out = await launchOrReattach(sb);
    expect(out.reattached).toBe(false);
    expect(calls.some((c) => c.kind === "startProcess")).toBe(true);
  });

  it("记录形状异常(无 status)按 missing 处理 → 重新启动", async () => {
    const { sb } = fakeLongRun({ existing: {} });
    const out = await launchOrReattach(sb);
    expect(out.reattached).toBe(false);
  });
});

// ---- poll / terminal / kill / collect ----

describe("pollLongRun", () => {
  it("记录消失 = missing(容量事实,workflow 按 -1 上报)", async () => {
    const { sb } = fakeLongRun({ existing: null });
    expect(await pollLongRun(sb)).toEqual({ status: "missing", exitCode: null, startedAtMs: null });
  });

  it("终态映射:failed 带 exitCode,Date 型 startTime 也能解析", async () => {
    const { sb } = fakeLongRun({
      existing: { status: "failed", exitCode: 55, startTime: new Date(1700000000000) },
    });
    expect(await pollLongRun(sb)).toEqual({
      status: "failed",
      exitCode: 55,
      startedAtMs: 1700000000000,
    });
  });

  it("终态判定表:completed/failed/killed/error/missing 为终态,starting/running 不是", () => {
    const t = (status: string) => isLongRunTerminal({ status, exitCode: null, startedAtMs: null } as never);
    expect([t("completed"), t("failed"), t("killed"), t("error"), t("missing")]).toEqual([
      true, true, true, true, true,
    ]);
    expect([t("starting"), t("running")]).toEqual([false, false]);
  });
});

describe("killLongRun", () => {
  it("SIGKILL 打到专用 session 的固定进程", async () => {
    const { sb, calls } = fakeLongRun({});
    await killLongRun(sb);
    expect(calls[0]).toEqual({
      kind: "killProcess",
      args: [LONGRUN_PROCESS_ID, "SIGKILL", LONGRUN_SESSION],
    });
  });

  it("kill 失败 fail-open:兜底击杀不能反噬上报路径", async () => {
    const { sb } = fakeLongRun({ killError: new Error("rpc down") });
    await expect(killLongRun(sb)).resolves.toBeUndefined();
  });
});

describe("collectLongRunOutput", () => {
  it("读回两个固定输出文件", async () => {
    const { sb } = fakeLongRun({
      files: { [LONGRUN_STDOUT]: "out-text", [LONGRUN_STDERR]: "err-text" },
    });
    expect(await collectLongRunOutput(sb)).toEqual({ stdout: "out-text", stderr: "err-text" });
  });

  it("文件读失败回落空串(容器重启后半程状态不炸 collect)", async () => {
    const { sb } = fakeLongRun({ readFileError: new Error("no such file") });
    expect(await collectLongRunOutput(sb)).toEqual({ stdout: "", stderr: "" });
  });
});

// ---- writer 到期线 ----

describe("qwenDeadlineSeconds", () => {
  it("默认预算 3600:qwen 墙钟 25m + 3min 余量 = 1680s(先到者生效)", () => {
    expect(qwenDeadlineSeconds(undefined, {})).toBe(25 * 60 + 180);
  });

  it("小预算 600:预算 - 60s 先生效,保证赶在 DO alarm(claim+600)之前回报", () => {
    // wallMinutes = floor((600-120)/60) = 8 → min(8*60+180=660, 540) = 540
    expect(qwenDeadlineSeconds(600, {})).toBe(540);
  });

  it("下限 60s:再小的预算也不会把到期线压成 0", () => {
    expect(qwenDeadlineSeconds(100, {})).toBe(60);
  });
});

describe("qwenCommand", () => {
  it("双预算随任务预算推导,且保持 stream-json/--yolo 等无头标志", () => {
    const cmd = qwenCommand(600, {});
    expect(cmd).toContain("--max-session-turns 64"); // 8 turns/min × 8min
    expect(cmd).toContain("--max-wall-time 8m");
    expect(cmd).toContain("--output-format stream-json");
    expect(cmd).toContain("--auth-type openai --yolo");
    expect(cmd).not.toContain("cd "); // cd 收在脚本里,命令本身不含 shell 结构
  });
});

// ---- verify collect 的退出码路由 ----

const sandboxSingleton = {
  readFile: async (path: string) => ({ content: sandboxFiles[path] ?? "" }),
};
const sandboxFiles: Record<string, string> = {};

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

const VERIFY_ARGS = {
  attemptId: "a1",
  taskId: "t1",
  writerManifestKey: "manifests/t1/w/x.json",
};

describe("collectVerifyAttempt", () => {
  it("apply 失败 → exit 20,verify=null,报告仍完整落 R2", async () => {
    const { bucket, bodies } = fakeArtifacts();
    const env = { ARTIFACTS: bucket } as unknown as Env;
    const prep = {
      base: { sha: "abc123", source: "pinned" as const },
      apply: { exit_code: 1, stderr_tail: "patch does not apply" },
      launched: false,
    };
    const r = await collectVerifyAttempt(env, VERIFY_ARGS, prep, null);
    expect(r.exitCode).toBe(20);
    const report = JSON.parse(bodies[r.transcript.key]);
    expect(report.verify).toBeNull();
    expect(report.apply.stderr_tail).toBe("patch does not apply");
    expect(report.base.sha).toBe("abc123");
  });

  it("无 verify_command(apply 成功、未启动)→ exit 0,仅以 apply 为证据", async () => {
    const { bucket, bodies } = fakeArtifacts();
    const env = { ARTIFACTS: bucket } as unknown as Env;
    const prep = {
      base: { sha: null, source: "unknown_legacy" as const },
      apply: { exit_code: 0, stderr_tail: "" },
      launched: false,
    };
    const r = await collectVerifyAttempt(env, VERIFY_ARGS, prep, null);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(bodies[r.transcript.key]).verify).toBeNull();
  });

  it("verify 跑完 exit 1 → 原样路由(候选质量结论,进返工)", async () => {
    const { bucket, bodies } = fakeArtifacts();
    const env = { ARTIFACTS: bucket } as unknown as Env;
    sandboxFiles[LONGRUN_STDOUT] = "test output tail";
    sandboxFiles[LONGRUN_STDERR] = "npm ERR! code 1";
    const prep = {
      base: { sha: "abc123", source: "pinned" as const },
      apply: { exit_code: 0, stderr_tail: "" },
      launched: true,
    };
    const r = await collectVerifyAttempt(env, VERIFY_ARGS, prep, { exitCode: 1 });
    expect(r.exitCode).toBe(1);
    const report = JSON.parse(bodies[r.transcript.key]);
    expect(report.verify).toEqual({
      exit_code: 1,
      stdout_tail: "test output tail",
      stderr_tail: "npm ERR! code 1",
    });
  });

  it("到期被杀/记录消失(exitCode null)→ -1:容量事实,不当候选质量结论", async () => {
    const { bucket, bodies } = fakeArtifacts();
    const env = { ARTIFACTS: bucket } as unknown as Env;
    const prep = {
      base: { sha: "abc123", source: "pinned" as const },
      apply: { exit_code: 0, stderr_tail: "" },
      launched: true,
    };
    const r = await collectVerifyAttempt(env, VERIFY_ARGS, prep, { exitCode: null });
    expect(r.exitCode).toBe(-1);
    expect(JSON.parse(bodies[r.transcript.key]).verify.exit_code).toBe(-1);
  });
});
