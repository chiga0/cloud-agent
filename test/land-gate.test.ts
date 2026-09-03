import { beforeAll, describe, expect, it } from "vitest";
import {
  buildCommitMessage,
  DEFAULT_API,
  DEFAULT_TOKEN_ENV,
  EXIT,
  GATE_KEYS,
  NEXT_TERMINAL_STATES,
  POLL_INTERVAL_MS,
  POLL_MAX_CONSECUTIVE_FAILURES,
  POLL_MAX_ROUNDS,
  parseArgs,
  parseTestCount,
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

/** h/i 两段的材料:下一任务的 spec 原文 + 平台返回的新 id。 */
const NEXT_SPEC_TEXT = '{"spec":{"prompt":"接着上一轮","repo_url":"https://github.com/octocat/Hello-World"},"budget":{"max_wall_seconds":1800}}';
const NEXT_ID = "11111111-2222-3333-4444-555555555555";

function fakeDeps(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const messages: string[] = [];
  const logs: string[] = [];
  /** POST /tasks 实际发出的 body —— 用来钉「脚本不改写 spec 文件」。 */
  const nextBodies: unknown[] = [];
  /** 每次 GET /tasks/<id> 时看到的 state 序列由 over.fetchTaskState 决定,这里只记账。 */
  const stateAsks: string[] = [];
  const sleeps: number[] = [];
  const pass = { ok: true, detail: "" };
  const impl: Record<string, (...args: any[]) => unknown> = {
    log: (step: string, status: string, detail: string) => logs.push(`${step} ${status} ${detail}`),
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
    readSpecFile: () => ({ ok: true, text: NEXT_SPEC_TEXT }),
    postNext: (_opts: unknown, text: string) => (nextBodies.push(text), NEXT_ID),
    // 默认第一问即终态:没显式关心轮询次数的用例不会在循环里空转 90 轮。
    fetchTaskState: (_opts: unknown, id: string) => (stateAsks.push(id), "DONE"),
    sleep: (ms: number) => sleeps.push(ms),
    ...over,
  };
  // 调用记录统一由注入层包一层:覆写某个 dep 时不会把「这次到底有没有被叫到」的账一起丢掉。
  const deps: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(impl)) {
    deps[name] = name === "log" ? fn : async (...args: unknown[]) => (calls.push(name), await fn(...args));
  }
  return { deps, calls, messages, logs, nextBodies, stateAsks, sleeps };
}

