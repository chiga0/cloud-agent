import { describe, expect, it } from "vitest";
import {
  accumulateUsageFromTranscript,
  costWeightedFromUsage,
  totalFromUsage,
  TranscriptLedgerMismatchError,
  type TranscriptUsage,
} from "../src/exec/extract";

/**
 * attempt token 台账的提取与成本口径。
 *
 * 两条独立的失真各修一层:
 * ① 「量」的口径(r2 实测):提取必须是**逐事件累加**。旧实现是「有 result 用 result、
 *    没 result 取最大的一条 assistant」—— 被墙钟击杀的任务没有 result,于是记成单次
 *    调用的量级:任务 `76464e22` 归档 input 221,006 / 加权 45,818,真实会话总量是
 *    input 10,686,994 / 加权 2,495,488 —— input 漏 48.4×、加权漏 54.5×,且漏记只发生在
 *    失败任务上(最需要成本可见性的那批)。
 * ② 「钱」的口径(r11 实测):raw total 里 96.9% 是最便宜的隐式缓存命中,所以台账同时
 *    记四元组拆分与成本加权值(fresh + output + 0.2×cache),raw total 原样保留。
 *
 * 完成态另有对账:累加值与 result 的会话累计值是**同一个量的两种记法**,不等即大声失败
 * (意味着 transcript 里有重复/缺失的 usage 事件 —— 正是要对账的原因),绝不静默取其一。
 */

function ndjson(...events: unknown[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n");
}

/** 一次 API 调用的 usage(单次值:total = input + output,input 含 cache_read)。 */
function call(input: number, cacheRead: number, output: number): Record<string, unknown> {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      usage: {
        input_tokens: input,
        cache_read_input_tokens: cacheRead,
        output_tokens: output,
        total_tokens: input + output,
      },
    },
  };
}

const R11_USAGE: TranscriptUsage = {
  input_tokens: 6_886_340,
  cache_read_input_tokens: 6_733_762,
  output_tokens: 63_371,
  total_tokens: 6_949_711,
};

/**
 * r2 prod 实测(任务 76464e22,被墙钟击杀、无 result 事件):
 * 会话真实总量 input 10,686,994 / cache_read 10,245,632 / output 5,000,加权 2,495,488。
 * 末次调用就是当时被归档的那四条(221,006 / 219,186 / 161 / 加权 45,818)。
 * 逐次拆分为合成值(取证只给到总量与末次调用),但**会话合计与取证逐字段相等**。
 */
const R2_LAST = call(221_006, 219_186, 161);
const R2_CALLS = [call(5_232_994, 5_013_223, 2_419), call(5_232_994, 5_013_223, 2_420), R2_LAST];
const R2_SESSION: TranscriptUsage = {
  input_tokens: 10_686_994,
  cache_read_input_tokens: 10_245_632,
  output_tokens: 5_000,
  total_tokens: 10_691_994,
};
/** factor=0.2:(10,686,994−10,245,632) + 5,000 + round(10,245,632×0.2) */
const R2_COST_WEIGHTED = 2_495_488;
/** 旧实现归档的那次「最后一次调用」:漏记倍数的分子/分母 */
const R2_ARCHIVED = { input_tokens: 221_006, cache_read_input_tokens: 219_186, output_tokens: 161, total_tokens: 221_167 };

/**
 * C8 prod 实测(writer 完成态,有 result 事件):result 的会话累计值
 * input 14,954,778 / cache 14,737,154 / output 75,677,加权 3,240,732
 * (与 fresh+output+0.2×cache 精确吻合 —— 完成态本来就不漏,对账钉住的是「同源」这件事)。
 */
const C8_CALLS = [call(4_985_271, 4_901_330, 20_114), call(4_985_271, 4_901_330, 20_114), call(4_984_236, 4_934_494, 35_449)];
const C8_RESULT: TranscriptUsage = {
  input_tokens: 14_954_778,
  cache_read_input_tokens: 14_737_154,
  output_tokens: 75_677,
  total_tokens: 15_030_455,
};
const C8_COST_WEIGHTED = 3_240_732;

