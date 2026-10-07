"use client";

import { useState, useCallback, useEffect, useId } from "react";
import PropTypes from "prop-types";
import { Card, Button, Modal } from "@/shared/components";
import { getModelsByProviderId, getModelKind } from "@/shared/constants/models";
import { getProviderAlias } from "@/shared/constants/providers";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { TableSkeleton } from "@/shared/components/Loading";

// ── ModelRow ───────────────────────────────────────────────────
export function ModelRow({ model, fullModel, copied, onCopy, testStatus, isCustom, isFree, onDeleteAlias, onTest, isTesting }) {
  const borderColor = testStatus === "ok" ? "border-success/40" : testStatus === "error" ? "border-danger/40" : "border-border";
  const iconColor = testStatus === "ok" ? "#22c55e" : testStatus === "error" ? "#ef4444" : undefined;

  return (
    <div className={`group min-w-0 px-3 py-2 rounded-lg border ${borderColor} hover:bg-surface-2 transition-colors`}>
      <div className="flex items-center gap-2">
        <span className="material-symbols-outlined text-base" style={iconColor ? { color: iconColor } : undefined} aria-hidden="true">
          {testStatus === "ok" ? "check_circle" : testStatus === "error" ? "cancel" : "smart_toy"}
        </span>
        <span className="sr-only">{testStatus === "ok" ? "Model test passed" : testStatus === "error" ? "Model test failed" : "Model not tested"}</span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <code className="break-all text-xs text-text-main font-mono bg-surface-2 px-1.5 py-0.5 rounded">{fullModel}</code>
          {model.name && <span className="text-[9px] text-text-muted/90 italic pl-1">{model.name}</span>}
        </div>
        {onTest && (
          <div className="relative group/btn">
            <button type="button" aria-label={`Test ${fullModel}`} onClick={onTest} disabled={isTesting} className="flex size-8 items-center justify-center hover:bg-surface-2 rounded text-text-muted hover:text-primary focus-visible:ring-2 focus-visible:ring-primary">
              <span className="material-symbols-outlined text-sm" style={isTesting ? { animation: "spin 1s linear infinite" } : undefined}>
                {isTesting ? "progress_activity" : "science"}
              </span>
            </button>
            <span className="pointer-events-none absolute mt-1 top-5 left-1/2 -translate-x-1/2 text-[10px] text-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
              {isTesting ? "Testing..." : "Test"}
            </span>
          </div>
        )}
        <div className="relative group/btn">
          <button type="button" aria-label={`Copy ${fullModel}`} onClick={() => onCopy(fullModel, `model-${model.id}`)} className="flex size-8 items-center justify-center hover:bg-surface-2 rounded text-text-muted hover:text-primary focus-visible:ring-2 focus-visible:ring-primary">
            <span className="material-symbols-outlined text-sm">{copied === `model-${model.id}` ? "check" : "content_copy"}</span>
          </button>
          <span className="pointer-events-none absolute mt-1 top-5 left-1/2 -translate-x-1/2 text-[10px] text-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
            {copied === `model-${model.id}` ? "Copied!" : "Copy"}
          </span>
        </div>
        {isFree && <span className="text-[10px] font-bold text-success bg-success/10 px-1.5 py-0.5 rounded">FREE</span>}
        {isCustom && (
          <button type="button" aria-label={`Remove ${fullModel}`} onClick={onDeleteAlias} className="flex size-8 shrink-0 items-center justify-center hover:bg-danger/10 rounded text-text-muted hover:text-danger focus-visible:ring-2 focus-visible:ring-primary ml-auto" title="Remove custom model">
            <span className="material-symbols-outlined text-sm">close</span>
          </button>
        )}
      </div>
    </div>
  );
}

ModelRow.propTypes = {
  model: PropTypes.shape({ id: PropTypes.string.isRequired }).isRequired,
  fullModel: PropTypes.string.isRequired,
  copied: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
  testStatus: PropTypes.oneOf(["ok", "error"]),
  isCustom: PropTypes.bool,
  isFree: PropTypes.bool,
  onDeleteAlias: PropTypes.func,
  onTest: PropTypes.func,
  isTesting: PropTypes.bool,
};

