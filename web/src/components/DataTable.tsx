import { flexRender, type Table as TanStackTable } from "@tanstack/react-table";

/**
 * 表格的 markup 层(w2b 交付 ①:React Table v8 headless)。
 *
 * 分工是这套选型的全部意义:
 * - **逻辑**在 `@tanstack/react-table`:排序/过滤/分页/列可见性的状态机与派生行模型。
 *   它不渲染一个字节,所以换它不会改到视觉,改视觉也不会改到判据。
 * - **实例**由页面自己 `useReactTable({ columns, data, ... })` 造出来(w3 的活:列定义、
 *   state 过滤、游标「加载更多」都是页面的业务,不是这个组件的知识)。
 * - **本组件**只把实例画成一张带 token 的 `<table>`:表头可排序、`aria-sort` 说得出方向、
 *   空态与「还在读」是两句话。
 *
 * 因此这里刻意**不**做任何业务映射:状态→颜色由列渲染器调 lib/view.ts 给
 * (`cell: ({ getValue }) => <StatusBadge tone={stateTone(getValue())} />`)。本组件连
 * `state` 这个字都不认识 —— 认识它就等于把「表格」与「任务列表」焊死,而审批表、审计表
 * 还要各用一次它。
 *
 * 这里不放任何翻页控件,一整个原因是服务端根本没有可翻的东西:`/api/admin/tasks` 只有一句
 * `LIMIT ?`,响应体里只有 `{tasks, count}` —— 没有游标可以续读,也没有总数可以算页数。
 * 伪装一个「加载更多」就是承诺一个做不到的动作,伪装页码更是拿一个不存在的总数做分母。
 * 读满上限时怎么说,由页面侧的 `lib/tasks-page.ts` 的 `tasksReadNote` 负责(§5 的 2026-09-06
 * w3 注记已把旧的「游标『加载更多』」设想作废,理由同上)。
 */
export function DataTable<TData>({
  table,
  loading = false,
  emptyText = "没有匹配的行。",
  loadingText = "正在读取…",
}: {
  table: TanStackTable<TData>;
  /** 页面自己的读态(Query 的 isPending/isFetching)。表格实例不知道网络上发生了什么。 */
  loading?: boolean;
  emptyText?: string;
  /** 一行都没有**且仍在读**时的文案。与空态分开:「还没有」与「确实没有」是两个结论。 */
  loadingText?: string;
}) {
  const rows = table.getRowModel().rows;
  const leafColumnCount = table.getVisibleLeafColumns().length;

  return (
    <table className="ca-table">
      <thead>
        {table.getHeaderGroups().map((headerGroup) => (
          <tr key={headerGroup.id}>
            {headerGroup.headers.map((header) => {
              const canSort = header.column.getCanSort();
              const sorted = header.column.getIsSorted();
              return (
                <th
                  key={header.id}
                  // aria-sort 只在实际排序时出现:给每个 th 都写 "none" 会让读屏器把一张
                  // 静态表也念成「可排序」,那是噪音而不是信息。
                  aria-sort={
                    sorted === false ? undefined : sorted === "asc" ? "ascending" : "descending"
                  }
                  colSpan={header.colSpan}
                >
                  {header.isPlaceholder
                    ? null
                    : canSort
                      ? (
                          <button
                            type="button"
                            className="ca-sort-btn"
                            onClick={header.column.getToggleSortingHandler()}
                            title="点击切换排序方向"
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {sorted === "asc" ? " ▲" : sorted === "desc" ? " ▼" : " ↕"}
                          </button>
                        )
                      : flexRender(header.column.columnDef.header, header.getContext())}
                </th>
              );
            })}
          </tr>
        ))}
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={leafColumnCount} className="ca-muted">
              {loading ? loadingText : emptyText}
            </td>
          </tr>
        ) : (
          rows.map((row) => (
            <tr key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
              ))}
            </tr>
          ))
        )}
      </tbody>
      <caption className="ca-muted ca-text-xs">
        {`读入 ${table.getPreFilteredRowModel().rows.length} 行 · 显示 ${rows.length} 行`}
      </caption>
    </table>
  );
}
