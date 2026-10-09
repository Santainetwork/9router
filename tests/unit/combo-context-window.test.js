// Per-combo `contextWindow` override: storage semantics (repo), backup
// round-trip (export/import) and the API's accept/reject contract.
//
// The override exists so a combo can publish a window other than the derived
// min across its seats in /v1/models. Emission is covered separately by
// v1-models-combo-context.test.js; this file covers everything below it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
  },
}));

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let combosRoute;
let comboByIdRoute;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-combo-ctx-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  combosRoute = await import("../../src/app/api/combos/route.js");
  comboByIdRoute = await import("../../src/app/api/combos/[id]/route.js");
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

function jsonRequest(method, url, body) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("combosRepo contextWindow", () => {
  it("stores an override and reads it back as a number", async () => {
    const combo = await db.createCombo({ name: "ctx-stored", models: ["ocg/mimo-v2.5"], contextWindow: 999000 });
    expect(combo.contextWindow).toBe(999000);
    expect((await db.getComboByName("ctx-stored")).contextWindow).toBe(999000);
  });

  it("normalizes junk to null instead of writing it through", async () => {
    for (const [name, value] of [["ctx-zero", 0], ["ctx-negative", -5], ["ctx-text", "abc"], ["ctx-nan", Number.NaN]]) {
      const combo = await db.createCombo({ name, models: ["m"], contextWindow: value });
      expect(combo.contextWindow, `${name} should store null`).toBeNull();
    }
  });

  it("keeps the stored override on a partial update and clears it on explicit null", async () => {
    const combo = await db.createCombo({ name: "ctx-partial", models: ["m"], contextWindow: 123456 });

    const renamed = await db.updateCombo(combo.id, { name: "ctx-partial-renamed" });
    expect(renamed.contextWindow).toBe(123456);
    expect((await db.getComboById(combo.id)).contextWindow).toBe(123456);

    const cleared = await db.updateCombo(combo.id, { contextWindow: null });
    expect(cleared.contextWindow).toBeNull();
    expect((await db.getComboById(combo.id)).contextWindow).toBeNull();

    const set = await db.updateCombo(combo.id, { contextWindow: 777000 });
    expect(set.contextWindow).toBe(777000);
  });
});

describe("export/import round-trip", () => {
  it("carries the override through exportDb → importDb", async () => {
    await db.createCombo({ name: "ctx-export", models: ["m"], contextWindow: 512000 });
    const dump = await db.exportDb();
    expect(dump.combos.find((c) => c.name === "ctx-export").contextWindow).toBe(512000);

    await db.deleteCombo((await db.getComboByName("ctx-export")).id);
    await db.importDb(dump);
    expect((await db.getComboByName("ctx-export")).contextWindow).toBe(512000);
  });

  it("restores a pre-column backup as 'no override'", async () => {
    const legacy = {
      combos: [{ id: "legacy-1", name: "ctx-legacy", kind: null, models: ["m"], createdAt: "t0", updatedAt: "t0" }],
    };
    await db.importDb(legacy);
    expect((await db.getComboByName("ctx-legacy")).contextWindow).toBeNull();
  });

  it("refuses a malformed value instead of silently dropping it", async () => {
    await expect(
      db.importDb({
        combos: [{ id: "bad-1", name: "ctx-bad", kind: null, models: ["m"], contextWindow: -1, createdAt: "t0", updatedAt: "t0" }],
      }),
    ).rejects.toThrow(/combos bad-1:/);
  });
});

describe("combo API contextWindow validation", () => {
  it("creates with an override and reports it back", async () => {
    const res = await combosRoute.POST(jsonRequest("POST", "https://9router.local/api/combos", {
      name: "api-ctx", models: ["m"], contextWindow: 64000,
    }));
    expect(res.status).toBe(201);
    expect((await res.json()).contextWindow).toBe(64000);
  });

  it("treats an absent override as 'derive from seats'", async () => {
    const res = await combosRoute.POST(jsonRequest("POST", "https://9router.local/api/combos", {
      name: "api-ctx-absent", models: ["m"],
    }));
    expect(res.status).toBe(201);
    expect((await res.json()).contextWindow).toBeNull();
  });

  it("400s on a malformed override", async () => {
    for (const bad of [0, -1, 1.5, "abc", {}]) {
      const res = await combosRoute.POST(jsonRequest("POST", "https://9router.local/api/combos", {
        name: `api-bad-${String(bad).replace(/\W/g, "")}`, models: ["m"], contextWindow: bad,
      }));
      expect(res.status, `should reject ${JSON.stringify(bad)}`).toBe(400);
      expect((await res.json()).error).toMatch(/positive integer/);
    }
  });

  it("clears with null and keeps the stored value when the key is absent", async () => {
    const created = await (await combosRoute.POST(jsonRequest("POST", "https://9router.local/api/combos", {
      name: "api-ctx-update", models: ["m"], contextWindow: 32000,
    }))).json();

    const renamed = await comboByIdRoute.PUT(
      jsonRequest("PUT", `https://9router.local/api/combos/${created.id}`, { name: "api-ctx-update-renamed" }),
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).contextWindow).toBe(32000);

    const cleared = await comboByIdRoute.PUT(
      jsonRequest("PUT", `https://9router.local/api/combos/${created.id}`, { contextWindow: null }),
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).contextWindow).toBeNull();
  });

  it("400s a malformed update without touching the stored override", async () => {
    const created = await (await combosRoute.POST(jsonRequest("POST", "https://9router.local/api/combos", {
      name: "api-ctx-keep", models: ["m"], contextWindow: 48000,
    }))).json();

    const res = await comboByIdRoute.PUT(
      jsonRequest("PUT", `https://9router.local/api/combos/${created.id}`, { contextWindow: "nope" }),
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(res.status).toBe(400);
    expect((await db.getComboById(created.id)).contextWindow).toBe(48000);
  });
});
