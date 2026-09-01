import { Sandbox as SandboxBase } from "@cloudflare/sandbox";
import type { OutboundHandlerContext } from "@cloudflare/containers";
import type { Env } from "../types";

/**
 * 出站策略的纯解析部分(可穷举单测):
 * - 模型主机从 MODEL_UPSTREAM_BASE 推导,与既有变量同源,避免两处维护;
 * - 代码托管主机来自可选的 EGRESS_GIT_HOSTS(逗号分隔),缺省仅 github.com。
 * 列表必须静态可审计:不按任务 repo_url 动态放行 —— 那是外带通道。
 */
export function egressAllowedHosts(env: {
  MODEL_UPSTREAM_BASE?: string;
  EGRESS_GIT_HOSTS?: string;
}): string[] {
  const hosts: string[] = [];
  try {
    const modelHost = new URL(env.MODEL_UPSTREAM_BASE ?? "").host;
    if (modelHost) hosts.push(modelHost);
  } catch {
    // MODEL_UPSTREAM_BASE 非法时模型调用本就必然失败,这里不额外兜底
  }
  const gitHosts = (env.EGRESS_GIT_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  hosts.push(...(gitHosts.length > 0 ? gitHosts : ["github.com"]));
  return hosts;
}

export function egressMode(env: { EGRESS_MODE?: string }): "shadow" | "enforce" {
  return env.EGRESS_MODE === "enforce" ? "enforce" : "shadow";
}

/**
 * 带出站策略的沙箱。DO 类名必须保持 `Sandbox`(wrangler 的 containers /
 * durable_objects / migrations 都按这个名字绑定)。
 *
 * 两档策略,同一套拦截机器:
 * - shadow:不设 allowedHosts、不禁网,所有出站经 `outbound` catch-all
 *   记日志后放行 —— 积累「封了会打到谁」的样本,同时让 HTTPS 拦截的
 *   CA 信任问题在观测期就暴露,而不是等到 enforce 才发现。
 * - enforce:allowedHosts 白名单 + 禁网,未列名主机在处理器链第二步
 *   被拒(HTTP 520);列名主机同样过 catch-all 记账后放行。
 *
 * `interceptHttps` 两档都开:流量几乎全是 HTTPS,不拦就等于没观测。
 * 类字段在构造期赋值即可 —— 基类构造器会先让出微任务,等子类字段
 * 初始化完再读取(官方推荐模式)。每个 attempt 是全新 DO 实例,
 * 模式翻转对后续 attempt 即时生效,无存量实例问题。
 */
export class Sandbox extends SandboxBase<Env> {
  interceptHttps = true;

  allowedHosts = egressMode(this.env) === "enforce" ? egressAllowedHosts(this.env) : undefined;

  enableInternet = egressMode(this.env) !== "enforce";

  /**
   * 全量记账 + 放行:白名单门(处理器链第 2 步)已先过滤,这里只记录到达的主机。
   *
   * 必须用静态块赋值而不是 `static outbound = ...` 字段:字段是 [[Define]],
   * 会遮蔽基类的静态 setter,处理器注册表保持为空 —— 拦截照样安装、流量照
   * 样进代理,但处理器链第 6 步永远落空,观测与自定义处置全部静默失效
   * (M9 shadow 部署零日志的根因)。赋值走 [[Set]],基类 setter 才真正注册。
   */
  static {
    this.outbound = (req: Request, _env: Env, ctx: OutboundHandlerContext) => {
      let host = "unknown";
      try {
        host = new URL(req.url).host;
      } catch {
        // 非法 URL 也放行,拦截语义由处理器链的白名单门负责
      }
      console.log(`egress=forward host=${host} container=${ctx.containerId}`);
      return fetch(req);
    };
  }
}
