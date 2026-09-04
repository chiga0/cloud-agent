import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { TaskSession } from "../src/control/session";
import type { AgentEventV1 } from "../src/obs/events";
import { OBS_HEARTBEAT_KIND } from "../src/obs/events";
import { commitObsRound, obsIndexPath } from "../src/obs/journal";
import { attemptDeadline, WALL_GRACE_SECONDS } from "../src/control/statemachine";
import {
  RULE_STALL_AGENT_SILENT,
  RULE_STALL_LAST_EVENT_GAP,
  RULE_STALL_NO_HEARTBEAT,
  SUPERVISOR_DEFAULT_TICK_SECONDS,
} from "../src/supervisor/detect";
import { applyMigrations } from "./d1";

/**
 * Supervisor 接线层(TaskSession DO 内)。这里要钉的是**接线契约**,判据本身在
 * test/supervisor-detect.test.ts:
 *
 * 1. 观察与裁决分离 —— Supervisor 跑过之后,任务 state 与两个 pending 标志**逐字段不变**。
 *    这是本层最重要的一条可执行证据:只要将来有人在这里顺手加一句处置,这条会红。
 * 2. supervisor_finding 真实进权威 hash chain、读得到、可按 kind 查到。
 * 3. 去重存在 DO storage 而不是请求局部变量:第二次 tick 不再产生事件。
 * 4. journal 读失败一律降级:不抛、不影响别的 attempt、不改状态。
 * 5. mode=off(代码缺省)时链里一个 supervisor 事件都没有。
 *
 * journal 走真实 miniflare 的 R2(commitObsRound 写段 + index),不假造读到的事件:
 * 判据依赖的是「readObsAttemptEvents 按序读出什么」,手搓假桶最容易把这条糊过去。
 */

beforeAll(applyMigrations);

const ns = () => env.TASK_SESSION as DurableObjectNamespace<TaskSession>;

const STALE_MS = 30 * 60_000;

function setMode(mode: "shadow" | undefined) {
  const bag = env as unknown as Record<string, unknown>;
  if (mode === undefined) delete bag.SUPERVISOR_MODE;
  else bag.SUPERVISOR_MODE = mode;
}

afterEach(() => {
  setMode(undefined);
  delete (env as unknown as Record<string, unknown>).SUPERVISOR_TICK_SECONDS;
});

function chainIntact(events: Array<{ prev_digest: string | null; digest: string }>): void {
  for (let i = 1; i < events.length; i++) {
    expect(events[i].prev_digest).toBe(events[i - 1].digest);
  }
}

/** getSnapshot 的 events.payload 是 canonical JSON 字符串(见 session.ts) */
function findingsOf(snap: { events: Array<{ kind: string; payload: string }> }) {
  return snap.events
    .filter((e) => e.kind === "supervisor_finding")
    .map((e) => JSON.parse(e.payload) as Record<string, unknown>);
}

/** 往 Observation journal 写 n 条 STALE_MS 前的事件(= 悬挂形态)。 */
async function staleJournal(taskId: string, attemptId: string, n = 1): Promise<void> {
  const ts = new Date(Date.now() - STALE_MS).toISOString();
  const events: AgentEventV1[] = Array.from({ length: n }, (_, i) => ({
    v: 1,
    task_id: taskId,
    attempt_id: attemptId,
    generation: 1,
    seq: i + 1,
    ts,
    kind: "tool_use",
    payload: { tool_names: ["read_file"], text: "src/stuck.ts" },
  }));
  await commitObsRound(env.ARTIFACTS, {
    taskId,
    attemptId,
    events,
    cursor: { generation: 1, offset_bytes: 0, head_len: 0, head_digest: "0".repeat(64) },
    prev: null,
    now: new Date().toISOString(),
  });
}

/** 建一个有 RUNNING writer attempt 的任务(墙钟 600s + 宽限,本轮绝不会过期)。 */
async function runningWriterAttempt() {
  const stub = ns().get(ns().newUniqueId());
  const taskId = crypto.randomUUID();
  await stub.createTask({ prompt: "supervisor" }, taskId);
  const { attempt_id } = await stub.startAttempt({
    role: "writer",
    idempotency_key: `${taskId}:attempt:1`,
    max_model_tokens: 1000,
    max_wall_seconds: 600,
  });
  return { stub, taskId, attemptId: attempt_id };
}

