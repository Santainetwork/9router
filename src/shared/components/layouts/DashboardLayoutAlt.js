"use client";

// Adapted from friend 9Router v0.5.86 dashboard shell
// Origin: /root/.jcode/scratch/9router-ui/src/shared/components/layouts/DashboardLayout.js
// Changes: identical structure, uses friend-origin Sidebar/Header components

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useNotificationStore } from "@/store/notificationStore";
import SidebarAlt from "../SidebarAlt";
import HeaderAlt from "../HeaderAlt";

function getToastStyle(type) {
  if (type === "success") {
    return {
      wrapper: "border-green-500/30 bg-green-500/10 text-green-800 dark:text-green-400",
      icon: "check_circle",
    };
  }
  if (type === "error") {
    return {
      wrapper: "border-red-500/30 bg-red-500/10 text-red-800 dark:text-red-300",
      icon: "error",
    };
  }
  if (type === "warning") {
    return {
      wrapper: "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-400",
      icon: "warning",
    };
  }
  return {
    wrapper: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
    icon: "info",
  };
}

export default function DashboardLayoutAlt({ children }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCompact, setSidebarCompact] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);
  const pathname = usePathname();
  const menuButtonRef = useRef(null);
  const drawerRef = useRef(null);
  const notifications = useNotificationStore((state) => state.notifications);
  const removeNotification = useNotificationStore((state) => state.removeNotification);
  const sidebarVisible = isDesktop || sidebarOpen;
  const closeSidebar = () => {
    setSidebarOpen(false);
    globalThis.requestAnimationFrame(() => menuButtonRef.current?.focus());
  };

  useEffect(() => {
    const media = globalThis.matchMedia("(min-width: 1024px)");
    const sync = () => setIsDesktop(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (isDesktop) setSidebarOpen(false);
  }, [isDesktop]);

  useEffect(() => {
    try {
      const saved = globalThis.localStorage?.getItem("dashboard-sidebar-compact");
      if (saved === "true") setSidebarCompact(true);
    } catch {}
  }, []);

  useEffect(() => {
    if (!sidebarOpen) return undefined;
    const focusable = drawerRef.current?.querySelector("a, button");
    focusable?.focus();
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        setSidebarOpen(false);
        globalThis.requestAnimationFrame(() => menuButtonRef.current?.focus());
        return;
      }
      if (event.key !== "Tab") return;
      const items = [...(drawerRef.current?.querySelectorAll("a, button") || [])]
        .filter((item) => !item.disabled && item.getAttribute("aria-hidden") !== "true");
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [sidebarOpen]);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-bg">
      <div className="fixed top-4 right-4 z-[80] flex w-[min(92vw,380px)] flex-col gap-2" aria-live="polite" aria-relevant="additions text">
        {notifications.map((n) => {
          const style = getToastStyle(n.type);
          return (
            <div
              key={n.id}
              className={`rounded-lg border px-3 py-2 shadow-lg backdrop-blur-sm ${style.wrapper}`}
            >
              <div className="flex items-start gap-2">
                <span className="material-symbols-outlined text-[18px] leading-5" aria-hidden="true">{style.icon}</span>
                <div className="min-w-0 flex-1">
                  {n.title ? <p className="text-xs font-semibold mb-0.5">{n.title}</p> : null}
                  <p className="text-xs whitespace-pre-wrap break-words">{n.message}</p>
                </div>
                {n.dismissible ? (
                  <button
                    type="button"
                    onClick={() => removeNotification(n.id)}
                    className="text-current/70 hover:text-current"
                    aria-label="Dismiss notification"
                  >
                    <span className="material-symbols-outlined text-[16px]">close</span>
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      <a href="#dashboard-main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[90] focus:rounded focus:bg-surface focus:px-3 focus:py-2 focus:text-primary">
        Skip to main content
      </a>
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          onClick={closeSidebar}
          aria-hidden="true"
        />
      )}

      <div
        ref={drawerRef}
        className={`fixed inset-y-0 left-0 z-50 transform transition-transform duration-300 ease-in-out lg:static lg:flex lg:shrink-0 lg:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
        aria-hidden={!sidebarVisible}
        aria-modal={!isDesktop && sidebarOpen ? "true" : undefined}
        inert={sidebarVisible ? undefined : true}
        role={!isDesktop && sidebarOpen ? "dialog" : undefined}
        aria-label={!isDesktop && sidebarOpen ? "Navigation" : undefined}
      >
        <SidebarAlt compact={sidebarCompact} onClose={closeSidebar} />
      </div>

      <main id="dashboard-main" tabIndex="-1" inert={!isDesktop && sidebarOpen ? true : undefined} aria-hidden={!isDesktop && sidebarOpen ? "true" : undefined} className="flex flex-col flex-1 h-full min-w-0 max-w-full relative transition-colors duration-300 isolate">
        <div className="landing-grid absolute inset-0 pointer-events-none -z-10" aria-hidden="true" />
        <HeaderAlt key={pathname} menuButtonRef={menuButtonRef} onMenuClick={() => setSidebarOpen(true)} onCompactToggle={() => setSidebarCompact((value) => {
          const next = !value;
          try { globalThis.localStorage?.setItem("dashboard-sidebar-compact", String(next)); } catch {}
          return next;
        })} sidebarCompact={sidebarCompact} />
        <div className={`flex-1 overflow-y-auto custom-scrollbar ${pathname === "/dashboard/basic-chat" ? "" : "px-3 py-4 sm:p-5 lg:p-6"} ${pathname === "/dashboard/basic-chat" ? "flex flex-col overflow-hidden" : ""}`}>
          <div className={`${pathname === "/dashboard/basic-chat" ? "flex-1 w-full h-full flex flex-col" : "w-full max-w-[1600px] mx-auto"}`}>{children}</div>
        </div>
      </main>
    </div>
  );
}
