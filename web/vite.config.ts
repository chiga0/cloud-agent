import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * 前端构建基座(w2a)。产物落仓库根的 `dist/`,由 Workers Static Assets 直接托管
 * (wrangler.jsonc 的 assets.directory),所以这里没有 CDN 前缀也没有 base path:
 * 同源单部署单元(docs/product.md §1),部署时不存在「前端指向后端」的配置项。
 *
 * `root`/`outDir` 是相对路径:`root` 相对 cwd(npm scripts 恒为仓库根),
 * `outDir` 相对 root。
 */
export default defineConfig({
  root: "web",
  // @vitejs/plugin-react 必须在 plugins 里,否则上面那行 import 是死的:JSX 仍然会被
  // Vite 自带的转换器编掉(所以 `npm run build` 照样绿),但 dev 期没有 React Fast Refresh ——
  // 改一个组件就整页重载、state 全丢。这类「依赖装了但没接线」的漂移由
  // test/web-build-base.test.ts 钉(它断言这个文件里 react 插件真的被注册)。
  plugins: [react()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // dev 期把 worker 拥有的路径全部转给 `npm run dev`(wrangler dev,缺省 8787)。
    // 路径清单是 wrangler.jsonc `run_worker_first` 的镜像:两边不一致时,vite dev 会把某个
    // API 前缀当成本地路由返回 index.html —— 与线上「漏列 run_worker_first」同形状的故障,
    // 但只在 dev 出现,极难归因。改一边必须改另一边(线上那份由 test/assets-routing.test.ts 钉)。
    proxy: {
      "/api": "http://localhost:8787",
      "/live": "http://localhost:8787",
      "/healthz": "http://localhost:8787",
    },
  },
});