/** 绕过 parseArgs 直接造 opts,以便单列测「即使 opts 自相矛盾也不许 push」。 */
function landOpts(over: Record<string, unknown> = {}) {
  return {
    task: TASK,
    api: DEFAULT_API,
    tokenEnv: DEFAULT_TOKEN_ENV,
    execute: false,
    push: false,
    worktree: null,
    next: null,
    wait: false,
    ...over,
  };
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

  it("--next 缺 --push → 参数错误 3(--next ⇒ --push ⇒ --execute 链式依赖)", () => {
    for (const argv of [
      ["--task", TASK, "--next", "backlog/next.json"],
      ["--task", TASK, "--execute", "--next", "backlog/next.json"],
    ]) {
      const plan = planRun(argv, env);
      expect(plan.ok, JSON.stringify(argv)).toBe(false);
      if (!plan.ok) {
        expect(plan.exitCode).toBe(3);
        expect(plan.error).toContain("--next requires --push");
        expect(plan.usage).toContain("[--next <file>] [--wait]");
      }
    }
  });

  it("--wait 缺 --next → 参数错误 3(即使 --push 已给)", () => {
    const plan = planRun(["--task", TASK, "--execute", "--push", "--wait"], env);
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.exitCode).toBe(3);
      expect(plan.error).toContain("--wait requires --next");
    }
  });

  it("整条链 --execute --push --next --wait 齐备才通过;等号形式同样吃", () => {
    const plan = planRun(["--task", TASK, "--execute", "--push", "--next=backlog/next.json", "--wait"], env);
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.opts).toMatchObject({ next: "backlog/next.json", wait: true, push: true, execute: true });
  });

  it("--next 只给旗子不给取值 → 3(与其它取值选项同口径)", () => {
    for (const argv of [["--task", TASK, "--execute", "--push", "--next"], ["--task", TASK, "--execute", "--push", "--next", "--wait"]]) {
      const plan = planRun(argv, env);
      expect(plan.ok, JSON.stringify(argv)).toBe(false);
      if (!plan.ok) expect(plan.exitCode).toBe(3);
    }
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
        next: null,
        wait: false,
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

  /**
   * c12 在执行面让被墙钟击杀的差量自称不完整(`patch_complete: false` + 原因)。
   * 落地端是唯一不可逆的动作:一份在途差量即使 digest 对得上、即使能干净 apply,
   * 也不是候选 —— 它从未按「完整候选」的口径被验证过。门必须自己读 manifest 拦下,
   * 不能依赖调用方去看 `x-patch-complete` 头。
   */
  it("manifest 自称补丁不完整 → 拒绝且不取补丁本体,更不碰 git", async () => {
    const { deps, calls } = fakeDeps({
      fetchEvidence: async () =>
        evidenceResponse({
          manifest: Object.assign({}, (evidenceResponse() as Record<string, any>).manifest, {
            patch_complete: false,
            patch_incomplete_reason: "budget_abort(exit=55)",
          }),
        }),
    });
    const outcome = await runGate(landOpts({ execute: true, push: true }), deps);
    expect(outcome.exitCode).toBe(EXIT.GATE);
    expect(outcome.reason).toContain("budget_abort(exit=55)");
    expect(outcome.gates).toEqual({ done_state: true, manifest_cross: true, digest_ok: false, apply_ok: null, tests_ok: null });
    expect(calls).not.toContain("fetchPatch");
    for (const step of GIT_WRITE_STEPS) expect(calls, step).not.toContain(step);
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

/**
 * 迭代循环续命段(h 提交下一任务 / i 轮询到终态)。
 *
 * 这一节钉的是本期核心不变量:**未 push 成功绝不 POST 下一任务**。本轮改动没进远端就派下一
 * 任务,下一轮会在缺本轮成果的基线上重跑 —— 对无人值守循环来说这比报错更糟,因为它会一直
 * 「成功」。轮询侧钉的是两条放弃线:瞬态要容忍(一次 5xx 不该断循环),而连续问不到与超时
 * 必须是退出码 1(报的是环境,不是对下一任务质量的裁决)。
 */
describe("迭代循环续命段:--next / --wait", () => {
  /** 按脚本喂 state 序列并记轮数;数组耗尽后重复最后一个值(超时用例要它一直不动)。 */
  function stateScript(states: (string | Error)[]) {
    const asked: string[] = [];
    const fn = async (_opts: unknown, id: string): Promise<string> => {
      const value = asked.length < states.length ? states[asked.length] : states[states.length - 1];
      asked.push(id);
      if (value instanceof Error) throw value;
      return value;
    };
    return { fn, asked };
  }

  it("① dry-run(未 commit 未 push)带 --next --wait → 绝不 POST、绝不轮询,两字段为 null", async () => {
    const { deps, calls, logs, stateAsks } = fakeDeps();
    const outcome = await runGate(landOpts({ next: "backlog/next.json", wait: true }), deps);

    expect(outcome.exitCode).toBe(EXIT.OK);
    expect(calls).not.toContain("postNext");
    expect(calls).not.toContain("readSpecFile");
    expect(calls).not.toContain("fetchTaskState");
    expect(stateAsks).toEqual([]);
    expect(outcome).toMatchObject({ nextTask: null, nextState: null });
    // 跳过必须喊出来:静默跳过等于让读日志的人以为下一任务已经派出去了
    expect(logs.some((line) => line.startsWith("next skip") && line.includes("绝不 POST 下一任务"))).toBe(true);
    expect(logs.some((line) => line.startsWith("wait skip"))).toBe(true);
  });

  it("② 已 commit 但未 push(--execute 单传)→ 同样绝不 POST", async () => {
    const { deps, calls } = fakeDeps();
    const outcome = await runGate(landOpts({ execute: true, next: "backlog/next.json", wait: true }), deps);
    expect(outcome.pushed).toBe(false);
    expect(calls).toContain("commit");
    expect(calls).not.toContain("push");
    expect(calls).not.toContain("postNext");
  });

  it("③ push 抛错(远端拒绝)→ 下一任务不提交,故障原样上抛", async () => {
    const { deps, calls } = fakeDeps({
      push: async () => {
        throw new Error("non-fast-forward");
      },
    });
    await expect(
      runGate(landOpts({ execute: true, push: true, next: "backlog/next.json", wait: true }), deps),
    ).rejects.toThrow(/non-fast-forward/);
    expect(calls).not.toContain("postNext");
    expect(calls).toContain("closeWorktree");
  });

  it("④ --next 提交成功 + --wait 轮询至终态:三次问、两次 sleep、next_state 落地", async () => {
    const script = stateScript(["RUNNING", "RUNNING", "DONE"]);
    const { deps, calls, nextBodies, sleeps } = fakeDeps({ fetchTaskState: script.fn });
    const outcome = await runGate(landOpts({ execute: true, push: true, next: "backlog/next.json", wait: true }), deps);

    expect(outcome.exitCode).toBe(EXIT.OK);
    expect(outcome.nextTask).toBe(NEXT_ID);
    expect(outcome.nextState).toBe("DONE");
    expect(script.asked).toEqual([NEXT_ID, NEXT_ID, NEXT_ID]);
    expect(sleeps).toEqual([POLL_INTERVAL_MS, POLL_INTERVAL_MS]); // 间隔 60s,末轮不再 sleep
    // POST 发的是文件**原文**:脚本不改写 spec 文件(它只是任务意图的权威副本)
    expect(nextBodies).toEqual([NEXT_SPEC_TEXT]);
    // 顺序:本轮 push 之后才 POST,POST 之后才开始问
    expect(calls.indexOf("push")).toBeLessThan(calls.indexOf("postNext"));
    expect(calls.indexOf("postNext")).toBeLessThan(calls.indexOf("fetchTaskState"));
    expect(JSON.parse(summaryLine(outcome))).toMatchObject({ pushed: true, next_task: NEXT_ID, next_state: "DONE" });
  });

  it("REJECTED / BLOCKED 也是终态,且不改本次运行的退出码(那是下一任务自己那一轮的裁决)", async () => {
    for (const [terminal, runs] of [["REJECTED", 2], ["BLOCKED", 4]] as const) {
      const { deps } = fakeDeps({ fetchTaskState: stateScript([...Array(runs).fill("RUNNING"), terminal]).fn });
      const outcome = await runGate(landOpts({ execute: true, push: true, next: "f.json", wait: true }), deps);
      expect(outcome.nextState).toBe(terminal);
      expect(outcome.exitCode).toBe(EXIT.OK);
    }
    expect(NEXT_TERMINAL_STATES).toEqual(["DONE", "REJECTED", "BLOCKED"]);
  });

  it("⑤ 瞬态容忍:连续 4 次问不到后恢复 → 不放弃,继续轮询到终态", async () => {
    const script = stateScript([
      new Error("HTTP 503"),
      new Error("fetch failed"),
      new Error("HTTP 502"),
      new Error("socket hang up"),
      "RUNNING",
      "RUNNING",
      "DONE",
    ]);
    const { deps, sleeps } = fakeDeps({ fetchTaskState: script.fn });
    const outcome = await runGate(landOpts({ execute: true, push: true, next: "f.json", wait: true }), deps);

    expect(outcome.exitCode).toBe(EXIT.OK);
    expect(outcome.nextState).toBe("DONE");
    expect(script.asked).toHaveLength(7);
    // 抖动轮同样要 sleep:否则「连续失败」会变成对平台的猛击
    expect(sleeps).toHaveLength(6);
  });

  it("⑥ 连续 5 次问不到 → 判为故障而非「还没好」,退出码 1 且 next_state 不落地", async () => {
    const script = stateScript(Array(POLL_MAX_CONSECUTIVE_FAILURES).fill(new Error("HTTP 500")));
    const { deps } = fakeDeps({ fetchTaskState: script.fn });
    const outcome = await runGate(landOpts({ execute: true, push: true, next: "f.json", wait: true }), deps);

    expect(outcome.exitCode).toBe(EXIT.RUNTIME);
    expect(outcome.nextTask).toBe(NEXT_ID); // 下一任务确实提交了 —— 摘要不能撒谎说没提交
    expect(outcome.nextState).toBe(null);
    expect(script.asked).toHaveLength(POLL_MAX_CONSECUTIVE_FAILURES);
    expect(outcome.reason).toContain("连续 5 次问不到");
  });

  it("⑦ 轮询超时(90 分钟预算用完仍非终态)→ 退出码 1,轮数正好用满预算", async () => {
    const script = stateScript(["RUNNING"]);
    const { deps, sleeps } = fakeDeps({ fetchTaskState: script.fn });
    const outcome = await runGate(landOpts({ execute: true, push: true, next: "f.json", wait: true }), deps);

    expect(outcome.exitCode).toBe(EXIT.RUNTIME);
    expect(outcome.nextState).toBe(null);
    expect(script.asked).toHaveLength(POLL_MAX_ROUNDS);
    expect(sleeps).toHaveLength(POLL_MAX_ROUNDS - 1);
    expect(POLL_MAX_ROUNDS * POLL_INTERVAL_MS).toBe(90 * 60_000); // 轮数 × 间隔 = 承诺的 90 分钟
    expect(outcome.reason).toContain("超时");
  });

  it("⑧ spec 文件读不到/不是合法 JSON → 退出码 3、摘要照打(next_task=null)、不再 POST", async () => {
    for (const read of [
      { ok: false, detail: "read /repo/backlog/next.json failed: ENOENT" },
      { ok: false, detail: "next.json is not valid JSON: Unexpected token" },
    ]) {
      const { deps, calls } = fakeDeps({ readSpecFile: async () => read });
      const outcome = await runGate(landOpts({ execute: true, push: true, next: "f.json", wait: true }), deps);
      const parsed = JSON.parse(summaryLine(outcome));

      expect(outcome.exitCode, JSON.stringify(read)).toBe(EXIT.ENV);
      expect(parsed.next_task).toBe(null);
      expect(parsed.next_state).toBe(null);
      expect(parsed.pushed).toBe(true); // 本轮确实落地了:这条摘要照打才有意义
      expect(calls).not.toContain("postNext");
      expect(calls).not.toContain("fetchTaskState");
      expect(outcome.reason, JSON.stringify(read)).toContain("spec 文件不可用");
    }
  });

  it("POST /tasks 失败(平台 4xx)与 get() 同口径上抛,不把 null 记成已提交、也不去等", async () => {
    const { deps, calls } = fakeDeps({
      postNext: async () => {
        throw new Error("POST /tasks → HTTP 400 invalid_spec");
      },
    });
    await expect(
      runGate(landOpts({ execute: true, push: true, next: "f.json", wait: true }), deps),
    ).rejects.toThrow(/invalid_spec/);
    expect(calls).not.toContain("fetchTaskState"); // 没有 id 就没有可等的对象
  });

  it("不带 --next 时 h/i 两段完全不存在 —— 既有 a–g 行为零变化", async () => {
    const { deps, calls } = fakeDeps();
    const outcome = await runGate(landOpts({ execute: true, push: true }), deps);
    expect(outcome.exitCode).toBe(EXIT.OK);
    for (const step of ["readSpecFile", "postNext", "fetchTaskState", "sleep"]) expect(calls, step).not.toContain(step);
    expect(calls.slice(calls.indexOf("runTests"))).toEqual(["runTests", "commit", "push", "closeWorktree"]);
  });
});

describe("摘要形状与提交信息", () => {
  it("stdout 摘要:键固定为 task/gate/committed/pushed/commit_sha/next_task/next_state,未执行到的门是 null", async () => {
    const { deps } = fakeDeps({ applyPatch: async () => ({ ok: false, detail: "nope" }) });
    const line = summaryLine(await runGate(landOpts(), deps));
    expect(line.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(line)).toEqual({
      task: TASK,
      gate: { done_state: true, manifest_cross: true, digest_ok: true, apply_ok: false, tests_ok: null },
      committed: false,
      pushed: false,
      commit_sha: null,
      next_task: null,
      next_state: null,
    });
  });

  it("dry-run 全绿的摘要:committed/pushed=false、commit_sha=null、next_task/next_state=null,gate 五键有序", async () => {
    const { deps } = fakeDeps();
    const parsed = JSON.parse(summaryLine(await runGate(landOpts(), deps)));
    expect(parsed).toMatchObject({ task: TASK, committed: false, pushed: false, commit_sha: null, next_task: null, next_state: null });
    expect(Object.keys(parsed.gate)).toEqual([...GATE_KEYS]);
    // 新增两字段必须在摘要里存在(即使为 null)—— 无人值守的读者靠键的存在判断「这一段跑过了」
    expect(Object.keys(parsed)).toEqual(["task", "gate", "committed", "pushed", "commit_sha", "next_task", "next_state"]);
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

/**
 * parseTestCount 的契约钉在**真实 vitest 输出字节**上(2026-09-02 C6a 冒烟取证:
 * TERM=xterm-256color 下 vitest 输出带 ANSI 色码,Tests 标签与数字之间隔着 ESC 序列)。
 * 这又是反模式 17 的活体:注入层给的都是已解析好的 {ok, passed},真实输出形状零覆盖
 * —— 旧正则在带码输出上永远失配,回落咬住 Test Files 的文件数(15 ≠ 230)。
 */
describe("parseTestCount(真实 vitest 输出字节)", () => {
  // 汇总两行是 2026-09-02 冒烟捕获的逐字节原文(npm test 输出重定向进文件仍带码)。
  const REAL_VITEST_SUMMARY = [
    "> cloud-agent@0.1.0 test\n> vitest run\n",
    "\x1b[2m Test Files \x1b[22m \x1b[1m\x1b[32m16 passed\x1b[39m\x1b[22m\x1b[90m (16)\x1b[39m",
    "\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[32m258 passed\x1b[39m\x1b[22m\x1b[90m (258)\x1b[39m",
    "   Duration  41.02s",
  ].join("\n");

  it("带 ANSI 色码的真实汇总:取 Tests 行的用例数 258,不是 Test Files 的文件数 16", () => {
    expect(parseTestCount(REAL_VITEST_SUMMARY)).toBe(258);
  });

  it("无色码的汇总行同样取用例数", () => {
    expect(parseTestCount(" Test Files  15 passed (15)\n      Tests  230 passed (230)\n")).toBe(230);
  });

  it("只有 Test Files 行时回落取文件数 —— 有数字好于 0,但语义是文件数", () => {
    expect(parseTestCount(" Test Files  15 passed (15)\n")).toBe(15);
  });

  it("解析不出如实返回 0,绝不编数;null/undefined 同样 0", () => {
    expect(parseTestCount("no summary here")).toBe(0);
    expect(parseTestCount("")).toBe(0);
    expect(parseTestCount(null)).toBe(0);
    expect(parseTestCount(undefined)).toBe(0);
  });
});
