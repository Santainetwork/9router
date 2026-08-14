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

// Full-theme customization ----------------------------------------------------
// A "palette" is a small set of user overrides applied on top of the built-in
// light/dark vars. Keys map to CSS custom properties on <html>. Values are hex
// (colors) or a number (radius, in px). Empty/absent = fall back to built-in.
const PALETTE_VARS = {
  accent: "--color-primary",
  bg: "--color-bg",
  surface: "--color-surface",
  text: "--color-text",
  border: "--color-border",
};

// Named presets. Each sets a coherent palette; `dark` marks whether the preset
// looks best in dark mode (used to auto-switch mode on apply).
export const THEME_PRESETS = {
  default: { label: "Default", accent: "", bg: "", surface: "", text: "", border: "" },
  ocean: { label: "Ocean", dark: true, accent: "#38bdf8", bg: "#0b1620", surface: "#132433", text: "#e2f1fb", border: "#1e3547" },
  forest: { label: "Forest", dark: true, accent: "#34d399", bg: "#0d1712", surface: "#152820", text: "#e3f5ec", border: "#1f3a2d" },
  rose: { label: "Rose", accent: "#f43f5e", bg: "#fff5f6", surface: "#ffffff", text: "#2a1216", border: "#f3d4d9" },
  grape: { label: "Grape", dark: true, accent: "#a78bfa", bg: "#161022", surface: "#221a33", text: "#ece6fb", border: "#33284a" },
  mono: { label: "Mono", dark: true, accent: "#e5e5e5", bg: "#0a0a0a", surface: "#1a1a1a", text: "#fafafa", border: "#2a2a2a" },
  paper: { label: "Paper", accent: "#b45309", bg: "#f6f1e7", surface: "#fffdf8", text: "#2a2016", border: "#e5dcc8" },
  midnight: { label: "Midnight", dark: true, accent: "#60a5fa", bg: "#0a0f1e", surface: "#141b30", text: "#e6ecff", border: "#1f2a44" },
};

const useThemeStore = create(
  persist(
    (set, get) => ({
      theme: THEME_CONFIG.defaultTheme,
      accent: "", // custom brand/accent hex, "" = built-in palette
      palette: {}, // { bg, surface, text, border } hex overrides
      radius: 0, // custom base radius in px, 0 = built-in
      preset: "default",

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
        set({ accent: val, preset: "custom" });
        applyAccent(val);
      },

      resetAccent: () => {
        set({ accent: "" });
        applyAccent("");
      },

      // Set one palette color (bg/surface/text/border). "" clears the override.
      setPaletteColor: (key, hex) => {
        if (!(key in PALETTE_VARS)) return;
        const val = hex && isValidHex(hex) ? (hex.startsWith("#") ? hex : `#${hex}`) : "";
        const palette = { ...get().palette, [key]: val };
        if (!val) delete palette[key];
        set({ palette, preset: "custom" });
        applyPalette(palette);
      },

      setRadius: (px) => {
        const n = Math.max(0, Math.min(24, Number(px) || 0));
        set({ radius: n, preset: n ? "custom" : get().preset });
        applyRadius(n);
      },

      // Apply a named preset (sets accent + palette together, optionally mode).
      applyPreset: (name) => {
        const p = THEME_PRESETS[name];
        if (!p) return;
        const palette = {};
        for (const k of Object.keys(PALETTE_VARS)) {
          if (k === "accent") continue;
          if (p[k]) palette[k] = p[k];
        }
        const nextTheme = name === "default" ? get().theme : p.dark ? "dark" : "light";
        set({ preset: name, accent: p.accent || "", palette, theme: nextTheme });
        applyTheme(nextTheme);
        applyAccent(p.accent || "");
        applyPalette(palette);
      },

      resetCustomTheme: () => {
        set({ accent: "", palette: {}, radius: 0, preset: "default" });
        applyAccent("");
        applyPalette({});
        applyRadius(0);
      },

      initTheme: () => {
        applyTheme(get().theme);
        applyAccent(get().accent);
        applyPalette(get().palette);
        applyRadius(get().radius);
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

// Apply / clear custom palette (bg/surface/text/border) plus derived vars so
// the override stays coherent across surfaces, borders, and muted text.
function applyPalette(palette) {
  if (typeof window === "undefined") return;
  const root = document.documentElement;
  const p = palette || {};

  const setOrClear = (varName, value) => {
    if (value) root.style.setProperty(varName, value);
    else root.style.removeProperty(varName);
  };

  // Background + its alt tint.
  setOrClear("--color-bg", p.bg || "");
  setOrClear("--color-bg-alt", p.bg ? shade(p.bg, 0.04) : "");

  // Surface ladder derived from the base surface.
  setOrClear("--color-surface", p.surface || "");
  setOrClear("--color-surface-2", p.surface ? shade(p.surface, 0.06) : "");
  setOrClear("--color-surface-3", p.surface ? shade(p.surface, 0.12) : "");
  setOrClear("--color-sidebar", p.surface || "");

  // Text + a muted derivative.
  setOrClear("--color-text", p.text || "");
  setOrClear("--color-text-main", p.text || "");
  setOrClear("--color-text-muted", p.text ? shade(p.text, -0.35) : "");

  // Border + subtle derivative.
  setOrClear("--color-border", p.border || "");
  setOrClear("--color-border-subtle", p.border ? shade(p.border, 0.08) : "");
}

// Apply / clear custom base radius (px). Scales the two brand radius tokens.
function applyRadius(px) {
  if (typeof window === "undefined") return;
  const root = document.documentElement;
  const n = Number(px) || 0;
  const vars = ["--radius-brand", "--radius-brand-lg", "--radius-sm", "--radius-md", "--radius-lg", "--radius-xl"];
  if (!n) {
    for (const v of vars) root.style.removeProperty(v);
    return;
  }
  root.style.setProperty("--radius-brand", `${n}px`);
  root.style.setProperty("--radius-brand-lg", `${n + 4}px`);
  // Tailwind's standard scale (drives rounded-sm/md/lg/xl used across the app).
  root.style.setProperty("--radius-sm", `${Math.max(0, n - 4)}px`);
  root.style.setProperty("--radius-md", `${Math.max(0, n - 2)}px`);
  root.style.setProperty("--radius-lg", `${n}px`);
  root.style.setProperty("--radius-xl", `${n + 4}px`);
}

export default useThemeStore;
