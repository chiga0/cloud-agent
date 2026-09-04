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
 * 3. **为什么 stall 需要两条判据而不是一条**:一条「最后事件距今多久」把两件不同的事
 *    混成了一个数 —— 观测通道停不停(runner/poll 相)与模型说不说话(agent)。c10 取证
 *    证明这两个时长在健康任务上会分叉到一个健康 writer 静默 576s、而一次真悬挂的
 *    转录静默也差不多是那个量级,于是单判据无论定 90s 还是 300s 都是在猜。分开之后
 *    分级才有依据:**心跳断 ⇒ red**(每轮无条件写的那条也没了 = runner 自己停了,
 *    不依赖任何「agent 应该多久动一次」的假设);**心跳在而转录静 ⇒ 只 yellow**
 *    (区分不了「挂了」与「在干不产转录的长活」,所以这条永远不给 red —— 详见
 *    detectSupervisor 里的注释)。没有独立时间源就没有分级:这是 §9.8 的全部根据。
 *
 * 分辨率的天花板在哪里,由 Observation 层的白名单决定:input 参数整体**仍然**不进 journal
 * (input 是自由文本 = 凭据外流面),但 §9.5 从 c10 的技术债起多留了一个受限出口
 * `payload.tool_targets` —— 按键白名单(file_path / path / pattern / directory / command)
 * + 打码 + 截断到 128 的形状摘要。target 的三级取值(入参目标 → 可见文本 → 工具名)见
 * targetOf 的注释。取到第三级时「反复调同一个工具」与「反复做同一件事」无法区分 ——
 * 这不是可以先凑一下的细节:它决定了 no_progress 与 loop 的区分度,也决定了 §9.8 为什么
 * 要求 shadow 样本按 tool_targets 是否存在**分段**统计。
 */

import { POLL_INTERVAL_MS } from "../exec/longrun";
import { OBS_HEARTBEAT_KIND, type AgentEventV1 } from "../obs/events";

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

/** alarm 的 tick 缺省值(= 判据每分钟才醒一次)。 */
export const SUPERVISOR_DEFAULT_TICK_SECONDS = 60;

/** ---- stall 阈值的推导:先量,再定 —— 每一个数字都要能追溯到一次实测 ---- */

/**
 * 实测**中位轮次**(毫秒)。来源:`~/c10-evidence/ingest-cadence-measurement.md`,
 * 两个独立任务共 51 轮(w1a 与 c11),中位数同为 33s —— 比 `POLL_INTERVAL_MS` 大 3s
 * 是真实成本,但**不是**「一次 30 秒级的读」叠在睡眠上(那份实测自己也写了读的时间被
 * 轮询间隔吸收、与睡眠相加不成立)。c10b 起心跳自报 `round_ms`(摄取这一轮自身的墙钟),
 * prod 首个 writer 实测中位 337ms / 最长 529ms ⇒ 33s 里的 ~3.5s 富余属于同一个 poll step
 * 的其余工作(进程快照 RPC + Workflows step 边界),而不是读文件。
 * **数字没变,归因错过一次** —— 这段留在这里是因为阈值读起来像在依赖那个归因。
 * 被证伪的是「摄取节拍每 30s 一次」这个**前提**本身:旧阈值 90/300 全建立在它之上。
 */
const MEASURED_ROUND_MEDIAN_MS = 33_000;

/**
 * 实测**最长轮次间隔**(毫秒):c11 的 41 轮里 9 个间隔 >60s(22% 的轮次被跳过),
 * 最长 94s = 连跳 2 轮。**这个数出自旧口径**(对 journal `ts` 去重反推轮次)。心跳上线
 * 后可以直接量了:首个样本(c14 writer,38 个 `gap_ms`,窗口 22 分钟,全程健康退出 0)
 * 全部落在 **32.6–34.7s,0 个 >60s** ⇒ 「22% 跳轮」至今**未被直接时间源复现**,它是
 * 任务/时段相关的现象,不是轮询的固有属性。取 94s 作为**设计上的最坏值**(任何样本里
 * 都没见过比这更长的间隔),而不是「当前分布的上界」—— 导出它是为了让测试钉住
 * 「红线 / 最坏间隔」这个比值,那是这条判据唯一可被后来者复查的凭据。
 */
export const MEASURED_ROUND_MAX_MS = 94_000;

/** 连续缺席多少个轮次算「runner 停了」。按**轮数**表达,秒数是派生的。 */
export const NO_HEARTBEAT_MISS_ROUNDS = 5;

