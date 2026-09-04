import { describe, expect, it } from "vitest";
import { toAgentEventV1, OBS_HEARTBEAT_KIND, type AgentEventV1 } from "../src/obs/events";
import { POLL_INTERVAL_MS } from "../src/exec/longrun";
import { LIVE_STALL_DANGER_SECONDS, LIVE_STALL_WARN_SECONDS } from "../src/obs/live";
import {
  AGENT_SILENT_YELLOW_MS,
  detectSupervisor,
  HEARTBEAT_ROUND_MS,
  MEASURED_ROUND_MAX_MS,
  NO_HEARTBEAT_MISS_ROUNDS,
  NO_HEARTBEAT_RED_MS,
  normalizeTarget,
  RULE_LOOP_TOOL_REPEAT,
  RULE_NO_PROGRESS_TARGET_REPEAT,
  RULE_STALL_AGENT_SILENT,
  RULE_STALL_LAST_EVENT_GAP,
  RULE_STALL_NO_HEARTBEAT,
  selectFindingsToEmit,
  supervisorFindingPayload,
  supervisorModeOf,
  supervisorTickMsOf,
  SUPERVISOR_DEDUPE_COOLDOWN_MS,
  SUPERVISOR_DEFAULT_TICK_SECONDS,
  SUPERVISOR_THRESHOLDS,
  type SupervisorFinding,
} from "../src/supervisor/detect";

/**
 * Supervisor 判据层。这一层的价值全在「同一组输入永远得到同一组输出」上,所以
 * 时钟/阈值/事件全部注入,断言直接打在返回值上。
 *
 * 每条用例都对应一个真实的失效担忧,不是覆盖率装饰:
 * - 空事件不报 stall:不钉住的话,每个刚起跑的 attempt 都会被误报(文件头第 1 条);
 * - 恰好等于阈值不报:边界语义必须是契约,否则「>」会被顺手改成「>=」;
 * - 归一化生效:不钉住的话,同一动作带个新时间戳就不算重复,判据静默永不触发
 *   (文件头第 2 条)。
 *
 * ⚠️ 夹具的形状必须**prod 产得出来**。c10 的教训正是:这里的 `tool_use` 夹具同时塞了
 * `tool_names` 和 `text`,而 ingress(src/obs/events.ts 的 sanitizePayload)对 `tool_use`
 * 根本不写 `text` —— 于是判据测试全绿,真实 journal 里 target 却永远取不到文本、
 * repeat_key 塌成 `read_file @read_file`。判据测试与摄取测试各测各的,中间那道缝没人守。
 * 现在由两层共同守:夹具只用 `tool_targets`(§9.5 的真实形状),另有一组用例把
 * `toAgentEventV1` 的产物直接喂进 `detectSupervisor`(见「ingress ↔ 判据的同一条缝」)。
 */

const NOW = Date.parse("2026-09-03T00:10:00.000Z");
const TASK = "11111111-1111-4111-8111-111111111111";
const ATTEMPT = "22222222-2222-4222-8222-222222222222";

function evt(over: Partial<AgentEventV1> & { seq: number }): AgentEventV1 {
  return {
    v: 1,
    task_id: TASK,
    attempt_id: ATTEMPT,
    generation: 1,
    ts: new Date(NOW - 10_000).toISOString(),
    kind: "tool_use",
    payload: { tool_names: ["read_file"] },
    ...over,
  };
}

describe("stall · no_heartbeat(心跳这条独立时间源)", () => {
  /** 一条心跳:ts 可控,payload 用 ingress 的真实形状(见 toHeartbeatEvent)。 */
  function beat(seq: number, tsMs: number, roundMs = 33_000): AgentEventV1 {
    return evt({
      seq,
      kind: OBS_HEARTBEAT_KIND,
      ts: new Date(tsMs).toISOString(),
      payload: { status: "running", exit_code: null as never, round_ms: roundMs },
    });
  }

  it("红线由 POLL_INTERVAL 一侧派生:5 轮 × 33s → 取整到 tick = 180s", () => {
    // 钉住「阈值是派生的」这件事本身:改 POLL_INTERVAL_MS 或轮数,秒数必须跟着动。
    expect(HEARTBEAT_ROUND_MS).toBeGreaterThanOrEqual(POLL_INTERVAL_MS);
    expect(NO_HEARTBEAT_RED_MS).toBe(
      Math.ceil((NO_HEARTBEAT_MISS_ROUNDS * HEARTBEAT_ROUND_MS) / (SUPERVISOR_DEFAULT_TICK_SECONDS * 1000)) *
        SUPERVISOR_DEFAULT_TICK_SECONDS *
        1000,
    );
    expect(NO_HEARTBEAT_RED_MS).toBe(180_000);
    // 阈值与实测最坏轮次的比值:必须明显大于 1 次抖动,否则「一次跳过即误红」。
    expect(NO_HEARTBEAT_RED_MS).toBeGreaterThan(MEASURED_ROUND_MAX_MS * 1.5);
  });

  it("最后一条心跳滞后超过红线 → red", () => {
    const events = [
      evt({ seq: 1, ts: new Date(NOW - 400_000).toISOString() }),
      beat(2, NOW - (NO_HEARTBEAT_RED_MS + 1)),
    ];
    const f = findingsOf(detectSupervisor({ now_ms: NOW, events }), RULE_STALL_NO_HEARTBEAT);
    expect(f?.severity).toBe("red");
    expect(f?.evidence.heartbeat_gap_ms).toBe(NO_HEARTBEAT_RED_MS + 1);
    expect(f?.evidence.has_heartbeat).toBe(true);
    expect(f?.evidence.last_heartbeat_ts).toBe(events[1].ts);
  });

  it("心跳在跳(哪怕转录静默)→ 绝不报 no_heartbeat", () => {
    // 这是本棒的核心取舍:健康 writer 实测静默 576s,期间 runner 一直活着。
    const events = [
      evt({ seq: 1, ts: new Date(NOW - 576_000).toISOString() }),
      beat(2, NOW - 33_000),
    ];
    expect(findingsOf(detectSupervisor({ now_ms: NOW, events }), RULE_STALL_NO_HEARTBEAT)).toBeUndefined();
  });

  it("恰好等于红线不报(严格大于)", () => {
    const events = [beat(1, NOW - NO_HEARTBEAT_RED_MS)];
    expect(findingsOf(detectSupervisor({ now_ms: NOW, events }), RULE_STALL_NO_HEARTBEAT)).toBeUndefined();
  });
});

