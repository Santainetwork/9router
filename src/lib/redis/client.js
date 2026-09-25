import { createClient as defaultCreateClient } from "redis";

const CONNECT_TIMEOUT_MS = 2000;
const COMMAND_TIMEOUT_MS = 2000;

export function createRedisManager({ url = process.env.REDIS_URL, createClient = defaultCreateClient } = {}) {
  if (!url) throw new Error("REDIS_URL is required");
  let commandClient = null;
  let blockingClient = null;
  let healthy = false;
  let lastCheckedAt = null;

  function makeClient() {
    const client = createClient({
      url,
      disableOfflineQueue: true,
      commandOptions: { timeout: COMMAND_TIMEOUT_MS },
      socket: {
        connectTimeout: CONNECT_TIMEOUT_MS,
        reconnectStrategy: (retries) => retries < 3 ? Math.min(100 * (retries + 1), 500) : false,
      },
    });
    client.on("error", () => { healthy = false; });
    return client;
  }

  async function connect(slot) {
    let client = slot === "command" ? commandClient : blockingClient;
    if (!client) {
      client = makeClient();
      if (slot === "command") commandClient = client;
      else blockingClient = client;
    }
    if (!client.isOpen) await client.connect();
    return client;
  }

  async function health() {
    lastCheckedAt = new Date().toISOString();
    try {
      const client = await connect("command");
      healthy = await client.ping() === "PONG";
    } catch {
      healthy = false;
      try { commandClient?.destroy(); } catch {}
      commandClient = null;
    }
    return healthy;
  }

  async function closeOne(client) {
    if (!client) return;
    try {
      if (client.isOpen) await client.close();
      else client.destroy?.();
    } catch {
      try { client.destroy?.(); } catch {}
    }
  }

  return {
    command: () => connect("command"),
    blocking: () => connect("blocking"),
    health,
    status: () => ({ healthy, connected: Boolean(commandClient?.isOpen), lastCheckedAt }),
    async close() {
      const clients = [commandClient, blockingClient];
      commandClient = null;
      blockingClient = null;
      healthy = false;
      await Promise.all(clients.map(closeOne));
    },
  };
}

let shared;
export function getRedisManager() {
  shared ||= createRedisManager();
  return shared;
}

export async function closeRedis() {
  if (!shared) return;
  const manager = shared;
  shared = null;
  await manager.close();
}
