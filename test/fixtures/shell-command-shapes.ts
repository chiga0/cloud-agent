/**
 * 2026-09-04 prod 标本夹具 —— c14 writer 的 12 条真实 shell 命令行。
 *
 * 来源:任务 `c08c3242-b95f-48c2-8727-771297055acd` / writer attempt
 * `4b5e9588-f858-4cc6-b875-85029d9fa4e2`(该任务**正常跑到 DONE**、退出码 0)。操作员从
 * 该 attempt 的 Raw transcript 逐条抽出 `run_shell_command` 的命令行:36 条里 35 条在旧的
 * `commandShape` 下塌成同一个键 `cd /workspace/repo`(不同键 2 个、主键占比 0.97),
 * loop 与 no_progress 于是在它启动两分钟内各亮一条黄。这里取的是其中 12 条,覆盖被折进
 * 同一键的全部动作类型(sed / grep / wc / ls / git / tsc / vitest / cat / test)。
 *
 * 保真度说明(不夸大):`<hex>` / `<uuid>` 两处是操作员替换掉的随机 id,形状不受影响;
 * 其余字符逐条照抄。第 10 条缩短了 vitest 的测试文件列表 —— 该段的形状由首词 `timeout`
 * 决定,缩短不改变结果。
 *
 * 为什么这份夹具只能这么用:`tool_targets` 存的是**塌缩之后**的形状,塌缩是有损的,原始
 * 命令行在 Observation 层根本不存在(全文里 `&&` 只出现在 11 条 `tool_result` 的输出文本
 * 中,没有一条在 `tool_targets` 里)。原始命令行只在 Raw transcript(R2 ARTIFACTS),而
 * 沙箱不持 prod 凭据 ⇒ 复算只能在下面的 `expectedShapes` 上做,prod 侧结论留给部署后取证。
 *
 * `expectedShapes` 是**实测**结果(由 `commandShape` 产出),不是人工推导:两侧共用它,
 * 摄取侧钉形状、判据侧钉分布,任何一侧改动都会在这里对不上。
 */
export const SHELL_FIXTURE: ReadonlyArray<{ command: string; shape: string }> = [
  {
    command: `cd /workspace/repo && git log --oneline -3 && git status --short && echo "---" && ls src src/control test docs migrations`,
    shape: "ls src",
  },
  {
    command: `cd /workspace/repo && wc -l src/control/session.ts src/index.ts docs/architecture.md && echo "=== grep archive( ===" && grep -n "async archive\\|archive(\\|ARCHIVE_RETRY_LADDER_MS\\|archive_stalled\\|archive_retry_step" src/control/session.ts src/index.ts | head -60`,
    shape: "grep src/control/session.ts",
  },
  {
    command: `cd /workspace/repo && grep -rn "chain-check\\|chainCheck\\|brokenTasks\\|not_archived" src/ | head -40`,
    shape: "grep src/",
  },
  {
    command: `cd /workspace/repo && sed -n '1470,1560p' src/control/session.ts`,
    shape: "sed src/control/session.ts",
  },
  {
    command: `cd /workspace/repo && sed -n '636,660p' src/index.ts && echo "=== alarm tail ===" && sed -n '2059,2059p' src/control/session.ts && grep -n "nextWatchdogAlarm\\|setAlarm" src/control/session.ts | tail -20`,
    shape: "grep src/control/session.ts",
  },
  {
    command: `cd /workspace/repo && sed -n '1,30p' src/index.ts | grep -n "import"`,
    shape: "sed src/index.ts",
  },
  {
    command: `cd /workspace/repo && npx tsc --noEmit 2>&1 | tail -20; echo "TSC_EXIT=$?"`,
    shape: "npx tsc",
  },
  {
    command: `cd /workspace/repo && timeout 180 npm test 2>&1 | tail -30; echo EXIT=\${PIPESTATUS[0]}`,
    shape: "timeout 180",
  },
  {
    command: `cat /root/.qwen/tmp/<hex>/background-shells/<uuid>/shell-bg_57ffdb55.status 2>/dev/null; echo "---log---"; tail -5 /tmp/install.log 2>/dev/null; ls /workspace/repo/node_modules 2>/dev/null | wc -l`,
    shape: "ls /workspace/repo/node_modules",
  },
  {
    command: `cd /workspace/repo && timeout 300 npx vitest run test/admin-events.test.ts -t "重号" 2>&1 | grep -E "Test Files|Tests " | head -20; echo "---TSC---"; timeout 240 npx tsc --noEmit; echo TSC=$?; echo "---GIT---"; git status --short`,
    shape: "timeout 300",
  },
  {
    command: `cd /workspace/repo && (test -f src/control/session.ts && echo present) || echo missing`,
    shape: "(test src/control/session.ts",
  },
  { command: `cd /workspace/repo`, shape: "cd /workspace/repo" },
];

/**
 * 塌缩前的形状:旧 `commandShape` 只看「首词 + 首个非 flag 实参」,`&&` 在那里只是普通
 * token 边界,于是整批 12 条里 11 条都是这一个键(只有第 9 条没有 `cd` 前缀而幸免)。
 * prod 那批 36 条的实测口径是同键 35 条(占比 0.97),这里 11/12 是它在 12 条样本上的投影。
 */
export const SHELL_FIXTURE_COLLAPSED_KEY = "cd /workspace/repo";
