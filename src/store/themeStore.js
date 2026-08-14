"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { THEME_CONFIG } from "@/shared/constants/config";

// Derive a small brand ramp (hover/darker) from a single accent hex so
// existing --color-brand-500 / --color-primary consumers stay coherent.
function shade(hex, amount) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "");
  if (!m) return hex;
  const adj = (c) => {
    const n = Math.round(parseInt(c, 16) * (1 + amount));
    return Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
  };
  return `#${adj(m[1])}${adj(m[2])}${adj(m[3])}`;
}

function isValidHex(hex) {
  return /^#?([a-f\d]{3}|[a-f\d]{6})$/i.test(hex || "");
}

const useThemeStore = create(
  persist(
    (set, get) => ({
      theme: THEME_CONFIG.defaultTheme,
      accent: "", // custom brand/accent hex, "" = built-in palette

      setTheme: (theme) => {
        set({ theme });
        applyTheme(theme);
      },

      toggleTheme: () => {
        const currentTheme = get().theme;
        const newTheme = currentTheme === "dark" ? "light" : "dark";
        set({ theme: newTheme });
        applyTheme(newTheme);
      },

      setAccent: (accent) => {
        const val = accent && isValidHex(accent) ? (accent.startsWith("#") ? accent : `#${accent}`) : "";
        set({ accent: val });
        applyAccent(val);
      },

      resetAccent: () => {
        set({ accent: "" });
        applyAccent("");
      },

      initTheme: () => {
        applyTheme(get().theme);
        applyAccent(get().accent);
      },
    }),
    {
      name: THEME_CONFIG.storageKey,
    }
  )
);

// Apply light/dark class to document
function applyTheme(theme) {
  if (typeof window === "undefined") return;

  const root = document.documentElement;
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";

  const effectiveTheme = theme === "system" ? systemTheme : theme;

  if (effectiveTheme === "dark") {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }
}

// Apply / clear custom accent CSS variable overrides on <html>.
function applyAccent(accent) {
  if (typeof window === "undefined") return;
  const root = document.documentElement;
  const vars = [
    "--color-brand-500",
    "--color-brand-400",
    "--color-brand-600",
    "--color-primary",
    "--color-primary-hover",
  ];
  if (!accent || !isValidHex(accent)) {
    for (const v of vars) root.style.removeProperty(v);
    return;
  }
  const base = accent.startsWith("#") ? accent : `#${accent}`;
  root.style.setProperty("--color-brand-500", base);
  root.style.setProperty("--color-brand-400", shade(base, 0.12));
  root.style.setProperty("--color-brand-600", shade(base, -0.15));
  root.style.setProperty("--color-primary", base);
  root.style.setProperty("--color-primary-hover", shade(base, -0.15));
}

export default useThemeStore;