/** 一轮的名义长度:标称轮询与实测中位轮次里取更慢的那个(33s)。 */
export const HEARTBEAT_ROUND_MS = Math.max(POLL_INTERVAL_MS, MEASURED_ROUND_MEDIAN_MS);

/** 向上取整到 tick 的整数倍:判据每 tick 才醒一次,取整前的余数在观测上不可区分。 */
function ceilToTick(ms: number): number {
  const tick = SUPERVISOR_DEFAULT_TICK_SECONDS * 1000;
  return Math.ceil(ms / tick) * tick;
}

/**
 * `no_heartbeat` 的红线 = `NO_HEARTBEAT_MISS_ROUNDS × HEARTBEAT_ROUND_MS`
 *              = 5 × 33s = 165s → 向上取整到 tick(60s)= **180s**。
 *
 * 为什么按**轮数**表达而不是直接写秒数:改了 `POLL_INTERVAL_MS` 之后阈值必须跟着走。
 * 写死的秒数不会报错,只会静默地变成「4 轮」或「5.5 轮」—— 而这条判据的语义是轮数。
 *
 * 为什么不取「一个最坏轮次 + 一点余量」(旧 stall 的写法):旧样本里 22% 的轮次会被跳过,
 * **抖动是常态不是意外**,任何「覆盖一个轮次」的阈值都会在健康任务上误红。
 * 为什么不是更保守的 3 × 94s:94s 本身已经是「连跳 2 轮」的结果,再乘 3 等于把同一个
 * 跳过现象计两次。按独立轮次粗估:单轮没落盘 ≈ 0.22,而 gap 要超过 180s 需要连续 5 轮
 * 没落盘(6 × 33s = 198s)≈ 0.22⁵ = 0.05%;一个 45 轮的 attempt 出现一次 ≈ 2%。
 * 这个 2% 建立在「跳过的轮次相互独立」上,而真实的跳过多半成批出现(容器抖动、RPC 重试)
 * —— 所以它既是估计也是假设。⚠️ **enforce 之前必须用 shadow 期样本复核**:c10b 起
 * journal 里每条心跳自带 gap_ms,这条分布可以直接量出来,不必再靠上面的模型。
 *
 * **首个直接样本(2026-09-04,c14 writer,n=38)**:`gap_ms` 全在 32.6–34.7s,一个 >60s 的
 * 都没有 ⇒ 0.22 那个先验高估了跳轮率,2% 的误红率随之也是**高估**(方向保守,阈值不动)。
 * 复核时该盯的比值是 **红线 / 实测最长 gap = 180 / 34.7 ≈ 5.2×**;样本变大后若这个比值
 * 掉到 2× 以内,再谈收紧 `NO_HEARTBEAT_MISS_ROUNDS`。
 */
export const NO_HEARTBEAT_RED_MS = ceilToTick(NO_HEARTBEAT_MISS_ROUNDS * HEARTBEAT_ROUND_MS);

/**
 * `agent_silent` 的黄线。实测**健康** writer 上最长的一段转录静默是 576s
 * (04:03:43→04:13:19,journal 无新条目)—— 那期间 runner 一直在跳,只是模型没吐字。
 * 取 576s × 1.5 的安全系数 → 864s,向上取整到 tick = **900s(15 分钟)**。
 *
 * 样本只有 1 个,这是这条阈值里最弱的一环,所以:①它**永不给 red**(见文件头与
 * §9.8「为什么 agent_silent 永远不给 red」);②阈值偏保守的代价只是「黄色晚 15 分钟
 * 才出现」,而不是误杀;③enforce 之前必须用 shadow 样本复核并分段统计。
 */
export const AGENT_SILENT_YELLOW_MS = ceilToTick(576_000 * 1.5);

/**
 * 阈值。全部可注入(见 detectSupervisor 的 thresholds 参数),这里的常量是缺省值。
 *
 * **单一权威副本**:这几个数字同时是 Supervisor 的判据与 Live UI 的显示口径
 * (src/obs/live.ts 直接 import 本文件的常量)。历史上它们是一份数字、两处字面量、
 * 两段理由,于是 live.ts 里那句「摄取节拍每 30s 一次」的错误前提被抄了两遍。
 * 现在:推导只在这里(c10 的取证数据 + 上面的算式),读端只引用。
 *
 * loop/no_progress 的窗口是**条数**而不是时间:判据问的是「这段时间里它在做什么」,
 * 事件密度本身就是要看的东西;用时间窗口会让高频空转(每秒一次工具调用)与低频空转
 * 用同一把尺子。重复上限取窗口的一半量级,低于它的重复在正常任务里是常态(改一个
 * 文件要 read→edit→read 两三次),所以取「明显超出常态」而不是「绝不可能是常态」。
 * 两个窗口的输入一律**排除心跳**(见 `behavioralOnly`):心跳没有 `tool_names`、塌不出
 * repeat_key,所以它造成的不是误报 —— 而是滑窗按**条数**取,每轮一条的心跳会把 20/30 槽
 * 填满,把真循环挤到窗外 ⇒ 长任务尾部的行为判据集体失聪(漏报)。机理与对偶用例见
 * `behavioralOnly` 上方注释及 §9.8。
 */
