import { describe, expect, it } from "vitest";

import routerRaw from "../web/src/router.tsx?raw";
import appRaw from "../web/src/App.tsx?raw";
import mainRaw from "../web/src/main.tsx?raw";
import loginPageRaw from "../web/src/routes/LoginPage.tsx?raw";
import authedLayoutRaw from "../web/src/components/AuthedLayout.tsx?raw";
import dataTableRaw from "../web/src/components/DataTable.tsx?raw";
import placeholdersRaw from "../web/src/routes/Placeholders.tsx?raw";
import tasksIndexPageRaw from "../web/src/routes/TasksIndexPage.tsx?raw";
import taskDetailPageRaw from "../web/src/routes/TaskDetailPage.tsx?raw";
import taskDetailLibRaw from "../web/src/lib/task-detail.ts?raw";
import taskDeliverablesRaw from "../web/src/lib/task-deliverables.ts?raw";
import useTaskTimelineRaw from "../web/src/lib/use-task-timeline.ts?raw";
import tasksPageLibRaw from "../web/src/lib/tasks-page.ts?raw";
import useEventStreamRaw from "../web/src/lib/use-event-stream.ts?raw";
import queryClientRaw from "../web/src/lib/query-client.ts?raw";
import queriesRaw from "../web/src/lib/queries.ts?raw";
import schemaLibRaw from "../web/src/lib/schema.ts?raw";
import apiRaw from "../web/src/lib/api.ts?raw";
import workerIndexRaw from "../src/index.ts?raw";
import viteConfigRaw from "../web/vite.config.ts?raw";
import prodWranglerRaw from "../wrangler.jsonc?raw";
import { loadWranglerConfig, matchesRunWorkerFirst } from "./wrangler-config";

/**
 * 页面与数据层的**接线契约**(w2b)。
 *
 * 这里钉的是「跨文件才能成立、而单点测试与 typecheck 都看不见」的装配事实。
 * 为什么不渲染组件:本仓的测试跑在 Workers 运行时里没有 DOM,而这几条断言的失效形状
 * 全部是「装配错了一个位置」——渲染测试也钉不住它们(渲染时谁都看不出 guard 被挪进了组件)。
 *
 * 逐条说清代价与红利:
 * - **路由表 ≤6 条**是 §4 选型注记里明写的缓解措施(TanStack Router 语料比 react-router 小),
 *   写第 7 条路由不会报错,只会让这一棒的复杂度预算悄悄超支。
 * - **guard 在路由的 beforeLoad 而不是组件里**:写进组件的第一个页面就会漏掉某条路由,
 *   漏掉的那条是一个「不需要登录也能看到的页面」—— 那是安全问题,不是样式问题。
 * - **SSE 不进 Query 缓存**(§4):进了就会得到「两份事件列表」——一份在缓存里按快照覆盖,
 *   一份在续传点之后。这条写死在这里,是因为下一个手痒的人一定是想「给事件流加缓存」。
 * - **旧落地页不留兼容层**:残留一个 `url.pathname === "/"` 的分支,就会得到
 *   「资产层被 worker 抢在面前」的静默故障(与 §7 头号风险同形状,只是方向相反)。
 */

const wrangler = loadWranglerConfig(prodWranglerRaw);

/**
 * 只留代码行(剥掉整行注释与 JSDoc 续行)。
 *
 * 本文件有几条「某个标识符不许出现在这个源文件里」的断言,而注释里正当的举例
 * (「不该出现 X,正确做法是 Y」)恰恰会提到那个 X。不剥注释,这些钉子就会误伤自己人 ——
 * 而一条会误伤的钉子的下场永远是被人删掉,不是被人改对。
 */
function codeOnly(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("//") && !trimmed.startsWith("/*") && !trimmed.startsWith("*");
    })
    .join("\n");
}

/** router.tsx 里声明的全部路由 path(根路由与无 path 的布局路由不在其中)。 */
function declaredPaths(): string[] {
  return [...routerRaw.matchAll(/\n\s*path:\s*(?:LOGIN_PATH|["']([^"']+)["'])/g)].map(
    (m) => (m[1] ?? "/login") as string,
  );
}

