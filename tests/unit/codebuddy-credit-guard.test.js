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
    const getSettings = async () => ({ codebuddyCreditGuard: { enabled: true, thresholdPercent: 10 } });
    const first = runCodebuddyCreditGuardTick({ getConnections, getSettings });
    const second = runCodebuddyCreditGuardTick({ getConnections, getSettings });
    try {
      await second;
      expect(getConnections).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await first;
    }
  });
});

import { thresholdFromPercent, CREDIT_GUARD_MIN_PERCENT, CREDIT_GUARD_MAX_PERCENT } from "../../src/sse/services/codebuddyCreditGuard.js";

describe("per-account opt-out (creditGuardOptOut)", () => {
  const optOut = (over = {}) => seat({ providerSpecificData: { creditGuardOptOut: true }, ...over });

  it("never disables an opted-out seat even when credits are exhausted", () => {
    expect(decideCreditGuard({ connection: optOut(), quotas: exhausted(99, 100) }).action).toBe("none");
  });

  it("restores a guard-disabled seat that the user opted out of", () => {
    const c = optOut({ isActive: false, providerSpecificData: { creditGuardOptOut: true, creditGuard: { disabledBy: AUTO_DISABLED_BY } } });
    expect(decideCreditGuard({ connection: c, quotas: exhausted(99, 100) }).action).toBe("enable");
  });

  it("leaves a manually disabled opted-out seat alone", () => {
    const c = optOut({ isActive: false, providerSpecificData: { creditGuardOptOut: true } });
    expect(decideCreditGuard({ connection: c, quotas: LIVE_HEALTHY }).action).toBe("none");
  });

  it("opting out does not change behaviour for seats without the flag", () => {
    expect(decideCreditGuard({ connection: seat(), quotas: exhausted(95, 100) }).action).toBe("disable");
  });
});

describe("thresholdFromPercent clamp", () => {
  it("converts whole percent to a fraction", () => {
    expect(thresholdFromPercent(10)).toBeCloseTo(0.1, 10);
    expect(thresholdFromPercent("25")).toBeCloseTo(0.25, 10);
  });
  it("clamps to the enforced band so a bad value cannot disable everything or nothing", () => {
    expect(thresholdFromPercent(0)).toBe(CREDIT_GUARD_MIN_PERCENT / 100);
    expect(thresholdFromPercent(100)).toBe(CREDIT_GUARD_MAX_PERCENT / 100);
    expect(thresholdFromPercent(-50)).toBe(CREDIT_GUARD_MIN_PERCENT / 100);
  });
  it("falls back to the 10% default for junk", () => {
    expect(thresholdFromPercent("abc")).toBeCloseTo(0.1, 10);
    expect(thresholdFromPercent(undefined)).toBeCloseTo(0.1, 10);
    expect(thresholdFromPercent(null)).toBeCloseTo(0.1, 10);
  });
});

describe("runCodebuddyCreditGuardTick reads settings", () => {
  it("does nothing when the guard is disabled in settings", async () => {
    const getConnections = vi.fn(async () => [seat()]);
    await runCodebuddyCreditGuardTick({
      getSettings: async () => ({ codebuddyCreditGuard: { enabled: false, thresholdPercent: 10 } }),
      getConnections,
      getUsage: vi.fn(async () => ({ quotas: exhausted(99, 100) })),
      update: vi.fn(),
      resolveProxy: async () => ({}),
    });
    expect(getConnections).not.toHaveBeenCalled();
  });

  it("applies the configured threshold, not the 10% default", async () => {
    const update = vi.fn(async () => ({}));
    // 80% used -> 20% remaining. Default 10% would keep it on; configured 25% must disable.
    await runCodebuddyCreditGuardTick({
      getSettings: async () => ({ codebuddyCreditGuard: { enabled: true, thresholdPercent: 25 } }),
      getConnections: async ({ provider }) => (provider === "codebuddy-intl" ? [seat({ id: "x" })] : []),
      getUsage: async () => ({ quotas: exhausted(80, 100) }),
      update,
      resolveProxy: async () => ({}),
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][1].isActive).toBe(false);
  });
});
