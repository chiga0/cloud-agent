import { describe, expect, it } from "vitest";
import { toAgentEventV1, type AgentEventV1 } from "../src/obs/events";
import { LIVE_STALL_DANGER_SECONDS, LIVE_STALL_WARN_SECONDS } from "../src/obs/live";
import {
  detectSupervisor,
  normalizeTarget,
  RULE_LOOP_TOOL_REPEAT,
  RULE_NO_PROGRESS_TARGET_REPEAT,
  RULE_STALL_LAST_EVENT_GAP,
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

/** 一条正常心跳的事件流:最后一条在 now-10s,不会触发 stall。 */
function healthy(n = 3) {
  return Array.from({ length: n }, (_, i) => evt({ seq: i + 1 }));
}

function stallOf(findings: SupervisorFinding[]) {
  return findings.find((f) => f.kind === "stall");
}

describe("stall(心跳:最后一条观测事件距今多久)", () => {
  it("人眼阈值与 Supervisor 阈值同一口径", () => {
    // 两套阈值一旦漂移,会出现「Live UI 早就红了而 Supervisor 一声不响」
    expect(SUPERVISOR_THRESHOLDS.stall_yellow_ms).toBe(LIVE_STALL_WARN_SECONDS * 1000);
    expect(SUPERVISOR_THRESHOLDS.stall_red_ms).toBe(LIVE_STALL_DANGER_SECONDS * 1000);
  });

  it("gap 超过 yellow 未过 red → 一条 yellow,证据带精确 gap", () => {
    const events = [evt({ seq: 1, ts: new Date(NOW - 120_000).toISOString() })];
    const findings = detectSupervisor({ now_ms: NOW, events });
    const stall = stallOf(findings);
    expect(stall?.severity).toBe("yellow");
    expect(stall?.rule).toBe(RULE_STALL_LAST_EVENT_GAP);
    expect(stall?.evidence.gap_ms).toBe(120_000);
    expect(stall?.evidence.last_event_ts).toBe(events[0].ts);
    expect(stall?.evidence.window_size).toBe(1);
  });

  it("gap 超过 red → red(C2-r6 那次 24 分钟悬挂的形态)", () => {
    const events = [evt({ seq: 1, ts: new Date(NOW - 24 * 60_000).toISOString() })];
    const stall = stallOf(detectSupervisor({ now_ms: NOW, events }));
    expect(stall?.severity).toBe("red");
    expect(stall?.evidence.gap_ms).toBe(1_440_000);
  });

  it("健康(gap 10s)不报 stall", () => {
    expect(stallOf(detectSupervisor({ now_ms: NOW, events: healthy() }))).toBeUndefined();
  });

  it("恰好等于阈值不报(严格大于)", () => {
    const atYellow = [evt({ seq: 1, ts: new Date(NOW - SUPERVISOR_THRESHOLDS.stall_yellow_ms).toISOString() })];
    expect(stallOf(detectSupervisor({ now_ms: NOW, events: atYellow }))).toBeUndefined();

    // 恰好等于 red 不报 red,但**仍然 > yellow** → 落 yellow。档位的判据是「超过哪一档」,
    // 不是「等于哪一档」:等于 red 的时刻确实已经越过了 yellow 那条线。
    const atRed = [evt({ seq: 1, ts: new Date(NOW - SUPERVISOR_THRESHOLDS.stall_red_ms).toISOString() })];
    expect(stallOf(detectSupervisor({ now_ms: NOW, events: atRed }))?.severity).toBe("yellow");
  });

  it("阈值 +1ms 立刻报:边界两侧各钉一次", () => {
    const yellowEdge = [evt({ seq: 1, ts: new Date(NOW - (SUPERVISOR_THRESHOLDS.stall_yellow_ms + 1)).toISOString() })];
    expect(stallOf(detectSupervisor({ now_ms: NOW, events: yellowEdge }))?.severity).toBe("yellow");
    const redEdge = [evt({ seq: 1, ts: new Date(NOW - (SUPERVISOR_THRESHOLDS.stall_red_ms + 1)).toISOString() })];
    expect(stallOf(detectSupervisor({ now_ms: NOW, events: redEdge }))?.severity).toBe("red");
  });

  it("注入时钟下 gap 精确到毫秒", () => {
    const ts = "2026-09-03T00:00:00.123Z";
    const stall = stallOf(detectSupervisor({ now_ms: Date.parse(ts) + 91_000, events: [evt({ seq: 1, ts })] }));
    expect(stall?.evidence.gap_ms).toBe(91_000);
  });
});

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
      // 最后一次动作停在 30 分钟前:stall red
      evt({ seq: 99, ts: new Date(NOW - 30 * 60_000).toISOString(), payload: { tool_names: ["run_shell_command"], tool_targets: ["npm test"] } }),
    ];
    const findings = detectSupervisor({ now_ms: NOW, events });
    expect(findings.map((f) => f.kind).sort()).toEqual(["loop", "stall"]);
    expect(stallOf(findings)?.severity).toBe("red");
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
    ).map((e, i) => ({ ...e, ts: new Date(NOW - (n - i + 2) * 60_000).toISOString() }));
    const findings = detectSupervisor({ now_ms: NOW, events });
    expect(findings.map((f) => f.kind).sort()).toEqual(["loop", "stall"]);
  });
});

/** finding 造一份给去重层用(绕开判据,专测去重)。 */
function finding(severity: "yellow" | "red"): SupervisorFinding {
  return {
    kind: "stall",
    rule: RULE_STALL_LAST_EVENT_GAP,
    severity,
    evidence: { last_event_ts: new Date(NOW).toISOString(), gap_ms: 120_000, window_size: 1 },
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
