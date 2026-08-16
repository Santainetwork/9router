"use client";

import { useState } from "react";
import { Card } from "@/shared/components";
import useFooterStore, { FOOTER_FIELDS } from "@/store/footerStore";

// Dedicated page for the Basic Chat response-footer settings. Split out of the
// chat header so footer governance lives in one focused place. The same zustand
// store backs both this page and the chat view, so changes apply everywhere.

function formatDuration(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

// A representative sample reply so users see exactly how their choices render.
const SAMPLE = {
  provider: "anthropic-compatible-xxxx",
  providerName: "UTAMA",
  model: "amar/amanai/deepseek-v4-flash",
  usage: { promptTokens: 2009, completionTokens: 25, totalTokens: 2034 },
  apiKeyQueueMs: 1200,
  providerQueueMs: 350,
  durationMs: 3100,
};

export default function FooterSettingsPageClient() {
  const footer = useFooterStore();
  const [savedFlash, setSavedFlash] = useState(false);

  const flash = () => {
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 900);
  };

  return (
    <div className="max-w-3xl mx-auto px-1 sm:px-0 flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Response Footer</h1>
        <p className="text-sm text-text-muted mt-1">
          Control the small info line shown under each assistant reply in Basic Chat.
          Pick which details appear and add your own custom footer text.
        </p>
        <p className="text-[11px] text-text-subtle mt-1">Modified by SantaiNetwork</p>
      </div>

      {/* Live preview */}
      <Card>
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">Live preview</p>
          {savedFlash ? <span className="text-xs text-green-500">Saved</span> : null}
        </div>
        <div className="mt-3 rounded-xl border border-border bg-bg p-4">
          <p className="text-sm">Hello! How can I help you with your coding today?</p>
          {footer.enabled && (footer.hasVisibleField() || footer.customMessage) ? (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted">
              {footer.fields.providerModel ? <span>{SAMPLE.providerName} · {SAMPLE.model}</span> : null}
              {footer.fields.tokens ? <span>{SAMPLE.usage.promptTokens} in · {SAMPLE.usage.completionTokens} out · {SAMPLE.usage.totalTokens} total</span> : null}
              {footer.fields.apiKeyQueue ? <span>API queue {formatDuration(SAMPLE.apiKeyQueueMs)}</span> : null}
              {footer.fields.providerQueue ? <span>Provider queue {formatDuration(SAMPLE.providerQueueMs)}</span> : null}
              {footer.fields.duration ? <span>{formatDuration(SAMPLE.durationMs)}</span> : null}
              {footer.customMessage ? <span className="whitespace-pre-wrap text-text-subtle">{footer.customMessage}</span> : null}
            </div>
          ) : (
            <p className="mt-2 text-[11px] italic text-text-subtle">Footer hidden</p>
          )}
        </div>
      </Card>

      {/* Master + fields */}
      <Card>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={footer.enabled}
            onChange={(e) => { footer.setEnabled(e.target.checked); flash(); }}
            className="size-4 accent-primary"
          />
          Show response footer
        </label>

        <div className={`mt-4 grid gap-2 sm:grid-cols-2 ${footer.enabled ? "" : "pointer-events-none opacity-40"}`}>
          {FOOTER_FIELDS.map((field) => (
            <label key={field.key} className="flex items-start gap-2 rounded-[12px] border border-border bg-bg px-3 py-2 text-sm">
              <input
                type="checkbox"
                checked={!!footer.fields[field.key]}
                onChange={() => { footer.toggleField(field.key); flash(); }}
                className="mt-0.5 size-4 accent-primary"
              />
              <span className="min-w-0">
                <span className="block">{field.label}</span>
                <span className="block text-[11px] leading-4 text-text-muted">{field.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </Card>

      {/* Custom footer */}
      <Card>
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">Your custom footer</p>
          <button
            type="button"
            onClick={() => { footer.resetFooter(); flash(); }}
            className="text-xs text-text-muted underline hover:text-text-main"
          >
            Reset all
          </button>
        </div>
        <p className="mt-1 text-xs text-text-muted">
          Free text appended to the footer line. Supports multiple lines. Leave blank for none.
        </p>
        <textarea
          value={footer.customMessage}
          onChange={(e) => footer.setCustomMessage(e.target.value)}
          onBlur={flash}
          rows={3}
          maxLength={500}
          placeholder="e.g. Powered by SantaiNetwork"
          className={`mt-2 w-full rounded-[12px] border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-primary/50 ${footer.enabled ? "" : "opacity-40"}`}
        />
        <p className="mt-1 text-right text-[11px] text-text-subtle">{footer.customMessage.length}/500</p>
      </Card>
    </div>
  );
}
