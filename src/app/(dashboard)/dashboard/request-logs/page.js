import RequestLogsClient from "./RequestLogsClient";

export default function RequestLogsPage() {
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header>
        <h1 className="text-3xl font-bold text-text-main">Request Logs</h1>
        <p className="mt-1 text-sm text-text-muted">Inbound API request audit trail.</p>
      </header>
      <RequestLogsClient />
    </div>
  );
}
