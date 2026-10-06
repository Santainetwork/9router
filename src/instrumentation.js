// Next.js build/prerender must not spawn long-lived children.
const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build"
  || process.env.NEXT_PHASE === "phase-export"
  || process.env.NEXT_PHASE === "phase-static";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Control owns worker log aggregation; API workers never spawn a follower.
    const { isApiWorkerRole } = await import("@/shared/utils/engineConfig.js");
    if (!isApiWorkerRole() && !isBuildPhase) {
      const { startWorkerJournalCollector } = await import("@/lib/workerJournalLogs");
      const journalCollector = startWorkerJournalCollector();
      if (!journalCollector) {
        const { startWorkerFileCollector } = await import("@/lib/workerFileLogs");
        const { getDataDir } = await import("@/lib/dataDir.js");
        startWorkerFileCollector({ dataDir: getDataDir() });
      }
      const { startSqliteMutationWriter } = await import("@/lib/db/sqliteMutationRuntime.js");
      await startSqliteMutationWriter();
    } else if (isApiWorkerRole() && !isBuildPhase) {
      const { installWorkerFileMirror } = await import("@/lib/workerFileLogs");
      const { getDataDir } = await import("@/lib/dataDir.js");
      installWorkerFileMirror({ dataDir: getDataDir() });
    }

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    // Only the control process owns the recurring catalog refresh. API workers
    // read the catalog the control process wrote, so they skip the sync to avoid
    // N replicas racing to rewrite the same file.
    if (!isApiWorkerRole()) {
      const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
      startModelCatalogSync();
    }
  }
}
