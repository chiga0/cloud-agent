/**
 * Vite 的 `?raw` 导入(把文件内容当字符串打包进来)。测试用它核对 README 里
 * 登记的端点描述与实际行为不漂移 —— Workers 运行时没有 fs,只能走构建期内联。
 */
declare module "*?raw" {
  const content: string;
  export default content;
}