describe("stall · agent_silent(心跳在、转录静默)", () => {
  function beat(seq: number, tsMs: number): AgentEventV1 {
    return evt({ seq, kind: OBS_HEARTBEAT_KIND, ts: new Date(tsMs).toISOString(), payload: { status: "running", round_ms: 33_000 } });
  }

  it("超过黄线 → 只 yellow,永不 red", () => {
    const events = [
      evt({ seq: 1, ts: new Date(NOW - (AGENT_SILENT_YELLOW_MS + 1_000)).toISOString() }),
      beat(2, NOW - 30_000),
    ];
    const f = findingsOf(detectSupervisor({ now_ms: NOW, events }), RULE_STALL_AGENT_SILENT);
    expect(f?.severity).toBe("yellow");
    expect(f?.evidence.transcript_gap_ms).toBe(AGENT_SILENT_YELLOW_MS + 1_000);
    // 心跳新鲜 ⇒ 同一次判定里不能同时出 no_heartbeat:两个规则各管一条时间源。
    expect(findingsOf(detectSupervisor({ now_ms: NOW, events }), RULE_STALL_NO_HEARTBEAT)).toBeUndefined();
  });

  it("健康阈值:实测健康 writer 的 576s 静默不得触发黄", () => {
    const events = [
      evt({ seq: 1, ts: new Date(NOW - 576_000).toISOString() }),
      beat(2, NOW - 30_000),
    ];
    expect(findingsOf(detectSupervisor({ now_ms: NOW, events }), RULE_STALL_AGENT_SILENT)).toBeUndefined();
  });

  it("整段只有心跳(还没有转录)→ 参照点是首条心跳,不是「无穷大滞后」", () => {
    // 误报防线①的新形态:拿不到转录 ≠ 卡住。起跑后 10 分钟只有心跳 → 不报。
    const events = [beat(1, NOW - 600_000), beat(2, NOW - 30_000)];
    expect(findingsOf(detectSupervisor({ now_ms: NOW, events }), RULE_STALL_AGENT_SILENT)).toBeUndefined();
    // 而首条心跳距今超过黄线 → 报 yellow(观察开始就没动过)。
    const long = [beat(1, NOW - (AGENT_SILENT_YELLOW_MS + 5_000)), beat(2, NOW - 30_000)];
    expect(findingsOf(detectSupervisor({ now_ms: NOW, events: long }), RULE_STALL_AGENT_SILENT)?.severity).toBe("yellow");
  });

  it("静默再久也只 yellow:这条判据没有 red 分支(结构判据)", () => {
    // 上一条把静默量停在黄线附近,而「×2 就升 red」这类改法恰恰只在**远大于**黄线时才写得出
    // 差别 —— 于是它可以全绿通过。这里要的契约是分级本身:转录静默区分不了「挂了」与
    // 「在干不产字的长活」(c10 实测健康 writer 静默 576s),判据不许把自己的分辨率上限
    // 藏成一个更红的颜色 —— enforce 之后 red 就是处置信号,那是拿假设当证据。
    const events = [
      evt({ seq: 1, ts: new Date(NOW - 100 * AGENT_SILENT_YELLOW_MS).toISOString() }),
      beat(2, NOW - 30_000),
    ];
    const findings = detectSupervisor({ now_ms: NOW, events });
    expect(findingsOf(findings, RULE_STALL_AGENT_SILENT)?.severity).toBe("yellow");
    expect(findings.filter((f) => f.severity === "red")).toEqual([]);
  });
});

