export function maskKey(key) {
  if (!key || typeof key !== "string") return null;
  return key.length <= 10 ? `${key.slice(0, 2)}…` : `${key.slice(0, 6)}…${key.slice(-4)}`;
}

export function extractApiKey(request) {
  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return request.headers.get("x-api-key")
    || request.headers.get("x-goog-api-key")
    || new URL(request.url).searchParams.get("key")
    || null;
}
