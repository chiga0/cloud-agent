import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import {
  createColumnHelper,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";

import { DataTable } from "../components/DataTable";
import { StatusBadge } from "../components/StatusBadge";
import { adminTasksQueryOptions, TASKS_LIST_LIMIT } from "../lib/queries";
import type { ArchivedTask } from "../lib/schema";
import {
  parseTasksFilter,
  STATE_FILTER_OPTIONS,
  tasksEmptyText,
  tasksFailureText,
  tasksFilterFallbackCopy,
  tasksReadNote,
  truncateTaskId,
} from "../lib/tasks-page";
import { stateTone } from "../lib/view";

/**
 * `/` 任务列表(w3 交付:docs/product.md §5 第一行页面 + 同节 2026-09-06 w3 注记)。
 *
 * 数据源是现成端点 `GET /api/admin/tasks`,零后端改动;响应形状照 `src/index.ts` 的
 * `handleAdminTasks` 转写(`{tasks:[{id,state,created_at,updated_at,version}],count}`),
 * 三条口径 —— count 是本次条数、没有游标、只读归档投影 —— 全部写在 `lib/tasks-page.ts`
 * 顶部,页面上每一句话都是那里的一个函数,不在这份文件里现编。
 *
 * 三处刻意的取舍:
 *
 * 1. **取数在组件里 `useQuery`,不在路由 loader 里 `ensureQueryData`**(与 router.tsx 那份
 *    w2b 预告的写法不同,理由在那份注释被随动更新的地方)。这一页的三种状态 —— 还在读、
 *    读到空、读失败 —— 都是**页面内容**而不是页面缺失:把它们塞进 loader,失败就会去渲染
 *    错误边界,而 §5 要的是「失败/空态各有文案」。`defaultPreload: "intent"` 已经让悬停
 *    开始解析与预取,loader 再 gate 一次只多一道会吞文案的关卡。
 * 2. **没有翻页**:服务端只有一句 `LIMIT ?`,没有游标、没有总数。不伪装「加载更多」,
 *    也不伪装页码 —— 读满上限时由 `tasksReadNote` 说出读满了。
 * 3. **排序是本地排序**:只作用于本次读到的那 ≤200 行(口径在页面说明里写明)。
 *    表格的逻辑全在 `@tanstack/react-table`(headless),markup 全在 `DataTable`,
 *    这一份只管列定义与把状态接到 URL 上 —— 那个分工是 §4 选型的全部意义。
 *
 * 需浏览器实测(单测钉不住,§7 的口径):`<select>` 在两套主题下的原生下拉面板配色
 * (靠 theme.css 的 `color-scheme`,不自带样式)、窄屏下五列表格的横向溢出。
 */

/** 读到答复之前的空行。模块级常量:每次渲染新给一个 `[]` 就是每帧重算一遍行模型。 */
const NO_ROWS: ArchivedTask[] = [];

const columnHelper = createColumnHelper<ArchivedTask>();

/**
 * 五列 = §5 点名的清单,顺序即列序。
 *
 * 模块级常量而不是 `useMemo`:列定义每次换身份,表格就把整棵列树重建一遍。
 * 每格都是 `cell` 渲染器 + 一个 `accessor`(排序/取值仍由 react-table 按列的 `id` 做),
 * 业务映射只有一处:state → 色调由 `lib/view.ts` 决定,这里连一档色都不自己算。
 */
const TASK_COLUMNS = [
  columnHelper.accessor("id", {
    header: "id",
    cell: ({ getValue }) => {
      const { shown, full } = truncateTaskId(getValue());
      return <code title={`完整 id:${full}`}>{shown}</code>;
    },
  }),
  columnHelper.accessor("state", {
    header: "state",
    cell: ({ getValue }) => {
      const state = getValue();
      return <StatusBadge tone={stateTone(state)}>{state}</StatusBadge>;
    },
  }),
  columnHelper.accessor("created_at", {
    header: "created_at",
    cell: ({ getValue }) => getValue(),
  }),
  columnHelper.accessor("updated_at", {
    header: "updated_at",
    cell: ({ getValue }) => getValue(),
  }),
  columnHelper.accessor("version", {
    header: "version",
    cell: ({ getValue }) => <span className="ca-num">{getValue()}</span>,
  }),
];

export function TasksIndexPage() {
  // state 一律从「路由校验后的 search」读:组件不第二遍解 URL,否则两份判据必然漂移。
  const search = useSearch({ from: "/_auth/" });
  const location = useLocation();
  const navigate = useNavigate();
  const state = search.state ?? null;

  // 被拒收的原值只能从**校验前**的串里取(zod 已经把它抹掉了)。它是旁注,不参与取数:
  // adminTasksQueryKey 只吃 state,所以两种坏链接指向同一份缓存。
  const rejected = parseTasksFilter(location.searchStr).rejected;

  const query = useQuery(adminTasksQueryOptions(state));
  const rows = query.data?.tasks ?? NO_ROWS;
  const failed = query.isError;
  const readNote = tasksReadNote(query.data);

  const table = useReactTable({
    data: rows,
    columns: TASK_COLUMNS,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  function onFilterChange(value: string) {
    // 写进 URL 之前同样过一遍 parseTasksFilter:下拉的取值本就来自那份合法清单,
    // 但「先校验再写地址栏」这条规矩必须在唯一的那个写入口上成立一次,而不是靠控件类型保证。
    const next = parseTasksFilter({ state: value });
    void navigate({ to: "/", search: next.state === null ? {} : { state: next.state } });
  }

  return (
    <div className="ca-stack">
      <section className="ca-card ca-stack">
        <div className="ca-cluster">
          <h1 className="ca-text-md">任务列表</h1>
          <span className="ca-badge">w3</span>
          <span className="ca-muted ca-text-xs">每 30 秒重读本页</span>
        </div>
        <p className="ca-muted ca-text-xs">
          数据源 <code>{`GET /api/admin/tasks?state=&limit=${TASKS_LIST_LIMIT}`}</code>
          {" —— "}只读投影,读的是 D1 归档的 tasks 表。归档在任务进终态时才发生,
          所以仍在 DO 里运行的任务不会出现在这一页(实时状态是 <code>GET /api/tasks/:id</code>
          ,详情页由 w4 接入)。服务端按 updated_at 降序返回至多 limit 条:
          没有游标可以续读,也没有总数可算页数,所以这一页不放翻页控件;
          表头的排序只作用于本次读到的行。
        </p>
        <div className="ca-cluster">
          <div className="ca-field">
            <label className="ca-label" htmlFor="tasks-state-filter">
              state 过滤(URL 上的 <code>?state=</code>)
            </label>
            <select
              id="tasks-state-filter"
              className="ca-input ca-input--inline"
              // 下拉显示的是**生效**的过滤,不是地址栏里那个串:非法值回落到「全部」之后,
              // 控件与页面必须同口供(不同口供的观测面会让人不再相信任何一面)。
              value={state ?? ""}
              onChange={(event) => onFilterChange(event.target.value)}
            >
              {STATE_FILTER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          {readNote === null ? null : <span className="ca-muted ca-text-xs">{readNote}</span>}
        </div>
        {rejected === null ? null : (
          <p className="ca-error-text">
            {tasksFilterFallbackCopy(rejected)}
            {" —— "}
            <Link to="/" search={{}}>
              按「全部」重读并改掉地址栏
            </Link>
          </p>
        )}
        {failed ? <p className="ca-error-text">{tasksFailureText(query.error)}</p> : null}
      </section>

      <section className="ca-card">
        <DataTable
          table={table}
          loading={query.isPending || query.isFetching}
          emptyText={tasksEmptyText(state, failed)}
          loadingText="正在读取归档任务…"
        />
      </section>
    </div>
  );
}
