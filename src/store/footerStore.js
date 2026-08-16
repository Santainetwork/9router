import { create } from "zustand";
import { persist } from "zustand/middleware";

// Per-user settings for the Basic Chat response footer (the subtle metadata
// line under each assistant reply). Users pick which fields to show and can
// add a free-text custom note that renders alongside the metadata.
//
// Persisted to localStorage so the choice survives reloads. This is a
// client-only preference — it never leaves the browser.

// Field toggles. Keys match the metadata rendered in BasicChatPageClient.
export const FOOTER_FIELDS = [
  { key: "providerModel", label: "Provider · model", hint: "Which provider/model served the reply" },
  { key: "tokens", label: "Token usage", hint: "Prompt / completion / total tokens" },
  { key: "apiKeyQueue", label: "API-key queue wait", hint: "Time spent waiting in the per-key RPM queue" },
  { key: "providerQueue", label: "Provider queue wait", hint: "Time spent waiting in the per-provider RPM queue" },
  { key: "duration", label: "Response duration", hint: "Total round-trip time" },
];

const DEFAULT_FIELDS = {
  providerModel: true,
  tokens: true,
  apiKeyQueue: true,
  providerQueue: true,
  duration: true,
};

const useFooterStore = create(
  persist(
    (set, get) => ({
      // Master switch — hide the whole footer regardless of field toggles.
      enabled: true,
      // Per-field visibility.
      fields: { ...DEFAULT_FIELDS },
      // Optional custom note shown at the end of the footer line.
      customMessage: "",

      setEnabled: (enabled) => set({ enabled: !!enabled }),

      toggleField: (key) =>
        set((state) => ({
          fields: { ...state.fields, [key]: !state.fields[key] },
        })),

      setField: (key, value) =>
        set((state) => ({
          fields: { ...state.fields, [key]: !!value },
        })),

      setCustomMessage: (msg) => set({ customMessage: String(msg ?? "").slice(0, 200) }),

      resetFooter: () =>
        set({ enabled: true, fields: { ...DEFAULT_FIELDS }, customMessage: "" }),

      // True when at least one field is on (used to decide whether to render).
      hasVisibleField: () => Object.values(get().fields).some(Boolean),
    }),
    {
      name: "basic-chat.footer-settings",
      version: 1,
      // Merge persisted state onto defaults so newly-added fields default to on.
      merge: (persisted, current) => ({
        ...current,
        ...(persisted || {}),
        fields: { ...DEFAULT_FIELDS, ...((persisted || {}).fields || {}) },
      }),
    }
  )
);

export default useFooterStore;