describe("accumulateUsageFromTranscript —— 被杀态(r2:没有 result 也记全)", () => {
  it("N 次调用 + 无 result:提取结果 = 全部调用之和(逐字段)", () => {
    const ledger = accumulateUsageFromTranscript(ndjson(...R2_CALLS));
    expect(ledger.usage).toEqual(R2_SESSION);
    expect(ledger.calls).toBe(3);
    // raw total 与四元组同源:恒等于 totalFromUsage(usage)
    expect(ledger.total).toBe(totalFromUsage(R2_SESSION));
    expect(ledger.total).toBe(10_691_994);
  });

  it("成本口径维持 fresh+output+0.2×cache:r2 = 2,495,488(漏记时是 45,818)", () => {
    const ledger = accumulateUsageFromTranscript(ndjson(...R2_CALLS));
    expect(costWeightedFromUsage(ledger.usage!, 0.2)).toBe(R2_COST_WEIGHTED);
  });

  it("既不回落到最后一次调用,也不回落到最大一次调用", () => {
    const ledger = accumulateUsageFromTranscript(ndjson(...R2_CALLS));
    const input = ledger.usage!.input_tokens!;
    expect(input).not.toBe(R2_ARCHIVED.input_tokens);
    expect(input).not.toBe(Math.max(...R2_CALLS.map((e) => (e.message as { usage: { input_tokens: number } }).usage.input_tokens)));
    // 漏记倍数钉在取证量级:会话累计 / 末次调用 ≈ 48.4×
    expect(input / R2_ARCHIVED.input_tokens).toBeCloseTo(48.4, 0);
    const cost = costWeightedFromUsage(ledger.usage!, 0.2);
    expect(cost / 45_818).toBeGreaterThan(54);
  });

  it("被杀态没有 result:不抛错 —— 累加值就是此刻唯一可主张的口径", () => {
    expect(() => accumulateUsageFromTranscript(ndjson(...R2_CALLS))).not.toThrow();
  });

  it("调用顺序不影响累加(不依赖「最后一条」的位置)", () => {
    const forward = accumulateUsageFromTranscript(ndjson(...R2_CALLS)).usage;
    const reversed = accumulateUsageFromTranscript(ndjson(...[...R2_CALLS].reverse())).usage;
    expect(reversed).toEqual(forward);
  });

  // 操作员补用例(审查 M1 变异存活暴露的缺口):被杀态没有对账兜底,部分和若混进
  // 累加结果就会以「总量」的形状直接进台账。值级断言钉住:部分上报的字段整体留空,
  // 绝不让 2/3 调用的部分和顶替总量。
  it("被杀态 + 部分字段:部分和整体留空(值级断言),成本按全 fresh 保守计", () => {
    const t = ndjson(
      call(4_985_271, 4_901_330, 20_114),
      { type: "assistant", message: { usage: { input_tokens: 4_985_271, output_tokens: 20_114, total_tokens: 5_005_385 } } },
      call(4_984_236, 4_934_494, 35_449),
    );
    const ledger = accumulateUsageFromTranscript(t);
    expect(ledger.calls).toBe(3);
    expect(ledger.usage).toEqual({
      input_tokens: 14_954_778,
      output_tokens: 75_677,
      total_tokens: 15_030_455,
    });
    expect(ledger.usage!.cache_read_input_tokens).toBeUndefined();
    expect(ledger.underreportedFields).toEqual(["cache_read_input_tokens"]);
    expect(costWeightedFromUsage(ledger.usage!, 0.2)).toBe(15_030_455);
  });
});

