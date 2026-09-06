import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";

import { queryClient } from "./lib/query-client";
import { createAppRouter } from "./router";

/**
 * 前端入口的装配(w2b):两个 Provider,没有第三样。
 *
 * 顺序即依赖方向:`QueryClientProvider` 在外,`RouterProvider` 在内。
 * 路由的 loader/guard 通过 **context** 拿 queryClient(见 router.tsx 的 RouterContext),
 * 组件通过 Provider 拿同一个实例。反过来接不会报错,但 `useQueryClient()` 会在路由层
 * 拿到 undefined —— 那是最费时间查的一类「装配顺序」bug。
 *
 * router 与 queryClient 都是模块级单例(理由见 lib/query-client.ts):两处各 new 一份的
 * 后果不是内存,是「同一份数据两个真相」—— guard 已经读到 /me 了,壳还在那儿转圈。
 *
 * w2a 那份「前端基座壳」首页(产品名 + 状态说明 + 主题切换)到此不再是首页:
 * `/` 现在是任务列表的位置(内容由 w3 接入),壳与品牌挪进 components/AuthedLayout.tsx,
 * 主题切换跟着挪到右上角。worker 侧那个 `/` 落地页(landingHtml)在同一棒退役(§4)。
 */
const router = createAppRouter(queryClient);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
