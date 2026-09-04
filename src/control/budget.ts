/**
 * 预算口径的唯一权威:一个数字进来,四个时钟出去。
 *
 * **为什么要单独一层**:同一条「墙钟预算怎么算」的规则曾有三份独立副本(index.ts
 * 的入口缺省、sandbox.ts 的 deriveWriterBudget、qwenDeadlineSeconds 里的
 * `?? Number(... ?? "3600")`)。三份副本的表现是「改缺省值必漏一处」,而更糟的是
 * 它们对「用户请求的时长」和「writer 实际拿到的时长」各执一词 —— 任务记录说 3600s,
 * writer 实际只有 25 分钟,链上没有任何一条事件承认过这件事。用户看到的是一个数,
 * 系统按另一个数干活,中间那段无人负责的差额就是不诚实。
 *
 * **两条边界纪律(本仓一贯)**:
 * - 请求侧:给了非法值必须**拒绝**(入口 400),不静默修正 —— 静默修正产出的是
 *   「与请求不符且没人报告」的静默行为。见 validateMaxWallSeconds。
 * - 配置侧:环境变量缺配走**缺省 + 回落**(静默);给了非法值回落 + `console.warn`
 *   留可 grep 的痕(`budget_default_invalid`)。旧行为里非法的 DEFAULT_MAX_WALL_SECONDS
 *   会一路 NaN 到底(`--max-wall-time NaNm`),这里改成明确回落并留痕。
 *
 * **设计取向:夹钳只降 writer 能力,不改用户契约。** DO 的 alarm 仍按任务预算
 * (attemptDeadline = claim + max_wall_seconds + 宽限,见 statemachine.ts)兜底,
 * 于是「预算 3600s」这件事在任务记录、DO 兜底、事件链三处口径一致;writer 拿不到
 * 那么多是平台事实(见 MAX_SAFE_WALL_MINUTES),必须被记录,而不是靠把 alarm 也
 * 提前来制造「预算本来就这么多」的假象 —— 那等于悄悄把用户契约改小。
 */

/**
 * 导出余量:从任务预算里先扣掉的秒数,给 patch 导出 / 证据组装 / 回报留时间,
 * 让 qwen 先于外层预算干净退出(否则外层杀进程时产物与回报都拿不到)。
 */
export const EXPORT_ALLOWANCE_SECONDS = 120;

/** 墙钟分钟下限:0 分钟等于不起模型。 */
export const MIN_WALL_MINUTES = 1;

/**
 * qwen 墙钟的平台安全上限(分钟)。可被 env.MAX_WRITER_WALL_MINUTES 覆盖(可选 + 回落)。
 *
 * workerd 挂起检测会在 ~29:48 杀掉单条正在 await 的请求(M9 prod 实测;C2-r6 曾按
 * 2400s 预算推出 38m 墙钟,撞的就是这堵墙 —— BLOCKED 零产出)。超过它拿到的是平台
 * 击杀(无产物、无回报、无退出码),而不是 qwen 自己的干净退出,所以宁可夹钳并留痕。
 */
export const MAX_SAFE_WALL_MINUTES = 25;

/** poll 到期兜底相对 writer 墙钟的余量(Fix C:只兜「qwen 自己都没能退出」的悬挂)。 */
export const QWEN_DEADLINE_GRACE_SECONDS = 180;

/** poll 到期兜底相对任务预算的安全边际:必须赶在 DO 的 attemptDeadline alarm 之前回报。 */
export const QWEN_DEADLINE_BUDGET_MARGIN_SECONDS = 60;

/** poll 到期线下限。 */
export const MIN_DEADLINE_SECONDS = 60;

/** turns 闸随墙钟缩放的系数(实测健康产出速率 ≈ 8 turns/min)。 */
const TURNS_PER_WALL_MINUTE = 8;

/** turns 闸下限:再小的预算也得让 qwen 有机会做完一次像样的改动。 */
const MIN_SESSION_TURNS = 40;

