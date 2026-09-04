import { describe, expect, it } from "vitest";
import {
  OBS_EVENT_KINDS,
  OBS_HEARTBEAT_KIND,
  OBS_SECRET_MASK,
  OBS_TEXT_MAX_CHARS,
  maskSecrets,
  obsKindOfLine,
  obsSecretValues,
  toAgentEventV1,
  toHeartbeatEvent,
} from "../src/obs/events";
import { LONGRUN_STATUSES, type LongRunStatus, type ProcessSnapshot } from "../src/exec/longrun";
import { SHELL_FIXTURE, SHELL_FIXTURE_COLLAPSED_KEY } from "./fixtures/shell-command-shapes";
import type { Env } from "../src/types";

/**
 * AgentEventV1 的 ingress 契约:kind 映射、字段白名单、凭据打码、文本截断。
 *
 * 这一层是外圈唯一能在任务 RUNNING 时看到的东西,所以两侧的失败都要钉住:
 * - **漏字段**(白名单写成黑名单)→ 沙箱里的凭据顺着 journal 出到读端点;
 * - **丢行**(认不出就扔)→ 悬挂前最后几条正好是协议里没见过的行类型,
 *   最需要看的时候看不到。
 */

const TASK = "11111111-1111-4111-8111-111111111111";
const ATTEMPT = "22222222-2222-4222-8222-222222222222";
const TS = "2026-09-01T00:00:00.000Z";

const KEY = "sk-1234567890abcdef1234567890abcdef";

function build(line: unknown, over: Partial<Parameters<typeof toAgentEventV1>[0]> = {}) {
  return toAgentEventV1({
    taskId: TASK,
    attemptId: ATTEMPT,
    generation: 1,
    seq: 1,
    ts: TS,
    line: typeof line === "string" ? line : JSON.stringify(line),
    ...over,
  });
}

describe("AgentEventV1 信封", () => {
  it("字段齐全且形状固定:读端点与下一期 Supervisor 只认这个信封", () => {
    const e = build({ type: "system", subtype: "init", model: "qwen3.8-flash" });
    expect(Object.keys(e).sort()).toEqual([
      "attempt_id",
      "generation",
      "kind",
      "payload",
      "seq",
      "task_id",
      "ts",
      "v",
    ]);
    expect(e.v).toBe(1);
    expect(e.task_id).toBe(TASK);
    expect(e.attempt_id).toBe(ATTEMPT);
    expect(e.generation).toBe(1);
    expect(e.seq).toBe(1);
    expect(e.ts).toBe(TS);
    expect(OBS_EVENT_KINDS).toContain(e.kind);
  });

  it("seq 与 generation 由调用方给定(幂等判定在游标层,不在信封层)", () => {
    const e = build({ type: "assistant" }, { seq: 41, generation: 3 });
    expect({ seq: e.seq, generation: e.generation }).toEqual({ seq: 41, generation: 3 });
  });

  it("transcript 行类型 → kind;带 tool_use 块的 assistant 行算 tool_use", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ type: "system", subtype: "init" }, "system"],
      [{ type: "assistant", content: [{ type: "text", text: "我先看目录" }] }, "assistant"],
      [
        {
          type: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "run_shell_command", input: { command: "ls" } }],
        },
        "tool_use",
      ],
      [
        {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a.ts\nb.ts" }] },
        },
        "tool_result",
      ],
      [{ type: "user", message: { content: [{ type: "text", text: "prompt" }] } }, "user"],
      [{ type: "result", subtype: "success", result: "done" }, "result"],
      [{ type: "result", subtype: "error_max_turns", is_error: true }, "error"],
      [{ type: "weird_unseen_row" }, "raw"],
    ];
    for (const [line, want] of cases) {
      expect(obsKindOfLine(line), `${JSON.stringify(line)} → ${want}`).toBe(want);
      expect(build(line).kind, `${JSON.stringify(line)} → ${want}`).toBe(want);
    }
  });

  it("未知类型不丢:kind=raw 且留住原 type,外圈才看得出协议外行了什么", () => {
    const e = build({ type: "progress", stage: "checkout" });
    expect(e.kind).toBe("raw");
    expect(e.payload.raw_type).toBe("progress");
  });

  it("非 JSON 行也产事件(悬挂前最后写出的往往正是这种半行)", () => {
    const e = build("Fatal: upstream stream stalled\n");
    expect(e.kind).toBe("raw");
    expect(e.payload.unparseable).toBe(true);
    expect(e.payload.text).toContain("upstream stream stalled");
  });
});

