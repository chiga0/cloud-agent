/**
 * 路由表(w2b 交付 ①):TanStack Router **代码式**路由,不引文件路由插件。
 *
 * 结构刻意扁平(§4 的选型注记:语料比 react-router 小 → 缓解手段之一就是「路由 ≤6 条」):
 * 根路由 + 5 条页面路由,其中 4 条挂在一条无 path 的 authed 布局路由下面。
 * 无 path 布局是这里唯一的技巧:`/_auth` 不出现在 URL 里,只负责「门 + 壳」,
 * 于是 guard 与导航栏只有一份定义,而不是在四个页面里各调一次 useSession()。
 *
 * 三条规矩:
 *
 * 1. **guard 用 ensureQueryData,而不是 loader 之外的裸 fetch**。§4 的选型红利就在这:
 *    路由解析阶段就能把 /api/session/me 读完并与壳上的状态位共享同一份缓存。
 *    这条预取的取舍要写清 —— **loader 只用于「页面渲染的前置条件」**:Approvals 角标的
 *    计数不是前置条件,所以它走壳上的 useQuery 而不是这里的 loader。把非必要的查询放进
 *    loader 的后果是「角标那个端点 500 了 → 整页进错误边界」,而它明明只是少一个数字。
 *    **w3 落在同一侧**:任务列表的取数也留在组件里(`useQuery`)。这一页的「还在读 /
 *    读到空 / 读失败」三种状态都是**页面内容**(§5 要求失败态与空态各有文案),把它们搬进
 *    loader 就等于让失败绕过页面自己的诊断去渲染错误边界;而 `defaultPreload: "intent"`
 *    已经让悬停开始解析与预取,gate 一次只多一道吞掉诊断的关卡。
 *    仍然算前置条件的是 guard 那一条(没登录就没有页面)。w4 详情若要把预取搬进 loader,
 *    那一棒的 loader 长这样:
 *    `loader: ({ context: { queryClient }, params }) => queryClient.ensureQueryData(taskDetailQueryOptions(params.taskId))`
 * 2. **只有 unauthenticated 才 redirect**。`unreachable`(网络/形状/5xx)放行到壳里,由右上角
 *    那一位说「会话状态未知」。判据在 lib/auth.ts 的 probeSession,理由写在那儿。
 * 3. **search 参数一律 zod 校验后交付**。/login 用 `loginSearchSchema`(经 `parseSearch`),
 *    `/` 用 `tasksSearchSchema`(经 `parseTasksFilter`,它额外把被拒收的原值报给页面 —— 理由在
 *    `lib/tasks-page.ts`)。URL 是用户可编辑输入,
 *    而组件按校验后的类型写代码 —— 打错的链接要能正常落到缺省,而不是白屏。
 */

import { createRootRouteWithContext, createRoute, createRouter, Outlet, redirect } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";

import { AuthedLayout } from "./components/AuthedLayout";
import { isInternalNextPath, LOGIN_PATH, probeSession } from "./lib/auth";
import { sessionQueryOptions } from "./lib/queries";
import { loginSearchSchema, parseSearch, type LoginSearch, type TasksSearch } from "./lib/schema";
import { parseTasksFilter } from "./lib/tasks-page";
import { LoginPage } from "./routes/LoginPage";
import { TasksIndexPage } from "./routes/TasksIndexPage";
import { ApprovalsPage, AuditPage, NotFoundPage, TaskDetailPage } from "./routes/Placeholders";

/** 路由 context 的契约:目前只有 QueryClient(§4:router context 携 queryClient)。 */
export interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: RootRoute,
  notFoundComponent: NotFoundPage,
});

/** 根路由只做一件事:把子路由摆出来。布局在 /_auth,登录页自带整屏 —— 两层都不在这。 */
function RootRoute() {
  return <Outlet />;
}

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: LOGIN_PATH,
  component: LoginPage,
  validateSearch: (search): LoginSearch => parseSearch(loginSearchSchema, search),
});

const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "/_auth",
  component: AuthedLayout,
  beforeLoad: async ({ context, location }) => {
    const probe = await probeSession(() =>
      context.queryClient.ensureQueryData(sessionQueryOptions()),
    );
    if (probe.status !== "unauthenticated") return;
    // 只有站内路径才配被写进 next:白名单在 lib/auth.ts,登录成功后照它跳。
    const next = isInternalNextPath(location.pathname) ? location.pathname : undefined;
    throw redirect({ to: LOGIN_PATH, search: next === undefined ? {} : { next } });
  },
});

const indexRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/",
  component: TasksIndexPage,
  // w3:任务列表的 state 过滤器就住在这条 search 上。校验器与页面读的是同一个纯函数
  // (`lib/tasks-page.ts` 的 parseTasksFilter),差别只在这一份**不**把被拒收的原值带进
  // search:validateSearch 的返回是下一次导航要写回地址栏的东西,把旁注写进 URL 就等于
  // 承诺一个谁都会以为是过滤器一部分的参数。被拒的值由页面自己从 searchStr 里取。
  validateSearch: (search): TasksSearch => {
    const filter = parseTasksFilter(search);
    return filter.state === null ? {} : { state: filter.state };
  },
});

const taskDetailRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/tasks/$taskId",
  component: TaskDetailPage,
});

const approvalsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/approvals",
  component: ApprovalsPage,
});

const auditRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/audit",
  component: AuditPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  authedRoute.addChildren([indexRoute, taskDetailRoute, approvalsRoute, auditRoute]),
]);

/**
 * 单例 router 工厂:导出函数而不是导出实例,因为 `queryClient` 由调用方(App.tsx)给 ——
 * 两边必须握同一个 QueryClient 实例,否则 loader 的预取与 hook 的读缓存会各自为政。
 *
 * `defaultPreload: "intent"` 的红利与代价:鼠标停在链接上就开始解析与取数,点下去即刻呈现。
 * 对本仓唯一的实时读面(任务详情)这是划算的;它同时意味着「悬停即请求」,
 * 所以那一棒的 loader 只放幂等的读查询(全部 /api 读端点都是)。
 */
export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
