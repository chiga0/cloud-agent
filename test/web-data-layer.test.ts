import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  apiFailureKind,
  apiGet,
  apiPost,
  isUnauthorized,
  UNAUTHORIZED_STATUS,
} from "../web/src/lib/api";
import {
  HOME_PATH,
  LOGIN_EMPTY_TOKEN_TEXT,
  LOGIN_FAILURE_TEXT,
  isInternalNextPath,
  isUsableToken,
  loginFailureCopy,
  loginTargetPath,
  probeSession,
  probeSessionFromError,
  sessionIndicator,
} from "../web/src/lib/auth";
import {
  archivedTasksSchema,
  loginResultSchema,
  loginSearchSchema,
  parseSearch,
  sessionSchema,
  streamEndSchema,
  streamEventSchema,
} from "../web/src/lib/schema";
import { awaitingBadgeLabel, AWAITING_APPROVAL_LIMIT } from "../web/src/lib/queries";
import { durationLabel, stateTone, textOf, totalTokensOf } from "../web/src/lib/view";

/**
 * 数据层与登录/会话判定(w2b 交付 ①②③里「钉得住」的那一半)。
 *
 * 这个文件是**浏览器外**能钉住的极限:测试跑在 Workers 运行时里(没有 DOM、没有 jsdom),
 * 所以凡是被切进 `web/src/lib/*.ts` 的纯判定都在这里真跑一遍,而 `.tsx` 里剩下的接线
 * (Link 的跳转、表单的 onChange)只能靠 test/web-frontend-contract.test.ts 的源码钉子
 * 加部署后浏览器冒烟 —— 分工本身就写在这里,免得后来人以为「测试绿 = 页面没问题」。
 *
 * 为什么不 mock 组件:mock 出来的渲染只验证了 mock,而这里每一条断言对应的都是一个
 * 「曾经只能在生产里发现」的故障形状(401 与网络错混成一个文案、`?next=` 指向外站、
 * API 被 SPA 兜底吞成 HTML 时前端把它当未登录)。
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 最近一次 fetch 的调用参数(自己记账,而不是伸手去摸 vi 的 mock 内部结构)。 */
const fetchCalls: Array<{ input: unknown; init: RequestInit }> = [];

/** 造一个 API 答复。`json` 走真实的 content-type 与 body,不给客户端留「假响应」的捷径。 */
function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(response: Response): void {
  fetchCalls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init: RequestInit) => {
      fetchCalls.push({ input, init });
      return response;
    }),
  );
}

function fetchCall(): { input: unknown; init: RequestInit } | null {
  return fetchCalls.length === 0 ? null : fetchCalls[0]!;
}

describe("API 客户端:失败面只有四种", () => {
  it("200 + 合法 JSON → 返回校验过的数据", async () => {
    stubFetch(jsonResponse({ authenticated: true, credential: "cookie", expires_at: null }));
    const session = await apiGet("/api/session/me", sessionSchema);
    expect(session.credential).toBe("cookie");
  });

  it("401 → unauthorized,且这是唯一的跳登录判据", async () => {
    stubFetch(jsonResponse({ error: { type: "unauthorized" } }, UNAUTHORIZED_STATUS));
    const err = await apiGet("/api/session/me", sessionSchema).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(apiFailureKind(err)).toBe("unauthorized");
    expect(isUnauthorized(err)).toBe(true);
  });

  it("500/403/404 → http,并带上服务端的 error.type", async () => {
    stubFetch(jsonResponse({ error: { type: "invalid_origin" } }, 403));
    const err = await apiGet("/api/admin/tasks", archivedTasksSchema).catch((e: unknown) => e);
    expect(apiFailureKind(err)).toBe("http");
    expect((err as ApiError).failure).toMatchObject({ status: 403, errorType: "invalid_origin" });
    expect(isUnauthorized(err)).toBe(false);
  });

  it("fetch 抛错(离线/拒连)→ network", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const err = await apiGet("/api/admin/tasks", archivedTasksSchema).catch((e: unknown) => e);
    expect(apiFailureKind(err)).toBe("network");
    expect(isUnauthorized(err)).toBe(false);
  });

  /**
   * §7 头号风险的前端一侧:`run_worker_first` 漏列 `/api/*` 时,API 会拿到
   * **200 + index.html**。这一条必须归 `shape` 而不是 `unauthorized`——
   * 把它当未登录,用户就会在源配错时反复被踢回登录页(而 token 是对的),
   * 故障现场从「一条配置」伪装成「会话有问题」,是最难归因的那一类。
   */
  it("200 + HTML(SPA 兜底吞掉 API)→ shape,绝不判成未登录", async () => {
    stubFetch(
      new Response("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    const err = await apiGet("/api/session/me", sessionSchema).catch((e: unknown) => e);
    expect(apiFailureKind(err)).toBe("shape");
    expect(isUnauthorized(err)).toBe(false);
    expect((err as ApiError).message).toContain("text/html");
  });

  it("200 + JSON 但与 schema 不符 → shape,并给出可定位的 issue", async () => {
    stubFetch(jsonResponse({ authenticated: true })); // 少了 credential / expires_at
    const err = await apiGet("/api/session/me", sessionSchema).catch((e: unknown) => e);
    expect(apiFailureKind(err)).toBe("shape");
    expect((err as ApiError).message).toMatch(/credential/);
  });

  it("非 2xx 且 body 不是 JSON 也不抛第二次错(http 分类照常成立)", async () => {
    stubFetch(new Response("gateway timeout", { status: 504 }));
    const err = await apiGet("/api/admin/tasks", archivedTasksSchema).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).failure).toMatchObject({ kind: "http", status: 504, errorType: null });
  });

  it("凭据只走同源 cookie:credentials=same-origin,且绝不注入 Authorization 头", async () => {
    stubFetch(jsonResponse({ ok: true }));
    await apiPost("/api/session/login", loginResultSchema, { token: "t" });
    const call = fetchCall();
    expect(call).not.toBeNull();
    expect(call!.init.credentials).toBe("same-origin");
    const headers = new Headers(call!.init.headers as HeadersInit);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.get("content-type")).toBe("application/json");
    expect(call!.input).toBe("/api/session/login");
  });

  it("POST 的 body 是 JSON 串,token 不出现在 URL 上", async () => {
    stubFetch(jsonResponse({ ok: true }));
    await apiPost("/api/session/login", loginResultSchema, { token: "sekret" });
    const call = fetchCall();
    expect(String(call!.input)).not.toContain("sekret");
    expect(call!.init.body).toContain("sekret");
    expect(call!.init.method).toBe("POST");
  });
});

