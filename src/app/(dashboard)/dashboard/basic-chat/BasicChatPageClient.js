"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button } from "@/shared/components";
import { getModelsByProviderId } from "@/shared/constants/models";
import { getProviderAlias, isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";
import { restoreSessionModel } from "./basicChatModels";
import useFooterStore, { FOOTER_FIELDS } from "@/store/footerStore";

const STORAGE_KEYS = {
  sessions: "basic-chat.sessions",
  activeSessionId: "basic-chat.activeSessionId",
  activeProviderId: "basic-chat.activeProviderId",
  draft: "basic-chat.draft",
  apiKey: "basic-chat.apiKey",
};

function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `chat_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function safeParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function textValue(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join(" ");
  if (typeof value === "object") {
    if (typeof value.message === "string") return value.message;
    if (typeof value.error === "string") return value.error;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function humanize(value = "") {
  return String(value)
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim() || "Unknown";
}

function formatRelativeTime(value) {
  if (!value) return "Now";
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return "Now";
  const diffMinutes = Math.max(1, Math.round((Date.now() - time) / 60000));
  if (diffMinutes < 60) return `${diffMinutes}m`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h`;
  return `${Math.round(diffHours / 24)}d`;
}

function makeSessionTitle(text = "") {
  const normalized = textValue(text).replace(/\s+/g, " ").trim();
  if (!normalized) return "New chat";
  return normalized.length > 52 ? `${normalized.slice(0, 52).trimEnd()}…` : normalized;
}

function buildUserContent(message) {
  const text = textValue(message.content).trim();
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];

  if (attachments.length === 0) return text;

  const content = [];
  if (text) content.push({ type: "text", text });

  for (const attachment of attachments) {
    if (attachment?.dataUrl) {
      content.push({ type: "image_url", image_url: { url: attachment.dataUrl } });
    }
  }

  return content.length > 0 ? content : text;
}

function readAssistantText(chunk) {
  if (!chunk || typeof chunk !== "object") return "";
  const choice = chunk.choices?.[0];
  const delta = choice?.delta || {};
  const pieces = [delta.content, choice?.message?.content, chunk.output_text, chunk.text]
    .map(textValue)
    .filter(Boolean);
  return pieces[0] || "";
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  const totalTokens = Number(usage.total_tokens ?? (promptTokens + completionTokens)) || 0;
  return promptTokens || completionTokens || totalTokens ? { promptTokens, completionTokens, totalTokens } : null;
}

function formatDuration(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

async function fileToDataUrl(file) {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

function cloneSession(session) {
  return {
    ...session,
    messages: Array.isArray(session.messages) ? session.messages.map((message) => ({ ...message })) : [],
  };
}

function getProviderLabel(connection) {
  return connection?.name || humanize(connection?.provider || connection?.id || "provider");
}

function normalizeStaticModel(model, connection, requestPrefix) {
  if (!model?.id) return null;
  const requestModel = `${requestPrefix}/${model.id}`;
  return {
    id: requestModel,
    requestModel,
    name: model.name || model.id,
    providerId: connection.provider,
    providerName: getProviderLabel(connection),
    source: "static",
  };
}

function normalizeLiveModel(model, connection, requestPrefix) {
  const rawId = typeof model === "string" ? model : model?.id || model?.name || model?.model || "";
  if (!rawId) return null;

  const displayName = typeof model === "string"
    ? model
    : model?.name || model?.displayName || rawId;

  const requestModel = rawId.startsWith(`${requestPrefix}/`) ? rawId : `${requestPrefix}/${rawId}`;

  return {
    id: requestModel,
    requestModel,
    name: displayName,
    providerId: connection.provider,
    providerName: getProviderLabel(connection),
    source: "live",
  };
}

function parseProviderModelsPayload(data) {
  if (Array.isArray(data?.models)) return data.models;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data)) return data;
  return [];
}

function dedupeModels(models) {
  const map = new Map();
  for (const model of models) {
    if (!model?.id) continue;
    if (!map.has(model.id)) map.set(model.id, model);
  }
  return Array.from(map.values());
}

