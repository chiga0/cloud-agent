/**
 * Supervisor 判据层 —— 三类「attempt 还挂着但已经不动了」的判据,**纯函数**。
 *
 * 定位(四层可观测终态的独立消费者):读第②层 Observation journal(src/obs/journal.ts
 * 的 readObsAttemptEvents 产出),产 finding。本文件不读 R2、不取 Date.now()、不写任何
 * 状态 —— 时钟、事件、阈值一律由参数注入。理由不是教条:
 * - 判据是启发式,可信度只能建立在「同一组输入永远得到同一组输出」上,才能把边界
 *   (恰好等于阈值算不算)钉进测试当契约;
 * - 一旦在这里读桶/取时钟,误报排查就得在真环境里等时间流过 —— C2-r6 那次 24 分钟
 *   悬挂之所以当时只能人工 tail,就是因为「判定」和「等待」缠在了一起。
 *
 * ⚠️ 两条判据可信度的根,改之前先读完整段(将来一定会被人当 bug 改掉,所以写在这):
 *
 * 1. **为什么 events 为空时不报 stall**:空数组有两种完全无法区分的成因 —— (a)这个
 *    attempt 刚启动,journal 还没写第一行(摄取是 30s 一轮的旁路 poll,启动后第一个
 *    周期内读到空是常态);(b)journal 坏了/被删/index 缺失(readObsAttemptEvents 对
 *    缺失返回空数组)。两种都不是「agent 卡住了」。而「最后一条事件距今无穷大」这种
 *    看似合理的写法,后果是**每一个刚起跑的 attempt 都会立刻吃一条 red stall**。
 *    判据的语义必须是「有证据表明已经停止」,而不是「没有证据表明还在动」—— 缺少证据
 *    不等于反面证据。所以空输入返回空数组,这条是误报防线,不是漏实现。
 *
 * 2. **为什么参数必须先归一化才能判重复**:loop/no_progress 的本质是「同一个动作出现
 *    了 N 次」。真实 transcript 里同一个动作的两行**永远不会字节相同**:时间戳每行都
 *    变、临时目录带随机后缀(`/tmp/qwen-3f9a…/out`、`.qwen/tmp/<hash>/…`)、uuid/commit
 *    sha 每次不同。不归一化的话 repeat_key 的唯一度 ≈ 事件条数,repeat_count 恒等于 1
 *    —— 这两条判据会**静默地永远不触发**(最坏的失效形态:看起来接了线,其实什么也不
 *    检查)。归一化即「把每次必变的字节折叠成占位符,只留下能区分动作的字节」。
 *    代价是判据分辨率下降:两个只在时间戳上不同的动作会被算作同一个。这是有意的取舍
 *    —— 宁可为「反复做同一件事」付出一处误报面,也不接受一条永不触发的判据。
 *
 * 分辨率的天花板由 Observation 层的白名单决定(src/obs/events.ts 刻意丢掉 tool_use 的
 * input 参数,因为 input 是自由文本 = 凭据外流面)。所以这里的 target 只能取 payload
 * 里**已经过 ingress 脱敏**的可见文本,取不到时退化为工具名本身。这不是可以先凑一下的
 * 细节:它决定了 no_progress 与 loop 的区分度,必须写明白而不是让人以为能看见工具入参。
 */

import type { AgentEventV1 } from "../obs/events";

/** Supervisor 的启用状态。`enforce` 本期刻意不存在(见规格「不要做」)。 */
export const SUPERVISOR_MODES = ["off", "shadow"] as const;
export type SupervisorMode = (typeof SUPERVISOR_MODES)[number];

/**
 * env → mode。写错的值(包括将来若有人加了 `enforce`)一律回落 off:一个可能有杀伤力
 * 的开关,失效方向必须是「不做事」。缺省 off 而不是缺省 shadow —— 启用点只能是
 * wrangler.jsonc 里那行显式的 vars,这样「什么时候开始有东西盯着」可审计。
 */
export function supervisorModeOf(value: string | undefined): SupervisorMode {
  return value === "shadow" ? "shadow" : "off";
}

