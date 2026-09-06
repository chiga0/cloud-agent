/**
 * API 客户端(w2b 数据层的唯一入口)。
 *
 * 三条规矩,每条都对应一种「以前只能靠浏览器控制台发现」的故障:
 *
 * 1. **每次响应都过 zod**。前端的类型是「声称」,schema 才是「检查过」。二者不同时成立
 *    的那一刻,组件拿到的是 undefined 而类型写的是 string —— 表现是某个格子里空空如也,
 *    或者整页白屏,而归因通常会去找后端。§7 的不变量是「前端是投影」:投影的前提是
 *    读得懂被投影的东西,读不懂必须出声,不能猜。
 * 2. **失败面只有四种**(`ApiFailure.kind`)。UI 要按这四种分别处置(只有 `unauthorized`
 *    跳登录、只有 `unauthorized` 与 `http` 可以说「服务端答了」),所以它们在客户端就被
 *    分好类,而不是把 status 扔给每个组件各自 `=== 401`。
 * 3. **介质检查先于解析**:`content-type` 不是 JSON 就是 `shape` 失败,绝不 attempt parse。
 *    这正是 §7 头号风险的现形方式 —— `run_worker_first` 漏一条,`/api/*` 会返回
 *    200 + index.html(HTML 里没有 `{"error"...}`),把它当「未鉴权」就会在源配错时把
 *    用户踢进登录死循环;当「形状不符」才说得出人话。
 *
 * 不注入 token、不存 cookie:凭据唯一来源是同源会话 cookie(`credentials: "same-origin"`),
 * 与 docs/product.md §3 一致 —— Bearer 那条路是给 land.mjs 与 curl 的,浏览器不该碰。
 */

import type { ZodType } from "zod";

/** 与 `src/index.ts` 的门同一条判据:没过门就是 401,没有第二种码。 */
export const UNAUTHORIZED_STATUS = 401;

export type ApiFailure =
  | { readonly kind: "unauthorized"; readonly status: number }
  /** 服务端答了,但不是 2xx(含 400/403/404/5xx)。`errorType` 是 `{error:{type}}` 里的 type,可能取不到。 */
  | { readonly kind: "http"; readonly status: number; readonly errorType: string | null }
  /** 请求根本没发出去/没回来(DNS、拒连、离线、CORS 之外的一切网络类)。 */
  | { readonly kind: "network" }
  /** 答了 2xx 但不是可读的形状:介质不是 JSON,或 JSON 与 schema 不符。 */
  | { readonly kind: "shape"; readonly status: number; readonly detail: string };

/** 失败种类的展示顺序唯一决定于这里,新增一支必须同时新增文案(见 copy.ts)。 */
export const API_FAILURE_KINDS = ["unauthorized", "http", "network", "shape"] as const;
export type ApiFailureKind = (typeof API_FAILURE_KINDS)[number];

/**
 * 唯一被允许向上抛的 API 异常。`message` 是**给日志看的**(含路径与 kind,便于贴进工单),
 * 不是给用户看的 —— 用户可见文案一律由各页面按 `failure.kind` 现取,理由见 copy.ts。
 */
export class ApiError extends Error {
  readonly failure: ApiFailure;

  constructor(failure: ApiFailure, path: string) {
    super(`${apiMessage(failure)} (${failurePath(failure, path)})`);
    this.name = "ApiError";
    this.failure = failure;
  }

  get kind(): ApiFailureKind {
    return this.failure.kind;
  }
}

function apiMessage(failure: ApiFailure): string {
  switch (failure.kind) {
    case "unauthorized":
      return "unauthorized";
    case "http":
      return `http_${failure.errorType ?? failure.status}`;
    case "network":
      return "network_error";
    case "shape":
      return `shape_error_${failure.status}`;
  }
}

/**
 * 日志里最该出现的一件事:哪条路径。`shape` 失败时把 detail 也带上(它说得出「是 HTML
 * 还是 JSON 不合 schema」,这两种的修法完全不同)。路径不带 query 之外的敏感值:
 * 这里出现的只有端点形状,token 恒在请求体里,不在 URL 上。
 */
