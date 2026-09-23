import { createHash } from "node:crypto";

const snapshotKey = (key) => `sha256:${createHash("sha256").update(String(key)).digest("hex")}`;

export function mapSharedProviderActivity(buckets = [], connections = []) {
  const byKey = new Map(connections.map((connection) => [snapshotKey(connection.id), connection]));
  return buckets.flatMap((bucket) => {
    const count = Number(bucket?.activeConcurrency) || 0;
    const connection = bucket?.scope === "provider" ? byKey.get(bucket.key) : null;
    if (!connection || count <= 0) return [];
    return [{
      connectionId: connection.id,
      model: "In-flight",
      provider: connection.provider || "unknown",
      account: connection.name || connection.email || connection.provider || connection.id,
      count,
    }];
  });
}

export function mergeActiveRequests(local = [], shared = []) {
  return [...local, ...shared];
}