describe("stall · last_event_gap(downlevel:无心跳的历史段)", () => {
  it("无心跳段:只给 yellow,永不 red(没有独立时间源就不许分级)", () => {
    const events = [evt({ seq: 1, ts: new Date(NOW - 24 * 60_000).toISOString() })];
    const f = findingsOf(detectSupervisor({ now_ms: NOW, events }), RULE_STALL_LAST_EVENT_GAP);
    expect(f?.severity).toBe("yellow");
    expect(f?.evidence.has_heartbeat).toBe(false);
    expect(f?.evidence.gap_ms).toBe(1_440_000);
  });

  it("黄线与 agent_silent 同一份常量(不留第二个数字)", () => {
    expect(SUPERVISOR_THRESHOLDS.agent_silent_yellow_ms).toBe(LIVE_STALL_WARN_SECONDS * 1000);
    expect(SUPERVISOR_THRESHOLDS.no_heartbeat_red_ms).toBe(LIVE_STALL_DANGER_SECONDS * 1000);
  });

  it("有心跳的段上这条不再参与:分级交给两条新判据", () => {
    const events = [
      evt({ seq: 1, ts: new Date(NOW - 24 * 60_000).toISOString() }),
      evt({ seq: 2, kind: OBS_HEARTBEAT_KIND, ts: new Date(NOW - 30_000).toISOString(), payload: { status: "running" } }),
    ];
    expect(findingsOf(detectSupervisor({ now_ms: NOW, events }), RULE_STALL_LAST_EVENT_GAP)).toBeUndefined();
  });
});

describe("阈值与实测同源(live.ts 只引用不重述)", () => {
  it("Live 页面的秒数就是判据的毫秒数 / 1000", () => {
    expect(LIVE_STALL_WARN_SECONDS * 1000).toBe(SUPERVISOR_THRESHOLDS.agent_silent_yellow_ms);
    expect(LIVE_STALL_DANGER_SECONDS * 1000).toBe(SUPERVISOR_THRESHOLDS.no_heartbeat_red_ms);
  });
});

/** 一条正常心跳的事件流:最后一条在 now-10s,不会触发 stall。 */
function healthy(n = 3) {
  return Array.from({ length: n }, (_, i) => evt({ seq: i + 1 }));
}

function stallOf(findings: SupervisorFinding[]) {
  return findings.find((f) => f.kind === "stall");
}

function findingsOf(findings: SupervisorFinding[], rule: string) {
  return findings.find((f) => f.rule === rule);
}

describe("误报防线(没有证据 ≠ 卡住了)", () => {
  it("events 为空 → 不报 stall,返回空数组", () => {
    // journal 还没写 / index 缺失 → readObsAttemptEvents 返回空数组。两种成因都不是
    // 「agent 卡住」,这里报红等于每个刚起跑的 attempt 白吃一条 red。
    expect(detectSupervisor({ now_ms: NOW, events: [] })).toEqual([]);
  });

  it("时间戳不可解析 → gap 为 null 且不报 stall", () => {
    const events = [evt({ seq: 1, ts: "not-a-timestamp" as unknown as string })];
    const findings = detectSupervisor({ now_ms: NOW, events });
    expect(findings.find((f) => f.kind === "stall")).toBeUndefined();
  });

  it("只有一条非工具事件(assistant 心跳)时不报 loop/no_progress", () => {
    const events = [
      evt({ seq: 1, kind: "assistant", payload: { text: "thinking" } }),
      evt({ seq: 2, kind: "system", payload: {} }),
    ];
    expect(detectSupervisor({ now_ms: NOW, events })).toEqual([]);
  });
});

