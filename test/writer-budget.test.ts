import { describe, expect, it } from "vitest";
import { deriveWriterBudget } from "../src/exec/sandbox";
import { MAX_SAFE_WALL_MINUTES } from "../src/control/budget";

/**
 * qwen 双预算推导:曾硬编码 5m/12turns,代码类任务(装依赖+跑测试)必然撞墙;
 * 修复后 r5 又暴露两缺陷 —— 2400s 预算推出 38m 墙钟超过 workerd ~29:48 挂起墙
 * (attempt 2 死于平台击杀),固定 40 turns 在 5.3 分钟就杀掉正常产出的 attempt 1。
 * 钉住「墙钟与任务预算同源 + 120s 余量 + 下限 1 分钟 + 平台上限钳制」与
 * 「turns 随墙钟缩放、显式配置优先」的回落语义。
 */
describe("deriveWriterBudget", () => {
  it("任务预算决定墙钟并留 120s 余量,但钳到平台安全上限 25 分钟", () => {
    expect(deriveWriterBudget(2400, {}).wallMinutes).toBe(MAX_SAFE_WALL_MINUTES);
    expect(deriveWriterBudget(3600, {}).wallMinutes).toBe(MAX_SAFE_WALL_MINUTES);
    expect(MAX_SAFE_WALL_MINUTES).toBe(25);
  });

  it("预算小于上限时不受钳制影响,仍按 (预算-120s)/60 推导", () => {
    expect(deriveWriterBudget(900, {}).wallMinutes).toBe(13);
    expect(deriveWriterBudget(1620, {}).wallMinutes).toBe(25);
  });

  it("未传预算时回落环境默认,环境也缺配时回落 3600(再钳到 25)", () => {
    expect(deriveWriterBudget(undefined, { DEFAULT_MAX_WALL_SECONDS: "900" }).wallMinutes).toBe(13);
    expect(deriveWriterBudget(undefined, {}).wallMinutes).toBe(MAX_SAFE_WALL_MINUTES);
  });

  it("极小预算不产生 0/负分钟,墙钟下限 1 分钟", () => {
    expect(deriveWriterBudget(60, {}).wallMinutes).toBe(1);
    // 0 不再是「合法的极小预算」:非法值在入口就被拒(400 invalid_budget),内部投影
    // 按缺省回落。旧行为是 max(1, floor((0-120)/60)) 把它**掩盖**成 1 分钟预算,
    // 于是「0」和「60」在沙箱侧长成同一个数 —— 那正是 c14b 要治的分叉。
    expect(deriveWriterBudget(0, {}).wallMinutes).toBe(MAX_SAFE_WALL_MINUTES);
    expect(deriveWriterBudget(-60, {}).wallMinutes).toBe(MAX_SAFE_WALL_MINUTES);
  });

  it("MAX_WRITER_WALL_MINUTES 可覆盖上限,非法值回落 25", () => {
    expect(deriveWriterBudget(2400, { MAX_WRITER_WALL_MINUTES: "10" }).wallMinutes).toBe(10);
    expect(deriveWriterBudget(2400, { MAX_WRITER_WALL_MINUTES: "0" }).wallMinutes).toBe(25);
    expect(deriveWriterBudget(2400, { MAX_WRITER_WALL_MINUTES: "abc" }).wallMinutes).toBe(25);
  });

  it("turns 缺省时随墙钟缩放(≈8/min,下限 40),不再固定 40", () => {
    // r5 attempt 1 的教训:2400s 预算下 40 turns 只够 5.3 分钟健康产出
    expect(deriveWriterBudget(2400, {}).maxSessionTurns).toBe(200);
    expect(deriveWriterBudget(900, {}).maxSessionTurns).toBe(104);
    expect(deriveWriterBudget(60, {}).maxSessionTurns).toBe(40);
  });

  it("turns 显式配置优先,非法值回落推导", () => {
    expect(deriveWriterBudget(600, { DEFAULT_MAX_SESSION_TURNS: "25" }).maxSessionTurns).toBe(25);
    expect(deriveWriterBudget(600, { DEFAULT_MAX_SESSION_TURNS: "0" }).maxSessionTurns).toBe(64);
    expect(deriveWriterBudget(600, { DEFAULT_MAX_SESSION_TURNS: "-3" }).maxSessionTurns).toBe(64);
    expect(deriveWriterBudget(600, { DEFAULT_MAX_SESSION_TURNS: "abc" }).maxSessionTurns).toBe(64);
  });
});