/** `DEFAULT_MAX_WALL_SECONDS` 也缺配/非法时的最后回落值(与 wrangler.jsonc 的缺省同值)。 */
export const FALLBACK_MAX_WALL_SECONDS = 3600;

/** 夹钳原因的唯一权威清单:事件 payload 里只出现这些枚举值,没有自由文本通道。 */
export const BUDGET_CLAMP_REASONS = [
  /** 墙钟撞上限(MAX_WRITER_WALL_MINUTES 或 MAX_SAFE_WALL_MINUTES)被削平 */
  "writer_wall_ceiling",
  /** 预算小到扣完导出余量不足 1 分钟,被下限抬到 1 分钟 */
  "minimum_wall",
] as const;
export type BudgetClampReason = (typeof BUDGET_CLAMP_REASONS)[number];

/** 夹钳事件的 kind 名。写在权威链里,`grep budget.clamped` 即可复盘「谁被削过」。 */
export const BUDGET_CLAMP_EVENT_KIND = "budget.clamped";

/** resolveBudget 需要的环境变量子集(Env 的这三个键)。 */
export interface BudgetEnv {
  DEFAULT_MAX_WALL_SECONDS?: string;
  DEFAULT_MAX_SESSION_TURNS?: string;
  MAX_WRITER_WALL_MINUTES?: string;
}

/** 一次解析的全部输出:四个时钟同源,任何调用点不再自己算 min/max。 */
export interface ResolvedBudget {
  /** 任务记录里的预算(秒)。入口已校验,故这里恒为正整数。 */
  budgetSeconds: number;
  /** writer 实际拿到的墙钟(分钟):已扣导出余量、钳到上限、抬到下限。 */
  wallMinutes: number;
  /** 本次生效的墙钟上限(分钟):显式覆盖值或 MAX_SAFE_WALL_MINUTES。 */
  ceilingMinutes: number;
  /** qwen 的 session turns 上限。 */
  maxSessionTurns: number;
  /** 轮询到期兜底(秒),见 deadlineSeconds 的推导注释。 */
  deadlineSeconds: number;
  /** 夹钳原因;null = writer 拿到的就是预算允许的完整时长。 */
  clamp: BudgetClampReason | null;
}

/**
 * 正整数秒:非数值 / 非有限 / 小数 / 非正 一律 undefined。
 * 返回 undefined 而不是 0,是为了让调用方决定「拒绝」还是「回落」——
 * 请求侧拒绝(400),配置与内部侧回落,两侧语义不同,不能共用一个 0。
 */
function asPositiveSeconds(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

/**
 * 入口校验器:`budget.max_wall_seconds` 的合法形状 = JSON 正整数(秒)。
 * null / undefined = 未给,合法(走缺省)。返回 null 表示通过,否则返回拒绝原因。
 */
export function validateMaxWallSeconds(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number") {
    return "budget.max_wall_seconds must be a JSON number of seconds, not " + typeof value;
  }
  if (!Number.isFinite(value)) {
    return "budget.max_wall_seconds must be finite (got " + String(value) + ")";
  }
  if (!Number.isInteger(value)) {
    return "budget.max_wall_seconds must be a whole number of seconds (got " + String(value) + ")";
  }
  if (value <= 0) {
    return "budget.max_wall_seconds must be greater than 0 (got " + String(value) + ")";
  }
  return null;
}

/** 配置侧的缺省预算:缺配静默回落,给了但非法则回落 + 留痕(不静默修正)。 */
function defaultBudgetSeconds(env: BudgetEnv): number {
  const raw = env.DEFAULT_MAX_WALL_SECONDS;
  if (raw === undefined || raw === "") return FALLBACK_MAX_WALL_SECONDS;
  const parsed = asPositiveSeconds(raw);
  if (parsed !== undefined) return parsed;
  console.warn(
    `budget_default_invalid DEFAULT_MAX_WALL_SECONDS=${JSON.stringify(raw)} ` +
      `fallback=${FALLBACK_MAX_WALL_SECONDS}`,
  );
  return FALLBACK_MAX_WALL_SECONDS;
}

