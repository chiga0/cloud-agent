/**
 * 落地守门器的纯逻辑:参数解析、鉴权环境变量解析、五道门的状态机、摘要形状。
 *
 * 本文件刻意不 import node:fs / node:child_process / node:crypto,也不读 process.env ——
 * 一切副作用经 `deps` 注入。这样 test/land-gate.test.ts 能在 vitest(workerd)里用假
 * deps 直接钉住「digest 不匹配时绝不碰 git」「未 commit 时绝不 push」这类不变量:
 * 守门器的价值在于它**不会做什么**,而那些恰恰是最难靠真进程验证的断言。
 * 真 git/npm/HTTP 的实现留在 land.mjs(薄壳),那部分靠真实运行验证。
 *
 * 退出码 —— 对外的唯一口径,land.mjs、README 退出码表、测试三处必须一致:
 * - 0 成功。守门链全绿:dry-run 表示「可以落地」,--execute 表示已 commit(--push 则已 push)。
 * - 1 执行期故障。网络、git/npm 子进程本身、install、commit/push 失败 —— 这是对**环境**的
 *   报告,不是对候选的裁决,因此不占用 2。
 * - 2 守门拒绝。五道门(done_state / manifest_cross / digest_ok / apply_ok / tests_ok)任一不过。
 * - 3 环境或参数错误。usage 错误(只传 --push、未知参数、缺 --task、选项取值缺失)、
 *   鉴权环境变量缺失、目标目录不是 git 仓库。这类失败发生在守门开始**之前**,
 *   所以 stdout 不输出摘要 JSON —— 一道门也没被评估过,打出来只会误导读数。
 *
 * 并发:不做落地锁。前提是单机单循环(一次只 land 一个 task),这是刻意接受的边界。
 */

export const EXIT = Object.freeze({ OK: 0, RUNTIME: 1, GATE: 2, ENV: 3 });

export const DEFAULT_API = "https://cloud-agent.aflow.workers.dev";
export const DEFAULT_TOKEN_ENV = "WORKER_API_TOKEN";

export const USAGE =
  "usage: node scripts/land.mjs --task <uuid> [--api <url>] [--token-env <NAME>] [--execute] [--push] [--worktree <dir>]";

/**
 * @typedef {Object} LandOptions
 * @property {string} task
 * @property {string} api
 * @property {string} tokenEnv
 * @property {boolean} execute
 * @property {boolean} push
 * @property {string|null} worktree
 */

/** 守门链的五道门,顺序即执行顺序(null = 尚未执行到,不是「不过」)。 */
export const GATE_KEYS = Object.freeze([
  "done_state",
  "manifest_cross",
  "digest_ok",
  "apply_ok",
  "tests_ok",
]);

const VALUE_OPTS = new Set(["--task", "--api", "--token-env", "--worktree"]);
const FLAG_OPTS = new Set(["--execute", "--push"]);

/**
 * task id 要拼进 URL path,worktree/api 要进 argv 与 cwd —— 用户输入是唯一的校验点,
 * 因此这里只做字符集与相邻选项的约束,不做业务校验。
 */
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * 只解析、只判形状,不碰 process.argv 也不 exit —— 便于把「哪种错误算参数错误」这件事
 * 钉在测试里(退出码 3 的整条映射都由这里喂给 land.mjs)。
 *
 * @param {string[]} argv
 * @returns {{ok: true, opts: LandOptions} | {ok: false, error: string, usage: string}}
 */
export function parseArgs(argv) {
  /** @type {LandOptions} */
  const opts = {
    task: "",
    api: DEFAULT_API,
    tokenEnv: DEFAULT_TOKEN_ENV,
    execute: false,
    push: false,
    worktree: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (typeof token !== "string" || !token.startsWith("--")) {
      return usage(`unexpected argument: ${JSON.stringify(token)}`);
    }
    const eq = token.indexOf("=");
    const flag = eq > 0 ? token.slice(0, eq) : token;
    let inline = eq > 0 ? token.slice(eq + 1) : null;
    if (inline === "") return usage(`${flag} requires a value`);

    if (FLAG_OPTS.has(flag)) {
      if (inline !== null) return usage(`${flag} is a boolean flag, it takes no value`);
      opts[flag === "--execute" ? "execute" : "push"] = true;
      continue;
    }
    if (!VALUE_OPTS.has(flag)) return usage(`unknown option: ${flag}`);

    let value = inline;
    if (value === null) {
      value = argv[i + 1];
      i += 1;
    }
    if (typeof value !== "string" || value === "") return usage(`${flag} requires a value`);
    if (value.startsWith("--")) return usage(`${flag} requires a value (got ${flag})`);
    if (flag === "--task") opts.task = value;
    else if (flag === "--api") opts.api = value.replace(/\/+$/, "");
    else if (flag === "--token-env") opts.tokenEnv = value;
    else opts.worktree = value;
  }

  if (opts.task === "") return usage("--task <uuid> is required");
  if (!TASK_ID_RE.test(opts.task)) return usage(`--task is not a valid id: ${JSON.stringify(opts.task)}`);
  // --push 单独出现一定是误用:落地端唯一的写远端动作,必须先过 --execute 这道显式意图门。
  if (opts.push && !opts.execute) return usage("--push requires --execute (dry-run never pushes)");
  return { ok: true, opts };
}