describe("search 参数校验", () => {
  it("合法 next 原样通过", () => {
    expect(parseSearch(loginSearchSchema, { next: "/approvals" })).toEqual({ next: "/approvals" });
  });

  it("非法/多余输入退回空对象(= 全缺省),绝不抛", () => {
    expect(parseSearch(loginSearchSchema, null)).toEqual({});
    expect(parseSearch(loginSearchSchema, "not-an-object")).toEqual({});
    expect(parseSearch(loginSearchSchema, { evil: { nested: true } })).toEqual({});
  });

  it("URLSearchParams 也是合法输入(路由外的调用点)", () => {
    const params = new URLSearchParams("next=/audit");
    expect(parseSearch(loginSearchSchema, params)).toEqual({ next: "/audit" });
  });
});

describe("?next= 白名单:登录页不做开放重定向", () => {
  it("站内路径全部放行", () => {
    for (const path of [
      "/",
      "/approvals",
      "/audit",
      `/tasks/${crypto.randomUUID()}`,
    ]) {
      expect(isInternalNextPath(path), path).toBe(true);
    }
  });

  /** 每一条都是一个真实绕法,不是假想的畸形输入。 */
  it("外站、协议相对、伪协议、未知形状全部拒绝", () => {
    for (const path of [
      "https://evil.example/",
      "//evil.example/",
      "/\\evil.example",
      "javascript:alert(1)",
      "/login?next=/login",
      "/tasks/not-a-uuid",
      "",
      "/..%2f..%2f",
      "approvals",
    ]) {
      expect(isInternalNextPath(path), path).toBe(false);
    }
  });

  it("非法 next 一律退回首页,而不是照抄输入", () => {
    expect(loginTargetPath({ next: "//evil.example/" })).toBe(HOME_PATH);
    expect(loginTargetPath({ next: undefined })).toBe(HOME_PATH);
    expect(loginTargetPath({})).toBe(HOME_PATH);
    expect(loginTargetPath({ next: "/approvals" })).toBe("/approvals");
  });
});

describe("会话判定:只有 401 才叫没登录", () => {
  it("探测成功 → authenticated", async () => {
    expect(await probeSession(async () => ({}))).toEqual({ status: "authenticated" });
  });

  it("401 → unauthenticated", async () => {
    const probe = await probeSession(async () => {
      throw new ApiError({ kind: "unauthorized", status: 401 }, "/api/session/me");
    });
    expect(probe).toEqual({ status: "unauthenticated" });
  });

  for (const kind of ["network", "shape", "http"] as const) {
    it(`${kind} → unreachable(不是「未登录」,不能据此跳登录页)`, async () => {
      const failure =
        kind === "http"
          ? ({ kind, status: 500, errorType: null } as const)
          : kind === "shape"
            ? ({ kind, status: 200, detail: "x" } as const)
            : ({ kind } as const);
      const probe = await probeSession(async () => {
        throw new ApiError(failure, "/api/session/me");
      });
      expect(probe).toEqual({ status: "unreachable", reason: kind });
    });
  }

  it("非 ApiError 的意外异常同样是 unreachable(不能让它冒出去变白屏)", async () => {
    const probe = await probeSession(async () => {
      throw new Error("bug");
    });
    expect(probe).toEqual({ status: "unreachable", reason: "unknown" });
  });

  it("同步版与异步版对同一个错误给同一个结论(guard 与壳上状态位不许各判一次)", () => {
    const err = new ApiError({ kind: "unauthorized", status: 401 }, "/api/session/me");
    expect(probeSessionFromError(err)).toEqual({ status: "unauthenticated" });
    const other = new ApiError({ kind: "network" }, "/api/session/me");
    expect(probeSessionFromError(other)).toEqual({ status: "unreachable", reason: "network" });
    expect(probeSessionFromError(new Error("x")).status).toBe("unreachable");
  });
});

