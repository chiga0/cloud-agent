import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate } from "@tanstack/react-router";

import { probeSessionFromError, sessionIndicator } from "../lib/auth";
import {
  awaitingApprovalQueryOptions,
  awaitingBadgeLabel,
  logoutMutationFn,
  sessionQueryOptions,
} from "../lib/queries";
import { StatusBadge } from "./StatusBadge";
import { ThemeToggle } from "./ThemeToggle";

/**
 * authed 布局壳(w2b 交付 ③):顶导航 Tasks/Approvals/Audit + Approvals 计数角标 + 会话状态位。
 *
 * 分工要说死:**跳登录在路由表的 `beforeLoad` 里,不在本组件**。本组件只管「已经站在门内
 * 之后显示什么」。把 401 处理写进组件的下一步,就是某个页面自己
 * `if (status === 401) navigate("/login")`,于是三处三份跳转逻辑,而其中一份必然忘了带 `?next=`。
 *
 * 右上角那一位读的是 guard 已经拿到的同一份缓存(`sessionQueryOptions()` 的 key 唯一),
 * 所以壳渲染不会多打一次 /me。结论由 `probeSessionFromError` 现算 —— 与 guard 同一个函数:
 * 「未知」与「未登录」必须是两句话,而两处各判一次 401,就会有一处把网络故障说成「未登录」,
 * 后果是操作员站在那儿反复贴一个本来正确的 token。
 */
export function AuthedLayout() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const session = useQuery(sessionQueryOptions());
  const awaiting = useQuery(awaitingApprovalQueryOptions());
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const nowMs = useNowMs();

  const badge = awaitingBadgeLabel(awaiting.data);
  const indicator = sessionIndicator(
    session.isError ? probeSessionFromError(session.error) : { status: "authenticated" },
    session.isPending,
    session.data?.expires_at ?? null,
    nowMs,
  );

  async function onLogout() {
    setLoggingOut(true);
    setLogoutError(null);
    try {
      await logoutMutationFn();
      // 先清缓存再跳:留着 /me 的缓存进登录页,下一步的 guard 会以为「会话还在」。
      queryClient.clear();
      setLoggingOut(false);
      await navigate({ to: "/login" });
    } catch {
      setLoggingOut(false);
      // 登出端点恒 200,能走到这里就是请求没送达。此时 cookie 大概率还在,所以**不**跳登录页:
      // 把「清不掉凭据」显示成「已登出」是谎,而操作员需要知道这个会话仍然有效
      // (全量撤销的唯一手段仍是换 WORKER_API_TOKEN —— §3 定稿的取舍)。
      setLogoutError("登出请求未送达:会话可能仍然有效。");
    }
  }

  return (
    <div className="ca-shell ca-shell--wide ca-stack">
      <header className="ca-stack">
        <div className="ca-cluster">
          <Link to="/" className="ca-text-md" activeOptions={{ exact: true }}>
            cloud-agent
          </Link>
          <span className="ca-badge">运维看板</span>
          <div className="ca-cluster ca-ml-auto">
            {logoutError !== null ? <span className="ca-error-text">{logoutError}</span> : null}
            <StatusBadge tone={indicator.tone}>{indicator.text}</StatusBadge>
            <ThemeToggle />
            <button
              type="button"
              className="ca-btn"
              onClick={onLogout}
              disabled={loggingOut}
              title="清掉本浏览器的会话 cookie(服务端零状态,没有别的登出动作)"
            >
              {loggingOut ? "登出中" : "登出"}
            </button>
          </div>
        </div>
        <nav className="ca-nav" aria-label="主导航">
          <Link
            to="/"
            className="ca-nav-link"
            activeProps={{ className: "ca-nav-link ca-nav-link--active" }}
            activeOptions={{ exact: true }}
          >
            Tasks
          </Link>
          <Link
            to="/approvals"
            className="ca-nav-link"
            activeProps={{ className: "ca-nav-link ca-nav-link--active" }}
          >
            <span className="ca-cluster">
              Approvals
              {badge === null ? null : <StatusBadge tone="warn">{badge}</StatusBadge>}
            </span>
          </Link>
          <Link
            to="/audit"
            className="ca-nav-link"
            activeProps={{ className: "ca-nav-link ca-nav-link--active" }}
          >
            Audit
          </Link>
        </nav>
      </header>
      <main className="ca-stack ca-stack--loose">
        <Outlet />
      </main>
    </div>
  );
}

/**
 * 会话剩余时需要的「现在」。30s 一拍:这一位只显示到分钟,更密的节拍只多打渲染。
 * 用 `Date.now()` 差值而不是累加秒数 —— 与 SSE 停滞计时同一条抗 hidden-tab 节流的纪律
 * (docs/product.md §4 的 SSE 行),两类计时器没有理由各写一套。
 */
function useNowMs(intervalMs = 30_000): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return nowMs;
}