describe("loop(同一个工具动作在窗内反复出现)", () => {
  // 形状 = ingress 对 tool_use 真实产出的 payload(§9.5):tool_names + tool_targets
  const toolEvt = (seq: number, name: string, arg: string) =>
    evt({ seq, payload: { tool_names: [name], tool_targets: [arg] } });

  it("同一工具同一参数出现 loop_repeat_max 次 → 命中", () => {
    const n = SUPERVISOR_THRESHOLDS.loop_repeat_max;
    const events = [
      ...Array.from({ length: n }, (_, i) => toolEvt(i + 1, "run_shell_command", "npm test")),
      ...healthy(2).map((e, i) => evt({ seq: 100 + i, payload: { tool_names: ["read_file"], tool_targets: ["src/other.ts"] } })),
    ];
    const loop = detectSupervisor({ now_ms: NOW, events }).find((f) => f.kind === "loop");
    expect(loop?.rule).toBe(RULE_LOOP_TOOL_REPEAT);
    expect(loop?.evidence.repeat_count).toBe(n);
    expect(loop?.evidence.repeat_key).toContain("run_shell_command");
    expect(loop?.evidence.repeat_key).toContain("npm test");
  });

  it("不重复(每轮换目标)→ 不命中", () => {
    const n = SUPERVISOR_THRESHOLDS.loop_repeat_max * 2;
    const events = Array.from({ length: n }, (_, i) => toolEvt(i + 1, "read_file", `src/f${i}.ts`));
    expect(detectSupervisor({ now_ms: NOW, events }).find((f) => f.kind === "loop")).toBeUndefined();
  });

  it("归一化生效:同一工具同一目标带不同时间戳/随机 id 仍算重复", () => {
    const n = SUPERVISOR_THRESHOLDS.loop_repeat_max;
    const events = Array.from({ length: n }, (_, i) =>
      toolEvt(i + 1, "run_shell_command", `node scripts/rerun.js --at 2026-09-03T00:0${i}:00Z --id 76464e22-0000-4000-8000-00000000000${i}`),
    );
    const loop = detectSupervisor({ now_ms: NOW, events }).find((f) => f.kind === "loop");
    expect(loop?.evidence.repeat_count).toBe(n);
  });

  it("归一化生效:绝对路径里的临时目录段不影响重复判定", () => {
    const a = normalizeTarget("/tmp/qwen-3f9a2b7c/repo/src/a.ts");
    const b = normalizeTarget("/tmp/qwen-9d8e7f61/repo/src/a.ts");
    expect(a).toBe(b);
    expect(normalizeTarget("/workspace/repo/.qwen/tmp/beefbeef/out.md")).toBe(
      normalizeTarget("/workspace/repo/.qwen/tmp/12345678/out.md"),
    );
    expect(normalizeTarget("")).toBe("");
  });

  it("参数不同(归一化后仍可区分)→ 不算循环", () => {
    const events = [
      toolEvt(1, "edit", "src/a.ts"),
      toolEvt(2, "edit", "src/b.ts"),
      toolEvt(3, "edit", "src/c.ts"),
    ];
    expect(detectSupervisor({ now_ms: NOW, events }).find((f) => f.kind === "loop")).toBeUndefined();
  });

  it("命中次数翻倍 → severity 升 red", () => {
    const n = SUPERVISOR_THRESHOLDS.loop_repeat_max * 2;
    const events = Array.from({ length: n }, (_, i) => toolEvt(i + 1, "read_file", "src/a.ts"));
    const loop = detectSupervisor({ now_ms: NOW, events }).find((f) => f.kind === "loop");
    expect(loop?.severity).toBe("red");
  });
});

describe("no_progress(反复碰同一个目标)", () => {
  const n = SUPERVISOR_THRESHOLDS.no_progress_repeat_max;
  const touch = (seq: number, name: string, target: string) =>
    evt({ seq, payload: { tool_names: [name], tool_targets: [target] } });

  it("工具名交替但目标同一个 → 命中 no_progress(loop 抓不到)", () => {
    const events = Array.from({ length: n }, (_, i) =>
      touch(i + 1, i % 2 === 0 ? "read_file" : "edit_file", "src/stuck.ts"),
    );
    const findings = detectSupervisor({ now_ms: NOW, events });
    const np = findings.find((f) => f.kind === "no_progress");
    expect(np?.rule).toBe(RULE_NO_PROGRESS_TARGET_REPEAT);
    expect(np?.evidence.repeat_count).toBe(n);
    expect(findings.find((f) => f.kind === "loop")).toBeUndefined();
  });

  it("目标各不相同 → 不命中", () => {
    const events = Array.from({ length: n * 2 }, (_, i) => touch(i + 1, "read_file", `src/f${i}.ts`));
    expect(detectSupervisor({ now_ms: NOW, events }).find((f) => f.kind === "no_progress")).toBeUndefined();
  });

  it("命令首词形状:npm test 的反复执行算同一目标", () => {
    const events = Array.from({ length: n }, (_, i) =>
      touch(i + 1, "run_shell_command", `npm test -- --reporter=v${i}`),
    );
    const np = detectSupervisor({ now_ms: NOW, events }).find((f) => f.kind === "no_progress");
    expect(np?.evidence.repeat_key).toContain("npm test");
  });
});

describe("多判据并存", () => {
  it("悬挂前的循环痕迹与当前 stall 同时上报", () => {
    const n = SUPERVISOR_THRESHOLDS.loop_repeat_max;
    const events = [
      ...Array.from({ length: n }, (_, i) =>
        evt({ seq: i + 1, payload: { tool_names: ["run_shell_command"], tool_targets: ["npm test"] } }),
      ),
      // 最后一次动作停在 30 分钟前、且这段 journal 没有心跳 → downlevel yellow
      evt({ seq: 99, ts: new Date(NOW - 30 * 60_000).toISOString(), payload: { tool_names: ["run_shell_command"], tool_targets: ["npm test"] } }),
    ];
    const findings = detectSupervisor({ now_ms: NOW, events });
    expect(findings.map((f) => f.kind).sort()).toEqual(["loop", "stall"]);
    expect(stallOf(findings)?.severity).toBe("yellow");
    expect(stallOf(findings)?.rule).toBe(RULE_STALL_LAST_EVENT_GAP);
  });

  it("同一轮里 no_heartbeat 与 agent_silent 可以并存(runner 与模型一起停)", () => {
    const beatOld = (seq: number) =>
      evt({ seq, kind: OBS_HEARTBEAT_KIND, ts: new Date(NOW - 20 * 60_000).toISOString(), payload: { status: "running" } });
    const events = [
      evt({ seq: 1, ts: new Date(NOW - 25 * 60_000).toISOString() }),
      beatOld(2),
    ];
    const findings = detectSupervisor({ now_ms: NOW, events });
    expect(findings.map((f) => f.rule).sort()).toEqual([RULE_STALL_AGENT_SILENT, RULE_STALL_NO_HEARTBEAT].sort());
    // 两条各自一档:red 只来自心跳断,yellow 只来自转录静默。
    expect(findings.find((f) => f.rule === RULE_STALL_NO_HEARTBEAT)?.severity).toBe("red");
    expect(findings.find((f) => f.rule === RULE_STALL_AGENT_SILENT)?.severity).toBe("yellow");
  });
});