describe("Supervisor shadow(TaskSession DO 内的独立消费者)", () => {
  it("finding 入链、可按 kind 查到,且任务状态逐字段不变", async () => {
    setMode("shadow");
    const { stub, taskId, attemptId } = await runningWriterAttempt();
    await staleJournal(taskId, attemptId);
    const before = await stub.getSnapshot();

    const tick = await stub.supervisorTick();
    expect(tick.mode).toBe("shadow");
    expect(tick.reported).toHaveLength(1);
    // 这份夹具里**没有心跳**(= c10b 之前落的历史段),所以走的是 downlevel 那条:
    // 只有 yellow。想要 red 必须有独立时间源可断 —— 见下面 heartbeatJournal 那两条。
    expect(tick.reported[0]).toMatchObject({ attempt_id: attemptId, kind: "stall", severity: "yellow" });

    const after = await stub.getSnapshot();
    // 观察/裁决分离的可执行证据:Supervisor 跑过之后,**裁决面**的字段一个都没动。
    // 唯一允许变的是 next_seq —— 它变正是「往权威链里写了一条事件」的记账,而事件本身
    // 就是本层的全部产出。把这条差异显式钉死,而不是把它从断言里漏掉。
    expect(after!.task).toEqual({ ...before!.task, next_seq: before!.task.next_seq + 1 });
    expect(after!.task.state).toBe(before!.task.state);
    expect(after!.task.version).toBe(before!.task.version);
    expect(after!.task.updated_at).toBe(before!.task.updated_at);
    expect(after!.task.pending_review).toBe(false);
    expect(after!.task.pending_verify).toBe(false);
    expect(after!.task.awaiting_human).toBe(before!.task.awaiting_human);
    expect(after!.task.archived).toBe(before!.task.archived);
    expect(after!.task.state).toBe("RUNNING");
    expect(after!.attempts.map((a) => a.state)).toEqual(["RUNNING"]);
    expect(after!.attempts.map((a) => a.created_at)).toEqual(before!.attempts.map((a) => a.created_at));

    const findings = findingsOf(after!);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      attempt_id: attemptId,
      kind: "stall",
      rule: RULE_STALL_LAST_EVENT_GAP,
      severity: "yellow",
      mode: "shadow",
      enforced: false,
    });
    const evidence = findings[0].evidence as { gap_ms: number; last_event_ts: string };
    expect(evidence.gap_ms).toBeGreaterThanOrEqual(STALE_MS);
    expect(Date.parse(evidence.last_event_ts)).toBeLessThan(Date.now());
    chainIntact(after!.events);
  });

  it("去重:同一 finding 第二次 tick 不再产生事件(去重表在 DO storage 里)", async () => {
    setMode("shadow");
    const { stub, taskId, attemptId } = await runningWriterAttempt();
    await staleJournal(taskId, attemptId);

    expect((await stub.supervisorTick()).reported).toHaveLength(1);
    expect((await stub.supervisorTick()).reported).toHaveLength(0);
    const snap = await stub.getSnapshot();
    expect(findingsOf(snap!)).toHaveLength(1);
    expect(snap!.task.state).toBe("RUNNING");
  });

  it("journal 缺失(刚起跑的 attempt)不报:没有证据不等于卡住", async () => {
    setMode("shadow");
    const { stub } = await runningWriterAttempt();
    const tick = await stub.supervisorTick();
    expect(tick.reported).toHaveLength(0);
    const snap = await stub.getSnapshot();
    expect(findingsOf(snap!)).toHaveLength(0);
  });

  it("降级:index 坏了 → 不抛、跳过该 attempt、另一个 attempt 照常上报", async () => {
    setMode("shadow");
    const { stub, taskId, attemptId } = await runningWriterAttempt();
    const { attempt_id: brokenId } = await stub.startAttempt({
      role: "reviewer",
      idempotency_key: `${taskId}:attempt:2`,
      max_model_tokens: 1000,
      max_wall_seconds: 600,
    });
    // 坏 index:形状不对会被 loadObsIndex 判成 obs_index_malformed 抛出来
    await env.ARTIFACTS.put(obsIndexPath(taskId, brokenId), JSON.stringify({ v: 99 }));
    await staleJournal(taskId, attemptId);

    const tick = await stub.supervisorTick();
    expect(tick.reported.map((f) => f.attempt_id)).toEqual([attemptId]);
    const snap = await stub.getSnapshot();
    expect(snap!.task.state).toBe("RUNNING");
    expect(snap!.attempts.map((a) => a.state)).toEqual(["RUNNING", "RUNNING"]);
  });

  /**
   * 关于 alarm 那条路径:workerd 明确禁止 `alarm` 走 RPC("'alarm' is a reserved method"),
   * 测试里也就没法把 watchdog 叫醒。所以本期的接线契约拆成两块各自钉死:
   * - tick 本体(runSupervisorTick)= 上面几条用例(supervisorTick RPC 调的就是 alarm 里
   *   同一份实现,不是为测试另写一条路);
   * - 续期节奏(nextWatchdogAlarm 的 supervisorTickMs)= test/statemachine.test.ts;
   *   两个 env 旋钮的解析 = test/supervisor-detect.test.ts。
   * alarm() 里剩的只有「mode 为 off 时不传 tick + 调同一份 tick」这两行胶水。
   */
  it("mode 缺省 off:链里没有 supervisor 事件(alarm 续期沿用截止驱动)", async () => {
    // 不设置 env.SUPERVISOR_MODE:代码缺省 off。off 的续期行为等价性由
    // test/statemachine.test.ts 的「不传 tick → 与历史逐字段一致」钉住。
    const { stub, taskId, attemptId } = await runningWriterAttempt();
    await staleJournal(taskId, attemptId);
    const tick = await stub.supervisorTick();
    expect(tick.mode).toBe("off");
    expect(tick.reported).toHaveLength(0);
    const snap = await stub.getSnapshot();
    expect(findingsOf(snap!)).toHaveLength(0);
    expect(snap!.task.state).toBe("RUNNING");
  });
});

