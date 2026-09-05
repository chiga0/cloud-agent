/**
 * 失败成因词表(§13.23)—— **只有一份**:writer 的 provider 回报与 reviewer 的一次 chat
 * 调用共用下面这个 `ErrorClass` 枚举。
 *
 * 为什么要专门立一份共享词表:2026-09-03 标本(task daa8dd44)里三个 writer attempt 全部
 * exit_code=11,控制面把它当成候选质量失败 → `outcome_kind=quality / rule=quality_fallback
 * / action=rework` → 三次全烧成返工,最后 attempts 耗尽 BLOCKED。而 attempt-1 的 transcript
 * 显示前 16 轮完全健康、第 17 轮起模型 API 回 403,终态 result 文本整串就是
 * `[API Error: 403 Access to model denied. Please make sure you are eligible for using the model.]`
 * (95 字符,`is_error:false` —— CLI 把 API 错误当**成功结果**回报)。根因是 token-plan 端点
 * 对该模型的购买资格失效(403 AccessDenied.Unpurchased):重开沙箱、原规格重做,拿到的是
 * 同一个 403。返工在这里是纯浪费,而它烧掉的正是 `DEFAULT_MAX_ATTEMPTS` 的全部额度。
 *
 * 与 reviewer 侧的关系:`src/exec/review.ts` 的 `runReviewLLM` 有三个 `return { exitCode: 12 }`
 * 位点(传输失败/超时、非 2xx、响应体解析不了),三件事共用一个码,处置却完全不同 ——
 * 它不烧返工(reviewer 的 exit!=0 走 `verdict=none` → `review.unavailable` → `holdForHuman`),
 * 而是把任务钉在人工闸门上,且 reason 里只有 `exit_code=12`,看不出该改上限还是端点挂了。
 * 两侧是**同一个问题的两个读面**,所以成因必须同名。
 *
 * 判据口径:纯函数、按**形状**不按数值。
 * - 不读 `exit_code` 的数值:11 只是本轮观察到的、由 `adjudicateCliExit` 上翻出来的产物,
 *   换码/改上翻规则都会让判据静默失效;而且 `is_error:false` 意味着「CLI 说成功」这件事
 *   本身就不可信 —— 能信的只有文本形状。
 * - **整串匹配**而非包含:与 `src/exec/cli-exit.ts` 同一理由(被删空的那个假设是「包含即
 *   失败」—— 一份讨论 API 错误的成功总结完全可能引用这些字样)。`test/routing-error-class.test.ts`
 *   有一条锁步断言钉住两张形状表不漂移。
 * - 漏报可以(落 unknown → 走既有 quality 返工),误报不行:把质量失败判成 infra 会吞掉
 *   本来该返工的轮次。所以瞬态成因(`upstream_error`)一律 `is_infra:false`。
 */

/**
 * 全部成因。新增成员必须同时回答两件事:它是不是「重开沙箱原规格重做必然复现」,
 * 以及它的形状锚点是什么 —— 答不出锚点的不要往这里加。
 *
 * `upstream_timeout` 与 `bad_response_body` 是 reviewer 三个位点带来的两个成员;
 * 其余三个 `provider_*` 与 `upstream_error` 是 writer 侧 result 文本的形状家族
 * (也是 reviewer 非 2xx 分支的落点)。
 */
export const ERROR_CLASSES = [
  "provider_access_denied",
  "provider_quota_exhausted",
  "provider_model_unavailable",
  "upstream_error",
  "upstream_timeout",
  "bad_response_body",
] as const;

export type ErrorClass = (typeof ERROR_CLASSES)[number];

export function isErrorClass(v: unknown): v is ErrorClass {
  return typeof v === "string" && (ERROR_CLASSES as readonly string[]).includes(v);
}

/**
 * 「重开一个沙箱原规格重做,结果会不会不一样」答案为「不会」的成因。
 *
 * `upstream_error` 刻意**不在**其中:5xx / 未知状态码 / CLI 裸 `[API Error: ...]` 无状态码
 * 这些形态里有一部分是瞬态的,把瞬态判成确定性 = enforce 模式下把一次本可返工成功的任务
 * 停成 BLOCKED。宁可漏报(走老路返工),不可误报。
 */
