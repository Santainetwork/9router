import { describe, expect, it, vi } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Regression guard: a bare Anthropic-style model string sent to /v1/messages
// must resolve through the user-configured model alias map (kv modelAliases)
// instead of inferring the native `anthropic` provider, which 404s when no
// native Anthropic credentials exist.
describe("bare anthropic model alias resolution", () => {
  it("resolves claude-sonnet-4 via configured alias to openrouter", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-alias-regression-"));
    process.env.DATA_DIR = tempDir;
    try {
      const { setModelAlias, getModelAliases } = await import("@/lib/db/repos/aliasRepo.js");
      await setModelAlias("claude-sonnet-4", "openrouter/anthropic/claude-sonnet-4");
      expect(await getModelAliases()).toEqual({
        "claude-sonnet-4": "openrouter/anthropic/claude-sonnet-4",
      });

      // Same path handleChat uses: getModelInfo -> parseModel -> getModelInfoCore
      const { getModelInfoCore } = await import("open-sse/services/model.js");
      await expect(getModelInfoCore("claude-sonnet-4", await getModelAliases())).resolves.toEqual({
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4",
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("without an alias, bare Claude model does not map to native Anthropic", async () => {
    const { getModelInfoCore } = await import("open-sse/services/model.js");
    await expect(getModelInfoCore("claude-sonnet-4", {})).resolves.toEqual({
      provider: "openai",
      model: "claude-sonnet-4",
    });
  });

  it("keeps a configured combo ahead of bare-model inference", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-combo-routing-"));
    const previousDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    try {
      const { createCombo } = await import("@/models/index.js");
      const { getModelInfo } = await import("@/sse/services/model.js");
      await createCombo({
        name: "claude-sonnet-4",
        models: ["openrouter/anthropic/claude-sonnet-4"],
      });

      await expect(getModelInfo("claude-sonnet-4")).resolves.toEqual({
        provider: null,
        model: "claude-sonnet-4",
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      if (previousDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = previousDataDir;
    }
  });
});
