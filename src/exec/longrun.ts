/**
 * M9.5①(Fix C):长命令(qwen 主跑 / verify_command)从「单条阻塞 exec」改为
 * 「后台 startProcess + workflow 短轮询」。
 *
 * 根因(r6/r7/r8 prod 实证):workflow step 内的长 await(17–25 分钟)会让
 * isolate 被平台驱逐 → run 调用 Canceled → step 重试重新调用 run() → 容器内
 * 的 qwen 成为孤儿:继续烧 token(BLOCKED 后实测 2.5min+)、占住 default
 * session 让重试命令排队(r8 实测 415s,最长撞 600s 排队上限)、并与重试的
 * clone 竞态(r6)。
 *
 * 机制:
 * - 长进程跑在专用 session,default session 永不被长命令占用;
 * - 固定 processId + autoCleanup:false → step 重试时经 getProcess 查到记录
 *   即重连,绝不重启(幂等);记录消失(missing)= 容量事实,按 -1 上报;
 * - 启动命令固定为 `bash /tmp/longrun.sh`:脚本由 writeFile 落盘(已实证
 *   路径),重定向/环境变量/工作目录全部收在脚本内,不依赖 startProcess
 *   端的 shell 语义;
 * - 输出重定向到固定文件,经 readFile 回收(不依赖 getProcessLogs);
 * - 轮询是秒级短 RPC,逐个落 checkpoint;驱逐后从 checkpoint 恢复,
 *   launch step 不会重放,孤儿无从产生。
 */

export const LONGRUN_SESSION = "longrun";
export const LONGRUN_PROCESS_ID = "longrun";
export const LONGRUN_SCRIPT = "/tmp/longrun.sh";
export const LONGRUN_STDOUT = "/tmp/longrun-stdout";
export const LONGRUN_STDERR = "/tmp/longrun-stderr";
export const LONGRUN_LAUNCH_CMD = `bash ${LONGRUN_SCRIPT}`;

/** 脚本内 cd 失败的专用退出码:把「工作目录不存在」与命令自身失败区分开 */
export const SCRIPT_CD_FAILED = 96;

export type LongRunStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "killed"
  | "error"
  /** 进程记录不存在:从未启动成功,或容器重启后记录消失 */
  | "missing";

export interface ProcessSnapshot {
  status: LongRunStatus;
  exitCode: number | null;
  startedAtMs: number | null;
}

/** 结构上窄化真实 Sandbox,只为可单测;真实实例天然满足 */
export interface LongRunSandbox {
  createSession(options: { id?: string; cwd?: string }): Promise<unknown>;
  startProcess(
    command: string,
    options?: { processId?: string; autoCleanup?: boolean },
    sessionId?: string,
  ): Promise<unknown>;
  getProcess(
    id: string,
    sessionId?: string,
  ): Promise<{ status?: string; exitCode?: number | null; startTime?: Date | string | number } | null>;
  killProcess(id: string, signal?: string, sessionId?: string): Promise<unknown>;
  readFile(path: string): Promise<{ content: string }>;
}

function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/**
 * 生成 /tmp/longrun.sh。纯字符串构造,可穷举单测(与 exportPatchScript 同规约)。
 * 重定向包在 { } 组里,多命令(如 `npm ci && npm test`)的 stdout/stderr 才不泄漏;
 * `exit $?` 让进程退出码 = 命令组退出码(captured by 容器 process 记录)。
 */
export function longRunScript(args: {
  workdir: string;
  command: string;
  env?: Record<string, string>;
}): string {
  const lines = ["#!/bin/bash", `cd ${args.workdir} || exit ${SCRIPT_CD_FAILED}`];
  for (const [k, v] of Object.entries(args.env ?? {})) {
    lines.push(`export ${k}=${shellQuote(v)}`);
  }
  lines.push("{", args.command, `} > ${LONGRUN_STDOUT} 2> ${LONGRUN_STDERR}`, "exit $?");
  return `${lines.join("\n")}\n`;
}

async function readProcess(sb: LongRunSandbox): Promise<ProcessSnapshot> {
  const p = await sb.getProcess(LONGRUN_PROCESS_ID, LONGRUN_SESSION);
  if (!p || typeof p.status !== "string") {
    return { status: "missing", exitCode: null, startedAtMs: null };
  }
  const t = p.startTime == null ? Number.NaN : new Date(p.startTime).getTime();
  return {
    status: p.status as LongRunStatus,
    exitCode: p.exitCode ?? null,
    startedAtMs: Number.isFinite(t) ? t : null,
  };
}

/**
 * 启动或重连。step 重试/驱逐后重放都走这里:已有记录(哪怕已终态——结果
 * 绝不能丢)即重连;无记录才启动。createSession 失败 fail-open:session
 * 可能已存在,startProcess 自身会给出确定结果。
 */
export async function launchOrReattach(
  sb: LongRunSandbox,
): Promise<{ reattached: boolean; snapshot: ProcessSnapshot }> {
  try {
    await sb.createSession({ id: LONGRUN_SESSION, cwd: "/" });
  } catch (err) {
    console.warn(`longrun_session_create_failed err=${String(err).slice(0, 200)}`);
  }
  const existing = await readProcess(sb);
  if (existing.status !== "missing") {
    console.info(`longrun_reattach status=${existing.status} exit=${existing.exitCode}`);
    return { reattached: true, snapshot: existing };
  }
  await sb.startProcess(
    LONGRUN_LAUNCH_CMD,
    { processId: LONGRUN_PROCESS_ID, autoCleanup: false },
    LONGRUN_SESSION,
  );
  console.info("longrun_started");
  return {
    reattached: false,
    snapshot: { status: "running", exitCode: null, startedAtMs: Date.now() },
  };
}

export function pollLongRun(sb: LongRunSandbox): Promise<ProcessSnapshot> {
  return readProcess(sb);
}

export function isLongRunTerminal(s: ProcessSnapshot): boolean {
  return (
    s.status === "completed" ||
    s.status === "failed" ||
    s.status === "killed" ||
    s.status === "error" ||
    s.status === "missing"
  );
}

/** 到期兜底击杀。fail-open:击杀失败也按超时上报,不能让 kill 异常吞掉结论 */
export async function killLongRun(sb: LongRunSandbox): Promise<void> {
  try {
    await sb.killProcess(LONGRUN_PROCESS_ID, "SIGKILL", LONGRUN_SESSION);
    console.info("longrun_killed");
  } catch (err) {
    console.warn(`longrun_kill_failed err=${String(err).slice(0, 200)}`);
  }
}

export async function collectLongRunOutput(
  sb: LongRunSandbox,
): Promise<{ stdout: string; stderr: string }> {
  const read = async (path: string): Promise<string> => {
    try {
      return (await sb.readFile(path)).content;
    } catch (err) {
      console.warn(`longrun_output_read_failed path=${path} err=${String(err).slice(0, 200)}`);
      return "";
    }
  };
  return { stdout: await read(LONGRUN_STDOUT), stderr: await read(LONGRUN_STDERR) };
}
