import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { resetComboRotation } from "open-sse/services/combo.js";
import bcrypt from "bcryptjs";
import { footerSettingsPatch } from "@/shared/utils/footerSettings.js";
import { getWorkerTopology } from "@/shared/utils/systemHealth.js";
import { getInitialPassword } from "@/lib/auth/dashboardSession";
import { CREDIT_GUARD_MIN_PERCENT, CREDIT_GUARD_MAX_PERCENT } from "@/sse/services/codebuddyCreditGuard.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SETTINGS_RESPONSE_HEADERS = {
  "Cache-Control": "no-store"
};

// Secrets must never be mass-assigned from request body (CWE-915)
const PROTECTED_SETTING_KEYS = ["password", "mitmSudoEncrypted"];

export async function GET() {
  try {
    const settings = await getSettings();
    const { password, oidcClientSecret, ...safeSettings } = settings;
    safeSettings.oidcConfigured = !!(safeSettings.oidcIssuerUrl && safeSettings.oidcClientId && oidcClientSecret);
    
    const enableRequestLogs = process.env.ENABLE_REQUEST_LOGS === "true";
    const enableTranslator = process.env.ENABLE_TRANSLATOR === "true";
    
    return NextResponse.json({ 
      ...safeSettings, 
      enableRequestLogs,
      enableTranslator,
      hasPassword: !!password,
      workerTopology: getWorkerTopology()
    }, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error getting settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();

    // Strip protected secrets before any internal handling sets them
    for (const key of PROTECTED_SETTING_KEYS) delete body[key];
    delete body.workerTopology;

    if (Object.prototype.hasOwnProperty.call(body, "appName")) {
      body.appName = String(body.appName ?? "").trim().slice(0, 50) || "SantaiNetwork";
    }

    // CodeBuddy credit guard: keep the shape { enabled, thresholdPercent } and clamp
    // the threshold to the band the guard enforces, so a stray value cannot store
    // "disable everything" or "never disable" by accident.
    if (Object.prototype.hasOwnProperty.call(body, "codebuddyCreditGuard")) {
      const incoming = body.codebuddyCreditGuard;
      if (incoming === null || typeof incoming !== "object" || Array.isArray(incoming)) {
        delete body.codebuddyCreditGuard;
      } else {
        const current = (await getSettings()).codebuddyCreditGuard || {};
        const merged = { ...current, ...incoming };
        const pct = Number(merged.thresholdPercent);
        body.codebuddyCreditGuard = {
          enabled: merged.enabled !== false,
          thresholdPercent: Number.isFinite(pct)
            ? Math.min(CREDIT_GUARD_MAX_PERCENT, Math.max(CREDIT_GUARD_MIN_PERCENT, Math.round(pct)))
            : 10,
        };
      }
    }

    // Normalize admin-controlled Basic Chat footer values at the API boundary.
    if (Object.prototype.hasOwnProperty.call(body, "responseFooterBasicChatEnabled")) {
      body.responseFooterBasicChatEnabled = body.responseFooterBasicChatEnabled !== false;
    }
    if (Object.prototype.hasOwnProperty.call(body, "responseFooterBasicChatFields")) {
      body.responseFooterBasicChatFields = footerSettingsPatch({
        fields: body.responseFooterBasicChatFields,
      }).responseFooterBasicChatFields;
    }
    if (Object.prototype.hasOwnProperty.call(body, "responseFooterBasicChatText")) {
      body.responseFooterBasicChatText = String(body.responseFooterBasicChatText ?? "").slice(0, 500);
    }

    // If updating password, hash it
    if (body.newPassword) {
      const settings = await getSettings();
      const currentHash = settings.password;

      // Verify current password if it exists
      if (currentHash) {
        if (!body.currentPassword) {
          return NextResponse.json({ error: "Current password required" }, { status: 400 });
        }
        const isValid = await bcrypt.compare(body.currentPassword, currentHash);
        if (!isValid) {
          return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      } else {
        // First time setting password, no current password needed.
        // If a value is supplied it must match the current first-run password
        // (INITIAL_PASSWORD env or the per-install random value).
        if (body.currentPassword && body.currentPassword !== getInitialPassword()) {
           return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      }

      const salt = await bcrypt.genSalt(10);
      body.password = await bcrypt.hash(body.newPassword, salt);
      delete body.newPassword;
      delete body.currentPassword;
    }

    if (Object.prototype.hasOwnProperty.call(body, "oidcClientSecret")) {
      if (!body.oidcClientSecret || !String(body.oidcClientSecret).trim()) {
        delete body.oidcClientSecret;
      }
    }

    const settings = await updateSettings(body);

    // Apply outbound proxy settings immediately (no restart required)
    if (
      Object.prototype.hasOwnProperty.call(body, "outboundProxyEnabled") ||
      Object.prototype.hasOwnProperty.call(body, "outboundProxyUrl") ||
      Object.prototype.hasOwnProperty.call(body, "outboundNoProxy")
    ) {
      applyOutboundProxyEnv(settings);
    }

    // Invalidate combo rotation state when strategy settings change
    if (
      Object.prototype.hasOwnProperty.call(body, "comboStrategy") ||
      Object.prototype.hasOwnProperty.call(body, "comboStickyRoundRobinLimit") ||
      Object.prototype.hasOwnProperty.call(body, "comboStrategies")
    ) {
      resetComboRotation();
    }

    if (
      Object.prototype.hasOwnProperty.call(body, "claudeAutoPing") ||
      Object.prototype.hasOwnProperty.call(body, "codexAutoPing")
    ) {
      // Keep the scheduler absent when no account opted in; load its provider graph only on demand.
      import("@/shared/services/quotaAutoPing")
        .then(({ configureQuotaAutoPing }) => {
          configureQuotaAutoPing(settings);
        })
        .catch((error) => console.warn("[AutoPing] settings update failed:", error.message));
    }

    const { password, oidcClientSecret, workerTopology, ...safeSettings } = settings;
    safeSettings.oidcConfigured = !!(safeSettings.oidcIssuerUrl && safeSettings.oidcClientId && oidcClientSecret);
    return NextResponse.json(safeSettings, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error updating settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
