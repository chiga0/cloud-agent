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

export interface EvidenceManifest {
  schema_version: 1;
  task_id: string;
  attempt_id: string;
  role: string;
  produced_at: string;
  spec_digest: string;
  model: string;
  transcript: ArtifactRef;
  artifacts: ArtifactRef[];
  verify?: ArtifactRef;
  /** writer 导出的候选变更 patch(repo 任务),供独立验证器重放 */
  patch?: ArtifactRef;
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
