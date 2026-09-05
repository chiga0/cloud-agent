/**
 * 平台路由分流(M9.5②③)的判定层:把「这次失败是什么性质」与「失败之后走哪条路」
 * 分开决定,并且**每次判定都留一条结构化事件**供事后核算。
 *
 * 要治的病(2026-09-02 prod 标本,任务 6d4574df / verifier f1673050):
 * writer 一次成功(~14min)→ verifier 因沙箱出站 ECONNRESET 落成 verify exit 1
 * (apply exit 0,候选补丁本身完好)→ 控制面把它当成质量失败送 writer 全量返工 ×2
 * → 两轮都跑满 2400s 墙钟以 exit 55 退出 → exit 55 又被当成失败**再**返工
 * → 熔断 BLOCKED。两次返工 ≈50 分钟与数 M token 白烧,而正确处置本应是重试 verifier
 * 或 BLOCKED 转人工。根因不是缺重试逻辑,而是路由层只有一档:终态非 0 即质量失败。
 *
 * 本模块是纯函数:不读 env、不碰 DO、不写事件、不起沙箱,全部输入由调用方注入 ——
 * 判据可以穷举单测,也可以被 `TaskSession` 与将来的外圈 Supervisor 共用同一份口径。
 *
 * 刻意不做(留下一期,按 shadow 事件计数决定):
 * - `env_transient` 的 enforce 与 `retry_verifier` 分支 —— 错误文本启发式有误报面,
 *   样本未攒够;不写半截的 retry 分支。
 * - 改 exit 53/55 的产生侧(qwen 自己的预算机制,平台不动)。
 *
 * §13.23 给这条轴补的是 `provider_infra` 一档:writer 的终态文本整串就是 provider 错误时
 * (2026-09-03 标本:三个 attempt 全 403 AccessDenied,被当成质量失败烧光返工额度),
 * 成因判读在 `src/routing/error-class.ts`(与 reviewer 共用词表),本模块只负责把它
 * 映射成路由主张。强制力由 `ROUTING_INFRA_MODE` 运行时决定,缺省 shadow。
 */

import { classifyProviderError, type ErrorClass } from "./error-class";

/**
 * qwen-code `--max-session-turns` 超限的退出码。
 * 来源:qwen 0.22.3 `nonInteractiveCli.ts` 的 `enforceSessionTurnLimit`。
 */
export const EXIT_SESSION_TURNS_LIMIT = 53;

/**
 * qwen-code 预算击杀(`--max-wall-time` / `--max-tool-calls` 超限)的退出码。
 * 来源:qwen 0.22.3 `chunk-DJPASAUV.js:42029-42032`。
 * **不是 token 预算**:token 侧只有事后记账,从不执法(§13.20)。把 55 读成
 * 「token 烧完了」会得出完全错误的处置结论 —— 它是墙钟/次数到期。
 */
export const EXIT_BUDGET_ABORT = 55;

/**
 * 失败性质。一次分类恰好命中一个,`quality` 是兜底档。
 *
 * `provider_infra`(§13.23):provider 侧确定性错误 —— 端点拒绝了这个模型/这把 key/这份额度。
 * 它与候选质量零相关,返工只是把同一个失败买贵一次;`quality` 与它的区别就是「重做有没有
 * 可能不一样」。
 */
export type RouteKind =
  | "budget_turns"
  | "budget_abort"
  | "provider_infra"
  | "env_transient"
  | "quality";

/** 触发的判据名。进事件链,是「为什么这么判」的可审计答案,也是模式表的键。 */
export type RouteRule =
  | "writer_exit_53_session_turns"
  | "writer_exit_55_budget_abort"
  | "writer_provider_error_shape"
  | "verifier_env_network_signature"
  | "quality_fallback";

/**
 * 路由动作。
 * - `blocked`:改路由 —— 停下转人工,绝不派同规格返工。
 * - `rework`:主张返工(= 既有语义,现状不变)。
 * - `none`:分类器**不主张**改动,交回调用方的既有路由。命中的是 shadow 档规则时
 *   用它:分类照记,处置权还在现有链路上。下一期把某条规则切到 enforce 时,改的是
 *   这张表里该规则的动作与模式表,而不是接线点。
 */