const DETERMINISTIC_INFRA: ReadonlySet<ErrorClass> = new Set([
  "provider_access_denied",
  "provider_quota_exhausted",
  "provider_model_unavailable",
  "upstream_timeout",
  "bad_response_body",
]);

/** 分类器输入。`exit_code` 只随事件带上供人对照,**判据一处都不读它**(见文件头)。 */
export interface ProviderErrorSignals {
  result_text?: string | null;
  exit_code?: number;
}

export interface ProviderErrorVerdict {
  is_infra: boolean;
  /** null = 形状不认识(unknown)。unknown 一律 `is_infra:false`,交回既有 quality 路径。 */
  error_class: ErrorClass | null;
}

const NOT_INFRA: ProviderErrorVerdict = { is_infra: false, error_class: null };

/**
 * qwen CLI 的人读包壳:整串 `[API Error: <状态码> <说明>]`,内部不再出现 `]`。
 * 状态码可选 —— CLI 也回过 `[API Error: fetch failed]` 这种无码形态。
 *
 * `(?![\d])` 是必要的:少了它 `4033` 会被读成 `403` + 余文,于是把「状态码读不出」
 * 误判成「读出了 403」—— 判据的错误来源必须落成 unknown/瞬态,而不是一个成因。
 */
const API_ERROR_WRAP = /^\[API Error:(?:\s*(\d{3})(?![\d]))?([^\]]*)\]$/;

/**
 * CLI 原样吐出的裸机器码(整串无空白才算「裸」,理由同 cli-exit.ts)。
 * `AccessDenied.<子码>` 子码不固定(本次事故是 `.Unpurchased`),按前缀单独判。
 */
const BARE_ACCESS_DENIED = /^AccessDenied\.[^\s]*$/;
const BARE_MACHINE_CODES: Readonly<Record<string, ErrorClass>> = {
  model_not_found: "provider_model_unavailable",
  insufficient_quota: "provider_quota_exhausted",
  upstream_error: "upstream_error",
};

/**
 * HTTP 状态码 → 成因。**两侧共用这一张表**:writer 从 result 包壳里的数字读,
 * reviewer 从 `resp.status` 读 —— 同一个 403 在两个读面上必须是同一个名字。
 *
 * 只有资格/额度/模型不存在这三类是确定性的;其余(含 5xx、400、未知 4xx)落
 * `upstream_error`,瞬态,不主张 infra。
 */
export function errorClassFromHttpStatus(status: number): ErrorClass {
  if (status === 401 || status === 403) return "provider_access_denied";
  if (status === 404) return "provider_model_unavailable";
  if (status === 429) return "provider_quota_exhausted";
  return "upstream_error";
}

function verdict(errorClass: ErrorClass): ProviderErrorVerdict {
  return { is_infra: DETERMINISTIC_INFRA.has(errorClass), error_class: errorClass };
}

/**
 * 一次**失败**的回报文本 → 成因。纯函数,不读 env、不碰事件。
 *
 * 三条通道,全部要求**整串**匹配(去首尾空白后):
 * 1. `[API Error: <码> …]` 包壳 → 按码分流(无码 → `upstream_error`);
 * 2. 裸 `AccessDenied.*` → `provider_access_denied`;
 * 3. 裸定长机器码 → 查表。
 * 形状不符返回 `{is_infra:false, error_class:null}`:不猜,交回 quality 兜底。
 */
export function classifyProviderError(args: ProviderErrorSignals): ProviderErrorVerdict {
  const text = (args.result_text ?? "").trim();
  if (text === "") return NOT_INFRA;

  const wrapped = API_ERROR_WRAP.exec(text);
  if (wrapped) {
    const status = wrapped[1] === undefined ? null : Number(wrapped[1]);
    // 无状态码的包壳只能说明「CLI 认为这是一次 API 错误」,说明不了它是否确定性。
    if (status === null) return verdict("upstream_error");
    return verdict(errorClassFromHttpStatus(status));
  }

  if (BARE_ACCESS_DENIED.test(text)) return verdict("provider_access_denied");
  const bare = BARE_MACHINE_CODES[text];
  if (bare) return verdict(bare);

  return NOT_INFRA;
}
