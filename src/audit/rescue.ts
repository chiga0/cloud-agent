import type { CandidateInput, CandidateView } from "./candidate";
import { assembleCandidate } from "./candidate";

/**
 * 抢救视图(BLOCKED 专用读面)。
 *
 * c12 让「墙钟到期」不再等于「工作树差量消失」:被击杀的 writer 仍会把在途差量导成
 * 一份自称不完整的 manifest。但那份 manifest 从不进入 `current_evidence`(M7 的失败
 * 门禁:writer 失败产物不进审批流),于是 `GET /candidate` 对 BLOCKED 任务恒 404 ——
 * 差量取得了,人却够不到。本模块补的是后一半,且**只补读面**:
 *
 * - 不复用 `current_evidence`:提前钉上会让半成品进入 `binding_digest` 的口径;
 * - 不新增状态对象:仍是「attempt 自己回报的 manifest + TaskRecord.base」的投影;
 * - 不与 `/candidate` 抢口径:`pinned: false` + `binding_digest: null` 明说这份材料
 *   没有审批绑定可核对,`safe_to_apply` 恒 `false`。
 *
 * 诚实性文案全部复用 `assembleCandidate`,两个读面共用同一套判据 —— 否则「补丁不完整」
 * 在两边措辞不同,人会以为它们是不同的东西。
 */
export interface RescueView extends CandidateView {
  /** 本视图来自 attempt 回报的 manifest,不是钉住的证据 */
  rescued: true;
  /** 与 `rescued` 成对:显式说出「没钉住」,省掉一次「那它是不是当前候选」的疑问 */
  pinned: false;
}

export function assembleRescueView(input: CandidateInput): RescueView {
  // binding_digest 强制 null:审批绑定的组成是被钉住的证据,这里一个都没钉。
  // 传空组成进去会算出一个「看起来可核对」的 digest,那是本视图最不该出现的假象。
  const view = assembleCandidate({ ...input, binding_digest: null });
  return {
    ...view,
    rescued: true,
    pinned: false,
    // 兜底而非依赖推导:视图的开放条件是 BLOCKED(状态机已保证 status 非 verified/approved),
    // 但「抢救产物可以自动落地」这个后果不该由调用方的判据是否收紧来决定。
    safe_to_apply: false,
    warnings: [
      "抢救视图:内容取自 writer 终态回报的 manifest,未经独立验证、未钉入 current_evidence、" +
        "不参与任何审批绑定。它只是「人接续工作的起点」,不是可交付的候选 —— " +
        "要提交请回到 /api/tasks/:id/candidate 的口径。",
      ...view.warnings,
    ],
  };
}
