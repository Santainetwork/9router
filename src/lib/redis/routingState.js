// Task 6: atomic Redis routing state for multicore. Selection keys are
// namespaced by deployment and logical scope, carry no credentials, and advance
// only among caller-supplied eligible IDs. Redis failure rejects with a typed
// error; there is no local fallback in multicore.

import { redisNamespace } from "./client.js";

export const ROUTING_ERROR = Object.freeze({
  REDIS_UNAVAILABLE: "ROUTING_REDIS_UNAVAILABLE",
});

const PLAIN_ROTATE = `
local n = tonumber(ARGV[1])
if not n or n <= 0 then return 0 end
local cur = tonumber(redis.call('GET', KEYS[1]) or '0') or 0
local idx = cur % n
redis.call('SET', KEYS[1], tostring((cur + 1) % n))
return idx
`;

const STICKY_ROTATE = `
local n = tonumber(ARGV[1])
local sticky = tonumber(ARGV[2])
if not n or n <= 0 then return 0 end
if not sticky or sticky <= 1 then sticky = 1 end
local raw = redis.call('GET', KEYS[1]) or '0:0'
local sep = string.find(raw, ':')
local cur = tonumber(string.sub(raw, 1, (sep or 0) - 1)) or 0
local count = tonumber(sep and string.sub(raw, sep + 1) or '0') or 0
local idx = cur % n
count = count + 1
if count >= sticky then
  cur = (cur + 1) % n
  count = 0
end
redis.call('SET', KEYS[1], tostring(cur) .. ':' .. tostring(count))
return idx
`;

const SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;

const ROUTING_PROBE = `
redis.call('GET', KEYS[1])
redis.call('SET', KEYS[1], '1', 'PX', 30000)
return 1
`;

export async function checkRoutingState(redis, namespace = redisNamespace()) {
  if (!redis || typeof redis.eval !== "function") return false;
  if (!SCOPE_PATTERN.test(namespace)) return false;
  try {
    return Number(await redis.eval(ROUTING_PROBE, {
      keys: [`${namespace}:routing:readiness`],
      arguments: [],
    })) === 1;
  } catch {
    return false;
  }
}

export function createRoutingState({
  redis,
  namespace = redisNamespace(),
} = {}) {
  if (!redis || typeof redis.eval !== "function") {
    throw new TypeError("redis manager with eval is required");
  }
  if (!SCOPE_PATTERN.test(namespace)) throw new TypeError("safe Redis namespace is required");

  function key(scope) {
    if (!SCOPE_PATTERN.test(scope)) throw new TypeError("safe routing scope is required");
    return `${namespace}:routing:${scope}`;
  }

  async function evalScript(script, scope, args) {
    try {
      const result = await redis.eval(script, { keys: [key(scope)], arguments: args });
      return Number(result) || 0;
    } catch (error) {
      const e = new Error("routing state unavailable");
      e.code = ROUTING_ERROR.REDIS_UNAVAILABLE;
      e.cause = error;
      throw e;
    }
  }

  return {
    async rotate(scope, eligibleIds) {
      const n = Array.isArray(eligibleIds) ? eligibleIds.length : 0;
      return evalScript(PLAIN_ROTATE, scope, [String(n)]);
    },
    async rotateSticky(scope, eligibleIds, stickyLimit = 1) {
      const n = Array.isArray(eligibleIds) ? eligibleIds.length : 0;
      return evalScript(STICKY_ROTATE, scope, [String(n), String(stickyLimit)]);
    },
  };
}
