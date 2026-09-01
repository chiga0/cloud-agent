import { describe, expect, it } from "vitest";
import {
  BASE_ERRORS,
  REPO_DIR,
  exportPatchScript,
  isBaseError,
  isValidSha,
  materializeScript,
  parseSha,
  requireSha,
  resolveScript,
  shaLiteral,
} from "../src/exec/base";

/**
 * 基线材质化脚本单测。这里测的重心不是「脚本能不能跑」(那由 prod E2E 证),
 * 而是注入面:持久化的 base_sha 会被重放进多个新沙箱执行,一次未校验的拼接
 * 就是把执行面隔离边界整个交出去,所以逐条钉住「非法值不可能进入脚本」。
 */

const SHA40 = "a".repeat(40);
const SHA64 = "0123456789abcdef".repeat(4);

describe("isValidSha", () => {
  it("接受 sha1 / sha256 的小写十六进制全长度", () => {
    expect(isValidSha(SHA40)).toBe(true);
    expect(isValidSha(SHA64)).toBe(true);
    expect(isValidSha("0".repeat(40))).toBe(true);
  });

  it("拒绝构造过的、被截断的、超长的、大小写混杂的输入", () => {
    expect(isValidSha(SHA40.slice(0, 39))).toBe(false);
    expect(isValidSha(SHA40 + "a")).toBe(false);
    expect(isValidSha(SHA40.toUpperCase())).toBe(false);
    expect(isValidSha(`${SHA40.slice(0, 39)}z`)).toBe(false);
    expect(isValidSha("")).toBe(false);
    expect(isValidSha("~1")).toBe(false);
    expect(isValidSha("HEAD")).toBe(false);
    expect(isValidSha(null)).toBe(false);
    expect(isValidSha(undefined)).toBe(false);
    expect(isValidSha(123)).toBe(false);
  });

  it("拒绝一切 shell 元字符 —— 它们绝不可能通过长度 + 字符集双重锚定", () => {
    const attacks = [
      `${SHA40.slice(0, 39)}';touch /pwn`,
      `${SHA40.slice(0, 38)}\`id\``,
      `${SHA40.slice(0, 37)}$(id)`,
      `${SHA40.slice(0, 36)};rm -rf /`,
      `${SHA40.slice(0, 36)}\nrm -rf /`,
      `${SHA40.slice(0, 36)} && curl evil`,
    ];
    for (const a of attacks) expect(isValidSha(a)).toBe(false);
  });
});

describe("requireSha / shaLiteral", () => {
  it("非法值直接 throw,而不是转成字符串继续拼", () => {
    expect(() => requireSha("not-a-sha")).toThrow(/invalid base_sha/);
    expect(() => shaLiteral(`';touch /pwn`)).toThrow();
  });

  it("合法值以单引号字面量返回", () => {
    expect(shaLiteral(SHA40)).toBe(`'${SHA40}'`);
  });
});

describe("materializeScript", () => {
  const script = materializeScript(SHA40);

  it("SHA 只以带引号的字面量出现,且脚本里没有 repo_url 入口", () => {
    expect(script).toContain(`'${SHA40}'`);
    expect(script).not.toContain("https://");
    expect(script).not.toContain("git clone");
    // 断言不含注入位:任何未加引号的 SHA 裸拼都会让下面这条失败
    expect(script).not.toMatch(new RegExp(`[^'"]${SHA40}[^'"]`));
  });

  it("逐条 git -C 绝对路径,不依赖 cd 后的相对位置", () => {
    for (const line of script.split("\n")) {
      if (line.includes("git ")) expect(line).toContain(`-C `);
    }
    expect(script).toContain(`R=${REPO_DIR}`);
  });

  it("禁用凭据交互,避免私有仓/坏 ref 把 attempt 挂到墙钟超时", () => {
    expect(script).toContain("GIT_TERMINAL_PROMPT=0");
  });

  it("三个失败出口都能被脚本自身触发,且语义可区分", () => {
    expect(script).toContain(`exit ${BASE_ERRORS.UNREACHABLE}`);
    expect(script).toContain(`exit ${BASE_ERRORS.MISMATCH}`);
    // 不可达判定在 checkout 之前,一致性断言在 checkout 之后
    expect(script.indexOf(`exit ${BASE_ERRORS.UNREACHABLE}`)).toBeLessThan(
      script.indexOf("checkout"),
    );
    expect(script.indexOf("checkout")).toBeLessThan(script.indexOf(`exit ${BASE_ERRORS.MISMATCH}`));
  });

  it("非法 SHA 不可能被编进脚本", () => {
    expect(() => materializeScript(`x';rm -rf /;echo '`)).toThrow();
  });
});