/** env → alarm 的 tick 毫秒。未配/非正数/非法值回落缺省 60s(与 alarm 最小间隔同拍)。 */
export function supervisorTickMsOf(
  value: string | undefined,
  fallbackSeconds: number = SUPERVISOR_DEFAULT_TICK_SECONDS,
): number {
  const raw = Number(value);
  return Number.isFinite(raw) && raw > 0 ? raw * 1000 : fallbackSeconds * 1000;
}

/** finding 的三类判据。加一类要同时加进 SUPERVISOR_MODE 的文档表与测试。 */
export const SUPERVISOR_FINDING_KINDS = ["stall", "loop", "no_progress"] as const;
export type SupervisorFindingKind = (typeof SUPERVISOR_FINDING_KINDS)[number];

export type SupervisorSeverity = "yellow" | "red";

/**
 * 阈值。全部可注入(见 detectSupervisor 的 thresholds 参数),这里的常量是缺省值。
 *
 * stall 的两个数字**刻意与 src/obs/live.ts 的人眼阈值同口径**(90s 黄 / 300s 红):
 * Supervisor 要做的正是把「人盯着屏幕 5 分钟能看出来的事」变成机器每 60s 判一次的事。
 * 两套阈值一旦漂移,就会出现「Live UI 早就红了而 Supervisor 一声不响」—— 那是比误报
 * 更糟的失效(观测面互相矛盾时,人会不再相信任何一面)。测试里钉住相等关系。
 *
 * loop/no_progress 的窗口是**条数**而不是时间:判据问的是「这段时间里它在做什么」,
 * 事件密度本身就是要看的东西;用时间窗口会让高频空转(每秒一次工具调用)与低频空转
 * 用同一把尺子。重复上限取窗口的一半量级,低于它的重复在正常任务里是常态(改一个
 * 文件要 read→edit→read 两三次),所以取「明显超出常态」而不是「绝不可能是常态」。
 */
export const SUPERVISOR_THRESHOLDS = {
  /** 最后一条观测事件滞后超过它 → yellow。 */
  stall_yellow_ms: 90_000,
  /** 超过它 → red。与 Live UI 的 300s 同一判据。 */
  stall_red_ms: 300_000,
  /** loop 滑窗看末尾多少条事件。 */
  loop_window: 20,
  /** 窗内同一 repeat_key 出现多少次算循环。 */
  loop_repeat_max: 5,
  /** no_progress 滑窗看末尾多少条事件。 */
  no_progress_window: 30,
  /** 窗内同一 target 被碰多少次算空转。 */
  no_progress_repeat_max: 8,
} as const;

export type SupervisorThresholds = { -readonly [K in keyof typeof SUPERVISOR_THRESHOLDS]: number };

/** alarm 的 tick 缺省值与 finding 去重冷却期。 */
export const SUPERVISOR_DEFAULT_TICK_SECONDS = 60;
/**
 * 同一 (attempt_id, kind, rule, severity) 两次上报的最小间隔。
 * 38 分钟的悬挂按 60s tick 判 ~38 次,去重后权威链里只有 yellow 一条 + red 一条。
 * 权威链是事实底座,不是日志垃圾桶。
 */
export const SUPERVISOR_DEDUPE_COOLDOWN_MS = 600_000;

/** 进 finding evidence 的 target 长度上限(字符)。归一化后仍要限长,否则一条 2 KiB 的
 * payload.text 会整段进权威事件。 */
const TARGET_MAX_CHARS = 96;

export interface SupervisorEvidence {
  /** 判据看到的最后一条观测事件时间(ISO);无事件为 null */
  last_event_ts: string | null;
  /** now_ms - last_event_ts;时间戳不可解析为 null */
  gap_ms: number | null;
  /** 本条 finding 实际考察的事件条数(stall=全部,loop/no_progress=窗口) */
  window_size: number;
  /** 循环/空转判据命中的键;stall 无 */
  repeat_key?: string;
  /** repeat_key 在窗内的出现次数 */
  repeat_count?: number;
}

export interface SupervisorFinding {
  kind: SupervisorFindingKind;
  /** 具体规则的稳定标识(进事件、进去重键,不要改字符串) */
  rule: string;
  severity: SupervisorSeverity;
  evidence: SupervisorEvidence;
}