describe("路由表", () => {
  it("代码式路由恰好 5 条页面路由,且与 §5 的清单逐条相同", () => {
    expect(declaredPaths().sort()).toEqual(
      ["/", "/approvals", "/audit", "/login", "/tasks/$taskId"].sort(),
    );
  });

  it("不引文件路由插件(代码式路由是定稿,不是过渡状态)", () => {
    expect(routerRaw).not.toMatch("routeTree.gen");
    expect(viteConfigRaw).not.toMatch(/router-plugin|router-plugin\/vite|TanStackRouterVite/i);
  });

  it("/live/:taskId 仍归 worker(w4b 起答 301 到详情页),前端路由清单不抢这条路径", () => {
    expect(declaredPaths()).not.toContain("/live");
    const rules = (wrangler.assets?.run_worker_first ?? []) as string[];
    // 分区仍然成立:301 必须由 worker 答(资产层没有这条路由),新页面归资产。
    expect(matchesRunWorkerFirst(rules, "/live/x")).toBe(true);
    expect(matchesRunWorkerFirst(rules, "/tasks/x")).toBe(false);
    expect(matchesRunWorkerFirst(rules, "/api/session/me")).toBe(true);
  });

  it("根路由给 notFound 组件:站内未知路径不该白屏", () => {
    expect(routerRaw).toContain("notFoundComponent");
    expect(placeholdersRaw).toContain("NotFoundPage");
  });
});

