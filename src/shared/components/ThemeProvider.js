"use client";

import { useEffect } from "react";
import useThemeStore from "@/store/themeStore";
import useUiVariantStore from "@/store/uiVariantStore";

export function ThemeProvider({ children }) {
  const { initTheme } = useThemeStore();
  const variant = useUiVariantStore((state) => state.variant);

  useEffect(() => {
    initTheme();
  }, [initTheme]);

  useEffect(() => {
    document.documentElement.dataset.uiVariant = variant;
  }, [variant]);

  return <>{children}</>;
}
