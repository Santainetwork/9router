import { describe, expect, it, vi } from "vitest";
import { decideCreditGuard, summarizeCredits, AUTO_DISABLED_BY } from "../../src/sse/services/codebuddyCreditGuard.js";
import { applyCreditGuardToConnection, runCodebuddyCreditGuardTick } from "../../src/sse/services/codebuddyCreditSweep.js";

// Live shape captured from codebuddy-intl account 7f481b0a (Free Plan).
const LIVE_HEALTHY = {
  Monthly: { used: 0, total: 100, recurring: true, unlimited: false },
  "Bonus Pack 1": { used: 1.27, total: 250, recurring: false, unlimited: false },
  "Bonus Pack 2": { used: 0, total: 100, recurring: false, unlimited: false },
  "Bonus Pack 3": { used: 0, total: 100, recurring: false, unlimited: false },
};
const exhausted = (used, total) => ({ Monthly: { used, total, unlimited: false } });
const seat = (over = {}) => ({ id: "c1", provider: "codebuddy-intl", isActive: true, providerSpecificData: {}, ...over });
const autoOff = (over = {}) => seat({ isActive: false, providerSpecificData: { creditGuard: { disabledBy: AUTO_DISABLED_BY } }, ...over });

describe("summarizeCredits", () => {
  it("sums remaining across refill and bonus packs (live shape)", () => {
    const s = summarizeCredits(LIVE_HEALTHY);
    expect(s.total).toBe(550);
    expect(s.remaining).toBeCloseTo(548.73, 2);
    expect(s.ratio).toBeCloseTo(0.99769, 4);
    expect(s.packages).toBe(4);
  });

  it("returns null when there is no usable package (guard must do nothing)", () => {
    expect(summarizeCredits({})).toBeNull();
    expect(summarizeCredits(undefined)).toBeNull();
    expect(summarizeCredits({ X: { used: 5, total: 0 } })).toBeNull();
    expect(summarizeCredits({ X: { used: null, total: 100 } })).toBeNull();
  });

  it("clamps overspend so remaining never goes negative", () => {
    const s = summarizeCredits({ Monthly: { used: 120, total: 100 } });
    expect(s.remaining).toBe(0);
    expect(s.ratio).toBe(0);
  });

  it("treats any unlimited package as unlimited", () => {
    expect(summarizeCredits({ Monthly: { used: 99, total: 100 }, X: { unlimited: true } }).unlimited).toBe(true);
  });
});

describe("decideCreditGuard threshold", () => {
  it("disables an active seat exactly at 10% remaining (boundary inclusive)", () => {
    // 90 of 100 used -> 10% remaining -> disable
    expect(decideCreditGuard({ connection: seat(), quotas: exhausted(90, 100) }).action).toBe("disable");
  });

  it("keeps an active seat just above 10% remaining", () => {
    expect(decideCreditGuard({ connection: seat(), quotas: exhausted(89, 100) }).action).toBe("none");
  });

  it("keeps a healthy seat active", () => {
    expect(decideCreditGuard({ connection: seat(), quotas: LIVE_HEALTHY }).action).toBe("none");
  });

  it("counts bonus packs: a low refill is not enough if bonus balance keeps the total high", () => {
    const q = { Monthly: { used: 100, total: 100 }, "Bonus Pack 1": { used: 0, total: 900 } };
    // remaining 900 / 1000 = 90% -> not low
    expect(decideCreditGuard({ connection: seat(), quotas: q }).action).toBe("none");
  });

  it("disables when the combined pool drops to 10%, even if one pack is still full", () => {
    const q = { Monthly: { used: 0, total: 100 }, "Bonus Pack 1": { used: 900, total: 900 } };
    // remaining 100 / 1000 = 10% -> disable
    expect(decideCreditGuard({ connection: seat(), quotas: q }).action).toBe("disable");
  });

  it("honours a custom threshold", () => {
    expect(decideCreditGuard({ connection: seat(), quotas: exhausted(80, 100), threshold: 0.25 }).action).toBe("disable");
    expect(decideCreditGuard({ connection: seat(), quotas: exhausted(70, 100), threshold: 0.25 }).action).toBe("none");
  });

  it("does nothing when usage is unavailable (never disable on bad data)", () => {
    expect(decideCreditGuard({ connection: seat(), quotas: undefined }).action).toBe("none");
    expect(decideCreditGuard({ connection: seat(), quotas: {} }).action).toBe("none");
  });
});