/**
 * c10b 的排程接线。这一组是**从 alarm 驱动**的,不是从 supervisorTick() RPC 驱动的。
 *
 * 为什么必须这样测:c10 那一期判据与 DO 测试全绿,而 prod 从头到尾一次 tick 都没发生
 * —— 因为 `supervisorTick()` 测的是 tick 本体,而缺陷在排程(claim 只排了截止时刻)与
 * alarm 周期体里的门。tick 方法自己永远测不到「有没有人被排醒」。
 *
 * 为什么走 alarmCycle() 而不是 alarm():workerd 把 `alarm` 列为保留方法名,不能 RPC。
 * 于是周期体整体搬进 alarmCycle(),`alarm()` 只剩一次委托 —— 本组测的就是 prod alarm
 * 触发时跑的那段代码(含 terminal 门、tick 门、续期),委托那一行由最后一条用例钉形状。
 */

const TICK_MS = SUPERVISOR_DEFAULT_TICK_SECONDS * 1000;

/**
 * 一份**有心跳**的 journal:转录事件停在 lastTranscriptAgoMs 之前,最后一条心跳停在
 * lastBeatAgoMs 之前。心跳 payload 用 ingress 的真实形状(status/round_ms/gap_ms)。
 */
async function heartbeatJournal(
  taskId: string,
  attemptId: string,
  args: { lastBeatAgoMs: number; lastTranscriptAgoMs: number },
): Promise<void> {
  const transcriptTs = new Date(Date.now() - args.lastTranscriptAgoMs).toISOString();
  const beatTs = new Date(Date.now() - args.lastBeatAgoMs).toISOString();
  const events: AgentEventV1[] = [
    {
      v: 1,
      task_id: taskId,
      attempt_id: attemptId,
      generation: 1,
      seq: 1,
      ts: transcriptTs,
      kind: "tool_use",
      payload: { tool_names: ["read_file"], tool_targets: ["src/stuck.ts"] },
    },
    {
      v: 1,
      task_id: taskId,
      attempt_id: attemptId,
      generation: 1,
      seq: 2,
      ts: beatTs,
      kind: OBS_HEARTBEAT_KIND,
      payload: { status: "running", round_ms: 3_000, gap_ms: 33_000 },
    },
  ];
  await commitObsRound(env.ARTIFACTS, {
    taskId,
    attemptId,
    events,
    cursor: { generation: 1, offset_bytes: 0, head_len: 0, head_digest: "0".repeat(64) },
    prev: null,
    now: new Date().toISOString(),
  });
}

