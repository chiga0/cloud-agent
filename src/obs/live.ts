/**
 * Live UI —— 在途事件时间线的**人眼端**(四层可观测架构第④层的下半)。
 *
 * 定位:与 §9.6 的 SSE 投影一样,这是**投影,非权威**,而且比它更下游一层 —— 本模块
 * 只生成一个 HTML 字符串,一个字节都不写、不做任何判定、不做任何处置(那是 Supervisor
 * 那一层的事)。数据的唯一来源仍是 `GET /api/tasks/:id/events/stream`。
 *
 * 为什么需要单独一个「给人看」的页面,而不是让运维 `curl -N` 那条流:
 * 悬挂的真实标本 C2-r6 是**单次模型调用挂了 24 分钟**,当时靠人工 tail 才发现。人眼
 * 无法从滚动的 NDJSON 里量出「距离上一条事件过了多久」—— 而「多久」正是这件事唯一的
 * 判据。所以本 UI 的核心价值不是渲染事件,而是**把停滞时长变成一个会自己涨的数字**,
 * 并在越过阈值时改变颜色。两条时间源、两个说法(c10b 起重标定):
 * **红 = 连每轮无条件写的那条心跳都没了** ⇒ runner 自己停了,高置信;
 * **黄 = 心跳在而模型静默** ⇒ 可能只是一件不产字的长活,所以这一条永不判红。
 * 按这个标尺 C2-r6 那次悬挂**不会亮红**:挂的是容器里的单次模型调用,poll 相每轮照常
 * 返回快照 ⇒ 心跳不断。它在静默 900s(15 分钟)后亮黄 —— 比旧文案宣称的「5 分钟必红」慢,
 * 这是**用检出的时延换精度**:旧红线建立在「新数据每 30s 推进一次」上,而 prod 实测一个
 * 健康 writer 静默过 576s,那条红线早就在对健康任务误报。代价换到的东西同样要说清:
 * 「runner 停了」这个判据在旧的单时间源下**根本表达不出来**。
 * 阈值仍是**产品的判定标准**而不是样式参数,但它**不再写在本文件里**:
 * 两个秒数派生自 src/supervisor/detect.ts 的那对常量(÷1000),推导算式与实测来源只在
 * docs/architecture.md §9.8 出现一次 —— 「本页自带一份理由」正是旧数字被证伪却没人发现的原因。
 *
 * 三条实现约束决定了形态:
 *
 * 1. **全内联、零依赖、无构建步骤**(CSS/JS 都在这一个字符串里)。两个理由:
 *    (a)可测性 —— 页面是纯函数的字符串产物,单测可以直接 `toContain` 钉住契约
 *    (阈值数字、EventSource、流路径、kind 徽章清单),不需要起浏览器;
 *    (b)离线可用 —— 这是故障时最后还要打开的页面。引 CDN 等于让「观测面」依赖
 *    一个与故障无关的外部可用性,而外部资源加载失败会让页面**看起来**是坏的,
 *    正好在最需要它的时刻最不可信。
 * 2. **taskId 必须转义**。它来自 URL 路径,会同时进 HTML 文本节点和 JS 字面量两个
 *    上下文 —— 一个上下文一个转义规则,混用就是 XSS。详见 escapeHtmlText /
 *    scriptJsonString 上方注释。
 * 3. **数据一律 textContent 落地,绝不用 innerHTML 拼**。payload.text 装的是 agent
 *    的任意自由文本(已在 ingress 过白名单脱敏,但脱敏不是转义:它管的是「不该出现的
 *    值」,管不了「看起来像标记的字符」)。
 *
 * ⚠️ **已知的部署侧前提(可达性本期刻意不解决,见 index.ts 的 handleLivePage 注释)**:
 * `EventSource` 按规范**不能**携带 `Authorization` 头,而 §9.6 那条流的鉴权只认这个头。
 * prod 无凭据直开本页面因此得到 **401**,而 401 下的 `onerror` 与网络断连**是可区分的**:
 * 判据是 `es.readyState`(实测 401 → 2/CLOSED 且永不重连,拒连 → 0/CONNECTING 且每 3s 重连,
 * 详见下方 `LIVE_CONN_RULES` 的注释)。本模块据此给两个分支两个文案 —— 页面对「会不会重连」
 * 这句话必须说实话。本模块不改 SSE 端点的任何行为(本期硬约束),也不引入任何临时凭据出口。
 */