describe("/login 的失败文案:不区分 token 错与网络错", () => {
  it("四种失败种类 + 非 API 异常,六条路径逐字同一句", () => {
    const cases: unknown[] = [
      new ApiError({ kind: "unauthorized", status: 401 }, "/api/session/login"), // token 错
      new ApiError({ kind: "http", status: 500, errorType: null }, "/api/session/login"),
      new ApiError({ kind: "network" }, "/api/session/login"), // 请求没出去
      new ApiError({ kind: "shape", status: 200, detail: "text/html" }, "/api/session/login"),
      new Error("意外的 bug"),
      "字符串异常",
    ];
    for (const err of cases) {
      expect(loginFailureCopy(err)).toBe(LOGIN_FAILURE_TEXT);
    }
  });

  it("文案本身不含服务端形状的细节(不含 status、不含 kind 名)", () => {
    expect(LOGIN_FAILURE_TEXT).not.toMatch(/\d{3}/);
    for (const leak of ["unauthorized", "network", "shape", "http"]) {
      expect(LOGIN_FAILURE_TEXT.toLowerCase(), leak).not.toContain(leak);
    }
  });

  it("空 token 是输入错误,有独立文案且不发请求", () => {
    expect(isUsableToken("")).toBe(false);
    expect(isUsableToken("   \n\t ")).toBe(false);
    expect(isUsableToken(" t ")).toBe(true);
    expect(LOGIN_EMPTY_TOKEN_TEXT).not.toBe(LOGIN_FAILURE_TEXT);
  });
});

describe("会话状态位", () => {
  const NOW = Date.parse("2026-09-06T12:00:00.000Z");
  const iso = (offsetSec: number) => new Date(NOW + offsetSec * 1000).toISOString();

  it("探测中 → 会话校验中(中性色)", () => {
    expect(sessionIndicator({ status: "authenticated" }, true, null, NOW)).toEqual({
      text: "会话校验中",
      tone: "",
    });
  });

  it("unreachable 显示为 err 且带上失败种类(与「未登录」分得开)", () => {
    const view = sessionIndicator(
      { status: "unreachable", reason: "network" },
      false,
      null,
      NOW,
    );
    expect(view.tone).toBe("err");
    expect(view.text).toContain("network");
    expect(view.text).not.toContain("未登录");
  });

  it("未登录 → 未登录", () => {
    expect(sessionIndicator({ status: "unauthenticated" }, false, null, NOW)).toMatchObject({
      tone: "err",
    });
  });

  it("剩余时长按档位取色:>5min 正常、<5min warn、已过 err", () => {
    expect(sessionIndicator({ status: "authenticated" }, false, iso(6 * 3600), NOW)).toMatchObject(
      { tone: "ok" },
    );
    expect(sessionIndicator({ status: "authenticated" }, false, iso(240), NOW)).toMatchObject({
      tone: "warn",
    });
    expect(sessionIndicator({ status: "authenticated" }, false, iso(-10), NOW)).toMatchObject({
      tone: "err",
    });
  });

  it("Bearer 会话(服务端不报过期)只显示「会话有效」,不编一个剩余时长", () => {
    const view = sessionIndicator({ status: "authenticated" }, false, null, NOW);
    expect(view.text).toBe("会话有效");
    expect(view.tone).toBe("ok");
  });

  it("无法解析的时间串同样退回「会话有效」而不是 NaN", () => {
    const view = sessionIndicator({ status: "authenticated" }, false, "昨天", NOW);
    expect(view.text).toBe("会话有效");
    expect(view.text).not.toContain("NaN");
  });
});