describe("ingress 白名单与脱敏", () => {
  it("只留白名单字段:未列白的键一律不进 payload", () => {
    const e = build({
      type: "assistant",
      subtype: "none",
      proxy_token: KEY,
      api_key: KEY,
      env: { OPENAI_API_KEY: KEY },
      request_id: "req-1",
      content: [{ type: "text", text: "正文" }],
    });
    expect(Object.keys(e.payload).sort()).toEqual(["subtype", "text"]);
    // 按字段名混进来的凭据必须在 payload 里彻底消失
    expect(JSON.stringify(e.payload)).not.toContain(KEY);
  });

  it("枚举型信息保留:token 用量、时长、轮次、退出码、工具名", () => {
    const e = build({
      type: "result",
      subtype: "success",
      num_turns: 12,
      duration_ms: 1440000,
      duration_api_ms: 1400000,
      total_cost_usd: 0.5,
      usage: { input_tokens: 100, cache_read_input_tokens: 90, output_tokens: 5, total_tokens: 105 },
      result: "ok",
    });
    expect(e.kind).toBe("result");
    expect(e.payload.usage).toEqual({
      input_tokens: 100,
      cache_read_input_tokens: 90,
      output_tokens: 5,
      total_tokens: 105,
    });
    expect(e.payload.num_turns).toBe(12);
    expect(e.payload.duration_ms).toBe(1440000);
    expect(e.payload.text).toBe("ok");
  });

  it("usage 里非数值的字段丢弃:0 是「上游说没消耗」,不是「上游没说」", () => {
    const e = build({ type: "result", usage: { input_tokens: 7, output_tokens: "many" } });
    expect(e.payload.usage).toEqual({ input_tokens: 7 });
  });

  it("tool_use 留工具名 + 白名单参数目标,丢其余参数:参数里通常是整个文件内容", () => {
    const e = build({
      type: "assistant",
      content: [
        { type: "tool_use", name: "write_file", input: { file_path: "/x/y.ts", content: "整个文件" } },
        { type: "tool_use", name: "read_file", input: { file_path: "/x/y.ts" } },
      ],
    });
    expect(e.kind).toBe("tool_use");
    expect(e.payload.tool_names).toEqual(["write_file", "read_file"]);
    // file_path 在白名单里 → 路径形状留下(判据要靠它区分「读 A」与「读 B」);
    // content 不在 → 整个文件正文一个字节都不进 journal。
    expect(e.payload.tool_targets).toEqual(["/x/y.ts", "/x/y.ts"]);
    expect(JSON.stringify(e.payload)).not.toContain("整个文件");
  });
});

/**
 * tool_targets 的形状契约。这一组用例的存在理由:§9.8 的 loop / no_progress 判据
 * 分辨率**完全**取决于这里多留的形状,而它同时是 ingress 唯一一处「从 input 里取值」
 * 的地方 —— 白名单一旦写宽,泄露面就在这儿;写窄(或不留空位),判据就退回工具名。
 */
