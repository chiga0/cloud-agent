/**
 * Vite 的 `?raw` 导入(把文件内容当字符串打包进来)。测试用它核对 README 里
 * 登记的端点描述与实际行为不漂移 —— Workers 运行时没有 fs,只能走构建期内联。
 */
declare module "*?raw" {
  const content: string;
  export default content;
}

/**
 * `import.meta.glob` 的构建期内联(Vite 的 glob 导入)。给一个**整目录**的原文做契约扫描
 * 时必须用它:手抄文件清单会漏掉将来新增的文件,而「漏掉」恰好是这类纪律测试唯一危险的
 * 失效模式 —— 清单式扫描对新文件永远绿。
 * 只声明本项目用到的那一种形状(eager + `?raw` + `import: "default"`)。
 */
interface ImportMeta {
  glob<T = string>(
    patterns: string | string[],
    options?: {
      query?: string;
      import?: string;
      eager?: boolean;
    },
  ): Record<string, T>;
}

