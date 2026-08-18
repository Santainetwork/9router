import { create } from "zustand";
import {
  DEFAULT_FOOTER_FIELDS,
  footerSettingsFromServer,
} from "@/shared/utils/footerSettings";

// Admin-controlled Basic Chat response footer. Settings are loaded from the
// server so every dashboard user sees the same configuration.
export const FOOTER_FIELDS = [
  { key: "providerModel", label: "Provider · model", hint: "Which provider/model served the reply" },
  { key: "tokens", label: "Token usage", hint: "Prompt / completion / total tokens" },
  { key: "apiKeyQueue", label: "API-key queue wait", hint: "Time spent waiting in the per-key RPM queue" },
  { key: "providerQueue", label: "Provider queue wait", hint: "Time spent waiting in the per-provider RPM queue" },
  { key: "duration", label: "Response duration", hint: "Total round-trip time" },
];

const useFooterStore = create((set, get) => ({
  enabled: true,
  fields: { ...DEFAULT_FOOTER_FIELDS },
  customMessage: "",
  loaded: false,

  setSettings: (settings) => set({ ...footerSettingsFromServer(settings), loaded: true }),
  setEnabled: (enabled) => set({ enabled: !!enabled }),
  toggleField: (key) => set((state) => ({
    fields: { ...state.fields, [key]: !state.fields[key] },
  })),
  setField: (key, value) => set((state) => ({
    fields: { ...state.fields, [key]: !!value },
  })),
  setCustomMessage: (msg) => set({ customMessage: String(msg ?? "").slice(0, 500) }),
  resetFooter: () => set({ enabled: true, fields: { ...DEFAULT_FOOTER_FIELDS }, customMessage: "" }),
  hasVisibleField: () => Object.values(get().fields).some(Boolean),
}));

export default useFooterStore;