import { OBS_EVENT_KINDS, OBS_HEARTBEAT_KIND } from "./events";
import { AGENT_SILENT_YELLOW_MS, NO_HEARTBEAT_RED_MS } from "../supervisor/detect";

/**
 * 停滞阈值(秒)。**这里不再有独立的数字,也不再有独立的理由** —— 一律派生自
 * src/supervisor/detect.ts 里的那份判据(推导算式与实测来源都在那里)。
 *
 * 为什么必须共用一份:这两个数字与 Supervisor 的判据回答的是同一个问题(「什么算异常」)。
 * 从前它们是一份数字、两处字面量、两段理由,于是「摄取节拍每 30s 一次」这个错误前提被
 * 抄了两遍 —— 而 prod 实测一个**健康** writer 静默过 576s,也就是说旧页面早就在对健康
 * 任务准备误报。观测面互相矛盾时,人会不再相信任何一面。
 *
 * - danger(红)= `no_heartbeat`:**runner 停了** —— 每轮无条件写的那条心跳也没了。
 * - warn(黄)= `agent_silent`:**模型沉默但 runner 活着** —— 永远只是黄,页面也不许把
 *   它说成红(理由见 detect.ts 文件头第 3 条)。
 */
export const LIVE_STALL_WARN_SECONDS = AGENT_SILENT_YELLOW_MS / 1000;
export const LIVE_STALL_DANGER_SECONDS = NO_HEARTBEAT_RED_MS / 1000;

/**
 * 摘要显示上限(字符)。journal 里 payload.text 最长 2048(OBS_TEXT_MAX_CHARS),
 * 一屏时间线放不下也不需要放下:这里只做**显示**截断并标注原始长度,数据本身不动 ——
 * 要看全文有 `/api/tasks/:id/events`(以及 transcript 端点)。
 */
export const LIVE_TEXT_SUMMARY_MAX_CHARS = 200;

/**
 * 页面唯一的数据源。与 SSE 端点同一条路径、同一个位置游标口径(帧 id → Last-Event-ID)。
 *
 * 路径必须挂 /api/*:API 在 /api/* 是因为 SPA fallback 会吞掉一切未匹配路径(w2 起
 * 未匹配的 GET 返回 index.html 而不是 404),而这个注入点是页面唯一的流地址出口 ——
 * 这里漏改在 w2 之前**完全不可见**(路径仍自洽),之后才表现为「Live 页拿不到流但
 * HTTP 200」。由 test/api-prefix.test.ts 钉住产出以 /api/ 开头。
 */
export function liveStreamPath(taskId: string): string {
  // 路径段按 URL 编码:taskId 合法形状是 UUID(编码后逐字不变),但本函数是导出的
  // 纯函数,不能假设调用方只喂合法值 —— 未编码的 `?`/`#`/`/` 会把流 URL 改道。
  return `/api/tasks/${encodeURIComponent(taskId)}/events/stream`;
}

/**
 * HTML **文本节点**的转义。`&` 必须最先替换,否则后续替换出的 `&lt;` 会被二次替换成
 * `&amp;lt;`(转义函数最经典的一个错)。
 *
 * 为什么连单引号/双引号一起转:`/live/:taskId` 的路由正则目前只放行 [0-9a-f-]{36},
 * 畸形 id 根本进不来。但 renderLivePage 是导出函数,契约不能建立在「调用方的正则
 * 恰好够用」上 —— 下一棒放宽路由、或别处复用本函数,就会得到一个静默的注入点。
 * 转义在这里是便宜的纵深防御,不转义是贵的漏洞。
 */
export function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 把字符串安全地嵌进 **`<script>` 内部的 JS 字面量**。
 *
 * 与 escapeHtmlText 是两件不同的事,不能用同一个函数糊过去:script 元素的内容不是
 * HTML 文本节点,`&lt;` 在那里不会还原成 `<`。真正的杀手是 `</script>` —— 它会提前
 * 闭合标签,后面的 JS 全部变成 HTML,这是最典型的一类注入。JSON.stringify 不转义
 * `<`/`>`/`&`,所以还要显式换成 `\u003c` 形式;U+2028/U+2029 对 HTML 合法、对 JSON
 * 合法,历史上对 JS 源码的字面量非法(ES2019 起合法,但页面可能被老引擎打开),一并换掉
 * —— 与 obs/stream.ts 的 sseData() 同一个理由。
 *
 * 入参是 `unknown` 而非 `string`:页面向来注入两类值 —— 流路径是字符串,连接文案表是数组。
 */
