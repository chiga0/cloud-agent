/**
 * DONE 候选的自动落地守门器 —— 把人工的「取证据 → 校验 digest → 干净树 apply →
 * 本地验证 → commit → push」闭环脚本化。薄壳:只做 I/O 适配与退出码落地,
 * 守门判定全在 land-gate.mjs(可测、可注入)。
 *
 * 信任边界:平台侧只读,不持有 push 凭据;push 凭据只存在于运行本脚本的机器上。
 * 因此本脚本是**唯一**能改远端的地方 —— 它宁可什么都不做,也不会在没被证明的候选上动手。
 *
 * 退出码口径见 land-gate.mjs 头注释:0 成功 / 1 执行期故障 / 2 守门拒绝 / 3 环境或参数错误。
 *
 * 守门链 a–g 之后可选接两段迭代循环尾巴(判定全在 land-gate.mjs,本文件只给真实现):
 * --next <file> 在本轮 push 成功后把 spec 文件原样 POST /tasks 提交下一任务;
 * --wait 再每 60s 轮询那个新任务直到 DONE/REJECTED/BLOCKED(上限 90 分钟)。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

/** `git status --porcelain` 每行的路径列(XY 前两格 + 空格;rename 形状 apply 不产生,仍取箭头后)。 */
function statusPaths(text) {
  return String(text ?? "")
    .split("\n")
    .filter((l) => l.length > 3)
    .map((l) => {
      const p = l.slice(3);
      const arrow = p.indexOf(" -> ");
      return arrow >= 0 ? p.slice(arrow + 4) : p;
    });
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
 * 带鉴权的 HTTP。token **每次从 env 现读**(不做凭据缓存):平台侧 token 可轮换,
 * 而落地窗口可能横跨轮换 —— 加了 --wait 之后这个窗口最长是 90 分钟。
 *
 * 失败语义对 GET/POST 一视同仁:网络错误与任何非 2xx 都抛 LandError(RUNTIME)。
 * POST /tasks 的 4xx 是「平台拒绝了这个 spec」,大声失败比就地猜测要补什么字段有用。
 */
async function request(opts, method, path, { accept = "application/json", body = null } = {}) {
  const tok = resolveToken(process.env, opts.tokenEnv);
  if (!tok.ok) throw new LandError(EXIT.ENV, tok.error);
  const headers = { authorization: `Bearer ${tok.token}`, accept };
  if (body !== null) headers["content-type"] = "application/json";
  let res;
  try {
    res = await fetch(`${opts.api}${path}`, { method, headers, body });
  } catch (err) {
    // undici 把真实原因(ECONNREFUSED / ENOTFOUND / TLS)藏在 err.cause 里:
    // 只喊 "fetch failed" 等于把最有用的一行扔了。
    const cause = err && typeof err === "object" && err.cause instanceof Error ? ` (${err.cause.message})` : "";
    throw new LandError(EXIT.RUNTIME, `${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}${cause}`);
  }
  if (!res.ok) {
    const text = oneLine((await res.text().catch(() => ""))).slice(0, 300);
    throw new LandError(EXIT.RUNTIME, `${method} ${path} → HTTP ${res.status}${text ? ` ${text}` : ""}`);
  }
  return res;
}

/** GET 的薄别名:守门链 a–c 三步全是读,调用点保持原样好读。 */
function get(opts, path, accept) {
  return request(opts, "GET", path, { accept });
}

/** 真 deps:与 land-gate.mjs 的注入面一一对应。 */
const deps = {
  log,

  async fetchTask(opts) {
    const res = await get(opts, `/api/tasks/${opts.task}`, "application/json");
    const body = /** @type {{task?: Record<string, unknown>}} */ (await res.json());
    if (!body || typeof body.task !== "object" || body.task === null) {
      throw new LandError(EXIT.RUNTIME, `GET /api/tasks/${opts.task} → 响应里没有 task 对象`);
    }
    return /** @type {any} */ (body.task);
  },

  async fetchEvidence(opts) {
    const res = await get(opts, `/api/tasks/${opts.task}/evidence`, "application/json");
    return await res.json();
  },

  async fetchPatch(opts) {
    // 裸 patch 文本,不是 JSON:按**响应体字节**算 sha256,不能经过任何解析/换行改写。
    const res = await get(opts, `/api/tasks/${opts.task}/candidate?format=patch`, "text/plain");
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

  async build(handle) {
    // build 前的 porcelain 快照 = 候选补丁自身造成的全部工作树变化;build 之后**新增**的
    // 条目是 build(或 test)泄漏的产物 —— commit 的 `git add -A` 会把它们卷进落地提交,
    // 「落地 commit 的差量 == 候选 patch」就被静默破坏。dist/ 已在根 .gitignore,这条拦
    // 的是 writer 侧例外化(.gitignore 反选、产物落别的目录)那一类。
    const before = gitAt(handle.dir, ["status", "--porcelain"]);
    if (before.code !== 0) return { ok: false, detail: before.detail };
    const r = npmAt(handle.dir, ["run", "build"]);
    if (r.code !== 0) return { ok: false, detail: r.detail };
    const after = gitAt(handle.dir, ["status", "--porcelain"]);
    if (after.code !== 0) return { ok: false, detail: after.detail };
    const beforePaths = new Set(statusPaths(before.stdout));
    const leaked = statusPaths(after.stdout).filter((p) => !beforePaths.has(p));
    if (leaked.length > 0) {
      return {
        ok: false,
        detail: `build 产生未被 .gitignore 覆盖的产物(${leaked.slice(0, 5).join(", ")}${leaked.length > 5 ? " 等" : ""})— 卷进落地提交会破坏 commit==候选patch,先修 .gitignore`,
      };
    }
    return { ok: true, detail: "no leakage" };
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

  async readSpecFile(opts) {
    // h 步材料。这里只判「读得到、解析得开」两件事,然后把**文件原文**交回去:
    // spec 文件是任务意图的权威副本,脚本既不改写(不 JSON.parse 后再 stringify —— 那会
    // 悄悄重排键序、归一化数字),也不校验业务内容(平台是唯一裁判,4xx 由它大声报)。
    const path = resolve(process.cwd(), opts.next);
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      return { ok: false, detail: `read ${path} failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    try {
      JSON.parse(text);
    } catch (err) {
      return { ok: false, detail: `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { ok: true, text };
  },

  async postNext(opts, text) {
    const res = await request(opts, "POST", "/api/tasks", { body: text });
    const body = /** @type {{task?: {id?: unknown}, task_id?: unknown}} */ (await res.json());
    // prod 实测(2026-09-02)返回 {"task":{"id":…,"state":"QUEUED"}};仓内 src/index.ts 的
    // 同一端点返回 {task_id:…}。两种都认,认不出即大声失败 —— 把 null 记进摘要会让
    // 一个 --wait 去等一个不存在的任务,那是最难查的一类挂法。
    const id = body?.task?.id ?? body?.task_id;
    if (typeof id !== "string" || id === "") {
      throw new LandError(EXIT.RUNTIME, `POST /api/tasks → 响应里没有新任务 id(拿到的是 ${oneLine(JSON.stringify(body)).slice(0, 200)})`);
    }
    return id;
  },

  async fetchTaskState(opts, id) {
    const res = await get(opts, `/api/tasks/${id}`, "application/json");
    const body = /** @type {{task?: {state?: unknown}}} */ (await res.json());
    const state = body?.task?.state;
    if (typeof state !== "string" || state === "") {
      throw new LandError(EXIT.RUNTIME, `GET /api/tasks/${id} → 响应里没有 task.state`);
    }
    return state;
  },

  async sleep(ms) {
    await new Promise((r) => setTimeout(r, ms));
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

  log("args", "ok", `task=${opts.task} api=${opts.api} execute=${opts.execute} push=${opts.push} worktree=${opts.worktree ?? "temp"} next=${opts.next ?? "-"} wait=${opts.wait}`);
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
