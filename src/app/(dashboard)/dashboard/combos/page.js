"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToVerticalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import { Card, Button, Modal, Input, CardSkeleton, ModelSelectModal, ConfirmModal, CapacityBadges, Select, Toggle } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { useModelCaps } from "@/shared/hooks/useModelCaps";
import { aggregateComboCapabilities } from "open-sse/providers/capabilities.js";

// Validate combo name: only a-z, A-Z, 0-9, -, _
const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;

// Capacity adapter: global fallback pools of models per input-modality capability.
// A request needing a capability the target model/combo lacks switches straight
// to the first enabled model here instead of erroring or dropping the data.
const CAPACITY_ADAPTER_CAPS = [
  { key: "vision", label: "Vision", icon: "visibility", desc: "images (png, jpg, webp, …)" },
  // pdf, videoInput temporarily hidden — no translator support yet for those blocks.
  { key: "audioInput", label: "Audio", icon: "graphic_eq", desc: "audio input" },
];
const DEFAULT_FALLBACK_MODEL = "oc/mimo-v2.6-flash-free";
const EMPTY_CAP_ENTRY = { enabled: true, roundRobin: false, models: [] };
const EMPTY_CAPACITY_ADAPTER = {
  vision: { ...EMPTY_CAP_ENTRY },
  pdf: { ...EMPTY_CAP_ENTRY },
  audioInput: { ...EMPTY_CAP_ENTRY },
  videoInput: { ...EMPTY_CAP_ENTRY },
};
const upgradeLegacyModel = (m) => (m === "oc/mimo-v2.5-free" ? DEFAULT_FALLBACK_MODEL : m);

// Backward-compat: legacy stored form was an array of {model, enabled}.
function normalizeCapEntry(entry) {
  if (Array.isArray(entry)) {
    return { enabled: true, roundRobin: false, models: entry.map((e) => upgradeLegacyModel(e?.model || e)).filter(Boolean) };
  }
  if (entry && typeof entry === "object") {
    return {
      enabled: entry.enabled !== false,
      roundRobin: !!entry.roundRobin,
      models: Array.isArray(entry.models) ? entry.models.map(upgradeLegacyModel).filter(Boolean) : [],
    };
  }
  return { ...EMPTY_CAP_ENTRY };
}

const STRATEGY_OPTIONS = [
  { value: "fallback", label: "Fallback — try in order" },
  { value: "round-robin", label: "Round Robin — rotate" },
  { value: "fusion", label: "Fusion — panel + judge" },
];