function scriptJsonValue(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function scriptJsonString(value: string): string {
  return scriptJsonValue(value);
}

/** kind 徽章清单:唯一权威仍是 OBS_EVENT_KINDS,这里只派生,不留第二份列表。 */
const KINDS: readonly string[] = OBS_EVENT_KINDS;

/**
 * `EventSource.readyState` 的三个取值(WHATWG 冻结的常数)。
 *
 * 为什么在这里写数值而不是引用 `EventSource.CLOSED`:分支判定必须能在 vitest 里当纯函数跑,
 * 那个环境没有 `EventSource` 全局;而 0/1/2 是规范常数、不是实现细节。浏览器侧比较的也是
 * 数值,两侧共用下面那张表 —— 所以常数只有一份。
 */
export const ES_READY_STATE_CONNECTING = 0;
export const ES_READY_STATE_OPEN = 1;
export const ES_READY_STATE_CLOSED = 2;

/** 连接状态提示的一条分支规则(是数据不是代码:页面里的 JS 与下面的纯函数读同一份)。 */
export interface LiveConnRule {
  /** 匹配的 `es.readyState`;`null` = 兜底分支(取值不在预期内) */
  readonly readyState: number | null;
  readonly prefix: string;
  readonly suffix: string;
  /** 中间插哪个计数器。`null` = 这条分支不承诺任何次数,因此不显示数字。 */
  readonly counter: "reconnects" | "readyState" | null;
  /**
   * 这条分支是否意味着浏览器**真的**还会自己重连。只有 true 时 `reconnects` 才 +1、
   * 计数行才显示「重连 N 次」—— 否则那个数字本身就成了第二处谎。
   */
  readonly reconnecting: boolean;
}

/**
 * 分支表。**顺序即语义**:线性扫描 + 末尾兜底,所以 `readyState: null` 只能出现在最后
 * (下面用模块级检查钉住 —— 写错顺序会在导入时就炸,而不是静默地把 401 文案派给断连)。
 *
 * 为什么 CLOSED 与 CONNECTING 必须是两个文案(2026-09-03 浏览器实测,同一 42s 窗口并排探
 * 两条流,用 readyState 探针):
 * - **HTTP 401** → `onerror` 只触发 **1 次**(dt≈1ms)、最终 `readyState === 2`(CLOSED)、
 *   浏览器**永不重连**;
 * - **网络失败(拒连)** → `onerror` **每 ~3000ms 一次**、最终 `readyState === 0`(CONNECTING)、
 *   每 3s 真重连。
 * 两个形状在旧页面上长得一模一样(都停在「正在自动重连(第 1 次)」),而 401 那条永远不会
 * 再动 —— 沿用同一句文案等于向操作员承诺一件已证明不会发生的事,他会白等。
 */
export const LIVE_CONN_RULES: readonly LiveConnRule[] = [
  {
    readyState: ES_READY_STATE_CLOSED,
    prefix:
      "连接已关闭,浏览器不会自动重连 —— 最常见原因是鉴权失败(401):EventSource 无法携带 Authorization 头," +
      "而这条流只认那个头。浏览器直开需要产品化会话方案(规划中,本期刻意不引入临时凭据出口);" +
      "当前可用带凭据的 API 客户端访问流端点(curl -N 加 authorization 头,见下方说明)。",
    suffix: "",
    counter: null,
    reconnecting: false,
  },
  {
    readyState: ES_READY_STATE_CONNECTING,
    prefix: "连接中断,浏览器正在自动重连(第 ",
    suffix: " 次)",
    counter: "reconnects",
    reconnecting: true,
  },
  {
    readyState: null,
    prefix: "连接异常且状态未知(readyState=",
    suffix: "):不承诺自动重连,也不承诺已关闭 —— 请用带凭据的 API 客户端对照。",
    counter: "readyState",
    reconnecting: false,
  },
];

if (LIVE_CONN_RULES.some((r, i) => r.readyState === null && i !== LIVE_CONN_RULES.length - 1)) {
  // 大声失败:兜底分支不在末尾时它会先命中并吃掉所有具体分支 —— 那是静默的文案错配。
  throw new Error("live_conn_rules_fallback_not_last");
}

/** 一次 `onerror` 该显示什么、该不该算作一次重连。 */
export interface LiveConnView {
  readonly text: string;
  readonly reconnecting: boolean;
}

function matchConnRule(readyState: number): LiveConnRule {
  for (const rule of LIVE_CONN_RULES) {
    if (rule.readyState === readyState) return rule;
  }
  return LIVE_CONN_RULES[LIVE_CONN_RULES.length - 1]!;
}

/**
 * 纯函数:`onerror` 的分支判定。
 *
 * 判据为什么是 `readyState` 而不是「error 事件出现了几次」:实测的区分度全部在 readyState 上
 * (401 → 2,拒连 → 0);事件次数只是它的副产物,而且 401 与断连的**第一次**都恰好是 1 次 ——
 * 拿次数当判据必然把 401 误判成「正在重连」。
 *
 * 页面里的 JS 做同一件事(读同一张 LIVE_CONN_RULES)。之所以不把本函数 `toString()` 内联进
 * 页面:部署经 esbuild 压缩,函数体不是可读的内联脚本,而这张表才是唯一权威 ——
 * 文案与分支归属改一处即可生效于两侧。
 */
export function liveConnectionView(readyState: number, reconnects: number): LiveConnView {
  const rule = matchConnRule(readyState);
  const middle =
    rule.counter === "reconnects"
      ? String(reconnects)
      : rule.counter === "readyState"
        ? String(readyState)
        : "";
  return { text: rule.prefix + middle + rule.suffix, reconnecting: rule.reconnecting };
}

const CSS = `
  :root { color-scheme: dark; }
  body { font-family: -apple-system, "SF Mono", Menlo, Consolas, monospace; background:#0b0f14; color:#e6edf3; margin:0; padding:0 0 48px; }
  header { position:sticky; top:0; z-index:2; background:#0b0f14; border-bottom:1px solid #30363d; padding:14px 20px; }
  main { padding:0 20px; }
  h1 { font-size:15px; margin:0 0 10px; color:#8b949e; font-weight:600; letter-spacing:.04em; }
  h1 code { color:#e6edf3; font-size:14px; }
  .row { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
  .badge { border-radius:999px; padding:2px 9px; font-size:12px; border:1px solid #30363d; background:#161b22; color:#c9d1d9; white-space:nowrap; }
  .pill { border-radius:6px; padding:4px 10px; font-size:13px; border:1px solid #30363d; background:#161b22; }
  .stall { font-variant-numeric:tabular-nums; font-weight:700; }
  .stall.warn { background:#3d2f00; border-color:#9c6d00; color:#ffd866; }
  .stall.danger { background:#4b0d0d; border-color:#d1242f; color:#ff9b9b; animation:blink 1.2s step-end infinite; }
  .stall.done { color:#8b949e; font-weight:400; }
  .conn.bad { background:#4b0d0d; border-color:#d1242f; color:#ff9b9b; }
  .conn.good { color:#7ee787; }
  @keyframes blink { 50% { border-color:#ff7b72; } }
  .legend { margin-top:10px; display:flex; flex-wrap:wrap; gap:6px; }
  .legend .badge { font-size:11px; }
  ol { list-style:none; margin:14px 0 0; padding:0; }
  .ev { display:flex; gap:10px; align-items:baseline; border-bottom:1px solid #161b22; padding:7px 2px; }
  .ev .seq { color:#6e7681; font-size:12px; min-width:4.5em; text-align:right; font-variant-numeric:tabular-nums; }
  .ev .ts { color:#6e7681; font-size:12px; white-space:nowrap; }
  .ev .body { flex:1; min-width:0; overflow-wrap:anywhere; font-size:13px; }
  .ev .extra { color:#8b949e; font-size:12px; }
  .ev .note { color:#d2a8ff; font-size:12px; }
  .k-system { border-color:#3d4b5c; color:#a9c1d9; }
  .k-assistant { border-color:#2a5b3a; color:#7ee787; }
  .k-user { border-color:#5b3a75; color:#d2a8ff; }
  .k-tool_use { border-color:#21548f; color:#79b8ff; }
  .k-tool_result { border-color:#1f5f5f; color:#73d3d3; }
  .k-result { border-color:#2a5b3a; color:#0b0f14; background:#7ee787; font-weight:700; }
  .k-error { border-color:#d1242f; color:#ffb3ad; background:#4b0d0d; font-weight:700; }
  .k-raw { border-style:dashed; color:#8b949e; }
  /* runner 心跳:每轮一条、不是模型行为,所以刻意做成最不起眼的一类(细虚线 + 灰)。
     时间线上它的作用是「证明这一分钟有人在数」,不是内容。 */
  .k-heartbeat { border-style:dotted; color:#6e7681; background:#11161d; }
  .ev[data-kind="result"] { background:#0f1d13; }
  .ev[data-kind="error"] { background:#1d0f0f; }
  .ev[data-kind="result"] .body, .ev[data-kind="error"] .body { font-weight:600; }
  .notice { margin:12px 0 0; padding:10px 12px; border:1px solid #9c6d00; background:#2d2600; border-radius:8px; font-size:13px; }
  .empty { color:#6e7681; margin-top:14px; font-size:13px; }
`;

/**
 * 客户端脚本。两点写法上的自律(都是为了「字符串生成 HTML」这条路不出事):
 * - 不用模板字面量、不出现 `${`:整段 JS 嵌在 TS 的模板字面量里,`\${` 的转义一旦
 *   走偏就是静默的语法错误;拼接字符串更啰嗦但不给这种错留位置。
 * - 所有来自流的数据一律走 textContent(见 renderEvent),不 innerHTML。
 */
const JS = `
(function () {
  "use strict";
  var STREAM_URL = __STREAM_URL__;
  var STALL_WARN_SECONDS = __STALL_WARN__;
  var STALL_DANGER_SECONDS = __STALL_DANGER__;
  // 心跳 kind 的名字由服务端注入:页面与 journal 用的是同一份权威常量(OBS_HEARTBEAT_KIND),
  // 在这里再写一遍字面量 "heartbeat" 就等于给「改名」留一个静默失效点。
  var HEARTBEAT_KIND = __HEARTBEAT_KIND__;
  var TEXT_MAX = __TEXT_MAX__;
  var KINDS = __KINDS__;
  var CONN_RULES = __CONN_RULES__;

  var stallEl = document.getElementById("stall");
  var connEl = document.getElementById("conn");
  var stateEl = document.getElementById("state");
  var countEl = document.getElementById("counts");
  var listEl = document.getElementById("tl");
  var emptyEl = document.getElementById("empty");

  var lastEventMs = null;   // 最新一条**可解析**事件到达时刻(浏览器本地钟)
  // 最新一条**行为**(非心跳)事件到达时刻。与上一条分开计时是本模块 c10b 起的要点:
  // 「没有新转录」既可能是 agent 挂了,也可能是它在干一件不产字的长活(实测一个健康
  // writer 静默 576s),只有心跳这条独立时间源能把两者分开。
  var lastBehavioralMs = null;
  // 页面打开即计时:「一直没有事件」与「事件停了」是同一个故障的两种形状(C2-r6 若发生
  // 在首轮摄取之前,就是前者),所以缺了一条事件也不能把计时器灰在那儿不动 —— 那正好
  // 把最需要看的时间藏起来。参考点退回到打开页面的时刻,数字照旧自增、阈值照旧变色。
  var startMs = Date.now();
  var ended = false;
  var seen = 0;
  var bad = 0;
  var reconnects = 0;

  // onerror 的分支判定。与 TS 侧的 liveConnectionView 读同一张 CONN_RULES(由服务端注入),
  // 所以文案与「这条分支算不算真会重连」只有一处定义。
  // ⚠️ 此处需浏览器实测:规则本身是 2026-09-03 实测出来的(401 → readyState 2 且不重连;
  // 拒连 → readyState 0 且每 3s 一次),但「浏览器真的把这段 JS 跑出这个形状」单测钉不住。
  function connView(readyState, reconnectCount) {
    for (var i = 0; i < CONN_RULES.length; i++) {
      // 兜底规则的 readyState 是 null,任何数值都不等于它,所以它天然只在末尾被走到
      // (顺序由服务端那张表保证,写错会在导入时就抛 live_conn_rules_fallback_not_last)。
      if (CONN_RULES[i].readyState === readyState || CONN_RULES[i].readyState === null) {
        var r = CONN_RULES[i];
        var middle = r.counter === "reconnects" ? String(reconnectCount)
          : r.counter === "readyState" ? String(readyState) : "";
        return { text: r.prefix + middle + r.suffix, reconnecting: r.reconnecting };
      }
    }
    return { text: "连接状态未知", reconnecting: false };
  }

  function kindClass(kind) {
    // 未知 kind 落中性徽章:CSS 类名只能来自白名单,不能让 payload 决定类名。
    return KINDS.indexOf(kind) >= 0 ? kind : "";
  }

  function summarize(text) {
    var flat = text.replace(/\\s+/g, " ").trim();
    if (flat.length <= TEXT_MAX) return { shown: flat, note: "" };
    return {
      shown: flat.slice(0, TEXT_MAX),
      note: "… 已截断(全文 " + flat.length + " 字符,看 /api/tasks/id/events)",
    };
  }

  function renderEvent(ev) {
    if (emptyEl && emptyEl.parentNode) emptyEl.parentNode.removeChild(emptyEl);
    var li = document.createElement("li");
    var kind = typeof ev.kind === "string" ? ev.kind : "?";
    li.className = "ev";
    li.setAttribute("data-kind", kindClass(kind));

    var seq = document.createElement("span");
    seq.className = "seq";
    seq.textContent = typeof ev.seq === "number" ? String(ev.seq) : "?";

    var badge = document.createElement("span");
    badge.className = "badge" + (kindClass(kind) ? " k-" + kindClass(kind) : "");
    badge.textContent = kind;

    var ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = typeof ev.ts === "string" ? ev.ts : "";

    var body = document.createElement("span");
    body.className = "body";
    var payload = ev.payload && typeof ev.payload === "object" ? ev.payload : {};
    if (typeof payload.text === "string" && payload.text.length > 0) {
      var s = summarize(payload.text);
      body.textContent = s.shown;
      if (s.note) {
        var note = document.createElement("span");
        note.className = "note";
        note.textContent = " " + s.note;
        body.appendChild(note);
      }
    } else {
      body.textContent = "";
    }

    li.appendChild(seq);
    li.appendChild(badge);
    li.appendChild(ts);
    li.appendChild(body);

    var extra = document.createElement("span");
    extra.className = "extra";
    if (kindClass(kind) === "tool_use" && Array.isArray(payload.tool_names)) {
      extra.textContent = "tools: " + payload.tool_names.map(String).join(", ");
    } else if (kindClass(kind) === "raw" && typeof payload.raw_type === "string") {
      extra.textContent = "raw_type: " + payload.raw_type;
    }
    var usage = payload.usage && typeof payload.usage === "object" ? payload.usage : null;
    if (usage && typeof usage.total_tokens === "number") {
      extra.textContent = (extra.textContent ? extra.textContent + " · " : "") +
        "tokens: " + usage.total_tokens;
    }
    if (extra.textContent) li.appendChild(extra);

    listEl.appendChild(li);
    // 时间线自动滚到底:人盯的就是「最新一条」,但它只是便利,不是判据。
    window.scrollTo(0, document.body.scrollHeight);
  }

  function onEnd(data) {
    ended = true;
    stallEl.className = "pill stall done";
    stallEl.textContent = "流已结束" +
      (data && typeof data.events === "number" ? "(共 " + data.events + " 条)" : "") +
      " —— 任务已离开 RUNNING";
    connEl.className = "pill conn good";
    connEl.textContent = "流已结束";
    // end 帧只证明「已非 RUNNING」(泵的唯一终止条件),给不出具体终态:
    // 权威终态要读 GET /api/tasks/:id。这里如实标注,不猜。
    stateEl.textContent = "state: 非 RUNNING(精确值见 GET /api/tasks/:id)";
  }

  function accept(raw, kindOfFrame) {
    if (kindOfFrame === "end") {
      var end = null;
      try { end = JSON.parse(raw); } catch (e) { end = null; }
      onEnd(end);
      return;
    }
    var ev = null;
    try {
      ev = JSON.parse(raw);
    } catch (e) {
      ev = null;
    }
    // 防御性解析:一条坏帧**绝不能**让整页停更 —— 跳过并计数显示。
    // 为什么可能出坏帧:流上除了事件帧还有终止帧与注释帧,而未来加 kind/字段
    // (AgentEventV1.v 演进)时,老页面必须先能读懂它才能继续盯停滞。
    if (!ev || typeof ev !== "object" || typeof ev.kind !== "string") {
      bad += 1;
      showCounts();
      return;
    }
    seen += 1;
    lastEventMs = Date.now();
    // 心跳也算「runner 活着」的那条时间源(它本身就是为此存在的),
    // 但绝不能算进「模型在动」那条 —— 否则静默计时永远归零,agent_silent 形同虚设。
    if (ev.kind !== HEARTBEAT_KIND) lastBehavioralMs = Date.now();
    renderEvent(ev);
    showCounts();
  }

  function showCounts() {
    var parts = ["事件 " + seen + " 条"];
    if (bad > 0) parts.push("坏帧 " + bad + " 条(已跳过)");
    if (reconnects > 0) parts.push("重连 " + reconnects + " 次");
    countEl.textContent = parts.join(" · ");
  }

  function tick() {
    if (ended) return;
    var nowMs = Date.now();
    // 两条时间源、两个说法 —— 这是 c10b 对用户最有用的可见差异:
    // 红只说「runner 停了」(连每轮无条件写的心跳都没了),
    // 黄只说「模型沉默但 runner 活着」(心跳还在跳,只是没有新转录)。
    var beatSecs = Math.floor((nowMs - (lastEventMs === null ? startMs : lastEventMs)) / 1000);
    var quietSecs = Math.floor((nowMs - (lastBehavioralMs === null ? startMs : lastBehavioralMs)) / 1000);
    if (beatSecs > STALL_DANGER_SECONDS) {
      stallEl.textContent = "心跳停止 " + beatSecs + "s(runner 停了)";
      stallEl.className = "pill stall danger";
      return;
    }
    if (quietSecs > STALL_WARN_SECONDS) {
      stallEl.textContent = "模型静默 " + quietSecs + "s(runner 活着)";
      stallEl.className = "pill stall warn";
      return;
    }
    // 「最后事件」这个字样必须真的在跟新到的事件说话:还没有事件时说的是「等开了页多久」。
    stallEl.textContent = lastEventMs === null
      ? "尚未收到事件(已等 " + beatSecs + "s)"
      : "最后事件 " + beatSecs + "s 前";
    stallEl.className = "pill stall";
  }

  // 每秒自增:停滞时长必须是**在跑的钟**,不能只在事件到达时刷新 —— 恰恰在悬挂
  // 的时候没有事件来触发刷新,而那一刻正是唯一需要它的时刻。
  tick();
  setInterval(tick, 1000);

  // 选 SSE 的决定性理由之一:**网络类**断线由浏览器按标准自动重连,并把最后看到的帧 id 原样
  // 回传成 Last-Event-ID。而帧 id 与 GET /events 的 ?after= 是同一个口径(§9.6 不变量 1),
  // 所以重连既不重发也不漏读 —— UI 这一侧一行续传代码都不用写。
  // 但这条只覆盖 CONNECTING 那一支:HTTP 层的致命错(401)浏览器**根本不重连**(实测见下方
  // onerror 的注释),所以「它会自己重连」不能当成整页的前提。
  var es = new EventSource(STREAM_URL);

  es.addEventListener("agent", function (e) { accept(e.data, "agent"); });
  es.addEventListener("end", function (e) { accept(e.data, "end"); });
  // 匿名 data 帧(不带 event:)也收下,别默默丢。
  es.onmessage = function (e) { accept(e.data, "message"); };

  // onerror 必须**可见**,而且必须**按分支可见**。EventSource 的 error 事件有两种完全不同的
  // 形状(2026-09-03 浏览器实测):HTTP 401 → 只触发一次、readyState 停在 2(CLOSED)、浏览器
  // 永不重连;网络失败(拒连)→ 每 ~3000ms 一次、readyState 停在 0(CONNECTING)、真的自动重连。
  // 旧代码不分枝地显示「正在自动重连(第 1 次)」并永久停在同一句上 —— 那是承诺一件不会发生的
  // 事,操作员会白等。断流与悬挂在页面上本来就长得一样(都不出事件),提示再说谎就等于把
  // 唯一的线索也毁掉。
  // ⚠️ 此处需浏览器实测:分支判据与文案由单测钉住(liveConnectionView 的两条分支),
  // 浏览器真实派发 error 事件时的形态只能实测。
  es.onerror = function () {
    if (ended) return;
    var view = connView(es.readyState, reconnects + 1);
    // 只有浏览器真会重连时才把这一次记进「重连 N 次」—— 否则计数行是第二处谎。
    if (view.reconnecting) {
      reconnects += 1;
      showCounts();
    }
    connEl.className = "pill conn bad";
    connEl.textContent = view.text;
  };
  es.onopen = function () {
    if (ended) return;
    connEl.className = "pill conn good";
    connEl.textContent = "已连接" + (reconnects > 0 ? "(重连过 " + reconnects + " 次)" : "");
  };
})();
`;

export interface RenderLivePageOptions {
  /**
   * 页面加载那一刻的任务状态(来自 `getSnapshot()`,与 `GET /api/tasks/:id` 同源)。
   * 传 null/undefined 表示不预置:徽章显示「未知」,由页面自己从 end 帧推断收尾。
   */
  state?: string | null;
}

/**
 * 生成 Live UI 页面(纯函数:同样的入参出同样的字节,不碰 env、不发请求)。
 *
 * 服务端**只渲染骨架**:任务 id、state 徽章初值、阈值常量、kind 徽章清单。事件内容
 * 一律由浏览器的 EventSource 拉 —— 服务端渲染首批事件会把位置游标(帧 id)与服务端的
 * 一次 journal 读绑进 HTML,而页面活着的时间远长于那次读的一致性窗口,得不偿失。
 */
export function renderLivePage(taskId: string, opts: RenderLivePageOptions = {}): string {
  if (typeof taskId !== "string" || taskId.length === 0) {
    // 大声失败:空 id 会生成一条指向 /api/tasks//events/stream 的流,页面看起来「活着」
    // 却永远不出事件 —— 那是最难查的一种坏(它不报错)。
    throw new Error(`live_bad_task_id ${JSON.stringify(taskId)}`);
  }
  const displayId = escapeHtmlText(taskId);
  const state = typeof opts.state === "string" && opts.state.length > 0 ? opts.state : "unknown";
  const kindsLiteral = `[${KINDS.map((k) => scriptJsonString(k)).join(",")}]`;
  // 替换值一律用函数形式:字符串形式的 replace 会把替换串里的 `$&`/`$1` 当模式解释,
  // 而注入进去的正是外部输入(taskId 里出现 `$` 就会得到一段被悄悄改写的 JS)。
  const script = JS.replace("__STREAM_URL__", () => scriptJsonString(liveStreamPath(taskId)))
    .replace("__STALL_WARN__", () => String(LIVE_STALL_WARN_SECONDS))
    .replace("__STALL_DANGER__", () => String(LIVE_STALL_DANGER_SECONDS))
    .replace("__HEARTBEAT_KIND__", () => scriptJsonString(OBS_HEARTBEAT_KIND))
    .replace("__TEXT_MAX__", () => String(LIVE_TEXT_SUMMARY_MAX_CHARS))
    .replace("__KINDS__", () => kindsLiteral)
    // 连接文案表整体注入:页面与单测读同一份 LIVE_CONN_RULES,不留第二份文案。
    .replace("__CONN_RULES__", () => scriptJsonValue(LIVE_CONN_RULES));

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>live · ${displayId}</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <h1>live · RUNNING 任务事件时间线 · task <code>${displayId}</code></h1>
  <div class="row">
    <span class="badge" id="state">state: ${escapeHtmlText(state)}</span>
    <span class="pill stall" id="stall">最后事件 — s</span>
    <span class="pill conn" id="conn">连接中…</span>
    <span class="pill" id="counts">事件 0 条</span>
  </div>
  <div class="legend">${KINDS.map((k) => `<span class="badge k-${escapeHtmlText(k)}">${escapeHtmlText(k)}</span>`).join("")}</div>
</header>
<main>
  <div class="notice">
    停滞判据(<strong>与 Supervisor 共用同一份常量</strong>,推导与实测来源见 §9.8):<strong>红 = 心跳停止超过 ${LIVE_STALL_DANGER_SECONDS}s</strong>(runner 自己停了,高置信);<strong>黄 = 心跳在而模型静默超过 ${LIVE_STALL_WARN_SECONDS}s</strong>(可能只是不产字的长活,所以这一条永不判红)。
    数据落地节奏由每条心跳自带的 <code>gap_ms</code> 说明(不要再假设「每 30s 一次」;轮次分布与两个阈值的推导只有一份权威口径:<code>docs/architecture.md</code> §9.8)。
    本页只被动显示,不做判定也不做任何处置 —— 它是投影,权威仍是 TaskSession DO(GET /api/tasks/${displayId})。
  </div>
  <ol id="tl"></ol>
  <p class="empty" id="empty">还没有事件。先说清一件事:<code>EventSource</code> 无法携带 Authorization 头,而这条流只认那个头 —— 所以<strong>浏览器自己连不上 prod</strong>:无凭据直开 <code>/live/…</code> 会得到 401,而 401 下浏览器根本不会重连(顶部提示会如实写「不会自动重连」)。浏览器可达性由后续产品化会话方案统一解决,本期刻意不引入临时凭据出口。当下要对照数据,请用带凭据的 API 客户端:<code>curl -N "$BASE/api/tasks/${displayId}/events/stream" -H "authorization: Bearer $TOKEN"</code>。</p>
</main>
<script>${script}</script>
</body>
</html>`;
}
