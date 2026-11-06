"use client";

import { useEffect, useState } from "react";
import { Card } from "@/shared/components";

// Command Code serves two wires from the same host and API key:
//   alpha — /alpha/generate, the CLI envelope (AI-SDK NDJSON), default
//   v1    — /provider/v1/chat/completions, standards-compliant OpenAI gateway
//           (95 models, plan-gated per model)
// The choice is per connection: a plan that only grants models on one wire can
// still use the other accounts on the other wire.
const OPTIONS = [
  {
    value: "alpha",
    label: "Alpha",
    path: "/alpha/generate",
    hint: "CLI envelope, NDJSON. Default; same wire the official CLI uses.",
  },
  {
    value: "v1",
    label: "V1",
    path: "/provider/v1/chat/completions",
    hint: "OpenAI-compatible. Native tool calls and standard SSE; model access follows your plan.",
  },
];

export default function CommandCodeTransportCard({ connectionId, transport: initial = "alpha" }) {
  const [transport, setTransport] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setTransport(initial === "v1" ? "v1" : "alpha");
  }, [initial, connectionId]);

  const choose = async (value) => {
    if (!connectionId || saving || value === transport) return;
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/providers/${connectionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerSpecificData: { commandcodeTransport: value } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setTransport(value);
    } catch (err) {
      setError(err.message || "Failed to save transport");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <div className="mb-3">
        <h2 className="text-lg font-semibold">Transport</h2>
        <p className="mt-0.5 text-xs text-text-muted">
          Which Command Code endpoint this connection calls. Applies to new requests only.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {OPTIONS.map((opt) => {
          const active = transport === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              disabled={!connectionId || saving}
              onClick={() => choose(opt.value)}
              className={`rounded-lg border p-3 text-left transition-colors ${
                active
                  ? "border-primary bg-primary/5"
                  : "border-border hover:bg-black/5 dark:hover:bg-white/5"
              } ${!connectionId || saving ? "opacity-60" : ""}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-text-primary">{opt.label}</span>
                {active && <span className="text-xs font-medium text-primary">active</span>}
              </div>
              <div className="mt-1 font-mono text-[11px] text-text-muted">{opt.path}</div>
              <p className="mt-1 text-xs text-text-muted">{opt.hint}</p>
            </button>
          );
        })}
      </div>
      {saving && <p className="mt-2 text-xs text-text-muted">Saving…</p>}
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      {!connectionId && (
        <p className="mt-2 text-xs text-text-muted">Add a connection first to choose a transport.</p>
      )}
    </Card>
  );
}