describe("payload.tool_targets(入参形状摘要:按键白名单 + 打码 + ≤128)", () => {
  const tool = (input: unknown, name = "read_file") => ({
    type: "tool_use",
    name,
    id: "t1",
    input,
  });

  it("白名单键原样取值,且与 tool_names 同长度同顺序(下标对齐)", () => {
    const e = build({
      type: "assistant",
      content: [
        tool({ file_path: "/repo/src/a.ts" }, "read_file"),
        tool({ path: "src/b.ts" }, "edit"),
        tool({ pattern: "**/*.test.ts" }, "glob"),
        tool({ directory: "/repo/src" }, "list"),
      ],
    });
    expect(e.payload.tool_names).toEqual(["read_file", "edit", "glob", "list"]);
    expect(e.payload.tool_targets).toEqual([
      "/repo/src/a.ts",
      "src/b.ts",
      "**/*.test.ts",
      "/repo/src",
    ]);
  });

  it("command 取选中段的首词 + 首个可当目标的实参:flag 与其余 token 一律不留", () => {
    const e = build({
      type: "assistant",
      content: [tool({ command: `npm test -- --reporter=verbose --token=${KEY}` }, "run_shell_command")],
    });
    expect(e.payload.tool_targets).toEqual(["npm test"]);
    expect(JSON.stringify(e.payload)).not.toContain(KEY);
    expect(JSON.stringify(e.payload)).not.toContain("verbose");

    // 只有首词(没有可当目标的实参)时不补空格,也不会退化成整行
    const bare = build({ type: "assistant", content: [tool({ command: "git status" }, "run_shell_command")] });
    expect(bare.payload.tool_targets).toEqual(["git status"]);
    const only = build({ type: "assistant", content: [tool({ command: "pwd" }, "run_shell_command")] });
    expect(only.payload.tool_targets).toEqual(["pwd"]);
  });

  /**
   * c14 首样本的失效根因:`cd X && <任何事>` 塌成 `cd X`,于是**健康** writer 的 36 次
   * shell 调用里 35 次共用一个键,loop 与 no_progress 各亮一条黄。下面这组用例钉住修好
   * 之后的形状:复合命令行逐段取形状,一条 tool_use 仍然只产一个键 —— 所以 window 与
   * repeat_count 的既有语义一个字都没动,变的只是键的分辨率。
   */
  it("复合命令行按 && / || / ; 分段:cd 前缀不再吞掉真正的动作", () => {
    const cases: Array<[string, string]> = [
      ["cd /workspace/repo && git log --oneline -3", "git log"],
      // 动作比 `cd X` 短也照样赢:前缀段不参与选段,否则这条判据永远在 cd 上误报
      ["cd /workspace/repo && ls", "ls"],
      ["cd /workspace/repo && npm test 2>&1 | tail -30", "npm test"],
      // `;` 与 `||` 同样是边界(闭合的三成员)
      ["cd /workspace/repo && npx tsc --noEmit; echo TSC_DONE", "npx tsc"],
      ["cd /w && test -f src/a.ts || echo missing", "test src/a.ts"],
      // 装饰段(标题 echo、收尾短段)抢不过真正的动作:取「最具体」的那一段
      ['cd /w && echo "=== alarm tail ===" && sed -n "10,20p" src/index.ts', "sed src/index.ts"],
      // 没有 cd 前缀时同样只留一段
      ["tail -5 /tmp/install.log 2>/dev/null; ls /w/node_modules 2>/dev/null | wc -l", "ls /w/node_modules"],
      // 悬空/连续的分隔符不产空段,也不会因为多一个边界就取不到形状
      ["cd /w && && echo hi", "echo hi"],
    ];
    for (const [command, want] of cases) {
      const e = build({ type: "assistant", content: [tool({ command }, "run_shell_command")] });
      expect(e.payload.tool_targets, command).toEqual([want]);
    }
  });

  it("单竖线 | 不是分段符:引号内的正则或、管道尾巴都不改变形状", () => {
    // 这一条钉住分段符集合为什么只有三成员(操作员在同一批 36 条上实测:含 `|` 的有 24 条,
    // 其中 12 条的 `|` 在引号内)。按 `|` 切会把模式劈成碎片,选段规则于是选中尾碎片
    // ⇒ 键变成 `not_archived" src/` 这类东西:随模式文本漂移(真空转反而测不出),
    // 而且把 grep 模式送上观测面。
    const withPipe = build({
      type: "assistant",
      content: [
        tool(
          { command: `cd /w && grep -rn "chain-check\\|chainCheck\\|brokenTasks\\|not_archived" src/ | head -40` },
          "run_shell_command",
        ),
      ],
    });
    expect(withPipe.payload.tool_targets).toEqual(["grep src/"]);
    const json = JSON.stringify(withPipe.payload);
    expect(json).not.toContain("not_archived");
    expect(json).not.toContain("chain-check");
    expect(json).not.toContain("|");

    // 换了管道尾巴(竖线之后的全部内容)不算换了动作 ⇒ 仍是同一个键。反过来,若 `|` 被
    // 当成分段符,这两条会得到两个不同的键 —— 那正是「键随模式文本漂移」的形状。
    const otherTail = build({
      type: "assistant",
      content: [tool({ command: `cd /w && sed -n "1,30p" src/index.ts | grep -n "import"` }, "run_shell_command")],
    });
    expect(otherTail.payload.tool_targets).toEqual(["sed src/index.ts"]);
  });

  it("正文不当目标:引号里的模式与消息、命令替换、重定向一律不进 payload", () => {
    const cases: Array<[string, string]> = [
      // 模式里带空格 ⇒ 按空白切出的两块都只是正文碎片(后一块只剩右引号),两端都不许留
      ['cd /w && grep -n "async archive\\|archive(" src/a.ts', "grep src/a.ts"],
      ['cd /w && sed -n "1470,1560p" src/control/session.ts', "sed src/control/session.ts"],
      ["cd /w && echo $(date) done", "echo done"],
      ["cd /w && npm test --silent >/dev/null 2>&1", "npm test"],
    ];
    for (const [command, want] of cases) {
      const e = build({ type: "assistant", content: [tool({ command }, "run_shell_command")] });
      expect(e.payload.tool_targets, command).toEqual([want]);
    }
    // 形状里不许出现引号内的正文:这是「input 不进 journal」在命令通道上的同一口径
    const patterned = build({
      type: "assistant",
      content: [
        tool(
          { command: `cd /w && grep -n "async archive\\|ARCHIVE_RETRY_LADDER_MS\\|archive_retry_step" src/a.ts` },
          "run_shell_command",
        ),
      ],
    });
    expect(JSON.stringify(patterned.payload)).not.toContain("ARCHIVE_RETRY_LADDER_MS");
    expect(JSON.stringify(patterned.payload)).not.toContain("archive_retry_step");
  });

  it("整行都是前缀段时保留 cd:裸 `cd X` 反复跑仍然是空转(判据不许改哑)", () => {
    // 丢掉前缀段是为了看见真正的动作,不是为了让 `cd` 消失:整行没有别的动作时,
    // 重复九次的裸 `cd` 就该按 `cd <dir>` 算重复 —— 否则这条修反倒成了「把判据阉掉」。
    const cases: Array<[string, string]> = [
      ["cd /workspace/repo", "cd /workspace/repo"],
      ["cd /w; cd /w/x", "cd /w"],
      ["cd /w && export FOO=1", "cd /w"],
    ];
    for (const [command, want] of cases) {
      const e = build({ type: "assistant", content: [tool({ command }, "run_shell_command")] });
      expect(e.payload.tool_targets, command).toEqual([want]);
    }
  });

  it("prod 夹具 12 条:主键占比从 11/12 打下来,且逐条形状与判据侧共用同一份表", () => {
    const commands = SHELL_FIXTURE.map((f) => f.command);
    // 每个块用不同工具名:tool_names 是去重的,重名块不产 slot(那是另一条契约)
    const e = build({
      type: "assistant",
      content: commands.map((command, i) => tool({ command }, `sh_${i}`)),
    });
    const targets = e.payload.tool_targets as string[];
    // 一条 tool_use 只贡献一个键:数组长度 = 命令行条数,没有哪条被拆成两个
    expect(targets).toHaveLength(commands.length);
    expect(targets).toEqual(SHELL_FIXTURE.map((f) => f.shape));
    const counts = new Map<string, number>();
    for (const t of targets) counts.set(t, (counts.get(t) ?? 0) + 1);
    expect(counts.size).toBeGreaterThanOrEqual(10);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(Math.ceil(commands.length / 6));
    // 塌缩的反证:修之前 12 条里 11 条的键都是 SHELL_FIXTURE_COLLAPSED_KEY
    expect(targets.filter((t) => t === SHELL_FIXTURE_COLLAPSED_KEY)).toHaveLength(1);
    // 泄露面钉在常数级:模式文本一个字节都不许进 payload
    const json = JSON.stringify(e.payload);
    for (const leak of ["ARCHIVE_RETRY_LADDER_MS", "archive_stalled", "chainCheck", "not_archived", "alarm tail"]) {
      expect(json, leak).not.toContain(leak);
    }
  });

  it("键名大小写与分隔符不敏感:同一工具改名换写法仍能取到", () => {
    const variants = ["filePath", "FILE_PATH", "File-Path", " file path ", "path"];
    for (const key of variants) {
      const e = build({ type: "assistant", content: [tool({ [key.trim()]: "src/c.ts" })] });
      expect(e.payload.tool_targets, key).toEqual(["src/c.ts"]);
    }
  });

  it("认不出的键一律不取(宁可少一个观测维度,不可多一个泄露面)", () => {
    const e = build({
      type: "assistant",
      content: [
        tool({ notebook_path: "/x/y.ipynb", cmd: "ls", query: "SECRET-Q", text: "正文" }, "read_file"),
      ],
    });
    expect(e.payload.tool_names).toEqual(["read_file"]);
    // 一个形状都没取到 → 整键缺省(不是写 [])
    expect(e.payload).not.toHaveProperty("tool_targets");
    expect(JSON.stringify(e.payload)).not.toContain("/x/y.ipynb");
    expect(JSON.stringify(e.payload)).not.toContain("SECRET-Q");
  });

  it("取不到形状的 slot 写空串占位,不让数组错位", () => {
    const e = build({
      type: "assistant",
      content: [
        tool({ unknown_key: "v" }, "mcp_thing"),
        tool({ file_path: "/repo/src/d.ts" }, "read_file"),
      ],
    });
    expect(e.payload.tool_names).toEqual(["mcp_thing", "read_file"]);
    expect(e.payload.tool_targets).toEqual(["", "/repo/src/d.ts"]);
  });

  it("非字符串值与空白值不算形状;input 缺失/非对象也不炸", () => {
    const nested = build({
      type: "assistant",
      content: [
        tool({ file_path: { path: "/x.ts" } }), // 结构化值不递归
        tool({ command: "   " }, "b"),
        { type: "tool_use", name: "c" }, // 没有 input
        { type: "tool_use", name: "d", input: "not-an-object" },
      ],
    });
    expect(nested.payload.tool_names).toEqual(["read_file", "b", "c", "d"]);
    expect(nested.payload).not.toHaveProperty("tool_targets");
  });

  it("目标里的凭据值先打码后截断,长度 ≤128", () => {
    const e = build(
      {
        type: "assistant",
        content: [tool({ file_path: `/tmp/${KEY}/rest-of-the-path-that-keeps-going-and-going-and-going-${"x".repeat(200)}` })],
      },
      { secrets: [KEY] },
    );
    const target = (e.payload.tool_targets as string[])[0];
    expect(target).not.toContain(KEY);
    expect(target).toContain(OBS_SECRET_MASK);
    expect(target.length).toBeLessThanOrEqual(128);
  });

  it("非 tool_use 的 kind 不产这个键(text 通道口径不混)", () => {
    const e = build({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a.ts\nb.ts" }] },
    });
    expect(e.kind).toBe("tool_result");
    expect(e.payload).not.toHaveProperty("tool_targets");
  });
});