describe("心跳不进 loop / no_progress 的滑窗(必须排除)", () => {
  /** 一串只有心跳的 journal:一个 25 分钟任务会产 ~45 条,窗口 20/30 条会被心跳填满。 */
  function beatsOnly(n: number, stepMs = 33_000): AgentEventV1[] {
    return Array.from({ length: n }, (_, i) =>
      evt({
        seq: i + 1,
        kind: OBS_HEARTBEAT_KIND,
        ts: new Date(NOW - (n - i) * stepMs).toISOString(),
        payload: { status: "running", round_ms: 3_000, gap_ms: stepMs },
      }),
    );
  }

  /** 心跳排在行为事件**之后**(seq 与 ts 同序):窗槽位争夺的真实形态。 */
  function beatsAfter(behavioralCount: number, n: number, stepMs = 33_000): AgentEventV1[] {
    return Array.from({ length: n }, (_, i) =>
      evt({
        seq: behavioralCount + i + 1,
        kind: OBS_HEARTBEAT_KIND,
        ts: new Date(NOW - (n - i) * stepMs).toISOString(),
        payload: { status: "running", round_ms: stepMs, gap_ms: stepMs },
      }),
    );
  }

  it("一串心跳不推进行为类判据(它们不该成为任何判据的输入)", () => {
    const findings = detectSupervisor({ now_ms: NOW, events: beatsOnly(45) });
    // 45 条心跳 = 25 分钟里模型一条转录没产 → 允许报的是 agent_silent(黄),
    // 行为类判据必须一条都不许有。注意失效方向:心跳没有 tool_names、塌不成
    // repeat_key,所以**误报**不是这里的风险;风险在下面的槽位争夺(漏报)。
    expect(findings.map((f) => f.kind).sort()).toEqual(["stall"]);
    expect(findings.map((f) => f.rule)).toEqual([RULE_STALL_AGENT_SILENT]);
  });

  it("心跳混在真循环里也不改变计数(既不多算也不少算)", () => {
    const n = SUPERVISOR_THRESHOLDS.loop_repeat_max;
    const loop = Array.from({ length: n }, (_, i) =>
      evt({ seq: i + 1, payload: { tool_names: ["read_file"], tool_targets: ["src/a.ts"] } }),
    );
    // 交错插进心跳:窗口的条数上限会被心跳吃掉,排除后仍应按行为事件计数命中 loop。
    const mixed = loop.flatMap((e, i) => [e, ...beatsOnly(2).map((b) => ({ ...b, seq: 100 + i }))]);
    const without = detectSupervisor({ now_ms: NOW, events: loop });
    const withBeats = detectSupervisor({ now_ms: NOW, events: mixed });
    expect(without.find((f) => f.kind === "loop")?.evidence.repeat_count).toBe(n);
    expect(withBeats.find((f) => f.kind === "loop")?.evidence.repeat_count).toBe(n);
    expect(withBeats.find((f) => f.kind === "loop")?.evidence.has_heartbeat).toBe(true);
  });

  it("真循环被心跳**追在身后**时仍要命中 loop(排除失效的后果是漏报)", () => {
    // 交错形态对「有没有排除」不敏感(窗里总留得下那几条行为事件),而真实 journal 的形态
    // 是**成串心跳排在行为事件之后**:一个 25 分钟任务攒 ~45 条心跳,而 loop 窗只有 20 槽。
    // 不先排除心跳,slice(-20) 取到的全是心跳 → 真循环落在窗外 → 判据静默失聪。
    const { loop_window, loop_repeat_max } = SUPERVISOR_THRESHOLDS;
    const beats = loop_window + 5;
    const loop = Array.from({ length: loop_repeat_max }, (_, i) =>
      evt({
        seq: i + 1,
        ts: new Date(NOW - (beats + loop_repeat_max - i) * 33_000).toISOString(),
        payload: { tool_names: ["read_file"], tool_targets: ["src/a.ts"] },
      }),
    );
    const f = findingsOf(
      detectSupervisor({ now_ms: NOW, events: [...loop, ...beatsAfter(loop.length, beats)] }),
      RULE_LOOP_TOOL_REPEAT,
    );
    expect(f?.evidence.repeat_count).toBe(loop_repeat_max);
    // 窗大小钉的是**行为**条数:它 == loop_window 就说明窗被心跳占了(漏报正在发生)。
    expect(f?.evidence.window_size).toBe(loop_repeat_max);
  });

  it("同样形态下 no_progress 也要命中(两个窗各自有独立排除)", () => {
    // 两条判据各有一次 slice,改一处漏一处是这套接线最自然的错法 —— 上面那条只杀得动 loop。
    const { no_progress_window, no_progress_repeat_max } = SUPERVISOR_THRESHOLDS;
    const beats = no_progress_window + 5;
    const repeats = Array.from({ length: no_progress_repeat_max }, (_, i) =>
      evt({
        seq: i + 1,
        ts: new Date(NOW - (beats + no_progress_repeat_max - i) * 33_000).toISOString(),
        payload: { tool_names: [i % 2 === 0 ? "read_file" : "edit_file"], tool_targets: ["src/a.ts"] },
      }),
    );
    const f = findingsOf(
      detectSupervisor({ now_ms: NOW, events: [...repeats, ...beatsAfter(repeats.length, beats)] }),
      RULE_NO_PROGRESS_TARGET_REPEAT,
    );
    expect(f?.evidence.repeat_count).toBe(no_progress_repeat_max);
    expect(f?.evidence.window_size).toBe(no_progress_repeat_max);
  });

  it("同样的心跳仍要让 agent_silent 计时正确(排除≠丢弃时间源)", () => {
    // 转录只有一条 20 分钟前的动作,心跳一直新 → 只报 agent_silent,不报行为类判据。
    const events = [
      evt({ seq: 1, ts: new Date(NOW - 20 * 60_000).toISOString() }),
      ...beatsOnly(6, 30_000),
    ];
    const findings = detectSupervisor({ now_ms: NOW, events });
    expect(findings.map((f) => f.rule)).toEqual([RULE_STALL_AGENT_SILENT]);
  });
});