describe("authed guard 的落点与判据", () => {
  it("beforeLoad 挂在无 path 的布局路由上,四条 authed 页面共用一个 guard", () => {
    const beforeLoadCount = (routerRaw.match(/beforeLoad:/g) ?? []).length;
    expect(beforeLoadCount, "多一条 beforeLoad 就多一份跳转逻辑,而它们必然漂移").toBe(1);
    expect(routerRaw).toMatch(/id:\s*"\/_auth"[\s\S]*?beforeLoad:/);
    // 四条页面路由全部以 authedRoute 为父:漏一条 = 那个页面不需要登录
    const parents = [...routerRaw.matchAll(/getParentRoute:\s*\(\)\s*=>\s*(\w+)/g)].map(
      (m) => m[1] as string,
    );
    expect(parents.filter((p) => p === "authedRoute")).toHaveLength(4);
    expect(parents).toHaveLength(6); // 其余两条:login 与 authed 本身挂在 root 上
  });

  it("guard 走 queryClient.ensureQueryData(预取与壳共享同一份缓存)", () => {
    expect(routerRaw).toMatch(/ensureQueryData\(sessionQueryOptions\(\)\)/);
    expect(routerRaw).toMatch(/context\.queryClient/);
  });

  it("跳转判据只有 unauthenticated 一支,其余放行进壳", () => {
    expect(routerRaw).toMatch(/probe\.status\s*!==\s*"unauthenticated"/);
    expect(routerRaw).toMatch(/throw redirect\(\{\s*to:\s*LOGIN_PATH/);
    // 反向钉子:路由里不许出现其它 status 的分支(那等于把网络故障解释成「没登录」)
    expect(routerRaw).not.toMatch(/probe\.status === "unreachable"/);
  });

  it("App 把同一个 queryClient 同时交给 Provider 与 router context", () => {
    expect(appRaw).toMatch(/createAppRouter\(queryClient\)/);
    expect(appRaw).toMatch(/<QueryClientProvider client=\{queryClient\}/);
    expect(queryClientRaw).toMatch(/export const queryClient = new QueryClient/);
    // 只有一个 QueryClient 构造点:两处各 new 就是两份缓存
    expect((codeOnly(queryClientRaw).match(/new QueryClient/g) ?? []).length).toBe(1);
  });
});

describe("/login 页", () => {
  it("表单控件走 surface/border token 的 class,错误提示走 err 文案 class", () => {
    expect(loginPageRaw).toContain("ca-input");
    expect(loginPageRaw).toContain("ca-input--error");
    expect(loginPageRaw).toContain("ca-error-text");
  });

  it("错误文案取自 lib/auth 的常量,不在组件里另写一句", () => {
    expect(loginPageRaw).toContain("loginFailureCopy");
    expect(loginPageRaw).toMatch(/setError\(loginFailureCopy\(err\)\)/);
    // 组件里不许出现第二种登录失败文案(§5:不区分 token 错与网络错)
    expect(loginPageRaw).not.toMatch(/token 不正确|网络错误|无法连接|unauthorized/i);
  });

  it("POST 走 /api/session/login,且不清凭据也不写 localStorage", () => {
    expect(queriesRaw).toContain('"/api/session/login"');
    expect(loginPageRaw).not.toMatch(/localStorage/);
    expect(apiRaw).not.toMatch(/localStorage/);
  });

  it("登录成功清掉旧会话结论后再跳,并按白名单决定落点", () => {
    expect(loginPageRaw).toMatch(/removeQueries\(\{ queryKey: SESSION_KEY \}\)/);
    expect(loginPageRaw).toMatch(/navigate\(\{ href: loginTargetPath\(search\) \}\)/);
  });

  it("提交中禁用按钮,避免并发两次登录", () => {
    expect(loginPageRaw).toMatch(/disabled=\{pending\}/);
    expect(loginPageRaw).toMatch(/if \(pending\) return/);
  });
});

describe("authed 壳", () => {
  it("顶导航三格用站内路由,Approvals 带 warn 角标", () => {
    expect(authedLayoutRaw).toMatch(/to="\/approvals"/);
    expect(authedLayoutRaw).toMatch(/to="\/audit"/);
    expect(authedLayoutRaw).toMatch(/to="\/"/);
    expect(authedLayoutRaw).toMatch(/<StatusBadge tone="warn">\{badge\}/);
    expect(authedLayoutRaw).toContain("awaitingApprovalQueryOptions");
  });

  it("会话状态位与登出都在壳里,而「跳登录」的判据只在 guard", () => {
    expect(authedLayoutRaw).toContain("sessionIndicator");
    expect(authedLayoutRaw).toContain("logoutMutationFn");
    // 壳不许自己解释 401(两处判据必然漂移,而漂的那一处会把网络故障说成「没登录」)。
    // 它唯一的 navigate 是登出成功之后 —— 那是一个动作的结果,不是一个判据。
    expect(authedLayoutRaw).not.toMatch(/unauthorized/i);
    expect((codeOnly(authedLayoutRaw).match(/navigate\(/g) ?? []).length).toBe(1);
  });

  it("Approvals 计数读的是现成端点(零后端改动)", () => {
    // 这条原先拿 `queriesRaw` 直接比 `/api/admin/tasks?state=AWAITING_APPROVAL`,
    // 命中的其实是一句 JSDoc(代码里那串是模板的 `${AWAITING_APPROVAL_STATE}`)——
    // 一份只被注释满足的钉子等于没有(HEAD 那棒刚修过同类的 M5 假钉)。改成先剥注释,
    // 再比代码里真正拼 URL 的那一处。
    expect(codeOnly(queriesRaw)).toMatch(
      /\$\{ADMIN_TASKS_PATH\}\?state=\$\{AWAITING_APPROVAL_STATE\}&limit=\$\{AWAITING_APPROVAL_LIMIT\}/,
    );
    expect(codeOnly(queriesRaw)).toMatch(/refetchInterval: 30_000/);
  });
});

describe("EventSource 封装", () => {
  it("用原生 EventSource,带同源凭据,卸载即关闭", () => {
    expect(useEventStreamRaw).toMatch(/new EventSource\(path, \{ withCredentials: true \}\)/);
    expect(useEventStreamRaw).toMatch(/es\.close\(\)/);
    expect(useEventStreamRaw).not.toMatch(/fetch\(/);
  });

  it("事件流不走 Query 缓存(§4:增量流不是快照)", () => {
    expect(useEventStreamRaw).not.toMatch(/useQuery|queryKey|QueryClient/);
  });

  it("停滞计时取 Date.now 差值,不累加 tick", () => {
    expect(useEventStreamRaw).toMatch(/setNowMs\(Date\.now\(\)\)/);
    expect(useEventStreamRaw).not.toMatch(/\+=\s*1\s*;?\s*\/\/?\s*秒/);
    // 累加器写法(唯一会做错的那种)不能出现在这一层
    expect(useEventStreamRaw).not.toMatch(/stallSeconds/);
  });

  it("监听 agent / end / 匿名 message 三个入口,坏帧只计数", () => {
    for (const needle of ["SSE_AGENT_EVENT", "SSE_END_EVENT", "es.onmessage"]) {
      expect(useEventStreamRaw, needle).toContain(needle);
    }
    expect(useEventStreamRaw).toMatch(/bad: prev\.bad \+ 1/);
    // 坏帧分支里绝不允许 return 之前先关流(那是一条坏帧停更整页的形状)。
    // 正则必须匹配实现的分支形状(if,不是 switch-case):变异验证发现 /case "bad"/ 恒不命中,
    // 坏帧分支真插 es.close() 时这条钉子绿着 —— 2026-09-06 落地前变异电池 M5 修掉。
    expect(useEventStreamRaw).not.toMatch(/frame\.kind === "bad"[\s\S]{0,500}es\.close\(\)/);
  });

  it("onopen 清掉错误文案(否则一次已恢复的断连会永远挂在「重连中」)", () => {
    expect(useEventStreamRaw).toMatch(/es\.onopen[\s\S]{0,200}setConnection\(null\)/);
  });
});

describe("旧落地页退役不留兼容层(w2b)", () => {
  it("worker 源码里没有 landingHtml,也没有任何 `/` 的页面分支", () => {
    expect(workerIndexRaw).not.toMatch(/landingHtml/);
    expect(workerIndexRaw).not.toMatch(/pathname === "\/"/);
    // live 页也退役了(w4b 301):worker 源码里不再有任何内联 HTML 产出点。
    // 再出现一份 `<!DOCTYPE html>` 就意味着有人又造了一个「worker 抢在资产前面的页面分支」。
    expect(workerIndexRaw).not.toMatch(/<!DOCTYPE html/i);
  });

  it("/live 的 301 仍在 worker 里(资产层答不了重定向),旧页面渲染已删干净", () => {
    expect(workerIndexRaw).toContain("liveMatch");
    expect(workerIndexRaw).not.toContain("renderLivePage");
  });

  it("前端的首页不再是 w2a 的说明壳,而是路由树", () => {
    expect(mainRaw).toMatch(/render\(<App \/>\)/);
    // 入口不再自带任何 markup:首页由路由表决定,布局只有一份(AuthedLayout)
    expect(appRaw).not.toMatch(/<div|<main|<header|className=/);
    expect(appRaw).toContain("RouterProvider");
  });
});

describe("表格 headless 分工", () => {
  it("markup 只吃 table 实例,不含业务映射与列定义", () => {
    expect(dataTableRaw).toMatch(/table: TanStackTable<TData>/);
    expect(dataTableRaw).toMatch(/flexRender/);
    // 逻辑归 react-table,颜色归 lib/view.ts:表格组件里不该出现 state→色的映射
    expect(codeOnly(dataTableRaw)).not.toMatch(/stateTone|AWAITING_APPROVAL|DONE/);
    // 没有页码器:§5 定的是游标「加载更多」
    expect(codeOnly(dataTableRaw)).not.toMatch(/nextPage|previousPage|pageCount/);
  });
});

/**
 * w3 交付的四件事(列表、过滤、取数、诚实呈现)里,凡是**跨文件才成立**的部分。
 *
 * 判据本身(合法 state 的取值、count 怎么说、失败怎么分)由 test/web-tasks-page.test.ts
 * 真跑函数钉住;这里只补那些「搬错一个位置就坏、而函数测试看不见」的装配事实 ——
 * 与本文件其余部分的分工一致。反向钉子(不许出现翻页 API、不许把 count 渲染成总数)
 * 是本节的全部重点:它们防的不是写不出来,而是下一棒顺手加一个看起来无害的「共 N 条」。
 */
describe("/ 任务列表页(w3)", () => {
  it("首页不再是占位组件:真页面有自己的文件,占位那份不再挂 w3", () => {
    expect(codeOnly(routerRaw)).toContain('from "./routes/TasksIndexPage"');
    expect(codeOnly(routerRaw)).toMatch(/component:\s*TasksIndexPage/);
    expect(codeOnly(placeholdersRaw)).not.toMatch(/TasksIndexPage/);
    expect(codeOnly(placeholdersRaw)).not.toContain("w3");
  });

  it("search 走 zod,且路由与页面共用同一个纯解析器(两份判据必漂)", () => {
    expect(codeOnly(routerRaw)).toMatch(/validateSearch:\s*\(search\):\s*TasksSearch\s*=>/);
    expect(codeOnly(routerRaw)).toContain("parseTasksFilter(search)");
    expect(codeOnly(tasksPageLibRaw)).toContain("tasksSearchSchema.safeParse");
    expect(codeOnly(schemaLibRaw)).toContain("z.enum(TASK_STATE_VALUES)");
  });

  it("过滤变化同步回 URL,写入之前先过同一个校验器", () => {
    expect(codeOnly(tasksIndexPageRaw)).toMatch(/navigate\(\{ to: "\/", search:/);
    expect(codeOnly(tasksIndexPageRaw)).toMatch(/parseTasksFilter\(\{ state: value \}\)/);
    // 被拒收的原值只做旁注:它不许被写进 search(否则 URL 多出一个像过滤器参数的键)
    expect(codeOnly(routerRaw)).not.toMatch(/rejected/);
  });

  it("取数判据只许是 parseTasksFilter:useSearch 的 state 被 router 合并过原始值,类型是谎报", () => {
    // router-core 以 `{ ...原始, ...校验输出 }` 合并出 match.search:校验器对坏值返回
    // 裸 {} 盖不掉 URL 上的 state=BAD / ?state=,原始串会原样流进 useSearch ——
    // 2026-09-06 prod 实测,组件读它曾把坏值原样发到服务端吃 400(invalid_state),
    // 而页面口供说「按全部读取」。取数值与旁注都必须出自组件与 validateSearch 共用的
    // 那份纯函数;校验器也因此刻意维持裸 {}:坏值留在地址栏,回落说明的承诺才为真。
    const code = codeOnly(tasksIndexPageRaw);
    expect(code).toContain("parseTasksFilter(location.searchStr)");
    expect(code).toContain("const state = filter.state;");
    expect(code).not.toContain("useSearch");
    expect(code).not.toContain("search.state");
    expect(codeOnly(routerRaw)).toContain("filter.state === null ? {} : { state: filter.state }");
  });

  it("表格逻辑在 headless 层:列定义在模块级,markup 交给 DataTable", () => {
    const code = codeOnly(tasksIndexPageRaw);
    expect(code).toMatch(/^const TASK_COLUMNS = \[/m);
    expect(code).toContain("useReactTable({");
    expect(code).toContain("getCoreRowModel: getCoreRowModel()");
    expect(code).toContain("getSortedRowModel: getSortedRowModel()");
    expect(code).toMatch(/<DataTable\b/);
    expect([...code.matchAll(/columnHelper\.accessor\("([\w_]+)"/g)].map((m) => m[1])).toEqual([
      "id",
      "state",
      "created_at",
      "updated_at",
      "version",
    ]);
  });

  it("配色只有一个出口:组件里不出现状态类名字面量,也不自带第二套映射", () => {
    const code = codeOnly(tasksIndexPageRaw);
    expect(code).toContain("stateTone(");
    expect(code).toContain("<StatusBadge");
    expect(code).not.toMatch(/ca-state--|ca-kind--/);
  });

  /**
   * 不伪装分页。
   *
   * 只禁**实现手段**(v8 的分面 API、v5 的无限查询、以及一个凭空缺出来的 cursor 参数),
   * 不禁「加载更多」这四个字 —— 读满上限时那一格文案恰恰要说「所以这里不放加载更多」
   * (`tasksReadNote`,由 test/web-tasks-page.test.ts 正向钉住)。说清楚为什么没有,
   * 与默默没有,是两种不同的页面。
   */
  it("不伪装分页:翻页要用的那套 API 在读层与列表页一个都不许出现", () => {
    const banned =
      /useInfiniteQuery|fetchNextPage|hasNextPage|getPaginationRowModel|getFilteredRowModel|pageIndex|pageSize|nextPage|previousPage|pageCount|next_cursor|\bcursor\b|offset=/;
    for (const [name, source] of Object.entries({
      tasksIndexPageRaw,
      tasksPageLibRaw,
      dataTableRaw,
      queriesRaw,
      schemaLibRaw,
    })) {
      expect(codeOnly(source), name).not.toMatch(banned);
    }
  });

  it("count 不许被渲染成总数", () => {
    for (const [name, source] of Object.entries({ tasksIndexPageRaw, tasksPageLibRaw, dataTableRaw })) {
      const code = codeOnly(source);
      expect(code, name).not.toMatch(/共\s*[\d{]/);
      expect(code, name).not.toMatch(/总计|总条数|第\s*\d+\s*页/);
    }
  });

  it("30s 节拍只有一份出处:角标与列表同拍(两套刷新率必然互相矛盾)", () => {
    expect((codeOnly(queriesRaw).match(/refetchInterval: 30_000/g) ?? []).length).toBe(2);
  });

  it("范围栅栏:只读 admin/tasks 一条端点,不碰 w4 的流、w5 的审批、w6 的审计面", () => {
    const code = codeOnly(tasksIndexPageRaw) + codeOnly(tasksPageLibRaw);
    expect(code).not.toMatch(/\/api\/admin\/(events|attempts|chain-check)/);
    expect(code).not.toMatch(/useMutation|approve|\/api\/session\//);
    expect(code).not.toMatch(/new EventSource|useEventStream|fetch\(/);
    // 反向:整条链上只有这一处列表 URL,拼第二处就会开始与角标那条漂移
    expect((codeOnly(queriesRaw).match(/\/api\/admin\/tasks/g) ?? []).length).toBe(1);
  });
});

/**
 * `/tasks/$taskId` 上半(w4a)。
 *
 * 判据本身(补齐该不该跑、翻没翻尽、坏形状怎么处理、四种失败各说哪句话、六列的预算边界)
 * 由 test/web-task-detail.test.ts 真跑函数并**打真端点**钉住;这一节只补那些
 * 「搬错一个位置就坏、而函数测试看不见」的装配事实。重点是那三根反向钉子:
 * 复制协议字面量、把 I/O 写进页面、给这一页再加第三个节拍 —— 三种都能让页面当场看起来正常,
 * 而坏的时候只在生产上、以最像「后端没事」的形状坏。
 */
describe("/tasks/$taskId 上半(w4a)", () => {
  const w4a = { taskDetailPageRaw, taskDetailLibRaw, useTaskTimelineRaw };
  const w4aCode = () => Object.values(w4a).map((source) => codeOnly(source)).join("\n");

  it("详情页组件真换成了独立文件,占位那份不再挂整页 w4", () => {
    expect(codeOnly(routerRaw)).toContain('from "./routes/TaskDetailPage"');
    expect(codeOnly(routerRaw)).toMatch(/component:\s*TaskDetailPage/);
    expect(codeOnly(placeholdersRaw)).not.toMatch(/TaskDetailPage|useParams/);
    // 拆围接缝(w4b 已合拢):下半三块真渲染,占位件不再挂在这一页。三条读法出自
    // lib/queries.ts(取数只在 queries 的那条钉继续管「没有第三条 I/O 出口」)。
    expect(codeOnly(taskDetailPageRaw)).not.toContain("PagePlaceholder");
    expect(codeOnly(taskDetailPageRaw)).toContain("taskEvidenceQueryOptions(");
    expect(codeOnly(taskDetailPageRaw)).toContain("candidateQueryOptions(");
    // warnings 必须与 patch 同屏(src/audit/candidate.ts 的交付合同:消费方必须展示)
    expect(codeOnly(taskDetailPageRaw)).toContain("candidate.warnings.map");
  });

  it("SSE 只复用 use-event-stream,协议字面量一个字都不抄", () => {
    // 本页的停滞三色走 taskStallView(product.md §5 的 90/300),以 DI 传入;
    // 钉死实参,防止退回缺省的 stallView(监督器那对 900/180,/live 口径)而测试看不见。
    expect(codeOnly(useTaskTimelineRaw)).toContain("useEventStream(streamPath, taskStallView)");
    expect(codeOnly(useTaskTimelineRaw)).toContain("taskStreamUrl(taskId)");
    // 复制这些字面量 = 第二份协议真相:w2b 那套与 worker 逐值比对的钉子从此管不到它
    expect(w4aCode()).not.toMatch(/new EventSource|addEventListener\(|readyState\s*===|lastEventId/);
    for (const banned of [/=\s*900\b/, /=\s*180\b/, /=\s*200\b/, /"agent"/, /"end"/, /"heartbeat"/]) {
      expect(w4aCode(), String(banned)).not.toMatch(banned);
    }
    // 阈值与截断长度只能被引用,不能被再定义一次
    expect(w4aCode()).toMatch(/STALL_WARN_SECONDS|stallView|stream\.stall/);
    expect(codeOnly(taskDetailLibRaw)).toContain("summarize(");
  });

  it("取数只在 lib/queries.ts:这一页的 .tsx 与 hook 里没有第三条 I/O 出口", () => {
    expect(w4aCode()).not.toMatch(/\bfetch\(|apiGet\(|apiPost\(|useMutation/);
    // URL 只有一个拼点。页面里那些 `GET /api/tasks/:id` 是给人看的说明文字,不是请求。
    for (const [name, source] of Object.entries({ taskDetailPageRaw, useTaskTimelineRaw })) {
      expect(codeOnly(source), name).not.toMatch(/`\/api\/tasks\/\$\{/);
    }
  });

  it("补齐不进 Query 缓存,也不给这一页加第三个节拍", () => {
    const hook = codeOnly(useTaskTimelineRaw);
    expect(hook).not.toMatch(/useQuery|queryKey|useInfiniteQuery|QueryClient/);
    // 快照的实时性靠「end 帧 → 重读」这一条事件驱动的边,不靠轮询。
    expect((codeOnly(queriesRaw).match(/refetchInterval/g) ?? []).length).toBe(2);
    expect(hook).toContain("runEventsPull(");
    expect(codeOnly(taskDetailPageRaw)).toContain("invalidateQueries");
    expect(codeOnly(taskDetailPageRaw)).toContain("taskSnapshotQueryKey");
  });

  it("不伪装分页:翻页要用的那套 API 在 w4a 三件套里一个都不许出现", () => {
    const banned =
      /useInfiniteQuery|fetchNextPage|hasNextPage|getPaginationRowModel|pageIndex|pageSize|nextPage|previousPage|pageCount|next_cursor|\bcursor\b|offset=/;
    for (const [name, source] of Object.entries(w4a)) {
      expect(codeOnly(source), name).not.toMatch(banned);
    }
  });

  it("取数判据出自纯函数:页面不解释 hook 返回值,只把原始量交给它们", () => {
    const code = codeOnly(taskDetailPageRaw);
    for (const needle of [
      "streamEnabledFor(",
      "isTaskNotFound(",
      "stateDisplay(",
      "connectionBadge(",
      "detailFailureText(",
      "timelineEmptyText(",
      "pullNote(",
    ]) {
      expect(code, needle).toContain(needle);
    }
    // 补齐的触发判据住在纯函数里,由 hook 调用(页面里没有第二处「该不该拉」的判断)
    expect(codeOnly(useTaskTimelineRaw)).toContain("pullStartAfter({");
    expect(code).not.toMatch(/pullStartAfter|runEventsPull/);
    // 这一页没有 search 参数:w4a 不放过滤器,也就不该有第二份「URL 上的值当判据」的坑
    expect(code).not.toMatch(/useSearch|searchParams/);
    // 直接分支在 hook 返回值上的形状(把判据留在组件里的那种):页面不许自己看 counts/tone/seconds
    expect(code).not.toMatch(/stream\.counts\.\w+\s*[<>]=?|\.tone === "|\.seconds > /);
  });

  it("任务级 URL 只有一个拼点:taskPath 之外没有第二处 /api/tasks/ 字面量", () => {
    // 三处各拼一遍 `/api/tasks/${id}/…` 的下一步一定是有一处少掉 `/api` 前缀 ——
    // 那正是 §2 分区表最怕的漂移,而它的表现是「页面拿到一份 HTML 却不知道自己为什么红」。
    expect((codeOnly(queriesRaw).match(/\/api\/tasks\//g) ?? []).length).toBe(1);
    expect(codeOnly(queriesRaw)).toContain("export function taskPath");
  });

  it("流侧位置口径与拉侧同单位:坏帧也占一个位置(streamFramesOf 是唯一的算法)", () => {
    expect(codeOnly(taskDetailLibRaw)).toMatch(/return counts\.seen \+ counts\.bad/);
    expect(codeOnly(useTaskTimelineRaw)).toContain("streamFramesOf(stream.counts)");
  });

  it("取数只在 lib/queries.ts:w4b 收拢下半三块后,读法清单恰好七条 apiGet + 一条裸 fetch", () => {
    const code = w4aCode();
    // 说明文字里出现 `GET /api/tasks/:id/result` 等字面量是这一页的诚实形状:说清读不到
    // 什么,才不至于让人以为空格子是没有。真正的越界形状是「有人把它拼出去」——
    // 页面/判定层/hook 里没有任何 I/O 出口(那条路只经由 lib/queries.ts)。
    expect(code).not.toMatch(/apiGet\(|apiPost\(|\bfetch\(/);
    expect(code).not.toMatch(/\/api\/session\//);
    // w2b 三条(session/approvals/列表)+ w4a 两条(快照/events)+ w4b 两条(evidence/candidate)= 7;
    // admin 那三面的调用点仍是一个都没有
    expect((codeOnly(queriesRaw).match(/apiGet\(/g) ?? []).length).toBe(7);
    expect(codeOnly(queriesRaw)).not.toMatch(/\/api\/admin\/(events|attempts|chain-check)/);
    // patch 正文是 text/plain,apiRequest 的介质检查收不了它:queries.ts 里唯一一条裸 fetch,
    // 判定交回 lib 纯函数(judgePatchResponse),介质纪律只在这条字节流上让步。
    expect((codeOnly(queriesRaw).match(/\bfetch\(/g) ?? []).length).toBe(1);
    expect(codeOnly(queriesRaw)).toContain("fetchCandidatePatchRaw");
  });

  it("w4b 判定层(task-deliverables.ts)是纯函数:没有第二条 I/O 出口,截断长度被引用不被再定义", () => {
    const code = codeOnly(taskDeliverablesRaw);
    expect(code).not.toMatch(/\bfetch\(|apiGet\(|apiPost\(|useMutation|new EventSource|addEventListener\(/);
    expect(code).toContain("judgePatchResponse(");
    expect(code).toContain("TEXT_SUMMARY_MAX_CHARS");
    // 拦的是「另立一份常量 200」的赋值;`res.status === 200` 这类裁决分支的比较不算。
    expect(code).not.toMatch(/[^=!<>]=\s*200\b/);
  });
});
