/**
 * qwen-code CLI 退出码裁决器 —— 把「这次运行到底算不算失败」从调用点的内联正则里搬出来。
 *
 * 要治的病(c15 三次俱毁):qwen CLI 遇到 API 错误**仍以 exit 0 返回**,把错误嵌进末条
 * `type=result` 事件的 `result` 文本。`collectQwenAttempt` 因此在内联判断里用**子串**匹配
 * 错误形状,命中即把 0 上翻为 11。这个「包含即失败」的假设被打穿的方式很体面:c15 的规格
 * **要求** writer 在总结里讨论这些错误形状,于是 `is_error=false` 的成功文本里出现了指名
 * 字样 → exit 0 被改写成 11 → 补丁导出被跳过(11 不是预算类退出码,§7.2.1 那张表)→
 * 三次完整工作全部作废。
 *
 * 判据的核心不是「认哪些词」,而是**整串 vs 包含**。真正的 CLI 错误,它的 result 文本
 * **整个就是**那条错误;成功的总结里,同样的字样只是被引用的一段散文。所以词的集合照旧,
 * 匹配的位置必须收紧到整串 —— 删词会把 c10b 那批真失败也一起放掉。
 *
 * 纯函数:不读 env、不碰沙箱、不解析 JSONL(取末行是接线点的事),输入全部由调用方注入。
 * 于是「哪条输入落哪个码」可以整表穷举,不必为一次裁决起一个容器。
 */

/**
 * API 错误上翻后的退出码。与 c10b 时代一致,刻意不改:路由侧把它当非预算类失败
 * (不导差量),换码等于悄悄改路由语义。
 */
export const EXIT_CLI_API_ERROR = 11;

/** 终态不可知(轮询到期没拿到退出码)时的码。不是失败,也不是成功 —— 不猜。 */
export const EXIT_UNKNOWN_NATIVE = -1;

/**
 * 末条 result 事件的**整串**形状。两类:
 * - `[API Error: ...]`:人读的方括号包壳,内部不再出现 `]`(所以「方括号开头 + 整串」);
 * - 裸机器码:整串就是一个 token —— `AccessDenied.<子码>` 家族(子码不固定,故按前缀认)
 *   或三个定长码之一。**要求整串无空白**,是因为「裸」才是机器码的形状:
 *   `AccessDenied. 这句是人写的散文` 不是错误本身,而是一份成功总结完全可能以它为头。
 */
const CLI_ERROR_SHAPE =
  /^\[API Error:[^\]]*\]$|^(?:AccessDenied\.[^\s]*|model_not_found|upstream_error|insufficient_quota)$/;

/** 裁决的输入:一次 CLI 运行的终态事实。 */
export interface CliExitFacts {
  /** 进程自己交回的退出码;`null` = 没拿到(到期被杀且无终态回报)。 */
  nativeExit: number | null;
  /** 末条 `type=result` 事件的 `is_error`;没有该事件/没有该字段时留空。 */
  isError?: boolean;
  /** 末条 `type=result` 事件的 `result` 文本。 */
  resultText?: string;
}

/** result 文本**整串**(去首尾空白)就是一条 CLI 错误。包含不算。 */
export function isCliErrorShape(resultText: string | undefined): boolean {
  const text = resultText?.trim() ?? "";
  return text !== "" && CLI_ERROR_SHAPE.test(text);
}

/**
 * 裁决顺序,一条不乱:
 *
 * 1. `nativeExit === null` → `EXIT_UNKNOWN_NATIVE`。终态未知时不做任何形状判读:
 *    进程可能死在写一半的时刻,那一刻的 result 文本说明不了成败。
 * 2. `nativeExit !== 0` → **原样返回**。进程自己喊了失败,平台不重新裁决成成功,
 *    也不改写它的码(预算类的 55/53 尤其要原封,见 §7.2.1 的路由不换轨)。
 * 3. `isError === true` → {@link EXIT_CLI_API_ERROR}。CLI 自己承认失败,不需要再看文本。
 * 4. `resultText` 整串命中错误形状 → {@link EXIT_CLI_API_ERROR}。这一步**与 `isError`
 *    是否在场、是真是假无关**:c10b 那批真失败就是 `exit 0` + CLI 没置 `is_error` +
 *    result 整串是错误 —— 让 `isError === false` 免疫,等于把这一批重新放成成功。
 *    `isError` 缺失时同样走这一步。
 * 5. 其余 → 0。成功文本里**引用**错误形状是 writer 的正当工作,不是失败。
 */
export function adjudicateCliExit(facts: CliExitFacts): number {
  if (facts.nativeExit === null) return EXIT_UNKNOWN_NATIVE;
  if (facts.nativeExit !== 0) return facts.nativeExit;
  if (facts.isError === true) return EXIT_CLI_API_ERROR;
  if (isCliErrorShape(facts.resultText)) return EXIT_CLI_API_ERROR;
  return 0;
}