export default function BasicChatPageClient() {
  const [providerGroups, setProviderGroups] = useState([]);
  const [loadingData, setLoadingData] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [sessions, setSessions] = useState(() => {
    if (typeof window === "undefined") return [];
    try {
      const saved = safeParse(globalThis.localStorage.getItem(STORAGE_KEYS.sessions), []);
      return Array.isArray(saved) ? saved.map((session) => ({
        ...session,
        messages: Array.isArray(session.messages) ? session.messages : [],
      })) : [];
    } catch { return []; }
  });
  const [activeSessionId, setActiveSessionId] = useState(() => {
    if (typeof window === "undefined") return "";
    return globalThis.localStorage.getItem(STORAGE_KEYS.activeSessionId) || "";
  });
  const [activeProviderId, setActiveProviderId] = useState(() => {
    if (typeof window === "undefined") return "";
    return globalThis.localStorage.getItem(STORAGE_KEYS.activeProviderId) || "";
  });
  const [activeModelId, setActiveModelId] = useState("");
  const [draft, setDraft] = useState(() => {
    if (typeof window === "undefined") return "";
    return globalThis.localStorage.getItem(STORAGE_KEYS.draft) || "";
  });
  const [attachments, setAttachments] = useState([]);
  const [apiKey, setApiKey] = useState(() => {
    if (typeof window === "undefined") return "";
    return globalThis.localStorage.getItem(STORAGE_KEYS.apiKey) || "";
  });
  const [apiKeyOpen, setApiKeyOpen] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const [isHydrated, setIsHydrated] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [customModel, setCustomModel] = useState("");
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [footerOpen, setFooterOpen] = useState(false);
  const footerSettings = useFooterStore();
  const fileInputRef = useRef(null);
  const abortRef = useRef(null);
  const initializedRef = useRef(false);
  const modelMenuRef = useRef(null);
  const providerMenuRef = useRef(null);
  const historyMenuRef = useRef(null);

  useEffect(() => {
    setIsHydrated(true);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      setLoadingData(true);
      setLoadError("");

      try {
        const [providersRes, nodesRes] = await Promise.all([
          fetch("/api/providers", { cache: "no-store" }),
          fetch("/api/provider-nodes", { cache: "no-store" }),
        ]);
        const providersData = await providersRes.json().catch(() => ({}));
        const nodesData = await nodesRes.json().catch(() => ({}));
        const nodePrefix = new Map(
          (Array.isArray(nodesData.nodes) ? nodesData.nodes : [])
            .filter((node) => node?.id && node?.prefix)
            .map((node) => [node.id, node.prefix])
        );
        const connections = Array.isArray(providersData.connections)
          ? providersData.connections.filter((connection) => connection?.isActive !== false)
          : [];

        if (connections.length === 0) {
          if (!cancelled) {
            setProviderGroups([]);
            setLoadError("No providers connected yet.");
          }
          return;
        }

        const providerMap = new Map();

        for (const connection of connections) {
          const providerId = connection.provider || connection.id;
          const requestPrefix = nodePrefix.get(providerId) || getProviderAlias(providerId);
          const providerName = getProviderLabel(connection);
          const providerType = isOpenAICompatibleProvider(providerId)
            ? "openai-compatible"
            : isAnthropicCompatibleProvider(providerId)
              ? "anthropic-compatible"
              : providerId;

          if (!providerMap.has(providerId)) {
            providerMap.set(providerId, {
              providerId,
              providerName,
              providerType,
              requestPrefix,
              connections: [],
              models: [],
              pendingModelLoads: 0,
            });
          }

          const group = providerMap.get(providerId);
          group.providerName = group.providerName || providerName;
          group.providerType = group.providerType || providerType;
          group.requestPrefix = group.requestPrefix || requestPrefix;
          group.connections.push(connection);
          group.pendingModelLoads += 1;

          const staticModels = getModelsByProviderId(providerId)
            .map((model) => normalizeStaticModel(model, connection, requestPrefix))
            .filter(Boolean);
          group.models.push(...staticModels);
        }

        // Providers are available from the local DB almost immediately. Render
        // them now instead of blocking the entire picker on the slowest remote
        // model catalog (some providers take 10–15s).
        const initialGroups = Array.from(providerMap.values())
          .map((group) => ({
            ...group,
            modelsLoading: group.pendingModelLoads > 0,
            models: dedupeModels(group.models).sort((a, b) => a.name.localeCompare(b.name)),
          }))
          .sort((a, b) => a.providerName.localeCompare(b.providerName));
        if (!cancelled) {
          setProviderGroups(initialGroups);
          setLoadingData(false);
        }

        await Promise.allSettled(
          connections.map(async (connection) => {
            let models = [];
            try {
              const response = await fetch(`/api/providers/${connection.id}/models`, { cache: "no-store" });
              const data = await response.json().catch(() => ({}));
              if (response.ok) {
                const requestPrefix = nodePrefix.get(connection.provider) || getProviderAlias(connection.provider);
                models = parseProviderModelsPayload(data)
                  .map((model) => normalizeLiveModel(model, connection, requestPrefix))
                  .filter(Boolean);
              }
            } finally {
              if (cancelled) return;
              const providerId = connection.provider || connection.id;
              setProviderGroups((groups) => groups.map((group) => {
                if (group.providerId !== providerId) return group;
                const pendingModelLoads = Math.max(0, (group.pendingModelLoads || 1) - 1);
                return {
                  ...group,
                  pendingModelLoads,
                  modelsLoading: pendingModelLoads > 0,
                  models: dedupeModels([...group.models, ...models]).sort((a, b) => a.name.localeCompare(b.name)),
                };
              }));
            }
          })
        );
      } catch (error) {
        if (!cancelled) {
          setLoadError(textValue(error?.message) || "Failed to load providers/models.");
          setProviderGroups([]);
        }
      } finally {
        if (!cancelled) setLoadingData(false);
      }
    }

    loadData();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(event.target)) {
        setModelMenuOpen(false);
      }
      if (providerMenuRef.current && !providerMenuRef.current.contains(event.target)) {
        setProviderMenuOpen(false);
      }
      if (historyMenuRef.current && !historyMenuRef.current.contains(event.target)) {
        setHistoryOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const modelIndex = useMemo(() => {
    const map = new Map();
    for (const group of providerGroups) {
      for (const model of group.models) {
        map.set(model.id, {
          ...model,
          providerId: group.providerId,
          providerName: group.providerName,
        });
      }
    }
    return map;
  }, [providerGroups]);

  const activeProviderGroup = useMemo(() => {
    return providerGroups.find((group) => group.providerId === activeProviderId)
      || providerGroups.find((group) => group.models.length > 0)
      || providerGroups[0]
      || null;
  }, [providerGroups, activeProviderId]);

  const activeModel = useMemo(() => {
    if (activeModelId && modelIndex.has(activeModelId)) return modelIndex.get(activeModelId);
    if (activeSessionId) {
      const session = sessions.find((item) => item.id === activeSessionId);
      const restored = restoreSessionModel(session, modelIndex);
      if (restored) return restored;
    }
    return activeProviderGroup?.models?.[0] || null;
  }, [activeModelId, modelIndex, activeProviderGroup, sessions, activeSessionId]);

  const currentSession = useMemo(() => sessions.find((session) => session.id === activeSessionId) || null, [sessions, activeSessionId]);
  const currentMessages = currentSession?.messages || [];
  const sessionItems = useMemo(() => [...sessions].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()), [sessions]);
  const canSend = !isSending && !!activeModel && (draft.trim().length > 0 || attachments.length > 0);

  useEffect(() => {
    if (!isHydrated) return;
    try {
      globalThis.localStorage.setItem(STORAGE_KEYS.sessions, JSON.stringify(sessions));
      globalThis.localStorage.setItem(STORAGE_KEYS.activeSessionId, activeSessionId);
      globalThis.localStorage.setItem(STORAGE_KEYS.activeProviderId, activeProviderId);
      globalThis.localStorage.setItem(STORAGE_KEYS.draft, draft);
      globalThis.localStorage.setItem(STORAGE_KEYS.apiKey, apiKey);
    } catch {
      // Ignore storage errors.
    }
  }, [isHydrated, sessions, activeSessionId, activeProviderId, draft, apiKey]);

  useEffect(() => {
    if (!isHydrated || loadingData || initializedRef.current) return;
    if (providerGroups.length === 0) return;

    const savedProvider = providerGroups.find((group) => group.providerId === activeProviderId && group.models.length > 0)
      || providerGroups.find((group) => group.models.length > 0);
    if (!savedProvider) return;
    const savedModel = activeModelId && modelIndex.has(activeModelId)
      ? modelIndex.get(activeModelId)
      : savedProvider.models[0];

    if (sessions.length > 0) {
      const session = sessions.find((item) => item.id === activeSessionId) || sessions[0];
      const sessionModel = restoreSessionModel(session, modelIndex, savedModel);
      initializedRef.current = true;
      setActiveSessionId(session.id);
      setActiveProviderId(sessionModel?.providerId || savedProvider.providerId);
      setActiveModelId(sessionModel?.id || savedModel.id);
      return;
    }

    const session = {
      id: createId(),
      title: "New chat",
      providerId: savedProvider.providerId,
      providerName: savedProvider.providerName,
      modelId: savedModel.id,
      modelName: savedModel.name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    };

    initializedRef.current = true;
    setSessions([session]);
    setActiveSessionId(session.id);
    setActiveProviderId(savedProvider.providerId);
    setActiveModelId(savedModel.id);
  }, [isHydrated, loadingData, providerGroups, modelIndex, sessions, activeSessionId, activeProviderId, activeModelId]);

  const updateSession = (sessionId, updater) => {
    setSessions((prev) => prev.map((session) => (session.id === sessionId ? updater(cloneSession(session)) : session)));
  };

  const ensureSessionForModel = (model) => {
    if (!model) return null;
    return {
      id: createId(),
      title: "New chat",
      providerId: model.providerId,
      providerName: model.providerName,
      modelId: model.id,
      modelName: model.name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    };
  };

  const handleNewChat = () => {
    if (!activeModel) return;
    const session = ensureSessionForModel(activeModel);
    if (!session) return;
    setSessions((prev) => [session, ...prev]);
    setActiveSessionId(session.id);
    setActiveProviderId(session.providerId);
    setActiveModelId(session.modelId);
    setDraft("");
    setAttachments([]);
    setStreamingMessageId("");
    setStreamingText("");
  };

  const handleSelectSession = (sessionId) => {
    const session = sessions.find((item) => item.id === sessionId);
    if (!session) return;
    setActiveSessionId(sessionId);
    setActiveProviderId(session.providerId || activeProviderId);
    setActiveModelId(session.modelId || activeModelId);
    setHistoryOpen(false);
  };

  const handleDeleteCurrentChat = () => {
    if (!activeSessionId) return;
    const nextSessions = sessions.filter((session) => session.id !== activeSessionId);
    const fallback = nextSessions[0] || null;
    setSessions(nextSessions);
    if (fallback) {
      setActiveSessionId(fallback.id);
      setActiveProviderId(fallback.providerId);
      setActiveModelId(fallback.modelId);
    } else {
      setActiveSessionId("");
      setActiveProviderId("");
      setActiveModelId("");
    }
  };

  const handleSelectProvider = (providerId) => {
    const group = providerGroups.find((item) => item.providerId === providerId);
    if (!group) return;
    setActiveProviderId(group.providerId);
    if (group.models.length === 0) {
      setActiveModelId("");
      setSessions((prev) => prev.map((item) => item.id === activeSessionId && item.messages.length === 0 ? {
        ...item,
        providerId: group.providerId,
        providerName: group.providerName,
        modelId: "",
        modelName: "",
      } : item));
      setModelMenuOpen(false);
      return;
    }
    const nextModel = group.models[0];

    const current = sessions.find((session) => session.id === activeSessionId);
    if (current && current.messages.length > 0) {
      const session = ensureSessionForModel(nextModel);
      if (!session) return;
      setSessions((prev) => [session, ...prev]);
      setActiveSessionId(session.id);
    } else if (current) {
      setSessions((prev) => prev.map((item) => (item.id === current.id ? {
        ...item,
        providerId: group.providerId,
        providerName: group.providerName,
        modelId: nextModel.id,
        modelName: nextModel.name,
      } : item)));
      setActiveSessionId(current.id);
    }

    setActiveModelId(nextModel.id);
    setModelMenuOpen(false);
  };

  const handleSelectModel = (modelId) => {
    const model = modelIndex.get(modelId);
    if (!model) return;

    const current = sessions.find((session) => session.id === activeSessionId);
    if (current && current.messages.length > 0) {
      const session = ensureSessionForModel(model);
      if (!session) return;
      setSessions((prev) => [session, ...prev]);
      setActiveSessionId(session.id);
    } else if (current) {
      setSessions((prev) => prev.map((item) => (item.id === current.id ? {
        ...item,
        providerId: model.providerId,
        providerName: model.providerName,
        modelId: model.id,
        modelName: model.name,
      } : item)));
      setActiveSessionId(current.id);
    } else {
      const session = ensureSessionForModel(model);
      if (!session) return;
      setSessions((prev) => [session, ...prev]);
      setActiveSessionId(session.id);
    }

    setActiveProviderId(model.providerId);
    setActiveModelId(model.id);
    setModelMenuOpen(false);
  };

  const handleAddCustomModel = () => {
    const raw = customModel.trim().replace(/^\/+|\/+$/g, "");
    if (!raw || !activeProviderGroup) return;
    const prefix = activeProviderGroup.requestPrefix;
    const requestModel = raw.startsWith(`${prefix}/`) ? raw : `${prefix}/${raw}`;
    const model = {
      id: requestModel,
      requestModel,
      name: raw,
      providerId: activeProviderGroup.providerId,
      providerName: activeProviderGroup.providerName,
      source: "custom",
    };
    setProviderGroups((groups) => groups.map((group) => group.providerId === activeProviderGroup.providerId
      ? { ...group, models: dedupeModels([...group.models, model]) }
      : group));
    setCustomModel("");
    setModelMenuOpen(false);

    const current = sessions.find((session) => session.id === activeSessionId);
    if (current && current.messages.length > 0) {
      const session = ensureSessionForModel(model);
      setSessions((prev) => [session, ...prev]);
      setActiveSessionId(session.id);
    } else if (current) {
      setSessions((prev) => prev.map((item) => item.id === current.id ? {
        ...item, providerId: model.providerId, providerName: model.providerName,
        modelId: model.id, modelName: model.name,
      } : item));
    } else {
      const session = ensureSessionForModel(model);
      setSessions((prev) => [session, ...prev]);
      setActiveSessionId(session.id);
    }
    setActiveProviderId(model.providerId);
    setActiveModelId(model.id);
  };

  const handleAttachFiles = async (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;

    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) {
      event.target.value = "";
      return;
    }

    const converted = await Promise.all(images.map(async (file) => ({
      id: createId(),
      name: file.name,
      type: file.type,
      size: file.size,
      dataUrl: await fileToDataUrl(file),
    })));

    setAttachments((prev) => [...prev, ...converted]);
    event.target.value = "";
  };

  const removeAttachment = (attachmentId) => {
    setAttachments((prev) => prev.filter((attachment) => attachment.id !== attachmentId));
  };

  const handleStop = () => {
    abortRef.current?.abort();
  };

  const finalizeSessionTitle = (sessionId, titleSeed) => {
    const title = makeSessionTitle(titleSeed);
    updateSession(sessionId, (session) => ({
      ...session,
      title: session.title === "New chat" ? title : session.title,
      updatedAt: new Date().toISOString(),
    }));
  };

  // Shared streaming core. Runs a completion for `requestMessages`, writing the
  // stream into the assistant message `assistantMessageId` in `sessionId`.
  const runStream = async (sessionId, model, requestMessages, assistantMessageId, titleSeed) => {
    const startedAt = Date.now();
    setIsSending(true);
    setStreamingMessageId(assistantMessageId);
    setStreamingText("");
    abortRef.current?.abort();
    abortRef.current = new AbortController();

    const headers = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };
    // When the user supplies a key, hit the provider directly via that key
    // (bypasses server-side key injection). Otherwise the dashboard proxy
    // injects an active issued key.
    const trimmedKey = (apiKey || "").trim();
    if (trimmedKey) headers.Authorization = `Bearer ${trimmedKey}`;

    try {
      const response = await fetch("/api/dashboard/chat/completions", {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: model.requestModel || model.id,
          messages: requestMessages,
          stream: true,
        }),
        signal: abortRef.current.signal,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(textValue(errorData.error?.message || errorData.error || errorData.message || `Request failed (${response.status})`));
      }

      const responseMeta = {
        provider: response.headers.get("x-9router-provider") || model.providerName || "",
        providerName: response.headers.get("x-9router-provider-name") || model.providerName || "",
        model: response.headers.get("x-9router-model") || model.requestModel || model.id,
        apiKeyQueueMs: Number(response.headers.get("x-9router-queue-apikey-ms") || 0),
        providerQueueMs: Number(response.headers.get("x-9router-queue-provider-ms") || 0),
      };

      const reader = response.body?.getReader();
      if (!reader) {
        const data = await response.json().catch(() => ({}));
        const fallbackText = textValue(data?.choices?.[0]?.message?.content || data?.output_text || data?.error || data?.message || "");
        responseMeta.usage = normalizeUsage(data?.usage);
        responseMeta.durationMs = Date.now() - startedAt;
        updateSession(sessionId, (currentSession) => ({
          ...currentSession,
          messages: currentSession.messages.map((message) => (message.id === assistantMessageId ? { ...message, content: fallbackText, status: "done", responseMeta } : message)),
          updatedAt: new Date().toISOString(),
        }));
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let assistantText = "";
      let usage = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;

          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;

          try {
            const chunk = JSON.parse(payload);
            usage = normalizeUsage(chunk?.usage) || usage;
            const text = readAssistantText(chunk);
            if (!text) continue;

            assistantText += text;
            setStreamingText(assistantText);
            updateSession(sessionId, (currentSession) => ({
              ...currentSession,
              messages: currentSession.messages.map((message) => (message.id === assistantMessageId ? { ...message, content: assistantText, status: "streaming" } : message)),
              updatedAt: new Date().toISOString(),
            }));
          } catch {
            // Ignore malformed chunks.
          }
        }
      }

      updateSession(sessionId, (currentSession) => ({
        ...currentSession,
        messages: currentSession.messages.map((message) => (message.id === assistantMessageId ? {
          ...message,
          content: assistantText || message.content,
          status: assistantText ? "done" : "error",
          responseMeta: { ...responseMeta, usage, durationMs: Date.now() - startedAt },
        } : message)),
        updatedAt: new Date().toISOString(),
      }));
      if (titleSeed) finalizeSessionTitle(sessionId, titleSeed);
    } catch (error) {
      if (error.name !== "AbortError") {
        const errorText = textValue(error?.message || error);
        updateSession(sessionId, (currentSession) => ({
          ...currentSession,
          messages: currentSession.messages.map((message) => (message.id === assistantMessageId ? { ...message, content: `Error: ${errorText}`, status: "error" } : message)),
          updatedAt: new Date().toISOString(),
        }));
        setLoadError(errorText || "Failed to send message.");
      }
    } finally {
      setIsSending(false);
      setStreamingMessageId("");
      setStreamingText("");
      abortRef.current = null;
    }
  };

  const buildRequestMessages = (messages, stopBeforeId) => {
    const out = [];
    for (const message of messages) {
      if (stopBeforeId && message.id === stopBeforeId) break;
      if (message.role !== "user" && message.role !== "assistant") continue;
      if (message.role === "assistant" && (message.status === "error" || !textValue(message.content))) continue;
      out.push({
        role: message.role,
        content: message.role === "user" ? buildUserContent(message) : message.content,
      });
    }
    return out;
  };

  const sendMessage = async () => {
    if (isSending) return;
    const model = activeModel || activeProviderGroup?.models?.[0] || null;
    if (!model) return;

    const userText = draft.trim();
    if (!userText && attachments.length === 0) return;

    let sessionId = activeSessionId;
    let session = sessions.find((item) => item.id === sessionId);
    if (!session) {
      session = ensureSessionForModel(model);
      if (!session) return;
      sessionId = session.id;
      setSessions((prev) => [session, ...prev]);
      setActiveSessionId(sessionId);
    }

    const userMessage = {
      id: createId(),
      role: "user",
      content: userText,
      attachments: attachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        type: attachment.type,
        dataUrl: attachment.dataUrl,
      })),
      createdAt: new Date().toISOString(),
    };

    const assistantMessageId = createId();
    const assistantMessage = {
      id: assistantMessageId,
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
      status: "streaming",
    };

    const nextMessages = [...(session.messages || []), userMessage, assistantMessage];
    setSessions((prev) => prev.map((item) => (item.id === sessionId ? {
      ...item,
      providerId: model.providerId,
      providerName: model.providerName,
      modelId: model.id,
      modelName: model.name,
      messages: nextMessages,
      updatedAt: new Date().toISOString(),
      title: item.title === "New chat" ? makeSessionTitle(userText) : item.title,
    } : item)));
    setDraft("");
    setAttachments([]);

    const requestMessages = buildRequestMessages(nextMessages, assistantMessageId);
    await runStream(sessionId, model, requestMessages, assistantMessageId, userText);
  };

  // Regenerate the assistant reply for `assistantId`: re-run using all messages
  // that precede it, replacing its content in place.
  const retryMessage = async (assistantId) => {
    if (isSending) return;
    const model = activeModel || activeProviderGroup?.models?.[0] || null;
    if (!model) return;

    const sessionId = activeSessionId;
    const session = sessions.find((item) => item.id === sessionId);
    if (!session) return;

    const requestMessages = buildRequestMessages(session.messages || [], assistantId);
    if (requestMessages.length === 0) return;

    updateSession(sessionId, (currentSession) => ({
      ...currentSession,
      messages: currentSession.messages.map((message) => (message.id === assistantId ? { ...message, content: "", status: "streaming" } : message)),
      updatedAt: new Date().toISOString(),
    }));

    await runStream(sessionId, model, requestMessages, assistantId, null);
  };

  const handleKeyDown = (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (canSend) sendMessage();
    }
  };

  const modelLabel = activeModel ? `${activeModel.name}` : "Select model";
  const modelSubLabel = activeModel ? activeModel.requestModel : "Choose from connected providers";

  return (
    <div className="relative flex-1 flex flex-col h-full min-h-0 min-w-0 bg-[#212121] text-white overflow-hidden">
      <div className="relative mx-auto flex flex-1 h-full min-h-0 w-full max-w-4xl flex-col">
        <div className="flex shrink-0 items-center justify-between gap-3 px-4 py-3 lg:px-6">
          <div className="flex items-center gap-2">
          {/* Provider selector */}
          <div ref={providerMenuRef} className="relative">
            <button
              type="button"
              onClick={() => { setProviderMenuOpen((v) => !v); setModelMenuOpen(false); }}
              className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-left transition hover:bg-white/8"
            >
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-[0.18em] text-white/40">Provider</p>
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold text-white">{activeProviderGroup?.providerName || "Select provider"}</span>
                  <span className="material-symbols-outlined text-[18px] text-white/70">expand_more</span>
                </div>
              </div>
            </button>

            {providerMenuOpen ? (
              <div className="absolute left-0 top-[calc(100%+10px)] z-30 w-[min(360px,calc(100vw-2rem))] overflow-hidden rounded-[20px] border border-white/10 bg-[#262626] shadow-2xl shadow-black/50">
                <div className="border-b border-white/10 px-4 py-3">
                  <p className="text-xs uppercase tracking-[0.22em] text-white/45">Providers</p>
                  <p className="text-sm text-white/75">Pick a provider first</p>
                </div>
                <div className="max-h-[60vh] overflow-y-auto p-2 custom-scrollbar">
                  {providerGroups.length === 0 ? (
                    <p className="px-3 py-4 text-sm text-white/55">No connected providers.</p>
                  ) : providerGroups.map((group) => {
                    const isActive = group.providerId === activeProviderId;
                    return (
                      <button
                        key={group.providerId}
                        type="button"
                        onClick={() => { handleSelectProvider(group.providerId); setProviderMenuOpen(false); }}
                        className={`w-full rounded-[14px] border px-3 py-3 text-left transition mb-1 ${isActive ? "border-blue-400/40 bg-blue-500/15" : "border-white/10 bg-white/5 hover:bg-white/8"}`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="truncate text-sm font-medium text-white">{group.providerName}</span>
                          <Badge size="sm" variant="default">{group.modelsLoading ? `${group.models.length}…` : group.models.length}</Badge>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>

          {/* Model selector (scoped to the chosen provider) */}
          <div ref={modelMenuRef} className="relative">
            <button
              type="button"
              onClick={() => { setModelMenuOpen((value) => !value); setProviderMenuOpen(false); }}
              disabled={!activeProviderGroup}
              className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-left transition hover:bg-white/8 disabled:opacity-50"
            >
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-[0.18em] text-white/40">Model</p>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-white">{modelLabel}</span>
                  <span className="material-symbols-outlined text-[18px] text-white/70">expand_more</span>
                </div>
                <p className="truncate text-xs text-white/55">{modelSubLabel}</p>
              </div>
            </button>

            {modelMenuOpen && activeProviderGroup ? (
              <div className="absolute left-0 top-[calc(100%+10px)] z-30 w-[min(520px,calc(100vw-2rem))] overflow-hidden rounded-[20px] border border-white/10 bg-[#262626] shadow-2xl shadow-black/50">
                <div className="border-b border-white/10 px-4 py-3">
                  <p className="text-xs uppercase tracking-[0.22em] text-white/45">Models</p>
                  <p className="text-sm text-white/75">{activeProviderGroup.providerName} · {activeProviderGroup.requestPrefix}/…</p>
                  <div className="mt-3 flex gap-2">
                    <input
                      value={customModel}
                      onChange={(event) => setCustomModel(event.target.value)}
                      onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); handleAddCustomModel(); } }}
                      placeholder="Custom model ID, e.g. qd/ultimate"
                      className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs text-white outline-none placeholder:text-white/30 focus:border-blue-400/50"
                    />
                    <button type="button" onClick={handleAddCustomModel} disabled={!customModel.trim()} className="rounded-lg bg-blue-500/20 px-3 py-2 text-xs text-blue-200 disabled:opacity-40">
                      Add
                    </button>
                  </div>
                </div>
                <div className="max-h-[60vh] overflow-y-auto p-2 custom-scrollbar">
                  {activeProviderGroup.models.length === 0 ? (
                    <p className="px-3 py-4 text-sm text-white/55">
                      {activeProviderGroup.modelsLoading ? "Loading models…" : "No catalog models. Add a custom model above."}
                    </p>
                  ) : null}
                  <div className="grid gap-2 sm:grid-cols-2">
                    {activeProviderGroup.models.map((model) => {
                      const isActive = model.id === activeModelId;
                      return (
                        <button
                          key={model.id}
                          type="button"
                          onClick={() => { handleSelectModel(model.id); setModelMenuOpen(false); }}
                          className={`rounded-[14px] border px-3 py-3 text-left transition ${isActive ? "border-blue-400/40 bg-blue-500/15" : "border-white/10 bg-white/5 hover:bg-white/8"}`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-white">{model.name}</p>
                              <p className="truncate text-[11px] text-white/45">{model.requestModel}</p>
                            </div>
                            {isActive ? <span className="material-symbols-outlined text-[18px] text-blue-300">check_circle</span> : null}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => { setFooterOpen((value) => !value); setApiKeyOpen(false); setHistoryOpen(false); }}
              className={`rounded-2xl border px-4 py-3 text-sm transition ${footerOpen ? "border-blue-400/40 bg-blue-500/10 text-blue-200" : "border-white/10 bg-white/5 text-white/80 hover:bg-white/8"}`}
              title="Choose what the response footer shows"
            >
              <span className="material-symbols-outlined align-middle text-[18px]">tune</span>
            </button>
            <button
              type="button"
              onClick={() => setApiKeyOpen((value) => !value)}
              className={`rounded-2xl border px-4 py-3 text-sm transition ${apiKey.trim() ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/15" : "border-white/10 bg-white/5 text-white/80 hover:bg-white/8"}`}
              title={apiKey.trim() ? "Using your API key" : "Set an API key to call the provider directly"}
            >
              <span className="material-symbols-outlined align-middle text-[18px]">key</span>
            </button>
            <button
              type="button"
              onClick={() => setHistoryOpen((value) => !value)}
              className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/80 transition hover:bg-white/8"
            >
              History
            </button>
            <Button variant="ghost" size="sm" icon="delete" onClick={handleDeleteCurrentChat} disabled={!activeSessionId || sessions.length === 0}>
              Clear
            </Button>
          </div>
        </div>

        {footerOpen ? (
          <div className="mx-4 mb-1 rounded-[18px] border border-white/10 bg-[#262626] p-3 lg:mx-6">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs uppercase tracking-[0.18em] text-white/45">Response footer</p>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => footerSettings.resetFooter()}
                  className="text-xs text-white/45 underline hover:text-white/80"
                >
                  Reset
                </button>
                <button type="button" onClick={() => setFooterOpen(false)} className="text-white/40 hover:text-white" aria-label="Close">
                  <span className="material-symbols-outlined text-[18px]">close</span>
                </button>
              </div>
            </div>
            <p className="mt-1 text-xs leading-5 text-white/50">
              Choose what appears in the small info line under each assistant reply.
            </p>

            <label className="mt-3 flex items-center gap-2 text-sm text-white/80">
              <input
                type="checkbox"
                checked={footerSettings.enabled}
                onChange={(e) => footerSettings.setEnabled(e.target.checked)}
                className="size-4 accent-blue-500"
              />
              Show response footer
            </label>

            <div className={`mt-3 grid gap-2 sm:grid-cols-2 ${footerSettings.enabled ? "" : "pointer-events-none opacity-40"}`}>
              {FOOTER_FIELDS.map((field) => (
                <label key={field.key} className="flex items-start gap-2 rounded-[12px] border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80">
                  <input
                    type="checkbox"
                    checked={!!footerSettings.fields[field.key]}
                    onChange={() => footerSettings.toggleField(field.key)}
                    className="mt-0.5 size-4 accent-blue-500"
                  />
                  <span className="min-w-0">
                    <span className="block">{field.label}</span>
                    <span className="block text-[11px] leading-4 text-white/40">{field.hint}</span>
                  </span>
                </label>
              ))}
            </div>

            <div className={`mt-3 ${footerSettings.enabled ? "" : "pointer-events-none opacity-40"}`}>
              <p className="text-xs uppercase tracking-[0.18em] text-white/45">Custom note (optional)</p>
              <input
                type="text"
                value={footerSettings.customMessage}
                onChange={(e) => footerSettings.setCustomMessage(e.target.value)}
                placeholder="e.g. Powered by SantaiNetwork"
                maxLength={200}
                className="mt-2 w-full rounded-[12px] border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:border-white/25"
              />
            </div>
          </div>
        ) : null}

        {apiKeyOpen ? (
          <div className="mx-4 mb-1 rounded-[18px] border border-white/10 bg-[#262626] p-3 lg:mx-6">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs uppercase tracking-[0.18em] text-white/45">API Key (optional)</p>
              <button type="button" onClick={() => setApiKeyOpen(false)} className="text-white/40 hover:text-white" aria-label="Close">
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>
            <p className="mt-1 text-xs leading-5 text-white/50">
              Provide a 9router API key to call the provider directly with that key. Leave blank to use an auto-selected active key.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="sk-..."
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-[12px] border border-white/10 bg-black/30 px-3 py-2 font-mono text-sm text-white outline-none placeholder:text-white/30 focus:border-white/25"
              />
              {apiKey ? (
                <button type="button" onClick={() => setApiKey("")} className="rounded-[12px] border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/70 transition hover:bg-white/10">
                  Clear
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {historyOpen ? (
          <div ref={historyMenuRef} className="absolute right-4 top-[72px] z-20 w-[min(360px,calc(100vw-2rem))] rounded-[20px] border border-white/10 bg-[#262626] p-2 shadow-2xl shadow-black/50 lg:right-6">
            <div className="px-3 py-2">
              <p className="text-xs uppercase tracking-[0.22em] text-white/45">Recent chats</p>
            </div>
            <div className="max-h-[48vh] space-y-2 overflow-y-auto p-1 custom-scrollbar">
              {sessionItems.length === 0 ? (
                <div className="rounded-[16px] border border-dashed border-white/10 bg-white/5 p-4 text-sm text-white/55">
                  No conversations yet.
                </div>
              ) : sessionItems.map((session) => {
                const isActive = session.id === activeSessionId;
                const latestMessage = [...(session.messages || [])].reverse().find((message) => message.role === "user") || session.messages?.[0];
                return (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => handleSelectSession(session.id)}
                    className={`w-full rounded-[16px] border px-3 py-3 text-left transition ${isActive ? "border-blue-400/40 bg-blue-500/15" : "border-white/10 bg-white/5 hover:bg-white/8"}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-white">{session.title}</p>
                        <p className="mt-1 truncate text-xs text-white/50">{textValue(latestMessage?.content) || "Empty chat"}</p>
                      </div>
                      <span className="text-[10px] text-white/40 shrink-0">{formatRelativeTime(session.updatedAt)}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {loadError ? (
          <div className="mt-4 rounded-[18px] border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-rose-100">
            <div className="flex items-start gap-3">
              <span className="material-symbols-outlined text-[20px]">error</span>
              <p className="text-sm leading-6">{loadError}</p>
            </div>
          </div>
        ) : null}

        <div className="flex flex-1 flex-col min-h-0">
          <div className="flex-1 overflow-y-auto py-4 custom-scrollbar">
            {currentMessages.length === 0 ? (
              <div className="flex min-h-[50vh] items-center justify-center px-4 text-center">
                <div className="max-w-xl space-y-4">
                  <div className="mx-auto flex size-16 items-center justify-center rounded-[20px] border border-white/10 bg-white/5 text-white/80">
                    <span className="material-symbols-outlined text-[30px]">chat</span>
                  </div>
                  <div className="space-y-2">
                    <h2 className="text-2xl font-semibold text-white">Start a conversation</h2>
                    <p className="text-sm leading-6 text-white/60">
                      Simple chat interface to interact with any AI model from connected providers. Select a model and start chatting!
                    </p>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4">
              {currentMessages.map((message) => {
                const isUser = message.role === "user";
                const isAssistant = message.role === "assistant";
                const isStreaming = isAssistant && message.id === streamingMessageId && message.status === "streaming";
                const content = textValue(message.content) || (isAssistant ? streamingText : "");

                return (
                  <div key={message.id} className={`flex w-full ${isUser ? "justify-end" : "justify-start"} mb-6`}>
                    <div className={`max-w-[min(88%,42rem)] ${isUser ? "rounded-3xl bg-[#2f2f2f] px-5 py-3.5 text-white" : "text-white/90"}`}>
                      <div className="mb-1 flex items-center justify-between gap-3">
                        <span className="text-xs font-semibold">{isUser ? "You" : activeModel?.name || "Assistant"}</span>
                      </div>

                      {message.attachments?.length ? (
                        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 mt-2">
                          {message.attachments.map((attachment) => (
                            <a key={attachment.id} href={attachment.dataUrl} target="_blank" rel="noreferrer" className="overflow-hidden rounded-[18px] border border-white/10 bg-black/20">
                              <img src={attachment.dataUrl} alt={attachment.name} className="h-28 w-full object-cover" loading="lazy" decoding="async" />
                            </a>
                          ))}
                        </div>
                      ) : null}

                      <div className="whitespace-pre-wrap break-words text-[15px] leading-7">
                        {content}
                        {isAssistant && isStreaming && !streamingText ? <span className="inline-block animate-pulse">▋</span> : null}
                      </div>

                      {isAssistant && !isStreaming ? (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          {message.responseMeta && footerSettings.enabled && (footerSettings.hasVisibleField() || footerSettings.customMessage) ? (
                            <div className="mr-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-white/40" aria-label="Response metadata">
                              {footerSettings.fields.providerModel ? <span title="Provider and model">{message.responseMeta.providerName || message.responseMeta.provider} · {message.responseMeta.model}</span> : null}
                              {footerSettings.fields.tokens && message.responseMeta.usage ? <span title="Prompt / completion / total tokens">{message.responseMeta.usage.promptTokens} in · {message.responseMeta.usage.completionTokens} out · {message.responseMeta.usage.totalTokens} total</span> : null}
                              {footerSettings.fields.apiKeyQueue && message.responseMeta.apiKeyQueueMs > 0 ? <span title="API key queue wait">API queue {formatDuration(message.responseMeta.apiKeyQueueMs)}</span> : null}
                              {footerSettings.fields.providerQueue && message.responseMeta.providerQueueMs > 0 ? <span title="Provider queue wait">Provider queue {formatDuration(message.responseMeta.providerQueueMs)}</span> : null}
                              {footerSettings.fields.duration && message.responseMeta.durationMs != null ? <span title="Total response duration">{formatDuration(message.responseMeta.durationMs)}</span> : null}
                              {footerSettings.customMessage ? <span className="text-white/50" title="Custom note">{footerSettings.customMessage}</span> : null}
                            </div>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => retryMessage(message.id)}
                            disabled={isSending}
                            className="flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-white/60 transition hover:bg-white/10 hover:text-white disabled:opacity-40"
                            title="Regenerate this reply"
                          >
                            <span className="material-symbols-outlined text-[15px]">refresh</span>
                            Retry
                          </button>
                          {message.status === "error" ? (
                            <span className="text-xs text-rose-300/80">failed</span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="shrink-0 pt-2">
            {attachments.length > 0 ? (
              <div className="mx-auto mb-3 flex w-full max-w-3xl flex-wrap gap-2 px-4">
                {attachments.map((attachment) => (
                  <div key={attachment.id} className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-2">
                    <span className="text-xs text-white/80 max-w-[12rem] truncate">{attachment.name}</span>
                    <button type="button" onClick={() => removeAttachment(attachment.id)} className="text-white/55 hover:text-white" aria-label="Remove attachment">
                      <span className="material-symbols-outlined text-[18px]">close</span>
                    </button>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="mx-auto w-full max-w-3xl px-4 pb-2">
              <div className="rounded-[26px] bg-[#2f2f2f] px-3 pt-3 pb-2 shadow-[0_0_15px_rgba(0,0,0,0.10)] ring-1 ring-white/5">
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Message AI"
                  rows={1}
                  className="w-full resize-none bg-transparent px-2 text-[15px] leading-6 text-white outline-none placeholder:text-white/40 custom-scrollbar max-h-[25vh] overflow-y-auto"
                />

                <div className="mt-2 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => fileInputRef.current?.click()} disabled={!activeModel || loadingData} className="p-2 text-white/50 hover:text-white transition rounded-full hover:bg-white/5">
                      <span className="material-symbols-outlined text-[20px]">attach_file</span>
                    </button>
                    <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleAttachFiles} />
                    <span className="text-xs font-medium text-white/30 truncate max-w-[120px]">{activeModel ? activeModel.name : "No model"}</span>
                  </div>

                  <div className="flex items-center gap-2">
                    {isSending ? (
                      <button type="button" onClick={handleStop} className="p-2 text-white bg-white/10 hover:bg-white/20 transition rounded-full h-8 w-8 flex items-center justify-center">
                        <span className="material-symbols-outlined text-[16px]">stop</span>
                      </button>
                    ) : null}
                    <button onClick={sendMessage} disabled={!canSend} className={`h-8 w-8 rounded-full flex items-center justify-center transition ${canSend ? 'bg-white text-black hover:opacity-90' : 'bg-white/10 text-white/30 cursor-not-allowed'}`}>
                      <span className="material-symbols-outlined text-[16px]">arrow_upward</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <p className="mx-auto mt-2 max-w-3xl px-4 pb-4 text-center text-[11px] text-white/30">
            Model list is filtered from connected providers.
          </p>
        </div>
      </div>
    </div>
  );
}