/**
 * target 的三级取值。第二、三级**不是**过渡兜底,是长期现实:
 * c10a 部署前落的 journal 段没有 tool_targets;`raw` / `assistant` 事件根本没有工具形状。
 */
describe("target 取值优先级(tool_targets → payload.text → 工具名)", () => {
  const n = SUPERVISOR_THRESHOLDS.loop_repeat_max;
  const keyOf = (events: AgentEventV1[]) =>
    detectSupervisor({ now_ms: NOW, events }).find((f) => f.kind === "loop")?.evidence.repeat_key;
  const five = (payload: Record<string, unknown>) =>
    Array.from({ length: n }, (_, i) => evt({ seq: i + 1, payload }));

  it("有 tool_targets 时按它成形(text 同时存在也不看 text)", () => {
    expect(keyOf(five({ tool_names: ["read_file"], tool_targets: ["src/real.ts"], text: "顺手说的一句" }))).toBe(
      "read_file@src/real.ts",
    );
  });

  it("无 tool_targets → 退回 payload.text(老段文件照常工作,不抛)", () => {
    expect(keyOf(five({ tool_names: ["read_file"], text: "src/old.ts" }))).toBe("read_file@src/old.ts");
  });

  it("两级都取不到 → 退化为工具名:这是分辨率的地板,同一工具的任意两次调用都会算重复", () => {
    expect(keyOf(five({ tool_names: ["read_file"] }))).toBe("read_file@read_file");
  });

  it("下标对齐的 \"\" 占位不算目标:跳过占位取第一个非空条目", () => {
    expect(
      keyOf(five({ tool_names: ["mcp_thing", "read_file"], tool_targets: ["", "src/aligned.ts"] })),
    ).toBe("mcp_thing,read_file@src/aligned.ts");
  });

  it("脏 payload 不抛:tool_targets 不是数组、项不是字符串、全为空串", () => {
    const noThrow = (payload: Record<string, unknown>) =>
      expect(() => detectSupervisor({ now_ms: NOW, events: five(payload) })).not.toThrow();
    noThrow({ tool_names: ["read_file"], tool_targets: "src/a.ts" });
    noThrow({ tool_names: ["read_file"], tool_targets: [7, null] });
    noThrow({ tool_names: ["read_file"], tool_targets: ["", "  "] });
    noThrow({ tool_targets: ["src/a.ts"] });
    // 全空串时按地板降级(而不是把 "" 当成一个目标)
    expect(keyOf(five({ tool_names: ["read_file"], tool_targets: [""] }))).toBe("read_file@read_file");
  });
});

/**
 * 完整 sanitize 路径 —— c10 技术债的正向证据。
 *
 * 这组用例把 transcript 行喂给 `toAgentEventV1`(= ingress 写进 journal 的同一条路径),
 * 产物原样喂给 `detectSupervisor`。判据单测可以自己造一个 prod 产不出的 payload,
 * 摄取单测只断言 payload 的键;两道测试之间那道缝正是 c10 翻车的地方,这里由同一条
 * 断言两头钉住:ingress 少留一个字段,判据就会在这里从「不命中」变成「命中」。
 */