describe("exportPatchScript", () => {
  const script = exportPatchScript(SHA40);

  it("导出前先确认基线对象仍在(基线 diff 才有意义)", () => {
    expect(script.indexOf("cat-file")).toBeLessThan(script.indexOf("-C $R diff"));
    expect(script).toContain(`exit ${BASE_ERRORS.PATCH_EXPORT_FAILED}`);
  });

  it("diff 以基线 SHA 为准,不是 HEAD 也不是分支名", () => {
    expect(script).toMatch(new RegExp(`git -C \\$R diff '${SHA40}' --binary`));
    expect(script).not.toMatch(/diff HEAD/);
  });
});

describe("会话安全(prod 回归)", () => {
  // 沙箱 exec 复用常驻 shell:顶层 exit 退掉的是会话本身,SDK 抛
  // 「Session … is not ready or shell has died」,退出码永远回不到控制面。
  const scripts: Array<[string, string]> = [
    ["materializeScript", materializeScript(SHA40)],
    ["exportPatchScript", exportPatchScript(SHA40)],
    ["resolveScript", resolveScript()],
  ];

  it.each(scripts)("%s 的整个函数体在子 shell 内", (_name, script) => {
    expect(script.startsWith("(\n")).toBe(true);
    expect(script.endsWith("\n)")).toBe(true);
  });

  it.each(scripts)("%s 的括号外没有任何 exit", (_name, script) => {
    let depth = 0;
    for (const line of script.split("\n")) {
      const before = depth;
      depth += (line.match(/\(/g) ?? []).length - (line.match(/\)/g) ?? []).length;
      if (/; exit |^\s*exit |\|\| exit /.test(line)) {
        expect(before, `exit 出现在子 shell 之外: ${line}`).toBeGreaterThan(0);
      }
    }
  });

  it("三个基线退出码都仍由脚本自身产生(包装没有把它们吞掉)", () => {
    const mat = materializeScript(SHA40);
    const exp = exportPatchScript(SHA40);
    expect(mat).toContain(`exit ${BASE_ERRORS.UNREACHABLE}`);
    expect(mat).toContain(`exit ${BASE_ERRORS.MISMATCH}`);
    expect(exp).toContain(`exit ${BASE_ERRORS.PATCH_EXPORT_FAILED}`);
  });
});

describe("resolveScript", () => {
  it("只读 HEAD,不写任何东西", () => {
    const script = resolveScript();
    expect(script).toContain("rev-parse HEAD");
    expect(script).not.toMatch(/checkout|fetch|add /);
  });
});

describe("parseSha", () => {
  it("从多行输出里取最后一行并校验", () => {
    expect(parseSha(`Already on main\n${SHA40}\n`)).toBe(SHA40);
    expect(parseSha("")).toBeNull();
    expect(parseSha(null)).toBeNull();
    expect(parseSha("not a sha")).toBeNull();
    // 交互式凭据提示之类的噪声尾行不能当 SHA 用
    expect(parseSha(`remote: Enumerating objects\nUsername for 'https://x'`)).toBeNull();
  });
});

describe("isBaseError", () => {
  it("只认基线专用码,不把质量失败混进来", () => {
    expect(isBaseError(BASE_ERRORS.UNREACHABLE)).toBe(true);
    expect(isBaseError(BASE_ERRORS.MISMATCH)).toBe(true);
    expect(isBaseError(BASE_ERRORS.PATCH_EXPORT_FAILED)).toBe(true);
    expect(isBaseError(0)).toBe(false);
    expect(isBaseError(1)).toBe(false);
    expect(isBaseError(-1)).toBe(false);
    expect(isBaseError(20)).toBe(false); // verifier 的 APPLY_FAILED
    expect(isBaseError(11)).toBe(false); // writer 的 upstream_error
  });
});