describe("accumulateUsageFromTranscript —— 完成态对账(r2 的同源测试)", () => {
  it("C8 实测向量:累加值 == result 累计值,两个口径同时命中", () => {
    const ledger = accumulateUsageFromTranscript(
      ndjson({ type: "system", subtype: "init" }, ...C8_CALLS, { type: "result", subtype: "success", usage: C8_RESULT }),
    );
    expect(ledger.usage).toEqual(C8_RESULT);
    expect(ledger.total).toBe(15_030_455);
    expect(costWeightedFromUsage(ledger.usage!, 0.2)).toBe(C8_COST_WEIGHTED);
  });

  it("重复的 usage 事件 → 大声失败,两个候选值与差异来源都写清楚", () => {
    const dup = ndjson(...C8_CALLS, C8_CALLS[0], { type: "result", usage: C8_RESULT });
    let err: unknown;
    try {
      accumulateUsageFromTranscript(dup);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TranscriptLedgerMismatchError);
    const msg = String(err);
    expect(msg).toContain("token_ledger_unreconciled");
    expect(msg).toContain("calls=4");
    // 两个候选值都在(不静默取其一),并点名重复的用量事件
    expect(msg).toContain("累加=19940049");
    expect(msg).toContain("result=14954778");
    expect(msg).toContain("差异来源");
  });

  it("usage 事件缺失(有一条调用没落 usage)→ 失败并点出缺失条数", () => {
    const t = ndjson(
      C8_CALLS[0],
      C8_CALLS[1],
      { type: "assistant", message: { role: "assistant", content: [] } },
      { type: "result", usage: C8_RESULT },
    );
    // 丢一条调用的用量 → 累加必然低于累计值:这条曾经只能靠人事后翻 transcript 才发现
    expect(() => accumulateUsageFromTranscript(t)).toThrow(TranscriptLedgerMismatchError);
    try {
      accumulateUsageFromTranscript(t);
    } catch (err) {
      expect(String(err)).toContain("1 条 assistant 事件不带 usage");
      expect(String(err)).toContain("input_tokens:累加=9970542 result=14954778");
    }
  });

  it("transcript 只有 result 带 usage → 失败:不许拿 result 冒充累加值", () => {
    expect(() =>
      accumulateUsageFromTranscript(ndjson({ type: "assistant", message: { content: [] } }, { type: "result", usage: R11_USAGE })),
    ).toThrow(/累加侧没有任何带 usage 的 assistant 事件/);
  });

  it("字段覆盖不齐(result 报了 cache_read,某次调用漏报)→ 无法证明相等也算失败", () => {
    const t = ndjson(
      call(4_985_271, 4_901_330, 20_114),
      { type: "assistant", message: { usage: { input_tokens: 4_985_271, output_tokens: 20_114, total_tokens: 5_005_385 } } },
      call(4_984_236, 4_934_494, 35_449),
      { type: "result", usage: C8_RESULT },
    );
    let err = "";
    try {
      accumulateUsageFromTranscript(t);
    } catch (e) {
      err = String(e);
    }
    expect(err).toContain("cache_read_input_tokens");
    expect(err).toContain("在部分调用缺失");
  });

  it("多条带 usage 的 result(多轮会话拼进同一份 transcript)→ 差异来源点名", () => {
    const t = ndjson(...C8_CALLS, { type: "result", usage: C8_RESULT }, { type: "result", usage: R11_USAGE });
    // 末次 result 是基准:与累加不等 → 响,并说出「疑似多轮会话拼接」
    expect(() => accumulateUsageFromTranscript(t)).toThrow(/疑似多轮会话拼接/);
  });

  it("未知事件类型带 usage 不并入累加,对账时说明它的存在", () => {
    // 少一条调用 + 一条未知类型带 usage:不能拿未知类型凑数,所以累加侧仍对不上
    const t = ndjson(
      C8_CALLS[0],
      C8_CALLS[1],
      { type: "model", usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 } },
      { type: "result", usage: C8_RESULT },
    );
    let err = "";
    try {
      accumulateUsageFromTranscript(t);
    } catch (e) {
      err = String(e);
    }
    expect(err).toContain("条非 assistant/result 事件带 usage");
    // 105 没被加进累加侧:证明「不猜未知类型」不是说说而已
    expect(err).toContain("input_tokens:累加=9970542");
  });
});

