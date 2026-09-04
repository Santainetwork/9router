"use client";

import { useState, useEffect, useMemo } from "react";
import PropTypes from "prop-types";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/shared/utils/cn";
import { APP_CONFIG, UPDATER_CONFIG } from "@/shared/constants/config";
import { MEDIA_PROVIDER_KINDS } from "@/shared/constants/providers";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import Button from "./Button";
import { ConfirmModal } from "./Modal";
import NineRemotePromoModal from "./NineRemotePromoModal";

const VISIBLE_MEDIA_KINDS = ["embedding", "image", "video", "tts", "stt"];

// Organized into logical navigation sections according to UI/UX Pro Max standards
const NAV_SECTIONS = [
  {
    title: "Gateway",
    items: [
      { href: "/dashboard", label: "Overview", icon: "grid_view" },
      { href: "/dashboard/endpoint", label: "Endpoint & Key", icon: "key" },
      { href: "/dashboard/api-keys", label: "Key Access & Limits", icon: "tune" },
      { href: "/dashboard/providers", label: "Providers", icon: "dns" },
      { href: "/dashboard/combos", label: "Combos & Routing", icon: "layers" },
    ],
  },
  {
    title: "Traffic & Limits",
    items: [
      { href: "/dashboard/queue-monitor", label: "Request Queue", icon: "pending_actions" },
      { href: "/dashboard/rpm-tester", label: "Rate & Concurrency Tester", icon: "speed" },
      { href: "/dashboard/error-response", label: "Custom Error Response", icon: "warning" },
      { href: "/dashboard/token-saver", label: "Token Saver", icon: "savings" },
    ],
  },
  {
    title: "Metrics & Analytics",
    items: [
      { href: "/dashboard/usage", label: "Usage Analytics", icon: "bar_chart" },
      { href: "/dashboard/leaderboard", label: "Leaderboard", icon: "leaderboard" },
      { href: "/dashboard/quota", label: "Quota Tracker", icon: "data_usage" },
      { href: "/dashboard/custom-credits", label: "Custom Credits", icon: "account_balance_wallet" },
    ],
  },
  {
    title: "Tools & System",
    items: [
      { href: "/dashboard/basic-chat", label: "Basic Chat", icon: "chat" },
      { href: "/dashboard/model-probe", label: "Model Identity Probe", icon: "verified_user" },
      { href: "/dashboard/footer", label: "Response Footer", icon: "subtitles" },
      { href: "/dashboard/proxy-pools", label: "Proxy Pools", icon: "lan" },
      { href: "/dashboard/skills", label: "Skills", icon: "extension" },
      { href: "/dashboard/cli-tools", label: "CLI Tools", icon: "terminal" },
      { href: "/dashboard/console-log", label: "Console Log", icon: "terminal" },
    ],
  },
];

