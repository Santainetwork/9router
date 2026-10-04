"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

const useUiVariantStore = create(
  persist(
    (set) => ({
      variant: "santai", // "santai" (current) or "friend" (v0.5.86 bundle)

      setVariant: (variant) => {
        if (variant !== "santai" && variant !== "friend") return;
        set({ variant });
      },
    }),
    {
      name: "9router-ui-variant",
    }
  )
);

export default useUiVariantStore;