export const RULE_STALL_LAST_EVENT_GAP = "stall.last_event_gap";
export const RULE_LOOP_TOOL_REPEAT = "loop.tool_repeat";
export const RULE_NO_PROGRESS_TARGET_REPEAT = "no_progress.target_repeat";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 工具名:Observation 层只留了 payload.tool_names(白名单),没有入参 —— 见文件头。 */
function toolNamesOf(e: AgentEventV1): string[] {
  const names = asRecord(e.payload).tool_names;
  if (!Array.isArray(names)) return [];
  return names.filter((n): n is string => typeof n === "string" && n.length > 0);
}

function textOf(e: AgentEventV1): string {
  const text = asRecord(e.payload).text;
  return typeof text === "string" ? text : "";
}

/** 随机字节的形状:uuid、长 hex(sha/随机目录名)、纯数字段。 */
const ISO_TS_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/g;
const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
const EPOCH_RE = /\b\d{10,13}\b/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const LONG_HEX_RE = /\b[0-9a-f]{12,}\b/gi;
const LONG_DIGITS_RE = /\b\d{6,}\b/g;

/**
 * 路径里以下面这些名字开头的目录,其下的每一段都是「每次运行都不一样」的字节:
 * 临时工作目录、worktree 后缀、缓存 hash。整枝砍成占位符 —— 否则同一动作的两行
 * 永远算不出重复(见文件头第 2 条)。
 */
const TEMP_MARKERS = new Set(["tmp", ".tmp", "scratch", "worktrees", "worktree", ".cache"]);

/** 单段是否本身就是随机名(纯 hex / 纯数字 / hex 前缀 + 尾巴)。 */
function isRandomSegment(seg: string): boolean {
  return /^[0-9a-f]{8,}$/i.test(seg) || /^\d+$/.test(seg) || /^[0-9a-f]{6,}-/i.test(seg);
}

function normalizePath(target: string): string {
  // /private/var/tmp、/var/tmp 统一到 /tmp:miniflare/macos/linux 的同义写法不该分成两个键
  const collapsed = target.replace(/^\/?(private\/)?var\/tmp\//, "/tmp/");
  const absolute = collapsed.startsWith("/");
  const segments = collapsed.split("/").filter((s) => s.length > 0);
  const out: string[] = [];
  for (const seg of segments) {
    if (TEMP_MARKERS.has(seg)) {
      out.push(seg, "<...>");
      break;
    }
    out.push(isRandomSegment(seg) ? "<id>" : seg);
  }
  return (absolute ? "/" : "") + out.join("/");
}

/**
 * 自由文本 → 可比较的 target。
 * 顺序有意为之:先按路径/命令行拆形状,再把随机字节折成占位符,最后限长。
 */
export function normalizeTarget(raw: string): string {
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length === 0) return "";

  const tokens = text.split(" ");
  const head = tokens[0];
  // 「首词 + 实参」而不是整行:同一句 `npm test -- --reporter=x` 每次可能追加不同 flag,
  // 而真正区分「在碰哪个东西」的是命令与它的主目标。路径形状(含 / 或带扩展名,可带
  // :line)直接当目标,不再往后取实参 —— `src/a.ts:12` 的目标就是 src/a.ts。
  const looksLikePath =
    /^[~/]/.test(head) || /\.\.?\//.test(head) || head.includes("/") || /^[^\s]*\.[A-Za-z]{1,5}(:\d+)?$/.test(head);
  const shaped = looksLikePath
    ? normalizePath(head)
    : (() => {
        const arg = tokens.slice(1).find((t) => !t.startsWith("-"));
        return arg ? `${head} ${normalizePath(arg)}` : head;
      })();

  return shaped
    .replace(ISO_TS_RE, "<ts>")
    .replace(DATE_RE, "<date>")
    .replace(EPOCH_RE, "<epoch>")
    .replace(UUID_RE, "<id>")
    .replace(LONG_DIGITS_RE, "<id>")
    .replace(LONG_HEX_RE, "<id>")
    .slice(0, TARGET_MAX_CHARS);
}

/** 某条事件的 target:可见文本归一化;看不见就退化为工具名(见文件头的分辨率说明)。 */
function targetOf(e: AgentEventV1): string {
  const normalized = normalizeTarget(textOf(e));
  if (normalized.length > 0) return normalized;
  return toolNamesOf(e).join(",");
}

