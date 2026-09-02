/**
 * DONE 候选的自动落地守门器 —— 把人工的「取证据 → 校验 digest → 干净树 apply →
 * 本地验证 → commit → push」闭环脚本化。薄壳:只做 I/O 适配与退出码落地,
 * 守门判定全在 land-gate.mjs(可测、可注入)。
 *
 * 信任边界:平台侧只读,不持有 push 凭据;push 凭据只存在于运行本脚本的机器上。
 * 因此本脚本是**唯一**能改远端的地方 —— 它宁可什么都不做,也不会在没被证明的候选上动手。
 *
 * 退出码口径见 land-gate.mjs 头注释:0 成功 / 1 执行期故障 / 2 守门拒绝 / 3 环境或参数错误。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EXIT, parseTestCount, planRun, resolveToken, runGate, summaryLine } from "./land-gate.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 带退出码的失败:让壳里任何一处都能把「环境/参数错误」原样映射到 3,不被吞成 1。 */
class LandError extends Error {
  /** @param {number} exitCode @param {string} message */
  constructor(exitCode, message) {
    super(message);
    this.exitCode = exitCode;
  }
}

function oneLine(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function log(step, status, detail) {
  const tail = oneLine(detail);
  process.stderr.write(`[land] ${step} ${status}${tail ? ` ${tail}` : ""}\n`);
}

/**
 * 子进程调用。逐条检查退出码,且 cwd 与 `-C` 双显式 —— 不依赖进程 cwd 残留:
 * 守门链里主仓库与 worktree 两个坐标交替出现,靠「当前还在哪个目录」判断是错的。
 */
function run(cmd, args, { cwd = ROOT, input = null } = {}) {
  // spawnSync 默认 maxBuffer 只有 1 MiB,而 `npm test` 的输出会超(超限是 ENOBUFS,
  // 表现为一次「说不清为什么」的失败)—— 放大到足够跑完真实测试摘要。
  const res = spawnSync(cmd, args, {
    cwd,
    input: input === null ? undefined : input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) {
    // ENOENT 是「这台机器上没有 git/npm」= 环境错误(3);其他 spawn 故障才是执行期故障(1)。
    const env = res.error.code === "ENOENT";
    throw new LandError(
      env ? EXIT.ENV : EXIT.RUNTIME,
      env ? `${cmd} is not available on PATH (env error)` : `${cmd} ${args.join(" ")}: ${res.error.message}`,
    );
  }
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  return { code: res.status ?? 1, stdout, stderr, detail: oneLine(stderr || stdout).slice(0, 600) };
}

/** 主仓库上的 git(fetch / worktree add|remove / rev-parse)。 */
function gitMain(args, opts) {
  return run("git", ["-C", ROOT, ...args], opts);
}

/** worktree 内的 git(必须带 -C <dir>,绝不靠 cwd)。 */
function gitAt(dir, args, opts) {
  return run("git", ["-C", dir, ...args], { ...opts, cwd: dir });
}

function npmAt(dir, args) {
  return run("npm", args, { cwd: dir });
}

/**
 * 带鉴权的 GET。token **每次从 env 现读**(不做凭据缓存):平台侧 token 可轮换,
 * 而落地窗口可能横跨轮换。
 */
async function get(opts, path, accept) {
  const tok = resolveToken(process.env, opts.tokenEnv);
  if (!tok.ok) throw new LandError(EXIT.ENV, tok.error);
  let res;
  try {
    res = await fetch(`${opts.api}${path}`, {
      headers: { authorization: `Bearer ${tok.token}`, accept },
    });
  } catch (err) {
    // undici 把真实原因(ECONNREFUSED / ENOTFOUND / TLS)藏在 err.cause 里:
    // 只喊 "fetch failed" 等于把最有用的一行扔了。
    const cause = err && typeof err === "object" && err.cause instanceof Error ? ` (${err.cause.message})` : "";
    throw new LandError(EXIT.RUNTIME, `GET ${path} failed: ${err instanceof Error ? err.message : String(err)}${cause}`);
  }
  if (!res.ok) {
    const body = oneLine((await res.text().catch(() => ""))).slice(0, 300);
    throw new LandError(EXIT.RUNTIME, `GET ${path} → HTTP ${res.status}${body ? ` ${body}` : ""}`);
  }
  return res;
}

/** 真 deps:与 land-gate.mjs 的注入面一一对应。 */
const deps = {
  log,

  async fetchTask(opts) {
    const res = await get(opts, `/tasks/${opts.task}`, "application/json");
    const body = /** @type {{task?: Record<string, unknown>}} */ (await res.json());
    if (!body || typeof body.task !== "object" || body.task === null) {
      throw new LandError(EXIT.RUNTIME, `GET /tasks/${opts.task} → 响应里没有 task 对象`);
    }
    return /** @type {any} */ (body.task);
  },

  async fetchEvidence(opts) {
    const res = await get(opts, `/tasks/${opts.task}/evidence`, "application/json");
    return await res.json();
  },

  async fetchPatch(opts) {
    // 裸 patch 文本,不是 JSON:按**响应体字节**算 sha256,不能经过任何解析/换行改写。
    const res = await get(opts, `/tasks/${opts.task}/candidate?format=patch`, "text/plain");
    return new Uint8Array(await res.arrayBuffer());
  },

  async sha256Hex(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
  },

  async openWorktree(opts, baseSha) {
    const isTemp = !opts.worktree;
    // mkdtemp 出的父目录留着,worktree 落在它的子路径上:git worktree add 会自建子目录,
    // 但要求父目录已在 —— 且这个前缀唯一,不会撞到别人的 worktree。
    const dir = isTemp ? join(mkdtempSync(join(tmpdir(), `land-${opts.task.slice(0, 8)}-`)), "wt") : resolve(opts.worktree);
    const fetched = gitMain(["fetch", "origin"]);
    if (fetched.code !== 0) throw new LandError(EXIT.RUNTIME, `git fetch origin failed: ${fetched.detail}`);
    // detached:worktree 是候选的验证场,不该占用任何本地分支。--detach 让「忘了摘 branch」
    // 变成不可能,而不是变成一个悄悄推进本地分支的 bug。
    const added = gitMain(["worktree", "add", "--detach", dir, baseSha]);
    if (added.code !== 0) throw new LandError(EXIT.RUNTIME, `git worktree add ${dir} ${baseSha} failed: ${added.detail}`);
    log("worktree", "ok", `${dir} @ ${baseSha}${isTemp ? " (temp)" : " (fixed, 保留)"}`);
    return { dir, temp: isTemp };
  },

  async closeWorktree(handle) {
    if (!handle.temp) return; // --worktree 指定的目录由调用方处置:失败现场留在原地才有诊断价值
    const removed = gitMain(["worktree", "remove", "--force", handle.dir]);
    if (removed.code !== 0) log("worktree", "fail", `remove ${handle.dir}: ${removed.detail}`);
    rmSync(dirname(handle.dir), { recursive: true, force: true });
  },

  async applyCheck(handle, bytes) {
    // patch 走 stdin:不在 worktree 里落一个待 apply 的文件,`git add -A` 才不会把它卷进提交。
    const r = gitAt(handle.dir, ["apply", "--check", "-"], { input: bytes });
    return { ok: r.code === 0, detail: r.detail };
  },

  async applyPatch(handle, bytes) {
    const r = gitAt(handle.dir, ["apply", "-"], { input: bytes });
    return { ok: r.code === 0, detail: r.detail };
  },

  async install(handle) {
    const r = npmAt(handle.dir, ["ci", "--no-audit", "--no-fund"]);
    return { ok: r.code === 0, detail: r.detail };
  },

  async typecheck(handle) {
    const r = npmAt(handle.dir, ["run", "typecheck"]);
    return { ok: r.code === 0, out: "ok", detail: r.detail };
  },

  async runTests(handle) {
    const r = npmAt(handle.dir, ["test"]);
    // 提交信息里的 tests N passed 必须是真实输出里的数字。解析(含剥 ANSI 色码)
    // 收在 parseTestCount;解析不出来时如实写 0(宁可得出的摘要难看,也不编一个数)。
    const passed = parseTestCount(`${r.stdout}\n${r.stderr}`);
    return { ok: r.code === 0, passed, detail: passed > 0 ? `passed=${passed}` : r.detail };
  },

  async commit(handle, message) {
    const added = gitAt(handle.dir, ["add", "-A"]);
    if (added.code !== 0) throw new LandError(EXIT.RUNTIME, `git add -A failed: ${added.detail}`);
    const staged = gitAt(handle.dir, ["diff", "--cached", "--name-only"]);
    if (staged.code !== 0) throw new LandError(EXIT.RUNTIME, `git diff --cached failed: ${staged.detail}`);
    if (oneLine(staged.stdout) === "") {
      // 空提交会让「task/base/patch/binding」四要素指向一个不含任何变更的 commit —— 拒了。
      throw new LandError(EXIT.GATE, "commit refused: staged tree is empty(候选在本基线上是 no-op)");
    }
    const committed = gitAt(handle.dir, ["commit", "-m", message]);
    if (committed.code !== 0) throw new LandError(EXIT.RUNTIME, `git commit failed: ${committed.detail}`);
    const sha = gitAt(handle.dir, ["rev-parse", "HEAD"]);
    if (sha.code !== 0) throw new LandError(EXIT.RUNTIME, `git rev-parse HEAD failed: ${sha.detail}`);
    return oneLine(sha.stdout);
  },

  async push(handle) {
    // 非快进/权限失败一律报错退出。绝不用 --force:落地端的错误不该由删掉别人的提交来收拾。
    const r = gitAt(handle.dir, ["push", "origin", "HEAD:main"]);
    if (r.code !== 0) throw new LandError(EXIT.RUNTIME, `git push origin HEAD:main failed(非快进则先人工 rebase,不用 --force): ${r.detail}`);
  },
};

async function main(argv, env) {
  const plan = planRun(argv, env);
  if (!plan.ok) {
    // 参数/环境错误一律 3(见 land-gate.mjs 退出码口径);此时一道门都没评估过,不打摘要。
    log("startup", "fail", plan.error);
    if (plan.usage) process.stderr.write(`${plan.usage}\n`);
    return plan.exitCode;
  }
  const opts = plan.opts;

  const inside = gitMain(["rev-parse", "--git-dir"]);
  if (inside.code !== 0) {
    log("startup", "fail", `${ROOT} 不是 git 仓库: ${inside.detail}`);
    return EXIT.ENV;
  }

  log("args", "ok", `task=${opts.task} api=${opts.api} execute=${opts.execute} push=${opts.push} worktree=${opts.worktree ?? "temp"}`);
  try {
    const outcome = await runGate(opts, deps);
    process.stdout.write(`${summaryLine(outcome)}\n`);
    return outcome.exitCode;
  } catch (err) {
    const code = typeof err?.exitCode === "number" ? err.exitCode : EXIT.RUNTIME;
    log("run", "error", err instanceof Error ? err.message : String(err));
    // 3 的口径是「连守门都没开始」,中途掉回 3 也不打摘要;其余打出已判定部分(未跑到的门为 null)。
    if (code !== EXIT.ENV && err && typeof err === "object" && err.outcome) {
      process.stdout.write(`${summaryLine(err.outcome)}\n`);
    }
    return code;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // 用 exitCode 而非 exit():让 stdout/stderr 有机会冲完。
  main(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