/** @param {string} error */
function usage(error) {
  return { ok: false, error, usage: USAGE };
}

/**
 * 鉴权 token 从**指名的环境变量**现读(每个 HTTP 请求各调一次,绝不缓存、绝不落盘)。
 * 缺失即 fail-closed:平台侧只读,落地端没有 token 就什么都做不了,不存在降级路径。
 *
 * @param {Record<string, string|undefined>} env
 * @param {string} tokenEnv
 * @returns {{ok: true, token: string} | {ok: false, error: string}}
 */
export function resolveToken(env, tokenEnv) {
  const value = env && typeof env === "object" ? env[tokenEnv] : undefined;
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, error: `auth token missing: env ${tokenEnv} is not set (fail-closed)` };
  }
  return { ok: true, token: value };
}

/**
 * 守门开始**之前**的全部失败(参数 + 环境)收敛到这一个函数、一个退出码(3)。
 * 之所以由纯函数而不是 land.mjs 的 if 链决定退出码:退出码是对无人值守循环的接口,
 * 「哪种失败算环境错误」必须被测试钉住,而不是靠壳里的分支被执行过一次才知道。
 *
 * @param {string[]} argv
 * @param {Record<string, string|undefined>} env
 * @returns {{ok: true, opts: LandOptions} | {ok: false, exitCode: number, error: string, usage?: string}}
 */
export function planRun(argv, env) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) return { ok: false, exitCode: EXIT.ENV, error: parsed.error, usage: parsed.usage };
  const tok = resolveToken(env, parsed.opts.tokenEnv);
  if (!tok.ok) return { ok: false, exitCode: EXIT.ENV, error: tok.error };
  return { ok: true, opts: parsed.opts };
}

/**
 * 提交信息是「落地了什么」的唯一离线凭据,所以四要素必须逐字在内:task_id、base sha 全长、
 * patch sha256、binding digest,外加一行真实验证摘要(数字来自 npm test 的实际输出)。
 *
 * @param {{task:string, baseSha:string, patchDigest:string, bindingDigest:string, typecheckOut:string, testsPassed:number}} info
 * @returns {string}
 */
export function buildCommitMessage(info) {
  return [
    `land: task ${info.task} candidate (patch sha256:${info.patchDigest})`,
    "",
    `task: ${info.task}`,
    `base: ${info.baseSha}`,
    `patch-sha256: ${info.patchDigest}`,
    `binding-digest: ${info.bindingDigest}`,
    `verify: typecheck ${info.typecheckOut} / tests ${info.testsPassed} passed`,
  ].join("\n");
}

/**
 * @param {LandOptions} opts
 * @returns {{exitCode:number, task:string, gates:Record<string, boolean|null>, committed:boolean, pushed:boolean, commitSha:string|null, reason:string|null}}
 */
export function newOutcome(opts) {
  /** @type {Record<string, boolean|null>} */
  const gates = {};
  for (const key of GATE_KEYS) gates[key] = null;
  return { exitCode: EXIT.OK, task: opts.task, gates, committed: false, pushed: false, commitSha: null, reason: null };
}

/** stdout 的终局摘要:一行 JSON,机读优先,不加装饰。 */
export function summaryLine(outcome) {
  return JSON.stringify({
    task: outcome.task,
    gate: {
      done_state: outcome.gates.done_state,
      manifest_cross: outcome.gates.manifest_cross,
      digest_ok: outcome.gates.digest_ok,
      apply_ok: outcome.gates.apply_ok,
      tests_ok: outcome.gates.tests_ok,
    },
    committed: outcome.committed,
    pushed: outcome.pushed,
    commit_sha: outcome.commitSha,
  });
}