function failurePath(failure: ApiFailure, path: string): string {
  return failure.kind === "shape" ? `${path} —— ${failure.detail}` : path;
}

/** 从错误里取 kind(非 ApiError 一律 null):各页面的分支判定都经这一个口子。 */
export function apiFailureKind(err: unknown): ApiFailureKind | null {
  return err instanceof ApiError ? err.kind : null;
}

export function isUnauthorized(err: unknown): boolean {
  return apiFailureKind(err) === "unauthorized";
}

/** 响应体里的 `{error:{type}}`:取不到不是错(404/5xx 常带空 body 或纯文本),取到就用。 */
async function readErrorType(res: Response): Promise<string | null> {
  if (!isJsonMedia(res.headers.get("content-type"))) return null;
  try {
    const body = (await res.json()) as { error?: { type?: unknown } };
    const type = body.error?.type;
    return typeof type === "string" && type.length > 0 ? type : null;
  } catch {
    return null;
  }
}

function isJsonMedia(contentType: string | null): boolean {
  return (contentType ?? "").toLowerCase().includes("application/json");
}

export interface ApiRequestInit {
  method?: string;
  /** 会被 JSON.stringify 后进请求体。 */
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * 一次 API 调用。泛型参数就是响应契约:先按 schema 校验,再把**校验过的值**交出去。
 * 抛错只有 ApiError 一种形状(网络层异常在内部就地转换),调用方不需要 try/catch TypeError。
 */
export async function apiRequest<T>(
  path: string,
  schema: ZodType<T>,
  init: ApiRequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  let body: string | undefined;
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }

  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? "GET",
      headers,
      body,
      signal: init.signal,
      // 显式写出而不是吃缺省值:整个前端的鉴权就挂在这条 cookie 上,而「缺省本来就是这样」
      // 读代码时看不出来 —— 这一行就是同源会话方案的落地点。
      credentials: "same-origin",
    });
  } catch (err) {
    // fetch 只在不返回任何响应时抛(TypeError)。AbortController 取消也走这里:
    // 它不是故障,但也确实「没有形状可读」,归进 network 并保留原 reason 供日志。
    if (isAbort(err)) throw err;
    throw new ApiError({ kind: "network" }, path);
  }

  if (res.status === UNAUTHORIZED_STATUS) {
    await drain(res);
    throw new ApiError({ kind: "unauthorized", status: res.status }, path);
  }
  if (!res.ok) {
    const errorType = await readErrorType(res);
    throw new ApiError({ kind: "http", status: res.status, errorType }, path);
  }
  if (!isJsonMedia(res.headers.get("content-type"))) {
    await drain(res);
    throw new ApiError(
      {
        kind: "shape",
        status: res.status,
        detail: `期望 application/json,实际 ${res.headers.get("content-type") ?? "无 content-type"}`,
      },
      path,
    );
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new ApiError({ kind: "shape", status: res.status, detail: "响应体不是合法 JSON" }, path);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiError(
      { kind: "shape", status: res.status, detail: `响应与 schema 不符(${issueSummary(parsed.error)})` },
      path,
    );
  }
  return parsed.data;
}

export function apiGet<T>(path: string, schema: ZodType<T>, signal?: AbortSignal): Promise<T> {
  return apiRequest(path, schema, { method: "GET", signal });
}

export function apiPost<T>(
  path: string,
  schema: ZodType<T>,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return apiRequest(path, schema, { method: "POST", body, signal });
}

/** 非 2xx 的 body 也得读完:留着未读的流在 workerd/浏览器里都是一个未释放的连接。 */
async function drain(res: Response): Promise<void> {
  try {
    await res.arrayBuffer();
  } catch {
    // 读不出来不影响判定(status 已经说明了一切)。
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/** zod 的 issue 摘要:只取前两处路径 + 一句话原因,够定位且不塞进整条 schema 文本。 */
function issueSummary(err: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string {
  return err.issues
    .slice(0, 2)
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}
