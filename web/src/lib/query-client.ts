/**
 * QueryClient 单例(w2b)。
 *
 * 为什么是模块级单例而不是 `useState(() => new QueryClient())`:这个前端的
 * QueryClient 要同时被三个读者拿到 —— 路由的 `context`(loader/guard 里 `ensureQueryData`)、
 * `QueryClientProvider`(组件里的 hook)、登出时的 `clearQueries`。两处各 new 一个就是两份缓存,
 * 表现是「登录后 guard 已经读过 /me,壳还是转一圈」(它读的是另一个 client)。
 *
 * 默认值是**有意保守**的:
 * - `refetchOnWindowFocus: false`:这是运维看板,操作员会频繁切窗口。默认策略下每次聚焦
 *   都重打一遍全部查询,而 §5 的页面自带 30s 节拍 —— 焦点风暴换来的新信息是零,
 *   代价是审批页可能在聚焦瞬间刷掉一个刚点开的确认弹层。
 * - `retry: 1`:同源单部署,一次重试足够覆盖「worker 冷启」这一类瞬时失败;
 *   更多重试只会把「后端在报错」拖成「页面卡了三分钟」。401 由各个查询自己 `retry: false`
 *   接管(见 queries.ts),这条缺省只管没特别声明的查询。
 */

import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
    mutations: {
      retry: 0,
    },
  },
});
