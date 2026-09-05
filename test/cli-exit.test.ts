import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";

/**
 * CLI 退出码裁决(c16)。判据核心是**整串 vs 包含**,不是认哪些词。
 *
 * 两向都必须钉死:
 * - **向上**(c10b 时代的能力不许退化):真失败的形状是 `exit 0` + CLI 未必置
 *   `is_error` + result **整串**就是那条错误。整串必须仍是 11。
 * - **向下**(c15 三次俱毁的病根):writer 成功收尾、`is_error=false`,而规格**要求**
 *   它在总结里讨论这些错误形状。同样的字样作为**引用**出现时必须仍是 0 —— 判成 11
 *   的代价不是「多一个失败任务」,而是补丁导出被整支跳过(11 不是预算类退出码,
 *   §7.2.1),完整工作归零。
 *
 * 接线层走真实入口 `collectQwenAttempt`,因为「裁决改了、导出条件也跟着改了」这件事
 * 只有从入口才看得出。桩测手段沿用 test/budget-patch-export.test.ts:替换 getSandbox
 * + 假 R2,不为测试新增只在测试里用的公开方法。测试与夹具里照常用字面形状。
 */

const sandboxFiles: Record<string, string> = {};
const execLog: string[] = [];

vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: () => ({
    async exec(cmd: string) {
      execLog.push(cmd);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async readFile(path: string) {
      return { content: sandboxFiles[path] ?? "" };
    },
  }),
}));

import {
  EXIT_CLI_API_ERROR,
  EXIT_UNKNOWN_NATIVE,
  adjudicateCliExit,
  isCliErrorShape,
} from "../src/exec/cli-exit";
import { collectQwenAttempt } from "../src/exec/sandbox";
import { PATCH_PATH } from "../src/exec/base";
import { LONGRUN_STDERR, LONGRUN_STDOUT } from "../src/exec/longrun";

const BASE_SHA = "a".repeat(40);
const DIFF = "diff --git a/src/x.ts b/src/x.ts\n@@\n+// done\n";

/** c10b 真失败标本:整串就是一条 CLI 错误,result 里没有别的字。 */
const WHOLE_ERROR = "[API Error: 403 AccessDenied.Unpurchased.]";

/** c15 三次俱毁标本:成功总结按要求讨论了这些形状 —— 全是引用,不是整串。 */
const SUCCESS_SUMMARY = [
  "Done — 41 tests pass, no regressions.",
  'The retry path now covers the four failure shapes the spec asked me to discuss:',
  'a rejected key prints "[API Error: 403 AccessDenied.Unpurchased.]", a quota drain',
  "echoes insufficient_quota, a transport fault surfaces as upstream_error, and an",
  "unknown deployment as model_not_found. Each is asserted in cli-exit.test.ts.",
].join(" ");

/** 形状清单:整串必须 11,嵌进散文必须 0。 */
const ERROR_SHAPES = [
  WHOLE_ERROR,
  "AccessDenied.Unpurchased",
  "model_not_found",
  "upstream_error",
  "insufficient_quota",
];

const resultLine = (evt: { is_error?: boolean; result?: string }) =>
  JSON.stringify({ type: "result", subtype: "success", ...evt });

function fakeArtifacts() {
  const bodies: Record<string, string> = {};
  const bucket = {
    async put(key: string, body: string) {
      bodies[key] = body;
      return {};
    },
  };
  return { bucket: bucket as unknown as R2Bucket, bodies };
}

/** 走真实 collect 入口:@param lastLine 是 /tmp/longrun-stdout 的全部内容。 */
async function collect(nativeExit: number | null, stdout: string) {
  execLog.length = 0;
  for (const k of Object.keys(sandboxFiles)) delete sandboxFiles[k];
  sandboxFiles[LONGRUN_STDOUT] = stdout;
  sandboxFiles[LONGRUN_STDERR] = "";
  sandboxFiles[PATCH_PATH] = DIFF;

  const { bucket, bodies } = fakeArtifacts();
  const env = { ARTIFACTS: bucket } as unknown as Env;
  const r = await collectQwenAttempt(
    env,
    {
      attemptId: "att-c16",
      repoUrl: "https://github.com/example/repo",
      exportPatch: true,
      base: { sha: BASE_SHA, source: "resolved_default" },
    },
    { exitCode: nativeExit },
  );
  return { r, bodies };
}