export const SUPERVISOR_THRESHOLDS = {
  /**
   * 最后一条**心跳**滞后超过它 → red(no_heartbeat)。= `5 × max(POLL_INTERVAL_MS,
   * 实测中位 33s)` 向上取整到 tick;当前胜出项是**实测**那一侧,名义轮询周期只是下界
   * (改 POLL_INTERVAL_MS 不带动这个数,§9.8 有这条仪器盲区的说明)。
   */
  no_heartbeat_red_ms: NO_HEARTBEAT_RED_MS,
  /** 心跳在、最后一条**转录**事件滞后超过它 → yellow(agent_silent)。 */
  agent_silent_yellow_ms: AGENT_SILENT_YELLOW_MS,
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

/** finding 去重冷却期。 */
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
  /** 判据看到的最后一条**行为**事件时间(ISO,排除心跳);无行为事件为 null */
  last_event_ts: string | null;
  /** now_ms - last_event_ts;时间戳不可解析为 null */
  gap_ms: number | null;
  /** 本条 finding 实际考察的事件条数(stall=全部,loop/no_progress=窗口) */
  window_size: number;
  /** 循环/空转判据命中的键;stall 无 */
  repeat_key?: string;
  /** repeat_key 在窗内的出现次数 */
  repeat_count?: number;
  /**
   * 本段 journal 有没有心跳。**每条 finding 自带这个标记**,因为 shadow 样本必须按
   * 「有心跳 / 无心跳」分段统计:混算等于拿旧数据判新判据(c10b 的阈值来自有心跳的那段,
   * 而旧段的 gap 量的是「上一轮读到新东西的时刻」,分布完全不同)。
   */
  has_heartbeat: boolean;
  /** 最后一条心跳的 ts;无心跳为 null */
  last_heartbeat_ts?: string | null;
  /** now_ms - 最后一条心跳 ts;no_heartbeat 量的就是这个滞后 */
  heartbeat_gap_ms?: number | null;
  /** 最后一条行为(非心跳)事件的 ts;整段没有行为事件时退回首条心跳 ts = 观察开始 */
  last_transcript_ts?: string | null;
  /** now_ms - last_transcript_ts */
  transcript_gap_ms?: number | null;
  /** 最后一条心跳自报的 round_ms(实测轮次长度);没有则 null */
  round_ms?: number | null;
}

export interface SupervisorFinding {
  kind: SupervisorFindingKind;
  /** 具体规则的稳定标识(进事件、进去重键,不要改字符串) */
  rule: string;
  severity: SupervisorSeverity;
  evidence: SupervisorEvidence;
}

export const RULE_STALL_LAST_EVENT_GAP = "stall.last_event_gap";
export const RULE_STALL_NO_HEARTBEAT = "stall.no_heartbeat";
export const RULE_STALL_AGENT_SILENT = "stall.agent_silent";
export const RULE_LOOP_TOOL_REPEAT = "loop.tool_repeat";
export const RULE_NO_PROGRESS_TARGET_REPEAT = "no_progress.target_repeat";

/**
 * 「行为事件」= 除心跳以外的一切观测事件。loop / no_progress / agent_silent 只看这一类。
 *
 * 为什么必须排除心跳:**失效方向是漏报,不是误报**。心跳 payload 只有枚举与数值(没有
 * `tool_names`),而两条行为判据的键函数都要求先有工具名才成形 —— 塌不出 repeat_key
 * 就不构成假阳性。它们真正的破坏力在**槽位**:滑窗是 `events.slice(-window)`,按条数取,
 * 而心跳每轮一条 —— 一个 25 分钟的 attempt 攒 ~45 条,多于 `loop_window=20` 与
 * `no_progress_window=30`,不排除时窗里全是心跳,真循环整个落在窗外,于是**每条长任务尾部
 * 的行为判据集体失聪**,恰好是最需要它们的那一段。排除之后心跳只剩一个用途:当时间源。
 * 判别力对偶用例见 `test/supervisor-detect.test.ts`「真循环被心跳追在身后时仍要命中」。
 */