/** 某条事件的 repeat_key = 工具名 + 归一化后的动作摘要。非工具调用没有键。 */
function repeatKeyOf(e: AgentEventV1): string | null {
  const names = toolNamesOf(e);
  if (names.length === 0) return null;
  return `${names.join(",")}@${targetOf(e)}`;
}

/** 窗内按 key 计数,返回出现最多的那个。 */
function topCount(events: AgentEventV1[], keyOf: (e: AgentEventV1) => string | null): { key: string; count: number } | null {
  const counts = new Map<string, number>();
  let best: { key: string; count: number } | null = null;
  for (const e of events) {
    const key = keyOf(e);
    if (key === null || key.length === 0) continue;
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    if (!best || next > best.count) best = { key, count: next };
  }
  return best;
}

/**
 * 三类判据一次跑完,**返回数组**(可以并存:悬挂 20 分钟的任务既 stall 又可能有
 * 悬挂前的 loop 痕迹)。并存正是 Supervisor 的价值 —— 一条链上只看到一个信号时,
 * 人还是得自己判断「这是不是卡住了」。
 */
export function detectSupervisor(args: {
  now_ms: number;
  events: AgentEventV1[];
  thresholds?: Partial<SupervisorThresholds>;
}): SupervisorFinding[] {
  const t: SupervisorThresholds = { ...SUPERVISOR_THRESHOLDS, ...(args.thresholds ?? {}) };
  const events = args.events;

  // 误报防线①(文件头第 1 条):没有证据 ≠ 卡住。空输入一律不报。
  if (events.length === 0) return [];

  const last = events[events.length - 1];
  const lastEventTs = typeof last.ts === "string" ? last.ts : null;
  const lastMs = lastEventTs === null ? NaN : Date.parse(lastEventTs);
  // 时间戳不可解析时 gap 记 null 且不报 stall:journal 里的 ts 由摄取侧写入,坏到
  // 解析不了说明观测面自己出了问题,此时「多久没动」无从谈起 —— 猜一个值就是把
  // 数据故障伪装成行为异常。
  const gapMs = Number.isFinite(lastMs) ? args.now_ms - lastMs : null;

  const findings: SupervisorFinding[] = [];
  const base: Omit<SupervisorEvidence, "window_size"> = {
    last_event_ts: lastEventTs,
    gap_ms: gapMs,
  };

  // ---- stall:心跳 ----
  // 边界一律**严格大于**。恰好等于阈值不报:阈值是「超出正常抖动」的分界点,取等号
  // 会让「阈值 + 0」与「阈值 - ε」这两种实际无差别的情况给出不同结论,而测试必须
  // 把这个选择钉成契约(见 test/supervisor-detect.test.ts)。
  if (gapMs !== null && gapMs > t.stall_red_ms) {
    findings.push({ kind: "stall", rule: RULE_STALL_LAST_EVENT_GAP, severity: "red", evidence: { ...base, window_size: events.length } });
  } else if (gapMs !== null && gapMs > t.stall_yellow_ms) {
    findings.push({ kind: "stall", rule: RULE_STALL_LAST_EVENT_GAP, severity: "yellow", evidence: { ...base, window_size: events.length } });
  }

  // ---- loop:同一个工具动作在窗内反复出现 ----
  const loopWindow = events.slice(-Math.max(1, Math.floor(t.loop_window)));
  const loop = topCount(loopWindow, repeatKeyOf);
  if (loop && loop.count >= t.loop_repeat_max) {
    findings.push({
      kind: "loop",
      rule: RULE_LOOP_TOOL_REPEAT,
      severity: loop.count >= t.loop_repeat_max * 2 ? "red" : "yellow",
      evidence: {
        ...base,
        window_size: loopWindow.length,
        repeat_key: loop.key,
        repeat_count: loop.count,
      },
    });
  }

  // ---- no_progress:反复碰同一个目标 ----
  // 与 loop 的分工:loop 看「动作全等(工具名 + 参数)」,no_progress 只看「目标」。
  // 于是 read A → edit A → read A → edit A… 这种工具名交替、loop 抓不到的形态,
  // 由 no_progress 抓到:它在同一个东西上转圈。
  const npWindow = events.slice(-Math.max(1, Math.floor(t.no_progress_window)));
  const np = topCount(npWindow, (e) => (toolNamesOf(e).length > 0 ? targetOf(e) : null));
  if (np && np.count >= t.no_progress_repeat_max) {
    findings.push({
      kind: "no_progress",
      rule: RULE_NO_PROGRESS_TARGET_REPEAT,
      severity: np.count >= t.no_progress_repeat_max * 2 ? "red" : "yellow",
      evidence: {
        ...base,
        window_size: npWindow.length,
        repeat_key: np.key,
        repeat_count: np.count,
      },
    });
  }

  return findings;
}