export type RouteAction = "blocked" | "rework" | "none";

export type RouteRuleMode = "enforce" | "shadow";

/**
 * `writer_provider_error_shape` 这条判据的强制力档位(§13.23)。三档,不是两档:
 * - `off`:整条判据当不存在 —— 不分类、不落事件、不改路由。逐字段等于本棒之前。
 * - `shadow`(缺省):照分类、照落 `route.infra_candidate` 事件,**路由动作一字不改**
 *   (仍走 quality → rework)。攒的就是这些事件。
 * - `enforce`:确定性 provider 错误不再派返工,直接 BLOCKED 转人工。
 *
 * 为什么不进 `ROUTE_RULE_MODES` 那张编译期表:这条的档位是**运行时由操作员拨的旋钮**
 * (`ROUTING_INFRA_MODE`),表里的值是写死在二进制里的。两处各存一份等于让「事件里写的
 * enforced」和「实际有没有强制力」可能各说各话。
 */
export const ROUTING_INFRA_MODES = ["off", "shadow", "enforce"] as const;
export type RoutingInfraMode = (typeof ROUTING_INFRA_MODES)[number];

/**
 * 读 `ROUTING_INFRA_MODE`。缺省 shadow;非法值同样落 shadow —— 与 `EGRESS_MODE`
 * 「有否决权的开关先观测再启用」同一取向:写错一个字母的后果是多记一条事件,
 * 绝不是悄悄开始有否决权。
 */
export function routingInfraMode(env: { ROUTING_INFRA_MODE?: string }): RoutingInfraMode {
  const raw = env.ROUTING_INFRA_MODE;
  return raw === "off" || raw === "enforce" ? raw : "shadow";
}

/** 分类器的输入:一次**失败**的 attempt 回报要素。成功回报不经此处。 */
export interface AttemptFailureSignals {
  /** reviewer 不在本判据范围内:它的 reject 由 gates.ts 的证据契约处置。 */
  role: "writer" | "verifier";
  /**
   * 终态退出码。**只有既有的两条预算判据读它的数值**(53/55 是平台自己下发的语义);
   * §13.23 的 provider 判据刻意不读 —— 11 只是 `adjudicateCliExit` 上翻的产物,不是成因。
   */
  exit_code: number;
  /**
   * 末条 result 事件的文本(writer 侧)。provider 成因按它的**整串形状**判定;
   * 缺省/空串 = 无可判读文本,判据不命中。
   */
  result_text?: string | null;
  /** provider 判据的档位。缺省 `off`(= 本棒之前的行为),由调用方从 env 读入。 */
  infra_mode?: RoutingInfraMode;
  /**
   * verifier 的结构化验证报告(schema v2,见 `src/exec/verify.ts`)。
   * 只在 verifier 路径上被读;writer 恒为 undefined。
   */
  verify_report?: VerifyReportSignals | null;
}

export interface VerifyReportSignals {
  apply: { exit_code: number; stderr_tail: string };
  verify: { exit_code: number; stderr_tail: string } | null;
}

export interface RouteDecision {
  kind: RouteKind;
  rule: RouteRule;
  action: RouteAction;
  /**
   * 命中的成因。**只在形状命中时存在**(缺省而非 null —— 既有的 `toEqual` 断言因此
   * 一字不改)。事件 payload 只取这个枚举值,绝不带原始错误文本。
   */
  error_class?: ErrorClass;
}

