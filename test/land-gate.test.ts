import { beforeAll, describe, expect, it } from "vitest";
import {
  buildCommitMessage,
  DEFAULT_API,
  DEFAULT_TOKEN_ENV,
  EXIT,
  GATE_KEYS,
  parseArgs,
  planRun,
  resolveToken,
  runGate,
  summaryLine,
} from "../scripts/land-gate.mjs";

/**
 * 守门器不变量测试。只测 land-gate.mjs 的纯逻辑(注入假 deps):真 git/npm 子进程
 * 不在这里 mock —— mock 出来的 `git apply` 只会证明「我以为 git 怎么表现」。那部分靠
 * 真实运行验证(README「候选落地」一节:先 dry-run,再 --execute,最后 --push)。
 *
 * 这里钉的是它**不会做什么**:digest 不对就不碰 git、没 commit 就不 push、
 * 参数/环境错误的退出码是 3(不是 64 —— 无人值守的循环按 0/1/2/3 分流,
 * 同一类错误不能有两套口径)。
 */

const TASK = "3f2b9a6e-1c4d-4e5f-8a9b-0c1d2e3f4a5b";
const BASE_SHA = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";
const MANIFEST_DIGEST = "b".repeat(64);
const BINDING_DIGEST = "c".repeat(64);
const COMMIT_SHA = "9".repeat(40);
const PATCH_TEXT = "diff --git a/hello.py b/hello.py\n--- a/hello.py\n+++ b/hello.py\n@@\n+print('hi')\n";
const PATCH_BYTES = new TextEncoder().encode(PATCH_TEXT);

/** 真实 sha256:让「比对通过」这条路径证明的是字节→hex 的等价,而不是对象同一性。 */
async function sha256Hex(bytes: BufferSource): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let PATCH_DIGEST = "";
beforeAll(async () => {
  PATCH_DIGEST = await sha256Hex(PATCH_BYTES);
});

function taskResponse(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: "DONE",
    base: { sha: BASE_SHA, source: "pinned" },
    current_evidence: {
      writer_attempt_id: "att-w",
      writer_manifest_digest: MANIFEST_DIGEST,
      verifier_attempt_id: null,
      verifier_manifest_digest: null,
    },
    ...over,
  };
}

function evidenceResponse(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    attempt_id: "att-w",
    verifier_attempt_id: null,
    awaiting_human: false,
    digest: MANIFEST_DIGEST,
    binding_digest: BINDING_DIGEST,
    manifest: {
      schema_version: 2,
      task_id: TASK,
      attempt_id: "att-w",
      role: "writer",
      produced_at: "2026-09-02T00:00:00Z",
      spec_digest: "a".repeat(64),
      model: "test-model",
      transcript: { key: "t", digest: "d".repeat(64), size: 1 },
      artifacts: [],
      patch: { key: "artifacts/sha256/be/ef/patch", digest: PATCH_DIGEST, size: PATCH_BYTES.length },
      base: { sha: BASE_SHA, source: "pinned" },
    },
    ...over,
  };
}

/** runGate 会经过的全部副作用名。GIT_WRITE_STEPS 是「真的动手」的那几个:任何一门不过都不该出现。 */
const GIT_WRITE_STEPS = ["openWorktree", "applyCheck", "applyPatch", "install", "typecheck", "runTests", "commit", "push"];

function fakeDeps(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const messages: string[] = [];
  const pass = { ok: true, detail: "" };
  const impl: Record<string, (...args: any[]) => unknown> = {
    log: () => undefined,
    fetchTask: () => taskResponse(),
    fetchEvidence: () => evidenceResponse(),
    fetchPatch: () => PATCH_BYTES,
    sha256Hex: (bytes: BufferSource) => sha256Hex(bytes),
    openWorktree: () => ({ dir: "/tmp/land-wt/wt", temp: true }),
    closeWorktree: () => undefined,
    applyCheck: () => pass,
    applyPatch: () => pass,
    install: () => pass,
    typecheck: () => ({ ok: true, out: "ok", detail: "" }),
    runTests: () => ({ ok: true, passed: 214, detail: "" }),
    commit: (_handle: unknown, message: string) => (messages.push(message), COMMIT_SHA),
    push: () => undefined,
    ...over,
  };
  // 调用记录统一由注入层包一层:覆写某个 dep 时不会把「这次到底有没有被叫到」的账一起丢掉。
  const deps: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(impl)) {
    deps[name] = name === "log" ? fn : async (...args: unknown[]) => (calls.push(name), await fn(...args));
  }
  return { deps, calls, messages };
}