/**
 * 幂等去重的状态:`(attempt_id, kind, rule, severity) → 上次上报时刻(ms)`。
 * 存 DO storage(见 session.ts),**不能**存在 alarm 的局部变量里 —— 每次 alarm
 * 触发是一次独立的请求,局部变量随请求结束消失,等于没有去重。
 */
export type SupervisorReported = Record<string, number>;

export function supervisorDedupeKey(args: {
  attempt_id: string;
  kind: SupervisorFindingKind;
  rule: string;
  severity: SupervisorSeverity;
}): string {
  return `${args.attempt_id}|${args.kind}|${args.rule}|${args.severity}`;
}

/** severity 的下一级:目前只有 red 有下一级(yellow),yellow 之上无。 */
function lowerSeverity(s: SupervisorSeverity): SupervisorSeverity | null {
  return s === "red" ? "yellow" : null;
}

/**
 * 本轮该发哪些 finding、去重表更新成什么。纯函数(表由参数进、由返回值出),
 * 所以「第二次 tick 不产生第二条事件」这类契约可以脱离 DO 直接测。
 *
 * 发事件只有三种情况:首次出现、severity 升级(yellow→red)、距上次上报超过冷却期。
 */
export function selectFindingsToEmit(args: {
  attempt_id: string;
  findings: SupervisorFinding[];
  reported: SupervisorReported;
  now_ms: number;
  cooldown_ms?: number;
}): { emit: SupervisorFinding[]; reported: SupervisorReported } {
  const cooldown = args.cooldown_ms ?? SUPERVISOR_DEDUPE_COOLDOWN_MS;
  const reported: SupervisorReported = { ...args.reported };
  const emit: SupervisorFinding[] = [];

  // 同一次 tick 里同一 kind 只会有一条(severity 由阈值决定),但多个 kind 可并存;
  // 逐条按各自的键判,已在本轮记过键的不再重复发。
  const seenThisRound = new Set<string>();
  for (const f of args.findings) {
    const keyOf = (severity: SupervisorSeverity) =>
      supervisorDedupeKey({ attempt_id: args.attempt_id, kind: f.kind, rule: f.rule, severity });

    const lastAt = reported[keyOf(f.severity)];
    const lower = lowerSeverity(f.severity);
    const lowerAt = lower === null ? undefined : reported[keyOf(lower)];

    const firstTime = lastAt === undefined;
    // 升级 = 低一档报过,且低一档那次不早于本档上一次。写「不早于」而不是「黄之后必红」
    // 是为了这个真实序列:red(200s) → 恢复一下又卡住 → yellow(400s) → red(600s)。
    // 只看本档最近一次会把第二次 red 吞掉(距 200s 未过冷却),而「又红了」正是必须
    // 再说一次的信号。
    const escalated = lowerAt !== undefined && (lastAt === undefined || lowerAt >= lastAt);
    const cooldownExpired = lastAt !== undefined && args.now_ms - lastAt > cooldown;
    if (!(firstTime || escalated || cooldownExpired)) continue;

    seenThisRound.add(keyOf(f.severity));
    reported[keyOf(f.severity)] = args.now_ms;
    emit.push(f);
  }
  return { emit, reported };
}

/** finding → 权威事件 payload 的形状。抽出来是为了让「链里到底写了什么」可单测。 */
export function supervisorFindingPayload(args: {
  attempt_id: string;
  finding: SupervisorFinding;
  mode: "shadow";
}): Record<string, unknown> {
  const f = args.finding;
  return {
    attempt_id: args.attempt_id,
    kind: f.kind,
    rule: f.rule,
    severity: f.severity,
    evidence: f.evidence,
    mode: args.mode,
    enforced: false,
  };
}

/** Supervisor 自身读 journal 失败时的降级标记(只进 console,不进权威链 —— 见 session.ts)。 */
export const SUPERVISOR_DEGRADED_TAG = "supervisor_journal_unavailable";