export default function CombosPage() {
  const [combos, setCombos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingCombo, setEditingCombo] = useState(null);
  const [activeProviders, setActiveProviders] = useState([]);
  const [comboStrategies, setComboStrategies] = useState({});
  const [capacityAdapter, setCapacityAdapter] = useState(EMPTY_CAPACITY_ADAPTER);
  const { getCaps } = useModelCaps();
  const [confirmState, setConfirmState] = useState(null);
  const [comboSearch, setComboSearch] = useState("");
  const [selectedStrategy, setSelectedStrategy] = useState("all"); // "all" | "fallback" | "round-robin" | "fusion"
  const [selectedProvider, setSelectedProvider] = useState("all"); // "all" | string
  const [selectedCapability, setSelectedCapability] = useState("all"); // "all" | "vision" | "audio"
  const [selectedModelCount, setSelectedModelCount] = useState("all"); // "all" | "single" | "multi" | "empty"
  const [sortBy, setSortBy] = useState("name-asc"); // "name-asc" | "name-desc" | "models-desc" | "models-asc"
  const [presetLoading, setPresetLoading] = useState(null); // "cursor" | "claude" | null
  const [selectedIds, setSelectedIds] = useState([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const { copied, copy } = useCopyToClipboard();

  // Extract all unique providers present across all combos
  const availableProviders = useMemo(() => {
    const set = new Set();
    for (const c of combos) {
      for (const m of c.models || []) {
        if (m.includes("/")) {
          set.add(m.split("/")[0]);
        } else if (m.startsWith("claude")) {
          set.add("claude");
        } else if (m.startsWith("gpt") || m.startsWith("o1") || m.startsWith("o3")) {
          set.add("openai");
        } else if (m.startsWith("gemini")) {
          set.add("gemini");
        } else if (m.startsWith("deepseek")) {
          set.add("deepseek");
        }
      }
    }
    return Array.from(set).sort();
  }, [combos]);

  // Count combos per strategy
  const strategyCounts = useMemo(() => {
    const counts = { all: combos.length, fallback: 0, "round-robin": 0, fusion: 0 };
    for (const c of combos) {
      const strat = comboStrategies[c.name]?.fallbackStrategy || "fallback";
      if (strat === "round-robin") counts["round-robin"]++;
      else if (strat === "fusion") counts.fusion++;
      else counts.fallback++;
    }
    return counts;
  }, [combos, comboStrategies]);

  const hasActiveFilters = useMemo(() => {
    return (
      comboSearch.trim() !== "" ||
      selectedStrategy !== "all" ||
      selectedProvider !== "all" ||
      selectedCapability !== "all" ||
      selectedModelCount !== "all" ||
      sortBy !== "name-asc"
    );
  }, [comboSearch, selectedStrategy, selectedProvider, selectedCapability, selectedModelCount, sortBy]);

  const resetFilters = () => {
    setComboSearch("");
    setSelectedStrategy("all");
    setSelectedProvider("all");
    setSelectedCapability("all");
    setSelectedModelCount("all");
    setSortBy("name-asc");
  };

  const filteredCombos = useMemo(() => {
    let result = combos.filter((c) => {
      const strat = comboStrategies[c.name]?.fallbackStrategy || "fallback";

      // 1. Search Query
      const q = comboSearch.trim().toLowerCase();
      if (q) {
        const nameMatch = c.name?.toLowerCase().includes(q);
        const modelsMatch = (c.models || []).some((m) => m.toLowerCase().includes(q));
        const judgeMatch = comboStrategies[c.name]?.judgeModel?.toLowerCase()?.includes(q);
        if (!nameMatch && !modelsMatch && !judgeMatch) return false;
      }

      // 2. Strategy Filter
      if (selectedStrategy !== "all" && strat !== selectedStrategy) {
        return false;
      }

      // 3. Provider Filter
      if (selectedProvider !== "all") {
        const hasProvider = (c.models || []).some((m) => {
          if (m.includes("/")) return m.split("/")[0].toLowerCase() === selectedProvider.toLowerCase();
          return m.toLowerCase().startsWith(selectedProvider.toLowerCase());
        });
        if (!hasProvider) return false;
      }

      // 4. Capability Filter
      if (selectedCapability !== "all") {
        const capKey = selectedCapability === "vision" ? "vision" : "audioInput";
        const hasCap = (c.models || []).some((m) => getCaps?.(m)?.[capKey]);
        if (!hasCap) return false;
      }

      // 5. Model Count Filter
      const count = c.models?.length || 0;
      if (selectedModelCount === "single" && count !== 1) return false;
      if (selectedModelCount === "multi" && count < 2) return false;
      if (selectedModelCount === "empty" && count !== 0) return false;

      return true;
    });

    // Sorting
    result = [...result].sort((a, b) => {
      if (sortBy === "name-asc") return a.name.localeCompare(b.name);
      if (sortBy === "name-desc") return b.name.localeCompare(a.name);
      if (sortBy === "models-desc") return (b.models?.length || 0) - (a.models?.length || 0);
      if (sortBy === "models-asc") return (a.models?.length || 0) - (b.models?.length || 0);
      return 0;
    });

    return result;
  }, [
    combos,
    comboSearch,
    selectedStrategy,
    selectedProvider,
    selectedCapability,
    selectedModelCount,
    sortBy,
    comboStrategies,
    getCaps,
  ]);

  useEffect(() => {
    fetchData();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Drop stale selection when the combo list changes (delete / refresh).
  useEffect(() => {
    const alive = new Set(combos.map((c) => c.id));
    setSelectedIds((prev) => prev.filter((id) => alive.has(id)));
  }, [combos]);

  const selectedCombos = combos.filter((c) => selectedIds.includes(c.id));
  const visibleIds = filteredCombos.map((combo) => combo.id);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));
  const someSelected = selectedIds.length > 0;

  const toggleSelect = (id) => {
    setSelectedIds((prev) => (
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    ));
  };

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      if (allSelected) return prev.filter((id) => !visibleIds.includes(id));
      return [...new Set([...prev, ...visibleIds])];
    });
  };

  const clearSelection = () => setSelectedIds([]);

  const handleGeneratePresets = async (source) => {
    const label = source === "cursor" ? "Cursor Default" : "Claude Default";
    setPresetLoading(source);
    try {
      const previewRes = await fetch(`/api/combos/presets?source=${source}`);
      const preview = await previewRes.json();
      if (!previewRes.ok) {
        alert(preview.error || `Failed to preview ${label}`);
        return;
      }

      const toCreate = preview.toCreate ?? (preview.items || []).filter((i) => !i.exists).length;
      const toSkip = preview.toSkip ?? (preview.items || []).filter((i) => i.exists).length;
      const total = (preview.items || []).length;

      if (total === 0) {
        alert(`No ${label} models available to generate.`);
        return;
      }

      if (toCreate === 0) {
        alert(`All ${total} ${label} combos already exist. Nothing to create.`);
        return;
      }

      setConfirmState({
        title: `Generate ${label}`,
        message: `Create ${toCreate} combo${toCreate === 1 ? "" : "s"} named like ${source === "cursor" ? "Cursor" : "Claude"} model IDs (seeded with cu/… or cc/…). ${toSkip} already exist and will be skipped. You can edit any combo afterward to add fallbacks.`,
        confirmText: "Generate",
        variant: "primary",
        onConfirm: async () => {
          setConfirmState((prev) => prev ? { ...prev, loading: true } : null);
          try {
            const res = await fetch("/api/combos/presets", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ source }),
            });
            const data = await res.json();
            if (!res.ok) {
              alert(data.error || `Failed to generate ${label}`);
              return;
            }
            await fetchData();
            setConfirmState(null);
          } catch (error) {
            console.log(`Error generating ${label}:`, error);
            alert(`Failed to generate ${label}`);
            setConfirmState((prev) => prev ? { ...prev, loading: false } : null);
          }
        },
      });
    } catch (error) {
      console.log(`Error previewing ${label}:`, error);
      alert(`Failed to preview ${label}`);
    } finally {
      setPresetLoading(null);
    }
  };

  const fetchData = async () => {
    try {
      const [combosRes, providersRes, settingsRes] = await Promise.all([
        fetch("/api/combos"),
        fetch("/api/providers"),
        fetch("/api/settings"),
      ]);
      const combosData = await combosRes.json();
      const providersData = await providersRes.json();
      const settingsData = settingsRes.ok ? await settingsRes.json() : {};

      // Only LLM combos here - webSearch/webFetch combos belong to media-providers/web
      if (combosRes.ok) setCombos((combosData.combos || []).filter(c => !c.kind || c.kind === "llm"));
      if (providersRes.ok) {
        setActiveProviders(providersData.connections || []);
      }
      setComboStrategies(settingsData.comboStrategies || {});
      const rawAdapter = settingsData.capacityAdapter || {};
      const normalized = {};
      for (const cap of CAPACITY_ADAPTER_CAPS) {
        normalized[cap.key] = normalizeCapEntry(rawAdapter[cap.key]);
      }
      setCapacityAdapter(normalized);
    } catch (error) {
      console.log("Error fetching data:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleSetCapacityAdapter = async (next) => {
    setCapacityAdapter(next);
    try {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capacityAdapter: next }),
      });
    } catch (error) {
      console.log("Error updating capacity adapter:", error);
    }
  };

  const handleCreate = async (data) => {
    try {
      const res = await fetch("/api/combos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        await fetchData();
        setShowCreateModal(false);
      } else {
        const err = await res.json();
        alert(err.error || "Failed to create combo");
      }
    } catch (error) {
      console.log("Error creating combo:", error);
    }
  };

  const handleUpdate = async (id, data) => {
    try {
      const res = await fetch(`/api/combos/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        await fetchData();
        setEditingCombo(null);
      } else {
        const err = await res.json();
        alert(err.error || "Failed to update combo");
      }
    } catch (error) {
      console.log("Error updating combo:", error);
    }
  };

  const pruneStrategiesForNames = (names, base = comboStrategies) => {
    const updated = { ...base };
    for (const name of names) delete updated[name];
    return updated;
  };

  const persistComboStrategies = async (updated) => {
    await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comboStrategies: updated }),
    });
    setComboStrategies(updated);
  };

  const handleDelete = async (id) => {
    const combo = combos.find((c) => c.id === id);
    setConfirmState({
      title: "Delete Combo",
      message: combo ? `Delete combo "${combo.name}"?` : "Delete this combo?",
      onConfirm: async () => {
        setConfirmState((prev) => prev ? { ...prev, loading: true } : null);
        try {
          const res = await fetch(`/api/combos/${id}`, { method: "DELETE" });
          if (res.ok) {
            if (combo?.name) {
              await persistComboStrategies(pruneStrategiesForNames([combo.name]));
            }
            setCombos((prev) => prev.filter((c) => c.id !== id));
            setSelectedIds((prev) => prev.filter((x) => x !== id));
          }
          setConfirmState(null);
        } catch (error) {
          console.log("Error deleting combo:", error);
          setConfirmState((prev) => prev ? { ...prev, loading: false } : null);
        }
      }
    });
  };

  const handleBulkDelete = () => {
    if (selectedCombos.length === 0) return;
    const count = selectedCombos.length;
    setConfirmState({
      title: "Delete Selected Combos",
      message: `Delete ${count} selected combo${count === 1 ? "" : "s"}? This cannot be undone.`,
      confirmText: "Delete",
      variant: "danger",
      onConfirm: async () => {
        setConfirmState((prev) => prev ? { ...prev, loading: true } : null);
        setBulkBusy(true);
        try {
          const ids = selectedCombos.map((c) => c.id);
          const names = selectedCombos.map((c) => c.name);
          const results = await Promise.all(
            ids.map((id) => fetch(`/api/combos/${id}`, { method: "DELETE" }))
          );
          const failed = results.filter((r) => !r.ok).length;
          await persistComboStrategies(pruneStrategiesForNames(names));
          setCombos((prev) => prev.filter((c) => !ids.includes(c.id)));
          clearSelection();
          setConfirmState(null);
          if (failed > 0) alert(`Deleted with ${failed} failure${failed === 1 ? "" : "s"}.`);
        } catch (error) {
          console.log("Error bulk deleting combos:", error);
          alert("Failed to delete selected combos");
          setConfirmState((prev) => prev ? { ...prev, loading: false } : null);
        } finally {
          setBulkBusy(false);
        }
      },
    });
  };

  // Merge a per-combo strategy patch into settings.comboStrategies. Passing an empty
  // patch (strategy back to default "fallback") drops the entry entirely.
  const handleSetComboStrategy = async (comboName, patch) => {
    try {
      const updated = { ...comboStrategies };
      const next = { ...(updated[comboName] || {}), ...patch };
      // Prune to keep settings clean: default fallback with no extras = no entry.
      if (!next.fallbackStrategy || next.fallbackStrategy === "fallback") {
        delete updated[comboName];
      } else {
        updated[comboName] = next;
      }

      await persistComboStrategies(updated);
    } catch (error) {
      console.log("Error updating combo strategy:", error);
    }
  };

  const handleBulkSetStrategy = async (strategy) => {
    if (selectedCombos.length === 0 || !strategy) return;
    setBulkBusy(true);
    try {
      const updated = { ...comboStrategies };
      for (const combo of selectedCombos) {
        if (!strategy || strategy === "fallback") {
          delete updated[combo.name];
        } else {
          updated[combo.name] = {
            ...(updated[combo.name] || {}),
            fallbackStrategy: strategy,
          };
        }
      }
      await persistComboStrategies(updated);
    } catch (error) {
      console.log("Error bulk updating combo strategy:", error);
      alert("Failed to update strategy for selected combos");
    } finally {
      setBulkBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm text-text-muted mt-1">
            Group models under one name, then pick a strategy per combo:
          </p>
          <ul className="text-sm text-text-muted mt-2 flex flex-col gap-1">
            <li><span className="font-medium text-text-main">Fallback</span> — tries models in order (next on failure)</li>
            <li><span className="font-medium text-text-main">Round Robin</span> — rotates models across requests to spread load</li>
            <li><span className="font-medium text-text-main">Fusion</span> — queries all models in parallel, then a judge synthesizes one answer. Best quality, but costs the most: every request bills all panel models + the judge (N+1 calls)</li>
          </ul>
          <p className="hidden text-xs text-text-muted mt-3 max-w-2xl">
            <span className="font-medium text-text-main">Cursor / Claude Default</span> create combos named exactly like those clients&apos; model IDs (e.g. <code className="font-mono">composer-2.5</code>, <code className="font-mono">opus</code>), seeded with the matching <code className="font-mono">cu/…</code> or <code className="font-mono">cc/…</code> route so traffic can hit 9router without the prefix.
            {" "}Note: Cursor IDE itself often blocks built-in Composer / Grok from Override OpenAI Base URL (&quot;model does not support custom API&quot;); add them via Cursor&apos;s <span className="font-medium text-text-main">Add Custom Model</span> using the combo name, or pick a model Cursor allows through the custom endpoint.
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:items-stretch">
          <Button icon="add" onClick={() => setShowCreateModal(true)} className="w-full sm:w-auto whitespace-nowrap">
            Create Combo
          </Button>
          <div className="hidden">
            <Button
              variant="secondary"
              size="sm"
              icon="edit_note"
              loading={presetLoading === "cursor"}
              disabled={!!presetLoading}
              onClick={() => handleGeneratePresets("cursor")}
              className="w-full whitespace-nowrap"
            >
              Cursor Default
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon="smart_toy"
              loading={presetLoading === "claude"}
              disabled={!!presetLoading}
              onClick={() => handleGeneratePresets("claude")}
              className="w-full whitespace-nowrap"
            >
              Claude Default
            </Button>
          </div>
        </div>
      </div>

      {/* Combos Filter & Search Control Panel */}
      <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface-1 p-4 shadow-sm">
        {/* Row 1: Search + Strategy Pill Tabs */}
        <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-3">
          <div className="relative flex-1">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-[18px]">
              search
            </span>
            <input
              type="text"
              placeholder="Search combo, model, or prefix (e.g. claude, gpt, hx/, qd)..."
              value={comboSearch}
              onChange={(e) => setComboSearch(e.target.value)}
              className="w-full rounded-xl border border-border bg-input pl-9 pr-8 py-2 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-primary/40 placeholder:text-text-muted transition-all"
            />
            {comboSearch && (
              <button
                onClick={() => setComboSearch("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-text-muted hover:text-text-main p-1"
                title="Clear search"
              >
                ✕
              </button>
            )}
          </div>

          {/* Strategy Tabs */}
          <div className="flex flex-wrap items-center gap-1 p-1 bg-surface-2 rounded-xl border border-border/60 shrink-0">
            {[
              { id: "all", label: "All", count: strategyCounts.all },
              { id: "fallback", label: "Fallback", count: strategyCounts.fallback },
              { id: "round-robin", label: "Round Robin", count: strategyCounts["round-robin"] },
              { id: "fusion", label: "Fusion", count: strategyCounts.fusion },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setSelectedStrategy(tab.id)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer ${
                  selectedStrategy === tab.id
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-text-muted hover:text-text-main hover:bg-surface-3/50"
                }`}
              >
                <span>{tab.label}</span>
                <span
                  className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono font-bold ${
                    selectedStrategy === tab.id
                      ? "bg-primary-foreground/20 text-primary-foreground"
                      : "bg-surface-3 text-text-muted"
                  }`}
                >
                  {tab.count}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Row 2: Secondary Dropdown Filters */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 pt-2 border-t border-border/60">
          {/* Provider Filter */}
          <div>
            <label className="text-[10px] font-bold uppercase tracking-wider text-text-muted mb-1 block">
              Provider
            </label>
            <select
              value={selectedProvider}
              onChange={(e) => setSelectedProvider(e.target.value)}
              className="w-full rounded-lg border border-border bg-input px-2.5 py-1.5 text-xs font-semibold text-text-main focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
            >
              <option value="all">All Providers ({availableProviders.length})</option>
              {availableProviders.map((prov) => (
                <option key={prov} value={prov}>
                  {prov}
                </option>
              ))}
            </select>
          </div>

          {/* Capability Filter */}
          <div>
            <label className="text-[10px] font-bold uppercase tracking-wider text-text-muted mb-1 block">
              Capability
            </label>
            <select
              value={selectedCapability}
              onChange={(e) => setSelectedCapability(e.target.value)}
              className="w-full rounded-lg border border-border bg-input px-2.5 py-1.5 text-xs font-semibold text-text-main focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
            >
              <option value="all">All Capabilities</option>
              <option value="vision">Vision (Images)</option>
              <option value="audio">Audio (Voice)</option>
            </select>
          </div>

          {/* Model Count Filter */}
          <div>
            <label className="text-[10px] font-bold uppercase tracking-wider text-text-muted mb-1 block">
              Model Count
            </label>
            <select
              value={selectedModelCount}
              onChange={(e) => setSelectedModelCount(e.target.value)}
              className="w-full rounded-lg border border-border bg-input px-2.5 py-1.5 text-xs font-semibold text-text-main focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
            >
              <option value="all">All Sizes</option>
              <option value="single">Single Model (1)</option>
              <option value="multi">Multi-Model (2+)</option>
              <option value="empty">Empty (0)</option>
            </select>
          </div>

          {/* Sort By */}
          <div>
            <label className="text-[10px] font-bold uppercase tracking-wider text-text-muted mb-1 block">
              Sort By
            </label>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="w-full rounded-lg border border-border bg-input px-2.5 py-1.5 text-xs font-semibold text-text-main focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
            >
              <option value="name-asc">Name (A → Z)</option>
              <option value="name-desc">Name (Z → A)</option>
              <option value="models-desc">Most Models</option>
              <option value="models-asc">Fewest Models</option>
            </select>
          </div>
        </div>

        {/* Row 3: Active Filters Summary & Reset */}
        <div className="flex items-center justify-between text-xs pt-2 border-t border-border/40">
          <div className="flex items-center gap-2 text-text-muted">
            <span className="font-semibold text-text-main">
              Showing {filteredCombos.length} of {combos.length} combos
            </span>
            {hasActiveFilters && (
              <span className="text-[11px] text-primary font-medium">
                (filtered)
              </span>
            )}
          </div>
          {hasActiveFilters && (
            <button
              type="button"
              onClick={resetFilters}
              className="inline-flex items-center gap-1 text-xs font-semibold text-danger dark:text-danger hover:text-danger dark:hover:text-danger transition-colors cursor-pointer"
            >
              <span className="material-symbols-outlined text-[14px]">restart_alt</span>
              Reset Filters
            </button>
          )}
        </div>
      </div>

      {/* Combos Card Grid */}
      {filteredCombos.length === 0 ? (
        <Card>
          <div className="text-center py-12">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 text-primary mb-4">
              <span className="material-symbols-outlined text-[32px]">layers</span>
            </div>
            <p className="text-text-main font-medium mb-1">
              {hasActiveFilters ? "No combos match your filters" : "No combos yet"}
            </p>
            <p className="text-sm text-text-muted mb-4">
              {hasActiveFilters ? "Try loosening your search or filter parameters" : "Create model combos with fallback support"}
            </p>
            {hasActiveFilters ? (
              <Button onClick={resetFilters} variant="outline" size="sm">
                Clear Filters
              </Button>
            ) : (
              <Button icon="add" onClick={() => setShowCreateModal(true)} className="w-full sm:w-auto">
                Create Combo
              </Button>
            )}
          </div>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {/* Selection toolbar */}
          <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-black/5 bg-black/[0.015] px-3 py-2 dark:border-white/5 dark:bg-white/[0.02] sm:flex-row sm:items-center sm:justify-between">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-text-muted hover:text-primary select-none">
              <input
                type="checkbox"
                checked={allSelected}
                ref={(el) => {
                  if (el) el.indeterminate = someSelected && !allSelected;
                }}
                onChange={toggleSelectAll}
                className="h-3.5 w-3.5 rounded border-border text-primary focus:ring-primary"
              />
              <span>
                {someSelected
                  ? `${selectedIds.length} selected`
                  : `Select all (${filteredCombos.length})`}
              </span>
            </label>

            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {someSelected && (
                <>
                  <div className="w-full min-w-[160px] sm:w-[200px]">
                    <Select
                      options={STRATEGY_OPTIONS}
                      value=""
                      placeholder="Set strategy…"
                      disabled={bulkBusy}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v) handleBulkSetStrategy(v);
                      }}
                      selectClassName="py-1.5 text-xs"
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="danger"
                    icon="delete"
                    disabled={bulkBusy}
                    loading={bulkBusy}
                    onClick={handleBulkDelete}
                    className="whitespace-nowrap"
                  >
                    Delete ({selectedIds.length})
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={clearSelection}
                    disabled={bulkBusy}
                  >
                    Clear
                  </Button>
                </>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {(() => {
              const comboByName = Object.fromEntries(combos.map((c) => [c.name, c.models]));
              return filteredCombos.map((combo) => (
                <ComboCard
                  key={combo.id}
                  combo={combo}
                  getCaps={getCaps}
                  comboByName={comboByName}
                  activeProviders={activeProviders}
                  copied={copied}
                  onCopy={copy}
                  onEdit={() => setEditingCombo(combo)}
                  onDelete={() => handleDelete(combo.id)}
                  strategy={comboStrategies[combo.name] || {}}
                  onSetStrategy={(patch) => handleSetComboStrategy(combo.name, patch)}
                  selected={selectedIds.includes(combo.id)}
                  onToggleSelect={() => toggleSelect(combo.id)}
                />
              ));
            })()}
          </div>
        </div>
      )}

      {/* Capacity Adapter */}
      <CapacityAdapterSection
        capacityAdapter={capacityAdapter}
        onChange={handleSetCapacityAdapter}
        activeProviders={activeProviders}
        getCaps={getCaps}
      />

      {/* Create Modal - Use key to force remount and reset state */}
      {showCreateModal && (
        <ComboFormModal
          key="create"
          isOpen={showCreateModal}
          onClose={() => setShowCreateModal(false)}
          onSave={handleCreate}
          activeProviders={activeProviders}
        />
      )}

      {editingCombo && (
        <ComboFormModal
          key={editingCombo.id}
          isOpen={!!editingCombo}
          combo={editingCombo}
          onClose={() => setEditingCombo(null)}
          onSave={(data) => handleUpdate(editingCombo.id, data)}
          activeProviders={activeProviders}
        />
      )}

      {/* Confirm (delete / generate presets) */}
      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => !confirmState?.loading && setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        confirmText={confirmState?.confirmText || "Confirm"}
        variant={confirmState?.variant || "danger"}
        loading={!!confirmState?.loading}
      />
    </div>
  );
}

const fmtK = (n) => {
  if (!n) return "?";
  if (n >= 1000000) {
    const m = n / 1000000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  return `${Math.round(n / 1000)}k`;
};

function StrategyBadge({ strategy }) {
  if (strategy === "round-robin") {
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-info/10 text-info dark:text-info border border-info/25">
        <span className="material-symbols-outlined text-[12px]">sync</span>
        Round Robin
      </span>
    );
  }
  if (strategy === "fusion") {
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-info/10 text-info dark:text-info border border-info/25">
        <span className="material-symbols-outlined text-[12px]">gavel</span>
        Fusion
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-success/10 text-success dark:text-success border border-success/25">
      <span className="material-symbols-outlined text-[12px]">alt_route</span>
      Fallback
    </span>
  );
}

function ComboCard({ combo, getCaps, comboByName = {}, activeProviders = [], copied, onCopy, onEdit, onDelete, strategy = {}, onSetStrategy, selected = false, onToggleSelect }) {
  const [showJudgeSelect, setShowJudgeSelect] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const current = strategy.fallbackStrategy || "fallback";
  const judge = strategy.judgeModel || "";
  const isFusion = current === "fusion";
  // The synced catalog is server-only, so resolving here would fall back to the
  // generic patterns and under-report the limits. getCaps carries the server's
  // answer for /api/models.
  const comboCaps = aggregateComboCapabilities(combo.models, comboByName, getCaps);
  const models = combo.models || [];
  const visibleModels = expanded ? models : models.slice(0, 4);

  return (
    <div className={`flex flex-col justify-between rounded-2xl border bg-card p-4 shadow-sm hover:border-primary/40 hover:shadow-md transition-all duration-200 group ${selected ? "border-primary/40 ring-1 ring-primary/40 bg-primary/[0.03]" : "border-border"}`}>
      <div>
        {/* Card Header */}
        <div className="flex items-start justify-between gap-2.5 pb-3 border-b border-border/60">
          <div className="flex items-center gap-2.5 min-w-0">
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggleSelect}
              onClick={(event) => event.stopPropagation()}
              aria-label={`Select ${combo.name}`}
              className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
            />
            <div className="size-9 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0 shadow-sm">
              <span className="material-symbols-outlined text-[20px]">layers</span>
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <code className="truncate font-mono text-sm font-bold text-text-main" title={combo.name}>
                  {combo.name}
                </code>
                <button
                  onClick={(event) => { event.stopPropagation(); onCopy(combo.name, `combo-${combo.id}`); }}
                  className="p-1 rounded-md text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5 transition-colors shrink-0 cursor-pointer"
                  title="Copy combo name"
                  aria-label={`Copy ${combo.name}`}
                >
                  <span className="material-symbols-outlined text-[15px]">
                    {copied === `combo-${combo.id}` ? "check" : "content_copy"}
                  </span>
                </button>
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-[11px] text-text-muted font-medium">
                  {models.length} {models.length === 1 ? "model" : "models"}
                </span>
                {comboCaps && (
                  <span className="text-[10px] text-text-muted">
                    ctx {fmtK(comboCaps.contextWindow)} · max {fmtK(comboCaps.maxOutput)}
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="shrink-0">
            <StrategyBadge strategy={current} />
          </div>
        </div>

        {/* Models list */}
        <div className="py-3 flex flex-col gap-2">
          {models.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-6 text-center text-text-muted/90 bg-surface-2/40 rounded-xl border border-dashed border-border/60">
              <span className="material-symbols-outlined text-[22px] mb-1">playlist_remove</span>
              <span className="text-xs italic">No models configured</span>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {visibleModels.map((model, index) => {
                const parts = model.split("/");
                const hasPrefix = parts.length > 1;
                const prefix = hasPrefix ? parts[0] : null;
                const modelName = hasPrefix ? parts.slice(1).join("/") : model;

                return (
                  <div
                    key={`${model}-${index}`}
                    className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-surface-2/60 border border-border/40 text-xs font-mono group/item hover:bg-surface-2 transition-colors"
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="size-4 rounded bg-surface-3 flex items-center justify-center text-[10px] text-text-muted font-bold shrink-0 font-sans">
                        {index + 1}
                      </span>
                      {prefix && (
                        <span className="text-[9px] px-1.5 py-0.2 rounded bg-black/5 dark:bg-white/10 text-text-muted uppercase font-sans font-bold shrink-0">
                          {prefix}
                        </span>
                      )}
                      <span className="truncate text-text-main font-medium" title={model}>
                        {modelName}
                      </span>
                    </div>
                    <div className="shrink-0 flex items-center gap-1">
                      <CapacityBadges
                        caps={
                          comboByName[model]
                            ? aggregateComboCapabilities(comboByName[model], comboByName, getCaps)
                            : getCaps?.(model)
                        }
                        size={14}
                      />
                    </div>
                  </div>
                );
              })}

              {models.length > 4 && (
                <button
                  type="button"
                  onClick={() => setExpanded(!expanded)}
                  className="w-full text-center py-1 text-[11px] font-semibold text-primary hover:underline transition-all cursor-pointer"
                >
                  {expanded ? "▲ Collapse models" : `▼ +${models.length - 4} more models`}
                </button>
              )}
            </div>
          )}

          {/* Fusion Judge Configuration */}
          {isFusion && (
            <div className="mt-1 p-2.5 rounded-xl bg-info/5 border border-info/20 text-xs space-y-1.5">
              <div className="flex items-center justify-between gap-1">
                <div className="flex items-center gap-1.5 text-info dark:text-info font-semibold text-[11px]">
                  <span className="material-symbols-outlined text-[14px]">gavel</span>
                  <span>Fusion Judge</span>
                </div>
                {judge && (
                  <button
                    onClick={() => onSetStrategy({ judgeModel: "" })}
                    className="text-[10px] font-medium text-text-muted hover:text-danger dark:hover:text-danger transition-colors cursor-pointer"
                    title="Reset judge to auto-first model"
                  >
                    Reset Auto
                  </button>
                )}
              </div>
              <button
                onClick={() => setShowJudgeSelect(true)}
                className="w-full text-left px-2.5 py-1.5 rounded-lg bg-surface-1 border border-dashed border-info/30 text-info dark:text-info font-mono text-[11px] truncate hover:border-info/20 hover:bg-info/5 transition-colors block cursor-pointer"
                title="Select judge model"
              >
                {judge || `Auto — ${models[0] || "first model"}`}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Card Footer: Strategy select & action buttons */}
      <div className="pt-3 border-t border-border/60 flex items-center justify-between gap-2 mt-auto">
        <div className="flex-1 min-w-0 max-w-[190px]">
          <Select
            options={STRATEGY_OPTIONS}
            value={current}
            onChange={(e) => onSetStrategy({ fallbackStrategy: e.target.value })}
            selectClassName="py-1 px-2 text-xs h-8"
            aria-label={`Strategy for ${combo.name}`}
          />
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={onEdit}
            className="h-8 px-2 text-xs"
            title="Edit combo models"
            aria-label={`Edit ${combo.name}`}
          >
            <span className="material-symbols-outlined text-[16px]">edit</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDelete}
            className="h-8 px-2 text-xs text-danger dark:text-danger hover:text-danger dark:hover:text-danger hover:bg-danger/10"
            title="Delete combo"
            aria-label={`Delete ${combo.name}`}
          >
            <span className="material-symbols-outlined text-[16px]">delete</span>
          </Button>
        </div>
      </div>

      {/* Judge model picker */}
      {showJudgeSelect && (
        <ModelSelectModal
          isOpen={showJudgeSelect}
          onClose={() => setShowJudgeSelect(false)}
          onSelect={(m) => { onSetStrategy({ judgeModel: m?.value || "" }); setShowJudgeSelect(false); }}
          activeProviders={activeProviders}
          title="Select Judge Model"
          addedModelValues={judge ? [judge] : []}
          closeOnSelect={true}
        />
      )}
    </div>
  );
}

function CapacityAdapterSection({ capacityAdapter, onChange, activeProviders, getCaps }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium">Vision Adapter</p>
          <p className="text-xs text-text-muted mt-0.5">
            Your model can&apos;t read image/audio? Auto-switches to a model in the pool below.
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-4">
        {CAPACITY_ADAPTER_CAPS.map((cap) => (
          <CapacityAdapterCap
            key={cap.key}
            cap={cap}
            entry={capacityAdapter[cap.key] || EMPTY_CAP_ENTRY}
            onChange={(entry) => onChange({ ...capacityAdapter, [cap.key]: entry })}
            activeProviders={activeProviders}
            getCaps={getCaps}
          />
        ))}
      </div>
    </div>
  );
}

function CapacityAdapterCap({ cap, entry, onChange, activeProviders, getCaps }) {
  const [showModelSelect, setShowModelSelect] = useState(false);
  const { enabled, roundRobin, models } = entry;

  const patch = (p) => onChange({ ...entry, ...p });

  const handleAdd = (model) => {
    const value = model?.value || model?.name || model;
    if (!value || models.includes(value)) return;
    patch({ models: [...models, value] });
  };

  const handleDeselect = (model) => {
    const value = model?.value || model?.name || model;
    const next = models.filter((m) => m !== value);
    patch({ models: next.length === 0 ? [DEFAULT_FALLBACK_MODEL] : next });
  };

  const handleRemove = (index) => {
    const next = models.filter((_, i) => i !== index);
    patch({ models: next.length === 0 ? [DEFAULT_FALLBACK_MODEL] : next });
  };

  const handleMove = (index, delta) => {
    const target = index + delta;
    if (target < 0 || target >= models.length) return;
    const next = [...models];
    [next[index], next[target]] = [next[target], next[index]];
    patch({ models: next });
  };

  return (
    <Card padding="sm" className={`group ${!enabled ? "opacity-50" : ""}`}>
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/* Master toggle + icon + label */}
        <div className="flex min-w-0 flex-1 items-start gap-2.5 sm:items-center">
          <Toggle
            checked={enabled}
            onChange={(v) => patch({ enabled: v })}
            aria-label={`Enable ${cap.label} adapter`}
          />
          <div className="size-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-primary text-[18px]">{cap.icon}</span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <code className="font-mono text-sm font-medium">{cap.label}</code>
              <span className="text-[10px] text-text-muted">— {cap.desc}</span>
            </div>
          </div>
        </div>

        {/* Actions: Round-robin toggle + Add Model */}
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:gap-3 sm:shrink-0">
          <label className="flex items-center gap-1.5 text-xs text-text-muted cursor-pointer select-none">
            <Toggle
              checked={roundRobin}
              onChange={(v) => patch({ roundRobin: v })}
              disabled={!enabled}
              aria-label={`Round-robin ${cap.label} adapter`}
            />
            <span>Round</span>
          </label>
          <Button
            icon="add"
            variant="ghost"
            size="sm"
            onClick={() => setShowModelSelect(true)}
            disabled={!enabled}
            title={`Add ${cap.label} model`}
          >
            Add Model
          </Button>
        </div>
      </div>

      {/* Model pool list/table */}
      {models.length === 0 ? (
        <div className="mt-3 py-2 text-center text-xs text-text-muted italic">
          No models in pool (will fallback to {DEFAULT_FALLBACK_MODEL})
        </div>
      ) : (
        <div className="mt-3 overflow-hidden rounded-lg border border-border/50">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-border/40 bg-black/[0.02] text-text-muted dark:bg-white/[0.02]">
                <th className="w-12 px-3 py-1.5 font-medium text-center">#</th>
                <th className="px-3 py-1.5 font-medium">Model</th>
                <th className="w-24 px-3 py-1.5 font-medium text-center">Order</th>
                <th className="w-12 px-3 py-1.5 font-medium text-right"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/30 font-mono">
              {models.map((model, index) => (
                <tr key={`${model}-${index}`} className="hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors">
                  <td className="px-3 py-2 text-center text-text-muted text-[11px] font-sans">
                    #{index + 1}
                  </td>
                  <td className="px-3 py-2 text-text-main">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="truncate">{model}</span>
                      <CapacityBadges caps={getCaps?.(model)} />
                      {model === DEFAULT_FALLBACK_MODEL && (
                        <span className="rounded bg-success/10 px-1.5 py-0.5 font-sans text-[10px] font-medium text-success dark:text-success">
                          free default
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-center">
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => handleMove(index, -1)}
                        disabled={!enabled || index === 0}
                        className={`p-1 rounded transition-colors ${
                          !enabled || index === 0
                            ? "text-text-muted/20 cursor-not-allowed"
                            : "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5"
                        }`}
                        title="Move up"
                      >
                        <span className="material-symbols-outlined text-[16px] leading-none">arrow_upward</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleMove(index, 1)}
                        disabled={!enabled || index === models.length - 1}
                        className={`p-1 rounded transition-colors ${
                          !enabled || index === models.length - 1
                            ? "text-text-muted/20 cursor-not-allowed"
                            : "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5"
                        }`}
                        title="Move down"
                      >
                        <span className="material-symbols-outlined text-[16px] leading-none">arrow_downward</span>
                      </button>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => handleRemove(index)}
                      disabled={!enabled}
                      className={`p-1 rounded transition-colors ${
                        !enabled
                          ? "text-text-muted/20 cursor-not-allowed"
                          : "text-text-muted hover:text-danger dark:hover:text-danger hover:bg-danger/10"
                      }`}
                      title="Remove model"
                    >
                      <span className="material-symbols-outlined text-[16px] leading-none">close</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModelSelect && (
        <ModelSelectModal
          isOpen={showModelSelect}
          onClose={() => setShowModelSelect(false)}
          onSelect={handleAdd}
          onDeselect={handleDeselect}
          activeProviders={activeProviders}
          title={`Add ${cap.label} Model`}
          addedModelValues={models}
          capFilter={cap.key}
          closeOnSelect={false}
        />
      )}
    </Card>
  );
}

function ModelItem({ id, index, model, isFirst, isLast, onEdit, onMoveUp, onMoveDown, onRemove }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    // no transition — prevents the CSS settle animation fighting React's re-render on drop
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 999 : undefined,
  };
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(model);
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== model) onEdit(trimmed);
    else setDraft(model);
    setEditing(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") { setDraft(model); setEditing(false); }
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 bg-black/[0.02] hover:bg-black/[0.04] dark:bg-white/[0.02] dark:hover:bg-white/[0.04] transition-colors ${isDragging ? "shadow-md ring-1 ring-primary/30" : ""}`}
    >
      {/* Drag handle */}
      <button
        {...attributes}
        {...listeners}
        type="button"
        className="cursor-grab touch-none p-0.5 rounded text-text-muted hover:text-primary active:cursor-grabbing shrink-0"
        title="Drag to reorder"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="9" cy="4" r="2"/><circle cx="15" cy="4" r="2"/>
          <circle cx="9" cy="12" r="2"/><circle cx="15" cy="12" r="2"/>
          <circle cx="9" cy="20" r="2"/><circle cx="15" cy="20" r="2"/>
        </svg>
      </button>

      {/* Index badge */}
      <span className="text-[10px] font-medium text-text-muted w-3 text-center shrink-0">{index + 1}</span>

      {/* Inline editable model value */}
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKeyDown}
          className="min-w-0 flex-1 rounded border border-primary/40 bg-white px-1.5 py-0.5 font-mono text-xs text-text-main outline-none dark:bg-black/20"
        />
      ) : (
        <div
          className="min-w-0 flex-1 cursor-text truncate rounded px-1.5 py-0.5 font-mono text-xs text-text-main hover:bg-black/5 dark:hover:bg-white/5"
          onClick={() => setEditing(true)}
          title="Click to edit"
        >
          {model}
        </div>
      )}

      {/* Priority arrows */}
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          onClick={onMoveUp}
          disabled={isFirst}
          className={`p-0.5 rounded ${isFirst ? "text-text-muted/20 cursor-not-allowed" : "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5"}`}
          title="Move up"
        >
          <span className="material-symbols-outlined text-[12px]">arrow_upward</span>
        </button>
        <button
          onClick={onMoveDown}
          disabled={isLast}
          className={`p-0.5 rounded ${isLast ? "text-text-muted/20 cursor-not-allowed" : "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5"}`}
          title="Move down"
        >
          <span className="material-symbols-outlined text-[12px]">arrow_downward</span>
        </button>
      </div>

      {/* Remove */}
      <button
        onClick={onRemove}
        className="p-0.5 hover:bg-danger/10 rounded text-text-muted hover:text-danger dark:hover:text-danger transition-all"
        title="Remove"
      >
        <span className="material-symbols-outlined text-[12px]">close</span>
      </button>
    </div>
  );
}