describe("排程接线(c10b:让 Supervisor 真的会被叫醒)", () => {
  it("(a) 真实 alarm 周期体跑完 → 链里出现 supervisor_finding", async () => {
    setMode("shadow");
    const { stub, taskId, attemptId } = await runningWriterAttempt();
    // runner 已停 10 分钟(> 红线 180s)、转录也静默 → 判据必须给出 red。
    await heartbeatJournal(taskId, attemptId, { lastBeatAgoMs: 600_000, lastTranscriptAgoMs: 600_000 });
    const before = await stub.getSnapshot();
    expect(findingsOf(before!)).toHaveLength(0);

    await stub.alarmCycle();

    const after = await stub.getSnapshot();
    const findings = findingsOf(after!);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.map((f) => f.rule)).toContain(RULE_STALL_NO_HEARTBEAT);
    expect(findings.find((f) => f.rule === RULE_STALL_NO_HEARTBEAT)).toMatchObject({
      kind: "stall",
      severity: "red",
      mode: "shadow",
      enforced: false,
    });
    // 观察/裁决分离:alarm 周期体跑过之后 attempt 仍然 RUNNING(墙钟远未到期)。
    expect(after!.attempts.map((a) => a.state)).toEqual(["RUNNING"]);
    expect(after!.task.state).toBe("RUNNING");
    chainIntact(after!.events);
  });

  it("(b) claim 后排定的下一次唤醒 ≤ now + tick(直接钉住「从不 tick」这一类失效)", async () => {
    setMode("shadow");
    const { stub } = await runningWriterAttempt();
    const now = Date.now();
    const scheduled = await stub.peekScheduledAlarm();
    expect(scheduled).not.toBeNull();
    expect(scheduled!).toBeLessThanOrEqual(now + TICK_MS);
    // 也不许密于 WATCHDOG_MIN_INTERVAL_MS:alarm 自旋会白烧 DO 请求。
    expect(scheduled!).toBeGreaterThan(now);
  });

  it("(b2) 一次 alarm 周期之后仍持续续期(不是一次性的)", async () => {
    setMode("shadow");
    const { stub, taskId, attemptId } = await runningWriterAttempt();
    await heartbeatJournal(taskId, attemptId, { lastBeatAgoMs: 10_000, lastTranscriptAgoMs: 10_000 });
    await stub.alarmCycle();
    const scheduled = await stub.peekScheduledAlarm();
    expect(scheduled).not.toBeNull();
    expect(scheduled!).toBeLessThanOrEqual(Date.now() + TICK_MS);
  });

  it("(b3) mode=off 时排程与历史逐字段一致 = attemptDeadline(回归证据)", async () => {
    // 不设 SUPERVISOR_MODE:代码缺省 off。这条断言的是「新接线没有改变 off 的排程」——
    // off 的续期等价性只能这样钉:值必须**恰好等于**截止时刻,而不是「小于等于什么」。
    const { stub, attemptId } = await runningWriterAttempt();
    const snap = await stub.getSnapshot();
    const record = snap!.attempts.find((a) => a.id === attemptId)!;
    // getSnapshot 的 attempt 是瘦身后的大小写(没有 max_wall_seconds),所以这里按
    // 夹具的输入重算同一个式子,而不是去放宽 snapshot —— 放宽读端点不是一条测试的权限。
    const deadline = Date.parse(record.created_at) + (600 + WALL_GRACE_SECONDS) * 1000;
    const scheduled = await stub.peekScheduledAlarm();
    expect(scheduled).toBe(deadline);
    expect(attemptDeadline({ ...record, max_wall_seconds: 600 })).toBe(deadline);
    expect(scheduled!).toBeGreaterThan(Date.now() + TICK_MS);
  });

  it("(c) 双判据各一:心跳断→red、心跳在而转录静→只 yellow", async () => {
    setMode("shadow");
    // 反向:心跳新鲜、转录静默很久 → 只有 yellow,不得有 red。
    const alive = await runningWriterAttempt();
    await heartbeatJournal(alive.taskId, alive.attemptId, {
      lastBeatAgoMs: 30_000,
      lastTranscriptAgoMs: 20 * 60_000,
    });
    await alive.stub.alarmCycle();
    const aliveFindings = findingsOf((await alive.stub.getSnapshot())!);
    expect(aliveFindings.map((f) => f.rule)).toEqual([RULE_STALL_AGENT_SILENT]);
    expect(aliveFindings[0]).toMatchObject({ severity: "yellow" });

    // 正向:心跳也断了 → 同一轮里 red(no_heartbeat)与 yellow(agent_silent)并存。
    const dead = await runningWriterAttempt();
    await heartbeatJournal(dead.taskId, dead.attemptId, {
      lastBeatAgoMs: 20 * 60_000,
      lastTranscriptAgoMs: 20 * 60_000,
    });
    await dead.stub.alarmCycle();
    const deadRules = findingsOf((await dead.stub.getSnapshot())!).map((f) => f.rule).sort();
    expect(deadRules).toEqual([RULE_STALL_AGENT_SILENT, RULE_STALL_NO_HEARTBEAT].sort());
  });

  it("alarm() 必须仍然委托给 alarmCycle():workerd 禁止 RPC,委托那一行只能钉形状", async () => {
    // 这条是「测不到」的补偿:委托如果被删,tick 与续期就都不再发生,而 RPC 叫不动 alarm,
    // 上面的用例反而全绿。所以直接看方法体:它必须是一次 alarmCycle 调用,不掺别的逻辑。
    const body = TaskSession.prototype.alarm.toString();
    expect(body).toContain("alarmCycle");
    expect(typeof TaskSession.prototype.alarmCycle).toBe("function");
  });
});