describe("Approvals 角标口径", () => {
  it("未到达 → null(不显示),0 条 → 也不显示", () => {
    expect(awaitingBadgeLabel(undefined)).toBeNull();
    expect(awaitingBadgeLabel({ tasks: [], count: 0 })).toBeNull();
  });

  it("1 条显示 1;达到 limit 显示「200+」而不是假装是总数", () => {
    expect(awaitingBadgeLabel({ tasks: [], count: 1 })).toBe("1");
    expect(awaitingBadgeLabel({ tasks: [], count: AWAITING_APPROVAL_LIMIT - 1 })).toBe("199");
    expect(awaitingBadgeLabel({ tasks: [], count: AWAITING_APPROVAL_LIMIT })).toBe("200+");
    expect(awaitingBadgeLabel({ tasks: [], count: 999 })).toBe("200+");
  });

  it("limit 就是服务端 /api/admin/tasks 的上限 200(超了服务端直接 400)", () => {
    expect(AWAITING_APPROVAL_LIMIT).toBe(200);
  });
});

describe("展示层纯函数(payload 的异构字段)", () => {
  it("读不到的字段一律退回空值,不抛(未知 kind 的帧也必须渲染得掉)", () => {
    for (const payload of [null, undefined, 42, "str", [], { text: 1 }, { usage: "x" }]) {
      expect(() => textOf(payload)).not.toThrow();
      expect(textOf(payload)).toBe("");
      expect(totalTokensOf(payload)).toBeNull();
    }
  });

  it("usage.total_tokens 只在是有限数值时才算数(字符串数字不算)", () => {
    expect(totalTokensOf({ usage: { total_tokens: 1234 } })).toBe(1234);
    expect(totalTokensOf({ usage: { total_tokens: "1234" } })).toBeNull();
    expect(totalTokensOf({ usage: { total_tokens: Number.NaN } })).toBeNull();
  });

  it("时长标签:秒 / 分秒 / 时分,负数与 NaN 都当 0", () => {
    expect(durationLabel(45)).toBe("45s");
    expect(durationLabel(192)).toBe("3m12s");
    expect(durationLabel(3720)).toBe("1h02m");
    expect(durationLabel(-5)).toBe("0s");
    expect(durationLabel(Number.NaN)).toBe("0s");
  });

  it("等待人工是 warn 而不是 err(它不是故障,是「需要有人动手」)", () => {
    expect(stateTone("AWAITING_APPROVAL")).toBe("warn");
    expect(stateTone("DONE")).toBe("ok");
    expect(stateTone("BLOCKED")).toBe("err");
    expect(stateTone("RUNNING")).toBe("run");
    expect(stateTone("SOMETHING_NEW")).toBe("");
  });
});

describe("响应 schema 与后端实际形状一致(转写,不是发明)", () => {
  it("sessionSchema 接受 handleSessionMe 的三种凭据形状", () => {
    expect(
      sessionSchema.safeParse({ authenticated: true, credential: "bearer", expires_at: null })
        .success,
    ).toBe(true);
    expect(
      sessionSchema.safeParse({
        authenticated: true,
        credential: "cookie",
        expires_at: "2026-09-06T18:00:00.000Z",
      }).success,
    ).toBe(true);
    // credential 只有两种取值:出现第三种说明后端多了东西,前端必须先看见再改
    expect(
      sessionSchema.safeParse({ authenticated: true, credential: "api_key", expires_at: null })
        .success,
    ).toBe(false);
  });

  it("archivedTasksSchema 接受 handleAdminTasks 的投影行,并容忍未知 state 取值", () => {
    const parsed = archivedTasksSchema.safeParse({
      tasks: [
        {
          id: crypto.randomUUID(),
          state: "AWAITING_APPROVAL",
          created_at: "2026-09-06T10:00:00Z",
          updated_at: "2026-09-06T10:05:00Z",
          version: 3,
        },
        { state: "SOME_FUTURE_STATE" }, // 缺字段 → 整份拒,而不是给一半
      ],
      count: 2,
    });
    expect(parsed.success).toBe(false);
    const ok = archivedTasksSchema.safeParse({
      tasks: [
        {
          id: "x",
          state: "SOME_FUTURE_STATE",
          created_at: "",
          updated_at: "",
          version: 0,
        },
      ],
      count: 1,
    });
    expect(ok.success).toBe(true);
  });

  it("信封 schema 容忍 v 演进与新 kind,但 kind 必须是字符串", () => {
    expect(
      streamEventSchema.safeParse({
        v: 2,
        task_id: "t",
        attempt_id: "a",
        generation: 1,
        seq: 7,
        ts: "2026-09-06T10:00:00Z",
        kind: "assistant",
        payload: { text: "hi" },
      }).success,
    ).toBe(true);
    expect(
      streamEventSchema.safeParse({
        v: 1,
        task_id: "t",
        attempt_id: "a",
        generation: 1,
        seq: 7,
        ts: "x",
        kind: 42,
        payload: {},
      }).success,
    ).toBe(false);
    expect(
      streamEndSchema.safeParse({ v: 1, task_id: "t", events: 451, unreadable_attempts: [] })
        .success,
    ).toBe(true);
  });
});