/** exportPatchScript 的产物形状 —— 用它判断这一支有没有去取差量。 */
const exportWasAttempted = () => execLog.some((c) => c.includes(`diff '${BASE_SHA}' --binary`));

describe("裁决顺序:进程终态优先于一切文本判读", () => {
  it("nativeExit 非 0 原样返回,哪怕 result 整串是错误形状(不改写别人的码)", () => {
    for (const code of [1, 23, 24, 53, 55]) {
      expect(
        adjudicateCliExit({ nativeExit: code, isError: true, resultText: WHOLE_ERROR }),
      ).toBe(code);
    }
  });

  it("nativeExit null → 终态未知即 -1:那一刻的文本说明不了成败", () => {
    expect(adjudicateCliExit({ nativeExit: null, isError: true, resultText: WHOLE_ERROR })).toBe(
      EXIT_UNKNOWN_NATIVE,
    );
    expect(adjudicateCliExit({ nativeExit: null })).toBe(EXIT_UNKNOWN_NATIVE);
  });

  it("isError===true 直接 11,不需要文本", () => {
    expect(adjudicateCliExit({ nativeExit: 0, isError: true, resultText: "all good" })).toBe(
      EXIT_CLI_API_ERROR,
    );
    expect(EXIT_CLI_API_ERROR).toBe(11);
  });

  it("没有 result 事实时,exit 0 就是 0", () => {
    expect(adjudicateCliExit({ nativeExit: 0 })).toBe(0);
    expect(adjudicateCliExit({ nativeExit: 0, isError: false })).toBe(0);
    expect(adjudicateCliExit({ nativeExit: 0, isError: false, resultText: "" })).toBe(0);
    expect(adjudicateCliExit({ nativeExit: 0, resultText: "   \n  " })).toBe(0);
  });
});

describe("整串形状:c10b 的识别能力不许退化", () => {
  it("方括号包壳整串 → 11,且与 is_error 在场与否无关(isError=false 不免疫)", () => {
    expect(adjudicateCliExit({ nativeExit: 0, isError: false, resultText: WHOLE_ERROR })).toBe(11);
    expect(adjudicateCliExit({ nativeExit: 0, resultText: WHOLE_ERROR })).toBe(11);
    expect(adjudicateCliExit({ nativeExit: 0, isError: undefined, resultText: WHOLE_ERROR })).toBe(
      11,
    );
  });

  it("去首尾空白后仍算整串", () => {
    expect(
      adjudicateCliExit({ nativeExit: 0, isError: false, resultText: `  \n${WHOLE_ERROR}\n  ` }),
    ).toBe(11);
    expect(
      adjudicateCliExit({ nativeExit: 0, resultText: "[API Error: 429 insufficient_quota]\n" }),
    ).toBe(11);
  });

  it("裸机器码家族整串 → 11(AccessDenied. 前缀 + 三个定长码)", () => {
    for (const text of [
      "AccessDenied.Unpurchased",
      "AccessDenied.Throttling",
      "model_not_found",
      "upstream_error",
      "insufficient_quota",
    ]) {
      expect(isCliErrorShape(text)).toBe(true);
      expect(adjudicateCliExit({ nativeExit: 0, isError: false, resultText: text })).toBe(11);
    }
  });
});

describe("包含形状:c15 的误杀不许复发", () => {
  it("成功总结里引用这些字样 → 0(is_error=false)", () => {
    expect(isCliErrorShape(SUCCESS_SUMMARY)).toBe(false);
    expect(adjudicateCliExit({ nativeExit: 0, isError: false, resultText: SUCCESS_SUMMARY })).toBe(
      0,
    );
    expect(adjudicateCliExit({ nativeExit: 0, resultText: SUCCESS_SUMMARY })).toBe(0);
  });

  it("逐形状双向钉:同一串,整串 → 11,嵌进散文 → 0", () => {
    for (const shape of ERROR_SHAPES) {
      expect(adjudicateCliExit({ nativeExit: 0, isError: false, resultText: shape })).toBe(11);
      const quoted = `The CLI prints ${shape} when the key is rejected; both branches are asserted.`;
      expect(quoted).toContain(shape);
      expect(adjudicateCliExit({ nativeExit: 0, isError: false, resultText: quoted })).toBe(0);
    }
  });

  it("以形状开头但接了散文,不算整串", () => {
    for (const text of [
      "[API Error: 403 AccessDenied.Unpurchased.] (retried, then succeeded)",
      "[API Error: 400 upstream_error] then [API Error: 500 upstream_error]",
      "AccessDenied. This is what a rejected key looks like in the stream.",
      "insufficient_quota is the code the gateway returns.",
      "error: model_not_found for the retired deployment",
    ]) {
      expect(isCliErrorShape(text)).toBe(false);
      expect(adjudicateCliExit({ nativeExit: 0, isError: false, resultText: text })).toBe(0);
    }
  });

  it("刻意的精度边界:包壳未闭合不算整串(真失败标本总是闭合的)", () => {
    expect(isCliErrorShape("[API Error: 403 AccessDenied.Unpurchased.")).toBe(false);
    expect(isCliErrorShape("[API Error: a] and b]")).toBe(false);
  });
});