describe("accumulateUsageFromTranscript —— 解析卫生与「未记录」", () => {
  it("顶层 evt.usage 与 evt.message.usage 两种形状都累加", () => {
    const t = ndjson(
      { type: "assistant", usage: { input_tokens: 100, cache_read_input_tokens: 90, output_tokens: 5, total_tokens: 105 } },
      { type: "assistant", message: { usage: { input_tokens: 200, cache_read_input_tokens: 180, output_tokens: 7, total_tokens: 207 } } },
    );
    expect(accumulateUsageFromTranscript(t).usage).toEqual({
      input_tokens: 300,
      cache_read_input_tokens: 270,
      output_tokens: 12,
      total_tokens: 312,
    });
  });

  it("单次调用缺 total_tokens:由 input+output 推出(上游恒等式,不是猜)", () => {
    const t = ndjson(
      { type: "assistant", message: { usage: { input_tokens: 1_000, cache_read_input_tokens: 900, output_tokens: 50 } } },
      { type: "assistant", message: { usage: { input_tokens: 2_000, cache_read_input_tokens: 1_900, output_tokens: 60 } } },
    );
    const ledger = accumulateUsageFromTranscript(t);
    expect(ledger.usage!.total_tokens).toBe(3_110);
    expect(ledger.total).toBe(3_110);
  });

  it("所有调用都没上报某字段 → 该字段整体留空(不是 0),成本按全 fresh 保守计", () => {
    const t = ndjson(
      { type: "assistant", message: { usage: { input_tokens: 1_000, output_tokens: 200, total_tokens: 1_200 } } },
      { type: "assistant", message: { usage: { input_tokens: 3_000, output_tokens: 100, total_tokens: 3_100 } } },
    );
    const ledger = accumulateUsageFromTranscript(t);
    expect(ledger.underreportedFields).toEqual([]);
    expect(ledger.usage).toEqual({ input_tokens: 4_000, output_tokens: 300, total_tokens: 4_300 });
    expect(ledger.usage!.cache_read_input_tokens).toBeUndefined();
    expect(costWeightedFromUsage(ledger.usage!, 0.2)).toBe(4_300);
  });

  it("一个 usage 都没有 → usage=null(「未记录」),total=0,不抛错", () => {
    for (const t of ["", ndjson({ type: "system", subtype: "init" }), "not json at all\n\x1b[31mred\x1b[0m\n", ndjson("a string line")]) {
      const ledger = accumulateUsageFromTranscript(t);
      expect(ledger.usage).toBeNull();
      expect(ledger.total).toBe(0);
      expect(ledger.calls).toBe(0);
    }
  });

  it("usage 空壳 / 非数值字段 / 空行:等于「上游没说」,不当 0 记", () => {
    const t = ndjson(
      { type: "assistant", message: { usage: {} } },
      { type: "assistant", message: { usage: { total_tokens: "123" } } },
      "",
      "   ",
      { type: "assistant", message: { usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
    );
    const ledger = accumulateUsageFromTranscript(t);
    expect(ledger.calls).toBe(1);
    expect(ledger.usage).toEqual({ input_tokens: 10, output_tokens: 2, total_tokens: 12 });
    // 空壳的 assistant 不贡献用量,但必须留痕:它是「累加可能低估」的证据
    expect(ledger.assistantWithoutUsage).toBe(2);
  });

  it("result 事件不参与累加(加了就是双计)", () => {
    const ledger = accumulateUsageFromTranscript(
      ndjson({ type: "result", usage: C8_RESULT }, ...C8_CALLS, { type: "result", usage: C8_RESULT }),
    );
    expect(ledger.usage).toEqual(C8_RESULT);
    expect(ledger.total).toBe(15_030_455);
  });
});

describe("totalFromUsage —— raw total 的唯一推导处", () => {
  it("有 total 用 total(r2 的单次口径 total 是 input+output,不是累计)", () => {
    expect(totalFromUsage(R2_ARCHIVED)).toBe(221_167);
    expect(totalFromUsage(R11_USAGE)).toBe(6_949_711);
  });

  it("缺 total 由 input+output 推出;都没有则 0", () => {
    expect(totalFromUsage({ input_tokens: 100, cache_read_input_tokens: 90, output_tokens: 5 })).toBe(105);
    expect(totalFromUsage({ output_tokens: 5 })).toBe(5);
    expect(totalFromUsage({})).toBe(0);
  });
});

describe("costWeightedFromUsage", () => {
  it("r11 向量:factor 0.2 → 1,562,701(fresh + output + 折扣后的缓存读)", () => {
    expect(costWeightedFromUsage(R11_USAGE, 0.2)).toBe(1_562_701);
  });

  it("factor=1 时缓存命中不再打折:加权值 = fresh + cache + output = total", () => {
    expect(costWeightedFromUsage(R11_USAGE, 1)).toBe(R11_USAGE.total_tokens);
  });

  it("factor=0 时缓存命中免费:加权值只剩真正贵的部分", () => {
    expect(costWeightedFromUsage(R11_USAGE, 0)).toBe(R11_USAGE.input_tokens! - R11_USAGE.cache_read_input_tokens! + R11_USAGE.output_tokens!);
  });

  it("只有 total:无从拆分,退回 total(与 raw total 同值)", () => {
    expect(costWeightedFromUsage({ total_tokens: 6_949_711 }, 0.2)).toBe(6_949_711);
    expect(costWeightedFromUsage({ total_tokens: 100, output_tokens: 7 }, 0.2)).toBe(100);
  });

  it("只有 input(cache_read 未知):保守按全 fresh 计,绝不猜「全是缓存命中」", () => {
    const u: TranscriptUsage = { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 };
    expect(costWeightedFromUsage(u, 0.2)).toBe(1200);
    expect(costWeightedFromUsage({ input_tokens: 1000 }, 0.5)).toBe(1000);
    expect(costWeightedFromUsage({ input_tokens: 1000, total_tokens: 1500 }, 0)).toBe(1000);
  });

  it("只有 cache_read(input 未知):退回 total", () => {
    expect(costWeightedFromUsage({ cache_read_input_tokens: 900, total_tokens: 1000 }, 0.2)).toBe(1000);
    expect(costWeightedFromUsage({ cache_read_input_tokens: 900, output_tokens: 30 }, 0.2)).toBe(30);
  });

  it("r11 复现:input+cache 齐备且缺 total 时按拆分计(缺 total 不阻断成本口径)", () => {
    const noCache: TranscriptUsage = { input_tokens: 5_000, cache_read_input_tokens: 0, output_tokens: 300 };
    expect(costWeightedFromUsage(noCache, 0.2)).toBe(5300);
  });

  it("加权值恒为整数(上游 total 是整数,台账不做浮点)", () => {
    const u: TranscriptUsage = { input_tokens: 1_001, cache_read_input_tokens: 1_000, output_tokens: 0 };
    expect(costWeightedFromUsage(u, 0.2)).toBe(1 + Math.round(1_000 * 0.2));
    expect(Number.isInteger(costWeightedFromUsage(u, 1 / 3))).toBe(true);
  });
});
