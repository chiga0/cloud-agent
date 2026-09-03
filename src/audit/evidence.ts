import type { BaseSource } from "../exec/base";

export async function sha256Hex(data: string | ArrayBuffer): Promise<string> {
  const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ArtifactRef {
  key: string;
  digest: string;
  size: number;
}

export async function putArtifact(
  bucket: R2Bucket,
  body: string | ArrayBuffer,
  prefix = "artifacts",
): Promise<ArtifactRef> {
  const digest = await sha256Hex(body);
  const size = typeof body === "string" ? new TextEncoder().encode(body).length : body.byteLength;
  const key = `${prefix}/sha256/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`;
  await bucket.put(key, body, {
    customMetadata: { digest, size: String(size) },
  });
  return { key, digest, size };
}

/** 候选所基于的精确 commit。没有它,patch 只能对「当时那条默认分支」说话。 */
export interface BaseRef {
  sha: string;
  source: BaseSource;
}

export interface EvidenceManifest {
  /** 写入恒为 2;v1 缺 base,读取方必须按「基线未固定」处理而非报错 */
  schema_version: number;
  task_id: string;
  attempt_id: string;
  role: string;
  produced_at: string;
  spec_digest: string;
  model: string;
  transcript: ArtifactRef;
  artifacts: ArtifactRef[];
  /** writer 导出的候选变更 patch(repo 任务),供独立验证器重放 */
  patch?: ArtifactRef;
  /**
   * 补丁完整性。**只在不完整时写入**,缺省 = 完整(含本字段引入前的全部历史
   * manifest —— 那时预算到期根本导不出补丁,不存在不完整样本)。
   *
   * 为什么不写成 `patch_complete: true` 覆盖正常路径:manifest 的 key 含正文
   * digest,给每次成功都加一个恒真字段会让历史 manifest 与新生成的在字节上
   * 分叉,而语义毫无变化。读端一律按「present ⇔ incomplete」判读。
   *
   * `false` 的语义是「这是 writer 被预算击杀那一刻的在途差量」,不是 writer 自认
   * 完成的候选:它可以不完整、不可编译,甚至只是半成品文件的一半。读模型必须把
   * 这句话原样带出去,否则一份 40 分钟的差量会伪装成一个候选。
   */
  patch_complete?: boolean;
  /** 不完整原因,形如 `budget_abort(exit=55)`;与 patch_complete=false 成对出现 */
  patch_incomplete_reason?: string;
  base?: BaseRef;
  model_calls_digest?: string;
}

export interface EvidencePart {
  role: string;
  attempt_id: string;
  digest: string;
}

/**
 * 决策绑定的组合证据:对因果链上各角色证据(writer 候选、verifier 验证、
 * reviewer 裁决)的 digest 做规范化序列化后取哈希。人工审批必须提供与
 * [writer, verifier?] 一致的组合值;自动裁决由控制面直接计算。
 */
export async function compositeEvidenceDigest(parts: EvidencePart[]): Promise<string> {
  return sha256Hex(JSON.stringify(parts));
}

export async function writeManifest(
  bucket: R2Bucket,
  manifest: EvidenceManifest,
): Promise<ArtifactRef> {
  const body = JSON.stringify(manifest, null, 2);
  const digest = await sha256Hex(body);
  const size = new TextEncoder().encode(body).length;
  const key = `manifests/task/${manifest.task_id}/${manifest.attempt_id}-${digest.slice(0, 16)}.json`;
  await bucket.put(key, body, {
    customMetadata: { digest, size: String(size), task_id: manifest.task_id },
  });
  return { key, digest, size };
}
