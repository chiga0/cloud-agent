/**
 * 2026-09-03 事故标本(task daa8dd44-7a94-43b5-8b49-5cea27e0c050,base f8885c8)。
 *
 * 三个 writer attempt 全部以这条 result 文本终态:`is_error:false`(CLI 把 API 错误当
 * **成功结果**回报),终态退出码 11 由 `adjudicateCliExit` 上翻得出,而控制面当时只看到
 * 「终态非 0」→ 当质量失败返工 ×3 → attempts 耗尽 BLOCKED。
 * 根因:token-plan 端点对该模型的购买资格失效(403 AccessDenied.Unpurchased)。
 *
 * 文本按逐字标本收录:长度 95 是取证事实,故在测试里钉住 —— 改一个字符就不再是标本。
 */
export const PROVIDER_403_RESULT_TEXT =
  "[API Error: 403 Access to model denied. Please make sure you are eligible for using the model.]";

/** 取证事实:attempt-1 的 result 文本 95 字符。 */
export const PROVIDER_403_RESULT_LEN = 95;

/** 同一根因的裸机器码形态(attempt 2/3 首调即死,total_tokens=0)。 */
export const PROVIDER_ACCESS_DENIED_BARE = "AccessDenied.Unpurchased";

/** 反例基线:一份**真的**质量失败总结,里面提到 API 错误字样也不该分流。 */
export const QUALITY_RESULT_TEXT =
  "已完成改动,但 npm test 有 2 条断言失败:expected resolve('a') 实际 reject(Error('boom'))。" +
  "上一轮报的 ECONNRESET 我已修,这次是断言本身的缺陷。";
