import { describe, expect, it } from "vitest";
import { Sandbox, egressAllowedHosts, egressMode } from "../src/exec/sandbox-do";

/**
 * 出站白名单的解析层。类字段如何被容器运行时消费由 prod 正/负向用例证
 * (本地无容器环境),这里钉的是「名单怎么算出来」:模型主机必须与
 * MODEL_UPSTREAM_BASE 同源,代码托管主机缺省最小集合,一切取值可审计。
 */
describe("egressAllowedHosts", () => {
  const UPSTREAM = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";

  it("模型主机从 MODEL_UPSTREAM_BASE 推导,不在第二处维护", () => {
    const hosts = egressAllowedHosts({ MODEL_UPSTREAM_BASE: UPSTREAM });
    expect(hosts).toContain("token-plan.cn-beijing.maas.aliyuncs.com");
  });

  it("代码托管主机缺省只有 github.com(最小集合)", () => {
    expect(egressAllowedHosts({ MODEL_UPSTREAM_BASE: UPSTREAM })).toEqual([
      "token-plan.cn-beijing.maas.aliyuncs.com",
      "github.com",
    ]);
  });

  it("EGRESS_GIT_HOSTS 逗号分隔、逐项 trim,空项丢弃", () => {
    const hosts = egressAllowedHosts({
      MODEL_UPSTREAM_BASE: UPSTREAM,
      EGRESS_GIT_HOSTS: "github.com, gitlab.com ,, ",
    });
    expect(hosts).toEqual([
      "token-plan.cn-beijing.maas.aliyuncs.com",
      "github.com",
      "gitlab.com",
    ]);
  });

  it("MODEL_UPSTREAM_BASE 非法时只放行托管主机,不把垃圾拼进名单", () => {
    expect(egressAllowedHosts({ MODEL_UPSTREAM_BASE: "not a url" })).toEqual(["github.com"]);
    expect(egressAllowedHosts({})).toEqual(["github.com"]);
  });

  it("模型主机带端口时保留端口(白名单按 host 匹配)", () => {
    const hosts = egressAllowedHosts({ MODEL_UPSTREAM_BASE: "https://proxy.internal:8443/v1" });
    expect(hosts[0]).toBe("proxy.internal:8443");
  });
});

describe("egressMode", () => {
  it("只认显式的 enforce,其余一律按 shadow(含缺配/拼写错误)", () => {
    expect(egressMode({ EGRESS_MODE: "enforce" })).toBe("enforce");
    expect(egressMode({ EGRESS_MODE: "shadow" })).toBe("shadow");
    expect(egressMode({})).toBe("shadow");
    expect(egressMode({ EGRESS_MODE: "ENFORCE" })).toBe("shadow");
    expect(egressMode({ EGRESS_MODE: "enabled" })).toBe("shadow");
  });
});

describe("outbound 处理器注册机制", () => {
  // `static outbound = fn` 是 [[Define]],会遮蔽基类的静态 setter:拦截照装、
  // 流量照进代理,但处理器链第 6 步读注册表落空,记账与处置静默失效
  // (M9 shadow 部署零日志的根因)。只有静态块赋值([[Set]])能真正注册。
  it("outbound 不是子类自有属性 —— 字段写法会遮蔽基类 setter", () => {
    expect(Object.hasOwn(Sandbox, "outbound")).toBe(false);
  });

  it("继承的读取路径取得到处理器(注册表已被静态块写入)", () => {
    expect(Sandbox.outbound).toBeTypeOf("function");
  });
});