describe("ingress ↔ 判据的同一条缝(transcript 行 → sanitize → detect)", () => {
  const n = SUPERVISOR_THRESHOLDS.loop_repeat_max;
  const TS_FRESH = new Date(NOW - 10_000).toISOString();

  const ingest = (lines: Array<Record<string, unknown>>): AgentEventV1[] =>
    lines.map((line, i) =>
      toAgentEventV1({
        taskId: TASK,
        attemptId: ATTEMPT,
        generation: 1,
        seq: i + 1,
        ts: TS_FRESH,
        line: JSON.stringify(line),
      }),
    );
  const toolLine = (name: string, input: Record<string, unknown>) => ({
    type: "assistant",
    content: [{ type: "tool_use", id: `t-${name}`, name, input }],
  });
  const loopOf = (events: AgentEventV1[]) =>
    detectSupervisor({ now_ms: NOW, events }).find((f) => f.kind === "loop");

  it("prod 形状自检:tool_use 的 payload 只有 tool_names/tool_targets,没有 text", () => {
    const [e] = ingest([toolLine("read_file", { file_path: "src/a.ts" })]);
    expect(e.kind).toBe("tool_use");
    expect(e.payload).toEqual({ tool_names: ["read_file"], tool_targets: ["src/a.ts"] });
  });

  it("关掉误报面:连续 5 次读 5 个**不同**文件(= c10 里会误报的形态)→ 不命中 loop", () => {
    const events = ingest(
      Array.from({ length: n }, (_, i) => toolLine("read_file", { file_path: `src/f${i}.ts` })),
    );
    const findings = detectSupervisor({ now_ms: NOW, events });
    expect(loopOf(events)).toBeUndefined();
    expect(findings.find((f) => f.kind === "no_progress")).toBeUndefined();
  });

  it("判据没被改哑:同一文件反复读 5 次 → 命中 loop,repeat_key 带真实路径", () => {
    const events = ingest(
      Array.from({ length: n }, () => toolLine("read_file", { file_path: "src/a.ts" })),
    );
    const loop = loopOf(events);
    expect(loop?.evidence.repeat_key).toBe("read_file@src/a.ts");
    expect(loop?.evidence.repeat_count).toBe(n);
  });

  it("同一文件反复读满 no_progress_repeat_max 次 → loop 与 no_progress 同时命中", () => {
    const events = ingest(
      Array.from({ length: SUPERVISOR_THRESHOLDS.no_progress_repeat_max }, () =>
        toolLine("read_file", { file_path: "src/a.ts" }),
      ),
    );
    expect(detectSupervisor({ now_ms: NOW, events }).map((f) => f.kind).sort()).toEqual([
      "loop",
      "no_progress",
    ]);
  });

  it("命令类工具走 command 成形:反复跑同一句 → 命中;换目标 → 不命中", () => {
    const same = ingest(
      Array.from({ length: n }, () =>
        toolLine("run_shell_command", { command: "npm test -- --reporter=v1" }),
      ),
    );
    expect(loopOf(same)?.evidence.repeat_key).toBe("run_shell_command@npm test");
    const mixed = ingest([
      ...Array.from({ length: n - 1 }, () => toolLine("run_shell_command", { command: "npm test" })),
      toolLine("run_shell_command", { command: "npm run build" }),
    ]);
    expect(loopOf(mixed)).toBeUndefined();
  });

  it("白名单取不到形状的工具(input 里没有可取键)→ 如实退化到地板,不抛", () => {
    const events = ingest(
      Array.from({ length: n }, () => toolLine("mcp_search", { query: "how do I do it" })),
    );
    expect(events[0].payload).not.toHaveProperty("tool_targets");
    expect(loopOf(events)?.evidence.repeat_key).toBe("mcp_search@mcp_search");
  });

  it("真实 transcript 里 loop 与 stall 可以并存(悬挂前在转圈)", () => {
    const events = ingest(
      Array.from({ length: n }, () => toolLine("edit", { file_path: "src/a.ts" })),
    ).map((e, i) => ({ ...e, ts: new Date(NOW - (n - i + 2) * 10 * 60_000).toISOString() }));
    const findings = detectSupervisor({ now_ms: NOW, events });
    // 最后一行停在 30 分钟前、且这批段里没有心跳(downlevel)→ stall 一档 yellow。
    // 旧的 300s 红线在这里会报 red,而那正是「对健康任务准备误报」的来源。
    expect(findings.map((f) => f.kind).sort()).toEqual(["loop", "stall"]);
    expect(findings.find((f) => f.kind === "stall")?.severity).toBe("yellow");
  });
});

/** finding 造一份给去重层用(绕开判据,专测去重)。 */
function finding(severity: "yellow" | "red"): SupervisorFinding {
  return {
    kind: "stall",
    rule: RULE_STALL_LAST_EVENT_GAP,
    severity,
    evidence: {
      last_event_ts: new Date(NOW).toISOString(),
      gap_ms: 120_000,
      window_size: 1,
      // 去重层不关心判据形状,但 SupervisorEvidence 的 has_heartbeat 是必填:它决定了
      // shadow 样本怎么分段,所以「随手造一条 finding」的夹具也得如实带上。
      has_heartbeat: false,
    },
  };
}