/**
 * 模式表:哪条判据有强制力。这是「哪条规则可以切 enforce」的唯一口径。
 *
 * 为什么两条 exit code 规则**默认 enforce**:退出码是平台自己下发给控制面的语义,
 * 不是从自由文本里猜出来的信号 —— 53/55 只可能由 qwen 的预算执法产生(writer 命令行
 * 显式带 `--max-session-turns` / `--max-wall-time`,见 `src/exec/sandbox.ts:qwenCommand`)。
 * 判据里没有任何启发式,因此没有误报面,不需要观测期。
 *
 * 为什么两条规则只在 writer 侧生效:只有 writer 的退出码来自我们亲手拼的那条 qwen
 * 命令。verifier 的 `exit_code` 就是任务自己那条 `verify_command` 的退出码,任意脚本
 * 都可能吐 53/55(比如某个测试框架把它当自己的失败码),拿它当「预算到期」会把真质量
 * 失败洗白成平台问题。
 *
 * 为什么环境签名规则**默认 shadow**:它是错误文本的启发式匹配,存在真实的误报面
 * (`ECONNREFUSED` 可能是测试自己连不上期望的服务)。仓内惯例是有否决权的开关先攒样本
 * 再 enforce(`REJECT_EVIDENCE_MODE` §13.12、`BASE_PIN_MODE` §13.13、`EGRESS_MODE` §13.14),
 * 本条同一口径:先只分类记事件,按 `route_decision` 的 kind 计数决定是否切 enforce。
 */
export const ROUTE_RULE_MODES = {
  writer_exit_53_session_turns: "enforce",
  writer_exit_55_budget_abort: "enforce",
  verifier_env_network_signature: "shadow",
  // 表里写 shadow 只是「编译期默认无否决权」的占位:这条判据的真实档位是运行时的
  // `ROUTING_INFRA_MODE`(见 routingInfraMode)。route_decision 的 `enforced` 字段对这条
  // 规则一律按注入档位算,不读这里 —— 读这里会把 enforce 模式下的实际处置记成假的。
  writer_provider_error_shape: "shadow",
  // 兜底档不是新规则,它就是既有语义:机械硬门禁历来有否决权,不经任何启发式。
  quality_fallback: "enforce",
} as const satisfies Record<RouteRule, RouteRuleMode>;

export function ruleMode(rule: RouteRule): RouteRuleMode {
  return ROUTE_RULE_MODES[rule];
}

/**
 * 依赖安装阶段的网络故障签名。
 *
 * 三条通道,都是 npm 自己给错误归类的产物:
 * 1. 裸 errno 词:连接被重置 / DNS 解析不出 / 超时 —— 只可能来自传输层;
 * 2. `npm error code <NET码>`:npm 显式标注的 error code 属于网络类的取值;刻意**不是**
 *    「以 E 开头就算」:`ERESOLVE`(依赖树冲突)、`EACCES`、`ENOENT` 这些同样是 E 前缀
 *    却与网络无关,误命中会把该返工的缺陷洗成环境问题;
 * 3. `npm error network …`:npm 对错误类的行前缀(`network aborted` /
 *    `This is a problem related to network connectivity.`),等于 npm 自己判定为网络问题。
 *
 * 匹配对象只有 `verify.stderr_tail`:npm 的错误出口恒定在 stderr,2026-09-02 标本
 * (verifier f1673050)的报告形态亦如此。
 */
const ENV_NETWORK_SIGNATURES: readonly RegExp[] = [
  /\bECONNRESET\b/,
  /\bENOTFOUND\b/,
  /\bETIMEDOUT\b/,
  /\bnpm error code (?:ECONNRESET|ECONNABORTED|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|ENETDOWN|ENETRESET|EHOSTUNREACH|ESOCKET|EPROTO|ERR_SOCKET_TIMEOUT)\b/,
  /\bnpm error network\b/,
];

