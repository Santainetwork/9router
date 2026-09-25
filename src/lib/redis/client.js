import { createClient as defaultCreateClient } from "redis";

const CONNECT_TIMEOUT_MS = 2000;
const COMMAND_TIMEOUT_MS = 2000;

export function createRedisManager({ url = process.env.REDIS_URL, createClient = defaultCreateClient } = {}) {
  if (!url) throw new Error("REDIS_URL is required");
  let commandClient = null;
  let blockingClient = null;
  const dedicatedClients = new Set();
  const connecting = new Map();
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
      connecting.delete(slot);
    }
    // Concurrent callers must await the same connect(). node-redis marks a client
    // open as soon as connect() starts, so an isOpen check alone would hand out a
    // client whose socket is not ready and every command would fail as offline.
    const pending = connecting.get(slot);
    if (pending?.client === client) {
      await pending.promise;
    } else if (!client.isOpen) {
      const promise = Promise.resolve(client.connect()).finally(() => {
        if (connecting.get(slot)?.promise === promise) connecting.delete(slot);
      });
      connecting.set(slot, { client, promise });
      await promise;
    }
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

  // Short-lived connection for a single blocking wait. One connection can only run
  // one blocking command at a time, so concurrent waiters each need their own.
  async function dedicated() {
    const client = makeClient();
    dedicatedClients.add(client);
    try {
      await client.connect();
    } catch (error) {
      dedicatedClients.delete(client);
      await closeOne(client);
      throw error;
    }
    return client;
  }

  async function release(client) {
    if (!client) return;
    dedicatedClients.delete(client);
    await closeOne(client);
  }

  return {
    command: () => connect("command"),
    blocking: () => connect("blocking"),
    dedicated,
    release,
    health,
    status: () => ({ healthy, connected: Boolean(commandClient?.isOpen), lastCheckedAt }),
    async close() {
      const clients = [commandClient, blockingClient, ...dedicatedClients];
      commandClient = null;
      blockingClient = null;
      dedicatedClients.clear();
      connecting.clear();
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