describe("接线层:collectQwenAttempt 的裁决与补丁导出", () => {
  it("c15 标本 —— exit 0 + 讨论错误形状的成功总结 → 仍 0,且差量照常导出", async () => {
    const { r, bodies } = await collect(0, resultLine({ is_error: false, result: SUCCESS_SUMMARY }));
    expect(r.exitCode).toBe(0);
    expect(exportWasAttempted()).toBe(true);
    expect(r.patch).toBeDefined();
    expect(bodies[r.patch!.key]).toBe(DIFF);
    expect(r.patchIncompleteReason).toBeUndefined();
  });

  it("c10b 标本 —— exit 0 + result 整串是错误 → 11,且不导差量(非预算类失败)", async () => {
    const { r } = await collect(0, resultLine({ is_error: false, result: WHOLE_ERROR }));
    expect(r.exitCode).toBe(11);
    expect(exportWasAttempted()).toBe(false);
    expect(r.patch).toBeUndefined();
    expect(r.patchIncompleteReason).toBeUndefined();
  });

  it("is_error=true 的自认失败 → 11,与文本内容无关", async () => {
    const { r } = await collect(0, resultLine({ is_error: true, result: "gave up" }));
    expect(r.exitCode).toBe(11);
    expect(exportWasAttempted()).toBe(false);
  });

  it("只有末行参与判读:中间行谈错误、末行干净 → 0 且导差量", async () => {
    const stdout = [
      '{"type":"system","subtype":"init"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hit upstream_error, retrying"}]}}',
      resultLine({ is_error: false, result: SUCCESS_SUMMARY }),
    ].join("\n");
    const { r } = await collect(0, stdout);
    expect(r.exitCode).toBe(0);
    expect(exportWasAttempted()).toBe(true);
    expect(r.patch).toBeDefined();
  });

  it("末行非 JSON / 不是 result 事件 → 行为不变(退出码原样)", async () => {
    const garbage = await collect(0, "bash: line 1: unexpected token\n");
    expect(garbage.r.exitCode).toBe(0);
    expect(exportWasAttempted()).toBe(true);

    const notResult = await collect(0, '{"type":"assistant","result":"upstream_error"}');
    expect(notResult.r.exitCode).toBe(0);

    const failedGarbage = await collect(1, "trace: boom\n");
    expect(failedGarbage.r.exitCode).toBe(1);

    const empty = await collect(0, "");
    expect(empty.r.exitCode).toBe(0);
  });

  it("预算死亡不被裁决器改轨:exit 55 + 成功总结仍是 55 + 在途差量带不完整标记", async () => {
    const { r } = await collect(55, resultLine({ is_error: false, result: SUCCESS_SUMMARY }));
    expect(r.exitCode).toBe(55);
    expect(exportWasAttempted()).toBe(true);
    expect(r.patchIncompleteReason).toBe("budget_abort(exit=55)");
  });

  it("exit 55 + result 整串是错误形状:终态仍优先,不升格成 11", async () => {
    const { r } = await collect(55, resultLine({ is_error: true, result: WHOLE_ERROR }));
    expect(r.exitCode).toBe(55);
  });

  it("终态缺失(null)+ 整串错误文本 → -1,不做形状判读", async () => {
    const { r } = await collect(null, resultLine({ is_error: false, result: WHOLE_ERROR }));
    expect(r.exitCode).toBe(-1);
    expect(exportWasAttempted()).toBe(false);
  });
});