/** 绕过 parseArgs 直接造 opts,以便单列测「即使 opts 自相矛盾也不许 push」。 */
function landOpts(over: Record<string, unknown> = {}) {
  return { task: TASK, api: DEFAULT_API, tokenEnv: DEFAULT_TOKEN_ENV, execute: false, push: false, worktree: null, ...over };
}

describe("退出码口径", () => {
  it("只有 0/1/2/3 四档;参数与环境错误是 3,不再有 64", () => {
    expect({ ...EXIT }).toEqual({ OK: 0, RUNTIME: 1, GATE: 2, ENV: 3 });
    expect(Object.values(EXIT)).not.toContain(64);
  });
});

describe("planRun:参数与环境门(守门开始之前)", () => {
  const env = { [DEFAULT_TOKEN_ENV]: "tok" };

  it("只传 --push 不传 --execute → 参数错误,退出码 3", () => {
    const plan = planRun(["--task", TASK, "--push"], env);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.exitCode).toBe(3);
  });

  it("未知参数 → 参数错误,退出码 3", () => {
    const plan = planRun(["--task", TASK, "--force"], env);
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.exitCode).toBe(3);
      expect(plan.error).toContain("unknown option: --force");
      expect(plan.usage).toContain("node scripts/land.mjs --task <uuid>");
    }
  });

  it("缺少 token 环境变量 → 环境错误,退出码 3 且 fail-closed", () => {
    const plan = planRun(["--task", TASK], {});
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.exitCode).toBe(3);
      expect(plan.error).toContain("WORKER_API_TOKEN is not set");
    }
  });

  it("缺 --task / 选项没有取值 → 同为 3", () => {
    for (const argv of [[], ["--api", "https://x"], ["--task", "--execute"], ["--task", TASK, "--token-env"]]) {
      const plan = planRun(argv, env);
      expect(plan.ok, JSON.stringify(argv)).toBe(false);
      if (!plan.ok) expect(plan.exitCode, JSON.stringify(argv)).toBe(3);
    }
  });

  it("--token-env 指名别的变量时按那个变量读", () => {
    const plan = planRun(["--task", TASK, "--token-env", "LAND_TOKEN"], { LAND_TOKEN: "t2" });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.opts.tokenEnv).toBe("LAND_TOKEN");
  });
});

describe("parseArgs / resolveToken", () => {
  it("默认值:dry-run、平台地址、token 变量名", () => {
    const parsed = parseArgs(["--task", TASK]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.opts).toEqual({
        task: TASK,
        api: DEFAULT_API,
        tokenEnv: DEFAULT_TOKEN_ENV,
        execute: false,
        push: false,
        worktree: null,
      });
    }
  });

  it("--execute --push 同传才成立;等号形式与末尾斜杠也吃", () => {
    const parsed = parseArgs(["--task", TASK, "--api", "https://x.example/", "--execute", "--push", "--worktree=/tmp/wt"]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.opts).toMatchObject({ api: "https://x.example", execute: true, push: true, worktree: "/tmp/wt" });
    }
  });

  it("flag 带值、多余位置参数、task 里带斜杠都是参数错误", () => {
    for (const argv of [["--task", TASK, "--execute=yes"], ["--task", TASK, "extra"], ["--task", "../../etc/passwd"]]) {
      expect(parseArgs(argv).ok, JSON.stringify(argv)).toBe(false);
    }
  });

  it("token 为空串/纯空格也算缺失(fail-closed,不降级跑)", () => {
    expect(resolveToken({ WORKER_API_TOKEN: "" }, DEFAULT_TOKEN_ENV).ok).toBe(false);
    expect(resolveToken({ WORKER_API_TOKEN: "   " }, DEFAULT_TOKEN_ENV).ok).toBe(false);
    expect(resolveToken({ WORKER_API_TOKEN: "tok" }, DEFAULT_TOKEN_ENV)).toEqual({ ok: true, token: "tok" });
  });
});