function ComboFormModal({ isOpen, combo, onClose, onSave, activeProviders, kindFilter = null }) {
  // Initialize state with combo values - key prop on parent handles reset on remount
  const [name, setName] = useState(combo?.name || "");
  const [models, setModels] = useState(combo?.models || []);
  const [showModelSelect, setShowModelSelect] = useState(false);
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState("");
  const [modelAliases, setModelAliases] = useState({});

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // Use stable index-based IDs so duplicates and similar names are handled correctly
  const modelItems = models.map((model, i) => ({ uid: `item-${i}`, model }));

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = modelItems.findIndex((m) => m.uid === active.id);
      const newIndex = modelItems.findIndex((m) => m.uid === over.id);
      if (oldIndex !== -1 && newIndex !== -1) {
        setModels((prev) => arrayMove(prev, oldIndex, newIndex));
      }
    }
  };

  const fetchModalData = async () => {
    try {
      const aliasesRes = await fetch("/api/models/alias");
      if (!aliasesRes.ok) return;
      const aliasesData = await aliasesRes.json();
      setModelAliases(aliasesData.aliases || {});
    } catch (error) {
      console.error("Error fetching modal data:", error);
    }
  };

  useEffect(() => {
    if (isOpen) fetchModalData();
  }, [isOpen]);

  const validateName = (value) => {
    if (!value.trim()) {
      setNameError("Name is required");
      return false;
    }
    if (!VALID_NAME_REGEX.test(value)) {
      setNameError("Only letters, numbers, -, _ and . allowed");
      return false;
    }
    setNameError("");
    return true;
  };

  const handleNameChange = (e) => {
    const value = e.target.value;
    setName(value);
    if (value) validateName(value);
    else setNameError("");
  };

  const handleAddModel = (model) => {
    if (!models.includes(model.value)) {
      setModels([...models, model.value]);
    }
  };

  const handleDeselectModel = (model) => {
    setModels(models.filter((m) => m !== model.value));
  };

  const handleRemoveModel = (index) => {
    setModels(models.filter((_, i) => i !== index));
  };

  const handleMoveUp = (index) => {
    if (index === 0) return;
    const newModels = [...models];
    [newModels[index - 1], newModels[index]] = [newModels[index], newModels[index - 1]];
    setModels(newModels);
  };

  const handleMoveDown = (index) => {
    if (index === models.length - 1) return;
    const newModels = [...models];
    [newModels[index], newModels[index + 1]] = [newModels[index + 1], newModels[index]];
    setModels(newModels);
  };

  const handleSave = async () => {
    if (!validateName(name)) return;
    setSaving(true);
    await onSave({ name: name.trim(), models });
    setSaving(false);
  };

  const isEdit = !!combo;

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title={isEdit ? "Edit Combo" : "Create Combo"}
      >
        <div className="flex flex-col gap-3">
          {/* Name */}
          <div>
            <Input
              label="Combo Name"
              value={name}
              onChange={handleNameChange}
              placeholder="my-combo"
              error={nameError}
            />
            <p className="text-[10px] text-text-muted mt-0.5">
              Only letters, numbers, -, _ and . allowed
            </p>
          </div>

          {/* Models */}
          <div>
            <label className="text-sm font-medium mb-1.5 block">Models</label>

            {models.length === 0 ? (
              <div className="text-center py-4 border border-dashed border-black/10 dark:border-white/10 rounded-lg bg-black/[0.01] dark:bg-white/[0.01]">
                <span className="material-symbols-outlined text-text-muted text-xl mb-1">layers</span>
                <p className="text-xs text-text-muted">No models added yet</p>
              </div>
            ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd} modifiers={[restrictToVerticalAxis, restrictToParentElement]}>
              <SortableContext items={modelItems.map((m) => m.uid)} strategy={verticalListSortingStrategy}>
                <div className="flex max-h-[55vh] min-w-0 flex-col gap-1 overflow-y-auto sm:max-h-[350px]">
                  {modelItems.map(({ uid, model }, index) => (
                    <ModelItem
                      key={uid}
                      id={uid}
                      index={index}
                      model={model}
                      isFirst={index === 0}
                      isLast={index === modelItems.length - 1}
                      onEdit={(newVal) => {
                        const updated = [...models];
                        updated[index] = newVal;
                        setModels(updated);
                      }}
                      onMoveUp={() => handleMoveUp(index)}
                      onMoveDown={() => handleMoveDown(index)}
                      onRemove={() => handleRemoveModel(index)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
            )}

            {/* Add Model button */}
            <button
              onClick={() => setShowModelSelect(true)}
              className="w-full mt-2 py-2 border border-dashed border-black/10 dark:border-white/10 rounded-lg text-xs text-primary font-medium hover:text-primary hover:border-primary/50 transition-colors flex items-center justify-center gap-1"
            >
              <span className="material-symbols-outlined text-[16px]">add</span>
              Add Model
            </button>
          </div>

          {/* Actions */}
          <div className="flex flex-col gap-2 pt-1 sm:flex-row">
            <Button onClick={onClose} variant="ghost" fullWidth size="sm">
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              fullWidth
              size="sm"
              disabled={!name.trim() || !!nameError || saving}
            >
              {saving ? "Saving..." : isEdit ? "Save" : "Create"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Model Select Modal */}
      {showModelSelect && (
        <ModelSelectModal
          isOpen={showModelSelect}
          onClose={() => setShowModelSelect(false)}
          onSelect={handleAddModel}
          onDeselect={handleDeselectModel}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          title="Add Model to Combo"
          kindFilter={kindFilter}
          addedModelValues={models}
          closeOnSelect={false}
        />
      )}
    </>
  );
}