describe("ingress 打码与截断(自由文本 / 标量字段一视同仁)", () => {
  it("已知凭据值精确打码:自由文本、工具结果、白名单字符串字段一视同仁", () => {
    const secrets = [KEY];
    const free = build(
      { type: "assistant", content: [{ type: "text", text: `用 ${KEY} 调模型` }] },
      { secrets },
    );
    expect(free.payload.text).toContain(OBS_SECRET_MASK);
    expect(JSON.stringify(free.payload)).not.toContain(KEY);

    const toolResult = build(
      {
        type: "user",
        message: { content: [{ type: "tool_result", content: `env dump: OPENAI_API_KEY=${KEY}` }] },
      },
      { secrets },
    );
    expect(JSON.stringify(toolResult.payload)).not.toContain(KEY);
    expect(toolResult.payload.text).toContain("env dump");

    const inScalar = build({ type: "system", model: `prefix-${KEY}-suffix` }, { secrets });
    expect(inScalar.payload.model).toBe(`prefix-${OBS_SECRET_MASK}-suffix`);
  });

  it("自由文本截断到 2048 字符(截断发生在打码之后,不给凭据留半个身子)", () => {
    const long = `${KEY}${"A".repeat(5000)}`;
    const e = build(
      { type: "assistant", content: [{ type: "text", text: long }] },
      { secrets: [KEY] },
    );
    const text = e.payload.text as string;
    expect(text.length).toBeLessThanOrEqual(OBS_TEXT_MAX_CHARS);
    expect(text).not.toContain(KEY);
    expect(text.startsWith(OBS_SECRET_MASK)).toBe(true);
  });

  it("空文本不留噪声键", () => {
    const e = build({ type: "assistant", content: [{ type: "text", text: "   \n " }] });
    expect(e.payload.text).toBeUndefined();
  });

  it("maskSecrets 忽略过短与空值:一把 3 字符的 key 会把正文打成筛子", () => {
    expect(maskSecrets("abc and abracadabra", ["abc"])).toBe("abc and abracadabra");
    expect(maskSecrets(`x${KEY}y`, [KEY, ""])).toBe(`x${OBS_SECRET_MASK}y`);
  });

  it("obsSecretValues 从注入点取已知凭据,去重且不含未配置项", () => {
    const env = {
      SANDBOX_MODEL_API_KEY: KEY,
      DASHSCOPE_API_KEY: "sk-otherotherother0000000000",
      WORKER_API_TOKEN: "worker-token-value-1234567890",
    } as unknown as Env;
    expect(obsSecretValues(env)).toHaveLength(3);
    expect(obsSecretValues({} as Env)).toEqual([]);
    expect(obsSecretValues({ DASHSCOPE_API_KEY: KEY, SANDBOX_MODEL_API_KEY: KEY } as unknown as Env)).toEqual([
      KEY,
    ]);
    expect(obsSecretValues({ DASHSCOPE_API_KEY: "tiny" } as unknown as Env)).toEqual([]);
  });
});