describe("守门链:任一门不过即终止", () => {
  it("① patch digest 不匹配 → 退出码 2,且在 apply 前终止:一次 git 写操作都没有", async () => {
    const { deps, calls } = fakeDeps({
      fetchPatch: async () => new TextEncoder().encode(PATCH_TEXT.replace("hi", "bye")),
    });
    const outcome = await runGate(landOpts({ execute: true, push: true }), deps);

    expect(outcome.exitCode).toBe(EXIT.GATE);
    expect(outcome.gates).toEqual({ done_state: true, manifest_cross: true, digest_ok: false, apply_ok: null, tests_ok: null });
    for (const step of GIT_WRITE_STEPS) expect(calls, step).not.toContain(step);
    // 读操作照常发生:证明确实是「走到 c 门才停」,而不是根本没跑起来
    expect(calls).toContain("fetchPatch");
    expect(calls).toContain("sha256Hex");
    expect(calls).not.toContain("closeWorktree");
  });

  it("② state 非 DONE → 退出码 2,且不再去取证据", async () => {
    const { deps, calls } = fakeDeps({ fetchTask: async () => taskResponse({ state: "AWAITING_HUMAN" }) });
    const outcome = await runGate(landOpts({ execute: true, push: true }), deps);

    expect(outcome.exitCode).toBe(2);
    expect(outcome.gates.done_state).toBe(false);
    expect(outcome.committed).toBe(false);
    expect(outcome.pushed).toBe(false);
    expect(calls).not.toContain("fetchEvidence");
    for (const step of GIT_WRITE_STEPS) expect(calls, step).not.toContain(step);
  });

  it("DONE 但 base.sha 不是全长 commit sha → 同样是守门拒绝", async () => {
    const { deps } = fakeDeps({ fetchTask: async () => taskResponse({ base: { sha: "0a1b2c3", source: "pinned" } }) });
    const outcome = await runGate(landOpts(), deps);
    expect(outcome.exitCode).toBe(EXIT.GATE);
    expect(outcome.reason).toContain("base.sha");
  });

  it("evidence.digest 与 task.current_evidence 不一致 → 拒绝,且不取候选", async () => {
    const { deps, calls } = fakeDeps({ fetchEvidence: async () => evidenceResponse({ digest: "e".repeat(64) }) });
    const outcome = await runGate(landOpts(), deps);
    expect(outcome.exitCode).toBe(EXIT.GATE);
    expect(outcome.gates).toEqual({ done_state: true, manifest_cross: false, digest_ok: null, apply_ok: null, tests_ok: null });
    expect(calls).not.toContain("fetchPatch");
    for (const step of GIT_WRITE_STEPS) expect(calls, step).not.toContain(step);
  });

  it("DONE 却没钉住 current_evidence → 拒绝(fail-closed,不因缺字段而放过)", async () => {
    const { deps } = fakeDeps({ fetchTask: async () => taskResponse({ current_evidence: null }) });
    expect((await runGate(landOpts(), deps)).exitCode).toBe(EXIT.GATE);
  });

  it("manifest 里没有 patch → 无 digest 可比,拒绝", async () => {
    const { deps, calls } = fakeDeps({
      fetchEvidence: async () => {
        const ev = evidenceResponse() as Record<string, any>;
        delete ev.manifest.patch;
        return ev;
      },
    });
    const outcome = await runGate(landOpts(), deps);
    expect(outcome.exitCode).toBe(EXIT.GATE);
    expect(calls).not.toContain("openWorktree");
  });

  it("git apply --check 失败 → apply_ok=false 且不进验证/提交,临时 worktree 被回收", async () => {
    const { deps, calls } = fakeDeps({ applyCheck: async () => ({ ok: false, detail: "patch does not apply" }) });
    const outcome = await runGate(landOpts({ execute: true }), deps);
    expect(outcome.exitCode).toBe(EXIT.GATE);
    expect(outcome.gates).toEqual({ done_state: true, manifest_cross: true, digest_ok: true, apply_ok: false, tests_ok: null });
    expect(calls).not.toContain("runTests");
    expect(calls).not.toContain("commit");
    expect(calls).toContain("closeWorktree");
  });

  it("npm test 失败 → 守门拒绝(2),不是执行期故障(1),且绝不 commit", async () => {
    const { deps, calls } = fakeDeps({ runTests: async () => ({ ok: false, passed: 3, detail: "3 failed" }) });
    const outcome = await runGate(landOpts({ execute: true, push: true }), deps);
    expect(outcome.exitCode).toBe(EXIT.GATE);
    expect(outcome.gates.tests_ok).toBe(false);
    expect(calls).not.toContain("commit");
    expect(calls).not.toContain("push");
  });

  it("npm ci 失败 → 环境侧故障(1),不冒充候选裁决(2)", async () => {
    const { deps, calls } = fakeDeps({ install: async () => ({ ok: false, detail: "registry unreachable" }) });
    const outcome = await runGate(landOpts({ execute: true }), deps);
    expect(outcome.exitCode).toBe(EXIT.RUNTIME);
    expect(outcome.gates.tests_ok).toBe(null);
    expect(calls).not.toContain("commit");
  });
});