describe("幂等去重(权威链不是日志垃圾桶)", () => {
  const MIN = 60_000;

  it("同一 finding 第二次 tick 不产生第二条事件", () => {
    const first = selectFindingsToEmit({ attempt_id: ATTEMPT, findings: [finding("yellow")], reported: {}, now_ms: NOW });
    expect(first.emit).toHaveLength(1);
    const second = selectFindingsToEmit({ attempt_id: ATTEMPT, findings: [finding("yellow")], reported: first.reported, now_ms: NOW + 5 * MIN });
    expect(second.emit).toHaveLength(0);
  });

  it("yellow→red 升级产生新事件", () => {
    const first = selectFindingsToEmit({ attempt_id: ATTEMPT, findings: [finding("yellow")], reported: {}, now_ms: NOW });
    const up = selectFindingsToEmit({ attempt_id: ATTEMPT, findings: [finding("red")], reported: first.reported, now_ms: NOW + 4 * MIN });
    expect(up.emit.map((f) => f.severity)).toEqual(["red"]);
  });

  it("冷却期过后产生新事件(缺省 10 分钟)", () => {
    const first = selectFindingsToEmit({ attempt_id: ATTEMPT, findings: [finding("red")], reported: {}, now_ms: NOW });
    const still = selectFindingsToEmit({
      attempt_id: ATTEMPT,
      findings: [finding("red")],
      reported: first.reported,
      now_ms: NOW + SUPERVISOR_DEDUPE_COOLDOWN_MS,
    });
    expect(still.emit).toHaveLength(0);
    const after = selectFindingsToEmit({
      attempt_id: ATTEMPT,
      findings: [finding("red")],
      reported: first.reported,
      now_ms: NOW + SUPERVISOR_DEDUPE_COOLDOWN_MS + 1,
    });
    expect(after.emit).toHaveLength(1);
  });

  it("冷却期可注入;不同 attempt / 不同 kind 各自独立去重", () => {
    const first = selectFindingsToEmit({ attempt_id: ATTEMPT, findings: [finding("red")], reported: {}, now_ms: NOW, cooldown_ms: 2 * MIN });
    const other = selectFindingsToEmit({ attempt_id: "33333333-3333-4333-8333-333333333333", findings: [finding("red")], reported: first.reported, now_ms: NOW + MIN });
    expect(other.emit).toHaveLength(1);
    const loopFinding: SupervisorFinding = { kind: "loop", rule: RULE_LOOP_TOOL_REPEAT, severity: "yellow", evidence: { ...finding("yellow").evidence, repeat_key: "read_file@src/a.ts", repeat_count: 5 } };
    const mixed = selectFindingsToEmit({ attempt_id: ATTEMPT, findings: [finding("red"), loopFinding], reported: first.reported, now_ms: NOW + MIN });
    expect(mixed.emit.map((f) => f.kind)).toEqual(["loop"]);
  });

  it("red→(恢复)yellow→red:第二次 red 仍要报", () => {
    let reported = selectFindingsToEmit({ attempt_id: ATTEMPT, findings: [finding("red")], reported: {}, now_ms: NOW }).reported;
    reported = selectFindingsToEmit({ attempt_id: ATTEMPT, findings: [finding("yellow")], reported, now_ms: NOW + 2 * MIN }).reported;
    const again = selectFindingsToEmit({ attempt_id: ATTEMPT, findings: [finding("red")], reported, now_ms: NOW + 4 * MIN });
    expect(again.emit.map((f) => f.severity)).toEqual(["red"]);
  });
});

describe("两个 env 旋钮的解析(启用点必须可审计)", () => {
  it("只有显式 shadow 才启用;其余值/未配一律 off", () => {
    expect(supervisorModeOf("shadow")).toBe("shadow");
    expect(supervisorModeOf(undefined)).toBe("off");
    expect(supervisorModeOf("Shadow")).toBe("off");
    expect(supervisorModeOf("enforce")).toBe("off");
    expect(supervisorModeOf("")).toBe("off");
  });

  it("tick 可注入;非法/非正数回落 60s", () => {
    expect(supervisorTickMsOf("90")).toBe(90_000);
    expect(supervisorTickMsOf(undefined)).toBe(SUPERVISOR_DEFAULT_TICK_SECONDS * 1000);
    expect(supervisorTickMsOf("0")).toBe(60_000);
    expect(supervisorTickMsOf("-5")).toBe(60_000);
    expect(supervisorTickMsOf("abc")).toBe(60_000);
  });
});

describe("supervisor_finding payload 形状", () => {
  it("shadow + enforced:false,处置权不在本层", () => {
    const payload = supervisorFindingPayload({ attempt_id: ATTEMPT, finding: finding("red"), mode: "shadow" });
    expect(payload).toMatchObject({
      attempt_id: ATTEMPT,
      kind: "stall",
      rule: RULE_STALL_LAST_EVENT_GAP,
      severity: "red",
      mode: "shadow",
      enforced: false,
    });
    expect((payload.evidence as { gap_ms: number }).gap_ms).toBe(120_000);
  });
});