export default function Sidebar({ onClose }) {
  const pathname = usePathname();
  const [navSearch, setNavSearch] = useState("");
  const [mediaOpen, setMediaOpen] = useState(false);
  const [showRemoteModal, setShowRemoteModal] = useState(false);
  const [isDisconnected, setIsDisconnected] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [shutdownCountdown, setShutdownCountdown] = useState(0);
  const [enableTranslator, setEnableTranslator] = useState(false);
  const { copied, copy } = useCopyToClipboard(2000);

  const INSTALL_CMD = UPDATER_CONFIG.installCmdLatest;

  useEffect(() => {
    fetch("/api/settings")
      .then((res) => res.json())
      .then((data) => {
        if (data.enableTranslator) setEnableTranslator(true);
      })
      .catch(() => {});
  }, []);

  const isActive = (href) => {
    if (href === "/dashboard") return pathname === "/dashboard";
    return pathname.startsWith(href);
  };

  const filteredSections = useMemo(() => {
    const q = navSearch.trim().toLowerCase();
    if (!q) return NAV_SECTIONS;
    return NAV_SECTIONS.map((sec) => ({
      ...sec,
      items: sec.items.filter((item) =>
        item.label.toLowerCase().includes(q) || item.href.toLowerCase().includes(q)
      ),
    })).filter((sec) => sec.items.length > 0);
  }, [navSearch]);

  const handleUpdate = () => {
    setShowUpdateModal(false);
    setIsUpdating(true);
  };

  const handleCopyAndShutdown = async () => {
    copy(INSTALL_CMD);
    try {
      await fetch("/api/shutdown", { method: "POST" });
    } catch {}
    let count = 3;
    setShutdownCountdown(count);
    const timer = setInterval(() => {
      count--;
      setShutdownCountdown(count);
      if (count <= 0) {
        clearInterval(timer);
        setIsDisconnected(true);
      }
    }, 1000);
  };

  const handleCancelUpdate = () => {
    setIsUpdating(false);
  };

  return (
    <>
      <aside className="w-64 border-r border-border bg-surface flex flex-col h-full select-none">
        {/* Mobile close bar */}
        <div className="md:hidden flex justify-end p-2 border-b border-border">
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-text-muted hover:text-text-main rounded-md"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        {/* Brand Header */}
        <div className="px-5 py-4 border-b border-border/60">
          <Link href="/dashboard" className="flex items-center gap-3 group">
            <div className="flex items-center justify-center size-9 rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-sm transition-transform group-hover:scale-105">
              <span className="material-symbols-outlined text-[20px]">hub</span>
            </div>
            <div className="flex flex-col min-w-0">
              <span className="text-base font-bold tracking-tight text-text-main flex items-center gap-1.5 truncate">
                {APP_CONFIG.name}
                <span className="px-1.5 py-0.2 rounded text-[10px] font-mono bg-primary/10 text-primary border border-primary/20">
                  v2
                </span>
              </span>
              <span className="text-[10px] text-text-muted truncate">
                SantaiNetwork Gateway
              </span>
            </div>
          </Link>

          {/* Quick Search inside Sidebar */}
          <div className="relative mt-3">
            <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted text-[16px]">
              search
            </span>
            <input
              type="text"
              value={navSearch}
              onChange={(e) => setNavSearch(e.target.value)}
              placeholder="Quick find page..."
              className="w-full rounded-lg border border-border bg-input pl-8 pr-2.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary/40 placeholder:text-text-muted/60"
            />
            {navSearch ? (
              <button
                type="button"
                onClick={() => setNavSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-main"
              >
                <span className="material-symbols-outlined text-[14px]">close</span>
              </button>
            ) : null}
          </div>
        </div>

        {/* Navigation Sections */}
        <nav className="flex-1 px-3 py-3 overflow-y-auto custom-scrollbar space-y-4 text-xs">
          {filteredSections.map((sec) => (
            <div key={sec.title} className="space-y-1">
              <p className="px-2 text-[10px] font-bold uppercase tracking-wider text-text-muted/70">
                {sec.title}
              </p>
              <div className="space-y-0.5">
                {sec.items.map((item) => {
                  const active = isActive(item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={onClose}
                      className={cn(
                        "flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg font-medium transition-all group",
                        active
                          ? "bg-primary/10 text-primary font-semibold shadow-xs"
                          : "text-text-muted hover:bg-surface-2 hover:text-text-main"
                      )}
                    >
                      <span
                        className={cn(
                          "material-symbols-outlined text-[18px]",
                          active ? "text-primary" : "text-text-muted group-hover:text-text-main"
                        )}
                      >
                        {item.icon}
                      </span>
                      <span className="truncate">{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}

          {/* Media Providers Accordion */}
          <div className="space-y-1 pt-1">
            <p className="px-2 text-[10px] font-bold uppercase tracking-wider text-text-muted/70">
              Media
            </p>
            <button
              type="button"
              onClick={() => setMediaOpen((v) => !v)}
              className={cn(
                "w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg font-medium transition-all",
                pathname.startsWith("/dashboard/media-providers")
                  ? "bg-primary/10 text-primary font-semibold"
                  : "text-text-muted hover:bg-surface-2 hover:text-text-main"
              )}
            >
              <div className="flex items-center gap-2.5">
                <span className="material-symbols-outlined text-[18px]">perm_media</span>
                <span>Media Endpoints</span>
              </div>
              <span
                className="material-symbols-outlined text-[14px] transition-transform"
                style={{ transform: mediaOpen ? "rotate(180deg)" : "rotate(0deg)" }}
              >
                expand_more
              </span>
            </button>
            {mediaOpen && (
              <div className="pl-4 space-y-0.5 border-l border-border/50 ml-3.5 my-1">
                {MEDIA_PROVIDER_KINDS.filter((k) => VISIBLE_MEDIA_KINDS.includes(k.id)).map((kind) => (
                  <Link
                    key={kind.id}
                    href={`/dashboard/media-providers/${kind.id}`}
                    onClick={onClose}
                    className={cn(
                      "flex items-center gap-2 px-2.5 py-1 rounded-md text-[11px] transition-colors",
                      pathname.startsWith(`/dashboard/media-providers/${kind.id}`)
                        ? "text-primary font-semibold bg-primary/5"
                        : "text-text-muted hover:text-text-main"
                    )}
                  >
                    <span className="truncate">{kind.label}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </nav>

        {/* Footer Area */}
        <div className="p-3 border-t border-border bg-surface-2/30 flex items-center justify-between text-xs">
          <Link
            href="/dashboard/profile"
            onClick={onClose}
            className="flex items-center gap-2 text-text-muted hover:text-text-main font-medium py-1 px-1.5 rounded-md hover:bg-surface-2 transition-colors"
          >
            <span className="material-symbols-outlined text-[18px]">settings</span>
            <span>Settings</span>
          </Link>

          <div className="flex items-center gap-1">
            <span className="size-2 rounded-full bg-emerald-500 animate-pulse" title="Gateway Online" />
            <span className="text-[11px] font-mono text-emerald-600 dark:text-emerald-400 font-semibold">
              Live
            </span>
          </div>
        </div>
      </aside>

      {/* Modals */}
      <NineRemotePromoModal isOpen={showRemoteModal} onClose={() => setShowRemoteModal(false)} />

      <ConfirmModal
        isOpen={showUpdateModal}
        onClose={() => setShowUpdateModal(false)}
        onConfirm={handleUpdate}
        title="Update 9Router"
        message={`Show install command for v${updateInfo?.latestVersion || ""}?`}
        confirmText="Show Command"
        cancelText="Cancel"
        variant="primary"
      />

      {(isDisconnected || isUpdating) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-6">
          <div className="text-center p-8 bg-surface rounded-2xl border border-border max-w-sm">
            <div className="flex items-center justify-center size-14 rounded-full bg-red-500/20 text-red-500 mx-auto mb-4">
              <span className="material-symbols-outlined text-[28px]">power_off</span>
            </div>
            <h2 className="text-lg font-bold text-text-main mb-2">Server Disconnected</h2>
            <p className="text-xs text-text-muted mb-6">The gateway server process has stopped.</p>
            <Button variant="secondary" onClick={() => globalThis.location.reload()}>
              Reload Page
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

Sidebar.propTypes = {
  onClose: PropTypes.func,
};