describe("顺序不变量:commit 先于 push", () => {
  it("dry-run(不带 --execute)跑完五道门,但绝不 commit/push", async () => {
    const { deps, calls } = fakeDeps();
    const outcome = await runGate(landOpts(), deps);
    expect(outcome.exitCode).toBe(EXIT.OK);
    for (const key of GATE_KEYS) expect(outcome.gates[key], key).toBe(true);
    expect(calls).toContain("runTests");
    expect(calls).not.toContain("commit");
    expect(calls).not.toContain("push");
    expect(outcome.commitSha).toBe(null);
  });

  it("--execute --push 全绿:commit 在 push 之前,commit_sha 落地", async () => {
    const { deps, calls, messages } = fakeDeps();
    const outcome = await runGate(landOpts({ execute: true, push: true }), deps);
    expect(outcome.exitCode).toBe(EXIT.OK);
    expect(calls.slice(calls.indexOf("runTests"))).toEqual(["runTests", "commit", "push", "closeWorktree"]);
    expect(outcome).toMatchObject({ committed: true, pushed: true, commitSha: COMMIT_SHA });
    expect(messages).toHaveLength(1);
  });

  it("③ commit 抛错 → push 绝不执行", async () => {
    const { deps, calls } = fakeDeps({
      commit: async () => {
        throw new Error("staged tree is empty");
      },
    });
    await expect(runGate(landOpts({ execute: true, push: true }), deps)).rejects.toThrow(/staged tree/);
    expect(calls).not.toContain("push");
    expect(calls).toContain("closeWorktree");
  });

  it("即使 opts 自相矛盾(push 而无 execute)也不 push —— 不依赖上游校验", async () => {
    const { deps, calls } = fakeDeps();
    const outcome = await runGate(landOpts({ push: true }), deps);
    expect(outcome.exitCode).toBe(EXIT.OK);
    expect(outcome.pushed).toBe(false);
    expect(calls).not.toContain("push");
    expect(calls).not.toContain("commit");
  });
});

describe("摘要形状与提交信息", () => {
  it("stdout 摘要:键固定为 task/gate/committed/pushed/commit_sha,未执行到的门是 null", async () => {
    const { deps } = fakeDeps({ applyPatch: async () => ({ ok: false, detail: "nope" }) });
    const line = summaryLine(await runGate(landOpts(), deps));
    expect(line.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(line)).toEqual({
      task: TASK,
      gate: { done_state: true, manifest_cross: true, digest_ok: true, apply_ok: false, tests_ok: null },
      committed: false,
      pushed: false,
      commit_sha: null,
    });
  });

  it("dry-run 全绿的摘要:committed/pushed=false、commit_sha=null,gate 五键有序", async () => {
    const { deps } = fakeDeps();
    const parsed = JSON.parse(summaryLine(await runGate(landOpts(), deps)));
    expect(parsed).toMatchObject({ task: TASK, committed: false, pushed: false, commit_sha: null });
    expect(Object.keys(parsed.gate)).toEqual([...GATE_KEYS]);
  });

  it("落地后的摘要带 commit_sha 且 committed/pushed 为真", async () => {
    const { deps } = fakeDeps();
    const parsed = JSON.parse(summaryLine(await runGate(landOpts({ execute: true, push: true }), deps)));
    expect(parsed).toMatchObject({ committed: true, pushed: true, commit_sha: COMMIT_SHA });
  });

  it("commit 信息逐字含四要素 + 真实验证摘要,base sha 未被截断", () => {
    const msg = buildCommitMessage({
      task: TASK,
      baseSha: BASE_SHA,
      patchDigest: PATCH_DIGEST,
      bindingDigest: BINDING_DIGEST,
      typecheckOut: "ok",
      testsPassed: 214,
    });
    for (const needle of [TASK, BASE_SHA, PATCH_DIGEST, BINDING_DIGEST, "tests 214 passed"]) {
      expect(msg).toContain(needle);
    }
    expect(msg).toMatch(new RegExp(`^base: ${BASE_SHA}$`, "m"));
    expect(msg.split("\n")[1]).toBe(""); // 标题与正文之间留空行,git 才把四要素当 body 而不是标题延续
  });

  it("runGate 交给 commit 的信息里,patch sha256 就是重算出来的那个", async () => {
    const { deps, messages } = fakeDeps();
    await runGate(landOpts({ execute: true }), deps);
    expect(messages[0]).toContain(`patch-sha256: ${PATCH_DIGEST}`);
    expect(messages[0]).toContain(`base: ${BASE_SHA}`);
    expect(messages[0]).toContain(`binding-digest: ${BINDING_DIGEST}`);
    expect(messages[0]).toContain(`land: task ${TASK} candidate`);
  });
});
