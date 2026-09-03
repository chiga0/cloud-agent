import { describe, expect, it } from "vitest";
import {
  OBS_EVENT_KINDS,
  OBS_SECRET_MASK,
  OBS_TEXT_MAX_CHARS,
  maskSecrets,
  obsKindOfLine,
  obsSecretValues,
  toAgentEventV1,
} from "../src/obs/events";
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

  it("command 只取首词 + 首个非 flag 实参:flag 与其余 token 一律不留", () => {
    const e = build({
      type: "assistant",
      content: [tool({ command: `npm test -- --reporter=verbose --token=${KEY}` }, "run_shell_command")],
    });
    expect(e.payload.tool_targets).toEqual(["npm test"]);
    expect(JSON.stringify(e.payload)).not.toContain(KEY);
    expect(JSON.stringify(e.payload)).not.toContain("verbose");

    // 只有首词(没有非 flag 实参)时不补空格,也不会退化成整行
    const bare = build({ type: "assistant", content: [tool({ command: "git status" }, "run_shell_command")] });
    expect(bare.payload.tool_targets).toEqual(["git status"]);
    const only = build({ type: "assistant", content: [tool({ command: "pwd" }, "run_shell_command")] });
    expect(only.payload.tool_targets).toEqual(["pwd"]);
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