/**
 * 心跳 payload 的类型门(§9.5)。它是外流面上唯一**由 runner 无条件书写**的通道:
 * 每轮一条、无人审阅、内容取自沙箱内部,还兼任 §9.8 分级唯一的时间源。所以它比
 * transcript 通道更窄 —— 没有 text 键、没有自由文本,只认枚举与有限数值。
 *
 * 这里要的是**负向**证据:上面那组「心跳只留枚举与数值」的用例都在证明「该留的留下了」,
 * 而把 `HEARTBEAT_STATUS_VALUES.includes(status)` 这道守卫删掉(改成一个不校验枚举的
 * `if (status !== null)`)在上述用例里全绿 —— 于是这条通道悄悄变成文本通道。
 */
describe("心跳 payload 的类型门:status 只认枚举、其余只认有限数值", () => {
  function beat(snapshot: Partial<ProcessSnapshot>, over: { round_ms?: number; gap_ms?: number | null } = {}) {
    return toHeartbeatEvent({
      taskId: TASK,
      attemptId: ATTEMPT,
      generation: 1,
      seq: 1,
      ts: TS,
      snapshot: { status: "running", exitCode: null, startedAtMs: null, ...snapshot } as ProcessSnapshot,
      round_ms: over.round_ms ?? 33_000,
      gap_ms: "gap_ms" in over ? over.gap_ms! : 33_000,
    });
  }

  it("枚举外的 status 整键丢掉:文本不得借 status 之名进 journal", () => {
    const leaky = 'running | {"content":"整个文件正文"}';
    const e = beat({ status: leaky as LongRunStatus });
    expect(e.kind).toBe(OBS_HEARTBEAT_KIND);
    expect(e.payload).not.toHaveProperty("status");
    // 只断「没有 status 键」不够:守卫被删掉时键名会换,内容才是真正的判据。
    expect(JSON.stringify(e.payload)).not.toContain(leaky);
  });

  it("LONGRUN_STATUSES 每个取值都收:白名单是引用,不是抄本", () => {
    // events.ts 引用 longrun.ts 的清单。抄一份的失败形状是:上游加一个状态,抄的那份
    // 不再匹配 → 心跳的 status 键悄悄消失,而判据看起来还在工作(§9.5 同一理由)。
    for (const status of LONGRUN_STATUSES) {
      expect(beat({ status }).payload.status).toBe(status);
    }
  });

  it("非有限数值与 null 一律不写键:缺观测 ≠ 观测到 0", () => {
    const e = beat({ exitCode: Number.NaN as number, startedAtMs: "1725" as unknown as number }, { gap_ms: null });
    expect(e.payload).not.toHaveProperty("exit_code");
    expect(e.payload).not.toHaveProperty("started_at_ms");
    expect(e.payload).not.toHaveProperty("gap_ms");
    expect(e.payload.round_ms).toBe(33_000);
  });
});