/**
 * 守门状态机。任一门不过即 return —— 后续步骤一次都不会执行,这是本函数的核心不变量:
 * 每一道门的判定材料都必须在下一道门的副作用**之前**拿到。
 *
 * deps(全部必填,由 land.mjs 提供真实实现,测试注入假实现):
 *   log(step, status, detail) / fetchTask(opts) / fetchEvidence(opts) / fetchPatch(opts)
 *   sha256Hex(bytes) / openWorktree(opts, baseSha) / closeWorktree(handle)
 *   applyCheck(handle, bytes) / applyPatch(handle, bytes) -> {ok, detail}
 *   install(handle) -> {ok, detail} / typecheck(handle) -> {ok, out, detail}
 *   runTests(handle) -> {ok, passed, detail} / commit(handle, message) -> sha / push(handle)
 *
 * @param {LandOptions} opts
 * @param {any} deps
 * @returns {Promise<{exitCode:number, task:string, gates:Record<string, boolean|null>, committed:boolean, pushed:boolean, commitSha:string|null, reason:string|null}>}
 */
export async function runGate(opts, deps) {
  const outcome = newOutcome(opts);
  const g = outcome.gates;
  /** @type {{dir:string, temp:boolean}|null} */
  let handle = null;

  /** 收口:记 exitCode + 原因,失败时把门名与判据原样打到 stderr。 */
  const refuse = (code, step, detail) => {
    outcome.exitCode = code;
    outcome.reason = `${step}: ${detail}`;
    deps.log(step, code === EXIT.GATE ? "fail" : "error", detail);
    return outcome;
  };

  try {
    // ── a. 平台状态必须是 DONE ────────────────────────────────────────────
    // DONE 意味着状态机里已有一条 approve/accept_with_notes 决策记录(平台不变量),
    // 所以这里读 state 就足够,不需要也无法再独立读 reviewer verdict。
    deps.log("state", "start", `GET ${opts.api}/tasks/${opts.task}`);
    const task = await deps.fetchTask(opts);
    const state = task && typeof task.state === "string" ? task.state : "";
    if (state !== "DONE") {
      g.done_state = false;
      return refuse(EXIT.GATE, "state", `task state is ${JSON.stringify(state)}, not "DONE" — 无决策记录即不落地`);
    }
    const baseSha = typeof task.base?.sha === "string" ? task.base.sha : "";
    // 冻结基线是 apply 的坐标;没有它,patch 只能对「当时那条默认分支」说话,不能落地。
    if (!/^[0-9a-f]{40,64}$/.test(baseSha)) {
      g.done_state = false;
      return refuse(EXIT.GATE, "state", `task.base.sha is not a full commit sha: ${JSON.stringify(baseSha)}`);
    }
    g.done_state = true;
    deps.log("state", "ok", `DONE base=${baseSha}`);

    // ── b. evidence.digest 与 task.current_evidence 交叉校验 ───────────────
    deps.log("evidence", "start", `GET ${opts.api}/tasks/${opts.task}/evidence`);
    const evidence = await deps.fetchEvidence(opts);
    const pinned = typeof task.current_evidence?.writer_manifest_digest === "string"
      ? task.current_evidence.writer_manifest_digest
      : null;
    if (!pinned) {
      g.manifest_cross = false;
      return refuse(EXIT.GATE, "evidence", "task.current_evidence.writer_manifest_digest 缺失 — DONE 却没有钉住证据,拒绝");
    }
    const evidenceDigest = typeof evidence?.digest === "string" ? evidence.digest : "";
    if (evidenceDigest !== pinned) {
      g.manifest_cross = false;
      return refuse(EXIT.GATE, "evidence", `manifest cross-check failed: evidence=${evidenceDigest} task.current_evidence=${pinned}`);
    }
    g.manifest_cross = true;
    deps.log("evidence", "ok", `digest=${evidenceDigest} binding=${evidence.binding_digest}`);

    // ── c. 逐字节重算候选 patch 的 sha256 —— 防篡改硬门 ─────────────────────
    // 到这一步为止所有校验读的都是「平台说」。这里第一次拿到本体并自己算一遍:
    // 不一致就是下发链路被动过,后面所有门都不必再看一眼。
    deps.log("candidate", "start", `GET ${opts.api}/tasks/${opts.task}/candidate?format=patch`);
    const patchDigest = typeof evidence?.manifest?.patch?.digest === "string"
      ? evidence.manifest.patch.digest
      : null;
    if (!patchDigest) {
      g.digest_ok = false;
      return refuse(EXIT.GATE, "candidate", "manifest.patch.digest 缺失 — 无 digest 可比,拒绝");
    }
    const patchBytes = await deps.fetchPatch(opts, evidence);
    const computed = await deps.sha256Hex(patchBytes);
    if (computed !== patchDigest) {
      g.digest_ok = false;
      return refuse(EXIT.GATE, "candidate", `patch digest mismatch: recomputed=${computed} manifest=${patchDigest}`);
    }
    g.digest_ok = true;
    deps.log("candidate", "ok", `sha256=${computed} bytes=${patchBytes.length}`);

    // ── d. 干净 worktree 上的干净 apply ───────────────────────────────────
    handle = await deps.openWorktree(opts, baseSha);
    deps.log("apply", "start", `git apply --check then apply in ${handle.dir}`);
    const checked = await deps.applyCheck(handle, patchBytes);
    if (!checked.ok) {
      g.apply_ok = false;
      return refuse(EXIT.GATE, "apply", `git apply --check failed: ${checked.detail}`);
    }
    const applied = await deps.applyPatch(handle, patchBytes);
    if (!applied.ok) {
      g.apply_ok = false;
      return refuse(EXIT.GATE, "apply", `git apply failed: ${applied.detail}`);
    }
    g.apply_ok = true;
    deps.log("apply", "ok", "clean apply on detached worktree");

    // ── e. 本地验证:typecheck + test ─────────────────────────────────────
    deps.log("install", "start", "npm ci --no-audit --no-fund");
    const ci = await deps.install(handle);
    if (!ci.ok) {
      // 装不上是环境事实(网络/registry/lock 与 node 版本),不是对候选的裁决 → 1。
      return refuse(EXIT.RUNTIME, "install", `npm ci failed: ${ci.detail}`);
    }
    deps.log("install", "ok", "");
    deps.log("typecheck", "start", "npm run typecheck");
    const tc = await deps.typecheck(handle);
    deps.log("typecheck", tc.ok ? "ok" : "fail", tc.detail);
    deps.log("test", "start", "npm test");
    const tests = tc.ok ? await deps.runTests(handle) : { ok: false, passed: 0, detail: "skipped: typecheck failed" };
    deps.log("test", tests.ok ? "ok" : "fail", tests.detail);
    g.tests_ok = tc.ok && tests.ok;
    if (!g.tests_ok) {
      return refuse(EXIT.GATE, "verify", `typecheck ${tc.ok ? "ok" : "fail"} / tests ${tests.ok ? `${tests.passed} passed` : "fail"}`);
    }

    // ── f. commit(仅 --execute)─────────────────────────────────────────
    if (opts.execute) {
      const message = buildCommitMessage({
        task: opts.task,
        baseSha,
        patchDigest,
        bindingDigest: String(evidence.binding_digest ?? ""),
        typecheckOut: tc.out ?? "ok",
        testsPassed: tests.passed,
      });
      deps.log("commit", "start", `git add -A && git commit in ${handle.dir}`);
      const sha = await deps.commit(handle, message);
      outcome.committed = true;
      outcome.commitSha = sha;
      deps.log("commit", "ok", `sha=${sha}`);
    } else {
      deps.log("commit", "skip", "dry-run: 不带 --execute 绝不 commit/push");
    }

    // ── g. push(仅 --push 且**已** commit)──────────────────────────────
    // 双条件门:committed 为真才允许推。dry-run / commit 失败 / commit 抛错都到不了这里。
    if (opts.push && outcome.committed) {
      deps.log("push", "start", "git push origin HEAD:main (never --force)");
      await deps.push(handle);
      outcome.pushed = true;
      deps.log("push", "ok", "HEAD:main");
    }
    return outcome;
  } catch (err) {
    // 故障路径上也把**已经判过**的门带上(未执行到的仍是 null),让 land.mjs 能打出
    // 一行诚实的摘要,而不是丢掉已有判定。但「为什么挂了」不冒充守门裁决。
    if (err && typeof err === "object") err.outcome = outcome;
    throw err;
  } finally {
    if (handle) {
      try {
        await deps.closeWorktree(handle);
      } catch (err) {
        // 清理失败不改变裁决结论(门已经判完了),但必须喊出来:目录/lock 会留在磁盘上。
        deps.log("cleanup", "fail", err instanceof Error ? err.message : String(err));
      }
    }
  }
}
