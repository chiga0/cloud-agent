import { describe, expect, it } from "vitest";
import { deriveWriterBudget } from "../src/exec/sandbox";

/**
 * qwen 双预算推导:曾硬编码 5m/12turns,代码类任务(装依赖+跑测试)必然撞墙。
 * 钉住「墙钟与任务预算同源 + 120s 余量 + 下限 1 分钟」与 turns 的回落语义。
 */
describe("deriveWriterBudget", () => {
  it("任务预算决定墙钟,并留 120s 给导出/证据/回报", () => {
    expect(deriveWriterBudget(2400, {}).wallMinutes).toBe(38);
    expect(deriveWriterBudget(3600, {}).wallMinutes).toBe(58);
  });

  it("未传预算时回落环境默认,环境也缺配时回落 3600", () => {
    expect(deriveWriterBudget(undefined, { DEFAULT_MAX_WALL_SECONDS: "900" }).wallMinutes).toBe(13);
    expect(deriveWriterBudget(undefined, {}).wallMinutes).toBe(58);
  });

  it("极小预算不产生 0/负分钟,墙钟下限 1 分钟", () => {
    expect(deriveWriterBudget(60, {}).wallMinutes).toBe(1);
    expect(deriveWriterBudget(0, {}).wallMinutes).toBe(1);
  });

  it("turns 缺省与非法值回落 40,合法值照单全收", () => {
    expect(deriveWriterBudget(600, {}).maxSessionTurns).toBe(40);
    expect(deriveWriterBudget(600, { DEFAULT_MAX_SESSION_TURNS: "25" }).maxSessionTurns).toBe(25);
    expect(deriveWriterBudget(600, { DEFAULT_MAX_SESSION_TURNS: "0" }).maxSessionTurns).toBe(40);
    expect(deriveWriterBudget(600, { DEFAULT_MAX_SESSION_TURNS: "-3" }).maxSessionTurns).toBe(40);
    expect(deriveWriterBudget(600, { DEFAULT_MAX_SESSION_TURNS: "abc" }).maxSessionTurns).toBe(40);
  });
});
