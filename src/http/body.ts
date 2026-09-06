/**
 * POST body 的**唯一**解析入口(c18)。
 *
 * 治的病(prod 实测,部署 c471b145):`POST /api/tasks` 与 `POST /api/tasks/:id/approve`
 * 拿到空 body 或坏 JSON 时走的是裸的 `Request#json()` 解析 —— 它抛 SyntaxError,而两个 handler
 * 都没有 try/catch,异常一路冒出 `fetch` 边界,由平台答一个 **500 error code 1101**。
 * 4/4 复现。同一件事在 `/api/session/login` 上从来不会崩(它早有降级),所以缺陷不是
 * 「平台会 500」,而是**同一个失败面在三个端点上给了三种答案**。
 *
 * 为什么是「一个共享函数 + 三处一律走它」而不是各自加 try/catch:各写一份的 try/catch
 * 只保证不崩,保证不了形状一致 —— 而形状一致才是这里的全部价值。一个入口还让
 * 「新端点漏走」成为可钉的事(见 test/body-parse-contract.test.ts)。
 *
 * 口径(三档失败,一律 4xx,绝不 5xx):
 * - `empty` —— body 一个字节也没有(或只有空白)。
 * - `malformed` —— 有字节但不是合法 JSON。读流本身失败(客户端中途断开)也算这一档:
 *   客户端拿到的仍是带类型的 400,而不是把 worker 抛穿。
 * - `not_object` —— 是合法 JSON 但不是 JSON **对象**(`"str"` / `123` / `null` / `[]`)。
 *   本项目的全部 POST 契约都是对象字面量,标量与数组不是「字段缺失」而是形态不对,
 *   让它们落到 `invalid_spec` / `invalid_decision` 这类字段级错误里会把两件不同的事
 *   混成一个类型;数组单独也算,是因为 `[]` 在 JS 里 `typeof` 就是 `"object"`。
 *
 * 刻意**不做**的:
 * - 不校验字段。本模块只回答「这份 body 能不能当成一个对象交给业务校验」,字段级的
 *   判定与错误类型(`invalid_spec` / `invalid_acceptance` / `invalid_budget` /
 *   `invalid_base_sha` / `invalid_decision` / `evidence_required`)一律留在各 handler,
 *   以免 `invalid_body` 把原有分支吞掉。
 * - 不猜 `Content-Type`。空 / 坏 JSON / 不是对象这三种失败与请求头无关,而按头分叉会多造
 *   一个可区分的失败面。
 */

/** 三档失败原因。它进 `detail`,所以必须是对客户端有行动意义的说法。 */
export type BodyFailure = "empty" | "malformed" | "not_object";

/**
 * 解析结果。判别式联合而不是 `T | null`:调用方必须**显式**处理失败分支才能拿到 body,
 * 而失败分支要映射成什么响应由调用方决定 —— `/api/tasks*` 是 400 `invalid_body`,
 * `/api/session/login` 是 401 `invalid_credentials`(它不能区分失败原因,见 product.md §3)。
 * 正因为映射留在调用方,这里不能顺手返回一个 Response。
 */
export type BodyResult<T> = { ok: true; body: T } | { ok: false; failure: BodyFailure };

const FAILURE_DETAIL: Record<BodyFailure, string> = {
  empty: "request body is empty",
  malformed: "request body is not valid JSON",
  not_object: "request body must be a JSON object",
};

/**
 * 把请求体读成一个 JSON 对象。**本函数不抛**:任何输入都得到判别式结果。
 *
 * 本模块是 src/ 里唯一直接读请求体的地方(用 `Request#text()` + `JSON.parse`,而不是裸的
 * `Request#json()`):为的是把「空 body」与「坏 JSON」分开报 —— 两种原因是两种说法,而裸解析
 * 把它们混成同一个异常。同时把唯一的抛点收在这一个 try 里。
 * 泛型 `T` 只是给调用方的字段访问用的形状名,运行时不做任何校验 —— 真校验在各 handler。
 */
export async function parseJsonBody<T>(req: Request): Promise<BodyResult<T>> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { ok: false, failure: "malformed" };
  }
  if (text.trim().length === 0) return { ok: false, failure: "empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, failure: "malformed" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, failure: "not_object" };
  }
  return { ok: true, body: parsed as T };
}

/**
 * 三档失败对外的**唯一**形状:400 + `{"error":{"type":"invalid_body","detail":…}}`。
 *
 * detail 只说形态,不说内容 —— 它不给「服务端期望什么 schema」的任何提示(字段级提示
 * 由各校验分支的 detail 给,那些端点本来就在鉴权门之后)。
 */
export function invalidBodyResponse(failure: BodyFailure): Response {
  return Response.json(
    { error: { type: "invalid_body", detail: FAILURE_DETAIL[failure] } },
    { status: 400 },
  );
}
