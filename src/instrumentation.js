export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    // Only the control process owns the recurring catalog refresh. API workers
    // read the catalog the control process wrote, so they skip the sync to avoid
    // N replicas racing to rewrite the same file.
    const { isApiWorkerRole } = await import("@/shared/utils/engineConfig.js");
    if (!isApiWorkerRole()) {
      const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
      startModelCatalogSync();
    }
  }
}