// ── AddCustomModelModal ────────────────────────────────────────
function AddCustomModelModal({ isOpen, onSave, onClose }) {
  const [modelId, setModelId] = useState("");
  const inputId = useId();

  const handleSave = () => {
    if (!modelId.trim()) return;
    onSave(modelId.trim());
    setModelId("");
  };

  return (
    <Modal isOpen={isOpen} title="Add Custom Model" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div>
          <label htmlFor={inputId} className="text-xs text-text-muted mb-1 block">Model ID</label>
          <input
            id={inputId}
            className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface focus-visible:ring-2 focus-visible:ring-primary"
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSave()}
            placeholder="e.g. tts-1-hd"
            autoFocus
          />
        </div>
        <div className="flex gap-2">
          <Button onClick={handleSave} fullWidth disabled={!modelId.trim()}>Add</Button>
          <Button onClick={onClose} variant="ghost" fullWidth>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}

AddCustomModelModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onSave: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};

// ── ModelsCard ─────────────────────────────────────────────────
// Self-contained card: shows models for a provider, filtered by optional `kindFilter`.
// kindFilter: if provided, only shows models with matching type/kinds field.
export default function ModelsCard({ providerId, kindFilter, providerAliasOverride }) {
  const { copied, copy } = useCopyToClipboard();
  const [modelAliases, setModelAliases] = useState({});
  const [customModels, setCustomModels] = useState([]);
  const [modelTestResults, setModelTestResults] = useState({});
  const [testingModelId, setTestingModelId] = useState(null);
  const [testError, setTestError] = useState("");
  const [showAddCustomModel, setShowAddCustomModel] = useState(false);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const providerAlias = providerAliasOverride || getProviderAlias(providerId);
  const effectiveType = kindFilter || "llm";

  const fetchData = useCallback(async () => {
    setLoadError("");
    try {
      const [aliasRes, customRes] = await Promise.all([
        fetch("/api/models/alias"),
        fetch("/api/models/custom", { cache: "no-store" }),
      ]);
      const aliasData = await aliasRes.json();
      const customData = await customRes.json();
      if (!aliasRes.ok || !customRes.ok) throw new Error("Could not load model configuration. Reload to try again.");
      if (aliasRes.ok) setModelAliases(aliasData.aliases || {});
      if (customRes.ok) setCustomModels(customData.models || []);
    } catch (e) { setLoadError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleSetAlias = async (modelId, alias) => {
    const fullModel = `${providerAlias}/${modelId}`;
    try {
      const res = await fetch("/api/models/alias", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: fullModel, alias }),
      });
      if (res.ok) await fetchData();
    } catch (e) { console.log("set alias error:", e); }
  };

  const handleDeleteAlias = async (alias) => {
    try {
      const res = await fetch(`/api/models/alias?alias=${encodeURIComponent(alias)}`, { method: "DELETE" });
      if (res.ok) await fetchData();
    } catch (e) { console.log("delete alias error:", e); }
  };

  const handleAddCustomModel = async (modelId) => {
    try {
      const res = await fetch("/api/models/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerAlias, id: modelId, type: effectiveType }),
      });
      if (res.ok) {
        await fetchData();
        window.dispatchEvent(new CustomEvent("customModelChanged"));
      }
    } catch (e) { console.log("add custom model error:", e); }
  };

  const handleDeleteCustomModel = async (modelId) => {
    try {
      const params = new URLSearchParams({ providerAlias, id: modelId, type: effectiveType });
      const res = await fetch(`/api/models/custom?${params}`, { method: "DELETE" });
      if (res.ok) {
        await fetchData();
        window.dispatchEvent(new CustomEvent("customModelChanged"));
      }
    } catch (e) { console.log("delete custom model error:", e); }
  };

  const handleTestModel = async (modelId) => {
    if (testingModelId) return;
    setTestingModelId(modelId);
    try {
      const res = await fetch("/api/models/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: `${providerAlias}/${modelId}`, kind: kindFilter }),
      });
      const data = await res.json();
      setModelTestResults((prev) => ({ ...prev, [modelId]: data.ok ? "ok" : "error" }));
      setTestError(data.ok ? "" : (data.error || "Model not reachable"));
    } catch {
      setModelTestResults((prev) => ({ ...prev, [modelId]: "error" }));
      setTestError("Network error");
    } finally { setTestingModelId(null); }
  };

  // Built-in models — filter by kindFilter if provided
  const allBuiltIn = getModelsByProviderId(providerId);
  const builtInModels = kindFilter
    ? allBuiltIn.filter((m) => {
        if (m.kinds) return m.kinds.includes(kindFilter);
        return getModelKind(m, "llm") === kindFilter;
      })
    : allBuiltIn;

  // Custom models for this provider + kind, dedupe vs built-in
  const myCustomModels = customModels.filter(
    (m) => m.providerAlias === providerAlias
      && getModelKind(m, "llm") === effectiveType
      && !builtInModels.some((b) => b.id === m.id)
  );

  const query = search.trim().toLowerCase();
  const matchesSearch = (model) => `${providerAlias}/${model.id} ${model.name || ""}`.toLowerCase().includes(query);
  const displayModels = builtInModels.filter(matchesSearch);
  const visibleCustomModels = myCustomModels.filter(matchesSearch);

  return (
    <>
      <Card className="min-w-0">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
          <h2 className="text-lg font-semibold">Models{kindFilter ? ` — ${kindFilter.toUpperCase()}` : ""}</h2>
          <input type="search" aria-label="Search models" placeholder="Search models…" value={search} onChange={(event) => setSearch(event.target.value)} className="h-10 w-full min-w-0 rounded-lg border border-border bg-surface px-3 text-sm text-text-main sm:max-w-xs focus-visible:ring-2 focus-visible:ring-primary" />
        </div>
        {loadError && <p role="alert" className="mb-3 text-sm text-danger">{loadError}</p>}
        {testError && <p className="text-xs text-danger mb-3 break-words">{testError}</p>}

        {loading ? <TableSkeleton rows={3} columns={2} /> : <div className="grid max-h-[60vh] grid-cols-1 gap-3 overflow-y-auto overscroll-contain md:grid-cols-2" role="region" aria-label="Available models" tabIndex={0}>
          {!displayModels.length && !visibleCustomModels.length && <p role="status" className="py-6 text-sm text-text-muted">No models match your search.</p>}
          {displayModels.map((model) => {
            const fullModel = `${providerAlias}/${model.id}`;
            const existingAlias = Object.entries(modelAliases).find(([, m]) => m === fullModel)?.[0];
            return (
              <ModelRow
                key={model.id}
                model={model}
                fullModel={`${providerAlias}/${model.id}`}
                alias={existingAlias}
                copied={copied}
                onCopy={copy}
                onSetAlias={(alias) => handleSetAlias(model.id, alias)}
                onDeleteAlias={() => handleDeleteAlias(existingAlias)}
                testStatus={modelTestResults[model.id]}
                onTest={() => handleTestModel(model.id)}
                isTesting={testingModelId === model.id}
                isFree={model.isFree}
              />
            );
          })}

          {visibleCustomModels.map((model) => (
            <ModelRow
              key={`${model.id}-${model.type}`}
              model={{ id: model.id, name: model.name }}
              fullModel={`${providerAlias}/${model.id}`}
              copied={copied}
              onCopy={copy}
              onSetAlias={() => {}}
              onDeleteAlias={() => handleDeleteCustomModel(model.id)}
              testStatus={modelTestResults[model.id]}
              onTest={() => handleTestModel(model.id)}
              isTesting={testingModelId === model.id}
              isCustom
            />
          ))}

          <button
            onClick={() => setShowAddCustomModel(true)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-dashed border-black/15 dark:border-white/15 text-xs text-text-muted hover:text-primary hover:border-primary/40 transition-colors"
          >
            <span className="material-symbols-outlined text-sm">add</span>
            Add Model
          </button>
        </div>}
      </Card>

      <AddCustomModelModal
        isOpen={showAddCustomModel}
        onSave={async (modelId) => {
          await handleAddCustomModel(modelId);
          setShowAddCustomModel(false);
        }}
        onClose={() => setShowAddCustomModel(false)}
      />
    </>
  );
}

ModelsCard.propTypes = {
  providerId: PropTypes.string.isRequired,
  kindFilter: PropTypes.string, // e.g. "tts", "embedding" — filters models shown
  providerAliasOverride: PropTypes.string, // override alias (e.g. for custom-embedding nodes using prefix)
};
