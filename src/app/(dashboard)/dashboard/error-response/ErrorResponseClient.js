"use client";

import { useState, useEffect } from "react";
import { Card, Button } from "@/shared/components";
import { cn } from "@/shared/utils/cn";

export default function ErrorResponseClient() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const [enabled, setEnabled] = useState(false);
  const [msg429, setMsg429] = useState("");
  const [msg502, setMsg502] = useState("");
  const [msg503, setMsg503] = useState("");
  const [msgFallback, setMsgFallback] = useState("");

  // Preview tab: 429 | 502 | 503 | fallback
  const [previewTab, setPreviewTab] = useState("429");

  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        const s = d.settings || d || {};
        setEnabled(s.customErrorResponseEnabled === true);
        setMsg429(s.customError429Message || "Server upstream sedang padat atau mencapai batas paralel. Silakan coba beberapa saat lagi.");
        setMsg502(s.customError502Message || "Server upstream tidak merespons atau mengalami koneksi timeout. Silakan coba lagi.");
        setMsg503(s.customError503Message || "Layanan upstream sedang tidak tersedia saat ini. Silakan coba beberapa saat lagi.");
        setMsgFallback(s.customErrorFallbackMessage || "Terjadi kendala pada penyedia AI upstream. Silakan coba beberapa saat lagi.");
        setLoading(false);
      })
      .catch((err) => {
        setError("Gagal memuat pengaturan: " + err.message);
        setLoading(false);
      });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError("");
    setSaved(false);

    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customErrorResponseEnabled: enabled,
          customError429Message: msg429.trim(),
          customError502Message: msg502.trim(),
          customError503Message: msg503.trim(),
          customErrorFallbackMessage: msgFallback.trim(),
        }),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError("Gagal menyimpan perubahan: " + err.message);
    } finally {
      setSaving(false);
    }
  };

  const getActivePreviewMessage = () => {
    if (!enabled) {
      return previewTab === "429"
        ? '{"detail":{"error":{"message":"Anda menjalankan 7 permintaan sekaligus, melebihi batas 7 request paralel pada paket Anda...","code":"parallel_limit"}}}'
        : previewTab === "502"
        ? '{"error":{"message":"fetch connect timeout (undici ETIMEDOUT)...","type":"server_error","code":"bad_gateway"}}'
        : '{"error":{"message":"All accounts unavailable (503)...","type":"server_error","code":"service_unavailable"}}';
    }

    let userMsg = msgFallback;
    let code = "internal_server_error";
    let type = "server_error";
    let status = 500;

    if (previewTab === "429") {
      userMsg = msg429;
      code = "rate_limit_exceeded";
      type = "requests";
      status = 429;
    } else if (previewTab === "502") {
      userMsg = msg502;
      code = "bad_gateway";
      type = "server_error";
      status = 502;
    } else if (previewTab === "503") {
      userMsg = msg503;
      code = "service_unavailable";
      type = "server_error";
      status = 503;
    }

    return JSON.stringify(
      {
        error: {
          message: userMsg,
          type,
          code,
        },
      },
      null,
      2
    );
  };

  if (loading) {
    return <div className="p-8 text-center text-sm text-text-muted">Memuat pengaturan...</div>;
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-border pb-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-text-main">Custom Error Response</h1>
          <p className="text-sm text-text-muted mt-1">
            Ganti error teknis mentah dari server upstream (seperti 429 limit paralel atau 502 timeout) dengan format OpenAI standar dan pesan kustom Anda sendiri.
          </p>
        </div>
        <Button
          onClick={handleSave}
          disabled={saving}
          className="self-start sm:self-auto gap-2"
        >
          <span className="material-symbols-outlined text-[18px]">save</span>
          {saving ? "Menyimpan..." : "Simpan Pengaturan"}
        </Button>
      </div>

      {saved && (
        <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-800 dark:text-emerald-400 text-xs font-semibold rounded-lg">
          Pengaturan custom error berhasil disimpan dan aktif langsung!
        </div>
      )}

      {error && (
        <div className="p-3 bg-red-500/10 border border-red-500/20 text-red-800 dark:text-red-300 text-xs font-semibold rounded-lg">
          {error}
        </div>
      )}

      {/* Main Switch Card */}
      <Card>
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <p className="font-semibold text-text-main text-sm">Aktifkan Pesan Error Kustom</p>
            <p className="text-xs text-text-muted">
              Saat aktif, gateway akan memotong pesan error teknis provider mentah dan menggantinya dengan template pesan yang Anda tentukan di bawah.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setEnabled(!enabled)}
            className={cn(
              "relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none",
              enabled ? "bg-primary" : "bg-surface-2 border border-border"
            )}
          >
            <span
              className={cn(
                "pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out",
                enabled ? "translate-x-5" : "translate-x-0"
              )}
            />
          </button>
        </div>
      </Card>

      {/* Inputs per Status */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="space-y-4">
          {/* 429 */}
          <Card>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-bold uppercase tracking-wider text-amber-800 dark:text-amber-500 flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[16px]">speed</span>
                  HTTP 429 · Parallel & Rate Limit
                </label>
                <span className="text-[11px] text-text-muted font-mono">Batas request bersamaan</span>
              </div>
              <textarea
                rows={3}
                value={msg429}
                onChange={(e) => setMsg429(e.target.value)}
                placeholder="Pesan untuk error 429..."
                className="w-full rounded-lg border border-border bg-input px-3 py-2 text-xs text-text-main placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary font-medium"
              />
              <p className="text-[11px] text-text-muted">
                Dipakai saat upstream mengembalikan batas request paralel atau token per menit terlampaui.
              </p>
            </div>
          </Card>

          {/* 502 */}
          <Card>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-bold uppercase tracking-wider text-red-700 dark:text-red-300 flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[16px]">cloud_off</span>
                  HTTP 502 · Bad Gateway & Timeout
                </label>
                <span className="text-[11px] text-text-muted font-mono">Koneksi upstream putus</span>
              </div>
              <textarea
                rows={3}
                value={msg502}
                onChange={(e) => setMsg502(e.target.value)}
                placeholder="Pesan untuk error 502..."
                className="w-full rounded-lg border border-border bg-input px-3 py-2 text-xs text-text-main placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary font-medium"
              />
              <p className="text-[11px] text-text-muted">
                Dipakai saat server upstream mengalami network timeout, drop koneksi, atau server mati.
              </p>
            </div>
          </Card>

          {/* 503 */}
          <Card>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-bold uppercase tracking-wider text-blue-700 dark:text-blue-400 flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[16px]">sync_problem</span>
                  HTTP 503 · Service Unavailable
                </label>
                <span className="text-[11px] text-text-muted font-mono">Akun upstream sibuk</span>
              </div>
              <textarea
                rows={3}
                value={msg503}
                onChange={(e) => setMsg503(e.target.value)}
                placeholder="Pesan untuk error 503..."
                className="w-full rounded-lg border border-border bg-input px-3 py-2 text-xs text-text-main placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary font-medium"
              />
              <p className="text-[11px] text-text-muted">
                Dipakai saat seluruh akun provider sedang berada dalam periode cooldown.
              </p>
            </div>
          </Card>

          {/* Fallback */}
          <Card>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-bold uppercase tracking-wider text-text-muted flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[16px]">error</span>
                  Default Fallback Error
                </label>
                <span className="text-[11px] text-text-muted font-mono">Error umum lainnya</span>
              </div>
              <textarea
                rows={3}
                value={msgFallback}
                onChange={(e) => setMsgFallback(e.target.value)}
                placeholder="Pesan untuk error lainnya..."
                className="w-full rounded-lg border border-border bg-input px-3 py-2 text-xs text-text-main placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary font-medium"
              />
              <p className="text-[11px] text-text-muted">
                Dipakai jika status error upstream tidak cocok dengan aturan spesifik di atas.
              </p>
            </div>
          </Card>
        </div>

        {/* Live Preview Panel */}
        <div className="space-y-4">
          <Card className="sticky top-6">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-[18px] text-primary">visibility</span>
                  <p className="text-xs font-bold uppercase tracking-wide text-text-main">Live Client Preview</p>
                </div>
                <span className={cn("text-[10px] px-2 py-0.5 rounded font-mono font-bold", enabled ? "bg-emerald-500/10 text-emerald-800 dark:text-emerald-400" : "bg-neutral-500/10 text-neutral-600 dark:text-neutral-300")}>
                  {enabled ? "CUSTOM MODE ACTIVE" : "RAW UPSTREAM PASS-THROUGH"}
                </span>
              </div>

              {/* Preview Status Switcher */}
              <div className="flex items-center gap-1 border border-border p-1 rounded-lg bg-surface-2">
                {[
                  { id: "429", label: "429 Parallel" },
                  { id: "502", label: "502 Timeout" },
                  { id: "503", label: "503 Cooldown" },
                ].map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setPreviewTab(t.id)}
                    className={cn(
                      "flex-1 py-1 text-xs font-semibold rounded-md transition",
                      previewTab === t.id ? "bg-primary text-primary-foreground shadow-sm" : "text-text-muted hover:text-text-main"
                    )}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              {/* Code Box */}
              <div className="rounded-lg border border-border bg-black/90 p-3 text-[11px] font-mono text-emerald-400 overflow-x-auto max-h-96">
                <pre>{getActivePreviewMessage()}</pre>
              </div>

              <div className="p-3 bg-surface-2 rounded-lg border border-border space-y-1 text-xs text-text-muted">
                <p className="font-semibold text-text-main">Kompatibilitas Standar OpenAI:</p>
                <p>
                  Semua client OpenAI-compatible (seperti Odysseus, Cursor, Claude Code, Cline, dll) akan menampilkan pesan kustom ini secara rapi di antarmuka mereka tanpa terpotong kode HTML/JSON error mentah.
                </p>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