/** 可选 + 回落的正整数配置项(非法值不报错,回落由调用方给定的默认)。 */
function positiveIntFromEnv(raw: string | undefined, fallback: number): number {
  const parsed = raw === undefined || raw === "" ? NaN : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.floor(parsed));
}

/**
 * 一次解析:请求预算 → writer 墙钟 / turns 闸 / poll 到期线 / 是否夹钳。
 *
 * 三个时钟的相对关系是契约,不是巧合,必须保持(顺序:qwen 墙钟 < poll 到期 < DO alarm):
 * 1. `wallMinutes` = 预算扣掉 EXPORT_ALLOWANCE_SECONDS 再钳到 ceiling —— writer 能力;
 * 2. `deadlineSeconds` = `min(墙钟 + 180s, 预算 - 60s)` 再取下限 —— 「赶在 DO 的
 *    attemptDeadline alarm(claim + 预算 + 宽限)之前给出带证据的回报」正是它存在的全部意义;
 * 3. DO alarm 由 statemachine.attemptDeadline 按**任务预算**排,本函数不碰它 ——
 *    夹钳不缩小用户契约(见文件头的设计取向)。
 */
export function resolveBudget(
  maxWallSeconds: number | undefined,
  env: BudgetEnv,
): ResolvedBudget {
  // 内部路径(queue/rework)传进来的值可能已是 NaN(历史遗留),这里按回落处理:
  // 绝不让 NaN 流进命令行 —— 旧行为是 `--max-wall-time NaNm` 静默烂掉。
  const budgetSeconds = asPositiveSeconds(maxWallSeconds) ?? defaultBudgetSeconds(env);
  const ceilingMinutes = positiveIntFromEnv(
    env.MAX_WRITER_WALL_MINUTES,
    MAX_SAFE_WALL_MINUTES,
  );
  const budgetedMinutes = Math.floor((budgetSeconds - EXPORT_ALLOWANCE_SECONDS) / 60);
  const floored = Math.max(MIN_WALL_MINUTES, budgetedMinutes);

  let wallMinutes = floored;
  let clamp: BudgetClampReason | null = null;
  if (floored > ceilingMinutes) {
    wallMinutes = ceilingMinutes;
    clamp = "writer_wall_ceiling";
  } else if (budgetedMinutes < MIN_WALL_MINUTES) {
    clamp = "minimum_wall";
  }

  const turnsRaw = env.DEFAULT_MAX_SESSION_TURNS;
  const turnsParsed =
    turnsRaw === undefined || turnsRaw === "" ? NaN : Number(turnsRaw);
  const maxSessionTurns =
    Number.isFinite(turnsParsed) && turnsParsed > 0
      ? Math.floor(turnsParsed)
      : Math.max(MIN_SESSION_TURNS, wallMinutes * TURNS_PER_WALL_MINUTE);

  const deadlineSeconds = Math.max(
    MIN_DEADLINE_SECONDS,
    Math.min(
      wallMinutes * 60 + QWEN_DEADLINE_GRACE_SECONDS,
      budgetSeconds - QWEN_DEADLINE_BUDGET_MARGIN_SECONDS,
    ),
  );

  return { budgetSeconds, wallMinutes, ceilingMinutes, maxSessionTurns, deadlineSeconds, clamp };
}

/**
 * `budget.clamped` 的 payload:只含数值与枚举(与 c10b 心跳同一卫生纪律 ——
 * 这条链每 attempt 都可能写,不该开一个自由文本外流面)。
 * 未夹钳返回 null,即「没有事件」而不是「一条说没事的事件」。
 */
export function budgetClampPayload(
  attemptId: string,
  b: ResolvedBudget,
): Record<string, string | number> | null {
  if (b.clamp === null) return null;
  return {
    attempt_id: attemptId,
    requested_seconds: b.budgetSeconds,
    writer_wall_minutes: b.wallMinutes,
    ceiling_minutes: b.ceilingMinutes,
    clamp_reason: b.clamp,
  };
}