function behavioralOnly(events: AgentEventV1[]): AgentEventV1[] {
  return events.filter((e) => e.kind !== OBS_HEARTBEAT_KIND);
}

/** ISO → ms;不可解析返回 null(调用方一律「不判」而不是「猜一个值」)。 */
function msOf(ts: string | null | undefined): number | null {
  if (typeof ts !== "string") return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 工具名:Observation 层的枚举白名单(§9.5),不含入参。 */
function toolNamesOf(e: AgentEventV1): string[] {
  const names = asRecord(e.payload).tool_names;
  if (!Array.isArray(names)) return [];
  return names.filter((n): n is string => typeof n === "string" && n.length > 0);
}

/**
 * 入参目标(§9.5 的 `tool_targets`):已过 ingress 脱敏(按键白名单 + 打码 + ≤128)。
 * 数组可能缺失(早于该字段上线的段文件)或含 `""` 占位(该工具没有可取形状)—— 两种都
 * 按「没有这一级」降级处理,不抛。
 */
function toolTargetsOf(e: AgentEventV1): string[] {
  const targets = asRecord(e.payload).tool_targets;
  if (!Array.isArray(targets)) return [];
  return targets.filter((t): t is string => typeof t === "string");
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

/**
 * 某条事件的 target。三级降级,一级都取不到时退化为工具名:
 *
 * 1. `payload.tool_targets` 首个能归一化成非空串的目标 —— 这就是「它在碰哪个东西」;
 * 2. `payload.text` 的归一化 —— 老段文件(c10a 部署前落的 journal 段)与 `raw`/`assistant`
 *    这类没有工具形状的事件走的都是这条,现实里长期存在,不是过渡兜底;
 * 3. 工具名本身 —— 分辨率的地板。取到这一级时同一工具的任意两次调用都会算作重复,
 *    所以 loop 的误报面就在这一级上;§9.8 要求 shadow 样本按 `tool_targets` 是否存在分段统计。
 *
 * 逐条试而不是只看第 0 条:一条 assistant 行可以带多个 tool_use 块,第 0 个可能恰好没有
 * 形状(`tool_targets` 用 `""` 占位以对齐下标),那不代表整行看不见目标。
 */
function targetOf(e: AgentEventV1): string {
  for (const raw of toolTargetsOf(e)) {
    if (raw.trim().length === 0) continue;
    const shaped = normalizeTarget(raw);
    if (shaped.length > 0) return shaped;
  }
  const fromText = normalizeTarget(textOf(e));
  if (fromText.length > 0) return fromText;
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

  // 两条时间源分开算:心跳给「观测通道还通不通」,行为事件给「模型有没有在动」。
  // 混成一条就是旧 stall 的失效根因 —— 它量的其实是「上一轮读到新东西的时刻」,
  // 那个时刻由摄取节奏决定,不是由 agent 决定(实测一个健康 writer 静默 576s)。
  const beats = events.filter((e) => e.kind === OBS_HEARTBEAT_KIND);
  const behavioral = behavioralOnly(events);
  const hasHeartbeat = beats.length > 0;

  const last = behavioral.length > 0 ? behavioral[behavioral.length - 1] : events[events.length - 1];
  const lastEventTs = typeof last.ts === "string" ? last.ts : null;
  const lastMs = msOf(lastEventTs);
  // 时间戳不可解析时 gap 记 null 且不报 stall:journal 里的 ts 由摄取侧写入,坏到
  // 解析不了说明观测面自己出了问题,此时「多久没动」无从谈起 —— 猜一个值就是把
  // 数据故障伪装成行为异常。
  const gapMs = lastMs === null ? null : args.now_ms - lastMs;

  const lastBeat = hasHeartbeat ? beats[beats.length - 1] : null;
  const beatMs = lastBeat === null ? null : msOf(lastBeat.ts);
  const heartbeatGapMs = beatMs === null ? null : args.now_ms - beatMs;
  const lastBehavioral = behavioral.length > 0 ? behavioral[behavioral.length - 1] : null;
  const behavioralMs = msOf(lastBehavioral?.ts ?? null);
  const transcriptGapMs = behavioralMs === null ? null : args.now_ms - behavioralMs;
  // 心跳自报的实测轮次:进 evidence 是为了 shadow 期能直接量分布,不必再解析 tail。
  const roundMs = (() => {
    const raw = lastBeat === null ? undefined : asRecord(lastBeat.payload).round_ms;
    return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  })();

  const findings: SupervisorFinding[] = [];
  const base: Omit<SupervisorEvidence, "window_size"> = {
    last_event_ts: lastEventTs,
    gap_ms: gapMs,
    has_heartbeat: hasHeartbeat,
    last_heartbeat_ts: lastBeat === null ? null : lastBeat.ts,
    heartbeat_gap_ms: heartbeatGapMs,
    last_transcript_ts: lastBehavioral === null ? null : lastBehavioral.ts,
    transcript_gap_ms: transcriptGapMs,
    round_ms: roundMs,
  };

  // ---- stall:两条判据,分级依据是「有没有心跳这条独立时间源」 ----
  // 边界一律**严格大于**。恰好等于阈值不报:阈值是「超出正常抖动」的分界点,取等号
  // 会让「阈值 + 0」与「阈值 - ε」这两种实际无差别的情况给出不同结论,而测试必须
  // 把这个选择钉成契约(见 test/supervisor-detect.test.ts)。
  if (hasHeartbeat) {
    // (1) no_heartbeat ⇒ **red**。心跳断 = 每轮无条件写的那条也没了 = 轮询/runner 自己
    //     停了,这是高置信度:它不依赖「agent 应该多久说一次话」这种假设。
    if (heartbeatGapMs !== null && heartbeatGapMs > t.no_heartbeat_red_ms) {
      findings.push({
        kind: "stall",
        rule: RULE_STALL_NO_HEARTBEAT,
        severity: "red",
        evidence: { ...base, window_size: events.length },
      });
    }
    // (2) agent_silent ⇒ **只 yellow,永不 red**。
    //     为什么永远不给 red:转录静默有两种成因 —— agent 真的悬挂,和 agent 在干一件
    //     不产转录的长活(装依赖、跑测试、模型内部思考)。c10 取证里一个**健康** writer
    //     静默过 576s,而 C2-r6 的 24 分钟悬挂长得一模一样:这一对上没有任何时间源能
    //     区分,给 red 就等于把「判据分不开」伪装成「任务确实死了」。而 red 在 enforce
    //     之后就是处置信号 —— 观察与裁决分离的底线是:判据不许把自己的分辨率上限藏起来。
    //     参照点:整段没有行为事件时,用首条心跳 ts(= 观察开始),否则每个刚起跑的
    //     attempt 都会因为「还没有转录」被判(文件头误报防线①的新形态)。
    const silenceRefMs =
      behavioralMs ?? (lastBeat === null ? null : msOf(beats[0].ts));
    const silenceGapMs = silenceRefMs === null ? null : args.now_ms - silenceRefMs;
    if (silenceGapMs !== null && silenceGapMs > t.agent_silent_yellow_ms) {
      findings.push({
        kind: "stall",
        rule: RULE_STALL_AGENT_SILENT,
        severity: "yellow",
        evidence: {
          ...base,
          transcript_gap_ms: silenceGapMs,
          window_size: events.length,
        },
      });
    }
  } else if (gapMs !== null && gapMs > t.agent_silent_yellow_ms) {
    // (3) downlevel:c10b 之前落的段(以及心跳上线前的历史 attempt)根本没有心跳这条
    //     时间源,于是「分级」无从谈起。这里保留 last_event_gap,但**只有 yellow** ——
    //     判据能说的只是「这个观测面上很久没出现新东西」,而那句话在没有独立时间源时
    //     推不出「runner 停了」。§9.8 要求 shadow 样本按有心跳/无心跳分段统计:混算等于
    //     拿旧数据判新判据,而旧数据的 gap 分布是「摄取节奏 + 转录节奏」的卷积。
    findings.push({
      kind: "stall",
      rule: RULE_STALL_LAST_EVENT_GAP,
      severity: "yellow",
      evidence: { ...base, window_size: events.length },
    });
  }

  // ---- loop:同一个工具动作在窗内反复出现(输入已排除心跳) ----
  const loopWindow = behavioral.slice(-Math.max(1, Math.floor(t.loop_window)));
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

  // ---- no_progress:反复碰同一个目标(输入已排除心跳) ----
  // 与 loop 的分工:loop 看「动作全等(工具名 + 参数)」,no_progress 只看「目标」。
  // 于是 read A → edit A → read A → edit A… 这种工具名交替、loop 抓不到的形态,
  // 由 no_progress 抓到:它在同一个东西上转圈。
  const npWindow = behavioral.slice(-Math.max(1, Math.floor(t.no_progress_window)));
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