/** 报告文本 → 分类要用的字段。形状不符即 null(交回 quality 兜底,绝不猜)。 */
export function parseVerifyReport(reportText: string | null | undefined): VerifyReportSignals | null {
  if (!reportText) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(reportText);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const apply = isRecord(raw.apply) ? raw.apply : null;
  if (!apply || typeof apply.exit_code !== "number" || typeof apply.stderr_tail !== "string") {
    return null;
  }
  // verify=null 是合法形态(apply 失败或没有 verify_command),此时不起验证进程
  if (raw.verify === null) return { apply: pickPhase(apply), verify: null };
  const verify = isRecord(raw.verify) ? raw.verify : null;
  if (!verify || typeof verify.exit_code !== "number" || typeof verify.stderr_tail !== "string") {
    return null;
  }
  return { apply: pickPhase(apply), verify: pickPhase(verify) };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 只取分类用到的两字段:报告里的 `stdout_tail` 等一律不带进判据。 */
function pickPhase(phase: Record<string, unknown>): { exit_code: number; stderr_tail: string } {
  return { exit_code: phase.exit_code as number, stderr_tail: phase.stderr_tail as string };
}

/**
 * 一次失败回报 → 路由决策。判据顺序即优先级:确定性最高的先判。
 *
 * `quality` 兜底覆盖:writer 的质量失败、verifier 的 apply 失败(候选不可重放)、
 * 非环境签名的 verify 失败、验证器基建错误(-1)回报。这些一律维持既有返工语义 ——
 * 本模块只负责把**不该返工**的那两类挑出来,不改其它任何判定。
 */
export function classifyAttemptFailure(args: AttemptFailureSignals): RouteDecision {
  if (args.role === "writer") {
    if (args.exit_code === EXIT_SESSION_TURNS_LIMIT) {
      return { kind: "budget_turns", rule: "writer_exit_53_session_turns", action: "blocked" };
    }
    if (args.exit_code === EXIT_BUDGET_ABORT) {
      return { kind: "budget_abort", rule: "writer_exit_55_budget_abort", action: "blocked" };
    }
    // provider 形状判读排在两条预算判据之后、质量兜底之前:53/55 与 provider 错误同框时
    // 两条都主张 blocked,但人在 BLOCKED 那头要调的旋钮不是同一个(预算 vs 端点资格)。
    const infra = providerInfraCandidate(args);
    if (infra?.is_infra && args.infra_mode === "enforce") {
      return {
        kind: "provider_infra",
        rule: "writer_provider_error_shape",
        action: "blocked",
        error_class: infra.error_class,
      };
    }
    // shadow 档:只分类、不落决策 —— 路由动作与 off 逐字段相同,新信息一律走
    // route.infra_candidate 那条独立事件(由调用方发)。瞬态成因(is_infra=false)即使在
    // enforce 下也走老路返工:漏报可以,误报不行。
  }

  if (args.role === "verifier" && isEnvNetworkFailure(args.verify_report)) {
    // shadow 档:照分类,不改路由(处置权留在调用方既有链路)
    return { kind: "env_transient", rule: "verifier_env_network_signature", action: "none" };
  }

  return { kind: "quality", rule: "quality_fallback", action: "rework" };
}

/**
 * 一次失败回报里的 provider 成因候选(形状判读,见 `error-class.ts`)。
 *
 * 返回 null = 档位为 off(整条判据当不存在)或形状不认识。
 * 档位为 shadow 时照样返回候选 —— 攒样本要的就是它,只是调用方拿它记事件、不拿它改路由。
 */
export function providerInfraCandidate(
  args: AttemptFailureSignals,
): { is_infra: boolean; error_class: ErrorClass } | null {
  if (args.role !== "writer" || args.infra_mode === undefined || args.infra_mode === "off") {
    return null;
  }
  const verdict = classifyProviderError({
    result_text: args.result_text,
    exit_code: args.exit_code,
  });
  // error_class=null 就是「形状不认识」:不产出候选,而不是产出一个 is_infra=false 的空因。
  return verdict.error_class === null
    ? null
    : { is_infra: verdict.is_infra, error_class: verdict.error_class };
}

/**
 * 环境类网络失败的充分条件:补丁能重放(apply 成功)而验证命令失败,且失败输出带
 * 依赖安装阶段的网络签名。
 *
 * `apply.exit_code === 0` 这一条是关键约束:补丁应用不上就是候选与冻结基线冲突
 * (M8 之后不存在「世界移动了」这个解释,§13.13),那是实打实的质量事实,任何网络
 * 错误文本都改不了它的性质。
 */
function isEnvNetworkFailure(report: VerifyReportSignals | null | undefined): boolean {
  if (!report) return false;
  if (report.apply.exit_code !== 0) return false;
  const verify = report.verify;
  if (!verify || verify.exit_code === 0) return false;
  return ENV_NETWORK_SIGNATURES.some((sig) => sig.test(verify.stderr_tail));
}