describe("decideCreditGuard manual vs automatic disable", () => {
  it("never re-enables a seat the user disabled manually, even when credits recover", () => {
    const manual = seat({ isActive: false, providerSpecificData: {} });
    expect(decideCreditGuard({ connection: manual, quotas: LIVE_HEALTHY }).action).toBe("none");
  });

  it("never disables a seat the user already turned off", () => {
    const manual = seat({ isActive: false, providerSpecificData: {} });
    expect(decideCreditGuard({ connection: manual, quotas: exhausted(95, 100) }).action).toBe("none");
  });

  it("re-enables a seat the guard disabled once credits recover above the threshold", () => {
    expect(decideCreditGuard({ connection: autoOff(), quotas: LIVE_HEALTHY }).action).toBe("enable");
  });

  it("keeps a guard-disabled seat off while still at or below the threshold", () => {
    expect(decideCreditGuard({ connection: autoOff(), quotas: exhausted(95, 100) }).action).toBe("none");
  });

  it("restores a guard-disabled seat when the plan turns unlimited", () => {
    expect(decideCreditGuard({ connection: autoOff(), quotas: { X: { unlimited: true } } }).action).toBe("enable");
  });

  it("never disables an unlimited plan", () => {
    expect(decideCreditGuard({ connection: seat(), quotas: { X: { unlimited: true, used: 999, total: 1 } } }).action).toBe("none");
  });
});

describe("applyCreditGuardToConnection (DB writes via injected deps)", () => {
  const passProxy = async () => ({ connectionProxyEnabled: false });

  it("disables with an auto marker and keeps existing providerSpecificData", async () => {
    const update = vi.fn(async () => ({}));
    const conn = seat({ providerSpecificData: { keep: "me" } });
    const d = await applyCreditGuardToConnection(conn, {
      getUsage: async () => ({ quotas: exhausted(95, 100) }),
      resolveProxy: passProxy,
      update,
    });
    expect(d.action).toBe("disable");
    expect(update).toHaveBeenCalledTimes(1);
    const [id, patch] = update.mock.calls[0];
    expect(id).toBe("c1");
    expect(patch.isActive).toBe(false);
    expect(patch.providerSpecificData.keep).toBe("me");
    expect(patch.providerSpecificData.creditGuard.disabledBy).toBe(AUTO_DISABLED_BY);
    expect(patch.providerSpecificData.creditGuard.reason).toMatch(/<= 10%/);
  });

  it("re-enables and clears the marker on recovery", async () => {
    const update = vi.fn(async () => ({}));
    await applyCreditGuardToConnection(autoOff({ providerSpecificData: { creditGuard: { disabledBy: AUTO_DISABLED_BY }, keep: 1 } }), {
      getUsage: async () => ({ quotas: LIVE_HEALTHY }),
      resolveProxy: passProxy,
      update,
    });
    const patch = update.mock.calls[0][1];
    expect(patch.isActive).toBe(true);
    expect(patch.providerSpecificData.creditGuard).toBeUndefined();
    expect(patch.providerSpecificData.keep).toBe(1);
  });

  it("writes nothing when the decision is none", async () => {
    const update = vi.fn();
    const d = await applyCreditGuardToConnection(seat(), {
      getUsage: async () => ({ quotas: LIVE_HEALTHY }),
      resolveProxy: passProxy,
      update,
    });
    expect(d.action).toBe("none");
    expect(update).not.toHaveBeenCalled();
  });

  it("propagates a usage fetch error so the tick can swallow it per account", async () => {
    const update = vi.fn();
    await expect(applyCreditGuardToConnection(seat(), {
      getUsage: async () => { throw new Error("upstream down"); },
      resolveProxy: passProxy,
      update,
    })).rejects.toThrow("upstream down");
    expect(update).not.toHaveBeenCalled();
  });
});

describe("runCodebuddyCreditGuardTick (fail-open)", () => {
  it("keeps going past a failing account and a failing provider load", async () => {
    const seen = [];
    const getConnections = vi.fn(async ({ provider }) => {
      if (provider === "codebuddy-cn") throw new Error("db locked");
      return [seat({ id: "a" }), seat({ id: "b" })];
    });
    const getUsage = vi.fn(async (conn) => {
      seen.push(conn.id);
      if (conn.id === "a") throw new Error("boom");
      return { quotas: LIVE_HEALTHY };
    });
    const update = vi.fn();
    await runCodebuddyCreditGuardTick({ getConnections, getUsage, resolveProxy: async () => ({}), update });
    // codebuddy-intl is loaded first and yields a, b; codebuddy-cn throws and is skipped.
    // The failing account "a" must not stop "b" from being checked.
    expect(getConnections).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(["a", "b"]);
    expect(update).not.toHaveBeenCalled();
  });

  it("does not run concurrently with itself", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const getConnections = vi.fn(async () => { await gate; return []; });
    const first = runCodebuddyCreditGuardTick({ getConnections });
    const second = runCodebuddyCreditGuardTick({ getConnections });
    await second;
    expect(getConnections).toHaveBeenCalledTimes(1);
    release();
    await first;
  });
});
