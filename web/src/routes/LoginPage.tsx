import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";

import {
  isUsableToken,
  LOGIN_EMPTY_TOKEN_TEXT,
  loginFailureCopy,
  loginTargetPath,
} from "../lib/auth";
import { APPROVALS_KEY, SESSION_KEY, loginMutationFn } from "../lib/queries";

/**
 * `/login`(docs/product.md §5 第一行,w2b 交付 ②)。
 *
 * 一个粘贴框 + 一个按钮,没有「注册/忘记密码/租户」:用户就是操作员本人,单租户,
 * 凭据就是那个 `WORKER_API_TOKEN`(§1 的不变量)。多放一个入口就是在给「不做用户体系」
 * 这条定稿留一个可以慢慢滑过去的斜坡。
 *
 * 三处刻意的不显眼:
 *
 * 1. **失败只有一句话**(文案在 lib/auth.ts 的常量里,四种失败种类同一句)。
 *    token 错、服务端没配 token、请求没出去、响应不是 JSON —— 在页面上不可区分。
 *    §5 的原话是「不泄露探测面」:/login 是门前唯一那条端点,没有鉴权也没有速率限制,
 *    每多一个分支就多一个白嫖的 oracle。可调试性由服务端日志承担,不由响应体承担。
 *    (空 token 是唯一例外:那是输入错误,压根没发请求,把它说成「登录失败」会让人
 *    以为是服务端的问题。判定见 `isUsableToken`。)
 * 2. **成功后立刻清空输入框**。token 在受控组件里就是内存里的一份明文;登录完成之后
 *    没有任何理由再留着它 —— 而这一页恰恰是唯一一个「操作员亲手把凭据贴进浏览器」的地方。
 *    会话凭据是那条 HttpOnly cookie,前端读不到,也不需要读到。
 * 3. **清掉 guard 留下的旧结论**再跳转。`removeQueries` 而不是 `invalidateQueries`:
 *    invalidate 只是标脏,`ensureQueryData` 在「已有数据」的分支上仍可能先交付旧值 ——
 *    而这里的旧值恰好是「未登录」。删干净,guard 必然重新读一次 /me,
 *    表现就是登录后直接进目标页而不是被弹回登录页转一圈。
 *
 * `?next=` 由 guard 写上、这里读回,值先过 zod 再过站内白名单(lib/auth.ts):
 * 照抄一个外站 next 就是把操作员登录后的第一眼用来给钓鱼背书。
 */
export function LoginPage() {
  const search = useSearch({ from: "/login" });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (!isUsableToken(token)) {
      setError(LOGIN_EMPTY_TOKEN_TEXT);
      return;
    }
    setPending(true);
    setError(null);
    try {
      await loginMutationFn(token.trim());
      queryClient.removeQueries({ queryKey: SESSION_KEY });
      queryClient.removeQueries({ queryKey: APPROVALS_KEY });
      setToken("");
      await navigate({ href: loginTargetPath(search) });
    } catch (err) {
      setError(loginFailureCopy(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="ca-shell ca-stack">
      <header className="ca-cluster">
        <h1 className="ca-text-md">cloud-agent</h1>
        <span className="ca-badge">运维看板</span>
      </header>
      <p className="ca-muted">
        粘贴 <code>WORKER_API_TOKEN</code> 换取会话 cookie(6 小时有效,HttpOnly +
        SameSite=Strict)。换掉 token 即撤销所有已登录的会话。
      </p>
      <form className="ca-card ca-field" onSubmit={onSubmit} noValidate>
        <label className="ca-label" htmlFor="token">
          token
        </label>
        <input
          id="token"
          className={error === null ? "ca-input" : "ca-input ca-input--error"}
          type="password"
          value={token}
          autoComplete="off"
          spellCheck={false}
          // 粘贴框:token 是长随机串,拼写检查与自动大写只会制造第二种错误形状。
          // 用 password 而不是 text:粘贴错了要能看出来,但肩窥者不该看出来。
          onChange={(event) => {
            setToken(event.target.value);
            setError(null);
          }}
        />
        {error === null ? null : <span className="ca-error-text">{error}</span>}
        <div className="ca-cluster">
          <button
            type="submit"
            className="ca-btn ca-btn--primary"
            disabled={pending}
          >
            {pending ? "登录中" : "登录"}
          </button>
        </div>
      </form>
    </main>
  );
}
