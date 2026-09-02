import { describe, expect, it } from "vitest";
import {
  costWeightedFromUsage,
  extractTokensFromTranscript,
  extractUsageFromTranscript,
} from "../src/exec/extract";

/**
 * attempt token 台账的提取与成本口径。
 *
 * 背景(r11 writer 实测):usage.total_tokens = 6,949,711,其中 cache_read_input_tokens
 * = 6,733,762 —— 96.9% 是最便宜的隐式 prompt 缓存命中,真正贵的 fresh input + output
 * 只有约 216K。把 total 当成本口径会把差一个数量级的两件事记成同一个数,所以台账
 * 同时记四元组拆分与成本加权值,raw total 原样保留(历史语义不变)。
 */

const R11_USAGE = {
  input_tokens: 6_886_340,
  cache_read_input_tokens: 6_733_762,
  output_tokens: 63_371,
  total_tokens: 6_949_711,
};

/** fresh input + output:total 里真正贵的部分 */
const R11_EXPENSIVE = R11_USAGE.input_tokens - R11_USAGE.cache_read_input_tokens + R11_USAGE.output_tokens;

function ndjson(...events: unknown[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n");
}

describe("extractUsageFromTranscript", () => {
  it("r11 实测向量:四元组原样提出,字段名与 qwen stream-json 对齐", () => {
    const t = ndjson({ type: "result", subtype: "success", usage: R11_USAGE });
    expect(extractUsageFromTranscript(t)).toEqual(R11_USAGE);
  });

  it("多事件取有效 total 最大的一条(累计 result),而不是最后一条", () => {
    const t = ndjson(
      { type: "system", subtype: "init" },
      { type: "assistant", message: { usage: { input_tokens: 900, output_tokens: 40, total_tokens: 940 } } },
      // 累计值在中间、后面还有更小的单次调用:靠 "最大" 而非 "最后" 才能挑对
      { type: "result", usage: { input_tokens: 50_000, output_tokens: 900, total_tokens: 50_900 } },
      { type: "assistant", message: { usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
    );
    expect(extractUsageFromTranscript(t)).toEqual({
      input_tokens: 50_000,
      output_tokens: 900,
      total_tokens: 50_900,
    });
  });

  it("顶层 evt.usage 与 evt.message.usage 两种形状都认", () => {
    const top = ndjson({ type: "result", usage: { total_tokens: 7 } });
    const nested = ndjson({ type: "assistant", message: { usage: { total_tokens: 7 } } });
    expect(extractUsageFromTranscript(top)).toEqual({ total_tokens: 7 });
    expect(extractUsageFromTranscript(nested)).toEqual({ total_tokens: 7 });
  });

  it("字段缺失:只留上游给了的那几个键,缺的是 undefined 而非 0", () => {
    const noTotal = extractUsageFromTranscript(
      ndjson({ type: "result", usage: { input_tokens: 100, cache_read_input_tokens: 90, output_tokens: 5 } }),
    );
    expect(noTotal).toEqual({ input_tokens: 100, cache_read_input_tokens: 90, output_tokens: 5 });
    expect(noTotal!.total_tokens).toBeUndefined();

    const onlyTotal = extractUsageFromTranscript(ndjson({ type: "result", usage: { total_tokens: 42 } }));
    expect(onlyTotal).toEqual({ total_tokens: 42 });
    expect(onlyTotal!.input_tokens).toBeUndefined();
    expect(onlyTotal!.cache_read_input_tokens).toBeUndefined();
    expect(onlyTotal!.output_tokens).toBeUndefined();
  });

  it("没有任何 usage 事件 → null;非 JSON 行与 usage 空壳同样不记", () => {
    expect(extractUsageFromTranscript("")).toBeNull();
    expect(extractUsageFromTranscript(ndjson({ type: "system", subtype: "init" }))).toBeNull();
    expect(extractUsageFromTranscript("not json at all\n\x1b[31mred\x1b[0m\n")).toBeNull();
    // usage 壳子里一个数值字段都没有:等于「上游没说」,不能当成 0 记进台账
    expect(extractUsageFromTranscript(ndjson({ type: "result", usage: {} }))).toBeNull();
    expect(extractUsageFromTranscript(ndjson({ type: "result", usage: { total_tokens: "123" } }))).toBeNull();
    expect(extractUsageFromTranscript(ndjson("a string line"))).toBeNull();
  });
});

describe("extractTokensFromTranscript", () => {
  it("语义不变:= 选中事件的 raw total(r11 即 6,949,711,含 96.9% 缓存命中)", () => {
    expect(extractTokensFromTranscript(ndjson({ type: "result", usage: R11_USAGE }))).toBe(6_949_711);
  });

  it("语义不变:无 total_tokens 时由 input+output 推出有效总量", () => {
    expect(
      extractTokensFromTranscript(
        ndjson({ type: "result", usage: { input_tokens: 100, cache_read_input_tokens: 90, output_tokens: 5 } }),
      ),
    ).toBe(105);
  });

  it("语义不变:多事件取最大值,无 usage / 解析失败一律 0", () => {
    const t = ndjson(
      { type: "assistant", message: { usage: { total_tokens: 940 } } },
      { type: "result", usage: { total_tokens: 50_900 } },
    );
    expect(extractTokensFromTranscript(t)).toBe(50_900);
    expect(extractTokensFromTranscript("")).toBe(0);
    expect(extractTokensFromTranscript("garbage\n\x1b[0m")).toBe(0);
    expect(extractTokensFromTranscript(ndjson({ type: "system" }))).toBe(0);
  });

  it("与四元组同源:tokens_used 恒等于选中 usage 的 raw total", () => {
    const t = ndjson({ type: "result", usage: R11_USAGE });
    const usage = extractUsageFromTranscript(t)!;
    expect(extractTokensFromTranscript(t)).toBe(usage.total_tokens ?? 0);
    expect(usage.total_tokens).toBe(R11_USAGE.total_tokens);
    // raw total 里九成以上是缓存命中:这正是它不能当成本口径的原因
    expect(R11_USAGE.cache_read_input_tokens / usage.total_tokens!).toBeGreaterThan(0.96);
  });
});

describe("costWeightedFromUsage", () => {
  it("r11 向量:factor 0.2 → 1,562,701(fresh + output + 折扣后的缓存读)", () => {
    expect(costWeightedFromUsage(R11_USAGE, 0.2)).toBe(1_562_701);
  });

  it("factor 1(缓存与 fresh 同价)退化为 raw total —— 自检", () => {
    expect(costWeightedFromUsage(R11_USAGE, 1)).toBe(R11_USAGE.total_tokens);
  });

  it("factor 0(缓存免费)= 只有真正贵的 token", () => {
    expect(costWeightedFromUsage(R11_USAGE, 0)).toBe(R11_EXPENSIVE);
    expect(R11_EXPENSIVE).toBe(215_949);
  });

  it("只有 total(无从拆分)时退回 total,不猜折扣", () => {
    expect(costWeightedFromUsage({ total_tokens: 6_949_711 }, 0.2)).toBe(6_949_711);
    expect(costWeightedFromUsage({ total_tokens: 100, output_tokens: 7 }, 0.2)).toBe(100);
  });

  it("有 input 无 cache_read:缓存收益未知,保守按全 fresh 计", () => {
    const u = { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 };
    expect(costWeightedFromUsage(u, 0.2)).toBe(1200);
    expect(costWeightedFromUsage({ input_tokens: 1000 }, 0.5)).toBe(1000);
    expect(costWeightedFromUsage({ input_tokens: 1000, total_tokens: 1500 }, 0)).toBe(1000);
  });

  it("只有 cache_read 无 input(上游形状异常):无从拆分,退回 total", () => {
    expect(costWeightedFromUsage({ cache_read_input_tokens: 900, total_tokens: 1000 }, 0.2)).toBe(1000);
    expect(costWeightedFromUsage({ cache_read_input_tokens: 900, output_tokens: 30 }, 0.2)).toBe(30);
  });

  it("全 fresh 的用量:加权值与 raw total 同值 —— 失真只发生在有缓存命中时", () => {
    const noCache = { input_tokens: 5000, cache_read_input_tokens: 0, output_tokens: 300, total_tokens: 5300 };
    expect(costWeightedFromUsage(noCache, 0.2)).toBe(5300);
  });

  it("折扣部分取整,不产生小数 token", () => {
    const u = { input_tokens: 1001, cache_read_input_tokens: 1000, output_tokens: 0, total_tokens: 1001 };
    expect(costWeightedFromUsage(u, 0.2)).toBe(1 + Math.round(1000 * 0.2));
    expect(Number.isInteger(costWeightedFromUsage(u, 1 / 3))).toBe(true);
  });
});
