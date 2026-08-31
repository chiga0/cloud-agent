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
  model_calls_digest?: string;
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
